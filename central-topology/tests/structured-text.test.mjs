// Structured layout text rules, on a 44-switch district shaped like a real
// one (plausible test data only). Every label is measured and placed by the
// layout, so the rules are checked on the layout output, not on pixels.
import test from "node:test";
import assert from "node:assert/strict";
import { buildModel, mgmtOptions } from "../site/js/model.js";
import { layoutById, structuredOpeningScale, structuredOpeningScroll, structuredScaleFloor } from "../site/js/layout.js";
import { GEOM, MIN_FONT_PX, WAN_CLEAR, approxMeasure, checkLayout, checkText, displayName } from "../site/js/structured.js";
import { renderSvg, TOKEN_NAMES } from "../site/js/render.js";
import { district44 } from "./fixtures/district44.mjs";

const data = district44();
const model = buildModel(data, { coreSerial: data.coreSerial });
const lay = (mgmt = "vlan:1", measure) => layoutById("structured", model, { mgmt, measure });
const unitByName = (l, name) => [...l.units.values()].find((u) => u.name === name);
const label = (l, name, kind) => l.labels.find((x) => x.unit === unitByName(l, name)?.id && x.kind === kind);
const TOKENS = Object.fromEntries(TOKEN_NAMES.map((t) => [t, "#123456"]));

test("district44 fixture: 44 switches in 8 buildings", () => {
  assert.equal(data.switches.length, 44);
  const by = {};
  for (const s of data.switches) by[s.site] = (by[s.site] ?? 0) + 1;
  assert.deepEqual(by, { "Admin and PreK": 2, "Middle School": 8, "Perry Worth Elementary": 4, Transportation: 1, "High School": 16, "Central Elementary": 6, "Harrison Elementary": 4, "Stokes Elementary": 3 });
  assert.ok(mgmtOptions(model.nodes).some((o) => o.id === "vlan:1" && /DEFAULT_VLAN_1/.test(o.label)));
});

test("district44: no crossings and every text rule met, on approximate and wider fonts", () => {
  const wide = (t, st) => approxMeasure(t, st) * 1.15; // a font wider than the estimate
  for (const measure of [undefined, wide]) for (const mgmt of ["vlan:1", "vlan:20", "monitor"]) {
    const l = lay(mgmt, measure);
    const r = checkLayout(l);
    assert.deepEqual({ c: r.crossings, d: r.diagonal, t: r.throughNodes, detail: r.detail }, { c: 0, d: 0, t: 0, detail: [] }, `${mgmt}`);
    assert.deepEqual(checkText(l), [], `${mgmt} ${measure ? "wide" : "approx"}`);
  }
});

test("columns: width from the measured text, clamped, labels never wider than the column", () => {
  const l = lay();
  for (const s of l.sections) assert.ok(s.colW >= GEOM.colMin && s.colW <= GEOM.colMax, `${s.name} col ${s.colW}`);
  const secOf = (u) => l.labels.find((x) => x.unit === u.id && x.kind === "name")?.section;
  const hsCells = new Set([...l.units.values()].filter((u) => secOf(u) === "High School" && u.role === "access").map((u) => u.cell.x0));
  assert.equal(hsCells.size, 2, "High School access switches sit in two columns");
  for (const u of l.units.values()) if (u.cell && secOf(u)) assert.equal(u.cell.x1 - u.cell.x0, l.sections.find((s) => s.name === secOf(u)).colW, `${u.name} shares its section's column width`);
  for (const lb of l.labels.filter((x) => x.unit)) {
    const u = l.units.get(lb.unit);
    assert.ok(lb.box.x1 - lb.box.x0 <= u.cell.x1 - u.cell.x0 + 0.01, `${lb.text} fits its column`);
  }
  // A long name grows its column past the faceplate, up to the clamp, then ellipsises.
  const long = (t, st) => approxMeasure(t, st) * (/^LHS-D111/.test(t) ? 3 : 1);
  const l2 = lay("vlan:1", long);
  const name = label(l2, "LHS-D111-STACK", "name");
  assert.ok(name.text.endsWith("…") && name.full === "LHS-D111-STACK", "ellipsis with the full name kept");
  assert.deepEqual(checkText(l2), []);
});

