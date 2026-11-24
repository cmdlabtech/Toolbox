"""Decode, encode, and generate Iris project files (.isf).

An .isf is the same Intangi wrapper as a catalog module: a short header, a
zlib (level 6) XML-ish payload, and a closing tag. See docs/isf-format.md.

Generated projects are cloned from a project the user saved in their own
Iris (--template). Project-level settings, header values, drawing
boilerplate, and record layouts all come from that file; only names, dates,
sites, equipment, and parts are replaced. Account ids are zeroed.
"""

from __future__ import annotations

import copy
import re
import uuid
import zlib
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from . import catalog, configure, modfile, xmlfmt
from .models import ModelStore, learned_from_template
from .xmlfmt import Node

ZLIB_LEVEL = 6


@dataclass
class IrisFile:
    header: dict[str, str]
    header_order: list[str]
    payload: bytes
    root: Node


def decode_isf(data: bytes | str | Path) -> IrisFile:
    raw = Path(data).read_bytes() if isinstance(data, (str, Path)) else data
    head, payload, footer = modfile.split_wrapper(raw)
    if footer.rstrip(b"\n") != modfile.FOOTER:
        raise ValueError(f"unexpected footer: {footer[:40]!r}")
    text = head.decode("utf-8")
    pairs = re.findall(r"<([A-Z_]+)>([^<]*)</\1>", text)
    decompressed = zlib.decompress(payload)
    return IrisFile(
        header={k: v for k, v in pairs},
        header_order=[k for k, _ in pairs],
        payload=decompressed,
        root=xmlfmt.parse(decompressed.decode("utf-8")),
    )


def header_bytes(header: dict[str, str], order: list[str]) -> bytes:
    lines = ['<?xml version="1.0" encoding="UTF-8" ?>', "<INTANGI_FILE_EX>"]
    lines += [f"<{k}>{header.get(k, '')}</{k}>" for k in order]
    lines.append("")
    return "\n".join(lines).encode("utf-8")


def encode(header: dict[str, str], order: list[str], payload: bytes | str) -> bytes:
    if isinstance(payload, str):
        payload = payload.encode("utf-8")
    return header_bytes(header, order) + zlib.compress(payload, ZLIB_LEVEL) + modfile.FOOTER + b"\n"


def encode_tree(iris: IrisFile) -> bytes:
    return encode(iris.header, iris.header_order, xmlfmt.serialize(iris.root))


def stamp(when: Optional[datetime] = None) -> str:
    when = (when or datetime.now()).astimezone()
    return when.strftime("%Y-%m-%d:%H:%M:%S")


def _leaf(tag: str, value: Any = "") -> Node:
    return Node(tag, text="" if value is None else str(value))


def _branch(tag: str, children) -> Node:
    return Node(tag, children=list(children))


def _set(node: Node, tag: str, value: Any) -> None:
    """Set every direct leaf named tag (Iris repeats POSX/POSY on SITE)."""
    for c in node.children or []:
        if c.tag == tag and c.children is None:
            c.text = str(value)


def _first(root: Node, tag: str) -> Optional[Node]:
    for n in root.iter_descendants():
        if n.tag == tag:
            return n
    return None


class TemplateError(ValueError):
    pass


@dataclass
class Template:
    iris: IrisFile
    site: Node
    equipment: Node
    miscpart: Optional[Node]
    qty_prop: Optional[dict[str, str]]
    learned: dict[str, list[dict[str, str]]]


def load_template(path: Path) -> Template:
    iris = decode_isf(Path(path))
    root = iris.root
    for tag in ("DETAIL", "DESIGNS", "SITES", "MATERIALS", "LAYERS", "DESGRPS"):
        if root.find(tag) is None:
            raise TemplateError(f"template is missing <{tag}>; save a fresh project in Iris and try again")
    designs = root.find("DESIGNS").findall("DESIGN")
    if not designs or designs[0].find("DISPLAYGROUP") is None:
        raise TemplateError("template has no DESIGN/DISPLAYGROUP")
    sites = root.find("SITES").findall("SITE")
    if not sites:
        raise TemplateError("template has no site; save a project with one site")
    equipment = _first(root, "EQUIPMENT")
    if equipment is None:
        raise TemplateError(
            "template has no device. In Iris, create a new project, place any one configurable "
            "device on the site, save it, and pass that file as --template"
        )
    qty = None
    for p in (equipment.find("PROPERTYS") or Node("PROPERTYS", children=[])).findall("PROPERTY"):
        if catalog.QTY_LABEL.match(p.text_of("LABEL") or ""):
            qty = {"id": p.text_of("PROPERTYID") or "", "label": p.text_of("LABEL") or "",
                   "flags": p.text_of("PROPFLAGSCUR") or "0"}
    return Template(
        iris=iris,
        site=sites[0],
        equipment=equipment,
        miscpart=_first(root, "MISCPART"),
        qty_prop=qty,
        learned=learned_from_template(root),
    )


