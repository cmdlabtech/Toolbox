import test from "node:test";
import assert from "node:assert/strict";
import { topologyFromFixtures } from "./helpers.mjs";
import { buildModel, parseOverrides } from "../site/js/model.js";
import { jsonExport } from "../site/js/export.js";
import { renderSvg } from "../site/js/render.js";
import {
  GEOM, LAYOUTS, applyPositionOverrides, clearPosition, labelBox, layout, layoutById, writePosition,
} from "../site/js/layout.js";

const data = await topologyFromFixtures();
const model = buildModel(data);

const TOKENS = {
  "--diagram-bg": "#fff", "--diagram-fg": "#111", "--diagram-muted": "#667",
  "--node-core": "#b42318", "--node-bcore": "#1f6feb", "--node-access": "#2f9e6e",
  "--node-ext": "#98a2b3", "--node-fill": "#fff", "--edge": "#8b95a7",
  "--edge-inferred": "#c0c6d2", "--warn": "#c77700",
  "--font-sans": "sans-serif", "--font-mono": "monospace",
};

function intersects(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function boxesOf(lay) {
  const out = [];
  for (const n of model.nodes) {
    const p = lay.pos.get(n.serial);
    out.push({ id: n.name, x: p.x - GEOM.nodeW / 2, y: p.y - GEOM.nodeH / 2, w: GEOM.nodeW, h: GEOM.nodeH });
  }
  for (const [id, p] of lay.extPos ?? []) {
    const name = model.externals.find((e) => e.serial === id)?.name ?? id;
    out.push({ id: name, x: p.x - 60, y: p.y - 15, w: 120, h: 30 });
  }
  for (const s of lay.sectors ?? []) {
    const b = labelBox(s);
    if (b) out.push({ id: `label:${s.building}`, ...b });
  }
  return out;
}

test("layout catalogue keeps hub and spoke first", () => {
  assert.deepEqual(LAYOUTS.map((l) => l.id), ["hub", "tree-tb", "tree-lr", "radial", "sites", "force"]);
  assert.equal(LAYOUTS[0].label, "Hub and spoke");
});

test("each layout is deterministic, places every node, and stays finite", () => {
  for (const spec of LAYOUTS) {
    const a = layoutById(spec.id, model);
    const b = layoutById(spec.id, model);
    assert.equal(a.id, spec.id);
    assert.equal(a.pos.size, model.nodes.length, spec.id);
    for (const n of model.nodes) {
      const p = a.pos.get(n.serial);
      assert.ok(p, `${spec.id} missed ${n.name}`);
      assert.equal(Number.isFinite(p.x) && Number.isFinite(p.y), true, `${spec.id} ${n.name}`);
      assert.deepEqual(p, b.pos.get(n.serial), `${spec.id} ${n.name} moved between calls`);
      assert.ok(p.x >= a.bounds.x && p.x <= a.bounds.x + a.bounds.w, `${spec.id} ${n.name} x outside bounds`);
      assert.ok(p.y >= a.bounds.y && p.y <= a.bounds.y + a.bounds.h, `${spec.id} ${n.name} y outside bounds`);
    }
    for (const p of a.extPos?.values() ?? []) {
      assert.equal(Number.isFinite(p.x) && Number.isFinite(p.y), true, spec.id);
    }
    assert.ok(Number.isFinite(a.bounds.x + a.bounds.y + a.bounds.w + a.bounds.h), spec.id);
    assert.ok(a.bounds.w > 0 && a.bounds.h > 0, spec.id);
    const again = spec.id === "hub" ? layout(model) : null;
    if (again) {
      for (const n of model.nodes) assert.deepEqual(again.pos.get(n.serial), a.pos.get(n.serial));
    }
  }
});

test("mock nodes, external devices, and labels do not overlap", () => {
  for (const spec of LAYOUTS) {
    const lay = layoutById(spec.id, model);
    const boxes = boxesOf(lay);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        assert.equal(intersects(boxes[i], boxes[j]), false, `${spec.id}: ${boxes[i].id} overlaps ${boxes[j].id}`);
      }
    }
    // Header band holds the title and the legend. Diagram marks stay below it.
    const header = lay.bounds.y + 72;
    for (const b of boxes) {
      assert.ok(b.y >= header, `${spec.id}: ${b.id} sits in the title band`);
      assert.ok(b.x >= lay.bounds.x && b.x + b.w <= lay.bounds.x + lay.bounds.w + 0.5, `${spec.id}: ${b.id} clipped on x`);
      assert.ok(b.y + b.h <= lay.bounds.y + lay.bounds.h + 0.5, `${spec.id}: ${b.id} clipped on y`);
    }
  }
});

