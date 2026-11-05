// Stacks (VSF, more than one member) draw as one box with a ×N pill after the
// name and two faded stacked-card shadows behind it, in every layout and in
// exports. The tooltip lists the members. Non-stacks are unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { buildModel, stackLines } from "../site/js/model.js";
import { largeSample } from "../site/js/large-sample.js";
import { GEOM as CARD, LAYOUTS, layoutById } from "../site/js/layout.js";
import { GEOM, checkLayout, checkText } from "../site/js/structured.js";
import { STACK_SHADOW, TOKEN_NAMES, renderSvg } from "../site/js/render.js";

const TOKENS = Object.fromEntries(TOKEN_NAMES.map((t) => [t, "#123456"]));
const STACKED = "BLDG-B-SW-02";

/** The large sample with one access switch made a 3-member stack. */
export function sampleWithStack() {
  const d = largeSample();
  const head = d.switches.find((s) => s.name === STACKED);
  Object.assign(head, { conductorSerial: head.serial, stackMemberId: 1 });
  ["SGSTACKB02", "SGSTACKC03"].forEach((serial, i) => d.switches.push({ ...head, serial, mac: `38:21:c7:ff:00:0${i}`, stackMemberId: i + 2, stackRole: i ? undefined : "standby" }));
  // Members cabled the way real stacks are: VSF links between members, a
  // second uplink from member 2 to the same building core, and an LLDP row
  // from member 3 to a neighbour the conductor already links to.
  const [m1, m2, m3] = ["head", "SGSTACKB02", "SGSTACKC03"].map((x) => (x === "head" ? head.serial : x));
  const up = d.links.find((l) => l.to === m1 && l.toPort === "1/1/49");
  d.links.push(
    { from: m1, to: m2, fromPort: "1/1/51", toPort: "2/1/51", source: "topology", isSibling: true },
    { from: m2, to: m3, fromPort: "2/1/52", toPort: "3/1/52", source: "topology", isSibling: true },
    { from: m3, to: m1, fromPort: "3/1/51", toPort: "1/1/52", source: "neighbours" },
    { from: up.from, to: m2, fromPort: "1/1/40", toPort: "2/1/49", source: "topology" },
    { from: m3, to: "SG865FB3A0", fromPort: "3/1/3", toPort: "1/1/50", source: "neighbours" },
  );
  return d;
}
const plainSample = largeSample();
const build = (d) => buildModel(d, { coreSerial: d.coreSerial });
const model = build(sampleWithStack());
const plain = build(plainSample);
const stack = model.nodes.find((n) => n.name === STACKED);

test("tooltip lines: number, model, serial, and role when known", () => {
  assert.deepEqual(stackLines(stack), ["Stack of 3",
    `  1  Aruba 6200F 48G  ${stack.serial}  conductor`, "  2  Aruba 6200F 48G  SGSTACKB02  standby", "  3  Aruba 6200F 48G  SGSTACKC03"]);
  assert.deepEqual(stackLines(plain.nodes[0]), []);
});

test("a stack draws one link per neighbour: no member-to-member links, parallel links merged", () => {
  const ends = model.edges.filter((e) => e.from === stack.serial || e.to === stack.serial);
  const peers = ends.map((e) => (e.from === stack.serial ? e.to : e.from));
  assert.equal(new Set(peers).size, peers.length, "one edge per neighbour");
  assert.ok(!peers.some((p) => stack.stack.some((m) => m.serial === p)) && !peers.includes(stack.serial), "no intra-stack edges");
  const plainPeers = plain.edges.filter((e) => e.from === stack.serial || e.to === stack.serial).length;
  assert.equal(ends.length, plainPeers, "member cabling adds no lines");
  const up = ends.find((e) => e.to === stack.serial && e.toLabel?.includes("2/1/49"));
  assert.ok(up && up.toLabel.includes("1/1/49") && up.fromLabel.includes("1/1/40"), `uplink lists both port pairs: ${up?.fromLabel} / ${up?.toLabel}`);
  const lldp = ends.find((e) => (e.from === stack.serial ? e.to : e.from) === "SG865FB3A0");
  assert.match(lldp.fromLabel, /3\/1\/3/);
  for (const spec of LAYOUTS) {
    const lay = layoutById(spec.id, model), plainLay = layoutById(spec.id, plain);
    const svg = renderSvg(model, lay, { tokens: TOKENS, title: "t", subtitle: "s" });
    const plainSvg = renderSvg(plain, plainLay, { tokens: TOKENS, title: "t", subtitle: "s" });
    const count = (x) => (x.match(/<(path|line)[^>]*><title>/g) ?? []).length;
    assert.equal(count(svg), count(plainSvg), `${spec.id}: same number of drawn links as the unstacked sample`);
    assert.ok(!/stack-link/.test(svg), `${spec.id}: no member connector`);
  }
});

