"""Synthetic test fixtures. EVERYTHING here is made up.

All ids, codes, part numbers, country numbers, and labels below are FAKE
values invented for tests (ids start with 9 and part numbers with FAKE-).
They are not copied from any Intangi catalog and do not exist in one.
"""

from __future__ import annotations

import plistlib
import zlib
from pathlib import Path

FAKE_HEADER = (
    '<?xml version="1.0" encoding="UTF-8" ?>\n<INTANGI_FILE_EX>\n'
    "<FILE_TYPE>91</FILE_TYPE>\n<FILE_VERSION>0</FILE_VERSION>\n"
    "<FILE_DATE>2000-01-01:00:00:00</FILE_DATE>\n<APPLICATION>92</APPLICATION>\n"
    "<APP_VERSION>93</APP_VERSION>\n<USER_ORG>{org}</USER_ORG>\n<USER>{user}</USER>\n"
)


def wrap(payload: str, org: str = "0", user: str = "0") -> bytes:
    return FAKE_HEADER.format(org=org, user=user).encode() + zlib.compress(payload.encode(), 6) + b"</INTANGI_FILE_EX>\n"


def _leafs(**kw) -> str:
    return "".join(f"<{k}>{v}</{k}>\n" for k, v in kw.items())


def _prop(pid, label, flags="9", options=(), valuedef="", codedef=""):
    opts = ""
    if options:
        opts = "<OPTIONS>\n" + "".join(
            f"<OPTION>\n{_leafs(OPTIONID=c, LABEL=l, TOOLTIP=t, FLAGS='0')}</OPTION>\n" for c, l, t in options
        ) + "</OPTIONS>\n"
    return (
        "<PROPERTY>\n"
        + _leafs(PRODUCTID="900000", MODELVER="1", PROPERTYID=pid, LABEL=label, DATATYPE="1",
                 TOOLTIP="", PROPFLAGSDEF=flags, VALUEDEF=valuedef, CODEDEF=codedef, SEQUENCE=pid)
        + opts
        + "</PROPERTY>\n"
    )


def _model(props: str, submodels: str = "") -> str:
    return (
        "<PRODUCT>\n<PART>\n" + _leafs(LABEL="Fake product", PARTNUMBER="corepart") + "</PART>\n</PRODUCT>\n"
        "<CHILDREN>\n</CHILDREN>\n"
        f"<SUBMODELS>\n{submodels}</SUBMODELS>\n"
        f"<PROPERTIES>\n{props}</PROPERTIES>\n"
    )


FAKE_PARTS = {
    # sku: (partid, description, manufacturer id)
    "FAKE-SW-24A": ("910001", "Fake 24-port switch A", "99"),
    "FAKE-SW-24B": ("910002", "Fake 24-port PoE switch B", "99"),
    "FAKEAP7-US": ("910003", "Fake AP7 access point for US", "99"),
    "FAKE-PSU-2": ("910004", "Fake 999W AC power supply", "99"),
    "FAKE-SUB-3Y": ("910005", "Fake 3 year subscription", "99"),
    "FAKE-DAC-1M": ("910006", "Fake 1m DAC cable", "99"),
    "FAKE-SW-48Z": ("910007", "Fake 48-port switch with no picker option", "99"),
}


