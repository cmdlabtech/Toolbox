// Structured (sections) layout: LAYOUT-SPEC §7 step 8 geometry checks. No
// crossings, no diagonals, no link through a faceplate, label, or header.
import test from "node:test";
import assert from "node:assert/strict";
import { topologyFromFixtures } from "./helpers.mjs";
import { buildModel } from "../site/js/model.js";
import { largeSample } from "../site/js/large-sample.js";
import { LAYOUTS, layoutById, modelForNeighborToggle } from "../site/js/layout.js";
import { checkLayout, checkText } from "../site/js/structured.js";
import { district44 } from "./fixtures/district44.mjs";
import { renderSvg, TOKEN_NAMES } from "../site/js/render.js";
import { createRegistry, modelKey } from "../site/js/stencils.js";

const clean = (r) => ({ crossings: r.crossings, diagonal: r.diagonal, throughNodes: r.throughNodes, detail: r.detail });
const ok = { crossings: 0, diagonal: 0, throughNodes: 0, detail: [] };
const layout = (model) => layoutById("structured", model);
const TOKENS = Object.fromEntries(TOKEN_NAMES.map((t) => [t, "#123456"]));
const data = await topologyFromFixtures();

// No line is cut off: both ends of every link sit on their own faceplate (or
// a core landing rail), no segment enters a section that is neither end's,
// a link inside one section stays inside it, and every link the tree cannot
// draw is drawn as a peer line.
function routeProblems(lay) {
  const out = [], e = 0.01;
  const inBox = (s, [x, y]) => x >= s.x - e && x <= s.x + s.w + e && y >= s.y - e && y <= s.y + s.h + e;
  const secOf = new Map([...lay.units.values()].map((u) => [u.id, lay.sections.find((s) => inBox(s, [(u.l + u.r) / 2, (u.ft + u.fb) / 2]))]));
  const onFace = (id, [x, y]) => {
    const u = lay.units.get(id);
    if (!u) return false;
    const rail = id === lay.coreSerial && (lay.rails ?? []).some((r) => (Math.abs(x - u.l) < e || Math.abs(x - u.r) < e) && y >= r.y0 - e && y <= r.y1 + e);
    const side = (Math.abs(x - u.l) < e || Math.abs(x - u.r) < e) && y >= u.ft - e && y <= u.fb + e;
    const cap = (Math.abs(y - u.ft) < e || Math.abs(y - u.fb) < e) && x >= u.l - e && x <= u.r + e;
    return rail || side || cap;
  };
  for (const l of lay.links) {
    if (l.decor) continue;
    const tag = `${l.kind} ${lay.name(l.a)}–${lay.name(l.b)}`, p = l.pts;
    if (!((onFace(l.a, p[0]) && onFace(l.b, p.at(-1))) || (onFace(l.b, p[0]) && onFace(l.a, p.at(-1))))) out.push(`${tag}: an end is off its faceplate`);
    const ends = new Set([secOf.get(l.a), secOf.get(l.b)]);
    for (let i = 1; i < p.length; i++) {
      const [x0, x1] = [p[i - 1][0], p[i][0]].sort((a, b) => a - b), [y0, y1] = [p[i - 1][1], p[i][1]].sort((a, b) => a - b);
      for (const s of lay.sections) if (!ends.has(s) && x1 > s.x + e && x0 < s.x + s.w - e && y1 > s.y + e && y0 < s.y + s.h - e) out.push(`${tag}: crosses ${s.name}`);
    }
    if (ends.size === 1 && l.kind === "peer" && !p.every((pt) => inBox([...ends][0], pt))) out.push(`${tag}: leaves its own section`);
  }
  const drawn = new Set(lay.links.map((l) => l.edge).filter(Boolean));
  for (const pe of lay.peerEdges) if (!drawn.has(pe)) out.push(`${lay.name(pe.from)}–${lay.name(pe.to)}: not drawn`);
  return out;
}

test("structured is in the picker, after the existing layouts", () => {
  assert.equal(LAYOUTS.at(-1).id, "structured");
  assert.equal(LAYOUTS.at(-1).label, "Structured (sections)");
  assert.equal(LAYOUTS[0].id, "hub", "hub stays the default");
});

