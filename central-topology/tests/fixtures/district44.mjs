// 44-switch district in the shape of a real K-12 tenant: 8 buildings, a
// two-column high school, two unnamed switches (name = serial), one stack,
// LAG second legs that become stubs, cross-building links, fallback IPs, and
// one switch with no management IP. Test data only: serials, MACs, and
// addresses are synthetic. Loaded by tests/ and served to the browser only
// through the mock /api/topology route in the screenshot harness.

const BUILDINGS = [
  { site: "Admin and PreK", head: "ADM-MDF", access: ["ADM-IDF"] },
  { site: "Middle School", head: "LMS-ER-RM154-CORE2", access: ["LMS-ER-RM154-CORE1", "LMS-ER-STACK", "LMS-TR1-STACK", "LMS-TR2-STACK", "LMS-TR3-STACK", "LMS-TR5-STACK", "LMS-CAFE-STACK"] },
  { site: "Perry Worth Elementary", head: "", access: ["PW-TR-A119", "PW-TR-B117", "PW-TR-D106"] },
  { site: "Transportation", head: "TRANS", access: [] },
  { site: "High School", head: "LCSC-DC-Stack1", access: ["LCSC-DC-INTERNET", "LCSC-DC-SAN-Stack1", "LHS-CORE-VSX-1", "LHS-CORE-VSX-2", "LHS-C214-STACK", "LHS-D111-STACK", "LHS-E100-STACK", "LHS-H109-STACK", "LHS-J114-STACK", "LHS-M103-STACK", "LHS-MDF-Stack1", "LHS-MDF-Stack2", "LHS-N105-STACK", "LHS-P109-SW1", "LHS-TRAC-SW1"] },
  { site: "Central Elementary", head: "CEN-ER-C130", access: ["CEN-TR-A121", "CEN-TR-B105", "CEN-TR-C139", "CEN-TR-D128", "CEN-TR-E116"] },
  { site: "Harrison Elementary", head: "", access: ["HAR-IDF-114", "HAR-IDF-308", "HAR-IDF-426B"] },
  { site: "Stokes Elementary", head: "STO-MDF-STACK", access: ["STO-CAFE-STACK", "STO-MEZZ-STACK"] },
];

const M = {
  m: "Aruba CX 6300M 48G Class4 PoE 4SFP56",
  l: "Aruba CX 6300L 48G Class4 PoE 4SFP56",
  vsx: "Aruba CX 8360-16Y2C",
};

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).toUpperCase().padStart(8, "0");
}
const serialOf = (key) => `TS${hash(key)}`;
const macOf = (key) => { const x = hash(`mac${key}`).toLowerCase(); return `02:00:5e:${x.slice(0, 2)}:${x.slice(2, 4)}:${x.slice(4, 6)}`; };

/** API-shaped topology plus coreSerial. `msCoreUplink` adds the tenant shape
 * where the Middle School VSX mate (CORE1) is also uplinked to the HS core. */
