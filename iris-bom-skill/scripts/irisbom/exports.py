"""Write Iris-style BOM exports from a normalized spec.

Layouts mirror what Iris itself exports: the normal (any manufacturer) xlsx
with a Composite sheet plus one sheet per site, and the Juniper-format CSV.
Prices are left blank unless the spec supplies unit_price.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Iterable, Optional

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.worksheet import Worksheet

NORMAL_COLUMNS = [
    "Line#",
    "Part Number",
    "Description",
    "Manufacturer",
    "Unit Price",
    "Quantity",
    "Sub Total",
    "Discount",
    "Total",
    "Price List",
]

JUNIPER_COLUMNS = [
    "Sequence Number",
    "Part Number",
    "Qty",
    "Duration",
    "Parent SKU",
    "Dynamic Bundle Child Parts",
    "Standalone SKU",
]

COL_WIDTHS = {
    "A": 10.7109375,
    "B": 25.7109375,
    "C": 60.7109375,
    "D": 25.7109375,
    "E": 12.7109375,
    "F": 12.7109375,
    "G": 12.7109375,
    "H": 12.7109375,
    "I": 12.7109375,
    "J": 25.7109375,
}

CURRENCY = '"$"#,##0.00_);("$"#,##0.00);"$"0.00_);_(* @_)'
HEADER_FILL = PatternFill("solid", fgColor="C0C0C0")
THIN = Border(
    left=Side(style="thin"),
    right=Side(style="thin"),
    top=Side(style="thin"),
    bottom=Side(style="thin"),
)
FONT = Font(name="Calibri", size=11)


def write_normal_xlsx(
    spec: dict[str, Any],
    path: Path,
    *,
    catalog: Optional[dict[str, dict[str, Any]]] = None,
) -> Path:
    path = Path(path)
    wb = Workbook()
    # Composite first, then one sheet per site (Iris sample layout).
    sites = spec.get("sites") or [{"name": "Site 1", "lines": spec.get("lines") or []}]
    composite_lines = _flatten_sites(sites)
    _write_sheet(wb.active, "Composite", composite_lines, catalog, default_price_list(spec))
    for site in sites:
        name = site.get("name") or "Site 1"
        ws = wb.create_sheet(name)
        _write_sheet(ws, name, site.get("lines") or [], catalog, default_price_list(spec))
    path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(path)
    return path


def write_juniper_csv(spec: dict[str, Any], path: Path) -> Path:
    path = Path(path)
    rows = _juniper_rows(_flatten_sites(spec.get("sites") or [{"lines": spec.get("lines") or []}]))
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [",".join(JUNIPER_COLUMNS)]
    for row in rows:
        lines.append(_csv_line(row))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def default_price_list(spec: dict[str, Any]) -> str:
    """Price List column text. Only what the spec supplies; this tool never
    reads Iris price lists."""
    return str(spec.get("price_list") or "")


def _flatten_sites(sites: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    counters: dict[str, int] = {}
    for site in sites:
        # Re-number per composite by walking already-numbered lines if present,
        # otherwise assign 1.0, 2.0... across the whole workbook in site order.
        for line in site.get("lines") or []:
            out.append(line)
    if any(line.get("line") for line in out):
        return out
    return _assign_line_numbers(out)


def _assign_line_numbers(lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Assign 1.0 / 1.1 / 1.1.1 style numbers from parent links if missing."""
    roots = []
    by_sku_order: list[dict[str, Any]] = []
    index = {id(line): line for line in lines}
    children: dict[int, list[dict[str, Any]]] = {id(line): [] for line in lines}
    used = set()
    sku_latest: dict[str, dict[str, Any]] = {}
    for line in lines:
        parent = (line.get("parent") or "").strip()
        sku = (line.get("sku") or "").strip()
        if parent and parent in sku_latest:
            children[id(sku_latest[parent])].append(line)
            used.add(id(line))
        else:
            roots.append(line)
        if sku:
            sku_latest[sku] = line

    numbered: list[dict[str, Any]] = []

    def walk(node: dict[str, Any], prefix: str) -> None:
        item = dict(node)
        item["line"] = prefix
        numbered.append(item)
        for i, child in enumerate(children.get(id(node), []), start=1):
            walk(child, f"{prefix}.{i}" if "." in prefix or True else f"{prefix}.{i}")

    for n, root in enumerate(roots, start=1):
        walk(root, f"{n}.0")
    return numbered


