// Stacks in live topology carry a stack id (UUID) as their serial, while LLDP
// rows and cross-site links name member hardware. These tests build that
// shape synthetically and check the uplink reaches the district core.
import test from "node:test";
import assert from "node:assert/strict";
import { central, CentralError } from "../worker/src/central.ts";
import { aliasIndex, macKey, mergeTenant } from "../worker/src/merge.ts";
import { buildModel } from "../site/js/model.js";
import { linkCheckExport } from "../site/js/export.js";

const CORE = "0b1c2d3e-0000-4000-8000-00000000c0de";
const MDF = "ce06b81a-9c07-47e7-8685-781b70d00001";
const CAFE = "5850bc11-613d-4c1f-912e-58e29701dcfd";
const MEZZ = "7a7a7a7a-1111-4222-8333-444444444444";
const PW = "43b58f0a-475b-4807-a118-f44a4ca3125e";

const dev = (serial, name, extra = {}) => ({ serial, name, type: "Switch", model: "CX-6300M", deviceFunction: "Access Switch", deployment: "Stack", ...extra });
const link = (from, to, fp, tp) => ({ from, to, fromPortList: [{ name: fp }], toPortList: [{ name: tp }] });

const MEMBERS = {
  [CORE]: [{ serialNumber: "SGCORE0001", macAddress: "aa:bb:cc:00:00:01", deviceName: "LCSC-DC-Stack1", stackMemberId: 1 },
    { serialNumber: "SGCORE0002", macAddress: "aa:bb:cc:00:00:02", deviceName: "LCSC-DC-Stack1", stackMemberId: 2 }],
  [MDF]: [{ serialNumber: "SGMDF00001", stackMemberId: 1 }, { serialNumber: "SGMDF00002", stackMemberId: 2 }],
  [CAFE]: [{ serialNumber: "SGCAFE0001", stackMemberId: 1 }],
  [MEZZ]: [{ serialNumber: "SGMEZZ0001", stackMemberId: 1 }],
  [PW]: [{ serialNumber: "SG3AKMY3JW", stackMemberId: 1 }, { serialNumber: "SG3AKMY3KZ", stackMemberId: 2 }],
};

function tenant({ crossSiteTopologyLink = false } = {}) {
  const topo = {
    hs: { devices: [dev(CORE, "LCSC-DC-Stack1", { deviceFunction: "Core Switch" }), dev("SGHSACC001", "HS-ACC-1", { deployment: "Standalone" })],
      links: [link(CORE, "SGHSACC001", "1/1/1", "1/1/52")] },
    // STO is the biggest piece, so the core is not in the biggest component.
    sto: { devices: [dev(MDF, "STO-MDF-STACK"), dev(CAFE, "STO-CAFE-STACK"), dev(MEZZ, "STO-MEZZ-STACK")],
      links: [link(MDF, CAFE, "1/1/51", "1/1/51"), link(MDF, MEZZ, "2/1/51", "1/1/52"),
        ...(crossSiteTopologyLink ? [link("SGMDF00002", "SGCORE0002", "2/1/52", "2/1/10")] : [])] },
    pw: { devices: [dev(PW, "SG3AKMY3JW", { deviceFunction: null }), dev("SGPWTRA119", "PW-TR-A119", { deployment: "Standalone" })],
      links: [link(PW, "SGPWTRA119", "1/1/52", "1/1/52")] },
  };
  const neighbours = {
    // Stack id answers with member-named rows: the core by its member serial.
    [MDF]: { neighbours: [
      { serial: "SGCAFE0001", name: "STO-CAFE-STACK", localPort: "1/1/51", toPort: "1/1/51", memberSerial: "SGMDF00001" },
      { serial: "SGCORE0002", name: "LCSC-DC-Stack1", localPort: "2/1/52", toPort: "2/1/10", memberSerial: "SGMDF00002" },
    ] },
    // Stack id answers empty; a member names the core by tpd_<mac>.
    [PW]: { neighbours: [] },
    SG3AKMY3KZ: { neighbours: [{ serial: "tpd_aabbcc000001", name: null, localPort: "2/1/52", toPort: "1/1/20" }] },
    SG3AKMY3JW: { neighbours: [{ serial: "SGPWTRA119", name: "PW-TR-A119", localPort: "1/1/52", toPort: "1/1/52" }] },
  };
  const calls = [];
  const get = async (path) => {
    calls.push(path);
    let m;
    if (path === "/network-monitoring/v1/sites-health") return { items: [{ id: "hs", siteName: "High School" }, { id: "sto", siteName: "Stokes Elementary" }, { id: "pw", siteName: "Perry Worth Elementary" }] };
    if (path === "/network-monitoring/v1/device-inventory") return { items: [...Object.values(MEMBERS).flat().map((x) => ({ serialNumber: x.serialNumber })), { serialNumber: "SGHSACC001" }, { serialNumber: "SGPWTRA119" }] };
    if ((m = path.match(/topology\/([^/]+)$/))) return topo[m[1]];
    if ((m = path.match(/stack\/([^/]+)\/members$/))) return { items: MEMBERS[decodeURIComponent(m[1])] ?? [] };
    if ((m = path.match(/neighbours\/([^/]+)$/))) { const hit = neighbours[decodeURIComponent(m[1])]; if (hit) return hit; throw new CentralError("no neighbours", 404); }
    if ((m = path.match(/switches\/([^/]+)$/))) { const id = decodeURIComponent(m[1]); return { serialNumber: MEMBERS[id]?.[0]?.serialNumber ?? id, jNumber: "R8S89A" }; }
    throw new CentralError(`no route ${path}`, 404);
  };
  return { get, calls };
}