test("mock tenant: sections around the core, crossing-free, LLDP neighbors on and off", () => {
  const full = buildModel(data);
  for (const shown of [true, false]) {
    const model = modelForNeighborToggle(full, shown);
    const lay = layout(model);
    assert.deepEqual(clean(checkLayout(lay)), ok, `LLDP ${shown}`);
    assert.deepEqual(checkText(lay), [], `LLDP ${shown} text`);
    const core = lay.sections.find((s) => s.own);
    assert.equal(core.name, "District Office");
    for (const s of lay.sections.filter((s) => !s.own)) {
      assert.ok(s.side === "L" ? s.x + s.w < core.x : s.x > core.x + core.w, `${s.name} sits in a wing`);
    }
    assert.equal(lay.switchCount, 22, "stack members count as switches");
    assert.equal(lay.pos.size, model.nodes.length, "every switch has a centre");
    // Nothing draws into the title band the app crops off the top.
    for (const s of lay.sections) assert.ok(s.y >= lay.bounds.y + 72, `${s.name} below the title band`);
    if (shown) assert.ok(lay.wan && lay.wan.unit.fb < core.y, "WAN band above the core site");
    else assert.equal(lay.wan, null, "no WAN band without LLDP neighbors");
  }
});

test("large sample stays crossing-free with every text rule met", () => {
  const sample = largeSample();
  const full = buildModel(sample, { coreSerial: sample.coreSerial });
  for (const shown of [true, false]) {
    const lay = layout(modelForNeighborToggle(full, shown));
    assert.equal(lay.geom.fw, 200, "one faceplate size; text never shrinks to fit");
    assert.deepEqual(clean(checkLayout(lay)), ok, `LLDP ${shown}`);
    assert.deepEqual(checkText(lay), [], `LLDP ${shown}`);
  }
});

// Synthetic district: one core plus k buildings with a hub and n access switches.
function district(sizes, { coreStack = 2 } = {}) {
  const switches = [], links = [];
  let id = 0;
  const sw = (name, site) => { const s = { serial: `S${String(++id).padStart(4, "0")}`, name, type: "Switch", model: "Aruba 6100 48G", status: "ONLINE", site, ipv4: `10.0.0.${id}`, vlans: [], interfaces: [] }; switches.push(s); return s; };
  const core = sw("DO-CORE-01", "District Office");
  for (let m = 2; m <= coreStack; m++) { const s = sw(`DO-CORE-0${m}`, "District Office"); s.conductorSerial = core.serial; s.deployment = "Stack"; }
  core.conductorSerial = coreStack > 1 ? core.serial : null;
  for (let a = 1; a <= 2; a++) links.push({ from: core.serial, to: sw(`DO-ACC-0${a}`, "District Office").serial, fromPort: `1/1/${a}`, toPort: "1/1/49", speedGbps: 10, source: "topology" });
  sizes.forEach((n, b) => {
    const site = `Bldg ${String.fromCharCode(65 + b)}`;
    const hub = sw(`B${b}-CORE-01`, site);
    links.push({ from: core.serial, to: hub.serial, fromPort: `1/1/${10 + b}`, toPort: "1/1/49", speedGbps: 40, source: "topology" });
    for (let a = 1; a <= n; a++) links.push({ from: hub.serial, to: sw(`B${b}-IDF-${a}`, site).serial, fromPort: `1/1/${a}`, toPort: "1/1/49", speedGbps: 10, source: "topology" });
  });
  return { data: { switches, externals: [], links, sites: [], warnings: [] }, overrides: { coreSerial: core.serial } };
}

test("synthetic districts of 1 to 14 buildings stay crossing-free", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let k = 1; k <= 14; k++) {
    const sizes = Array.from({ length: k }, () => 1 + Math.floor(rnd() * 8));
    const lay = layout(buildModel(...Object.values(district(sizes))));
    assert.deepEqual(clean(checkLayout(lay)), ok, `k=${k} sizes=${sizes}`);
    assert.deepEqual(checkText(lay), [], `k=${k} text`);
    assert.equal(lay.sections.length, k + 1);
  }
});