def _write_sheet(
    ws: Worksheet,
    title: str,
    lines: list[dict[str, Any]],
    catalog: Optional[dict[str, dict[str, Any]]],
    price_list: str,
) -> None:
    ws.title = title[:31]
    catalog = catalog or {}
    if not any(line.get("line") for line in lines):
        lines = _assign_line_numbers(lines)
    for col, width in COL_WIDTHS.items():
        ws.column_dimensions[col].width = width
    for col, header in enumerate(NORMAL_COLUMNS, start=1):
        cell = ws.cell(1, col, header)
        cell.font = FONT
        cell.fill = HEADER_FILL
        cell.border = THIN
    row_i = 2
    priced_rows: list[int] = []
    for line in lines:
        sku = (line.get("sku") or "").strip()
        info = catalog.get(sku) or catalog.get(sku.upper(), {})
        desc = line.get("description") or info.get("description") or info.get("label") or ""
        if line.get("included"):
            desc = desc if desc.startswith("  ") else f"  INCLUDED: {desc}"
        mfr = line.get("manufacturer") or info.get("manufacturer") or ""
        qty = line.get("qty")
        unit = line.get("unit_price")
        included = bool(line.get("included") or (isinstance(unit, str) and unit.lower() == "incl."))
        discount = line.get("discount", 0 if not included else None)
        plist = "" if included else (line.get("price_list") or price_list)

        values = [
            line.get("line") or "",
            sku,
            desc,
            mfr,
            ("incl." if included else unit),
            qty,
            None,
            discount,
            None,
            plist or None,
        ]
        for col, val in enumerate(values, start=1):
            cell = ws.cell(row_i, col, val)
            cell.font = FONT
            if col <= 9 or val not in (None, ""):
                cell.border = THIN
        # Line# as text, left aligned (Iris sample uses number format @)
        ws.cell(row_i, 1).number_format = "@"
        ws.cell(row_i, 1).alignment = Alignment(horizontal="left")
        if included:
            pass
        else:
            # Formulas only when a numeric unit price is present; otherwise
            # leave Sub Total / Total empty so we do not invent prices.
            if _is_number(unit):
                ws.cell(row_i, 5).number_format = CURRENCY
                ws.cell(row_i, 7).value = f"=E{row_i}*F{row_i}"
                ws.cell(row_i, 7).number_format = CURRENCY
                ws.cell(row_i, 8).value = discount if discount is not None else 0
                ws.cell(row_i, 9).value = f"=G{row_i}-G{row_i}*H{row_i}"
                ws.cell(row_i, 9).number_format = CURRENCY
                priced_rows.append(row_i)
            else:
                ws.cell(row_i, 5).value = unit
                ws.cell(row_i, 8).value = discount if discount is not None else 0
        row_i += 1

    # Quote Total row
    total_row = row_i
    ws.cell(total_row, 3, "Quote Total").font = FONT
    ws.cell(total_row, 3).border = THIN
    if priced_rows:
        first, last = 2, total_row - 1
        cell = ws.cell(total_row, 9, f"=SUM(I{first}:I{last})")
        cell.font = FONT
        cell.number_format = CURRENCY
        cell.border = THIN
    else:
        cell = ws.cell(total_row, 9, 0)
        cell.font = FONT
        cell.number_format = CURRENCY
        cell.border = THIN


