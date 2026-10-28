#!/usr/bin/env python3
"""Generate synthetic fixtures in New Central MRT response shapes:
  sites-health.json  GET /network-monitoring/v1/sites-health
  topology.json      GET /network-monitoring/v1/topology/{site-id}   (keyed by site id)
  switch-detail.json GET /network-monitoring/v1/switches/{serial}     (keyed by serial)
  neighbours.json    GET /network-monitoring/v1/neighbours/{serial}  (keyed by serial)
  vlans.json         GET /network-monitoring/v1/switches/{serial}/vlans
  interfaces.json    GET /network-monitoring/v1/switches/{serial}/interfaces
  device-inventory.json  GET /network-monitoring/v1/device-inventory
                         items[].deviceGroupName, keyed later by serialNumber

All names, serials, MACs and IPs are made up. Private (RFC 1918) addresses only.
Run: python3 worker/fixtures/gen_fixtures.py   (rewrites the JSON files next to it)
"""
import json, os, hashlib

HERE = os.path.dirname(os.path.abspath(__file__))

def serial(name):
    return "SG" + hashlib.sha1(name.encode()).hexdigest()[:8].upper()

def mac(name):
    h = hashlib.sha1(("mac" + name).encode()).hexdigest()
    return "38:21:c7:" + ":".join(h[i:i+2] for i in (0, 2, 4))

# name, site, model, mgmt-vlan-ip, oobm-ip, loopback-ip, monitor-ip
SW = []
def add(name, site, model, mon, vlan99=True, oobm=None, loop=None, status="Online"):
    SW.append(dict(name=name, site=site, model=model, mon=mon,
                   vlan99=(mon.replace("10.10.", "10.99.") if vlan99 is True else vlan99),
                   oobm=oobm, loop=loop, status=status))

add("DO-CORE-01", "District Office", "Aruba 8360-32Y4C", "10.10.0.1",
    oobm="192.168.100.1", loop="10.255.0.1")
for a in (1, 2):
    add(f"DO-ACC-0{a}", "District Office", "Aruba 6100 24G 4SFP+", f"10.10.0.{10+a}")
buildings = [
    ("WHS", "Westfield HS", 4),
    ("OMS", "Oak MS", 3),
    ("MES", "Maple ES", 2),
    ("PES", "Pine ES", 2),
]
for i, (code, site, n) in enumerate(buildings, start=1):
    add(f"{code}-CORE-01", site, "Aruba 6300M 48G", f"10.10.{i}.1",
        oobm=(None if code == "PES" else f"192.168.100.{10+i}"), loop=f"10.255.0.{10+i}")
    for a in range(1, n + 1):
        add(f"{code}-ACC-0{a}", site, "Aruba 6100 48G 4SFP+" if a % 2 else "Aruba 6200F 48G",
            f"10.10.{i}.{10+a}",
            vlan99=(None if (code, a) == ("MES", 2) else True),
            status=("Offline" if (code, a) == ("WHS", 4) else "Online"))
# The ambiguous one: assigned to Oak MS, but LLDP-linked to both the Oak MS and Maple ES cores.
add("SPARE-SW-07", "Oak MS", "Aruba 6100 24G 4SFP+", "10.10.250.7", vlan99=None)

by = {s["name"]: s for s in SW}
for s in SW:
    s["serial"] = serial(s["name"])

LINKS = []  # (a, a_ports, b, b_ports, lag or None)
def link(a, ap, b, bp, lag=None):
    names = lambda p: [p] if isinstance(p, str) else list(p)
    LINKS.append((a, names(ap), b, names(bp), lag))
for i, (code, site, n) in enumerate(buildings, start=1):
    link("DO-CORE-01", f"1/1/{i}", f"{code}-CORE-01", "1/1/49")
    for a in range(1, n + 1):
        if (code, a) == ("PES", 2):
            continue
        link(f"{code}-CORE-01", f"1/1/{a}", f"{code}-ACC-0{a}", "1/1/49")
# DO-ACC-01 is a two-member LAG so the diagram can show "lag1 (1/1/49-50)".
link("DO-CORE-01", ["1/1/15", "1/1/16"], "DO-ACC-01", ["1/1/49", "1/1/50"], "lag1")
link("DO-CORE-01", "1/1/11", "DO-ACC-02", "1/1/49")
# Pine ES access 02 is daisy-chained off access 01 (hop 3 from the district core)
link("PES-ACC-01", "1/1/50", "PES-ACC-02", "1/1/49")
# Ambiguous spare: LLDP to Oak MS core and Maple ES core
link("OMS-CORE-01", "1/1/20", "SPARE-SW-07", "1/1/25")
link("MES-CORE-01", "1/1/20", "SPARE-SW-07", "1/1/26")

