"""Load a BOM spec (JSON or CSV) into the normalized form the writers use.

JSON:
  {"project": "...", "client": "...", "vendor": "juniper|aruba|hpe|fortinet|...",
   "region": "US", "price_list": "optional text for the Price List column",
   "sites": [{"name": "Site 1", "lines": [
       {"sku": "...", "qty": 2, "description": "...", "parent": "",
        "unit_price": 0, "model_option": "", "family_sku": "", "iris_sku": "",
        "power_cord": "", "included": false, "standalone": false, "duration": ""}]}]}
  A top-level "lines" list is treated as one site named "Site 1".

CSV (header row required, case-insensitive):
  site, sku (or "part number"), qty (or "quantity"), description, parent
  (or "parent sku"), unit_price, model_option, family_sku, iris_sku, power_cord
"""

from __future__ import annotations

import csv
import json
import re
from pathlib import Path
from typing import Any

FIELD_ALIASES = {
    "part number": "sku", "part": "sku", "sku": "sku", "product number": "sku",
    "qty": "qty", "quantity": "qty",
    "description": "description",
    "parent": "parent", "parent sku": "parent",
    "site": "site", "site name": "site",
    "unit price": "unit_price", "unit_price": "unit_price",
    "model_option": "model_option", "model option": "model_option",
    "family_sku": "family_sku", "family sku": "family_sku",
    "iris_sku": "iris_sku", "iris sku": "iris_sku",
    "power_cord": "power_cord", "power cord": "power_cord",
    "duration": "duration",
}


def load_spec(path: Path) -> dict[str, Any]:
    path = Path(path)
    if path.suffix.lower() == ".csv":
        spec = _from_csv(path)
    else:
        spec = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(spec, dict) or not ("sites" in spec or "lines" in spec):
            raise ValueError(f"{path}: expected an object with 'sites' or 'lines'")
    spec.setdefault("project", path.stem)
    return normalize(spec)


def _from_csv(path: Path) -> dict[str, Any]:
    sites: dict[str, list[dict[str, Any]]] = {}
    with path.open(newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            item: dict[str, Any] = {}
            for key, value in row.items():
                name = FIELD_ALIASES.get((key or "").strip().lower())
                if name and value not in (None, ""):
                    item[name] = value.strip()
            if not item.get("sku"):
                continue
            site = item.pop("site", "") or "Site 1"
            sites.setdefault(site, []).append(item)
    return {"sites": [{"name": k, "lines": v} for k, v in sites.items()]}


def normalize(spec: dict[str, Any]) -> dict[str, Any]:
    if spec.get("lines") and not spec.get("sites"):
        spec["sites"] = [{"name": "Site 1", "lines": spec.pop("lines")}]
    for i, site in enumerate(spec.get("sites") or []):
        site.setdefault("name", f"Site {i + 1}")
        cleaned = []
        for line in site.get("lines") or []:
            item = dict(line)
            item["sku"] = str(item.get("sku") or "").strip()
            try:
                item["qty"] = int(str(item.get("qty", 0)).split()[0])
            except (TypeError, ValueError, IndexError):
                item["qty"] = 0
            parent = str(item.get("parent") or "").strip()
            item["parent"] = parent
            if parent and not item.get("duration"):
                item["duration"] = duration_from_sku(item["sku"])
            if parent and item["sku"].upper().endswith("-BND"):
                item.setdefault("juniper_bundle_child", True)
            if "standalone" not in item:
                item["standalone"] = looks_standalone(item["sku"], parent)
            cleaned.append(item)
        site["lines"] = cleaned
    return spec


def duration_from_sku(sku: str) -> str:
    """Term in months from common subscription naming (3Y, or 3M1 flex terms)."""
    m = re.search(r"(\d+)Y", sku, re.I) or re.search(r"(\d+)M1", sku, re.I)
    return str(int(m.group(1)) * 12) if m else ""


def looks_standalone(sku: str, parent: str) -> bool:
    if parent:
        return False
    upper = sku.upper()
    return any(t in upper for t in ("DAC", "SFP", "OPTIC", "CBL-", "CABLE"))


def all_lines(spec: dict[str, Any]) -> list[dict[str, Any]]:
    return [line for site in spec.get("sites") or [] for line in site.get("lines") or []]
