import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildModel } from "../site/js/model.js";
import { largeSample } from "../site/js/large-sample.js";
import { renderSvg } from "../site/js/render.js";
import {
  LAYOUTS, accessChipBoxes, accessOnlyNeighborIds, layoutById, modelForNeighborToggle,
} from "../site/js/layout.js";
import { UI_KEYS, readUiPrefs, writeUiPref } from "../site/js/prefs.js";

const TOKENS = {
  "--diagram-bg": "#fff", "--diagram-fg": "#111", "--diagram-muted": "#667",
  "--node-core": "#b42318", "--node-bcore": "#1f6feb", "--node-access": "#2f9e6e",
  "--node-ext": "#98a2b3", "--node-fill": "#fff", "--edge": "#8b95a7",
  "--edge-inferred": "#c0c6d2", "--warn": "#c77700",
  "--font-sans": "sans-serif", "--font-mono": "monospace",
};

function memoryStorage() {
  const map = new Map();
  return {
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
  };
}

function nameOf(model, id) {
  return model.externals.find((d) => d.serial === id)?.name ?? id;
}

function localOf(model, edge) {
  if (model.byId.has(edge.from)) return edge.from;
  if (model.byId.has(edge.to)) return edge.to;
  return null;
}

function otherOf(edge, local) {
  return local === edge.from ? edge.to : edge.from;
}

function edgeDrawn(svg, a, b) {
  if (!a || !b) return false;
  const line = `x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"`;
  const rev = `x1="${b.x}" y1="${b.y}" x2="${a.x}" y2="${a.y}"`;
  return svg.includes(line) || svg.includes(rev) || svg.includes(`M ${a.x} ${a.y}`) || svg.includes(`M ${b.x} ${b.y}`);
}

function synthetic() {
  const data = {
    switches: [
      { serial: "c1", name: "Core", site: "Site A" },
      { serial: "b1", name: "Bldg", site: "Site B" },
      { serial: "a1", name: "Access", site: "Site B" },
    ],
    externals: [
      { serial: "ap1", name: "AP-1", type: "Access Point" },
      { serial: "ph1", name: "Phone-1", type: "Phone" },
      { serial: "fw1", name: "FW-1", type: "Firewall" },
    ],
    links: [
      { from: "c1", to: "b1", fromPort: "1", toPort: "1", source: "topology" },
      { from: "b1", to: "a1", fromPort: "2", toPort: "1", source: "topology" },
      { from: "a1", to: "ap1", fromPort: "3", toPort: "eth0", source: "neighbours" },
      { from: "b1", to: "ph1", fromPort: "4", toPort: "eth0", source: "neighbours" },
      { from: "c1", to: "fw1", fromPort: "5", toPort: "eth0", source: "neighbours" },
      { from: "a1", to: "fw1", fromPort: "6", toPort: "eth1", source: "neighbours" },
    ],
  };
  return buildModel(data, { coreSerial: "c1" });
}

