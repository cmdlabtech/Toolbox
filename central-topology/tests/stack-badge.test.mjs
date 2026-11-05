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
