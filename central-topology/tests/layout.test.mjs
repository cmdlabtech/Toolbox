import test from "node:test";
import assert from "node:assert/strict";
import { topologyFromFixtures } from "./helpers.mjs";
import { buildModel, parseOverrides } from "../site/js/model.js";
import { jsonExport } from "../site/js/export.js";
import { renderSvg } from "../site/js/render.js";
import {
  CANVAS_PAD, CARD_NAME_FONT, CARD_NAME_MIN_PX, GEOM, HUB_FRAME, LAYOUTS, applyPositionOverrides, canvasSize, clearPosition, coreScroll, displayScale, fitScale, hubOpeningScale, labelBox, layout, layoutById, layoutSites, nameFloorScale, openingScale, orthoBend, readableScale, replaceMeasure, shownBounds, siteColumnCount, writePosition,
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

function samePoint(a, b) {
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;
}

function orient(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function properCross(a, b, c, d) {
  if (samePoint(a, c) || samePoint(a, d) || samePoint(b, c) || samePoint(b, d)) return false;
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

function drawnSegments(lay) {
  const at = (id) => lay.pos.get(id) ?? lay.extPos?.get(id);
  const segs = [];
  const add = (u, v) => {
    const a = at(u);
    const b = at(v);
    if (!a || !b) return;
    const pts = lay.route === "ortho" ? orthoBend(a, b, lay.axis) : [a, b];
    for (let i = 0; i < pts.length - 1; i++) segs.push({ a: pts[i], b: pts[i + 1], u, v });
  };
  const seen = new Set();
  for (const e of model.edges) {
    seen.add([e.from, e.to].sort().join("|"));
    add(e.from, e.to);
  }
  for (const n of model.nodes) {
    if (!n.parent || seen.has([n.serial, n.parent].sort().join("|"))) continue;
    add(n.serial, n.parent);
  }
  return segs;
}

function pointInRect(p, r) {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

function segmentHitsRect(a, b, r) {
  if (pointInRect(a, r) || pointInRect(b, r)) return true;
  const corners = [
    { x: r.x, y: r.y }, { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h },
  ];
  for (let i = 0; i < 4; i++) if (properCross(a, b, corners[i], corners[(i + 1) % 4])) return true;
  return false;
}

test("mock trees have no crossing links and no link through another node", () => {
  for (const id of ["tree-tb", "tree-lr"]) {
    const lay = layoutById(id, model);
    const segs = drawnSegments(lay);
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        assert.equal(properCross(segs[i].a, segs[i].b, segs[j].a, segs[j].b), false, `${id} segments cross`);
      }
    }
    const boxes = boxesOf(lay);
    for (const seg of segs) {
      for (const box of boxes) {
        if (box.id.startsWith("label:")) continue;
        const aName = model.nodes.find((n) => n.serial === seg.u)?.name ?? model.externals.find((e) => e.serial === seg.u)?.name ?? seg.u;
        const bName = model.nodes.find((n) => n.serial === seg.v)?.name ?? model.externals.find((e) => e.serial === seg.v)?.name ?? seg.v;
        if (box.id === aName || box.id === bName) continue;
        assert.equal(segmentHitsRect(seg.a, seg.b, box), false, `${id}: ${aName}–${bName} runs through ${box.id}`);
      }
    }
  }
});

test("hub opening scale is an absolute 11px name floor", () => {
  const avail = { w: 1068, h: 708 };
  const floor = nameFloorScale();
  assert.equal(CARD_NAME_MIN_PX, 11);
  assert.equal(CARD_NAME_FONT, 12.5);
  assert.ok(Math.abs(floor - 11 / 12.5) < 1e-12);
  assert.equal(nameFloorScale(), floor);
  const reference = layoutById("tree-lr", model).bounds;
  const relative = readableScale(avail, reference);
  assert.ok(Math.abs(floor - relative) > 1e-3, "floor must not be the left-to-right fit");

  const roomy = { w: 400, h: 280 };
  const roomyFit = fitScale(roomy, avail);
  assert.ok(roomyFit > floor);
  assert.ok(Math.abs(hubOpeningScale(roomy, avail) - roomyFit) < 1e-9);
  assert.ok(hubOpeningScale(roomy, avail) <= roomyFit + 1e-9);

  const huge = { w: 9000, h: 7000 };
  const hugeFit = fitScale(huge, avail);
  assert.ok(hugeFit < floor);
  const opened = hubOpeningScale(huge, avail);
  assert.ok(Math.abs(opened - floor) < 1e-9, "fit below the floor opens at the floor");
  assert.ok(opened <= floor + 1e-9, "never open above the floor");
  const core = { x: 40, y: -20 };
  const frame = { x: -2000, y: -1500, w: 9000, h: 7000 };
  const scroll = coreScroll(core, frame, opened, avail);
  const midX = (core.x - frame.x) * opened - scroll.left;
  const midY = (core.y - frame.y) * opened - scroll.top;
  assert.ok(Math.abs(midX - avail.w / 2) < 1e-6);
  assert.ok(Math.abs(midY - avail.h / 2) < 1e-6);

  assert.equal(model.nodes.length, 19);
  const smallLay = layoutById("hub", model);
  const smallFrame = shownBounds(smallLay, model, { collapseAps: true, ...HUB_FRAME });
  const smallBounds = { w: smallFrame.w, h: Math.max(1, smallFrame.h - 72) };
  // The diagram pane beside the switch list on a 1440px window.
  const pane = { w: 1051, h: 590 };
  const smallFit = fitScale(smallBounds, pane);
  const smallOpen = hubOpeningScale(smallBounds, pane);
  assert.ok(smallFit + 1e-9 >= floor, "19-switch clusters pull in until fit meets the 11px floor");
  assert.ok(smallOpen + 1e-9 >= floor, "19-switch sample opens at or above the 11px floor");
  assert.ok(Math.abs(smallOpen - smallFit) < 1e-9, "fit above the floor opens at fit");
  assert.ok(smallOpen <= smallFit + 1e-9, "never open above fit");
  assert.ok(CARD_NAME_FONT * smallOpen + 1e-9 >= CARD_NAME_MIN_PX);
});

test("opening scale fits only while labels stay at the readable floor", () => {
  const avail = { w: 1068, h: 708 };
  const reference = layoutById("tree-lr", model).bounds;
  const floor = readableScale(avail, reference);
  assert.ok(floor > 0);
  const roomy = { w: 400, h: 280 };
  const roomyFit = fitScale(roomy, avail);
  assert.ok(roomyFit >= floor);
  assert.ok(Math.abs(openingScale(roomy, avail, reference) - roomyFit) < 1e-9);
  const huge = { w: 9000, h: 7000 };
  const hugeFit = fitScale(huge, avail);
  assert.ok(hugeFit < floor);
  assert.ok(Math.abs(openingScale(huge, avail, reference) - floor) < 1e-9);
  const core = { x: 40, y: -20 };
  const frame = { x: -2000, y: -1500, w: 4000, h: 3000 };
  const scroll = coreScroll(core, frame, floor, avail);
  const midX = (core.x - frame.x) * floor - scroll.left;
  const midY = (core.y - frame.y) * floor - scroll.top;
  assert.ok(Math.abs(midX - avail.w / 2) < 1e-6);
  assert.ok(Math.abs(midY - avail.h / 2) < 1e-6);
});

test("display scale uses the floor only when fit-to-canvas would drop below it", () => {
  const avail = { w: 1055, h: 740 };
  const lr = layoutById("tree-lr", model).bounds;
  const floor = Math.min(avail.w / lr.w, avail.h / lr.h);
  assert.equal(Number.isFinite(floor) && floor > 0, true);
  for (const spec of LAYOUTS) {
    const lay = layoutById(spec.id, model);
    const fit = Math.min(avail.w / lay.bounds.w, avail.h / lay.bounds.h);
    const scale = displayScale(lay.bounds, avail, lr);
    assert.equal(Number.isFinite(scale) && scale > 0, true, spec.id);
    const floorFitsHeight = lay.bounds.h * floor <= avail.h;
    if (fit + 1e-9 >= floor || !floorFitsHeight) {
      assert.ok(Math.abs(scale - fit) < 1e-9, `${spec.id} scale ${scale} fit ${fit}`);
    } else {
      assert.ok(Math.abs(scale - floor) < 1e-9, `${spec.id} scale ${scale} floor ${floor}`);
    }
    assert.ok(lay.bounds.h * scale <= avail.h + 0.5, `${spec.id} taller than the card`);
    for (const n of model.nodes) {
      const p = lay.pos.get(n.serial);
      assert.equal(Number.isFinite(p.x) && Number.isFinite(p.y), true, spec.id);
    }
    const svg = renderSvg(model, lay, { tokens: TOKENS, mgmt: "monitor", title: "Switch topology", subtitle: spec.label });
    assert.match(svg, new RegExp(`width="${Math.round(lay.bounds.w)}"`), `${spec.id} export width`);
    assert.match(svg, new RegExp(`height="${Math.round(lay.bounds.h)}"`), `${spec.id} export height`);
    for (const n of model.nodes) assert.ok(svg.includes(n.name), `${spec.id} export ${n.name}`);
  }
  const radial = layoutById("radial", model);
  const radialFit = Math.min(avail.w / radial.bounds.w, avail.h / radial.bounds.h);
  const radialScale = displayScale(radial.bounds, avail, lr);
  assert.ok(Math.abs(radialScale - radialFit) < 1e-9, "radial stays fitted");
  assert.ok(radial.bounds.w * radialScale <= avail.w + 0.5);
  assert.ok(radial.bounds.h * radialScale <= avail.h + 0.5);
  const wide = { w: 4000, h: 400 };
  const wideFit = Math.min(avail.w / wide.w, avail.h / wide.h);
  const wideScale = displayScale(wide, avail, lr);
  assert.ok(wideFit < floor);
  assert.ok(Math.abs(wideScale - floor) < 1e-9);
});

test("force-directed graph is centered, with every node inside the frame", () => {
  const lay = layoutById("force", model);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, bottom = -Infinity;
  for (const p of [...lay.pos.values(), ...lay.extPos.values()]) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const mid = (minX + maxX) / 2;
  const frameMid = lay.bounds.x + lay.bounds.w / 2;
  assert.ok(Math.abs(mid - frameMid) <= 1, `center ${mid} vs frame ${frameMid}`);
  for (const n of model.nodes) {
    const p = lay.pos.get(n.serial);
    const top = p.y - GEOM.nodeH / 2;
    const foot = p.y + GEOM.nodeH / 2;
    bottom = Math.max(bottom, foot);
    assert.ok(p.x - GEOM.nodeW / 2 >= lay.bounds.x + 20, n.name);
    assert.ok(p.x + GEOM.nodeW / 2 <= lay.bounds.x + lay.bounds.w - 20, n.name);
    assert.ok(top >= lay.bounds.y + 72, n.name);
    assert.ok(foot <= lay.bounds.y + lay.bounds.h - 20, n.name);
  }
  assert.ok(bottom <= lay.bounds.y + lay.bounds.h - 20);
  assert.equal(Number.isFinite(lay.bounds.w + lay.bounds.h), true);
  const gap = 16;
  const nodeRects = model.nodes.map((n) => {
    const p = lay.pos.get(n.serial);
    return { id: n.name, flags: n.flags.length, x: p.x - GEOM.nodeW / 2, y: p.y - GEOM.nodeH / 2, w: GEOM.nodeW, h: GEOM.nodeH, p };
  });
  const ghosts = [...lay.extPos].map(([id, p]) => ({
    id: model.externals.find((e) => e.serial === id)?.name ?? id,
    x: p.x - 60, y: p.y - 15, w: 120, h: 30,
  }));
  const padded = (r) => ({ x: r.x - gap / 2, y: r.y - gap / 2, w: r.w + gap, h: r.h + gap });
  const boxes = [...nodeRects, ...ghosts];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      assert.equal(intersects(padded(boxes[i]), padded(boxes[j])), false, `${boxes[i].id} is within ${gap}px of ${boxes[j].id}`);
    }
  }
  for (const ghost of ghosts) {
    for (const node of nodeRects) {
      if (!node.flags) continue;
      const c = { x: node.p.x + GEOM.nodeW / 2 - 2, y: node.p.y - GEOM.nodeH / 2 + 2 };
      const nearestX = Math.max(ghost.x, Math.min(c.x, ghost.x + ghost.w));
      const nearestY = Math.max(ghost.y, Math.min(c.y, ghost.y + ghost.h));
      assert.ok(Math.hypot(nearestX - c.x, nearestY - c.y) >= 9, `${ghost.id} sits on ${node.id}'s badge`);
    }
  }
});

