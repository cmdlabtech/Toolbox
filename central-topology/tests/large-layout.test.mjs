import test from "node:test";
import assert from "node:assert/strict";
import { buildModel } from "../site/js/model.js";
import { campusSample, largeSample } from "../site/js/large-sample.js";
import {
  CARD_NAME_FONT, GEOM, HUB_FRAME, accessChipBoxes, accessNeighborGroups, apChipLabel, chipsExpanded, coreScroll, fitScale, hubOpeningScale, labelBox, layoutById, modelForNeighborToggle, nameFloorScale, shownBounds,
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

test("large hub-and-spoke places every node, keeps cards and labels apart, and opens at the name floor", () => {
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
  const visible = shownBounds(lay, model, { collapseAps: true });
  const frame = { x: visible.x, y: visible.y, w: visible.w, h: Math.max(1, visible.h - 72) };
  const scale = hubOpeningScale(frame, avail);
  const floor = nameFloorScale();
  const fit = fitScale(frame, avail);
  assert.ok(fit < floor, "the large sample fits below the 11px floor");
  assert.ok(Math.abs(scale - floor) < 1e-9, "large sample opens at the floor");
  assert.ok(scale <= floor + 1e-9, "never open above the floor");
  assert.ok(CARD_NAME_FONT * scale >= 11 - 1e-9);
  const core = lay.pos.get(model.coreSerial);
  const scroll = coreScroll(core, frame, scale, avail);
  const midX = (core.x - frame.x) * scale - scroll.left;
  const midY = (core.y - frame.y) * scale - scroll.top;
  assert.ok(Math.abs(midX - avail.w / 2) < 1e-6, "opening view centers the district core");
  assert.ok(Math.abs(midY - avail.h / 2) < 1e-6);

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
    const expected = ids.length === 1 ? "+1 AP" : `+${ids.length} APs`;
    assert.equal(apChipLabel(ids.length), expected);
  }
  assert.equal(apChipLabel(1), "+1 AP");
  assert.equal(apChipLabel(2), "+2 APs");
  const [serial, ids] = groups.entries().next().value;
  const ghostName = model.externals.find((e) => e.serial === ids[0]).name;
  const opts = { tokens: TOKENS, mgmt: "monitor", title: "Switch topology", subtitle: "Hub and spoke" };
  const collapsed = renderSvg(model, lay, { ...opts, collapseAps: true });
  assert.match(collapsed, /\+1 AP(?!s)/);
  assert.match(collapsed, /\+\d+ APs/);
  assert.equal(collapsed.includes(ghostName), false);
  const clicked = renderSvg(model, lay, { ...opts, collapseAps: true, openChips: new Set([serial]) });
  assert.ok(clicked.includes(ghostName), "click expands that switch's neighbors");
  assert.equal(chipsExpanded(1, 1), false);
  assert.equal(chipsExpanded(1.25, 1), true);
  const zoomed = renderSvg(model, lay, { ...opts, collapseAps: !chipsExpanded(1.25, 1) });
  assert.ok(zoomed.includes(ghostName), "zooming in past the opening scale expands neighbors");
});