test("show access neighbors defaults on and round-trips with the other UI prefs", () => {
  const empty = memoryStorage();
  const fresh = readUiPrefs(empty);
  assert.equal(fresh.showAccessNeighbors, true);
  assert.equal(fresh.layout, "hub");

  const storage = memoryStorage();
  writeUiPref(storage, "layout", "sites");
  writeUiPref(storage, "theme", "dark");
  writeUiPref(storage, "mgmt", "monitor");
  writeUiPref(storage, "showAccessNeighbors", false);
  const again = readUiPrefs(storage);
  assert.equal(again.layout, "sites");
  assert.equal(again.theme, "dark");
  assert.equal(again.mgmt, "monitor");
  assert.equal(again.showAccessNeighbors, false);
  assert.equal(storage.getItem(UI_KEYS.layout), JSON.stringify("sites"));
  assert.equal(storage.getItem(UI_KEYS.theme), JSON.stringify("dark"));
  assert.equal(storage.getItem(UI_KEYS.showAccessNeighbors), "false");
  writeUiPref(storage, "showAccessNeighbors", true);
  assert.equal(readUiPrefs(storage).showAccessNeighbors, true);
  storage.setItem(UI_KEYS.showAccessNeighbors, "{");
  assert.equal(readUiPrefs(storage).showAccessNeighbors, true);

  const html = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
  const header = html.slice(html.indexOf("<header>"), html.indexOf("</header>"));
  assert.match(header, /Show access neighbors/);
  assert.match(header, /id="showAccessNeighbors"/);
  assert.match(header, /type="checkbox"/);
  assert.match(header, /\bchecked\b/);

  const app = readFileSync(new URL("../site/js/app.js", import.meta.url), "utf8");
  assert.match(app, /readUiPrefs\(localStorage\)/);
  assert.match(app, /writeUiPref\(localStorage, "showAccessNeighbors"/);
  assert.match(app, /diagramModel\(\)/);
});

test("hiding access neighbors keeps core, building-core, and switch links", () => {
  const model = synthetic();
  assert.equal(model.byId.get("c1").role, "district-core");
  assert.equal(model.byId.get("b1").role, "building-core");
  assert.equal(model.byId.get("a1").role, "access");
  assert.equal(modelForNeighborToggle(model, true), model);

  const view = modelForNeighborToggle(model, false);
  assert.equal(view.nodes.length, model.nodes.length);
  assert.equal(view.edges.filter((e) => !e.external).length, model.edges.filter((e) => !e.external).length);
  assert.equal(view.externals.some((d) => d.serial === "ap1"), false);
  assert.equal(view.edges.some((e) => e.from === "ap1" || e.to === "ap1"), false);
  assert.equal(view.externals.some((d) => d.serial === "ph1"), true);
  assert.equal(view.externals.some((d) => d.serial === "fw1"), true);
  assert.equal(view.edges.some((e) => e.from === "b1" && e.to === "ph1"), true);
  assert.equal(view.edges.some((e) => e.from === "c1" && e.to === "fw1"), true);
  assert.equal(view.edges.some((e) => (e.from === "c1" && e.to === "b1") || (e.from === "b1" && e.to === "a1")), true);
  assert.deepEqual([...accessOnlyNeighborIds(view)], []);
});

test("hub and grouped-by-site layouts are placed again without access neighbors", () => {
  const sample = largeSample();
  const model = buildModel(sample, { coreSerial: sample.coreSerial });
  const hiddenIds = [...accessOnlyNeighborIds(model)];
  assert.ok(hiddenIds.length >= 10);
  const view = modelForNeighborToggle(model, false);
  assert.ok(view.externals.length < model.externals.length);
  assert.equal(view.nodes.length, model.nodes.length);
  assert.equal(view.edges.filter((e) => !e.external).length, model.edges.filter((e) => !e.external).length);

  let coreId = null;
  let bcoreId = null;
  for (const e of model.edges) {
    if (!e.external) continue;
    const local = localOf(model, e);
    if (!local) continue;
    const role = model.byId.get(local).role;
    const other = otherOf(e, local);
    if (role === "district-core" && !coreId) coreId = other;
    if (role === "building-core" && !bcoreId) bcoreId = other;
  }
  assert.ok(coreId);
  assert.ok(bcoreId);
  assert.equal(hiddenIds.includes(coreId), false);
  assert.equal(hiddenIds.includes(bcoreId), false);
  const accessId = hiddenIds[0];
  const accessName = nameOf(model, accessId);
  const coreName = nameOf(model, coreId);
  const bcoreName = nameOf(model, bcoreId);

  const opts = { tokens: TOKENS, mgmt: "monitor", title: "Switch topology", subtitle: "neighbors" };
  for (const id of ["hub", "sites"]) {
    const full = layoutById(id, model);
    const hid = layoutById(id, view);
    assert.equal(hid.pos.size, model.nodes.length, id);
    for (const dropped of hiddenIds) assert.equal(hid.extPos.has(dropped), false, `${id} still places ${dropped}`);
    assert.ok(full.extPos.has(accessId), `${id} places access neighbors when the toggle is on`);
    assert.ok(hid.extPos.has(coreId), id);
    assert.ok(hid.extPos.has(bcoreId), id);

    if (id === "hub") {
      let moved = false;
      for (const n of model.nodes) {
        const a = full.pos.get(n.serial);
        const b = hid.pos.get(n.serial);
        if (a.x !== b.x || a.y !== b.y) moved = true;
      }
      assert.equal(moved, true, "hub is placed again without access neighbors");
      assert.ok(hid.bounds.w * hid.bounds.h < full.bounds.w * full.bounds.h);
    } else {
      const height = (lay) => (lay.sectors ?? []).reduce((sum, s) => sum + (s.box?.h ?? 0), 0);
      assert.ok(height(hid) < height(full), "site boxes are shorter without access neighbors");
      assert.ok(hid.bounds.h < full.bounds.h || hid.bounds.w < full.bounds.w);
    }

    assert.ok(accessChipBoxes(model, full).length > 0, id);
    assert.equal(accessChipBoxes(view, hid).length, 0, id);
    const shown = renderSvg(model, full, { ...opts, collapseAps: true, subtitle: id });
    assert.match(shown, /\+\d+ AP/, `${id} still chips access neighbors when shown`);
    const svg = renderSvg(view, hid, { ...opts, collapseAps: true, subtitle: id });
    assert.equal(svg.includes(accessName), false, `${id} still draws ${accessName}`);
    assert.doesNotMatch(svg, /data-chip/);
    assert.doesNotMatch(svg, /\+\d+ AP/);
    assert.ok(svg.includes(coreName), `${id} dropped ${coreName}`);
    assert.ok(svg.includes(bcoreName), `${id} dropped ${bcoreName}`);
    assert.equal(edgeDrawn(svg, hid.pos.get(model.coreSerial), hid.extPos.get(coreId)), true, `${id} core link`);
    const bcoreEdge = view.edges.find((e) => e.external && (e.from === bcoreId || e.to === bcoreId));
    const bcoreLocal = localOf(view, bcoreEdge);
    assert.equal(edgeDrawn(svg, hid.pos.get(bcoreLocal), hid.extPos.get(bcoreId)), true, `${id} building-core link`);
    const sw = view.edges.find((e) => !e.external && hid.pos.has(e.from) && hid.pos.has(e.to));
    assert.ok(sw, id);
    assert.equal(edgeDrawn(svg, hid.pos.get(sw.from), hid.pos.get(sw.to)), true, `${id} switch link`);
    for (const n of model.nodes) assert.ok(svg.includes(n.name), `${id} ${n.name}`);
  }

  for (const spec of LAYOUTS) {
    const hid = layoutById(spec.id, view);
    for (const dropped of hiddenIds) assert.equal(hid.extPos.has(dropped), false, spec.id);
    assert.ok(hid.extPos.has(coreId), spec.id);
    const sw = view.edges.filter((e) => !e.external);
    assert.ok(sw.every((e) => hid.pos.has(e.from) && hid.pos.has(e.to)), spec.id);
  }
});
