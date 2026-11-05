// Browser-side switch rename (overrides.switches[serial].name) and the
// Worker's fallback when Central's topology name is only a serial.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { topologyFromFixtures } from "./helpers.mjs";
import { buildModel, cleanName, parseOverrides, switchLinks, withSwitchName } from "../site/js/model.js";
import { LAYOUTS, layoutById } from "../site/js/layout.js";
import { renderSvg } from "../site/js/render.js";
import { jsonExport } from "../site/js/export.js";
import { central } from "../worker/src/central.ts";
import { mergeTenant, pickName, serialLikeName } from "../worker/src/merge.ts";

const TOKENS = {
  "--diagram-bg": "#fff", "--diagram-fg": "#111", "--diagram-muted": "#667",
  "--node-core": "#b42318", "--node-bcore": "#1f6feb", "--node-access": "#2f9e6e",
  "--node-ext": "#98a2b3", "--node-fill": "#fff", "--edge": "#8b95a7",
  "--edge-inferred": "#c0c6d2", "--warn": "#c77700", "--link-stack": "#000",
  "--font-sans": "sans-serif", "--font-mono": "monospace",
};
const NEW = "Pine MDF (renamed)";

async function renamedModel() {
  const data = await topologyFromFixtures();
  const plain = buildModel(data, {});
  const target = plain.nodes.find((n) => !n.stack && n.degree > 0);
  const overrides = withSwitchName({ coreSerial: null, switches: {} }, target.serial, `  ${NEW} `, target.name);
  return { data, plain, target, overrides, model: buildModel(data, overrides) };
}

test("a rename replaces the name in the model, keeps Central's name, and moves no switch", async () => {
  const { plain, target, overrides, model } = await renamedModel();
  assert.deepEqual(overrides.switches[target.serial], { name: NEW });
  const n = model.byId.get(target.serial);
  assert.equal(n.name, NEW);
  assert.equal(n.centralName, target.name);
  assert.equal(n.nameSource, "override");
  assert.equal(model.nodes.filter((x) => x.nameSource === "override").length, 1);
  for (const x of plain.nodes) {
    const y = model.byId.get(x.serial);
    assert.deepEqual([y.role, y.building, y.hop, y.parent], [x.role, x.building, x.hop, x.parent], x.serial);
  }
  assert.equal(model.coreSerial, plain.coreSerial);
  const peer = switchLinks(model, target.serial)[0].peer;
  assert.ok(switchLinks(model, peer).some((l) => l.peer === target.serial && l.peerName === NEW), "link lists use the new name");
});

test("every layout's SVG (and so the PNG) draws the new name and not the old one", async () => {
  const { target, model } = await renamedModel();
  for (const { id } of LAYOUTS) {
    const svg = renderSvg(model, layoutById(id, model), { tokens: TOKENS, mgmt: "monitor", title: "t", subtitle: id });
    assert.ok(svg.includes("Pine MDF (renamed)"), `${id} draws the new name`);
    assert.equal(svg.includes(target.name), false, `${id} still shows ${target.name}`);
  }
  const app = readFileSync(new URL("../site/js/app.js", import.meta.url), "utf8");
  assert.match(app, /pngBlob\(state\.svg\)/, "PNG is rasterized from the same SVG string");
});

test("JSON export carries the new name, Central's name, and the rename in overrides", async () => {
  const { target, overrides, model } = await renamedModel();
  const out = jsonExport(model, "monitor", overrides, { mock: true });
  const sw = out.switches.find((s) => s.serial === target.serial);
  assert.deepEqual([sw.name, sw.centralName, sw.nameSource], [NEW, target.name, "override"]);
  const other = out.switches.find((s) => s.serial !== target.serial);
  assert.deepEqual([other.name, other.centralName, other.nameSource], [other.name, other.name, "central"]);
  assert.equal(out.overrides.switches[target.serial].name, NEW);
});

test("overrides export and import round-trip a rename; bad names are cleaned or dropped", () => {
  const exported = JSON.stringify({ coreSerial: "X", switches: { A: { role: "access", name: "MDF\u0007  Stack\n1" }, B: { name: "   " }, C: { name: 42 } } });
  const o = parseOverrides(exported);
  assert.deepEqual(o.switches, { A: { role: "access", name: "MDF Stack 1" } });
  assert.deepEqual(parseOverrides(JSON.stringify(o)).switches, o.switches);
  assert.equal(cleanName("x".repeat(80)).length, 64);
  assert.equal(cleanName(null), null);
});

test("reset: a blank name or Central's own name clears the rename and keeps other overrides", () => {
  let o = { coreSerial: "C", switches: { A: { role: "access" } } };
  o = withSwitchName(o, "A", "New A", "SW-A");
  assert.deepEqual(o.switches.A, { role: "access", name: "New A" });
  assert.deepEqual(withSwitchName(o, "A", "", "SW-A").switches.A, { role: "access" });
  assert.deepEqual(withSwitchName(o, "A", "SW-A", "SW-A").switches.A, { role: "access" });
  const only = withSwitchName({ coreSerial: null, switches: {} }, "B", "New B", "SW-B");
  assert.deepEqual(withSwitchName(only, "B", "", "SW-B").switches, {});
  assert.equal(o.coreSerial, "C");
});

