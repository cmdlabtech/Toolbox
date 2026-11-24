"""Read product models (prod<PRODUCTID>_<MODELVER>.mod) from the user's own
Iris cache and resolve configurator properties by their label and option text.

Nothing here hardcodes a property id, option code, or flag value. Ids, codes
(option ids), and default flags come from the model files on this computer,
or from a project the user saved in their own Iris (the --template file),
which shows what Iris itself writes for the same product.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from . import modfile

SUBMODEL_SHIFT = 16  # sub-model property ids are (instance << 16) | local id


@dataclass
class Option:
    code: str
    label: str
    tooltip: str = ""


@dataclass
class PropDef:
    id: str
    label: str
    flags: str = "0"
    datatype: str = ""
    valuedef: str = ""
    codedef: str = ""
    options: list[Option] = field(default_factory=list)
    instance: int = 0  # 0 = the product model itself
    source: str = ""

    def option_by_label(self, label: str) -> Optional[Option]:
        want = (label or "").strip().casefold()
        for opt in self.options:
            if opt.label.strip().casefold() == want:
                return opt
        return None


@dataclass
class SubModel:
    instance: int
    productid: str
    modelver: str


@dataclass
class Model:
    productid: str
    modelver: str
    path: Optional[Path]
    props: list[PropDef] = field(default_factory=list)
    submodels: list[SubModel] = field(default_factory=list)
    submodel_problems: list[str] = field(default_factory=list)

    def find(self, pattern: re.Pattern[str], *, include_sub: bool = True) -> list[PropDef]:
        return [p for p in self.props if pattern.search(p.label or "") and (include_sub or p.instance == 0)]


class ModelStore:
    """Loads product models from cache/prod and merges in what the user's own
    saved template project shows for the same product."""

    def __init__(self, cache: Path, learned: Optional[dict[str, list[dict[str, str]]]] = None):
        self.cache = Path(cache)
        self.prod = self.cache / "prod"
        self.learned = learned or {}
        self._cache: dict[tuple[str, str], Model] = {}

    def model_path(self, productid: str, modelver: str) -> Optional[Path]:
        exact = self.prod / f"prod{productid}_{modelver}.mod"
        if exact.is_file():
            return exact
        found = sorted(
            self.prod.glob(f"prod{productid}_*.mod"),
            key=lambda p: int(re.sub(r"\D", "", p.stem.split("_")[-1]) or 0),
        )
        return found[-1] if found else None

    def load(self, productid: str, modelver: str = "1", *, depth: int = 0) -> Model:
        key = (str(productid), str(modelver))
        if key in self._cache:
            return self._cache[key]
        path = self.model_path(*key)
        model = Model(productid=key[0], modelver=key[1], path=path)
        if path is not None:
            _, body = modfile.read_mod(path)
            model.props = parse_props(body, source=path.name)
            if depth == 0:
                subs, problems = parse_submodels(body, key[0], self)
                model.submodels = subs
                model.submodel_problems = problems
                for sub in subs:
                    child = self.load(sub.productid, sub.modelver, depth=depth + 1)
                    for p in child.props:
                        try:
                            local = int(p.id)
                        except ValueError:
                            continue
                        if local >= (1 << SUBMODEL_SHIFT):
                            continue
                        model.props.append(
                            PropDef(
                                id=str((sub.instance << SUBMODEL_SHIFT) | local),
                                label=p.label,
                                flags=p.flags,
                                datatype=p.datatype,
                                valuedef=p.valuedef,
                                codedef=p.codedef,
                                options=list(p.options),
                                instance=sub.instance,
                                source=f"{p.source} (sub-model instance {sub.instance})",
                            )
                        )
        if depth == 0:
            _merge_learned(model, self.learned.get(key[0]) or [])
        self._cache[key] = model
        return model


def parse_props(body: str, source: str = "") -> list[PropDef]:
    props: list[PropDef] = []
    # Restrict to the model's own PROPERTIES section when present.
    m = re.search(r"<PROPERTIES>(.*)</PROPERTIES>", body, re.S)
    section = m.group(1) if m else body
    for block in modfile.iter_blocks(section, "PROPERTY"):
        top = re.sub(r"<OPTIONS>.*?</OPTIONS>", "", block, flags=re.S)
        pid = modfile.field(top, "PROPERTYID")
        if not pid:
            continue
        options = [
            Option(
                code=modfile.field(o, "OPTIONID"),
                label=modfile.field(o, "LABEL"),
                tooltip=modfile.field(o, "TOOLTIP"),
            )
            for o in modfile.iter_blocks(block, "OPTION")
        ]
        props.append(
            PropDef(
                id=pid,
                label=modfile.field(top, "LABEL"),
                flags=modfile.field(top, "PROPFLAGSDEF") or "0",
                datatype=modfile.field(top, "DATATYPE"),
                valuedef=modfile.field(top, "VALUEDEF"),
                codedef=modfile.field(top, "CODEDEF"),
                options=options,
                source=source,
            )
        )
    return props


_INSTANCE_KEYS = ("INSTANCE", "SUBMODELID", "SUBID", "SEQUENCE", "OFFSET", "INDEX", "ID")


def parse_submodels(body: str, parent_productid: str, store: ModelStore) -> tuple[list[SubModel], list[str]]:
    """Best-effort read of the SUBMODELS section.

    The exact tag names are not published, so this looks for a child record
    that names another product model that exists in the cache, plus a small
    integer instance number. Anything it cannot read is reported, never
    guessed.
    """
    m = re.search(r"<SUBMODELS>(.*?)</SUBMODELS>", body, re.S)
    if not m or not m.group(1).strip():
        return [], []
    inner = m.group(1)
    records = re.findall(r"<([A-Z0-9_]+)>\n(.*?)</\1>", inner, re.S)
    subs: list[SubModel] = []
    problems: list[str] = []
    for tag, rec in records:
        fields = modfile.leaf_fields(rec)
        prod_key = None
        for k, v in fields.items():
            if ("PRODUCT" in k or "MODEL" in k) and "VER" not in k and v.isdigit() and v != parent_productid:
                if store.model_path(v, fields.get("MODELVER") or "1") is not None:
                    prod_key = k
                    break
        if prod_key is None:
            problems.append(f"could not read sub-model record <{tag}> (no product reference found)")
            continue
        productid = fields[prod_key]
        ver = ""
        for k, v in fields.items():
            if "VER" in k and v.isdigit() and (k.replace("VER", "") in prod_key or k.startswith("SUB")):
                ver = v
                break
        ver = ver or fields.get("MODELVER") or "1"
        instance = None
        for want in _INSTANCE_KEYS:
            for k, v in fields.items():
                if k == prod_key or "PRODUCT" in k or "VER" in k:
                    continue
                if want in k and v.isdigit() and 0 < int(v) < (1 << 15):
                    instance = int(v)
                    break
            if instance is not None:
                break
        if instance is None:
            problems.append(f"sub-model {productid}: instance number not found in <{tag}>")
            continue
        subs.append(SubModel(instance=instance, productid=productid, modelver=ver))
    return subs, problems


def _merge_learned(model: Model, learned: list[dict[str, str]]) -> None:
    """Prefer what the user's own saved project shows Iris writing (id, flags)
    and add any value->code pairs it reveals."""
    if not learned:
        return
    by_id = {p.id: p for p in model.props}
    for rec in learned:
        pid, label = rec.get("id", ""), rec.get("label", "")
        if not pid:
            continue
        p = by_id.get(pid)
        if p is None:
            try:
                instance = int(pid) >> SUBMODEL_SHIFT
            except ValueError:
                instance = 0
            p = PropDef(id=pid, label=label, instance=instance, source="template project")
            model.props.append(p)
            by_id[pid] = p
        if rec.get("flags"):
            p.flags = rec["flags"]
            p.source = (p.source + " + template flags").strip(" +")
        value, code = rec.get("value") or "", rec.get("code") or ""
        if value and code and p.option_by_label(value) is None:
            p.options.append(Option(code=code, label=value))


def learned_from_template(root) -> dict[str, list[dict[str, str]]]:
    """PRODUCTID -> PROPERTY records from equipment in the user's own project."""
    out: dict[str, list[dict[str, str]]] = {}
    for node in root.iter_descendants():
        if node.tag != "EQUIPMENT":
            continue
        pid = node.text_of("PRODUCTID") or ""
        props = node.find("PROPERTYS")
        if not pid or props is None:
            continue
        bucket = out.setdefault(pid, [])
        seen = {r["id"] for r in bucket}
        for p in props.findall("PROPERTY"):
            rec = {
                "id": p.text_of("PROPERTYID") or "",
                "label": p.text_of("LABEL") or "",
                "value": p.text_of("VALUE") or "",
                "code": p.text_of("CODE") or "",
                "flags": p.text_of("PROPFLAGSCUR") or "",
            }
            if rec["id"] and rec["id"] not in seen:
                bucket.append(rec)
                seen.add(rec["id"])
    return out