test("font floor: nothing under 10px at the opening and Fit scale", () => {
  const l = lay();
  assert.ok(l.minFont >= MIN_FONT_PX);
  const floor = structuredScaleFloor();
  assert.equal(floor, 1);
  for (const avail of [{ w: 900, h: 600 }, { w: 1280, h: 700 }, { w: 1600, h: 900 }, { w: 4000, h: 3000 }]) {
    const s = structuredOpeningScale(l.bounds, avail);
    assert.ok(s >= floor, `${avail.w} opens at ${s}`);
    assert.deepEqual(checkText(l, s), []);
  }
  assert.ok(checkText(l, 0.8).some((m) => /px$/.test(m)), "the check catches a scale under the floor");
});

test("title band holds only the title and count", () => {
  const l = lay();
  for (const s of l.sections) {
    const inBand = l.labels.filter((x) => x.section === s.name && x.box.y0 < s.y + GEOM.titleBand);
    assert.deepEqual([...new Set(inBand.map((x) => x.kind))].sort(), ["count", "title"].filter((k) => inBand.some((x) => x.kind === k)).sort(), s.name);
    const t = inBand.find((x) => x.kind === "title");
    assert.equal(t.size, 13); assert.equal(t.weight, 700); assert.equal(t.text, s.name.toUpperCase());
  }
});

test("unnamed switch: model family plus last 4 of the serial; full serial in the tooltip", () => {
  const l = lay();
  const head = data.switches.find((s) => s.site === "Harrison Elementary" && s.name === s.serial);
  const u = l.units.get(head.serial);
  assert.equal(u.name, `CX 6300M · ${head.serial.slice(-4)}`);
  assert.equal(displayName(model.byId.get(head.serial)), u.name);
  const svg = renderSvg(model, l, { tokens: TOKENS, mgmt: "vlan:1", title: "t", subtitle: "s" });
  assert.ok(svg.includes(`Serial ${head.serial}`), "full serial in the tooltip");
  assert.ok(!l.labels.some((x) => x.text === head.serial), "serial is never a header");
});

test("model text is 10px mono and never shrinks; badges sit inside the faceplate", () => {
  const l = lay();
  const models = l.labels.filter((x) => x.kind === "model");
  assert.ok(models.length > 40);
  for (const m of models) { assert.equal(m.size, 10); assert.equal(m.mono, true); }
  let badges = 0;
  for (const u of l.units.values()) for (const f of u.faces ?? []) if (f.badge) {
    badges++;
    assert.equal(f.badge.r * 2, 14);
    assert.equal(u.r - (f.badge.cx + f.badge.r), GEOM.badgeInset, "4px from the right edge");
    assert.equal(f.badge.cy, f.y + GEOM.fh / 2, "vertically centred");
  }
  assert.ok(badges > 0);
});

test("stubs and links out stay inside their sections, three lines then +n more", () => {
  const l = lay();
  for (const st of l.labels.filter((x) => x.kind === "stub" || x.kind === "linksout")) assert.equal(st.size, 11);
  const more = l.labels.filter((x) => /^\+\d+ more$/.test(x.text));
  assert.ok(more.length > 0);
  for (const m of more) assert.ok(m.section, "no loose +n more");
  for (const u of l.units.values()) {
    const lines = l.labels.filter((x) => x.unit === u.id && x.kind === "stub");
    assert.ok(lines.length <= 4, `${u.name} has ${lines.length} stub lines`);
  }
  // Ports and LAGs live in tooltips; only "via X" stays inline.
  assert.ok(!l.labels.some((x) => /lag\d|\d+\/\d+\/\d+/.test(x.text)), "no port names inline");
  assert.equal(label(l, "LHS-C214-STACK", "via").text.startsWith("via LHS-CORE-VSX-"), true);
});

