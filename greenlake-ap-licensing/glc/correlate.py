"""Join GreenLake device/subscription data with Aruba Central AP status.

Field access is defensive throughout: HPE has shipped several casings and
shapes for these payloads (camelCase v1, snake_case betas), so every lookup
tries the known variants before giving up.
"""

import re
from datetime import datetime, timezone

AP_DEVICE_TYPES = {"AP", "IAP", "ACCESS POINT", "ACCESS_POINT"}


def _first(record, *keys, default=None):
    for key in keys:
        if isinstance(record, dict) and record.get(key) not in (None, ""):
            return record[key]
    return default


def norm_mac(mac):
    if not mac:
        return ""
    return re.sub(r"[^0-9a-f]", "", str(mac).lower())


def norm_serial(serial):
    return str(serial).strip().upper() if serial else ""


def _parse_date(value):
    """Return a timezone-aware datetime from ISO strings or epoch (s/ms)."""
    if value in (None, "", 0):
        return None
    if isinstance(value, (int, float)) or (isinstance(value, str) and value.isdigit()):
        num = float(value)
        if num > 1e12:  # milliseconds
            num /= 1000.0
        if num <= 0:
            return None
        return datetime.fromtimestamp(num, tz=timezone.utc)
    if isinstance(value, str):
        text = value.replace("Z", "+00:00")
        for fmt in None, "%Y-%m-%d":
            try:
                dt = (datetime.fromisoformat(text) if fmt is None
                      else datetime.strptime(value, fmt))
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return dt
            except ValueError:
                continue
    return None


def _iso_date(dt):
    return dt.date().isoformat() if dt else None


def _parse_tags(raw):
    """Normalize a resource's GreenLake tags into sorted 'key: value' strings.

    GreenLake tags are user-assigned key/value pairs on devices and
    subscriptions alike (the same ones shown as 'tag:<Name>' columns in
    GreenLake's own CSV exports). HPE has shipped them both as a
    {name: value} map and as a list of {"key"/"name": ..., "value": ...}
    objects, so both are supported.
    """
    raw_tags = _first(raw, "tags", default={})
    pairs = []
    if isinstance(raw_tags, dict):
        pairs = list(raw_tags.items())
    elif isinstance(raw_tags, list):
        for t in raw_tags:
            if isinstance(t, dict):
                key = _first(t, "key", "name")
                if key:
                    pairs.append((key, _first(t, "value", default="")))
            elif isinstance(t, str):
                pairs.append((t, ""))
    return sorted(f"{k}: {v}" if v not in (None, "") else str(k) for k, v in pairs)


# -- extraction ------------------------------------------------------------

def parse_gl_device(raw):
    subs = _first(raw, "subscription", "subscriptions", default=[]) or []
    keys = []
    for sub in subs:
        if isinstance(sub, dict):
            key = _first(sub, "key", "subscriptionKey", "subscription_key")
            if key:
                keys.append(str(key))
        elif isinstance(sub, str):
            keys.append(sub)
    app = _first(raw, "application", default={}) or {}
    return {
        "gl_id": _first(raw, "id", "deviceId", "device_id", default=""),
        "serial": norm_serial(_first(raw, "serialNumber", "serial_number", "serial")),
        "mac": norm_mac(_first(raw, "macAddress", "mac_address", "mac")),
        "mac_display": _first(raw, "macAddress", "mac_address", "mac", default=""),
        "device_type": str(_first(raw, "deviceType", "device_type", "type",
                                  default="")).upper(),
        "model": _first(raw, "model", "partNumber", "part_number", default=""),
        "part_number": _first(raw, "partNumber", "part_number", default=""),
        "region": _first(raw, "region", default=""),
        "application": _first(app, "name", default="") if isinstance(app, dict) else "",
        "subscription_keys": keys,
        "tags": _parse_tags(raw),
    }