test("campus hub fits eight buildings at the 11px floor, and access chips are not free nodes", () => {
  const sample = campusSample();
  assert.equal(sample.switches.length, 44);
  assert.equal(new Set(sample.switches.map((s) => s.site)).size, 8);
  assert.ok(sample.links.length >= 620 && sample.links.length <= 680);
  assert.ok(sample.externals.length >= 200);
  const model = buildModel(sample);
  assert.equal(model.coreSource, "inferred");
  assert.equal(model.byId.get(model.coreSerial).name, "CORE-01");
  assert.equal(model.nodes.length, 44);
  assert.ok(model.nodes.some((n) => n.name === "BLDG-A-SW-01"));

  const lay = layoutById("hub", model, { width: 1100, height: 760 });
  const again = layoutById("hub", model, { width: 1100, height: 760 });
  assert.equal(lay.pos.size, model.nodes.length);
  for (const n of model.nodes) {
    const p = lay.pos.get(n.serial);
    assert.equal(Number.isFinite(p.x) && Number.isFinite(p.y), true, n.name);
    assert.deepEqual(p, again.pos.get(n.serial), n.name);
  }
  const cards = model.nodes.map((n) => {
    const p = lay.pos.get(n.serial);
    return { id: n.name, x: p.x - GEOM.nodeW / 2, y: p.y - GEOM.nodeH / 2, w: GEOM.nodeW, h: GEOM.nodeH };
  });
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      assert.equal(intersects(cards[i], cards[j]), false, `${cards[i].id} overlaps ${cards[j].id}`);
    }
  }
  for (const sector of lay.sectors) {
    const label = { id: sector.building, ...labelBox(sector) };
    assert.ok(label.w > 0 && label.h > 0, sector.building);
    for (const card of cards) {
      assert.equal(intersects(label, card), false, `${label.id} overlaps ${card.id}`);
    }
  }
  const uplink = [];
  for (const e of model.edges) {
    if (!e.external) continue;
    const local = model.byId.has(e.from) ? e.from : model.byId.has(e.to) ? e.to : null;
    if (!local || model.byId.get(local).role === "access") continue;
    const other = local === e.from ? e.to : e.from;
    const p = lay.extPos.get(other);
    assert.ok(p, other);
    uplink.push({ id: other, x: p.x - 60, y: p.y - 15, w: 120, h: 30 });
  }
  for (const pill of uplink) {
    for (const card of cards) assert.equal(intersects(pill, card), false, `${pill.id} overlaps ${card.id}`);
  }

  const avail = { w: 1068, h: 708 };
  const opened = shownBounds(lay, model, { collapseAps: true, ...HUB_FRAME });
  const frame = { w: opened.w, h: Math.max(1, opened.h - 72) };
  const fit = fitScale(frame, avail);
  const scale = hubOpeningScale(frame, avail);
  assert.ok(fit + 1e-9 >= nameFloorScale(), `opening fit ${fit} is below the 11px floor`);
  assert.ok(Math.abs(scale - fit) < 1e-9);
  assert.ok(CARD_NAME_FONT * scale + 1e-9 >= 11);
  const core = lay.pos.get(model.coreSerial);
  assert.ok(Math.abs(core.x - (opened.x + opened.w / 2)) < 24, "core is in the middle horizontally");
  assert.ok(Math.abs(core.y - (opened.y + 72 + frame.h / 2)) < 24, "core is in the middle of the opening frame");

  let accessFar = 0;
  for (const e of model.edges) {
    if (!e.external) continue;
    const local = model.byId.has(e.from) ? e.from : model.byId.has(e.to) ? e.to : null;
    if (!local || model.byId.get(local).role !== "access") continue;
    const other = local === e.from ? e.to : e.from;
    const p = lay.extPos.get(other);
    assert.equal(Number.isFinite(p.x) && Number.isFinite(p.y), true);
    const inside = p.x >= opened.x && p.x <= opened.x + opened.w && p.y >= opened.y && p.y <= opened.y + opened.h;
    if (!inside) accessFar += 1;
  }
  assert.ok(accessFar > 100, "access neighbors sit outside the opening fit");

  const hidden = modelForNeighborToggle(model, false);
  const hid = layoutById("hub", hidden, { width: 1100, height: 760 });
  let moved = false;
  for (const n of model.nodes) {
    const a = lay.pos.get(n.serial);
    const b = hid.pos.get(n.serial);
    assert.equal(Number.isFinite(b.x) && Number.isFinite(b.y), true, n.name);
    if (a.x !== b.x || a.y !== b.y) moved = true;
  }
  assert.equal(moved, true, "hiding access neighbors places the blocks again");
  assert.equal(accessChipBoxes(hidden, hid).length, 0);
  assert.ok(accessChipBoxes(model, lay).length > 0);
  assert.ok(hid.bounds.w * hid.bounds.h < lay.bounds.w * lay.bounds.h);
  const hidFrame = shownBounds(hid, hidden, { collapseAps: true, ...HUB_FRAME });
  const hidFit = fitScale({ w: hidFrame.w, h: Math.max(1, hidFrame.h - 72) }, avail);
  assert.ok(hidFit + 1e-9 >= nameFloorScale());

  const svg = renderSvg(model, lay, {
    tokens: TOKENS, mgmt: "monitor", title: "Switch topology", subtitle: "Hub and spoke", collapseAps: true,
  });
  const zoomed = renderSvg(model, { ...lay, bounds: opened }, {
    tokens: TOKENS, mgmt: "monitor", title: "Switch topology", subtitle: "Hub and spoke",
    collapseAps: true, showPorts: true, portScale: 1,
  });
  const ports = [];
  const portRe = /<g data-port-end="([^"]+)"[^>]*>([\s\S]*?)<\/g>/g;
  let portMatch;
  while ((portMatch = portRe.exec(zoomed))) {
    const rect = portMatch[2].match(/<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/);
    assert.ok(rect, "port label has a background");
    assert.match(portMatch[2], /font-size="10"/);
    ports.push({
      end: portMatch[1],
      x: Number(rect[1]), y: Number(rect[2]), w: Number(rect[3]), h: Number(rect[4]),
    });
  }
  assert.ok(ports.length >= 20, "zoomed hub still draws switch port labels");
  const hiddenPorts = renderSvg(model, lay, {
    tokens: TOKENS, mgmt: "monitor", title: "t", subtitle: "s", showPorts: false, portScale: 1,
  });
  assert.equal(hiddenPorts.includes("data-port-end"), false);
  const viewMatch = zoomed.match(/viewBox="(-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+)"/);
  assert.ok(viewMatch, "export viewBox");
  const frameBox = { x: Number(viewMatch[1]), y: Number(viewMatch[2]), w: Number(viewMatch[3]), h: Number(viewMatch[4]) };
  for (const lab of ports) {
    assert.ok(lab.x >= frameBox.x - 0.5 && lab.y >= frameBox.y - 0.5, "port label clipped");
    assert.ok(lab.x + lab.w <= frameBox.x + frameBox.w + 0.5 && lab.y + lab.h <= frameBox.y + frameBox.h + 0.5, "port label clipped");
    for (const card of cards) {
      assert.equal(intersects(lab, card), false, `port label covers ${card.id}`);
    }
  }
  const hidSvg = renderSvg(hidden, hid, {
    tokens: TOKENS, mgmt: "monitor", title: "t", subtitle: "s", collapseAps: true, showPorts: true, portScale: 1,
  });
  assert.match(hidSvg, /data-port-end=/);
  assert.equal(hidSvg.includes("data-chip"), false);
  assert.ok(svg.includes("BUILDING A"));
  assert.ok(svg.includes("BUILDING H"));
  assert.ok(svg.includes("BLDG-A-SW-01"));
  assert.match(svg, /stroke-opacity="0\.28"/);
  assert.ok(svg.includes("CORE-FW-01"));
  const accessName = model.externals.find((d) => d.name.startsWith("AP-BLDG-A-")).name;
  assert.equal(svg.includes(accessName), false);
});
