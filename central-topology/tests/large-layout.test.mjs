import test from "node:test";
import assert from "node:assert/strict";
import { buildModel } from "../site/js/model.js";
import { largeSample } from "../site/js/large-sample.js";
import {
  GEOM, accessChipBoxes, accessNeighborGroups, apChipLabel, chipsExpanded, fitScale, labelBox, layoutById, openingScale, readableScale, shownBounds,
} from "../site/js/layout.js";
import { renderSvg } from "../site/js/render.js";

const sample = largeSample();
const model = buildModel(sample, { coreSerial: sample.coreSerial });

const TOKENS = {
  "--diagram-bg": "#12151b", "--diagram-fg": "#e7eaf0", "--diagram-muted": "#9aa3b2",
  "--node-core": "#f97066", "--node-bcore": "#6aa2ff", "--node-access": "#4fc28f",
  "--node-ext": "#667085", "--node-fill": "#1a1e26", "--edge": "#5b6577",
  "--edge-inferred": "#3b4250", "--warn": "#f5a524",
  "--font-sans": "sans-serif", "--font-mono": "monospace",
};

function intersects(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

test("large sample is a second campus, not a replacement for the small mock", () => {
  assert.ok(sample.switches.length >= 40);
  assert.equal(new Set(sample.switches.map((s) => s.site)).size, 6);
  assert.ok(sample.externals.length >= 40);
  assert.ok(sample.links.length >= 200);
  assert.equal(model.byId.get(model.coreSerial).name, "CORE-01");
  assert.equal(model.coreSource, "override");
  assert.equal(model.nodes.length, sample.switches.length);
  assert.ok(model.buildings.includes("Building A"));
  assert.ok(model.buildings.includes("Building F"));
  assert.ok(model.nodes.some((n) => n.name === "BLDG-A-SW-01"));
});

test("large hub-and-spoke places every node, keeps cards and labels apart, and fits the open view", () => {
  const lay = layoutById("hub", model);
  const again = layoutById("hub", model);
  assert.equal(lay.pos.size, model.nodes.length);
  for (const n of model.nodes) {
    const p = lay.pos.get(n.serial);
    assert.ok(p, n.name);
    assert.equal(Number.isFinite(p.x) && Number.isFinite(p.y), true, n.name);
    assert.deepEqual(p, again.pos.get(n.serial), n.name);
  }
  const ghostIds = new Set();
  for (const e of model.edges) {
    if (!e.external) continue;
    ghostIds.add(model.byId.has(e.from) ? e.to : e.from);
  }
  assert.ok(ghostIds.size >= 40);
  for (const id of ghostIds) {
    const p = lay.extPos.get(id);
    assert.ok(p, id);
    assert.equal(Number.isFinite(p.x) && Number.isFinite(p.y), true, id);
    assert.deepEqual(p, again.extPos.get(id), id);
  }

  const cards = model.nodes.map((n) => {
    const p = lay.pos.get(n.serial);
    return { id: n.name, x: p.x - GEOM.nodeW / 2, y: p.y - GEOM.nodeH / 2, w: GEOM.nodeW, h: GEOM.nodeH, p, flags: n.flags.length };
  });
  const ghosts = [...ghostIds].map((id) => {
    const p = lay.extPos.get(id);
    const name = model.externals.find((e) => e.serial === id)?.name ?? id;
    return { id: name, x: p.x - 60, y: p.y - 15, w: 120, h: 30 };
  });
  const labels = (lay.sectors ?? []).map((s) => ({ id: `label:${s.building}`, ...labelBox(s) }));

  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      assert.equal(intersects(cards[i], cards[j]), false, `${cards[i].id} overlaps ${cards[j].id}`);
    }
  }
  for (const label of labels) {
    assert.ok(label.w > 0 && label.h > 0, label.id);
    for (const card of cards) {
      assert.equal(intersects(label, card), false, `${label.id} overlaps ${card.id}`);
    }
    for (const ghost of ghosts) {
      assert.equal(intersects(label, ghost), false, `${label.id} overlaps ${ghost.id}`);
    }
  }
  for (const ghost of ghosts) {
    for (const card of cards) {
      assert.equal(intersects(ghost, card), false, `${ghost.id} overlaps ${card.id}`);
    }
  }
  for (let i = 0; i < ghosts.length; i++) {
    for (let j = i + 1; j < ghosts.length; j++) {
      assert.equal(intersects(ghosts[i], ghosts[j]), false, `${ghosts[i].id} overlaps ${ghosts[j].id}`);
    }
  }
  for (const ghost of ghosts) {
    for (const card of cards) {
      if (!card.flags) continue;
      const c = { x: card.p.x + GEOM.nodeW / 2 - 2, y: card.p.y - GEOM.nodeH / 2 + 2 };
      const nearestX = Math.max(ghost.x, Math.min(c.x, ghost.x + ghost.w));
      const nearestY = Math.max(ghost.y, Math.min(c.y, ghost.y + ghost.h));
      assert.ok(Math.hypot(nearestX - c.x, nearestY - c.y) >= 9, `${ghost.id} sits on ${card.id}'s badge`);
    }
  }

  const boxes = [...cards, ...ghosts, ...labels];
  const header = lay.bounds.y + 72;
  for (const b of boxes) {
    assert.ok(b.y >= header, `${b.id} sits in the title band`);
    assert.ok(b.x >= lay.bounds.x - 0.5, `${b.id} clipped on the left`);
    assert.ok(b.y >= lay.bounds.y - 0.5, `${b.id} clipped on the top`);
    assert.ok(b.x + b.w <= lay.bounds.x + lay.bounds.w + 0.5, `${b.id} clipped on the right`);
    assert.ok(b.y + b.h <= lay.bounds.y + lay.bounds.h + 0.5, `${b.id} clipped on the bottom`);
  }

  const chips = accessChipBoxes(model, lay);
  for (const chip of chips) {
    for (const card of cards) assert.equal(intersects(chip.box, card), false, `${chip.text} overlaps ${card.id}`);
    for (const label of labels) assert.equal(intersects(chip.box, label), false, `${chip.text} overlaps ${label.id}`);
  }
  for (const s of lay.sectors) {
    const hub = model.nodes.find((n) => n.building === s.building && n.role === "building-core");
    if (!hub) continue;
    const p = lay.pos.get(hub.serial);
    const lb = labelBox(s);
    const card = { x: p.x - GEOM.nodeW / 2, y: p.y - GEOM.nodeH / 2, w: GEOM.nodeW, h: GEOM.nodeH };
    const gap = Math.max(card.x - (lb.x + lb.w), lb.x - (card.x + card.w), card.y - (lb.y + lb.h), lb.y - (card.y + card.h), 0);
    assert.ok(gap < 48, `${s.building} label is ${gap}px from its core`);
  }

  // 1440px window: diagram column beside the 340px switch list, minus the card padding.
  const avail = { w: 1440 - 340 - 32, h: 900 - 160 - 32 };
  const reference = layoutById("tree-lr", model).bounds;
  const visible = shownBounds(lay, model, { collapseAps: true });
  const scale = openingScale(visible, avail, reference);
  const floor = readableScale(avail, reference);
  const fit = fitScale(visible, avail);
  assert.ok(scale + 1e-9 >= floor, "opening scale drops below the readable floor");
  if (fit + 1e-9 >= floor) assert.ok(Math.abs(scale - fit) < 1e-9);
  else assert.ok(Math.abs(scale - floor) < 1e-9);

  const svg = renderSvg(model, lay, { tokens: TOKENS, mgmt: "monitor", title: "Switch topology", subtitle: "Hub and spoke" });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  for (const n of model.nodes) assert.ok(svg.includes(n.name), n.name);
  assert.ok(svg.includes("BUILDING A"));
  assert.ok(svg.includes("BUILDING F"));
  assert.ok(svg.includes("BLDG-A-SW-01"));
});