def parse_gl_subscription(raw):
    appts = _first(raw, "appointments", default={}) or {}
    start = _parse_date(
        _first(appts, "subscriptionStart", "subscription_start", "startAt")
        or _first(raw, "subscriptionStart", "subscription_start", "startDate", "start")
    )
    end = _parse_date(
        _first(appts, "subscriptionEnd", "subscription_end", "endAt")
        or _first(raw, "subscriptionEnd", "subscription_end", "endDate", "end")
    )

    def _int(value):
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    return {
        "key": str(_first(raw, "key", "subscriptionKey", "subscription_key",
                          default="")),
        "tier": _first(raw, "subscriptionTier", "subscription_tier", "tier",
                       "subscriptionType", "subscription_type", default=""),
        "sku": _first(raw, "sku", "productSku", default=""),
        "quantity": _int(_first(raw, "quantity", "qty")),
        "available": _int(_first(raw, "availableQuantity", "available_quantity")),
        "start": _iso_date(start),
        "end": _iso_date(end),
        "end_dt": end,
        "tags": _parse_tags(raw),
    }


def _norm_status(value):
    """Map Classic ('Up'/'Down') and New Central ('ONLINE'/'OFFLINE', …)
    status vocabularies onto Up / Down / <other>."""
    text = str(value or "").strip().lower()
    if text in ("up", "online", "connected"):
        return "Up"
    if text in ("down", "offline", "disconnected"):
        return "Down"
    return str(value).capitalize() if value else "Unknown"


def parse_central_ap(raw):
    """Accepts an AP record from Classic Central (/monitoring/v2/aps,
    snake_case) or New Central (/network-monitoring/v1/aps, camelCase)."""
    return {
        "serial": norm_serial(_first(raw, "serial", "serial_number",
                                     "serialNumber")),
        "mac": norm_mac(_first(raw, "macaddr", "mac_address", "mac",
                               "macAddress")),
        "name": _first(raw, "name", "deviceName", "device_name", "hostname",
                       default=""),
        "status": _norm_status(_first(raw, "status")),
        "site": _first(raw, "site", "siteName", "site_name", default="") or "",
        "group": _first(raw, "group_name", "group", "scopeName", default="") or "",
        "model": _first(raw, "model", default=""),
        "ip": _first(raw, "ip_address", "ip", "ipAddress", default=""),
        "last_modified": _parse_date(_first(raw, "last_modified", "lastSeenAt",
                                            "lastModifiedAt")),
        "firmware": _first(raw, "firmware_version", "firmwareVersion",
                           default=""),
    }


# -- correlation -----------------------------------------------------------

def is_ap(gl_device):
    dtype = gl_device["device_type"]
    return any(t in dtype for t in AP_DEVICE_TYPES) or dtype == ""


def _is_eval_sub(sub):
    """Evaluation subscriptions aren't flagged by a dedicated API field;
    HPE encodes it in the tier/SKU text (e.g. 'FOUNDATION_EVAL')."""
    text = f"{sub['tier']} {sub['sku']}".lower()
    return "eval" in text