_CLEAR_TEXT = (
    "DESCRIPTION", "COMMENT", "REV", "PAYMENT", "DELIVERY", "SHIPPING",
    "ADDRESS0", "ADDRESS1", "ADDRESS2", "ADDRESS3", "CONTACT",
)
_ACCOUNT_FIELDS = ("CREATEBY", "OWNERUSERID")
_EMPTY_LISTS = (
    "INTEGDATAARRAY", "CUSTOMPARTARRAY", "ALIASPARTARRAY", "UPLOADARRAY",
    "TEAMMEMBERS", "DISCOUNTS", "ADJUSTMENTS", "MISCPARTS", "ACTIVITYLOG",
    "PLUGINDATAARRAY", "PATHS", "USERIMAGES",
)


def _scrub(holder: Node) -> None:
    """Clear free text, account ids, and per-project lists on one record."""
    for n in holder.children or []:
        if n.children is None and n.tag in _CLEAR_TEXT:
            n.text = ""
        elif n.children is None and n.tag in _ACCOUNT_FIELDS:
            n.text = "0"
        elif n.children is not None and n.tag in _EMPTY_LISTS:
            n.children = []


def build_isf(
    *,
    project_name: str,
    sites: list[dict[str, Any]],
    template: Template,
    index: dict[str, Any],
    store: ModelStore,
    region: str,
    country_numb: str,
    allow_partial: bool = False,
    when: Optional[datetime] = None,
) -> tuple[bytes, list[str], list[str]]:
    """Return (file bytes, notes, errors)."""
    now = stamp(when)
    notes: list[str] = []
    errors: list[str] = []
    root = copy.deepcopy(template.iris.root)

    qty_prop = template.qty_prop or index.get("qty_property")
    if not qty_prop or not qty_prop.get("id"):
        raise TemplateError(
            "could not find the 'Quantity Multiplier' property in your template or product models"
        )

    detail = root.find("DETAIL")
    _set(detail, "SYSTEMID", "0")
    _set(detail, "SYSGUID", str(uuid.uuid4()))
    _set(detail, "NAME", project_name)
    _set(detail, "LOCATION", project_name)
    if country_numb:
        _set(detail, "COUNTRY", country_numb)
    else:
        notes.append("country number not found in your localization tables; kept the template's COUNTRY")
    _set(detail, "CREATEDATE", now)
    _set(detail, "MODIFYDATE", now)
    ids = [str(i + 1) for i in range(len(sites))]
    _set(detail, "OPENSITES", "0," + ",".join(ids) + (f",{len(sites)}" if sites else ""))
    design = root.find("DESIGNS").findall("DESIGN")[0]
    root.find("DESIGNS").children = [design]
    for holder in (root, detail, design):
        _scrub(holder)
    _set(design, "LABEL", project_name)
    _set(design, "ASOFDATE", now)

    site_nodes = []
    for i, site in enumerate(sites):
        sid = i + 1
        name = site.get("name") or f"Site {sid}"
        node = copy.deepcopy(template.site)
        _scrub(node)
        _set(node, "SITEID", sid)
        _set(node, "SITENAME", name)
        posx = (node.text_of("POSX") or "0")
        try:
            _set(node, "POSX", int(float(posx)) + i * 120)
        except ValueError:
            pass
        eq, misc, n_notes, n_errors = _site_contents(
            site.get("lines") or [], template, index, store, region, country_numb,
            qty_prop, now, allow_partial, prefix=f"{name}: ",
        )
        notes += n_notes
        errors += n_errors
        designset = node.find("DESIGNSET")
        workspaces = designset.find("WORKSPACES") if designset is not None else None
        children = [_branch("EQUIPMENTS", eq)]
        if misc:
            children.append(_branch("MISCPARTS", misc))
        if workspaces is not None:
            children.append(workspaces)
        if designset is None:
            node.children.append(_branch("DESIGNSET", children))
        else:
            designset.children = children
        site_nodes.append(node)
    root.find("SITES").children = site_nodes

    header = dict(template.iris.header)
    header["FILE_DATE"] = now
    for k in ("USER_ORG", "USER"):
        if k in header:
            header[k] = "0"
    data = encode(header, template.iris.header_order, xmlfmt.serialize(root))
    decode_isf(data)  # must re-decode cleanly
    return data, notes, errors


