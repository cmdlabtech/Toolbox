"""New Central (HPE Aruba Networking Central on GreenLake) API client.

New Central authenticates with HPE GreenLake platform tokens (the same SSO
endpoint as the GreenLake APIs) and serves monitoring data from a per-tenant
cluster base URL, e.g. https://us1.api.central.arubanetworks.com
"""

import sys

import requests


class NewCentralError(Exception):
    pass


class NewCentralClient:
    def __init__(self, base_url, client_id, client_secret,
                 sso_url="https://sso.common.cloud.hpe.com/as/token.oauth2",
                 timeout=60):
        self.base_url = base_url.rstrip("/")
        self.client_id = client_id
        self.client_secret = client_secret
        self.sso_url = sso_url
        self.timeout = timeout
        self.session = requests.Session()

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
            raise NewCentralError(
                f"New Central auth failed (HTTP {resp.status_code}): {resp.text[:300]}"
            )
        token = resp.json().get("access_token")
        if not token:
            raise NewCentralError("New Central auth response contained no access_token")
        self.session.headers["Authorization"] = f"Bearer {token}"

    def get_aps(self):
        """All APs via GET /network-monitoring/v1/aps (cursor pagination)."""
        if "Authorization" not in self.session.headers:
            self.authenticate()
        print("New Central: fetching APs...", file=sys.stderr)
        aps = []
        cursor = None
        while True:
            params = {"limit": 1000}
            if cursor:
                params["next"] = cursor
            resp = self.session.get(
                f"{self.base_url}/network-monitoring/v1/aps",
                params=params, timeout=self.timeout,
            )
            if resp.status_code == 401:
                # GLP tokens are short-lived (~15 min); re-auth once mid-run
                self.authenticate()
                resp = self.session.get(
                    f"{self.base_url}/network-monitoring/v1/aps",
                    params=params, timeout=self.timeout,
                )
            if resp.status_code != 200:
                raise NewCentralError(
                    f"GET /network-monitoring/v1/aps failed "
                    f"(HTTP {resp.status_code}): {resp.text[:300]}"
                )
            body = resp.json()
            page = None
            for key in ("items", "aps", "data", "list"):
                if isinstance(body.get(key), list):
                    page = body[key]
                    break
            if page is None:
                raise NewCentralError(
                    f"GET /network-monitoring/v1/aps: no item list in response "
                    f"keys {sorted(body.keys())}"
                )
            aps.extend(page)
            cursor = body.get("next")
            if not cursor or not page:
                break
        print(f"New Central: {len(aps)} APs", file=sys.stderr)
        return aps
