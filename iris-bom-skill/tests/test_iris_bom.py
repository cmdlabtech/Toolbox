"""Tests for iris-bom. Run from the package folder:

    python3 -m unittest discover -s tests -v

Unit tests use synthetic fixtures (tests/fixtures.py, all values fake).
The real-catalog test at the bottom runs only when Iris is installed on the
computer running the tests, and it only reads that user's own cache.
"""

from __future__ import annotations

import contextlib
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import fixtures  # noqa: E402
from irisbom import catalog, cli, isf, modfile, preflight, spec as specmod  # noqa: E402
from irisbom.models import ModelStore  # noqa: E402


def run_cli(*argv: str) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = cli.main(list(argv))
    return code, out.getvalue(), err.getvalue()


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.env = mock.patch.dict(os.environ, {"IRIS_BOM_HOME": str(self.dir / "home"),
                                                "IRIS_BOM_TEST_PLATFORM": "Darwin"})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def fake(self, **kw):
        paths = fixtures.make_cache(self.dir / "fake", **kw)
        return ["--iris-app", str(paths["app"]), "--iris-cache", str(paths["cache"])], paths

    def write_spec(self, data) -> Path:
        import json
        p = self.dir / "spec.json"
        p.write_text(json.dumps(data))
        return p


LAB_SPEC = {
    "project": "Fake Lab",
    "client": "Fake Client",
    "vendor": "juniper",
    "sites": [{"name": "Site 1", "lines": [
        {"sku": "FAKE-SW-24B", "qty": 2},
        {"sku": "FAKE-PSU-2", "qty": 2, "parent": "FAKE-SW-24B"},
        {"sku": "FAKEAP7-US", "qty": 4},
        {"sku": "FAKE-SUB-3Y", "qty": 4, "parent": "FAKEAP7-US"},
        {"sku": "FAKE-DAC-1M", "qty": 2},
    ]}],
}


class PreflightTests(Base):
    def test_this_box_has_no_iris(self):
        with mock.patch.dict(os.environ, {"IRIS_BOM_TEST_PLATFORM": ""}):
            r = preflight.run()
        if sys.platform.startswith("linux"):
            self.assertFalse(r.ok)

    def test_missing_app_fails_and_writes_nothing(self):
        out = self.dir / "out"
        spec = self.write_spec(LAB_SPEC)
        code, _, err = run_cli("--iris-app", str(self.dir / "nope.app"), "--iris-cache", str(self.dir / "nope"),
                               "build", "--spec", str(spec), "--out", str(out))
        self.assertEqual(code, cli.EXIT_PREFLIGHT)
        self.assertIn("not installed", err)
        self.assertFalse(out.exists())
        self.assertFalse((self.dir / "home").exists())

    def test_wrong_bundle_id_fails(self):
        args, _ = self.fake(bundle_id="com.example.notiris")
        code, _, err = run_cli(*args, "preflight")
        self.assertEqual(code, cli.EXIT_PREFLIGHT)
        self.assertIn("expected 'com.intangi.iris'", err)

    def test_app_without_catalog_fails(self):
        args, paths = self.fake()
        for f in (paths["cache"] / "part").glob("*.mod"):
            f.unlink()
        code, _, err = run_cli(*args, "preflight")
        self.assertEqual(code, cli.EXIT_PREFLIGHT)
        self.assertIn("part/part_*.mod", err)

    def test_linux_never_passes(self):
        args, _ = self.fake()
        with mock.patch.dict(os.environ, {"IRIS_BOM_TEST_PLATFORM": "Linux"}):
            code, _, _ = run_cli(*args, "preflight")
        self.assertEqual(code, cli.EXIT_PREFLIGHT)

    def test_fake_install_passes(self):
        args, _ = self.fake()
        code, out, _ = run_cli(*args, "preflight")
        self.assertEqual(code, 0, out)
        self.assertIn("OK", out)


