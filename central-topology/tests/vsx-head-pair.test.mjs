// A VSX pair that includes the section head (Middle School: head CORE2, mate
// CORE1, access stacks dual-homed to both over MC-LAG) draws like High School:
// both members side by side on the head row inside one dashed VSX box, the
// children fan out below, and the mate's cross-building uplink is a stub.
import test from "node:test";
import assert from "node:assert/strict";
import { buildModel } from "../site/js/model.js";
import { layoutById } from "../site/js/layout.js";
import { checkLayout, checkText, vsxPairs } from "../site/js/structured.js";
import { renderSvg, TOKEN_NAMES } from "../site/js/render.js";
import { district44 } from "./fixtures/district44.mjs";

const d = district44({ msCoreUplink: true });
const model = buildModel(d, { coreSerial: d.coreSerial });
const lay = layoutById("structured", model);
const id = (name) => model.nodes.find((n) => n.name === name).serial;
const C1 = id("LMS-ER-RM154-CORE1"), C2 = id("LMS-ER-RM154-CORE2"), HS = id("LHS-CORE-VSX-1");
const ms = lay.sections.find((s) => s.name === "Middle School");
const TOKENS = Object.fromEntries(TOKEN_NAMES.map((t) => [t, "#123456"]));

test("head pair is detected from LAG dual-homing and from -CORE1/-CORE2 names", () => {
  assert.ok(vsxPairs(model).some((p) => p.includes(C1) && p.includes(C2)));
  const bare = district44({ msCoreUplink: true });
  for (const l of bare.links) { for (const p of [...(l.fromPorts ?? []), ...(l.toPorts ?? [])]) p.lag = null; }
  const m2 = buildModel(bare, { coreSerial: bare.coreSerial });
  assert.ok(vsxPairs(m2).some((p) => p.includes(C1) && p.includes(C2)), "name fallback");
});

test("head and mate share the head row inside the box, with nothing else inside", () => {
  assert.equal(ms.head, C2);
  assert.equal(ms.mate, C1);
  const a = lay.units.get(C1), b = lay.units.get(C2);
  assert.equal(a.ft, b.ft, "same row");
  assert.ok(a.r <= b.l || b.r <= a.l, "side by side");
  const v = lay.vsx.find((x) => x.members.includes(C1) && x.members.includes(C2));
  assert.ok(v, "a VSX box for the head pair");
  const r = { x: v.box.x0, y: v.box.y0, w: v.box.x1 - v.box.x0, h: v.box.y1 - v.box.y0 };
  for (const u of [a, b]) assert.ok(u.l >= r.x && u.r <= r.x + r.w && u.ft >= r.y && u.fb <= r.y + r.h, `${u.name} inside`);
  for (const u of lay.units.values()) {
    if (u.id === C1 || u.id === C2) continue;
    const inside = u.l < r.x + r.w && u.r > r.x && u.ft < r.y + r.h && u.fb > r.y;
    assert.ok(!inside, `${u.name} is inside the box`);
  }
  for (const id of ms.access) assert.ok(lay.units.get(id).ft > Math.max(a.fb, b.fb), `${lay.name(id)} sits below the pair`);
});

test("the mate's uplink to the HS core draws no line, only a far-switch label; layout rules hold", () => {
  assert.ok(!lay.links.some((l) => [l.a, l.b].includes(C1) && [l.a, l.b].includes(HS)), "no line CORE1–HS core");
  assert.ok(lay.labels.some((x) => x.kind === "far" && x.unit === C1 && x.full.includes("LHS-CORE-VSX-1")));
  const r = checkLayout(lay);
  assert.deepEqual({ c: r.crossings, d: r.diagonal, t: r.throughNodes }, { c: 0, d: 0, t: 0 }, r.detail.join("; "));
  assert.deepEqual(checkText(lay), []);
  const svg = renderSvg(model, lay, { tokens: TOKENS, title: "t", subtitle: "s" });
  assert.equal((svg.match(/class="vsx-pair"/g) ?? []).length, 2);
});