def _site_contents(lines, template, index, store, region, country_numb, qty_prop, now, allow_partial, prefix):
    notes: list[str] = []
    errors: list[str] = []
    roots: list[dict[str, Any]] = []
    by_sku: dict[str, dict[str, Any]] = {}
    for line in lines:
        sku = (line.get("sku") or "").strip()
        if not sku:
            continue
        rec = {**line, "sku": sku, "qty": int(line.get("qty") or 0), "children": []}
        parent = (line.get("parent") or "").strip()
        if parent and parent in by_sku:
            by_sku[parent]["children"].append(rec)
        else:
            roots.append(rec)
            by_sku[sku] = rec

    equipments: list[Node] = []
    misc: list[Node] = []
    for rec in roots:
        sku = rec["sku"]
        if rec["qty"] == 0:
            notes.append(f"{prefix}{sku} qty 0 left out of the .isf (kept in exports)")
            continue
        iris_sku = rec.get("iris_sku") or sku
        part = catalog.part(index, iris_sku)
        if not part:
            errors.append(f"{prefix}{sku} is not in your Iris part catalog; left out of the .isf")
            continue
        product, how = catalog.resolve_product(index, iris_sku, family_sku=rec.get("family_sku") or "", region=region)
        if product is None and rec.get("family_sku"):
            errors.append(f"{prefix}{sku}: {how}")
            continue
        if product is None:
            if "appears as a model option" in how:
                errors.append(f"{prefix}{how}")
                continue
            if template.miscpart is None:
                errors.append(
                    f"{prefix}{sku} is a loose part, and your template has no loose part to copy the "
                    "record layout from; add one loose accessory to the template project"
                )
                continue
            node = copy.deepcopy(template.miscpart)
            _set(node, "MISCID", len(misc) + 1)
            _set(node, "PARTID", part["partid"])
            _set(node, "MISCPARTQTY", rec["qty"])
            misc.append(node)
            for child in rec["children"]:
                notes.append(f"{prefix}child {child['sku']} of loose part {sku} not placed")
            continue

        model = store.load(product["productid"], product.get("modelver") or "1")
        choice = configure.equipment_properties(
            sku=iris_sku, line=rec, model=model, children=rec["children"],
            index=index, region=region, country_numb=country_numb,
        )
        notes += [prefix + n for n in choice.notes]
        if choice.errors:
            errors += [prefix + e for e in choice.errors]
            if not allow_partial:
                errors.append(f"{prefix}{sku} left out of the .isf because of the error(s) above")
                continue
        eqparts = [_eqpart(part["partid"], iris_sku, 1, "1")]
        for child in rec["children"]:
            if child["qty"] == 0:
                continue
            cpart = catalog.part(index, child.get("iris_sku") or child["sku"])
            if not cpart:
                errors.append(f"{prefix}child {child['sku']} of {sku} is not in your part catalog; left out")
                continue
            eqparts.append(_eqpart(cpart["partid"], child["sku"], 1, "3"))
        node = copy.deepcopy(template.equipment)
        n = len(equipments) + 1
        node.children = [c for c in node.children if c.children is None]
        _set(node, "EQUIPMENTID", n)
        _set(node, "INSTALLDATE", now)
        _set(node, "PARTID", part["partid"])
        _set(node, "PRODUCTID", product["productid"])
        _set(node, "MODELVERSION", product.get("modelver") or "1")
        for tag, val in (("BV_POSITIONX", 100 + (n - 1) * 40), ("BV_POSITIONY", 160 + (0 if n % 2 else 80))):
            _set(node, tag, val)
        props = [_prop(p) for p in choice.props]
        props.append(_prop({**qty_prop, "value": str(rec["qty"]), "code": ""}))
        # Keep the template's element order: leaves, then PROPERTYS, EQPARTS.
        node.children += [_branch("PROPERTYS", props), _branch("EQPARTS", eqparts)]
        equipments.append(node)
    return equipments, misc, notes, errors


def _prop(p: dict[str, str]) -> Node:
    return _branch(
        "PROPERTY",
        [
            _leaf("PROPERTYID", p["id"]),
            _leaf("LABEL", p.get("label", "")),
            _leaf("VALUE", p.get("value", "")),
            _leaf("CODE", p.get("code", "")),
            _leaf("PROPFLAGSCUR", p.get("flags", "0")),
        ],
    )


def _eqpart(partid: str, partnum: str, qty: int, source: str) -> Node:
    return _branch(
        "EQPART",
        [
            _leaf("PRT_ID", partid),
            _leaf("PRT_NUM", partnum),
            _leaf("UOM_QTY", "0"),
            _leaf("PRT_QTY", str(qty)),
            _leaf("SOURCE", source),
        ],
    )
