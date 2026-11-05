// VSX pairs in the structured layout: detected from MC-LAG dual-homing (or
// VSX twin names), drawn side by side inside one dashed box, and the second
// MC-LAG legs are not routed as a peer bus around the section.
import test from "node:test";
import assert from "node:assert/strict";
import { buildModel } from "../site/js/model.js";
import { layoutById } from "../site/js/layout.js";
import { checkLayout, checkText, vsxPairs } from "../site/js/structured.js";
import { renderSvg, TOKEN_NAMES } from "../site/js/render.js";
import { district44 } from "./fixtures/district44.mjs";

const d = district44();
const model = buildModel(d, { coreSerial: d.coreSerial });
const lay = layoutById("structured", model);
const id = (name) => model.nodes.find((n) => n.name === name).serial;
const V1 = id("LHS-CORE-VSX-1"), V2 = id("LHS-CORE-VSX-2");
const TOKENS = Object.fromEntries(TOKEN_NAMES.map((t) => [t, "#123456"]));

test("detects the LHS VSX pair from MC-LAG dual-homing", () => {
  const pairs = vsxPairs(model).map((p) => p.map((s) => model.byId.get(s).name));
  assert.ok(pairs.some((p) => p.join() === "LHS-CORE-VSX-1,LHS-CORE-VSX-2"), JSON.stringify(pairs));
  for (const p of vsxPairs(model)) for (const s of p) assert.ok(!model.byId.get(s).stack, "stacks are never VSX members");
});

test("detects VSX twins by name without LAG data, and not lone or cross-building switches", () => {
  const strip = { ...d, links: d.links.map((l) => ({ ...l, fromPorts: [], toPorts: [] })) };
  const m = buildModel(strip, { coreSerial: d.coreSerial });
  assert.deepEqual(vsxPairs(m), [[V1, V2]]);
  const moved = { ...strip, switches: strip.switches.map((s) => (s.name === "LHS-CORE-VSX-2" ? { ...s, site: "Transportation", siteId: "Transportation" } : s)) };
  assert.deepEqual(vsxPairs(buildModel(moved, { coreSerial: d.coreSerial })), []);
});

test("pair sits side by side, box encloses both members and nothing else", () => {
  const v = lay.vsx.find((x) => x.members.includes(V1));
  assert.ok(v, "pair laid out");
  const [a, b] = v.members.map((s) => lay.units.get(s));
  assert.equal(a.y, b.y, "same row");
  assert.ok(a.r < b.l, "left and right columns");
  const { x0, x1, y0, y1 } = v.box;
  for (const u of [a, b]) assert.ok(x0 < u.l && x1 > u.r && y0 < u.y && y1 > u.fb, `${u.name} inside the box`);
  const sec = v.section;
  assert.ok(x0 >= sec.x && x1 <= sec.x + sec.w && y0 >= sec.y + lay.geom.titleBand && y1 <= sec.y + sec.h, "box inside its section, below the title");
  for (const u of lay.units.values()) {
    if (u.x == null || v.members.includes(u.id)) continue;
    assert.ok(u.r < x0 || u.l > x1 || u.bottom < y0 || u.y > y1, `${u.name} outside the box`);
  }
  for (const lb of lay.labels) if (!v.members.includes(lb.unit)) {
    const q = lb.box;
    assert.ok(q.x1 < x0 || q.x0 > x1 || q.y1 < y0 || q.y0 > y1, `"${lb.text}" outside the box`);
  }
});

test("no wrap-around: second MC-LAG legs are not routed, other links keep their member", () => {
  const v = lay.vsx[0];
  assert.ok(v.absorbed.length >= 10, `absorbed ${v.absorbed.length}`);
  const inSec = (s) => v.section.access.includes(s);
  const hsPeer = lay.links.filter((l) => l.kind === "peer" && [l.a, l.b].some((s) => v.members.includes(s)) && [l.a, l.b].every(inSec));
  assert.deepEqual(hsPeer.map((l) => `${lay.name(l.a)}–${lay.name(l.b)}`), []);
  // Every access unit drawn "via" a member still has its riser, and the via names that member.
  for (const s of v.section.access) {
    const u = lay.units.get(s);
    if (v.members.includes(s) || !u.via) continue;
    const up = model.byId.get(s).parent;
    if (v.members.includes(up)) assert.equal(u.via, lay.name(up));
  }
  // Cross-building links to VSX-1 are still peer lines to VSX-1.
  assert.ok(lay.links.filter((l) => l.kind === "peer" && l.cross && (l.a === V1 || l.b === V1)).length >= 2);
});

test("crossing-free and text rules still hold; SVG export draws the box", () => {
  const r = checkLayout(lay);
  assert.deepEqual({ c: r.crossings, d: r.diagonal, t: r.throughNodes }, { c: 0, d: 0, t: 0 }, r.detail.join("; "));
  assert.ok(r.peerCrossings <= 11);
  assert.deepEqual(checkText(lay), []);
  for (const badges of [true, false]) {
    const svg = renderSvg(model, lay, { tokens: TOKENS, title: "t", subtitle: "s", badges });
    assert.equal((svg.match(/class="vsx-pair"/g) ?? []).length, 1);
    assert.match(svg, /stroke-dasharray="5 4"\/><rect[^>]*\/><text[^>]*>VSX<\/text>/);
  }
});
