#!/usr/bin/env python3
"""Web UI for the GreenLake × Aruba Central AP licensing report.

Run:  python app.py         then open http://localhost:8321

Credentials are entered in the browser, sent only to this local server,
used for the API calls, and never written to disk (except Classic Central's
rotated refresh tokens, which Central invalidates on every use and must be
cached to keep Option B working across runs).
"""

import sys

from pathlib import Path

from flask import Flask, jsonify, render_template, request, send_from_directory

from glc.central import CentralClient, CentralError
from glc.correlate import correlate
from glc.greenlake import GreenLakeClient, GreenLakeError
from glc.new_central import NewCentralClient, NewCentralError
from glc.report import render_report

app = Flask(__name__)
_ROOT = Path(__file__).resolve().parent

SOURCE_LABELS = {
    "new": "New Central (GreenLake-native)",
    "classic": "Classic Aruba Central",
}


class RequestError(Exception):
    """Validation problem in the submitted form — reported as HTTP 400."""


def _require(value, message):
    value = (value or "").strip()
    if not value:
        raise RequestError(message)
    return value


def _fetch_live(body):
    gl_cfg = body.get("greenlake") or {}
    gl_id = _require(gl_cfg.get("client_id"), "GreenLake Client ID is required.")
    gl_secret = _require(gl_cfg.get("client_secret"),
                         "GreenLake Client Secret is required.")

    mode = body.get("central_mode")
    if mode not in SOURCE_LABELS:
        raise RequestError("Pick a Central type: New Central or Classic Central.")

    gl = GreenLakeClient(client_id=gl_id, client_secret=gl_secret)
    devices = gl.get_devices()
    subs = gl.get_subscriptions()

    if mode == "new":
        nc = body.get("new") or {}
        base = _require(nc.get("base_url"),
                        "New Central base URL is required "
                        "(e.g. https://us1.api.central.arubanetworks.com).")
        if nc.get("use_gl_creds", True):
            cid, csec = gl_id, gl_secret
        else:
            cid = _require(nc.get("client_id"),
                           "New Central API client ID is required "
                           "(or tick 'use my GreenLake credentials').")
            csec = _require(nc.get("client_secret"),
                            "New Central API client secret is required.")
        aps = NewCentralClient(base, cid, csec).get_aps()
    else:
        cc = body.get("classic") or {}
        base = _require(cc.get("base_url"),
                        "Classic Central API gateway base URL is required.")
        if cc.get("auth") == "token":
            client = CentralClient(
                base,
                access_token=_require(cc.get("access_token"),
                                      "Classic Central access token is required."),
            )
        else:
            client = CentralClient(
                base,
                client_id=_require(cc.get("client_id"),
                                   "Classic Central client ID is required."),
                client_secret=_require(cc.get("client_secret"),
                                       "Classic Central client secret is required."),
                refresh_token=_require(cc.get("refresh_token"),
                                       "Classic Central refresh token is required."),
            )
        aps = client.get_aps()

    return devices, subs, aps, SOURCE_LABELS[mode]


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/sample_file.csv")
def sample_csv():
    """GreenLake device-import sample CSV (same format the UI accepts)."""
    return send_from_directory(_ROOT, "sample_file.csv",
                               mimetype="text/csv",
                               as_attachment=True,
                               download_name="sample_file.csv")


@app.post("/api/report")
def api_report():
    body = request.get_json(silent=True) or {}
    try:
        devices, subs, aps, source = _fetch_live(body)
    except RequestError as exc:
        return jsonify({"error": str(exc)}), 400
    except (GreenLakeError, CentralError, NewCentralError) as exc:
        return jsonify({"error": str(exc)}), 502
    except Exception as exc:  # keep the UI informative on surprises
        return jsonify({"error": f"Unexpected error: {exc}"}), 500

    try:
        expiring_days = int(body.get("expiring_days") or 90)
    except (TypeError, ValueError):
        expiring_days = 90
    ignored = body.get("ignored_serials") or []
    if not isinstance(ignored, list):
        ignored = []
    data = correlate(devices, subs, aps, expiring_days=expiring_days,
                     central_source=source, ignored_serials=ignored)
    return render_report(data), 200, {"Content-Type": "text/html; charset=utf-8"}


@app.post("/api/detach")
def api_detach():
    """Remove all subscriptions from one device in GreenLake.

    Called by the in-app report after the user confirms; never reachable
    from a downloaded (static) report.
    """
    body = request.get_json(silent=True) or {}
    serial = (body.get("serial") or "").strip()
    try:
        gl_cfg = body.get("greenlake") or {}
        gl_id = _require(gl_cfg.get("client_id"), "GreenLake Client ID is required.")
        gl_secret = _require(gl_cfg.get("client_secret"),
                             "GreenLake Client Secret is required.")
        device_id = _require(
            body.get("device_id"),
            "This report has no GreenLake device id for the AP — regenerate "
            "the report and try again.")
    except RequestError as exc:
        return jsonify({"error": str(exc)}), 400
    try:
        gl = GreenLakeClient(client_id=gl_id, client_secret=gl_secret)
        status = gl.detach_subscriptions(device_id)
    except GreenLakeError as exc:
        return jsonify({"error": str(exc)}), 502
    except Exception as exc:
        return jsonify({"error": f"Unexpected error: {exc}"}), 500
    return jsonify({"ok": True, "status": status, "serial": serial})


@app.post("/api/add-inventory")
def api_add_inventory():
    """Register subscription keys and devices in GreenLake in one action."""
    body = request.get_json(silent=True) or {}
    keys = [str(k).strip() for k in (body.get("subscription_keys") or [])
            if str(k or "").strip()]
    devices = []
    for d in (body.get("devices") or []):
        serial = str((d or {}).get("serial") or "").strip()
        mac = str((d or {}).get("mac") or "").strip()
        if serial and mac:
            devices.append({"serialNumber": serial, "macAddress": mac})

    if not keys and not devices:
        return jsonify({"error": "Provide at least one subscription key or "
                                 "one device (serial + MAC)."}), 400

    try:
        gl_cfg = body.get("greenlake") or {}
        gl_id = _require(gl_cfg.get("client_id"), "GreenLake Client ID is required.")
        gl_secret = _require(gl_cfg.get("client_secret"),
                             "GreenLake Client Secret is required.")
    except RequestError as exc:
        return jsonify({"error": str(exc)}), 400

    gl = GreenLakeClient(client_id=gl_id, client_secret=gl_secret)
    result = {"ok": True}
    # subscriptions first so freshly added devices can pick up seats
    if keys:
        try:
            result["subscriptions"] = {"count": len(keys),
                                       "status": gl.add_subscriptions(keys)}
        except GreenLakeError as exc:
            result["ok"] = False
            result["subscriptions"] = {"count": len(keys), "error": str(exc)}
    if devices:
        try:
            result["devices"] = {"count": len(devices),
                                 "status": gl.add_devices(devices)}
        except GreenLakeError as exc:
            result["ok"] = False
            result["devices"] = {"count": len(devices), "error": str(exc)}
    return jsonify(result)


if __name__ == "__main__":
    port = 8321
    print(f"AP Licensing Report UI: http://localhost:{port}", file=sys.stderr)
    print("Note: bound to 127.0.0.1 — credentials never leave this machine. "
          "Put it behind HTTPS before exposing it to others.", file=sys.stderr)
    app.run(host="127.0.0.1", port=port, debug=False)