test("canvas size tracks the container and updates when the panel or window changes", () => {
  const column = { w: 860, h: 640 };
  const open = canvasSize(column);
  assert.equal(open.w, 860 - CANVAS_PAD * 2);
  assert.equal(open.h, 640 - CANVAS_PAD * 2);
  assert.ok(open.w > 700, "the card uses the column, not about half of it");
  const wider = replaceMeasure(column, { w: 1100, h: 640 });
  assert.equal(wider.w, 1100);
  assert.equal(canvasSize(wider).w, 1100 - CANVAS_PAD * 2);
  const panel = replaceMeasure(wider, { w: 1100, h: 420 });
  assert.equal(panel.h, 420);
  assert.equal(canvasSize(panel).h, 420 - CANVAS_PAD * 2);
  assert.equal(replaceMeasure(panel, { w: 1100, h: 420 }), panel);
});

test("grouped by site lays groups across the available width", () => {
  const availW = 1000;
  const lay = layoutSites(model, { width: availW });
  const boxes = (lay.sectors ?? []).filter((s) => s.box).map((s) => s.box);
  assert.ok(boxes.length >= 2);
  const cols = new Set(boxes.map((b) => b.x)).size;
  assert.ok(cols >= 2, "sites share the width instead of one narrow column");
  const span = Math.max(...boxes.map((b) => b.x + b.w)) - Math.min(...boxes.map((b) => b.x));
  const one = Math.max(...boxes.map((b) => b.w));
  assert.ok(span > one * 1.5, "the grid is wider than a single strip");
  const count = siteColumnCount(boxes.length, availW, one);
  assert.equal(lay.columns, count);
  assert.ok(span * nameFloorScale() <= availW + one, "columns stay within the pane at the 11px floor");
});