export function district44({ msCoreUplink = false } = {}) {
  const switches = [], links = [], externals = [];
  const by = new Map();
  BUILDINGS.forEach((b, bi) => {
    const names = [b.head, ...b.access];
    names.forEach((name, ni) => {
      const key = name || `${b.site}-unnamed`;
      const serial = serialOf(key);
      const model = /VSX/.test(name) ? M.vsx : ni === 0 || /CORE|DC-/.test(name) ? M.m : M.l;
      const host = 10 + ni;
      const ipv4 = `10.20.${bi}.${host}`;
      // VLAN 1 SVI on most switches; VLAN 20 SVI on every other one, so the
      // selector changes the drawn IP. Every fifth switch has no VLAN 1 SVI
      // (fallback to the monitoring IP). HAR-IDF-426B has no IP at all.
      const vlans = [];
      if ((bi * 7 + ni) % 5 !== 3) vlans.push({ id: "1", name: "DEFAULT_VLAN_1", ipv4: `10.20.${bi}.${host}` });
      if (ni % 2 === 0) vlans.push({ id: "20", name: "MGMT", ipv4: `172.16.${bi}.${host}` });
      const none = name === "HAR-IDF-426B";
      const s = {
        serial, mac: macOf(key), name: name || serial, model, type: "Switch",
        status: !name && b.site.startsWith("Perry") ? "OFFLINE" : "ONLINE",
        site: b.site, siteId: b.site, group: null,
        ipv4: none ? null : ipv4, vlans: none ? [] : vlans, interfaces: [],
      };
      switches.push(s);
      by.set(key, s);
    });
  });
  const S = (name) => by.get(name).serial;
  const link = (a, ap, b, bp, lag = null, source = "topology") => links.push({
    from: S(a), to: S(b), fromPort: ap[0], toPort: bp[0], speedGbps: 10, source,
    fromPorts: ap.map((name) => ({ name, lag })), toPorts: bp.map((name) => ({ name, lag })),
  });

  // Stack: LHS-MDF-Stack2 is member 2 of LHS-MDF-Stack1.
  const st1 = by.get("LHS-MDF-Stack1"), st2 = by.get("LHS-MDF-Stack2");
  st1.conductorSerial = st1.serial; st1.stackMemberId = 1; st1.deployment = "Stack";
  st2.conductorSerial = st1.serial; st2.stackMemberId = 2; st2.deployment = "Stack";

  // Backbone: every building head to the district core.
  const core = "LCSC-DC-Stack1";
  const heads = { "Admin and PreK": "ADM-MDF", "Middle School": "LMS-ER-RM154-CORE2", "Perry Worth Elementary": "Perry Worth Elementary-unnamed", Transportation: "TRANS", "Central Elementary": "CEN-ER-C130", "Harrison Elementary": "Harrison Elementary-unnamed", "Stokes Elementary": "STO-MDF-STACK" };
  Object.values(heads).forEach((h, i) => link(core, [`1/1/${20 + i}`], h, ["1/1/52"], `lag${20 + i}`));

  // High school: DC switches on the core, VSX pair on the core, access on
  // VSX-2 with a LAG second leg to VSX-1 (drawn as a stub).
  for (const n of ["LCSC-DC-INTERNET", "LCSC-DC-SAN-Stack1"]) link(core, [n.length > 16 ? "1/1/3" : "1/1/2"], n, ["1/1/49"]);
  link(core, ["1/1/16", "1/1/17"], "LHS-CORE-VSX-1", ["1/1/1", "1/1/2"], "lag256");
  link(core, ["1/1/18", "1/1/19"], "LHS-CORE-VSX-2", ["1/1/1", "1/1/2"], "lag256");
  const hsAccess = BUILDINGS[4].access.filter((n) => n.startsWith("LHS-") && !/VSX|Stack2/.test(n));
  hsAccess.forEach((n, i) => {
    link("LHS-CORE-VSX-2", [`1/1/${4 + i}`], n, ["1/1/51"], `lag${3 + i}`);
    link("LHS-CORE-VSX-1", [`1/1/${4 + i}`], n, ["1/1/52"], `lag${3 + i}`);
  });

  // Middle school: access on CORE2, LAG second legs to CORE1.
  for (const [i, n] of BUILDINGS[1].access.entries()) {
    link("LMS-ER-RM154-CORE2", [`1/1/${i + 1}`], n, ["1/1/52"], `lag${i + 1}`);
    if (i) link("LMS-ER-RM154-CORE1", [`1/1/${i + 1}`], n, ["1/1/51"], `lag${i + 1}`);
  }
  // Other buildings: access on the head.
  for (const [bi, b] of BUILDINGS.entries()) {
    if (bi === 1 || bi === 4) continue;
    const head = b.head || `${b.site}-unnamed`;
    b.access.forEach((n, i) => link(head, [`1/1/${i + 1}`], n, ["1/1/52"]));
  }
  // Cross-building links: these leave their section as stubs.
  link("PW-TR-A119", ["1/1/48"], "LMS-TR3-STACK", ["1/1/48"]);
  link("HAR-IDF-114", ["1/1/48"], "LHS-CORE-VSX-1", ["1/1/40"], "lag40");
  link("HAR-IDF-308", ["1/1/48"], "LHS-CORE-VSX-1", ["1/1/41"], "lag41");
  link("CEN-TR-A121", ["1/1/48"], "STO-CAFE-STACK", ["1/1/48"]);
  link("ADM-IDF", ["1/1/48"], "TRANS", ["1/1/48"]);
  link("LMS-CAFE-STACK", ["1/1/47"], "LHS-TRAC-SW1", ["1/1/47"]);
  if (msCoreUplink) link("LMS-ER-RM154-CORE1", ["1/1/51"], "LHS-CORE-VSX-1", ["1/1/45"], "lag45");

  // LLDP neighbours: a firewall behind LCSC-DC-INTERNET, some APs, a controller.
  const ext = (name, type, local, port) => {
    const serial = `TX${hash(name)}`;
    externals.push({ serial, name, mac: macOf(name), type, status: "ONLINE" });
    links.push({ from: S(local), to: serial, fromPort: port, toPort: "eth0", source: "neighbours" });
  };
  ext("LCSC-FW-01", "Firewall", "LCSC-DC-INTERNET", "1/1/1");
  ext("LCSC-WLC-01", "Mobility Controller", core, "1/1/30");
  ["CEN-TR-A121", "CEN-TR-B105", "STO-CAFE-STACK", "LHS-P109-SW1", "LHS-C214-STACK"].forEach((n, i) => ext(`AP-${String(i + 1).padStart(3, "0")}`, "Access Point", n, "1/1/10"));

  return {
    mock: true,
    generatedAt: "2026-11-04T17:34:03.000Z",
    sites: BUILDINGS.map((b) => ({ id: b.site, name: b.site })),
    switches, externals, links, warnings: [],
    coreSerial: S(core),
  };
}
