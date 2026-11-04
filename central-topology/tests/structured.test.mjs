// Structured (sections) layout: LAYOUT-SPEC §7 step 8 geometry checks. No
// crossings, no diagonals, no link through a faceplate, label, or header.
import test from "node:test";
import assert from "node:assert/strict";
import { topologyFromFixtures } from "./helpers.mjs";
import { buildModel } from "../site/js/model.js";
import { largeSample } from "../site/js/large-sample.js";
import { LAYOUTS, layoutById, modelForNeighborToggle } from "../site/js/layout.js";
import { checkLayout, checkText, stubLines } from "../site/js/structured.js";
import { renderSvg, TOKEN_NAMES } from "../site/js/render.js";
import { createRegistry, modelKey } from "../site/js/stencils.js";

const clean = (r) => ({ crossings: r.crossings, diagonal: r.diagonal, throughNodes: r.throughNodes, detail: r.detail });
const ok = { crossings: 0, diagonal: 0, throughNodes: 0, detail: [] };
const layout = (model) => layoutById("structured", model);
const TOKENS = Object.fromEntries(TOKEN_NAMES.map((t) => [t, "#123456"]));
const data = await topologyFromFixtures();

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

test("auto core on the wrong building: real links become stubs, still crossing-free", () => {
  const { data: d } = district([8, 6, 5]); // B0-CORE-01 has the highest degree, so it wins Auto core
  const model = buildModel(d);
  const lay = layout(model);
  assert.notEqual(lay.name(model.coreSerial), "DO-CORE-01");
  assert.deepEqual(clean(checkLayout(lay)), ok);
  assert.deepEqual(checkText(lay), []);
  // DO-CORE-01 heads its own section now; its links to the other heads are
  // listed in a "Links out" row inside that section, not drawn loose.
  const lo = lay.sections.find((s) => s.name === "District Office").linksOut;
  assert.ok(lo.length >= 2, "several links out share one row");
  assert.ok(lay.labels.some((x) => x.kind === "linksout-head" && x.section === "District Office"));
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

test("shared stubs show three labels, then +n more", () => {
  assert.deepEqual(stubLines(["a", "b"]), ["a", "b"]);
  assert.deepEqual(stubLines(["a", "b", "c", "d", "e"]), ["a", "b", "c", "+2 more"]);
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
