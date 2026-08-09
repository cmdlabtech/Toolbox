#!/usr/bin/env python3
"""Generate the GreenLake × Aruba Central AP licensing report.

Usage:
  python run_report.py                        # live data via config.ini
  python run_report.py -c my.ini -o out.html --dump-json raw.json
"""

import argparse
import json
import sys

from glc.central import CentralClient, CentralError
from glc.config import ConfigError, load_config, validate_config
from glc.correlate import correlate
from glc.greenlake import GreenLakeClient, GreenLakeError
from glc.new_central import NewCentralClient, NewCentralError
from glc.report import write_report


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-c", "--config", default="config.ini",
                    help="path to config file (default: config.ini)")
    ap.add_argument("-o", "--output", default="ap_license_report.html",
                    help="output HTML file (default: ap_license_report.html)")
    ap.add_argument("--expiring-days", type=int, default=90,
                    help="flag subscriptions ending within N days (default: 90)")
    ap.add_argument("--include-non-ap", action="store_true",
                    help="include switches/gateways from GreenLake, not just APs")
    ap.add_argument("--dump-json", metavar="FILE",
                    help="also write the raw API payloads to FILE for debugging")
    args = ap.parse_args(argv)

    cfg = load_config(args.config)
    try:
        validate_config(cfg)
    except ConfigError as exc:
        print(f"Configuration problems:\n{exc}\n\n"
              f"Copy config.example.ini to config.ini and fill it in.",
              file=sys.stderr)
        return 2
    try:
        gl = GreenLakeClient(**cfg["greenlake"])
        devices = gl.get_devices()
        subs = gl.get_subscriptions()
    except GreenLakeError as exc:
        print(f"GreenLake API error: {exc}", file=sys.stderr)
        return 1
    central_cfg = dict(cfg["central"])
    mode = central_cfg.pop("mode", "classic")
    try:
        if mode == "new":
            source = "New Central (GreenLake-native)"
            nc = NewCentralClient(
                base_url=central_cfg["base_url"],
                client_id=central_cfg["client_id"] or cfg["greenlake"]["client_id"],
                client_secret=(central_cfg["client_secret"]
                               or cfg["greenlake"]["client_secret"]),
                sso_url=cfg["greenlake"]["sso_url"],
            )
            aps = nc.get_aps()
        else:
            source = "Classic Aruba Central"
            ce = CentralClient(**central_cfg)
            aps = ce.get_aps()
    except (CentralError, NewCentralError) as exc:
        print(f"Aruba Central API error: {exc}", file=sys.stderr)
        return 1

    if args.dump_json:
        with open(args.dump_json, "w") as fh:
            json.dump({"greenlake_devices": devices,
                       "greenlake_subscriptions": subs,
                       "central_aps": aps}, fh, indent=2, default=str)
        print(f"Raw payloads written to {args.dump_json}", file=sys.stderr)

    data = correlate(devices, subs, aps,
                     expiring_days=args.expiring_days,
                     include_non_ap=args.include_non_ap,
                     central_source=source)
    write_report(data, args.output)

    s = data["summary"]
    print(f"\nReport written to {args.output}", file=sys.stderr)
    print(f"  APs: {s['total_aps']}  (Up {s['up']} / Down {s['down']})\n"
          f"  Unlicensed: {s['unlicensed']}   "
          f"Down + licensed (detach candidates): {s['down_licensed']}\n"
          f"  Subscriptions: {s['subscriptions']}  "
          f"(expiring soon: {s['expiring_soon']}, devices on expired keys: "
          f"{s['expired']})", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