const pool = async (xs, _n, f) => Promise.all(xs.map(f));

async function merged(opts) {
  const { get, calls } = tenant(opts);
  const c = central(get);
  const warnings = [];
  const out = await mergeTenant(c, await c.sites(), pool, (w) => warnings.push(w));
  return { ...out, warnings, calls };
}

test("an LLDP row naming a core stack member links the building stack to the core", async () => {
  const { links, lldpRows } = await merged();
  const up = links.find((l) => [l.from, l.to].includes(MDF) && [l.from, l.to].includes(CORE));
  assert.ok(up, "STO-MDF to core link is kept");
  assert.equal(up.source, "neighbours");
  assert.equal(up.from === MDF ? up.fromPort : up.toPort, "2/1/52");
  const row = lldpRows.find((r) => r.neighbourSerial === "SGCORE0002");
  assert.equal(row.matched, CORE);
  assert.equal(row.localMember, "SGMDF00002");
});

test("path to core is transitive: STO-CAFE reaches the core through STO-MDF", async () => {
  const { switches, links } = await merged();
  const model = buildModel({ switches, links }, { coreSerial: CORE });
  const hop = (s) => model.byId.get(s).hop;
  assert.equal(hop(MDF), 1);
  assert.equal(hop(CAFE), 2);
  assert.equal(hop(MEZZ), 2);
  for (const s of [MDF, CAFE, MEZZ]) assert.equal(model.byId.get(s).flags.includes("no path to district core"), false);
  assert.equal(model.byId.get(CAFE).parent, MDF);
});

test("a stack id with no LLDP rows falls back to its members, and tpd_<mac> matches a member MAC", async () => {
  const { switches, links, calls } = await merged();
  assert.ok(calls.some((p) => p.endsWith("/neighbours/SG3AKMY3KZ")));
  const up = links.find((l) => [l.from, l.to].includes(PW) && [l.from, l.to].includes(CORE));
  assert.ok(up, "Perry Worth stack reaches the core by MAC");
  const model = buildModel({ switches, links }, { coreSerial: CORE });
  assert.equal(model.byId.get(PW).hop, 1);
  assert.equal(model.byId.get("SGPWTRA119").hop, 2);
});

test("a cross-site topology link that names member serials is re-pointed at both stacks", async () => {
  const { get } = tenant({ crossSiteTopologyLink: true });
  const c = central(async (path) => (path.includes("/neighbours/") ? { neighbours: [] } : get(path)));
  const { links } = await mergeTenant(c, await c.sites(), pool, () => {});
  const up = links.find((l) => [l.from, l.to].includes(MDF) && [l.from, l.to].includes(CORE));
  assert.ok(up);
  assert.equal(up.source, "topology");
  assert.equal(links.some((l) => l.from === "SGMDF00002" || l.to === "SGCORE0002"), false);
});

test("stack ids count as Central switches when their member hardware is in inventory", async () => {
  const { switches } = await merged();
  assert.equal(switches.find((s) => s.serial === PW).central, true);
});

test("alias index: serial, member, MAC formats, unique names only", () => {
  const r = aliasIndex(
    [{ serial: "A", name: "SW-1", mac: "00:11:22:33:44:55" }, { serial: "B", name: "dup" }, { serial: "C", name: "DUP" }],
    [{ id: "member-a2", serial: "A" }],
  );
  assert.equal(r("a"), "A");
  assert.equal(r("MEMBER-A2"), "A");
  assert.equal(r("tpd_001122334455"), "A");
  assert.equal(r("0011.2233.4455"), "A");
  assert.equal(r("unknown", "sw-1"), "A");
  assert.equal(r("unknown", "dup"), null);
  assert.equal(r(null, null), null);
  assert.equal(macKey("tpd_883a3094c340"), "mac:883a3094c340");
  assert.equal(macKey("SG3AKMY3JW"), null);
});

test("link check export keeps LLDP rows and identities, drops IPs and VLANs", async () => {
  const { switches, links, lldpRows } = await merged();
  const data = { generatedAt: "t", mock: false, switches: switches.map((s) => ({ ...s, ipv4: "10.0.0.1", vlans: [{ id: "1", ipv4: "10.0.0.1" }] })), links, lldpRows };
  const out = linkCheckExport(data);
  const text = JSON.stringify(out);
  assert.equal(text.includes("10.0.0.1"), false);
  assert.equal(out.lldpRows.length, lldpRows.length);
  assert.ok(out.switches.some((s) => s.serial === MDF && s.name === "STO-MDF-STACK"));
  assert.ok(out.unmatchedRows.every((r) => r.matched === null));
});