test("site ghosts sit fully inside their box with a gap, and tree ghosts sit off other links", () => {
  const sites = layoutById("sites", model);
  const boxes = (sites.sectors ?? []).filter((s) => s.box).map((s) => s.box);
  const inside = (pill, box, gap) => pill.x >= box.x + gap && pill.y >= box.y + gap
    && pill.x + pill.w <= box.x + box.w - gap && pill.y + pill.h <= box.y + box.h - gap;
  const separated = (pill, box, gap) => pill.x + pill.w + gap <= box.x || box.x + box.w + gap <= pill.x
    || pill.y + pill.h + gap <= box.y || box.y + box.h + gap <= pill.y;
  for (const [id, p] of sites.extPos) {
    const pill = { x: p.x - 60, y: p.y - 15, w: 120, h: 30 };
    const name = model.externals.find((e) => e.serial === id)?.name ?? id;
    for (const box of boxes) {
      assert.ok(inside(pill, box, 12) || separated(pill, box, 12), `${name} meets a site border`);
    }
  }
  for (const id of ["tree-lr", "tree-tb"]) {
    const lay = layoutById(id, model);
    const segs = drawnSegments(lay);
    for (const [extId, p] of lay.extPos) {
      const pill = { x: p.x - 60, y: p.y - 15, w: 120, h: 30 };
      const name = model.externals.find((e) => e.serial === extId)?.name ?? extId;
      for (const seg of segs) {
        if (seg.u === extId || seg.v === extId) continue;
        assert.equal(segmentHitsRect(seg.a, seg.b, pill), false, `${id}: ${name} sits on a link`);
      }
    }
  }
});