test("parallel links between two plain switches merge too", async () => {
  const { collapseStacks } = await import("../site/js/model.js");
  const sw = [{ serial: "A", name: "a" }, { serial: "B", name: "b" }];
  const { links } = collapseStacks(sw, [
    { from: "A", to: "B", fromPort: "1/1/49", toPort: "1/1/1" },
    { from: "B", to: "A", fromPorts: [{ name: "1/1/2", lag: "lag1" }], toPorts: [{ name: "1/1/50", lag: "lag1" }] },
  ]);
  assert.equal(links.length, 1);
  assert.deepEqual([links[0].fromPorts.map((p) => p.name), links[0].toPorts.map((p) => p.name)], [["1/1/49", "1/1/50"], ["1/1/1", "1/1/2"]]);
});

test("structured: pill after the name, two shadows, mgmt line below them, checks pass", () => {
  const lay = layoutById("structured", model);
  const u = lay.units.get(stack.serial);
  const name = lay.labels.find((l) => l.unit === u.id && l.kind === "name");
  assert.equal(u.pill.text, "×3");
  assert.ok(u.pill.x >= name.box.x1 && u.pill.y + u.pill.h <= u.ft, "pill sits after the name, above the faceplate");
  const [f] = u.faces;
  assert.deepEqual(f.shadows.map((s) => [s.x - u.l, s.y - f.y]), [[8, 8], [4, 4]]);
  assert.equal(f.shadows[0].x + f.w, u.r, "back shadow ends at the cell's faceplate edge");
  const ip = lay.labels.find((l) => l.unit === u.id && l.kind === "ip");
  assert.ok(ip.box.y0 >= f.y + 2 * GEOM.shadow + GEOM.fh, "mgmt line clears the shadows");
  assert.ok(lay.bounds.y + lay.bounds.h >= u.bottom, "bounds hold the taller cell");
  const r = checkLayout(lay);
  assert.deepEqual([r.crossings, r.diagonal, r.throughNodes], [0, 0, 0], r.detail.join("; "));
  assert.deepEqual(checkText(lay), []);
  const svg = renderSvg(model, lay, { tokens: TOKENS, title: "t", subtitle: "s", badges: false });
  assert.equal((svg.match(/class="stack-pill"/g) ?? []).length, 1, "pill kept in exports");
  assert.equal((svg.match(/class="stack-shadow"/g) ?? []).length, 2);
  assert.match(svg, />×3</);
  assert.match(svg, /Stack of 3\n {2}1 {2}Aruba 6200F 48G/);
});

test("structured: non-stacks keep their geometry", () => {
  const a = layoutById("structured", plain), b = layoutById("structured", model);
  for (const [id, u] of a.units) {
    if (u.x == null) continue;
    assert.equal(u.fb - u.ft, GEOM.fh, `${u.name} one plain faceplate`);
    assert.ok(!u.pill && !u.faces[0].shadows.length, `${u.name} no stack decor`);
    const v = b.units.get(id);
    if (id !== stack.serial && v?.x != null) assert.equal(v.fb - v.ft, GEOM.fh);
  }
});

test("card layouts: pill and shadows inside the card footprint, mgmt line untouched", () => {
  for (const spec of LAYOUTS.filter((s) => s.id !== "structured")) {
    const lay = layoutById(spec.id, model);
    const svg = renderSvg(model, lay, { tokens: TOKENS, title: "t", subtitle: spec.label });
    const g = svg.match(new RegExp(`<g data-serial="${stack.serial}">.*?</g>`, "s"))?.[0];
    assert.ok(g, `${spec.id} draws the stack`);
    assert.match(g, /Stack of 3/, `${spec.id} member list in tooltip`);
    assert.match(g, /class="stack-pill"/);
    assert.match(g, />×3</);
    const p = lay.pos.get(stack.serial), top = p.y - CARD.nodeH / 2;
    const rects = [...g.matchAll(/class="stack-shadow" x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)].map((m) => m.slice(1).map(Number));
    assert.equal(rects.length, 2, spec.id);
    for (const [x, y, w, h] of rects) {
      assert.ok(x + w <= p.x + CARD.nodeW / 2 + 1e-9 && y + h <= top + CARD.boxH + 1e-9, `${spec.id} shadow inside the box area, above the mgmt line`);
    }
    assert.deepEqual(rects.map(([x, y]) => [x - (p.x - CARD.nodeW / 2), y - top]), [[2 * STACK_SHADOW, 2 * STACK_SHADOW], [STACK_SHADOW, STACK_SHADOW]]);
    // Non-stacks: the same single 156x30 box as before, no decor.
    const other = model.nodes.find((n) => !n.stack && lay.pos.get(n.serial));
    const og = svg.match(new RegExp(`<g data-serial="${other.serial}">.*?</g>`, "s"))[0];
    assert.ok(!/stack-(pill|shadow)/.test(og) && og.includes(`width="${CARD.nodeW}" height="${CARD.boxH}"`), `${spec.id} non-stack unchanged`);
  }
});