def make_cache(root: Path, *, with_app: bool = True, bundle_id: str = "com.intangi.iris") -> dict[str, Path]:
    root = Path(root)
    app = root / "Applications" / "Iris.app"
    if with_app:
        (app / "Contents").mkdir(parents=True, exist_ok=True)
        with (app / "Contents" / "Info.plist").open("wb") as fh:
            plistlib.dump({"CFBundleIdentifier": bundle_id, "CFBundleShortVersionString": "0.0-fake"}, fh)
    cache = root / "Intangi" / "cache"
    for sub in ("misc", "part", "prod", "deploy", "systems"):
        (cache / sub).mkdir(parents=True, exist_ok=True)

    (cache / "misc" / "manu_9.mod").write_bytes(wrap(
        "<ORGANIZATION>\n" + _leafs(ORGID="99", NAME="Fakevendor Networks") + "</ORGANIZATION>\n"))
    (cache / "misc" / "prodlist_9.mod").write_bytes(wrap(
        "<LISTINGITEM>\n" + _leafs(PARTNUMBER="FAKE-SW-24A", PRODUCTID="900001", MODELVER="1",
                                   LABEL="Fake switch family", TYPELABEL="Switch", MANUNAME="Fakevendor Networks")
        + "</LISTINGITEM>\n"
        + "<LISTINGITEM>\n" + _leafs(PARTNUMBER="FAKEAP7-US", PRODUCTID="900002", MODELVER="1",
                                     LABEL="Fake AP7", TYPELABEL="Wireless", MANUNAME="Fakevendor Networks")
        + "</LISTINGITEM>\n"
        + "<LISTINGITEM>\n" + _leafs(PARTNUMBER="FAKE-SW-48Z", PRODUCTID="900001", MODELVER="1",
                                     LABEL="Fake switch family", TYPELABEL="Switch", MANUNAME="Fakevendor Networks")
        + "</LISTINGITEM>\n"))
    (cache / "misc" / "look_9.mod").write_bytes(wrap(
        "<LOOKUP>\n<LOOKUPID>900077</LOOKUPID>\n<LABEL>Fake Localization</LABEL>\n<FLAGS>0</FLAGS>\n<DATA>\n"
        "<COLUMN>CountryNumb\t99000\t99001\t99002</COLUMN>\n"
        "<COLUMN>Country\t0\tTestland\tUnited States</COLUMN>\n"
        "<COLUMN>c13\t0\tCord, EU, C13\tCord, US, C13</COLUMN>\n"
        "</DATA>\n</LOOKUP>\n"))
    (cache / "part" / "part_1.mod").write_bytes(wrap("".join(
        "<PART>\n" + _leafs(PARTID=pid, PARTNUMBER=sku, DESCRIPTION=desc, MANUFACTURERID=mid) + "</PART>\n"
        for sku, (pid, desc, mid) in FAKE_PARTS.items())))

    switch_props = (
        _prop("913", "Select Model", flags="9013")
        + _prop("905", "Select Model_", flags="9005",
                options=[("901", "FAKE-SW-24A", ""), ("907", "FAKE-SW-24B", "")])
    )
    switch_subs = (
        "<SUBMODEL>\n" + _leafs(PRODUCTID="900001", SUBPRODUCTID="900009", SUBMODELVER="1", INSTANCE="5") + "</SUBMODEL>\n"
        "<SUBMODEL>\n" + _leafs(PRODUCTID="900001", SUBPRODUCTID="900009", SUBMODELVER="1", INSTANCE="6") + "</SUBMODEL>\n"
    )
    (cache / "prod" / "prod900001_1.mod").write_bytes(wrap(_model(switch_props, switch_subs)))
    cord_props = (
        _prop("31", "Power Cord Selection", flags="9101",
              options=[("951", "Cord, EU, C13", ""), ("955", "Cord, US, C13", ""), ("965", "Cord, 15A, US/Canada, C13", "")])
        + _prop("32", "Power Cord Quantity", flags="9102")
        + _prop("34", "Make Power Cords INCLUDED", flags="9104", options=[("971", "TRUE", ""), ("972", "FALSE", "")])
    )
    (cache / "prod" / "prod900009_1.mod").write_bytes(wrap(_model(cord_props)))
    ap_props = (
        _prop("924", "Fake Regulatory Domain / Region:", flags="9204",
              options=[("987", "WW", ""), ("982", "US", ""), ("988", "US Bundle", "")], valuedef="WW", codedef="987")
        + _prop("925", "Select Model", flags="9205", options=[("991", "FAKEAP7", "")])
        + _prop("960", "Quantity Multiplier", flags="9260")
    )
    (cache / "prod" / "prod900002_1.mod").write_bytes(wrap(_model(ap_props)))

    # Protected files: deliberately NOT valid modules. If the tool ever
    # opened them, decoding would fail and the tests would catch it.
    (cache / "deploy" / "user.mod").write_bytes(b"FAKE-ACCOUNT-DO-NOT-READ")
    (cache / "deploy" / "plist900123.mod").write_bytes(b"FAKE-PRICES-DO-NOT-READ")
    (cache / "misc" / "plist900124.mod").write_bytes(b"FAKE-PRICES-DO-NOT-READ")
    (cache / "systems" / "fake-project.bak").write_bytes(b"FAKE-USER-PROJECT-DO-NOT-READ")
    return {"app": app, "cache": cache}