def _is_number(value: Any) -> bool:
    if value is None or isinstance(value, bool):
        return False
    if isinstance(value, (int, float)):
        return True
    try:
        float(str(value).replace(",", ""))
        return True
    except (TypeError, ValueError):
        return False


def _juniper_rows(lines: list[dict[str, Any]]) -> list[list[Any]]:
    if not any(line.get("line") for line in lines):
        lines = _assign_line_numbers(lines)
    # Map sku -> children that are dynamic bundle parts (included software
    # bundles whose SKU ends in -BND). The Juniper CSV omits "INCLUDED" hardware
    # and writes bundle children in the parent subscription's column.
    by_line = {line.get("line"): line for line in lines}
    children_of: dict[str, list[dict[str, Any]]] = {}
    for line in lines:
        parent = (line.get("parent") or "").strip()
        parent_line = _parent_line_number(line.get("line") or "")
        key = parent_line
        children_of.setdefault(key, []).append(line)

    rows = []
    for line in lines:
        if line.get("juniper_bundle_child") or line.get("included"):
            # Official Juniper CSV omits included hardware and bundle children
            # (bundle children appear only in the parent row's Dynamic Bundle column).
            continue
        seq = _juniper_sequence(line.get("line") or "")
        duration = line.get("duration")
        if duration in (None, ""):
            duration = _duration_from_sku(line.get("sku") or "") if (line.get("parent") or line.get("juniper_bundle_child")) else ""
        parent_sku = line.get("parent") or ""
        if not parent_sku and "." in (line.get("line") or "") and not str(line.get("line")).endswith(".0"):
            parent_line = _parent_line_number(line.get("line") or "")
            parent_sku = (by_line.get(parent_line) or {}).get("sku") or ""
        bundle_children = []
        for child in children_of.get(line.get("line") or "", []):
            if child.get("juniper_bundle_child") or child.get("included") and _looks_like_bundle(child.get("sku") or ""):
                bundle_children.append(child.get("sku"))
        standalone = "YES" if line.get("standalone") else ""
        rows.append(
            [
                seq,
                line.get("sku") or "",
                line.get("qty"),
                duration if duration not in (None, "") else "",
                parent_sku,
                ", ".join(bundle_children),
                standalone,
            ]
        )
    return rows


def _juniper_sequence(line: str) -> str:
    # Roots are numbered 1.0, 2.0; children of a root are 1.0.1 in the normal
    # export and 1.1 in the Juniper export (two-level only).
    parts = [p for p in str(line).split(".") if p != ""]
    if len(parts) >= 3 and parts[1] == "0":
        parts = [parts[0]] + parts[2:]
    if len(parts) == 1:
        return f"{parts[0]}.0"
    return ".".join(parts[:2])


def _parent_line_number(line: str) -> str:
    parts = str(line).split(".")
    if len(parts) <= 1:
        return ""
    if parts[-1] == "0" and len(parts) == 2:
        return ""
    parent_parts = parts[:-1]
    if len(parent_parts) == 1:
        return f"{parent_parts[0]}.0"
    return ".".join(parent_parts)


def _looks_like_bundle(sku: str) -> bool:
    return sku.upper().endswith("-BND") or "BND" in sku.upper()


def _duration_from_sku(sku: str) -> str:
    import re

    m = re.search(r"(\d+)Y", sku, re.I)
    if m:
        return str(int(m.group(1)) * 12)
    # Juniper Flex term codes: 3M1, 5M1, 7M1 mean 3/5/7 year terms.
    m = re.search(r"(\d+)M1", sku, re.I)
    if m:
        return str(int(m.group(1)) * 12)
    return ""


def _csv_line(row: Iterable[Any]) -> str:
    out = []
    for val in row:
        if val is None:
            out.append("")
            continue
        s = str(val)
        if any(ch in s for ch in ',:"\n'):
            out.append('"' + s.replace('"', '""') + '"')
        else:
            out.append(s)
    return ",".join(out)