test("the sidebar card has a name field and a reset, wired to localStorage overrides only", () => {
  const app = readFileSync(new URL("../site/js/app.js", import.meta.url), "utf8");
  assert.match(app, /<input type="text" data-k="name"[^>]*value="\$\{esc\(n\.name\)\}"/);
  assert.match(app, /data-act="reset-name"/);
  const fn = app.slice(app.indexOf("function setSwitchName"), app.indexOf("}", app.indexOf("function setSwitchName")) + 1);
  assert.match(fn, /withSwitchName\(state\.overrides/);
  assert.match(fn, /persist\(\)/);
  assert.doesNotMatch(fn, /fetch|api\(|POST|PUT|PATCH/);
  assert.match(app, /function persist\(\) \{ save\(KEYS\.overrides, state\.overrides\); draw\(\); \}/);
});

test("serialLikeName: only blank, stack ids, and serials the tenant knows count", () => {
  const known = new Set(["SG3AKMY3JW"]);
  assert.equal(serialLikeName("", []), true);
  assert.equal(serialLikeName("43b58f0a-475b-4807-a118-f44a4ca3125e"), true);
  assert.equal(serialLikeName("SG3AKMY3JW", [], known), true);
  assert.equal(serialLikeName("G-SG3AKMY3JW", [], known), true);
  assert.equal(serialLikeName("sw-a", ["SW-A"]), true);
  assert.equal(serialLikeName("HSCORE6300", [], known), false, "a hostname that only looks like a serial is kept");
  assert.equal(serialLikeName("PW-MDF-STACK", [], known), false);
  assert.deepEqual(pickName("SG3AKMY3JW", [], [["switch-detail", "SG3AKMY3JW"], ["inventory", "PW-MDF"]], known), { name: "PW-MDF", nameFrom: "inventory" });
  assert.deepEqual(pickName("HS-CORE", [], [["switch-detail", "Other"]], known), { name: "HS-CORE", nameFrom: "topology" });
  assert.deepEqual(pickName("SG3AKMY3JW", [], [["switch-detail", null]], known), { name: "SG3AKMY3JW", nameFrom: "topology" });
});

// A tenant where topology names a stack by a member serial.
function tenant({ detailName = null, inventoryName = null } = {}) {
  const STACK = "43b58f0a-475b-4807-a118-f44a4ca3125e";
  const dev = (serial, name, extra = {}) => ({ serial, name, type: "Switch", model: "6300M", deviceFunction: "Access Switch", deployment: "Stack", ...extra });
  const topo = { devices: [dev(STACK, "SG3AKMY3JW"), dev("SGHSCORE01", "HSCORE6300", { deployment: "Standalone" })],
    links: [{ from: STACK, to: "SGHSCORE01", fromPortList: [{ name: "1/1/49" }], toPortList: [{ name: "1/1/1" }] }] };
  const get = async (path) => {
    if (path.endsWith("/sites-health")) return { items: [{ id: "s1", siteName: "Perry Worth" }], total: 1 };
    if (path.endsWith("/device-inventory")) return { items: [
      { serialNumber: "SG3AKMY3JW", deviceName: inventoryName, stackId: STACK, deviceGroupName: "Access" },
      { serialNumber: "SGHSCORE01", deviceName: "HSCORE6300" },
    ], next: null };
    if (path.endsWith("/topology/s1")) return topo;
    if (path.endsWith(`/switches/${STACK}`)) return { siteId: "s1", siteName: "Perry Worth", serialNumber: "SG3AKMY3JW", deviceName: detailName };
    if (path.endsWith("/switches/SGHSCORE01")) return { siteId: "s1", siteName: "Perry Worth", serialNumber: "SGHSCORE01", deviceName: "Aruba-6300M" };
    return { neighbours: [] };
  };
  return { STACK, c: central(get) };
}
const pool = async (xs, _n, f) => Promise.all(xs.map(f));
async function merged(opts) {
  const { STACK, c } = tenant(opts);
  const { switches } = await mergeTenant(c, await c.sites(), pool, () => {});
  return { stack: switches.find((s) => s.serial === STACK), core: switches.find((s) => s.serial === "SGHSCORE01") };
}

test("Worker: a stack named by its member serial takes switch detail deviceName", async () => {
  const { stack, core } = await merged({ detailName: "PW-MDF-STACK", inventoryName: "PW-INV" });
  assert.deepEqual([stack.name, stack.nameFrom], ["PW-MDF-STACK", "switch-detail"]);
  assert.deepEqual([core.name, core.nameFrom], ["HSCORE6300", "topology"], "a real hostname is never replaced by a default");
});

test("Worker: without a detail name, the inventory deviceName for the member or stackId is used", async () => {
  const { stack } = await merged({ detailName: "SG3AKMY3JW", inventoryName: "PW-MDF-INV" });
  assert.deepEqual([stack.name, stack.nameFrom], ["PW-MDF-INV", "inventory"]);
});

test("Worker: with no better field, the topology name stays and the user can rename it", async () => {
  const { stack } = await merged({});
  assert.deepEqual([stack.name, stack.nameFrom], ["SG3AKMY3JW", "topology"]);
});