test("management IP follows the selected VLAN, changes on reselect, and stays in its column", () => {
  const sw = data.switches.find((s) => s.site === "Middle School" && s.vlans.some((v) => v.id === "1") && s.vlans.some((v) => v.id === "20") && !/CORE/.test(s.name));
  const v1 = sw.vlans.find((v) => v.id === "1"), v20 = sw.vlans.find((v) => v.id === "20");
  assert.ok(v1 && v20, "fixture switch has both SVIs");
  const a = label(lay("vlan:1"), sw.name, "ip");
  const b = label(lay("vlan:20"), sw.name, "ip");
  const c = label(lay("vlan:1"), sw.name, "ip");
  assert.ok(a.text.includes(v1.ipv4) && b.text.includes(v20.ipv4), `${a.text} / ${b.text}`);
  assert.notEqual(a.text, b.text, "reselect changes the IP");
  assert.equal(c.text, a.text, "back to VLAN 1 restores it");
  assert.equal(a.size, 11); assert.equal(a.mono, true); assert.equal(a.color, "muted");
  // The IP is its own line under the name and inside the cell.
  for (const l of [lay("vlan:1"), lay("vlan:20")]) for (const ip of l.labels.filter((x) => x.kind === "ip")) {
    const u = l.units.get(ip.unit), name = l.labels.find((x) => x.unit === ip.unit && x.kind === "name");
    assert.ok(ip.box.x0 >= u.cell.x0 - 0.01 && ip.box.x1 <= u.cell.x1 + 0.01, `${u.name} IP in column`);
    assert.ok(ip.y > name.y && ip.box.y1 <= u.ft, `${u.name} IP under the name, above the faceplate`);
  }
  // Fallback keeps the badge; no address shows a dash.
  const l = lay("vlan:1");
  const fb = [...l.units.values()].find((u) => u.mgmt?.fallback && u.mgmt.ip);
  assert.ok(fb.faces.some((f) => f.badge), "fallback IP keeps the badge");
  assert.equal(label(l, "HAR-IDF-426B", "ip").text, "—");
});

test("render: labels come out as drawn, IP in mono, ports in the tooltip", () => {
  const l = lay("vlan:20");
  const svg = renderSvg(model, l, { tokens: { ...TOKENS, "--font-mono": "MONO" }, mgmt: "vlan:20", title: "t", subtitle: "s" });
  const ip = l.labels.find((x) => x.kind === "ip" && /^VL20 /.test(x.text));
  assert.match(svg, new RegExp(`class="lbl-ip"[^>]*font-family="MONO"[^>]*>${ip.text.replace(/[.]/g, "\\.")}<`));
  assert.match(svg, /<path data-edge=""[^>]*><title>[^<]*lag\d+/, "LAG names in link tooltips");
  assert.ok(!/<text[^>]*>[^<]*lag\d+/.test(svg), "no LAG names as text");
});

test("first scroll centres the district-core section with the top in view", () => {
  const l = lay();
  const core = l.sections.find((s) => s.own);
  for (const w of [700, 1100]) {
    const avail = { w, h: 600 };
    const { left, top } = structuredOpeningScroll(l, l.bounds, 1, avail);
    assert.equal(top, 0);
    const centre = core.x + core.w / 2 - l.bounds.x;
    assert.ok(Math.abs(left + w / 2 - centre) <= 1, `core centre ${centre} sits mid-pane at ${w}`);
    assert.ok(left > 0, "the left wing is not what opens");
  }
  // A pane wider than the drawing does not scroll.
  assert.deepEqual(structuredOpeningScroll(l, l.bounds, 1, { w: l.bounds.w + 100, h: 600 }), { left: 0, top: 0 });
});

test(`WAN line stays ${WAN_CLEAR}px clear of the core title text`, () => {
  for (const measure of [undefined, (t, st) => approxMeasure(t, st) * 1.15]) {
    const l = lay("vlan:1", measure);
    assert.ok(l.wan, "fixture has a WAN line");
    const core = l.sections.find((s) => s.own);
    for (const lb of l.labels.filter((x) => x.section === core.name && (x.kind === "title" || x.kind === "count"))) {
      assert.ok(l.wan.x - lb.box.x1 >= WAN_CLEAR, `${lb.kind} "${lb.text}" ends ${l.wan.x - lb.box.x1}px from the WAN line`);
    }
    assert.deepEqual(checkText(l).filter((m) => m.startsWith("WAN")), []);
  }
});

test("mgmt line is VLAN arrow IP in 11px mono", () => {
  const l = lay();
  const ip = l.labels.find((x) => x.kind === "ip" && x.text.startsWith("VL1 "));
  assert.match(ip.text, /^VL1 → \d+\.\d+\.\d+\.\d+$/);
  assert.equal(ip.size, 11);
  assert.equal(ip.mono, true);
  const model10 = l.labels.find((x) => x.kind === "model");
  assert.equal(model10.mono, true, "same family as the model text");
});