class SafetyTests(Base):
    def test_protected_files_refused(self):
        _, paths = self.fake()
        for p in (paths["cache"] / "deploy" / "user.mod", paths["cache"] / "misc" / "plist900124.mod",
                  paths["cache"] / "systems" / "fake-project.bak"):
            with self.assertRaises(modfile.ForbiddenFile):
                modfile.read_mod(p)

    def test_index_never_opens_protected_files(self):
        _, paths = self.fake()
        opened = []
        real = Path.read_bytes

        def spy(self_path):
            opened.append(self_path.name)
            return real(self_path)

        with mock.patch.object(Path, "read_bytes", spy):
            catalog.build_index(paths["cache"])
        self.assertTrue(opened)
        for name in opened:
            self.assertNotRegex(name, r"^(user|deploy)\.mod$|^plist|\.bak$")

    def test_no_network_modules_imported(self):
        import irisbom.cli  # noqa: F401
        for mod in ("urllib.request", "http.client", "socket", "requests"):
            src = "".join(p.read_text() for p in (ROOT / "scripts" / "irisbom").glob("*.py"))
            self.assertNotIn(f"import {mod}", src)


class CatalogTests(Base):
    def test_index_and_family_resolution(self):
        _, paths = self.fake()
        idx = catalog.load_or_build(paths["cache"], log=lambda m: None)
        self.assertEqual(catalog.part(idx, "fake-sw-24b")["partid"], "910002")
        prod, how = catalog.resolve_product(idx, "FAKE-SW-24B")
        self.assertEqual(prod["productid"], "900001")
        self.assertIn("model option", how)
        self.assertEqual(catalog.country_number(idx, "United States"), "99002")
        self.assertEqual(catalog.manufacturer_name(idx, "FAKE-DAC-1M"), "Fakevendor Networks")
        prod, _ = catalog.resolve_product(idx, "FAKE-DAC-1M")
        self.assertIsNone(prod)
        self.assertTrue(list((self.dir / "home").glob("index-*.json.gz")))

    def test_submodel_properties_get_instance_ids(self):
        _, paths = self.fake()
        model = ModelStore(paths["cache"]).load("900001", "1")
        cords = [p for p in model.props if p.label == "Power Cord Selection"]
        self.assertEqual(sorted(int(p.id) for p in cords), [(5 << 16) | 31, (6 << 16) | 31])


