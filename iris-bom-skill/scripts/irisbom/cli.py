"""Command line for iris-bom. Every command starts with the Iris preflight."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Optional

from . import __version__, catalog, clients, configure, exports, isf, preflight, spec as specmod
from .models import ModelStore

EXIT_PREFLIGHT = 2
EXIT_ISF_ERRORS = 3
EXIT_USAGE = 4


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="iris_bom.py",
        description=(
            "Build Iris-style BOM exports (and, on request, an .isf project) from your own local "
            "Intangi Iris install. Unofficial; not affiliated with Intangi or HPE."
        ),
    )
    p.add_argument("--version", action="version", version=f"iris-bom {__version__}")
    p.add_argument("--iris-app", help="Iris app location if not installed in the standard place")
    p.add_argument("--iris-cache", help="Iris catalog cache folder if not in the standard place")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("preflight", help="Check that Iris and its local catalog are installed")

    s = sub.add_parser("index", help="Build or refresh the private local catalog index")
    s.add_argument("--rebuild", action="store_true")

    s = sub.add_parser("lookup", help="Show how SKUs resolve in your local catalog")
    s.add_argument("skus", nargs="+")
    s.add_argument("--region", default="US")

    s = sub.add_parser("inspect", help="List a product model's configurator properties and options")
    s.add_argument("sku")
    s.add_argument("--filter", default="", help="Only properties whose label matches this regex")
    s.add_argument("--family-sku", default="")

    s = sub.add_parser("build", help="Write BOM exports (and an .isf with --isf)")
    s.add_argument("--spec", required=True, help="BOM spec (.json or .csv)")
    s.add_argument("--client", default="", help="Client name (folder under --client-root)")
    s.add_argument("--client-root", default="", help="Folder holding one subfolder per client")
    s.add_argument("--out", default="", help="Output folder when --client-root is not used")
    s.add_argument("--basename", default="")
    s.add_argument("--vendor", default="", help="Override the spec vendor (juniper writes the Juniper CSV)")
    s.add_argument("--region", default="", help="Region code for AP domain and power cords (default US)")
    s.add_argument("--country", default="", help="Country name as written in Iris, if not derivable from --region")
    s.add_argument("--isf", action="store_true", help="Also write a generated .isf project (opt-in)")
    s.add_argument("--template", default="", help="A project you saved in your own Iris (needed for --isf)")
    s.add_argument("--allow-partial", action="store_true", help="Write the .isf even if some lines failed")
    s.add_argument("--json", action="store_true", help="Print a JSON summary")

    s = sub.add_parser("decode", help="Decompress an .isf to its XML payload")
    s.add_argument("isf_path")
    s.add_argument("-o", "--output", required=True)

    s = sub.add_parser("encode", help="Wrap an XML payload as an .isf, using a header from --like")
    s.add_argument("xml")
    s.add_argument("--like", required=True, help="An .isf whose header layout to reuse")
    s.add_argument("-o", "--output", required=True)

    s = sub.add_parser("roundtrip", help="Check that decode+encode reproduces an .isf byte-for-byte")
    s.add_argument("isf_path")
    return p


def main(argv: Optional[list[str]] = None) -> int:
    args = _parser().parse_args(argv)
    # Test-only: pretend to be macOS/Windows so fixtures can exercise detection.
    system = os.environ.get("IRIS_BOM_TEST_PLATFORM") or None
    pf = preflight.run(app_override=args.iris_app, cache_override=args.iris_cache, system=system)
    if args.cmd == "preflight" or not pf.ok:
        print(pf.report(), file=sys.stdout if pf.ok else sys.stderr)
        return 0 if pf.ok else EXIT_PREFLIGHT
    cache = pf.cache_path
    assert cache is not None

    if args.cmd == "index":
        catalog.load_or_build(cache, rebuild=args.rebuild)
        return 0
    if args.cmd == "decode":
        iris = isf.decode_isf(Path(args.isf_path))
        Path(args.output).write_bytes(iris.payload)
        print(json.dumps(iris.header, indent=2))
        return 0
    if args.cmd == "encode":
        like = isf.decode_isf(Path(args.like))
        header = dict(like.header)
        for k in ("USER_ORG", "USER"):
            if k in header:
                header[k] = "0"
        Path(args.output).write_bytes(isf.encode(header, like.header_order, Path(args.xml).read_bytes()))
        return 0
    if args.cmd == "roundtrip":
        raw = Path(args.isf_path).read_bytes()
        iris = isf.decode_isf(raw)
        same = isf.encode(iris.header, iris.header_order, iris.payload) == raw
        tree = isf.encode_tree(iris) == raw
        print(f"payload re-encode identical: {same}; parse+serialize identical: {tree}")
        return 0 if same and tree else 1

    index = catalog.load_or_build(cache, log=lambda m: print(m, file=sys.stderr))
    if args.cmd == "lookup":
        for sku in args.skus:
            part = catalog.part(index, sku)
            prod, how = catalog.resolve_product(index, sku, region=args.region)
            print(json.dumps({
                "sku": sku,
                "in_part_catalog": bool(part),
                "description": (part or {}).get("description", ""),
                "manufacturer": catalog.manufacturer_name(index, sku),
                "configurable": bool(prod),
                "resolved_by": how,
            }))
        return 0
    if args.cmd == "inspect":
        prod, how = catalog.resolve_product(index, args.sku, family_sku=args.family_sku)
        if not prod:
            print(f"{args.sku}: {how}", file=sys.stderr)
            return 1
        model = ModelStore(cache).load(prod["productid"], prod.get("modelver") or "1")
        rx = re.compile(args.filter, re.I) if args.filter else None
        print(f"{args.sku}: resolved by {how}; model file {model.path.name if model.path else 'MISSING'}")
        for prob in model.submodel_problems:
            print(f"  ! {prob}")
        for p in model.props:
            if rx and not rx.search(p.label or ""):
                continue
            opts = "; ".join(o.label for o in p.options[:12]) + (" ..." if len(p.options) > 12 else "")
            print(f"  [{'sub' if p.instance else 'own'}] {p.label}" + (f"  options: {opts}" if opts else ""))
        return 0
    if args.cmd == "build":
        return _build(args, cache, index)
    return EXIT_USAGE


def _slug(text: str) -> str:
    s = re.sub(r"[^A-Za-z0-9._-]+", "-", text).strip("-._")
    return s[:80] or "bom"


def _unique(path: Path) -> Path:
    if not path.exists():
        return path
    for n in range(2, 1000):
        candidate = path.with_name(f"{path.stem} ({n}){path.suffix}")
        if not candidate.exists():
            return candidate
    raise FileExistsError(path)


def _build(args, cache: Path, index: dict[str, Any]) -> int:
    spec = specmod.load_spec(Path(args.spec))
    region = (args.region or spec.get("region") or "US").upper()
    lines = specmod.all_lines(spec)
    summary: dict[str, Any] = {"files": [], "notes": [], "errors": []}

    # Fill description/manufacturer from the local catalog for the exports.
    details: dict[str, dict[str, str]] = {}
    for line in lines:
        sku = line["sku"]
        part = catalog.part(index, line.get("iris_sku") or sku)
        if not part:
            summary["notes"].append(f"{sku} not found in your Iris part catalog (kept in exports as given)")
            continue
        details[sku] = {
            "description": part.get("description", ""),
            "manufacturer": catalog.manufacturer_name(index, line.get("iris_sku") or sku),
        }

    vendor = (args.vendor or spec.get("vendor") or "").lower()
    if not vendor:
        makers = {d["manufacturer"].lower() for d in details.values() if d.get("manufacturer")}
        if makers and all("juniper" in m for m in makers):
            vendor = "juniper"

    client = args.client or spec.get("client") or ""
    if args.client_root:
        if not client:
            print("--client is required with --client-root", file=sys.stderr)
            return EXIT_USAGE
        root = Path(args.client_root).expanduser()
        folder = clients.resolve(client, clients.existing_folders(root))
        out_dir = root / clients.safe_folder_name(folder)
    else:
        out_dir = Path(args.out or "iris-bom-output").expanduser()
        if client:
            out_dir = out_dir / clients.safe_folder_name(client)
    out_dir.mkdir(parents=True, exist_ok=True)
    base = _slug(args.basename or spec.get("project") or Path(args.spec).stem)

    xlsx = _unique(out_dir / f"{base}-bom.xlsx")
    exports.write_normal_xlsx(spec, xlsx, catalog=details)
    summary["files"].append(str(xlsx))
    if vendor == "juniper":
        csv_path = _unique(out_dir / f"{base}-juniper-bom.csv")
        exports.write_juniper_csv(spec, csv_path)
        summary["files"].append(str(csv_path))

    code = 0
    if args.isf:
        if not args.template:
            summary["errors"].append(
                "--isf needs --template: a project saved from your own Iris with one site and one device"
            )
            code = EXIT_USAGE
        else:
            try:
                template = isf.load_template(Path(args.template).expanduser())
            except (isf.TemplateError, ValueError, OSError) as exc:
                summary["errors"].append(f"template: {exc}")
                code = EXIT_USAGE
            else:
                country_name = configure.region_country_name(region, args.country)
                country_numb = catalog.country_number(index, country_name) if country_name else ""
                store = ModelStore(cache, learned=template.learned)
                try:
                    data, notes, errors = isf.build_isf(
                        project_name=str(spec.get("project") or base),
                        sites=spec.get("sites") or [],
                        template=template,
                        index=index,
                        store=store,
                        region=region,
                        country_numb=country_numb,
                        allow_partial=args.allow_partial,
                    )
                except isf.TemplateError as exc:
                    summary["errors"].append(str(exc))
                    code = EXIT_USAGE
                else:
                    summary["notes"] += notes
                    summary["errors"] += errors
                    if errors and not args.allow_partial:
                        summary["errors"].append(".isf not written because some lines failed (see above)")
                        code = EXIT_ISF_ERRORS
                    else:
                        isf_path = _unique(out_dir / f"{base}.isf")
                        isf_path.write_bytes(data)
                        summary["files"].append(str(isf_path))

    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        for f in summary["files"]:
            print(f"wrote {f}")
        for n in summary["notes"]:
            print(f"note: {n}")
        for e in summary["errors"]:
            print(f"error: {e}", file=sys.stderr)
    return code