test("auto core on the wrong building: real links become peer lines, still crossing-free", () => {
  const { data: d } = district([8, 6, 5]); // B0-CORE-01 has the highest degree, so it wins Auto core
  const model = buildModel(d);
  const lay = layout(model);
  assert.notEqual(lay.name(model.coreSerial), "DO-CORE-01");
  assert.deepEqual(clean(checkLayout(lay)), ok);
  assert.deepEqual(checkText(lay), []);
  // DO-CORE-01 heads its own section now; its links to the other heads are
  // drawn as peer lines that reach both faceplates, not listed as text.
  const dc = [...lay.units.values()].find((u) => u.name === "DO-CORE-01").id;
  assert.ok(lay.links.filter((l) => l.kind === "peer" && (l.a === dc || l.b === dc)).length >= 2, "several peer lines from DO-CORE-01");
  assert.deepEqual(routeProblems(lay), []);
  assert.ok(!lay.labels.some((x) => /^linksout/.test(x.kind)), "no Links out row");
});

test("wing links land on the core at least 12px apart, in lane order", () => {
  let railed = 0;
  for (const coreStack of [1, 2, 3]) for (const k of [2, 6, 10, 14, 20]) {
    const lay = layout(buildModel(...Object.values(district(Array.from({ length: k }, (_, i) => 1 + (i % 4)), { coreStack }))));
    assert.deepEqual(clean(checkLayout(lay)), ok, `stack=${coreStack} k=${k}`);
    const core = [...lay.units.values()].find((u) => u.name === "DO-CORE-01");
    const coreSec = lay.sections.find((s) => s.own);
    for (const side of ["L", "R"]) {
      const ys = lay.landings[side] ?? [];
      ys.slice(1).forEach((y, i) => assert.ok(y - ys[i] >= 12 - 1e-9, `stack=${coreStack} k=${k} ${side} gap ${y - ys[i]}`));
      for (const y of ys) assert.ok(y > coreSec.y + lay.geom.titleBand && y < coreSec.y + coreSec.h, "landing stays inside the core site, below its header");
      const bb = lay.links.filter((l) => l.kind === "backbone" && l.b === lay.coreSerial && l.pts.at(-1)[0] === (side === "L" ? core.l : core.r));
      assert.deepEqual(bb.map((l) => l.pts.at(-1)[1]), ys);
      if (ys.length && (ys[0] < core.ft || ys.at(-1) > core.fb)) { railed++; assert.ok(lay.rails.some((r) => r.side === side && r.y0 <= ys[0] && r.y1 >= ys.at(-1)), "rail covers off-faceplate landings"); }
    }
  }
  assert.ok(railed > 0, "some cases outgrow the stack and use padding plus a rail");
});

test("no line is cut off: every link reaches both faceplates and only crosses its own sections", () => {
  const cases = [];
  const full = buildModel(data);
  for (const shown of [true, false]) cases.push([`mock LLDP ${shown}`, modelForNeighborToggle(full, shown)]);
  const sample = largeSample();
  const big = buildModel(sample, { coreSerial: sample.coreSerial });
  for (const shown of [true, false]) cases.push([`large LLDP ${shown}`, modelForNeighborToggle(big, shown)]);
  const d44 = district44();
  const m44 = buildModel(d44, { coreSerial: d44.coreSerial });
  for (const shown of [true, false]) cases.push([`district44 LLDP ${shown}`, modelForNeighborToggle(m44, shown)]);
  cases.push(["auto core", buildModel(district([8, 6, 5]).data)]);
  for (const k of [1, 3, 6, 10, 14]) cases.push([`synthetic k=${k}`, buildModel(...Object.values(district(Array.from({ length: k }, (_, i) => 1 + (i % 5)))))]);
  let peers = 0;
  for (const [name, model] of cases) {
    const lay = layout(model);
    assert.deepEqual(routeProblems(lay), [], name);
    assert.deepEqual(clean(checkLayout(lay)), ok, `${name} tree crossings`);
    peers += lay.links.filter((l) => l.kind === "peer").length;
  }
  assert.ok(peers > 10, "the cases include peer lines");
});

