// Live-tenant shape behind "ADM-MDF -> LCSC-DC-Stack1 drawn as inferred":
// the core stack's topology id is its conductor's hardware serial (not a
// stack UUID) and its topology name is serial-shaped. Only the inventory
// (stackId, deviceName) and switch detail know the members and the real
// name. ADM is its own site with no topology link to the core, so the
// uplink can only come from ADM-MDF's LLDP row, which names the core by a
// member serial or by "LCSC-DC-Stack1".
import test from "node:test";
import assert from "node:assert/strict";
import { central, CentralError } from "../worker/src/central.ts";
import { mergeTenant } from "../worker/src/merge.ts";
import { buildModel } from "../site/js/model.js";
import { layoutById } from "../site/js/layout.js";

const CORE = "SGLCSC0001";
const STACK_UUID = "9d1e0000-aaaa-4bbb-8ccc-00000000c0de";
const dev = (serial, name, extra = {}) => ({ serial, name, type: "Switch", model: "CX-6300M", deviceFunction: "Access Switch", deployment: "Standalone", ...extra });
const link = (from, to, fp, tp) => ({ from, to, fromPortList: [{ name: fp }], toPortList: [{ name: tp }] });

function tenant(row) {
  const topo = {
    hs: { devices: [dev(CORE, CORE, { deviceFunction: "Core Switch", deployment: "Stack" }), dev("SGHSACC001", "HS-ACC-1")], links: [link(CORE, "SGHSACC001", "1/1/1", "1/1/52")] },
    adm: { devices: [dev("SGADMMDF01", "ADM-MDF"), dev("SGADMIDF01", "ADM-IDF")], links: [link("SGADMMDF01", "SGADMIDF01", "1/1/49", "1/1/49")] },
  };
  const inv = [
    { serialNumber: CORE, stackId: STACK_UUID, deviceName: "LCSC-DC-Stack1" },
    { serialNumber: "SGLCSC0002", stackId: STACK_UUID, deviceName: "LCSC-DC-Stack1" },
    { serialNumber: "SGHSACC001", deviceName: "HS-ACC-1" }, { serialNumber: "SGADMMDF01", deviceName: "ADM-MDF" }, { serialNumber: "SGADMIDF01", deviceName: "ADM-IDF" },
  ];
  const get = async (path) => {
    let m;
    if (path === "/network-monitoring/v1/sites-health") return { items: [{ id: "hs", siteName: "High School" }, { id: "adm", siteName: "Administration" }] };
    if (path === "/network-monitoring/v1/device-inventory") return { items: inv };
    if ((m = path.match(/topology\/([^/]+)$/))) return topo[m[1]];
    if ((m = path.match(/stack\/([^/]+)\/members$/))) return { items: [] };
    if ((m = path.match(/neighbours\/([^/]+)$/))) {
      if (decodeURIComponent(m[1]) === "SGADMMDF01") return { neighbours: [row, { serial: "SGADMIDF01", name: "ADM-IDF", localPort: "1/1/49", toPort: "1/1/49" }] };
      throw new CentralError("no neighbours", 404);
    }
    if ((m = path.match(/switches\/([^/]+)$/))) { const id = decodeURIComponent(m[1]); return { serialNumber: id, deviceName: id === CORE ? "LCSC-DC-Stack1" : null, stackMemberId: id === CORE ? 1 : null }; }
    throw new CentralError(`no route ${path}`, 404);
  };
  return get;
}

async function run(row) {
  const c = central(tenant(row));
  const out = await mergeTenant(c, await c.sites(), async (xs, _n, f) => Promise.all(xs.map(f)), () => {});
  const model = buildModel(out, { coreSerial: CORE });
  return { ...out, model };
}

const up = (links) => links.find((l) => [l.from, l.to].includes("SGADMMDF01") && [l.from, l.to].includes(CORE));

for (const [what, row] of [
  ["a core member serial the inventory ties to the stack", { serial: "SGLCSC0002", name: null, localPort: "1/1/52", toPort: "2/1/40" }],
  ["the core's real deviceName", { serial: "SGUNKNOWN9", name: "LCSC-DC-Stack1", localPort: "1/1/52", toPort: "2/1/40" }],
]) test(`ADM-MDF's LLDP row naming ${what} becomes a real uplink, not inferred`, async () => {
  const { links, lldpRows, model, switches } = await run(row);
  assert.equal(switches.find((s) => s.serial === CORE).name, "LCSC-DC-Stack1");
  const e = up(links);
  assert.ok(e, `uplink found (lldp: ${JSON.stringify(lldpRows)})`);
  assert.equal(e.source, "neighbours");
  for (const s of ["SGADMMDF01", "SGADMIDF01"]) assert.equal(model.byId.get(s).flags.includes("no path to district core"), false, s);
  const lay = layoutById("structured", model);
  const bb = lay.links.find((l) => l.kind === "backbone" && [l.a, l.b].includes("SGADMMDF01"));
  assert.ok(bb?.edge, "structured backbone has a real edge");
});

// Issue 1: a peer link between two buildings used to run the canvas
// perimeter, then drew a dangling stub (CMDLAB t742u: "random lines"). Now it
// draws no line; each end names the far switch ("↔ NAME").
test("cross-building peer links draw no line, only a far-switch label at both ends", async () => {
  const { largeSample } = await import("../site/js/large-sample.js");
  const d = largeSample(), model = buildModel(d, { coreSerial: d.coreSerial });
  const lay = layoutById("structured", model);
  assert.equal(lay.links.filter((l) => l.stub || (l.kind === "peer" && l.cross)).length, 0);
  const far = lay.labels.filter((lb) => lb.kind === "far");
  assert.ok(far.length >= 8, "sample has cross-building peers");
  for (const lb of far) assert.ok(lb.full.length > 0);
});
