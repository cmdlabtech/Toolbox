"""Aruba Central (classic) API client for AP monitoring."""

import json
import os
import sys

import requests

TOKEN_CACHE = ".central_token.json"


class CentralError(Exception):
    pass


class CentralClient:
    def __init__(self, base_url, access_token=None, client_id=None,
                 client_secret=None, refresh_token=None, timeout=60,
                 token_cache=None):
        self.base_url = base_url.rstrip("/")
        self.access_token = access_token
        self.client_id = client_id
        self.client_secret = client_secret
        self.refresh_token = refresh_token
        self.timeout = timeout
        # per-client cache file so different credential sets don't collide
        if token_cache is None and client_id:
            token_cache = f".central_token_{client_id[:8]}.json"
        self.token_cache = token_cache or TOKEN_CACHE
        self.session = requests.Session()

    # -- auth -------------------------------------------------------------

    def _load_cached_refresh_token(self):
        """Central rotates refresh tokens on every use; prefer the cached one."""
        if self.token_cache and os.path.exists(self.token_cache):
            try:
                with open(self.token_cache) as fh:
                    cached = json.load(fh)
                if cached.get("refresh_token"):
                    return cached["refresh_token"]
            except (OSError, ValueError):
                pass
        return self.refresh_token

    def _save_token_cache(self, token_body):
        if not self.token_cache:
            return
        try:
            with open(self.token_cache, "w") as fh:
                json.dump(token_body, fh, indent=2)
            os.chmod(self.token_cache, 0o600)
        except OSError as exc:
            print(f"warning: could not write {self.token_cache}: {exc}",
                  file=sys.stderr)

    def authenticate(self):
        if self.access_token:
            self.session.headers["Authorization"] = f"Bearer {self.access_token}"
            return
        if not all([self.client_id, self.client_secret]):
            raise CentralError("Central auth: no access_token and no OAuth client credentials")
        refresh = self._load_cached_refresh_token()
        if not refresh:
            raise CentralError("Central auth: no refresh token available")
        resp = self.session.post(
            f"{self.base_url}/oauth2/token",
            params={
                "client_id": self.client_id,
                "client_secret": self.client_secret,
                "grant_type": "refresh_token",
                "refresh_token": refresh,
            },
            timeout=self.timeout,
        )
        if resp.status_code != 200:
            raise CentralError(
                f"Central token refresh failed (HTTP {resp.status_code}): "
                f"{resp.text[:300]}\nIf the refresh token was used elsewhere it "
                f"has rotated; generate a new one in the Central API Gateway UI."
            )
        body = resp.json()
        self.access_token = body.get("access_token")
        if not self.access_token:
            raise CentralError("Central token response contained no access_token")
        self._save_token_cache(body)
        self.session.headers["Authorization"] = f"Bearer {self.access_token}"

    # -- endpoints --------------------------------------------------------

    def get_aps(self):
        """All APs with status/name/site via GET /monitoring/v2/aps."""
        if "Authorization" not in self.session.headers:
            self.authenticate()
        print("Central: fetching APs...", file=sys.stderr)
        aps = []
        offset = 0
        limit = 1000
        while True:
            resp = self.session.get(
                f"{self.base_url}/monitoring/v2/aps",
                params={"limit": limit, "offset": offset, "calculate_total": "true"},
                timeout=self.timeout,
            )
            if resp.status_code != 200:
                raise CentralError(
                    f"GET /monitoring/v2/aps failed (HTTP {resp.status_code}): "
                    f"{resp.text[:300]}"
                )
            body = resp.json()
            page = body.get("aps", [])
            aps.extend(page)
            total = body.get("total")
            offset += len(page)
            if len(page) < limit or (isinstance(total, int) and offset >= total):
                break
        print(f"Central: {len(aps)} APs", file=sys.stderr)
        return aps