test("district44: links the tree cannot draw are peer lines, not text", () => {
  const d = district44();
  const lay = layout(buildModel(d, { coreSerial: d.coreSerial }));
  assert.ok(lay.peerEdges.length >= 10);
  // Peer lines may cross each other where one bus encloses another; the count
  // is a ratchet so a change cannot quietly make it worse.
  assert.ok(checkLayout(lay).peerCrossings <= 16, `peer crossings ${checkLayout(lay).peerCrossings}`);
  assert.ok(!lay.labels.some((x) => /^→ |^\+\d+ more$/.test(x.text)), "no → switch lists or +n more");
  assert.ok(!lay.labels.some((x) => x.kind === "stub" || /^linksout/.test(x.kind)), "no stub or Links out labels");
  // The IDF to core links that used to stop at a stub now land in the core site.
  const coreSec = lay.sections.find((s) => s.side === "C");
  const inCore = (id) => { const u = lay.units.get(id); return u.l >= coreSec.x && u.r <= coreSec.x + coreSec.w && u.ft >= coreSec.y && u.fb <= coreSec.y + coreSec.h; };
  assert.ok(lay.links.some((l) => l.kind === "peer" && l.cross && (inCore(l.a) || inCore(l.b))), "peer lines reach the core site");
  const svg = renderSvg(lay.model ?? buildModel(d, { coreSerial: d.coreSerial }), lay, { tokens: TOKENS, title: "t", subtitle: "s" });
  assert.equal((svg.match(/data-kind="peer"/g) ?? []).length, lay.links.filter((l) => l.kind === "peer").length, "every peer line is drawn");
});

test("stencil lookup order: model, part number, prefix, family, fallback", () => {
  const reg = createRegistry([
    { match: "6300M 48G", sku: "JL661A", href: "a" },
    { match: "6100", href: "b" },
    { match: "8360-32Y4C", href: "c" },
    { match: "", sku: "JL726A", href: "d" },
  ]);
  assert.equal(modelKey("Aruba 6300M 48G  Switch"), "6300m 48g");
  assert.equal(reg.lookup("Aruba 6300M 48G").how, "model");
  assert.equal(reg.lookup("Aruba 6200F 48G", "JL726A").how, "part number");
  assert.equal(reg.lookup("Aruba 6100 24G").how, "prefix");
  assert.equal(reg.lookup("8360-16Y2C").how, "family");
  assert.equal(reg.lookup("2930F 48G"), null);
  assert.equal(reg.lookup(null), null);
});

test("family match needs a leading digit; vendor words and part numbers fall through", () => {
  const reg = createRegistry([{ match: "Aruba Instant On 1930", href: "x" }, { match: "JL676A spare", href: "y" }, { match: "6100 48G", href: "z" }]);
  assert.equal(reg.lookup("Aruba Something Else"), null);
  assert.equal(reg.lookup("JL676A"), null);
  assert.equal(reg.lookup("6100 12G").how, "family");
});

test("render: stack ordered by member id, black stack connector, one <defs> image per stencil", () => {
  const { data: d, overrides } = district([8, 6, 5], { coreStack: 2 });
  for (const s of d.switches) s.jNumber = "JL676A";
  d.switches.find((s) => s.name === "DO-CORE-01").stackMemberId = 2;
  d.switches.find((s) => s.name === "DO-CORE-02").stackMemberId = 1;
  const model = buildModel(d, overrides);
  assert.deepEqual(model.byId.get(model.coreSerial).stack.map((m) => [m.name, m.memberId]), [["DO-CORE-02", 1], ["DO-CORE-01", 2]]);
  const lay = layout(model);
  const plain = renderSvg(model, lay, { tokens: { ...TOKENS, "--link-stack": "#000000" }, title: "t", subtitle: "s" });
  assert.match(plain, /class="stack-link"[^>]*fill="#000000"/, "stack connector drawn in the stack token");
  assert.ok(!plain.includes("<image"), "no art without stencils");
  const reg = createRegistry([{ match: "", sku: "JL676A", href: "data:image/svg+xml;base64,AAAA" }]);
  const svg = renderSvg(model, lay, { tokens: TOKENS, title: "t", subtitle: "s", stencils: reg });
  assert.equal(svg.match(/<image id=/g).length, 1, "art stored once");
  assert.equal(svg.match(/<use href="#fp-0"/g).length, d.switches.length, "every faceplate uses it");
});

test("render: mock tenant draws every switch name and stays inside its viewBox", () => {
  const model = buildModel(data);
  const lay = layout(model);
  const svg = renderSvg(model, lay, { tokens: TOKENS, mgmt: "monitor", title: "Switch topology", subtitle: "structured" });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  for (const n of model.nodes) for (const m of n.stack ?? [n]) assert.ok(svg.includes(m.name) || svg.includes(n.name), m.name);
  const vb = svg.match(/viewBox="(-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+)"/).slice(1).map(Number);
  assert.deepEqual(vb, [lay.bounds.x, lay.bounds.y, lay.bounds.w, lay.bounds.h]);
});