test("access neighbors collapse to one chip and expand on zoom or click", () => {
  const lay = layoutById("hub", model);
  const groups = accessNeighborGroups(model);
  assert.ok(groups.size >= 10);
  for (const [serial, ids] of groups) {
    assert.equal(model.byId.get(serial).role, "access");
    assert.ok(ids.length >= 1);
    assert.equal(apChipLabel(ids.length), `+${ids.length} APs`);
  }
  const [serial, ids] = groups.entries().next().value;
  const ghostName = model.externals.find((e) => e.serial === ids[0]).name;
  const opts = { tokens: TOKENS, mgmt: "monitor", title: "Switch topology", subtitle: "Hub and spoke" };
  const collapsed = renderSvg(model, lay, { ...opts, collapseAps: true });
  assert.match(collapsed, /\+\d+ APs/);
  assert.equal(collapsed.includes(ghostName), false);
  const clicked = renderSvg(model, lay, { ...opts, collapseAps: true, openChips: new Set([serial]) });
  assert.ok(clicked.includes(ghostName), "click expands that switch's neighbors");
  assert.equal(chipsExpanded(1, 1), false);
  assert.equal(chipsExpanded(1.25, 1), true);
  const zoomed = renderSvg(model, lay, { ...opts, collapseAps: !chipsExpanded(1.25, 1) });
  assert.ok(zoomed.includes(ghostName), "zooming in past the opening scale expands neighbors");
});