def make_template(path: Path, *, with_equipment: bool = True, with_misc: bool = True) -> Path:
    eq = ""
    if with_equipment:
        eq = (
            "<EQUIPMENT>\n"
            + _leafs(EQUIPMENTID="1", DESIGNID="1", EQUIPSTATUS="0", EQUIPFLAGS="0", EQUIPFLAGS2="9",
                     BV_POSITIONX="1", BV_POSITIONY="1", LABELNUMBER="-1", LAYERCODE="9",
                     INSTALLDATE="2000-01-01:00:00:00", PARTID="910001", PRODUCTID="900001", MODELVERSION="1")
            + "<PROPERTYS>\n<PROPERTY>\n"
            + _leafs(PROPERTYID="9999008", LABEL="Quantity Multiplier", VALUE="1", CODE="", PROPFLAGSCUR="0")
            + "</PROPERTY>\n</PROPERTYS>\n<PORTS>\n</PORTS>\n<EQPARTS>\n</EQPARTS>\n</EQUIPMENT>\n"
        )
    misc = ""
    if with_misc:
        misc = "<MISCPARTS>\n<MISCPART>\n" + _leafs(
            MISCID="1", PARTID="910006", DESIGNID="0", MISCPARTQTY="1", QUANTITY="1", FLAGS="99", LAYERCODE="9"
        ) + "</MISCPART>\n</MISCPARTS>\n"
    payload = (
        "<SYSTEM>\n<DETAIL>\n"
        + _leafs(SYSTEMID="5", SYSGUID="00000000-fake", NAME="Template", DESCRIPTION="old text",
                 LOCATION="Somewhere", COUNTRY="99000", CREATEBY="42", CREATEDATE="x", MODIFYDATE="x",
                 OPENSITES="0,1,1", FLAGS="9")
        + "<PROPERTYS>\n</PROPERTYS>\n<INTEGDATAARRAY>\n</INTEGDATAARRAY>\n"
        "</DETAIL>\n<DESIGNS>\n<DESIGN>\n"
        + _leafs(DESIGNID="1", CUSTOMER="-1", LABEL="Template", COMMENT="old comment", OWNERUSERID="42",
                 PLISTARRAY="", ASOFDATE="x")
        + "<TEAMMEMBERS>\n</TEAMMEMBERS>\n<DISPLAYGROUP>\n" + _leafs(GROUPID="0", LABEL="All")
        + "</DISPLAYGROUP>\n</DESIGN>\n</DESIGNS>\n<USERIMAGES>\n</USERIMAGES>\n<SITES>\n<SITE>\n"
        + _leafs(SITEID="1", DESIGNID="1", SITENAME="Site 1", POSX="777", POSY="888", TYPE="9",
                 ADDRESS0="1 Fake St", CONTACT="Nobody", POSX_="x")
        .replace("<POSX_>x</POSX_>\n", "<POSX>777</POSX>\n")
        + "<DESIGNSET>\n<EQUIPMENTS>\n" + eq + "</EQUIPMENTS>\n" + misc
        + "<WORKSPACES>\n<WORKSPACE>\n" + _leafs(SPACEID="0", LABEL="Main Workspace") + "</WORKSPACE>\n</WORKSPACES>\n"
        "</DESIGNSET>\n</SITE>\n</SITES>\n<PATHS>\n</PATHS>\n"
        "<MATERIALS>\n<MATERIAL>\n" + _leafs(LABEL="Fake material") + "</MATERIAL>\n</MATERIALS>\n"
        "<LAYERS>\n<LAYER>\n" + _leafs(LABEL="Fake layer") + "</LAYER>\n</LAYERS>\n"
        "<DESGRPS>\n</DESGRPS>\n<ACTIVITYLOG>\n</ACTIVITYLOG>\n</SYSTEM>\n"
    )
    Path(path).write_bytes(wrap(payload, org="4242", user="42"))
    return Path(path)