EXTERNAL = [  # local switch, local port, neighbour dict
    ("DO-CORE-01", "1/1/30", dict(name="DO-FW-01", type="Firewall", mac="00:1b:17:aa:01:01", toPort="ethernet1/1")),
    ("WHS-ACC-02", "1/1/14", dict(name="WHS-AP-114", type="Access Point", mac="20:4c:03:bb:11:14", toPort="eth0")),
]


def site_id(site):
    return str(2000000 + int(hashlib.sha1(site.encode()).hexdigest()[:5], 16))

def switch_device(s, function):
    return {"serial": s["serial"], "mac": mac(s["name"]), "name": s["name"], "health": "Good",
            "model": s["model"], "deviceFunction": function, "deployment": "Standalone",
            "status": "ONLINE" if s["status"] == "Online" else "OFFLINE", "type": "Switch",
            "ipv4": s["mon"], "healthReason": None, "conductorSerial": None, "internet": True,
            "lastSeen": 1793120400, "vlans": [1, 10, 99]}

def function_of(s):
    if s["name"] == "DO-CORE-01": return "Core Switch"
    if s["name"].endswith("-CORE-01"): return "Aggregation Switch"
    return "Access Switch"

def as_ports(p):
    return [p] if isinstance(p, str) else list(p)

def port_entries(names, lag=None):
    return [{"index": i, "name": name, "lag": lag, "health": "Good", "healthReason": None,
             "vlanId": 99, "vlanMode": "trunk", "allowedVlans": "1,10,99", "nativeVlan": "1"}
            for i, name in enumerate(as_ports(names), start=1)]

def edge(a, ap, b, bp, lag=None):
    return {"from": by[a]["serial"] if a in by else a, "to": by[b]["serial"] if b in by else b,
            "edgeType": "ETHERNET", "health": "Good", "healthReason": None, "speed": 10,
            "stpState": "Forwarding", "fromPortList": port_entries(ap, lag), "toPortList": port_entries(bp, lag),
            "isSibling": False}

sites = sorted({s["site"] for s in SW})
sites_health = {"items": [{"id": site_id(n), "type": "network-monitoring/site-health", "siteName": n,
                           "address": {"country": "US", "address": "", "city": "Westfield", "zipCode": "46074", "state": "IN"},
                           "devices": {"count": sum(1 for s in SW if s["site"] == n)}} for n in sites],
                "count": len(sites), "total": len(sites), "offset": 0}

# Per-site topology. Cross-site uplinks (building core -> district core) are
# included in the building's site with the district core as a device, EXCEPT
# Pine ES, whose uplink is left out on purpose so the Worker's LLDP fill-in
# (/network-monitoring/v1/neighbours/{serial}) is exercised. Whether real
# per-site topology includes cross-site peers is unverified.
topology = {}
for n in sites:
    sid = site_id(n)
    members = [s for s in SW if s["site"] == n]
    devs = {s["name"]: switch_device(s, function_of(s)) for s in members}
    links = []
    for a, ap, b, bp, lag in LINKS:
        sa, sb = by[a]["site"], by[b]["site"]
        if sa == n and sb == n:
            links.append(edge(a, ap, b, bp, lag))
        elif n in (sa, sb) and n != "District Office" and n != "Pine ES" and "DO-CORE-01" in (a, b):
            other = a if sb == n else b
            devs[other] = switch_device(by[other], function_of(by[other]))
            links.append(edge(a, ap, b, bp, lag))
        elif n in (sa, sb) and "SPARE-SW-07" in (a, b) and n == "Oak MS":
            other = a if sb == n else b
            devs[other] = switch_device(by[other], function_of(by[other]))
            links.append(edge(a, ap, b, bp, lag))
    for local, lport, e in EXTERNAL:
        if by[local]["site"] == n:
            tpd = "tpd_" + e["mac"].replace(":", "")
            devs[e["name"]] = {"serial": tpd, "mac": e["mac"], "name": e["name"], "health": "Good",
                               "model": None, "deviceFunction": None, "deployment": None, "status": "ONLINE",
                               "type": e["type"], "ipv4": None, "vlans": []}
            links.append(edge(local, lport, tpd, e["toPort"]))
    topology[sid] = {"id": sid, "type": "Topology", "devices": list(devs.values()), "links": links,
                     "isolatedDevicesCount": 0, "isolatedHealth": "Good"}

