import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { topologyFromFixtures } from "./helpers.mjs";
import { buildModel, switchLinks } from "../site/js/model.js";
import { jsonExport, svgBlob } from "../site/js/export.js";
import { renderSvg } from "../site/js/render.js";
import { LAYOUTS, layoutById, modelForNeighborToggle } from "../site/js/layout.js";
import { compactPortNames, formatPortEnd, portsVisible, readShowPorts, writeShowPorts } from "../site/js/ports.js";
import { UI_KEYS, readUiPrefs, writeUiPref } from "../site/js/prefs.js";

const TOKENS = {
  "--diagram-bg": "#fff", "--diagram-fg": "#111", "--diagram-muted": "#667",
  "--node-core": "#b42318", "--node-bcore": "#1f6feb", "--node-access": "#2f9e6e",
  "--node-ext": "#98a2b3", "--node-fill": "#fff", "--edge": "#8b95a7",
  "--edge-inferred": "#c0c6d2", "--warn": "#c77700",
  "--font-sans": "sans-serif", "--font-mono": "monospace",
};

const data = await topologyFromFixtures();
const model = buildModel(data);

function memoryStorage() {
  const map = new Map();
  return {
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
  };
}

function labelsOf(svg) {
  const out = [];
  const re = /<g data-port-end="([^"]+)" data-port-link="([^"]+)">([\s\S]*?)<\/g>/g;
  let m;
  while ((m = re.exec(svg))) {
    const text = m[3].match(/<text[^>]*>([^<]*)<\/text>/);
    const at = m[3].match(/<text x="([^"]+)" y="([^"]+)"/);
    out.push({
      end: m[1], link: m[2], body: m[3], text: text?.[1] ?? "",
      x: at ? Number(at[1]) : NaN, y: at ? Number(at[2]) : NaN,
    });
  }
  return out;
}

function byName(name) {
  return model.nodes.find((n) => n.name === name);
}

test("LAG member ports compact to lag1 (1/1/49-50)", () => {
  assert.equal(compactPortNames(["1/1/50", "1/1/49"]), "1/1/49-50");
  assert.equal(compactPortNames(["1/1/49", "1/1/51"]), "1/1/49, 1/1/51");
  assert.equal(formatPortEnd([
    { name: "1/1/49", lag: "lag1" },
    { name: "1/1/50", lag: "lag1" },
  ]), "lag1 (1/1/49-50)");
  assert.equal(formatPortEnd(undefined, "1/1/11"), "1/1/11");
  const acc = byName("DO-ACC-01");
  const core = byName("DO-CORE-01");
  const edge = model.edges.find((e) => [e.from, e.to].includes(acc.serial) && [e.from, e.to].includes(core.serial));
  const accessLabel = edge.from === acc.serial ? edge.fromLabel : edge.toLabel;
  const coreLabel = edge.from === core.serial ? edge.fromLabel : edge.toLabel;
  assert.equal(accessLabel, "lag1 (1/1/49-50)");
  assert.equal(coreLabel, "lag1 (1/1/15-16)");
  const listed = switchLinks(model, acc.serial).find((l) => l.peer === core.serial);
  assert.equal(listed.local, "lag1 (1/1/49-50)");
  assert.equal(listed.remote, "lag1 (1/1/15-16)");
  assert.equal(switchLinks(model, core.serial).some((l) => l.peerName === "DO-FW-01"), false);
});

test("port labels sit on both ends of a switch link and not on AP or neighbor chips", () => {
  const lay = layoutById("hub", model);
  const svg = renderSvg(model, lay, { tokens: TOKENS, mgmt: "monitor", title: "Switch topology", subtitle: "ports" });
  const labels = labelsOf(svg);
  const acc = byName("DO-ACC-02");
  const core = byName("DO-CORE-01");
  const edge = model.edges.find((e) => !e.external && [e.from, e.to].includes(acc.serial) && [e.from, e.to].includes(core.serial));
  const link = [edge.from, edge.to].sort().join("|");
  const ends = labels.filter((l) => l.link === link);
  assert.equal(ends.length, 2);
  const from = ends.find((l) => l.end === edge.from);
  const to = ends.find((l) => l.end === edge.to);
  assert.equal(from.text, edge.fromLabel);
  assert.equal(to.text, edge.toLabel);
  assert.match(from.body, /<rect /);
  assert.match(to.body, /font-size="10"/);
  const a = lay.pos.get(edge.from);
  const b = lay.pos.get(edge.to);
  assert.ok(Math.hypot(from.x - a.x, from.y - a.y) < Math.hypot(from.x - b.x, from.y - b.y));
  assert.ok(Math.hypot(to.x - b.x, to.y - b.y) < Math.hypot(to.x - a.x, to.y - a.y));

  const ext = new Set(model.externals.map((d) => d.serial));
  for (const l of labels) {
    const [u, v] = l.link.split("|");
    assert.equal(ext.has(l.end) || ext.has(u) || ext.has(v), false, l.text);
  }
  const collapsed = renderSvg(model, lay, { tokens: TOKENS, mgmt: "monitor", title: "t", subtitle: "s", collapseAps: true });
  for (const l of labelsOf(collapsed)) {
    const [u, v] = l.link.split("|");
    assert.equal(ext.has(u) || ext.has(v), false);
  }
  assert.match(collapsed, /data-chip=/);
  assert.equal(collapsed.includes(`data-port-end="${model.externals[0].serial}"`), false);
});

test("show ports defaults on, persists, and labels drop below a readable size", () => {
  const empty = memoryStorage();
  assert.equal(readShowPorts(empty), true);
  assert.equal(portsVisible({}), true);
  assert.equal(portsVisible({ showPorts: false }), false);
  assert.equal(portsVisible({ portScale: 1 }), true);
  assert.equal(portsVisible({ portScale: 0.99 }), false);

  const storage = memoryStorage();
  writeShowPorts(storage, false);
  assert.equal(readShowPorts(storage), false);
  writeShowPorts(storage, true);
  assert.equal(readShowPorts(storage), true);
  storage.setItem("ct-ports", "{");
  assert.equal(readShowPorts(storage), true);

  const html = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
  const header = html.slice(html.indexOf("<header>"), html.indexOf("</header>"));
  assert.match(header, /Show ports/);
  assert.match(header, /id="portsToggle"/);
  assert.match(header, /type="checkbox"/);
  assert.match(header, /\bchecked\b/);
  const app = readFileSync(new URL("../site/js/app.js", import.meta.url), "utf8");
  const prefs = readFileSync(new URL("../site/js/prefs.js", import.meta.url), "utf8");
  assert.match(prefs, /ct-ports/);
  assert.equal(UI_KEYS.showPorts, "ct-ports");
  assert.equal(readUiPrefs(empty).showPorts, true);
  writeUiPref(storage, "showPorts", false);
  assert.equal(readUiPrefs(storage).showPorts, false);
  assert.equal(readShowPorts(storage), false);
  assert.match(app, /portsToggle/);
  assert.match(app, /writeUiPref\(localStorage, "showPorts"/);
  assert.match(app, /diagramModel\(\)/);
  assert.match(app, /modelForNeighborToggle/);

  const lay = layoutById("tree-lr", model);
  const opts = { tokens: TOKENS, mgmt: "monitor", title: "Switch topology", subtitle: "zoom" };
  const shown = renderSvg(model, lay, { ...opts, portScale: 1 });
  const hidden = renderSvg(model, lay, { ...opts, portScale: 0.5 });
  const off = renderSvg(model, lay, { ...opts, showPorts: false });
  assert.match(shown, /data-port-end=/);
  assert.equal(hidden.includes("data-port-end"), false);
  assert.equal(off.includes("data-port-end"), false);
});

test("hiding access neighbors keeps port labels on the remaining switch links", () => {
  const view = modelForNeighborToggle(model, false);
  assert.ok(view.externals.length < model.externals.length);
  assert.equal(view.edges.filter((e) => !e.external).length, model.edges.filter((e) => !e.external).length);
  const lay = layoutById("hub", view);
  const svg = renderSvg(view, lay, {
    tokens: TOKENS, mgmt: "monitor", title: "Switch topology", subtitle: "neighbors off", collapseAps: true,
  });
  assert.match(svg, /lag1 \(1\/1\/49-50\)/);
  assert.doesNotMatch(svg, /data-chip/);
  const labels = labelsOf(svg);
  assert.ok(labels.length >= 2);
  const ext = new Set(model.externals.map((d) => d.serial));
  for (const l of labels) {
    const [u, v] = l.link.split("|");
    assert.equal(ext.has(l.end) || ext.has(u) || ext.has(v), false);
  }
  const ap = model.externals.find((d) => d.name === "WHS-AP-114");
  assert.equal(view.externals.some((d) => d.serial === ap.serial), false);
  assert.equal(svg.includes(ap.name), false);
  const acc = byName("DO-ACC-02");
  const core = byName("DO-CORE-01");
  const edge = view.edges.find((e) => !e.external && [e.from, e.to].includes(acc.serial) && [e.from, e.to].includes(core.serial));
  const link = [edge.from, edge.to].sort().join("|");
  const ends = labels.filter((l) => l.link === link);
  assert.equal(ends.length, 2);
  assert.equal(ends.find((l) => l.end === edge.from).text, edge.fromLabel);
  assert.equal(ends.find((l) => l.end === edge.to).text, edge.toLabel);
});

test("every layout and the SVG export include port labels", async () => {
  const opts = { tokens: TOKENS, mgmt: "monitor", title: "Switch topology", subtitle: "export" };
  for (const spec of LAYOUTS) {
    const lay = layoutById(spec.id, model);
    const svg = renderSvg(model, lay, { ...opts, subtitle: spec.label });
    assert.match(svg, /lag1 \(1\/1\/49-50\)/, spec.id);
    assert.match(svg, /data-port-end=/, spec.id);
    const ext = new Set(model.externals.map((d) => d.serial));
    for (const l of labelsOf(svg)) assert.equal(ext.has(l.end), false, spec.id);
  }
  const lay = layoutById("hub", model);
  const svg = renderSvg(model, lay, opts);
  const text = await svgBlob(svg).text();
  assert.match(text, /lag1 \(1\/1\/49-50\)/);
  assert.match(text, /<rect [^>]*fill="#fff"/);
  const body = jsonExport(model, "monitor", { coreSerial: null, switches: {} }, { mock: true, generatedAt: data.generatedAt, layout: "hub", positions: {} });
  assert.ok(body.links.some((l) => l.fromLabel === "lag1 (1/1/49-50)" || l.toLabel === "lag1 (1/1/49-50)"));
});
