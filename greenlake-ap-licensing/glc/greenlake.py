"""HPE GreenLake platform API client (devices + subscriptions)."""

import json
import sys
import time

import requests


class GreenLakeError(Exception):
    pass


class GreenLakeClient:
    def __init__(self, client_id, client_secret,
                 sso_url="https://sso.common.cloud.hpe.com/as/token.oauth2",
                 api_base="https://global.api.greenlake.hpe.com",
                 timeout=60):
        self.client_id = client_id
        self.client_secret = client_secret
        self.sso_url = sso_url
        self.api_base = api_base.rstrip("/")
        self.timeout = timeout
        self.session = requests.Session()
        self._token = None

    # -- auth -------------------------------------------------------------

    def authenticate(self):
        resp = self.session.post(
            self.sso_url,
            data={
                "grant_type": "client_credentials",
                "client_id": self.client_id,
                "client_secret": self.client_secret,
            },
            timeout=self.timeout,
        )
        if resp.status_code != 200:
            raise GreenLakeError(
                f"GreenLake auth failed (HTTP {resp.status_code}): {resp.text[:300]}"
            )
        self._token = resp.json().get("access_token")
        if not self._token:
            raise GreenLakeError("GreenLake auth response contained no access_token")
        self.session.headers["Authorization"] = f"Bearer {self._token}"

    # -- helpers ----------------------------------------------------------

    def _get_paginated(self, path, item_keys=("items",), limit=100, params=None):
        """Fetch every page of a GreenLake collection endpoint.

        GreenLake APIs paginate with offset/limit and return items under
        'items'. Total may appear as 'total' or 'count'.
        """
        if self._token is None:
            self.authenticate()
        results = []
        offset = 0
        while True:
            query = dict(params or {})
            query.update({"limit": limit, "offset": offset})
            url = f"{self.api_base}{path}"
            resp = self.session.get(url, params=query, timeout=self.timeout)
            if resp.status_code == 401:
                # token expired mid-run; re-auth once and retry this page
                self.authenticate()
                resp = self.session.get(url, params=query, timeout=self.timeout)
            if resp.status_code != 200:
                raise GreenLakeError(
                    f"GET {path} failed (HTTP {resp.status_code}): {resp.text[:300]}"
                )
            body = resp.json()
            page = None
            for key in item_keys:
                if isinstance(body.get(key), list):
                    page = body[key]
                    break
            if page is None:
                raise GreenLakeError(
                    f"GET {path}: could not find item list in response keys "
                    f"{sorted(body.keys())}"
                )
            results.extend(page)
            total = body.get("total", body.get("count"))
            offset += len(page)
            if len(page) < limit or (isinstance(total, int) and offset >= total):
                break
        return results

    # -- endpoints --------------------------------------------------------

    def get_devices(self):
        """All devices in the workspace (serial, MAC, type, attached subscriptions)."""
        print("GreenLake: fetching devices...", file=sys.stderr)
        devices = self._get_paginated("/devices/v1/devices")
        print(f"GreenLake: {len(devices)} devices", file=sys.stderr)
        return devices

    def get_subscriptions(self):
        """All device subscriptions (key, tier, quantities, start/end dates)."""
        print("GreenLake: fetching subscriptions...", file=sys.stderr)
        subs = self._get_paginated("/subscriptions/v1/subscriptions")
        print(f"GreenLake: {len(subs)} subscriptions", file=sys.stderr)
        return subs

    def detach_subscriptions(self, device_id, wait_seconds=25):
        """Remove every subscription from one device.

        PATCH /devices/v1/devices?id=<uuid> with {"subscription": []}
        (merge-patch). GreenLake answers 202 and processes asynchronously;
        we poll the async-operation URI briefly so the caller gets a real
        outcome where possible.

        Returns "SUCCEEDED" | "PENDING" | raises GreenLakeError.
        """
        if self._token is None:
            self.authenticate()
        url = f"{self.api_base}/devices/v1/devices"
        kwargs = {
            "params": {"id": device_id},
            "data": json.dumps({"subscription": []}),
            "headers": {"Content-Type": "application/merge-patch+json"},
            "timeout": self.timeout,
        }
        resp = self.session.patch(url, **kwargs)
        if resp.status_code == 401:
            self.authenticate()
            resp = self.session.patch(url, **kwargs)
        if resp.status_code not in (200, 202):
            raise GreenLakeError(
                f"Detach failed (HTTP {resp.status_code}): {resp.text[:300]}"
            )
        if resp.status_code == 200:
            return "SUCCEEDED"
        return self._wait_for_op(resp, wait_seconds, "Detach")

    def _wait_for_op(self, resp, wait_seconds, label):
        """Poll a 202 response's async-operation URI until it settles."""
        location = resp.headers.get("Location")
        if not location:
            return "PENDING"
        op_url = location if location.startswith("http") else self.api_base + location
        deadline = time.monotonic() + wait_seconds
        while time.monotonic() < deadline:
            time.sleep(2)
            op = self.session.get(op_url, timeout=self.timeout)
            if op.status_code != 200:
                return "PENDING"
            status = str(op.json().get("status", "")).upper()
            if "SUCCE" in status:
                return "SUCCEEDED"
            if "FAIL" in status or "ERROR" in status:
                detail = (op.json().get("resultMessage")
                          or op.json().get("message") or status)
                raise GreenLakeError(f"{label} operation failed: {detail}")
        return "PENDING"

    def add_subscriptions(self, keys, wait_seconds=20):
        """Register subscription keys in the workspace.

        POST /subscriptions/v1/subscriptions {"subscriptions": [{"key": ...}]}
        Returns "SUCCEEDED" | "PENDING".
        """
        if self._token is None:
            self.authenticate()
        url = f"{self.api_base}/subscriptions/v1/subscriptions"
        payload = {"subscriptions": [{"key": k} for k in keys]}
        resp = self.session.post(url, json=payload, timeout=self.timeout)
        if resp.status_code == 401:
            self.authenticate()
            resp = self.session.post(url, json=payload, timeout=self.timeout)
        if resp.status_code not in (200, 201, 202):
            raise GreenLakeError(
                f"Add subscriptions failed (HTTP {resp.status_code}): "
                f"{resp.text[:300]}"
            )
        if resp.status_code != 202:
            return "SUCCEEDED"
        return self._wait_for_op(resp, wait_seconds, "Add subscriptions")

    def add_devices(self, devices, wait_seconds=20):
        """Register network devices in the workspace.

        POST /devices/v1/devices {"network": [{serialNumber, macAddress}]} —
        max five devices per call, so larger lists are sent in batches.
        devices: list of {"serialNumber": ..., "macAddress": ...}.
        Returns "SUCCEEDED" | "PENDING".
        """
        if self._token is None:
            self.authenticate()
        url = f"{self.api_base}/devices/v1/devices"
        pending = False
        for i in range(0, len(devices), 5):
            batch = {"network": devices[i:i + 5]}
            resp = self.session.post(url, json=batch, timeout=self.timeout)
            if resp.status_code == 401:
                self.authenticate()
                resp = self.session.post(url, json=batch, timeout=self.timeout)
            if resp.status_code not in (200, 201, 202):
                raise GreenLakeError(
                    f"Add devices failed on batch {i // 5 + 1} "
                    f"(HTTP {resp.status_code}): {resp.text[:300]}"
                )
            if resp.status_code == 202:
                if self._wait_for_op(resp, wait_seconds, "Add devices") == "PENDING":
                    pending = True
        return "PENDING" if pending else "SUCCEEDED"