def correlate(gl_devices_raw, gl_subs_raw, central_aps_raw, now=None,
              expiring_days=90, include_non_ap=False,
              central_source="Aruba Central", ignored_serials=None):
    """Build the joined dataset the report renders.

    ignored_serials: serials the user marked "down temporarily" — these are
    excluded from the detach-candidates list and shown separately.

    Returns a dict with summary counts and row lists for every report table.
    """
    now = now or datetime.now(timezone.utc)
    ignored = {norm_serial(s) for s in (ignored_serials or []) if s}

    devices = [parse_gl_device(d) for d in gl_devices_raw]
    if not include_non_ap:
        devices = [d for d in devices if is_ap(d)]
    subs = {s["key"]: s for s in (parse_gl_subscription(s) for s in gl_subs_raw)
            if s["key"]}
    central = [parse_central_ap(a) for a in central_aps_raw]

    by_serial = {a["serial"]: a for a in central if a["serial"]}
    by_mac = {a["mac"]: a for a in central if a["mac"]}

    def sub_state(keys):
        """(state, tiers, soonest_end, keys) for a device's attached keys."""
        if not keys:
            return "Unlicensed", [], None, []
        tiers, ends = [], []
        state = "Licensed"
        for key in keys:
            sub = subs.get(key)
            if sub:
                if sub["tier"]:
                    tiers.append(sub["tier"])
                if sub["end_dt"]:
                    ends.append(sub["end_dt"])
        soonest = min(ends) if ends else None
        if soonest and soonest < now:
            state = "Expired"
        return state, tiers, soonest, keys

    rows = []
    for dev in devices:
        ap = by_serial.get(dev["serial"]) or by_mac.get(dev["mac"])
        state, tiers, soonest_end, keys = sub_state(dev["subscription_keys"])
        rows.append({
            "name": ap["name"] if ap else "",
            "gl_id": dev["gl_id"],
            "ignored": dev["serial"] in ignored,
            "serial": dev["serial"],
            "mac": dev["mac_display"],
            "model": ap["model"] if ap and ap["model"] else dev["model"],
            "site": ap["site"] if ap else "",
            "group": ap["group"] if ap else "",
            "status": ap["status"] if ap else "Not in Central",
            "in_central": bool(ap),
            "device_type": dev["device_type"] or "AP",
            "license_state": state,
            "keys": keys,
            "tiers": sorted(set(tiers)),
            "sub_end": _iso_date(soonest_end),
            "last_seen": _iso_date(ap["last_modified"]) if ap else None,
            "ip": ap["ip"] if ap else "",
            "tags": dev["tags"],
        })

    down_and_licensed = [r for r in rows
                         if r["status"] == "Down"
                         and r["license_state"] != "Unlicensed"]
    down_licensed = [r for r in down_and_licensed if not r["ignored"]]
    ignored_down = [r for r in down_and_licensed if r["ignored"]]
    unlicensed = [r for r in rows if r["license_state"] == "Unlicensed"]
    expired = [r for r in rows if r["license_state"] == "Expired"]
    not_in_central = [r for r in rows if not r["in_central"]]

    # subscription summary with AP name mapping
    key_to_aps = {}
    key_to_device_types = {}
    for row in rows:
        for key in row["keys"]:
            key_to_aps.setdefault(key, []).append(
                row["name"] or row["serial"] or row["mac"])
            key_to_device_types.setdefault(key, set()).add(row["device_type"])
    sub_rows = []
    for key, sub in sorted(subs.items()):
        end_dt = sub["end_dt"]
        days_left = (end_dt - now).days if end_dt else None
        attached = sorted(key_to_aps.get(key, []))
        used = (sub["quantity"] - sub["available"]
                if sub["quantity"] is not None and sub["available"] is not None
                else len(attached) or None)
        sub_rows.append({
            "key": key,
            "sub_type": "Eval" if _is_eval_sub(sub) else "Paid",
            "tier": sub["tier"],
            "sku": sub["sku"],
            "device_types": sorted(key_to_device_types.get(key, [])),
            "quantity": sub["quantity"],
            "available": sub["available"],
            "used": used,
            "start": sub["start"],
            "end": sub["end"],
            "days_left": days_left,
            "expired": bool(end_dt and end_dt < now),
            "aps": attached,
            "tags": sub["tags"],
        })
    expiring_soon = [s for s in sub_rows
                     if s["days_left"] is not None
                     and 0 <= s["days_left"] <= expiring_days]

    up = sum(1 for r in rows if r["status"] == "Up")
    down = sum(1 for r in rows if r["status"] == "Down")

    return {
        "generated": now.strftime("%Y-%m-%d %H:%M UTC"),
        "central_source": central_source,
        "expiring_days": expiring_days,
        "summary": {
            "total_aps": len(rows),
            "up": up,
            "down": down,
            "not_in_central": len(not_in_central),
            "licensed": sum(1 for r in rows if r["license_state"] == "Licensed"),
            "unlicensed": len(unlicensed),
            "expired": len(expired),
            "down_licensed": len(down_licensed),
            "ignored_down": len(ignored_down),
            "subscriptions": len(sub_rows),
            "expiring_soon": len(expiring_soon),
        },
        "aps": rows,
        "down_licensed": down_licensed,
        "ignored_down": ignored_down,
        "unlicensed": unlicensed,
        "subscriptions": sub_rows,
        "not_in_central": not_in_central,
    }