class BuildTests(Base):
    def build(self, spec, *extra, template_kw=None):
        args, paths = self.fake()
        template = fixtures.make_template(self.dir / "template.isf", **(template_kw or {}))
        out = self.dir / "out"
        code, stdout, stderr = run_cli(*args, "build", "--spec", str(self.write_spec(spec)), "--out", str(out),
                                       "--template", str(template), *extra)
        return code, stdout, stderr, out

    def test_default_build_is_exports_only(self):
        code, stdout, stderr, out = self.build(LAB_SPEC)
        self.assertEqual(code, 0, stderr)
        files = sorted(p.name for p in (out / "Fake Client").iterdir())
        self.assertEqual(files, ["Fake-Lab-bom.xlsx", "Fake-Lab-juniper-bom.csv"])
        csv_text = (out / "Fake Client" / "Fake-Lab-juniper-bom.csv").read_text()
        self.assertIn("FAKE-SUB-3Y,4,36,FAKEAP7-US", csv_text)
        self.assertIn("FAKE-DAC-1M,2,,,,YES", csv_text)
        from openpyxl import load_workbook
        wb = load_workbook(out / "Fake Client" / "Fake-Lab-bom.xlsx")
        self.assertEqual(wb.sheetnames, ["Composite", "Site 1"])
        ws = wb["Composite"]
        self.assertEqual(ws["B2"].value, "FAKE-SW-24B")
        self.assertEqual(ws["C2"].value, "Fake 24-port PoE switch B")
        self.assertEqual(ws["D2"].value, "Fakevendor Networks")

    def test_non_juniper_has_no_csv(self):
        spec = dict(LAB_SPEC, vendor="fakevendor")
        code, _, stderr, out = self.build(spec)
        self.assertEqual(code, 0, stderr)
        self.assertEqual([p.suffix for p in (out / "Fake Client").iterdir()], [".xlsx"])

    def test_isf_uses_runtime_lookups(self):
        code, stdout, stderr, out = self.build(LAB_SPEC, "--isf")
        self.assertEqual(code, 0, stderr + stdout)
        iris = isf.decode_isf(out / "Fake Client" / "Fake-Lab.isf")
        self.assertEqual(iris.header["USER"], "0")
        self.assertEqual(iris.header["USER_ORG"], "0")
        self.assertEqual(iris.header["APP_VERSION"], "93")  # copied from the template header
        root = iris.root
        self.assertEqual(root.find("DETAIL").text_of("COUNTRY"), "99002")
        self.assertEqual(root.find("DETAIL").text_of("CREATEBY"), "0")
        self.assertEqual(root.find("DETAIL").text_of("DESCRIPTION"), "")
        site = root.find("SITES").findall("SITE")[0]
        self.assertEqual(site.text_of("ADDRESS0"), "")
        eqs = site.find("DESIGNSET").find("EQUIPMENTS").findall("EQUIPMENT")
        self.assertEqual(len(eqs), 2)
        sw, ap = eqs

        def props(eq):
            return [(p.text_of("PROPERTYID"), p.text_of("LABEL"), p.text_of("VALUE"), p.text_of("CODE"),
                     p.text_of("PROPFLAGSCUR")) for p in eq.find("PROPERTYS").findall("PROPERTY")]

        swp = props(sw)
        self.assertEqual(sw.text_of("PRODUCTID"), "900001")
        self.assertEqual(sw.text_of("PARTID"), "910002")
        self.assertIn(("913", "Select Model", "", "", "9013"), swp)
        self.assertIn(("905", "Select Model_", "FAKE-SW-24B", "907", "9005"), swp)
        slot0, slot1 = str((5 << 16) | 31), str((6 << 16) | 31)
        self.assertIn((slot0, "Power Cord Selection", "Cord, US, C13", "955", "9101"), swp)
        self.assertIn((slot1, "Power Cord Selection", "Cord, US, C13", "955", "9101"), swp)
        inc1 = str((6 << 16) | 34)
        self.assertIn((inc1, "Make Power Cords INCLUDED", "TRUE", "971", "9104"), swp)  # PSU child present
        self.assertEqual(swp[-1], ("9999008", "Quantity Multiplier", "2", "", "0"))
        app = props(ap)
        self.assertIn(("924", "Fake Regulatory Domain / Region:", "US", "982", "9204"), app)
        self.assertIn(("925", "Select Model", "FAKEAP7", "991", "9205"), app)
        misc = site.find("DESIGNSET").find("MISCPARTS").findall("MISCPART")
        self.assertEqual([m.text_of("PARTID") for m in misc], ["910006"])
        self.assertEqual(misc[0].text_of("FLAGS"), "99")  # record layout copied from template
        eqparts = [e.text_of("PRT_NUM") for e in sw.find("EQPARTS").findall("EQPART")]
        self.assertEqual(eqparts, ["FAKE-SW-24B", "FAKE-PSU-2"])

    def test_second_cord_slot_off_without_psu(self):
        spec = {"project": "P", "sites": [{"name": "S", "lines": [{"sku": "FAKE-SW-24A", "qty": 1}]}]}
        code, _, stderr, out = self.build(spec, "--isf")
        self.assertEqual(code, 0, stderr)
        iris = isf.decode_isf(out / "P.isf")
        eq = iris.root.find("SITES").findall("SITE")[0].find("DESIGNSET").find("EQUIPMENTS").findall("EQUIPMENT")[0]
        vals = {p.text_of("PROPERTYID"): (p.text_of("VALUE"), p.text_of("CODE"))
                for p in eq.find("PROPERTYS").findall("PROPERTY")}
        self.assertEqual(vals[str((6 << 16) | 34)], ("FALSE", "972"))
        self.assertEqual(vals[str((6 << 16) | 32)], ("0", ""))

    def test_power_cord_override_and_region(self):
        spec = {"project": "P", "sites": [{"name": "S", "lines": [
            {"sku": "FAKE-SW-24A", "qty": 1, "power_cord": "Cord, 15A, US/Canada, C13"}]}]}
        code, _, stderr, out = self.build(spec, "--isf")
        self.assertEqual(code, 0, stderr)
        root = isf.decode_isf(out / "P.isf").root
        values = [n.text for n in root.iter_descendants() if n.tag == "VALUE"]
        self.assertIn("Cord, 15A, US/Canada, C13", values)

    def test_unresolvable_line_fails_clearly(self):
        spec = {"project": "P", "sites": [{"name": "S", "lines": [
            {"sku": "FAKE-SW-48Z", "qty": 1}, {"sku": "FAKE-SW-24A", "qty": 1}]}]}
        code, _, stderr, out = self.build(spec, "--isf")
        self.assertEqual(code, cli.EXIT_ISF_ERRORS)
        self.assertIn("FAKE-SW-48Z: no option", stderr)
        self.assertFalse((out / "P.isf").exists())
        self.assertTrue((out / "P-bom.xlsx").exists())
        code, _, stderr, out2 = self.build(spec, "--isf", "--allow-partial")
        self.assertEqual(code, 0, stderr)
        self.assertTrue(list(out.glob("P*.isf")))

    def test_region_without_option_fails(self):
        spec = {"project": "P", "region": "ZZ", "sites": [{"name": "S", "lines": [{"sku": "FAKEAP7-US", "qty": 1}]}]}
        code, _, stderr, _ = self.build(spec, "--isf")
        self.assertEqual(code, cli.EXIT_ISF_ERRORS)
        self.assertIn("no option labeled 'ZZ'", stderr)

    def test_template_without_device_is_rejected(self):
        code, _, stderr, _ = self.build(LAB_SPEC, "--isf", template_kw={"with_equipment": False})
        self.assertEqual(code, cli.EXIT_USAGE)
        self.assertIn("place any one configurable device", stderr)

    def test_isf_needs_template(self):
        args, _ = self.fake()
        code, _, stderr = run_cli(*args, "build", "--spec", str(self.write_spec(LAB_SPEC)),
                                  "--out", str(self.dir / "o"), "--isf")
        self.assertEqual(code, cli.EXIT_USAGE)
        self.assertIn("--isf needs --template", stderr)

    def test_never_overwrites(self):
        self.build(LAB_SPEC)
        _, _, _, out = self.build(LAB_SPEC)
        names = sorted(p.name for p in (out / "Fake Client").iterdir())
        self.assertIn("Fake-Lab-bom (2).xlsx", names)

    def test_client_root_reuses_existing_folder(self):
        args, _ = self.fake()
        root = self.dir / "Clients"
        (root / "Springfield").mkdir(parents=True)
        code, _, stderr = run_cli(*args, "build", "--spec", str(self.write_spec(LAB_SPEC)),
                                  "--client", "Springfield Public Schools", "--client-root", str(root))
        self.assertEqual(code, 0, stderr)
        self.assertTrue((root / "Springfield" / "Fake-Lab-bom.xlsx").exists())


