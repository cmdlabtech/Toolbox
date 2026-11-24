"""Choose configurator properties for a generated EQUIPMENT by label and
option text, using the user's own product models.

Region defaults (configurable with --region, default US):
  * Regulatory domain: on any model with a "... Regulatory Domain ..."
    property, pick the option whose label is exactly the region code.
  * Model picker: on "Select Model" / "Select Model_" / "Select_Model"
    properties, pick the option whose label is the exact SKU (or the SKU
    without its -<REGION> suffix, or the line's model_option). Other picker
    properties on the same model are written empty, the way Iris saves a
    filter that was not used.
  * Power cords: on every "Power Cord Selection" property (including those
    in sub-models, one per power-supply slot) pick the option for the region.

If a needed property or option can't be found, the line gets an error and is
left out of the .isf (unless --allow-partial). Nothing is guessed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Optional

from . import catalog
from .models import Model, PropDef

DOMAIN_LABEL = re.compile(r"regulatory\s+domain", re.I)
SELECT_LABEL = catalog.SELECT_LABEL
CORD_SEL = re.compile(r"^\s*power cord selection\s*$", re.I)
CORD_QTY = re.compile(r"^\s*power cord quantity\s*$", re.I)
CORD_INC = re.compile(r"^\s*make power cords included\s*$", re.I)
PSU_TEXT = re.compile(r"power supply|\bPSU\b", re.I)

# Plain-text preferences used only when more than one power-cord option
# matches the region. They name public product families and option wording,
# never catalog codes. Edit or extend for your own needs.
CORD_PREFERENCES: list[dict[str, Any]] = [
    # Juniper EX4100 PoE models ship a high-wattage supply that takes the
    # 15A North American cord.
    {"sku": r"^EX4100(?:-[FH])?-(?:\d+P|\d*MP)\b", "prefer": [r"\b15A\b"]},
]

# ISO 3166 alpha-2 -> English country name as written in Iris localization
# tables. Public reference data, used to look up the country number in the
# user's own catalog.
REGION_COUNTRY = {
    "US": "United States",
    "CA": "Canada",
    "MX": "Mexico",
    "GB": "United Kingdom",
    "UK": "United Kingdom",
    "IE": "Ireland",
    "AU": "Australia",
    "NZ": "New Zealand",
    "DE": "Germany",
    "FR": "France",
    "NL": "Netherlands",
    "JP": "Japan",
    "IN": "India",
    "BR": "Brazil",
}


@dataclass
class Choice:
    props: list[dict[str, str]] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


def prop_out(p: PropDef, value: str, code: str) -> dict[str, str]:
    return {"id": p.id, "label": p.label, "value": value, "code": code, "flags": p.flags or "0"}


def region_token(region: str) -> re.Pattern[str]:
    return re.compile(rf"(?<![A-Za-z]){re.escape(region)}(?![A-Za-z])", re.I)


def equipment_properties(
    *,
    sku: str,
    line: dict[str, Any],
    model: Model,
    children: list[dict[str, Any]],
    index: dict[str, Any],
    region: str,
    country_numb: str,
) -> Choice:
    out = Choice()
    if model.path is None:
        out.errors.append(f"{sku}: product model file for this product is not in your Iris cache")
        return out
    for problem in model.submodel_problems:
        out.notes.append(f"{sku}: {problem}; sub-model options (such as power cords) may use Iris defaults")

    # 1. Regulatory domain
    for p in model.find(DOMAIN_LABEL, include_sub=False):
        opt = p.option_by_label(region)
        if opt is None:
            out.errors.append(f"{sku}: '{p.label}' has no option labeled {region!r}")
        else:
            out.props.append(prop_out(p, opt.label, opt.code))

    # 2. Model picker
    pickers = model.find(SELECT_LABEL, include_sub=False)
    if pickers:
        targets = [t for t in (line.get("model_option"), sku, catalog.strip_region(sku, region)) if t]
        matched: list[tuple[PropDef, str, str]] = []
        for p in pickers:
            opt = _match_option(p, targets, sku)
            if opt is not None:
                matched.append((p, opt.label, opt.code))
        if not matched:
            out.errors.append(
                f"{sku}: no option in {', '.join(repr(p.label) for p in pickers)} matches "
                f"{' / '.join(targets)}; set model_option on the line to the exact option text shown in Iris"
            )
        else:
            hit = {id(p) for p, _, _ in matched}
            for p in pickers:
                if id(p) not in hit:
                    out.props.append(prop_out(p, "", ""))
            for p, label, code in matched:
                out.props.append(prop_out(p, label, code))

    # 3. Power cords (per slot)
    selectors = model.find(CORD_SEL)
    if selectors:
        psu_children = sum(
            int(c.get("qty") or 0) > 0 and _is_psu(c, index) for c in children
        )
        slots = sorted({p.instance for p in selectors})
        for n, instance in enumerate(slots):
            sel = next(p for p in selectors if p.instance == instance)
            value, code, err = choose_cord(sel, sku, line, index, region, country_numb)
            if err:
                out.errors.append(f"{sku}: {err}")
                continue
            included = n == 0 or psu_children >= n
            out.props.append(prop_out(sel, value, code))
            qty = next((p for p in model.find(CORD_QTY) if p.instance == instance), None)
            if qty is not None:
                out.props.append(prop_out(qty, "1" if included else "0", ""))
            inc = next((p for p in model.find(CORD_INC) if p.instance == instance), None)
            if inc is not None:
                want = "TRUE" if included else "FALSE"
                opt = inc.option_by_label(want)
                if opt is None:
                    out.errors.append(f"{sku}: '{inc.label}' has no {want} option")
                else:
                    out.props.append(prop_out(inc, opt.label, opt.code))
    return out


def _match_option(p: PropDef, targets: list[str], sku: str):
    for t in targets:
        opt = p.option_by_label(t)
        if opt is not None:
            return opt
    token = re.compile(rf"(?<![A-Z0-9-]){re.escape(sku.upper())}(?![A-Z0-9-])")
    hits = [o for o in p.options if token.search(f"{o.label} {o.tooltip}".upper())]
    return hits[0] if len(hits) == 1 else None


def _is_psu(child: dict[str, Any], index: dict[str, Any]) -> bool:
    rec = catalog.part(index, child.get("sku") or "") or {}
    text = " ".join(str(x or "") for x in (child.get("description"), rec.get("description")))
    return bool(PSU_TEXT.search(text))


def choose_cord(
    sel: PropDef,
    sku: str,
    line: dict[str, Any],
    index: dict[str, Any],
    region: str,
    country_numb: str,
) -> tuple[str, str, str]:
    """Return (value, code, error)."""
    override = (line.get("power_cord") or "").strip()
    if override:
        opt = sel.option_by_label(override)
        if opt is None:
            matches = [o for o in sel.options if override.casefold() in o.label.casefold()]
            opt = matches[0] if len(matches) == 1 else None
        if opt is None:
            return "", "", f"power_cord {override!r} is not an option of '{sel.label}'"
        return opt.label, opt.code, ""

    tok = region_token(region)
    candidates = [o for o in sel.options if tok.search(o.label)]
    if not candidates:
        return "", "", f"no '{sel.label}' option mentions region {region}"
    if len(candidates) == 1:
        return candidates[0].label, candidates[0].code, ""

    for pref in CORD_PREFERENCES:
        if re.search(pref["sku"], sku, re.I):
            narrowed = [o for o in candidates if all(re.search(rx, o.label, re.I) for rx in pref["prefer"])]
            if len(narrowed) == 1:
                return narrowed[0].label, narrowed[0].code, ""

    if country_numb:
        localized = {v for _, _, v in catalog.localized_values(index, country_numb)}
        narrowed = [o for o in candidates if o.label in localized]
        # Prefer the generic C13 localization column when several match.
        generic = [
            o for o in narrowed
            if any(o.label == v and col.lower() == "c13" for _, col, v in catalog.localized_values(index, country_numb))
        ]
        if len(generic) == 1:
            return generic[0].label, generic[0].code, ""
        if len(narrowed) == 1:
            return narrowed[0].label, narrowed[0].code, ""
    labels = "; ".join(o.label for o in candidates)
    return "", "", (
        f"several '{sel.label}' options match region {region} ({labels}); "
        "set power_cord on the line to the one you want"
    )


def region_country_name(region: str, override: str = "") -> str:
    return override or REGION_COUNTRY.get(region.upper(), "")