detail = {}
for s in SW:
    detail[s["serial"]] = {"id": s["serial"], "type": "network-monitoring/switch", "serialNumber": s["serial"],
                           "deviceName": s["name"], "model": s["model"], "switchType": "cx",
                           "siteName": s["site"], "siteId": site_id(s["site"]), "ipv4": s["mon"], "ipv6": None,
                           "publicIp": None, "status": s["status"], "switchRole": None, "deployment": "Standalone"}

neighbours = {}
for s in SW:
    neighbours[s["serial"]] = {"id": s["serial"], "type": "Neighbours", "neighbours": []}
for a, ap, b, bp, _lag in LINKS:
    for x, xports, y, yports in ((a, ap, b, bp), (b, bp, a, ap)):
        n = max(len(xports), len(yports))
        for i in range(n):
            xp = xports[min(i, len(xports) - 1)]
            yp = yports[min(i, len(yports) - 1)]
            neighbours[by[x]["serial"]]["neighbours"].append({
                "serial": by[y]["serial"], "name": y, "type": "Switch", "health": "Good",
                "localPort": xp, "toPort": yp, "siteId": site_id(by[y]["site"]), "siteName": by[y]["site"]})

vlans = {}
for s in SW:
    items = [
        {"id": "1", "type": "STATIC", "name": "DEFAULT_VLAN", "status": "Up", "ipv4": None, "voice": "false", "interfaces": []},
        {"id": "10", "type": "STATIC", "name": "STAFF", "status": "Up", "ipv4": None, "voice": "false", "interfaces": []},
        {"id": "99", "type": "STATIC", "name": "MGMT", "status": "Up", "ipv4": s["vlan99"], "voice": "false", "interfaces": []},
    ]
    if s["name"].endswith("CORE-01"):
        # cores route the user VLANs, so the SVI on VLAN 10 has an address too
        items[1]["ipv4"] = s["mon"].replace("10.10.", "10.20.")
    vlans[s["serial"]] = {"items": items, "count": len(items), "total": len(items), "offset": None}

interfaces = {}
for s in SW:
    items = []
    for a, ap, b, bp, _lag in LINKS:
        if s["name"] not in (a, b):
            continue
        ports, other = (ap, b) if s["name"] == a else (bp, a)
        for port in ports:
            items.append({"id": port, "name": port, "type": "ETHERNET", "status": "Up",
                          "operStatus": "Up", "adminStatus": "Up", "uplink": port.endswith(("/49", "/50", "/25", "/26")),
                          "neighbour": other, "neighbourSerial": by[other]["serial"], "ipv4": None})
    if s["oobm"]:
        items.append({"id": "mgmt", "name": "mgmt", "type": "MANAGEMENT", "status": "Up",
                      "operStatus": "Up", "adminStatus": "Up", "uplink": False, "ipv4": s["oobm"]})
    if s["loop"]:
        items.append({"id": "loopback0", "name": "loopback0", "type": "LOOPBACK", "status": "Up",
                      "operStatus": "Up", "adminStatus": "Up", "uplink": False, "ipv4": s["loop"]})
    interfaces[s["serial"]] = {"items": items, "count": len(items), "total": len(items), "offset": None}

def device_group(name):
    # Generic Central device-group names. One switch is blank, one is absent.
    if name == "SPARE-SW-07":
        return None
    if name == "DO-ACC-02":
        return ""
    if name.startswith("DO-"):
        return "Group 1"
    if name.startswith("WHS-") or name.startswith("OMS-"):
        return "Group 2"
    return "Group 3"

items = []
for s in SW:
    group = device_group(s["name"])
    if group is None:
        continue
    items.append({
        "serialNumber": s["serial"],
        "id": s["serial"],
        "deviceType": "SWITCH",
        "deviceGroupName": group,
        "type": "network-monitoring/device-monitoring",
    })
inventory = {"items": items, "count": len(items), "total": len(items), "next": None}

for fname, obj in [("sites-health.json", sites_health), ("topology.json", topology),
                   ("neighbours.json", neighbours), ("switch-detail.json", detail), ("vlans.json", vlans),
                   ("interfaces.json", interfaces), ("device-inventory.json", inventory)]:
    with open(os.path.join(HERE, fname), "w") as f:
        json.dump(obj, f, indent=1)
print(f"{len(SW)} switches in {len(sites)} sites, {len(LINKS)} switch links, {len(EXTERNAL)} external neighbours, {len(items)} inventory rows")