class FormatTests(Base):
    def test_roundtrip_is_byte_identical(self):
        t = fixtures.make_template(self.dir / "t.isf")
        raw = t.read_bytes()
        iris = isf.decode_isf(raw)
        self.assertEqual(isf.encode(iris.header, iris.header_order, iris.payload), raw)
        self.assertEqual(isf.encode_tree(iris), raw)

    def test_csv_spec(self):
        p = self.dir / "bom.csv"
        p.write_text("Site,Part Number,Qty,Parent SKU\nA,FAKE-SW-24A,2,\nA,FAKE-SUB-3Y,2,FAKE-SW-24A\nB,FAKEAP7-US,1,\n")
        spec = specmod.load_spec(p)
        self.assertEqual([s["name"] for s in spec["sites"]], ["A", "B"])
        self.assertEqual(spec["sites"][0]["lines"][1]["duration"], "36")


@unittest.skipUnless(preflight.run().ok, "Intangi Iris is not installed on this computer")
class RealCatalogTests(unittest.TestCase):
    """Runs only on a computer with Iris installed. Reads that user's own cache."""

    def test_index_builds_from_local_iris(self):
        pf = preflight.run()
        idx = catalog.load_or_build(pf.cache_path, log=lambda m: None)
        self.assertGreater(len(idx["parts"]), 0)
        self.assertGreater(len(idx["products"]), 0)
        skus = [s for s in os.environ.get("IRIS_BOM_IT_SKUS", "").split(",") if s]
        for sku in skus:
            self.assertIsNotNone(catalog.part(idx, sku), f"{sku} not in local catalog")


if __name__ == "__main__":
    unittest.main()