test("every layout renders, including the management-IP fallback ring", () => {
  for (const spec of LAYOUTS) {
    const lay = layoutById(spec.id, model);
    const svg = renderSvg(model, lay, { tokens: TOKENS, mgmt: "vlan:99", title: "Switch topology", subtitle: spec.label });
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    for (const n of model.nodes) assert.ok(svg.includes(n.name), `${spec.id} ${n.name}`);
    assert.match(svg, /stroke-dasharray="5 4"/, `${spec.id} fallback marker`);
    assert.match(svg, /<line |<path /, `${spec.id} edges`);
  }
});

test("position overrides are stored per layout and do not wipe the others", () => {
  const serial = model.coreSerial;
  const hub = layoutById("hub", model);
  const moved = applyPositionOverrides(hub, { [serial]: { x: 25.4, y: -15.2 }, missing: { x: 1, y: 1 }, bad: { x: "no", y: 2 } });
  assert.deepEqual(moved.pos.get(serial), { x: 25, y: -15 });
  assert.equal(moved.pos.size, model.nodes.length);
  assert.ok(moved.bounds.w >= hub.bounds.w - 1);
  const untouched = layoutById("hub", model);
  assert.notDeepEqual(untouched.pos.get(serial), moved.pos.get(serial));

  const store = {};
  const withHub = writePosition(store, "hub", serial, { x: 25.2, y: -3.4 });
  const withBoth = writePosition(withHub, "tree-tb", serial, { x: 8, y: 9 });
  assert.deepEqual(store, {});
  assert.deepEqual(withBoth.hub[serial], { x: 25, y: -3 });
  assert.deepEqual(withBoth["tree-tb"][serial], { x: 8, y: 9 });
  assert.equal(withBoth["tree-tb"] !== withHub.hub, true);
  const cleared = clearPosition(withBoth, "hub", serial);
  assert.equal(cleared.hub, undefined);
  assert.deepEqual(cleared["tree-tb"][serial], { x: 8, y: 9 });
  assert.deepEqual(withBoth.hub[serial], { x: 25, y: -3 });
});

test("override import keeps a per-layout position map and still rejects a bad file", () => {
  const o = parseOverrides('{"coreSerial":"X","switches":{"A":{"role":"access","building":" B "}},"positions":{"hub":{"SG1":{"x":1.2,"y":3}},"tree-lr":{"nope":{"x":"a"}}}}');
  assert.equal(o.coreSerial, "X");
  assert.deepEqual(o.switches, { A: { role: "access", building: "B" } });
  assert.deepEqual(o.positions, { hub: { SG1: { x: 1, y: 3 } } });
  const legacy = parseOverrides('{"coreSerial":"X","switches":{}}');
  assert.equal(legacy.positions, undefined);
  const body = jsonExport(model, "monitor", { coreSerial: null, switches: {} }, { mock: true, generatedAt: data.generatedAt, layout: "sites", positions: { sites: { A: { x: 1, y: 2 } } } });
  assert.equal(body.layout, "sites");
  assert.deepEqual(body.positions.sites.A, { x: 1, y: 2 });
  assert.equal(body.switches.length, 19);
  assert.equal(body.links.length, model.edges.length);
});
