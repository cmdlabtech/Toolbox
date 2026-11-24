"""Build and query a private, user-local index of the user's own Iris catalog.

Everything here is read at run time from the Iris cache on this computer:
part numbers and ids (part/part_*.mod), configurable products
(misc/prodlist_*.mod), manufacturer names (manu_*.mod), country
localization tables (look_*.mod), and the option labels of each product
model's "Select Model" pickers (prod/prod*_*.mod).

The index is written to ~/.iris-bom/ (or $IRIS_BOM_HOME) and never leaves the
computer. It must never be committed or shared: it is derived from catalog
data covered by the user's own Iris/vendor terms.

Never read: cache/deploy/*, user.mod, plist*.mod (price lists), systems/*.
modfile.assert_allowed enforces that.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any, Iterable, Optional

from . import modfile

INDEX_VERSION = 1
SELECT_LABEL = re.compile(r"^\s*select[\s_]*model[\s_]*:?\s*$", re.I)
QTY_LABEL = re.compile(r"^\s*quantity multiplier\s*$", re.I)
# Things inside option labels/tooltips that look like orderable part numbers.
SKU_TOKEN = re.compile(r"\b[A-Z0-9]{2,}(?:-[A-Z0-9]+)+\b|\b[A-Z]{1,3}\d{3,4}[A-Z]{1,2}\b")


def home_dir() -> Path:
    base = os.environ.get("IRIS_BOM_HOME")
    return Path(base).expanduser() if base else Path(os.path.expanduser("~")) / ".iris-bom"


def _signature(cache: Path) -> str:
    h = hashlib.sha256()
    for sub, pattern in (("misc", "*.mod"), ("part", "part_*.mod")):
        for p in sorted((cache / sub).glob(pattern)):
            if modfile.FORBIDDEN_NAMES.match(p.name):
                continue
            st = p.stat()
            h.update(f"{sub}/{p.name}:{st.st_size}:{int(st.st_mtime)}".encode())
    prod = cache / "prod"
    if prod.is_dir():
        files = list(prod.glob("prod*_*.mod"))
        newest = max((int(p.stat().st_mtime) for p in files), default=0)
        h.update(f"prod:{len(files)}:{newest}".encode())
    h.update(str(cache.resolve()).encode())
    return h.hexdigest()[:16]


def index_path(cache: Path) -> Path:
    return home_dir() / f"index-{_signature(cache)}.json.gz"


def load_or_build(cache: Path, *, rebuild: bool = False, log=print) -> dict[str, Any]:
    cache = Path(cache)
    path = index_path(cache)
    if path.exists() and not rebuild:
        with gzip.open(path, "rt", encoding="utf-8") as fh:
            data = json.load(fh)
        if data.get("version") == INDEX_VERSION:
            return data
    log(f"Building local catalog index from {cache} (first run can take a minute)...")
    data = build_index(cache)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path.parent, 0o700)
    except OSError:
        pass
    tmp = path.with_suffix(".tmp")
    with gzip.open(tmp, "wt", encoding="utf-8") as fh:
        json.dump(data, fh)
    tmp.replace(path)
    log(
        f"Indexed {len(data['parts'])} parts, {len(data['products'])} products, "
        f"{len(data['select_options'])} model options -> {path}"
    )
    return data


def build_index(cache: Path) -> dict[str, Any]:
    cache = Path(cache)
    data: dict[str, Any] = {
        "version": INDEX_VERSION,
        "cache": str(cache),
        "parts": {},
        "products": {},
        "manufacturers": {},
        "select_options": {},
        "countries": {},
        "localization": [],
        "qty_property": None,
    }
    for path in modfile.safe_glob(cache, ["**/manu_*.mod"]):
        _, body = modfile.read_mod(path)
        for org in modfile.iter_blocks(body, "ORGANIZATION"):
            f = modfile.leaf_fields(org)
            if f.get("ORGID") and f.get("NAME"):
                data["manufacturers"][f["ORGID"]] = f["NAME"]

    for path in modfile.safe_glob(cache, ["misc/prodlist_*.mod"]):
        _, body = modfile.read_mod(path)
        for item in modfile.iter_blocks(body, "LISTINGITEM"):
            pn = modfile.field(item, "PARTNUMBER")
            pid = modfile.field(item, "PRODUCTID")
            if not pn or not pid:
                continue
            data["products"].setdefault(
                pn.upper(),
                {
                    "sku": pn,
                    "productid": pid,
                    "modelver": modfile.field(item, "MODELVER") or "1",
                    "label": modfile.field(item, "LABEL"),
                    "typelabel": modfile.field(item, "TYPELABEL"),
                    "manufacturer": modfile.field(item, "MANUNAME"),
                },
            )

    for path in modfile.safe_glob(cache, ["part/part_*.mod"]):
        _, body = modfile.read_mod(path)
        for item in modfile.iter_blocks(body, "PART"):
            pn = modfile.field(item, "PARTNUMBER")
            partid = modfile.field(item, "PARTID")
            if not pn or not partid:
                continue
            data["parts"].setdefault(
                pn.upper(),
                {
                    "sku": pn,
                    "partid": partid,
                    "description": modfile.field(item, "DESCRIPTION"),
                    "manufacturer_id": modfile.field(item, "MANUFACTURERID"),
                },
            )

    for path in modfile.safe_glob(cache, ["**/look_*.mod"]):
        _, body = modfile.read_mod(path)
        for lookup in modfile.iter_blocks(body, "LOOKUP"):
            _index_lookup(lookup, data)

    prod = cache / "prod"
    if prod.is_dir():
        for path in modfile.safe_glob(prod, ["prod*_*.mod"]):
            m = re.match(r"^prod(\d+)_(\d+)\.mod$", path.name)
            if not m:
                continue
            try:
                _, body = modfile.read_mod(path)
            except Exception:  # noqa: BLE001 - skip unreadable models
                continue
            _index_model(m.group(1), m.group(2), body, data)
    return data


def _index_lookup(lookup: str, data: dict[str, Any]) -> None:
    columns = {}
    for col in re.findall(r"<COLUMN>([^<]*)</COLUMN>", lookup):
        cells = col.split("\t")
        if cells:
            columns[cells[0].strip()] = cells[1:]
    numbs = columns.get("CountryNumb")
    if not numbs:
        return
    names = columns.get("Country") or []
    for i, numb in enumerate(numbs):
        if i < len(names) and names[i] and names[i] != "0":
            data["countries"].setdefault(names[i].strip().casefold(), numb.strip())
    table = {"label": modfile.field(lookup, "LABEL"), "columns": {}}
    for name, cells in columns.items():
        if name in ("CountryNumb", "Country"):
            continue
        table["columns"][name] = {numbs[i].strip(): cells[i] for i in range(min(len(numbs), len(cells)))}
    data["localization"].append(table)


def _index_model(productid: str, modelver: str, body: str, data: dict[str, Any]) -> None:
    for prop in modfile.iter_blocks(body, "PROPERTY"):
        top = re.sub(r"<OPTIONS>.*?</OPTIONS>", "", prop, flags=re.S)
        label = modfile.field(top, "LABEL")
        if data["qty_property"] is None and QTY_LABEL.match(label or ""):
            data["qty_property"] = {
                "id": modfile.field(top, "PROPERTYID"),
                "label": label,
                "flags": modfile.field(top, "PROPFLAGSDEF") or "0",
                "source": f"prod{productid}_{modelver}",
            }
        if not SELECT_LABEL.match(label or ""):
            continue
        for opt in modfile.iter_blocks(prop, "OPTION"):
            olabel = modfile.field(opt, "LABEL").strip()
            tip = modfile.field(opt, "TOOLTIP")
            keys = {olabel.upper()} if olabel else set()
            keys |= {t.upper() for t in SKU_TOKEN.findall(f"{olabel} {tip}".upper())}
            for key in keys:
                bucket = data["select_options"].setdefault(key, [])
                ref = {"productid": productid, "modelver": modelver}
                if ref not in bucket:
                    bucket.append(ref)


# ---------------------------------------------------------------- queries


def part(index: dict[str, Any], sku: str) -> Optional[dict[str, Any]]:
    return index["parts"].get((sku or "").strip().upper())


def manufacturer_name(index: dict[str, Any], sku: str) -> str:
    prod = index["products"].get((sku or "").upper())
    if prod and prod.get("manufacturer"):
        return prod["manufacturer"]
    p = part(index, sku)
    if p and p.get("manufacturer_id"):
        return index["manufacturers"].get(p["manufacturer_id"], "")
    return ""


def resolve_product(
    index: dict[str, Any], sku: str, *, family_sku: str = "", region: str = ""
) -> tuple[Optional[dict[str, str]], str]:
    """Find the configurable product (PRODUCTID/MODELVER) for a SKU.

    Returns (record or None, how). Never guesses: ambiguous matches return None.
    """
    key = (sku or "").strip().upper()
    if family_sku:
        rec = index["products"].get(family_sku.strip().upper())
        if rec:
            return rec, f"family_sku {family_sku}"
        return None, f"family_sku {family_sku} is not a product in your Iris catalog"
    if key in index["products"]:
        return index["products"][key], "product list"
    for candidate in _candidates(key, region):
        refs = index["select_options"].get(candidate) or []
        if len(refs) == 1:
            return refs[0], f"model option {candidate}"
        if len(refs) > 1:
            return None, (
                f"{sku} appears as a model option in {len(refs)} products; "
                "set family_sku on the line to pick one"
            )
    return None, "not a configurable product"


def _candidates(key: str, region: str) -> list[str]:
    out = [key]
    base = strip_region(key, region)
    if base != key:
        out.append(base)
    return out


def strip_region(sku: str, region: str) -> str:
    if region and sku.upper().endswith("-" + region.upper()):
        return sku[: -(len(region) + 1)]
    return sku


def country_number(index: dict[str, Any], country_name: str) -> str:
    return index["countries"].get((country_name or "").strip().casefold(), "")


def localized_values(index: dict[str, Any], country_numb: str) -> list[tuple[str, str, str]]:
    """[(lookup label, column, value)] for a country across localization tables."""
    out = []
    for table in index.get("localization") or []:
        for col, values in table["columns"].items():
            v = values.get(country_numb)
            if v:
                out.append((table["label"], col, v))
    return out


def all_skus(lines: Iterable[dict[str, Any]]) -> list[str]:
    seen: list[str] = []
    for line in lines:
        s = (line.get("sku") or "").strip()
        if s and s not in seen:
            seen.append(s)
    return seen
