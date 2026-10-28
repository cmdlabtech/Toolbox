import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildModel, isLldpOnlySwitch } from "../site/js/model.js";
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
    removeItem(k) { map.delete(k); },
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

test("LLDP neighbors default off, and a saved choice round-trips", () => {
  const empty = memoryStorage();
  const fresh = readUiPrefs(empty);
  assert.equal(fresh.showLldpNeighbors, false);
  assert.equal(fresh.layout, "hub");

  const storage = memoryStorage();
  writeUiPref(storage, "layout", "sites");
  writeUiPref(storage, "theme", "dark");
  writeUiPref(storage, "mgmt", "monitor");
  writeUiPref(storage, "showLldpNeighbors", true);
  const again = readUiPrefs(storage);
  assert.equal(again.layout, "sites");
  assert.equal(again.theme, "dark");
  assert.equal(again.mgmt, "monitor");
  assert.equal(again.showLldpNeighbors, true);
  assert.equal(storage.getItem(UI_KEYS.layout), JSON.stringify("sites"));
  assert.equal(storage.getItem(UI_KEYS.theme), JSON.stringify("dark"));
  assert.equal(storage.getItem(UI_KEYS.showLldpNeighbors), "true");
  writeUiPref(storage, "showLldpNeighbors", false);
  assert.equal(readUiPrefs(storage).showLldpNeighbors, false);
  storage.setItem(UI_KEYS.showLldpNeighbors, "{");
  assert.equal(readUiPrefs(storage).showLldpNeighbors, false);

  const html = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
  const header = html.slice(html.indexOf("<header>"), html.indexOf("</header>"));
  assert.match(header, /Show LLDP neighbors/);
  assert.doesNotMatch(header, /Show access neighbors/);
  assert.match(header, /id="showLldpNeighbors"/);
  assert.match(header, /type="checkbox"/);
  assert.doesNotMatch(header, /id="showLldpNeighbors"[^>]*\bchecked\b/);

  const app = readFileSync(new URL("../site/js/app.js", import.meta.url), "utf8");
  assert.match(app, /readUiPrefs\(localStorage\)/);
  assert.match(app, /writeUiPref\(localStorage, "showLldpNeighbors"/);
  assert.match(app, /diagramModel\(\)/);
});

test("the old LLDP preference key migrates and an empty store stays hidden", () => {
  const off = memoryStorage();
  off.setItem("ct-show-access-neighbors", "false");
  assert.equal(readUiPrefs(off).showLldpNeighbors, false);
  assert.equal(off.getItem(UI_KEYS.showLldpNeighbors), "false");
  assert.equal(off.getItem("ct-show-access-neighbors"), null);

  const on = memoryStorage();
  on.setItem("ct-show-access-neighbors", "true");
  assert.equal(readUiPrefs(on).showLldpNeighbors, true);
  assert.equal(on.getItem("ct-show-access-neighbors"), null);

  const current = memoryStorage();
  current.setItem(UI_KEYS.showLldpNeighbors, "false");
  current.setItem("ct-show-access-neighbors", "true");
  assert.equal(readUiPrefs(current).showLldpNeighbors, false);
  assert.equal(current.getItem("ct-show-access-neighbors"), null);

  const junk = memoryStorage();
  junk.setItem("ct-show-access-neighbors", "{");
  assert.equal(readUiPrefs(junk).showLldpNeighbors, false);
});

test("hiding LLDP neighbors drops core, distribution, and access neighbors and keeps switch links", () => {
  const model = synthetic();
  assert.equal(model.byId.get("c1").role, "district-core");
  assert.equal(model.byId.get("b1").role, "building-core");
  assert.equal(model.byId.get("a1").role, "access");
  assert.equal(modelForNeighborToggle(model, true), model);

  const view = modelForNeighborToggle(model, false);
  assert.equal(view.nodes.length, model.nodes.length);
  assert.equal(view.externals.length, 0);
  assert.equal(view.edges.some((e) => e.external), false);
  assert.equal(view.edges.filter((e) => e.from === "c1" && e.to === "b1" || e.from === "b1" && e.to === "a1").length, 2);
  for (const id of ["ap1", "ph1", "fw1"]) {
    assert.equal(view.externals.some((d) => d.serial === id), false);
    assert.equal(view.edges.some((e) => e.from === id || e.to === id), false);
  }
  assert.deepEqual([...accessOnlyNeighborIds(view)], []);
});

test("hub, grouped-by-site, and grouped-by-group layouts are placed again without LLDP neighbors", () => {
  const sample = largeSample();
  const model = buildModel(sample, { coreSerial: sample.coreSerial });
  const hiddenIds = model.externals.map((d) => d.serial);
  assert.ok(hiddenIds.length >= 10);
  const view = modelForNeighborToggle(model, false);
  assert.equal(view.externals.length, 0);
  assert.equal(view.nodes.length, model.nodes.length);
  assert.equal(view.edges.some((e) => e.external), false);
  assert.equal(view.edges.length, model.edges.filter((e) => !e.external).length);
  assert.equal(new Set(view.nodes.map((n) => n.serial)).size, view.nodes.length);

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
  const accessId = [...accessOnlyNeighborIds(model)][0];
  const accessName = nameOf(model, accessId);
  const coreName = nameOf(model, coreId);
  const bcoreName = nameOf(model, bcoreId);

  const opts = { tokens: TOKENS, mgmt: "monitor", title: "Switch topology", subtitle: "neighbors" };
  for (const id of ["hub", "sites", "groups"]) {
    const full = layoutById(id, model);
    const hid = layoutById(id, view);
    assert.equal(hid.pos.size, model.nodes.length, id);
    for (const dropped of hiddenIds) assert.equal(hid.extPos.has(dropped), false, `${id} still places ${dropped}`);
    assert.ok(full.extPos.has(accessId), `${id} places access neighbors when the toggle is on`);
    assert.ok(full.extPos.has(coreId), id);
    assert.equal(hid.extPos.has(coreId), false, id);
    assert.equal(hid.extPos.has(bcoreId), false, id);

    if (id === "hub") {
      let moved = false;
      for (const n of model.nodes) {
        const a = full.pos.get(n.serial);
        const b = hid.pos.get(n.serial);
        if (a.x !== b.x || a.y !== b.y) moved = true;
      }
      assert.equal(moved, true, "hub is placed again without LLDP neighbors");
      assert.ok(hid.bounds.w * hid.bounds.h < full.bounds.w * full.bounds.h);
    } else {
      const height = (lay) => (lay.sectors ?? []).reduce((sum, s) => sum + (s.box?.h ?? 0), 0);
      assert.ok(height(hid) < height(full), "boxes are shorter without LLDP neighbors");
      assert.ok(hid.bounds.h < full.bounds.h || hid.bounds.w < full.bounds.w);
    }

    assert.ok(accessChipBoxes(model, full).length > 0, id);
    assert.equal(accessChipBoxes(view, hid).length, 0, id);
    const shown = renderSvg(model, full, { ...opts, collapseAps: true, subtitle: id });
    assert.match(shown, /\+\d+ AP/, `${id} still chips access neighbors when shown`);
    const svg = renderSvg(view, hid, { ...opts, collapseAps: true, subtitle: id });
    assert.equal(svg.includes(accessName), false, `${id} still draws ${accessName}`);
    assert.equal(svg.includes(coreName), false, `${id} still draws ${coreName}`);
    assert.equal(svg.includes(bcoreName), false, `${id} still draws ${bcoreName}`);
    assert.doesNotMatch(svg, /data-chip/);
    assert.doesNotMatch(svg, /\+\d+ AP/);
    assert.equal(edgeDrawn(svg, hid.pos.get(model.coreSerial), hid.extPos.get(coreId)), false, `${id} core link`);
    const sw = view.edges.find((e) => hid.pos.has(e.from) && hid.pos.has(e.to));
    assert.ok(sw, id);
    assert.equal(edgeDrawn(svg, hid.pos.get(sw.from), hid.pos.get(sw.to)), true, `${id} switch link`);
    for (const n of model.nodes) assert.ok(svg.includes(n.name), `${id} ${n.name}`);
  }

  for (const spec of LAYOUTS) {
    const hid = layoutById(spec.id, view);
    for (const dropped of hiddenIds) assert.equal(hid.extPos.has(dropped), false, spec.id);
    assert.equal(hid.extPos.has(coreId), false, spec.id);
    const sw = view.edges.filter((e) => !e.external);
    assert.ok(sw.every((e) => hid.pos.has(e.from) && hid.pos.has(e.to)), spec.id);
    assert.equal(hid.pos.size, view.nodes.length, spec.id);
  }
});

function managed(serial, name, site, group) {
  return {
    serial, name, site, group: group ?? null, type: "Switch",
    model: "Aruba 6200", deviceFunction: name.includes("DIST") ? "Aggregation Switch" : name === "CORE-01" ? "Core Switch" : "Access Switch",
    ipv4: "10.1.0.1", vlans: [{ id: "99", name: "MGMT", ipv4: "10.99.0.1" }], central: true, status: "ONLINE",
  };
}

test("fallback LLDP cards hide, Central switches and every site stay, with no duplicate or orphan links", () => {
  const fallback = {
    serial: "CNFALLBACK1", name: "CNFALLBACK1", site: "Building B", group: null, type: "Switch",
    model: null, deviceFunction: null, ipv4: "10.8.0.8", central: false, status: "ONLINE",
  };
  assert.equal(isLldpOnlySwitch(fallback), true);
  assert.equal(isLldpOnlySwitch(managed("c1", "CORE-01", "Building A", "Group 1")), false);
  const data = {
    switches: [
      managed("c1", "CORE-01", "Building A", "Group 1"),
      managed("a1", "BLDG-A-SW-01", "Building A", "Group 1"),
      managed("d1", "BLDG-B-DIST-01", "Building B", "Group 2"),
      managed("b1", "BLDG-B-SW-01", "Building B", null),
      managed("a1", "BLDG-A-SW-01", "Building A", "Group 1"),
      fallback,
    ],
    externals: [
      { serial: "ap-core", name: "AP-CORE-1", type: "Access Point" },
      { serial: "ph-dist", name: "PH-DIST-1", type: "Phone" },
      { serial: "cam-sw", name: "CAM-SW-1", type: "Camera" },
    ],
    links: [
      { from: "c1", to: "a1", fromPort: "1/1/1", toPort: "1/1/49", source: "topology" },
      { from: "c1", to: "d1", fromPort: "1/1/2", toPort: "1/1/49", source: "topology" },
      { from: "d1", to: "b1", fromPort: "1/1/3", toPort: "1/1/49", source: "topology" },
      { from: "c1", to: "ap-core", fromPort: "1/1/40", toPort: "eth0", source: "neighbours" },
      { from: "d1", to: "ph-dist", fromPort: "1/1/41", toPort: "eth0", source: "neighbours" },
      { from: "a1", to: "cam-sw", fromPort: "1/1/20", toPort: "eth0", source: "neighbours" },
      { from: "b1", to: "CNFALLBACK1", fromPort: "1/1/21", toPort: "1/1/1", source: "neighbours" },
    ],
  };
  const model = buildModel(data, { coreSerial: "c1" });
  assert.equal(model.nodes.filter((n) => n.serial === "a1").length, 1);
  assert.equal(model.byId.get("d1").role, "building-core");
  assert.deepEqual([...model.buildings].sort(), ["Building A", "Building B"]);
  const shown = modelForNeighborToggle(model, true);
  assert.equal(shown, model);
  assert.ok(shown.nodes.some((n) => n.serial === "CNFALLBACK1"));

  const view = modelForNeighborToggle(model, false);
  assert.equal(view.nodes.some((n) => n.serial === "CNFALLBACK1"), false);
  assert.equal(view.externals.length, 0);
  assert.deepEqual(view.nodes.map((n) => n.serial).sort(), ["a1", "b1", "c1", "d1"]);
  assert.equal(new Set(view.nodes.map((n) => n.serial)).size, view.nodes.length);
  assert.deepEqual([...view.buildings].sort(), ["Building A", "Building B"]);
  for (const e of view.edges) {
    assert.equal(view.byId.has(e.from) && view.byId.has(e.to), true);
    assert.equal(e.external, false);
  }
  assert.equal(view.edges.some((e) => e.from === "CNFALLBACK1" || e.to === "CNFALLBACK1"), false);

  const opts = { tokens: TOKENS, mgmt: "vlan:99", title: "Switch topology", subtitle: "lldp", showPorts: true, portScale: 1 };
  for (const id of ["hub", "sites", "groups"]) {
    const full = layoutById(id, model);
    const hid = layoutById(id, view);
    const on = renderSvg(model, full, { ...opts, subtitle: id });
    const off = renderSvg(view, hid, { ...opts, subtitle: id });
    assert.match(on, /CNFALLBACK1/);
    assert.match(on, /\(fallback\)/);
    assert.equal(off.includes("CNFALLBACK1"), false, id);
    assert.equal(off.includes("AP-CORE-1"), false, id);
    assert.equal(off.includes("PH-DIST-1"), false, id);
    assert.equal(off.includes("CAM-SW-1"), false, id);
    assert.equal(off.includes("(fallback)"), false, id);
    for (const name of ["CORE-01", "BLDG-A-SW-01", "BLDG-B-DIST-01", "BLDG-B-SW-01"]) {
      assert.ok(off.includes(name), `${id} ${name}`);
    }
    assert.equal(off.includes("data-port-end=\"CNFALLBACK1\""), false, id);
    assert.doesNotMatch(off, /data-chip/);
    const box = off.match(/viewBox="(-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+)"/);
    assert.ok(box, id);
    if (id !== "hub") assert.ok(hid.bounds.h < full.bounds.h || hid.pos.size < full.pos.size, id);
  }
});
