// Structured (sections) layout, after Riri's LAYOUT-SPEC and TEXT-SPEC. Pure
// function: model in, geometry, routed orthogonal polylines, and every text
// label out. structured-render.js draws it; the card layouts in layout.js do
// not share this geometry.
//   Spine: Internet cloud, firewall, then the core-site section.
//   Wings: every other building is a section box on the left or right.
//   Routes: risers inside a section, nested-L spine routes from the core to
//   each building core, one WAN lane. Each kind is crossing-free by
//   construction. Links outside that tree are peer routes: a bus per hub
//   switch that runs in the section margins, gutter, and bottom channel, and
//   leaves the section through outer channels when its peer is elsewhere.
// Text is measured (opts.measure, the real font in the browser) and every
// label is emitted in out.labels with its box, so columns size to their
// content and tests can check that no text leaves its cell or section.
import { resolveMgmt } from "./model.js";

export const GEOM = {
  fw: 200, fh: 18, sgap: 6, collapseOver: 4,
  nameH: 16, lineH: 14, faceGap: 4, laneEdge: 4, tapSpread: 5, channelGap: 8, outerGap: 12,
  titleBand: 32, headGap: 12, rowGap: 12, bottomPad: 16, pad: 16,
  colMin: 160, colMax: 280, cellPad: 8, gutter: 24, lane: 6, laneInset: 6, textInset: 7,
  badgeR: 7, badgeInset: 4, badgeReserve: 22, square: 14,
  secgap: 24, spinePitch: 10, spineInset: 18, canvasPad: 40, titleH: 112, landingGap: 12,
};

/** TEXT-SPEC type scale, in user units (1x). */
export const TYPE = {
  title: { size: 13, weight: 700, ls: 0.52 },
  count: { size: 12, weight: 400 },
  name: { size: 12.5, weight: 700 },
  sub: { size: 11, weight: 400 },
  ip: { size: 11, weight: 400, mono: true },
  model: { size: 10, weight: 500, mono: true },
  badge: { size: 10, weight: 700 },
};
/** No structured text is drawn below this many screen px. */
export const MIN_FONT_PX = 10;

export const WAN_CLEAR = 8;
/** Gap between a VSX pair's box and its members' cells. */
export const VSX_PAD = 5;
const WAN_RE = /firewall|router|sd-?wan/i;
const SLOT_RE = /gateway|controller/i;
const AP_RE = /access point/i;
const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const memberOf = (port) => Number(/^(\d+)\/\d+\/\d+/.exec(port ?? "")?.[1] ?? 1);

// Width table for Node and tests: em per glyph, a little wider than Inter and
// the monospace fallback in Chrome so test geometry errs on the roomy side.
const NARROW = new Set([..."iIjlt.,:;'|!()[] fr1/"]);
const WIDE = new Set([..."MWmw@%"]);
/** Approximate text width in px. The browser passes a canvas measurer instead. */
export function approxMeasure(text, st = {}) {
  const s = String(text ?? ""), size = st.size ?? 12;
  let em = 0;
  for (const c of s) {
    if (st.mono) { em += 0.61; continue; }
    em += NARROW.has(c) ? 0.31 : WIDE.has(c) ? 0.9 : /[A-Z]/.test(c) ? 0.7 : /[0-9]/.test(c) ? 0.6 : c === "·" || c === "…" ? 0.5 : c === "→" ? 0.85 : c === "–" || c === "—" ? 0.7 : /[a-z]/.test(c) ? 0.56 : 0.6;
  }
  const bold = !st.mono && (st.weight ?? 400) >= 600 ? 1.06 : 1;
  return em * size * bold + (st.ls ?? 0) * [...s].length;
}

/** Longest prefix of text, plus an ellipsis, that fits maxW. */
export function ellipsize(text, st, maxW, measure = approxMeasure) {
  const s = String(text ?? "");
  if (measure(s, st) <= maxW) return s;
  const chars = [...s];
  let lo = 0, hi = chars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(chars.slice(0, mid).join("").trimEnd() + "…", st) <= maxW) lo = mid; else hi = mid - 1;
  }
  return lo ? chars.slice(0, lo).join("").trimEnd() + "…" : "";
}

export const shortModel = (m) => String(m ?? "").replace(/^(aruba|hpe)\s+/i, "").replace(/\s+switch$/i, "").trim();
/** Model family: words up to the first one with a digit ("CX 6300M"). */
export function modelFamily(m) {
  const words = shortModel(m).split(/\s+/).filter(Boolean);
  const i = words.findIndex((w) => /\d/.test(w));
  return (i >= 0 ? words.slice(0, i + 1) : words.slice(0, 2)).join(" ");
}
const serialNamed = (n) => !String(n?.name ?? "").trim() || n.name === n.serial;
/** Display name: the switch name, or model family plus serial tail for unnamed switches. */
export function displayName(n) {
  if (!n) return "";
  if (!serialNamed(n)) return n.name;
  return `${modelFamily(n.model) || "Switch"} · ${String(n.serial ?? "").slice(-4)}`;
}
/** The management line under a switch name, from the selected Mgmt IP option. */
export function mgmtText(m, optionId) {
  if (!m?.ip) return "—";
  if (m.fallback || m.source === "monitor") return m.ip;
  if (optionId?.startsWith("vlan:")) return `VL${optionId.slice(5)} → ${m.ip}`;
  return `${optionId === "oobm" ? "OOBM" : "Lo"} → ${m.ip}`;
}

// Text box from a baseline: ascent and descent as fractions of the size.
function textBox(x, base, w, size, anchor) {
  const x0 = anchor === "end" ? x - w : anchor === "middle" ? x - w / 2 : x;
  return { x0, x1: x0 + w, y0: base - 0.8 * size, y1: base + 0.24 * size };
}

// VSX pairs. Two switches in one building are a pair when at least two
// switches dual-home to both over one LAG (MC-LAG, the VSX signature), or
// when their names say VSX and differ only by a trailing member number.
// Stacks are not VSX members. Each switch joins at most one pair.
const twinBase = (name) => (/vsx/i.test(name ?? "") ? /^(.*?)[-_ ]?\d+$/.exec(name)?.[1]?.toLowerCase() ?? null : null);
export function vsxPairs(model) {
  const byId = model.byId ?? new Map(model.nodes.map((n) => [n.serial, n]));
  const sw = (id) => { const n = byId.get(id); return n && !n.stack ? n : null; };
  const lagsAt = (e, id) => new Set(((id === e.from ? e.fromPorts : e.toPorts) ?? []).map((p) => p.lag).filter(Boolean));
  const ups = new Map(); // child -> [{ up, lags }]
  for (const e of model.edges) {
    if (e.external) continue;
    for (const [c, up] of [[e.from, e.to], [e.to, e.from]]) {
      const lags = lagsAt(e, c);
      if (lags.size && byId.has(c) && sw(up)) ups.set(c, [...(ups.get(c) ?? []), { up, lags }]);
    }
  }
  const score = new Map();
  for (const list of ups.values()) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j];
    if (![...a.lags].some((l) => b.lags.has(l))) continue;
    const k = key(a.up, b.up);
    score.set(k, (score.get(k) ?? 0) + 1);
  }
  const cand = [];
  for (const [k, n] of score) if (n >= 2) cand.push([k, n]);
  const nodes = model.nodes.filter((n) => !n.stack && twinBase(n.name));
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    if (twinBase(nodes[i].name) === twinBase(nodes[j].name)) cand.push([key(nodes[i].serial, nodes[j].serial), 1]);
  }
  const used = new Set(), out = [];
  for (const [k] of cand.sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))) {
    const [a, b] = k.split("|");
    const na = sw(a), nb = sw(b);
    if (!na || !nb || used.has(a) || used.has(b) || na.building !== nb.building) continue;
    used.add(a); used.add(b);
    out.push([na, nb].sort((x, y) => x.name.localeCompare(y.name)).map((n) => n.serial));
  }
  return out;
}

export function layoutStructured(model, opts = {}) {
  const measure = opts.measure ?? approxMeasure;
  const mgmt = opts.mgmt ?? "monitor";
  const g = GEOM;
  const { nodes, byId, coreSerial } = model;
  const nsw = nodes.reduce((a, n) => a + (n.stack?.length ?? 1), 0);
  // pos/extPos hold each drawn unit's centre so callers that look a switch up
  // by position still find it. Drag pins do not apply (app.js skips them).
  const out = { kind: "structured", pos: new Map(), extPos: new Map(), sectors: [], geom: g, units: new Map(), sections: [], links: [], labels: [], wan: null, mgmt,
    bounds: { x: -300, y: -300, w: 600, h: 600 }, name: (id) => displayName(byId.get(id)) || id };
  if (!coreSerial) return out;
  const core = byId.get(coreSerial);
  const edgeBy = new Map(model.edges.map((e) => [key(e.from, e.to), e]));
  const extBy = new Map(model.externals.map((x) => [x.serial, x]));
  out.name = (id) => (byId.has(id) ? displayName(byId.get(id)) : extBy.get(id)?.name ?? id);
  const drawn = new Set(); // link keys represented on the canvas

  // Units: a name block plus faceplate(s).
  const unit = (id) => {
    let u = out.units.get(id);
    if (u) return u;
    const n = byId.get(id), x = extBy.get(id);
    const members = n?.stack?.length ?? 1;
    const collapsed = members > g.collapseOver ? members : 0;
    const m = n ? resolveMgmt(n, mgmt) : null;
    u = { id, node: n ?? null, ext: x ?? null, name: n ? displayName(n) : x?.name ?? id, model: n?.model ?? x?.model ?? x?.type ?? null,
      role: n?.role ?? "ext", n: collapsed ? 1 : members, collapsed, mgmt: m, ipText: n ? mgmtText(m, mgmt) : null,
      warn: !!(n && (m.fallback || n.flags.length)) };
    out.units.set(id, u);
    return u;
  };
  const stackH = (k) => k * g.fh + (k - 1) * g.sgap;
  const textH = (u) => g.nameH + (u.via ? g.lineH : 0) + (u.node ? g.lineH : 0);
  const cellH = (u) => textH(u) + g.faceGap + stackH(u.n);
  const place = (u, x, y) => { u.x = x; u.y = y; u.l = x; u.r = x + g.fw; u.ft = y + textH(u) + g.faceGap; u.fb = u.ft + stackH(u.n); u.mid = u.ft + g.fh / 2; u.bottom = y + cellH(u); };
  // Attach y on a stack member named by a CX port (m/s/p), else member 1.
  const memberMid = (u, port) => {
    const id = memberOf(port), at = u.node?.stack?.findIndex((s) => s.memberId === id) ?? -1;
    const m = Math.min(Math.max(at >= 0 ? at + 1 : id, 1), u.n) - 1;
    return u.ft + m * (g.fh + g.sgap) + g.fh / 2;
  };

  // Externals: WAN band, section slot, AP count, or a plain slot.
  const localOf = new Map();
  for (const e of model.edges.filter((e) => e.external)) {
    const local = byId.has(e.from) ? e.from : e.to, other = local === e.from ? e.to : e.from;
    if (!localOf.has(other)) localOf.set(other, local);
  }
  const wanDevs = [], slots = new Map(), aps = new Map();
  for (const x of [...model.externals].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))) {
    const local = localOf.get(x.serial);
    if (!local) continue;
    const b = byId.get(local).building;
    if (WAN_RE.test(`${x.type ?? ""} ${x.model ?? ""}`) && !wanDevs.length) wanDevs.push({ x, local });
    else if (AP_RE.test(x.type ?? "")) { aps.set(b, (aps.get(b) ?? 0) + 1); drawn.add(key(x.serial, local)); }
    else slots.set(b, [...(slots.get(b) ?? []), x.serial]);
  }

  // Sections and their columns (topology only; geometry comes later).
  const byHop = (a, b) => (a.hop ?? 99) - (b.hop ?? 99) || out.name(a.serial).localeCompare(out.name(b.serial));
  const secs = [];
  const pairsAll = vsxPairs(model);
  for (const b of model.buildings) {
    const members = nodes.filter((n) => n.building === b);
    if (!members.length) continue;
    const own = b === core.building;
    const headId = own ? coreSerial : model.hubs[b] && byId.get(model.hubs[b])?.building === b ? model.hubs[b] : [...members].sort((a, c) => out.name(a.serial).localeCompare(out.name(c.serial)))[0].serial;
    const access = members.filter((n) => n.serial !== headId).sort(byHop).map((n) => n.serial);
    // A VSX pair (neither the head) leads the access list, so its members
    // share the first row, one per column.
    const pair = pairsAll.find((p) => p.every((id) => access.includes(id))) ?? null;
    if (pair) access.splice(0, access.length, ...pair, ...access.filter((id) => !pair.includes(id)));
    secs.push({ name: b, own, head: headId, pair, access: [...access, ...(slots.get(b) ?? [])], aps: aps.get(b) ?? 0,
      unassigned: b === "Unassigned", nsw: members.reduce((a, n) => a + (n.stack?.length ?? 1), 0) });
  }
  const secOf = new Map();
  for (const s of secs) { unit(s.head); secOf.set(s.head, s); for (const id of s.access) { unit(id); secOf.set(id, s); } }
  const wanUnit = wanDevs.length ? unit(wanDevs[0].x.serial) : null;

  // Represented links: WAN, backbone (every non-core section head), risers.
  if (wanUnit) {
    const { x, local } = wanDevs[0];
    drawn.add(key(x.serial, local));
    if (local !== coreSerial) wanUnit.via = out.name(local);
  }
  for (const s of secs) {
    if (!s.own && edgeBy.has(key(s.head, coreSerial))) drawn.add(key(s.head, coreSerial));
    for (const id of s.access) {
      const u = unit(id), n = byId.get(id);
      if (edgeBy.has(key(id, s.head))) drawn.add(key(id, s.head));
      else if (n?.parent && n.parent !== s.head && byId.get(n.parent)?.building === s.name) { u.via = out.name(n.parent); drawn.add(key(id, n.parent)); }
      else if (u.ext && localOf.get(id) && localOf.get(id) !== s.head) { u.via = out.name(localOf.get(id)); drawn.add(key(id, localOf.get(id))); }
    }
  }
  // VSX: a switch drawn to one member reaches the other over the same
  // MC-LAG. The pair box stands for that second leg, so it is not routed.
  out.vsx = [];
  for (const s of secs) {
    if (!s.pair) continue;
    const [p, q] = s.pair, absorbed = [];
    for (const id of s.access) {
      const up = s.pair.find((m) => drawn.has(key(id, m)));
      const other = up && s.pair.find((m) => m !== up);
      if (other && !drawn.has(key(id, other)) && edgeBy.has(key(id, other))) { drawn.add(key(id, other)); absorbed.push(edgeBy.get(key(id, other))); }
    }
    if (edgeBy.has(key(p, q))) { drawn.add(key(p, q)); absorbed.push(edgeBy.get(key(p, q))); }
    out.vsx.push({ members: s.pair, section: s, absorbed });
  }

  // Every other link between drawn units is a peer route. Routes group into
  // buses, one per hub: the end with more peer links (then the name). A bus
  // draws as one line that branches, so its routes may share lanes.
  const peerEdges = model.edges.filter((e) => !drawn.has(key(e.from, e.to)) && out.units.has(e.from) && out.units.has(e.to) && e.from !== e.to);
  const deg = new Map();
  for (const e of peerEdges) for (const id of [e.from, e.to]) deg.set(id, (deg.get(id) ?? 0) + 1);
  const buses = new Map();
  for (const e of peerEdges) {
    drawn.add(key(e.from, e.to));
    const [hub, other] = [e.from, e.to].sort((a, b) => deg.get(b) - deg.get(a) || out.name(a).localeCompare(out.name(b)) || (a < b ? -1 : 1));
    if (!buses.has(hub)) buses.set(hub, { id: buses.size, hub, routes: [] });
    buses.get(hub).routes.push({ e, other, hubPort: hub === e.from ? e.fromPort : e.toPort, otherPort: hub === e.from ? e.toPort : e.fromPort });
  }
  const busList = [...buses.values()];
  for (const b of busList) b.secs = new Set([secOf.get(b.hub), ...b.routes.map((r) => secOf.get(r.other))]);

  // Column of each access unit, per section side.
  const columns = (sec, side) => {
    const acc = sec.access.map(unit), n = acc.length;
    return n <= 3 ? (side !== "R" ? [acc, []] : [[], acc]) : [acc.filter((_, i) => i % 2 === 0), acc.filter((_, i) => i % 2 === 1)];
  };
  // Width a unit needs inside a column (text starts textInset in from the faceplate).
  const textNeed = (u) => g.textInset + Math.max(measure(u.name, TYPE.name), u.via ? measure(`via ${u.via}`, TYPE.sub) : 0, u.ipText ? measure(u.ipText, TYPE.ip) : 0);

  // Section layout at (x0, y0). side: "L" (inner edge right), "R", or "C".
  // pad: extra space above and below the head unit (core landings, LAYOUT-SPEC §5).
  function layoutSection(sec, side, x0, y0, pad = 0) {
    const bc = unit(sec.head);
    const [L, R] = columns(sec, side);
    // Peer lanes: each bus that touches this section gets a lane on every
    // side it uses (left margin, right margin, gutter for the head), and a
    // bottom channel when it joins sides or leaves a wing section.
    const sideIn = new Map([[bc.id, "h"], ...L.map((u) => [u.id, "l"]), ...R.map((u) => [u.id, "r"])]);
    const lanes = { l: [], r: [], h: [], b: [] }, busAt = new Map();
    for (const b of busList) {
      if (!b.secs.has(sec)) continue;
      const sides = new Set([b.hub, ...b.routes.map((r) => r.other)].filter((id) => secOf.get(id) === sec).map((id) => sideIn.get(id)));
      for (const sd of sides) lanes[sd].push(b);
      if (sides.size > 1 || (b.secs.size > 1 && side !== "C")) lanes.b.push(b);
      busAt.set(b, {});
    }
    // Lane order. Buses that leave run outermost; the rest nest by the row
    // they start on, outer lanes on deeper bottom channels. A wing section's
    // leaving buses turn toward its outer edge on their channel, so on that
    // side the outer lane takes the shallower channel, and on the other side
    // the deeper one.
    const row = (id) => (id === bc.id ? -1 : Math.max(L.findIndex((u) => u.id === id), R.findIndex((u) => u.id === id)));
    const top = (b) => Math.min(...[b.hub, ...b.routes.map((r) => r.other)].filter((id) => secOf.get(id) === sec).map(row));
    const byTop = (x, y) => top(x) - top(y) || x.id - y.id;
    const leaves = (b) => b.secs.size > 1;
    for (const sd of ["l", "r", "h"]) {
      const out = lanes[sd].filter(leaves).sort(byTop), stay = lanes[sd].filter((b) => !leaves(b)).sort(byTop);
      const toward = side === "L" ? "l" : side === "R" ? "r" : sd;
      lanes[sd] = [...(sd === toward ? out : out.reverse()), ...stay];
    }
    lanes.b = [...lanes.b.filter((b) => !leaves(b)).sort(byTop).reverse(), ...lanes.b.filter(leaves).sort(byTop)];
    const margin = (n) => (n ? 2 * g.laneEdge + n * g.lane : 0);
    const offL = margin(lanes.l.length), offR = margin(lanes.r.length);
    const need = Math.max(g.fw, textNeed(bc),
      ...L.map((u) => offL + Math.max(g.fw, textNeed(u))),
      ...R.map((u) => Math.max(g.fw, textNeed(u)) + offR));
    const colW = Math.min(Math.max(need + g.cellPad, g.colMin), g.colMax);
    const Wg = Math.max(g.gutter, g.lane * (L.length + R.length + 1 + lanes.h.length));
    const p = g.pad, fw = g.fw;
    let inner, gc;
    if (L.length && R.length) { gc = colW + Wg / 2; inner = 2 * colW + Wg; }
    else if (L.length) { gc = colW + Wg / 2; inner = gc - fw / 2 + colW; }
    else if (R.length) { gc = fw / 2; inner = fw / 2 + Wg / 2 + colW; }
    else { gc = fw / 2; inner = colW; }
    const W = inner + 2 * p, ix0 = x0 + p, ix1 = x0 + p + inner;
    place(bc, ix0 + gc - fw / 2, y0 + g.titleBand + g.headGap + pad);
    bc.cell = { x0: bc.l, x1: Math.min(bc.l + colW, ix1) };
    let y = bc.bottom + pad + g.rowGap;
    const gl = ix0 + gc - Wg / 2, gr = ix0 + gc + Wg / 2;
    for (let r = 0; r < Math.max(L.length, R.length); r++) {
      const row = [];
      if (r < L.length) { const u = L[r]; place(u, gl - colW + offL, y); u.cell = { x0: gl - colW, x1: gl }; u.outer = "l"; row.push(u); }
      // Right-column text stops before the right margin's peer lanes.
      if (r < R.length) { const u = R[r]; place(u, gr, y); u.cell = { x0: gr, x1: gr + colW }; u.outer = "r"; u.textMax = offR ? colW - offR : undefined; row.push(u); }
      y = Math.max(...row.map((u) => u.bottom)) + g.rowGap;
    }
    let bottom = y - g.rowGap;
    if (!sec.access.length) bottom = bc.bottom + pad;
    const risers = [];
    L.forEach((a, r) => { const lx = gl + g.laneInset + r * g.lane; risers.push({ a, pts: [[lx, bc.fb], [lx, a.mid], [a.r, a.mid]] }); });
    R.forEach((a, r) => { const lx = gr - g.laneInset - r * g.lane; risers.push({ a, pts: [[lx, bc.fb], [lx, a.mid], [a.l, a.mid]] }); });
    // Lane positions. Head lanes take the gutter slots after the left risers,
    // so no riser tap crosses them.
    lanes.l.forEach((b, i) => { busAt.get(b).l = gl - colW + g.laneEdge + i * g.lane; });
    lanes.r.forEach((b, i) => { busAt.get(b).r = gr + colW - g.laneEdge - i * g.lane; });
    lanes.h.forEach((b, i) => { busAt.get(b).h = gl + g.laneInset + (L.length + i) * g.lane; });
    lanes.b.forEach((b, i) => { busAt.get(b).b = bottom + g.channelGap + i * g.lane; });
    if (lanes.b.length) bottom += g.channelGap + (lanes.b.length - 1) * g.lane;
    Object.assign(sec, { x: x0, y: y0, w: W, h: bottom + g.bottomPad - y0, side, risers, colW, gutter: Wg, inner: { x0: ix0, x1: ix1 }, busAt, sideIn });
    bc.outer = side === "L" ? "l" : "r";
  }

  // Wings: biggest first into the shorter wing (tie left), alphabetical
  // within. Heights come from the measured section layout.
  const others = secs.filter((s) => !s.own && !s.unassigned);
  const meas = new Map();
  for (const s of [...others, ...secs.filter((s) => s.unassigned)]) { layoutSection(s, "L", 0, 0); meas.set(s, s.h); }
  const wings = { L: [], R: [] }, hh = { L: 0, R: 0 };
  for (const s of [...others].sort((a, b) => meas.get(b) - meas.get(a) || a.name.localeCompare(b.name))) {
    const side = hh.L <= hh.R ? "L" : "R";
    wings[side].push(s); hh[side] += meas.get(s) + g.secgap;
  }
  for (const side of ["L", "R"]) wings[side].sort((a, b) => a.name.localeCompare(b.name));
  const un = secs.find((s) => s.unassigned);
  if (un) wings[hh.L <= hh.R ? "L" : "R"].push(un);

  // Core site at the origin. Wing links land on the core's outer ends at
  // least LANDING_GAP apart; when a wing has more links than the stack has
  // height, the core site grows top and bottom padding to make room.
  const coreSec = secs.find((s) => s.own);
  const cu = unit(coreSerial);
  const kmax = Math.max(wings.L.length, wings.R.length);
  const span = stackH(cu.n) - 6, need = (kmax - 1) * g.landingGap;
  const corePad = Math.max(0, Math.ceil((need - span) / 2));
  layoutSection(coreSec, "C", 0, 0, corePad);
  out.landings = {};
  out.rails = [];
  out.coreSerial = coreSerial;

  // WAN band above the core site. The lane leaves the core faceplate top
  // through its name block, so core text ends before the lane, and the
  // section title ends before it too.
  if (wanUnit) {
    const { x, local } = wanDevs[0];
    const wanX = Math.min(Math.max(cu.l + textNeed(cu) + 10, cu.l + g.fw / 2), cu.r - 30);
    cu.textMax = wanX - 8 - cu.l;
    // Title text stays WAN_CLEAR clear of the WAN line, plus room for glyph overhang.
    coreSec.titleMax = wanX - WAN_CLEAR - 2 - coreSec.inner.x0;
    const off = Math.min(Math.max(textNeed(wanUnit) + 8, g.fw / 2), g.fw - 12);
    const fx = Math.min(Math.max(wanX - off, coreSec.inner.x0), coreSec.inner.x1 - g.fw);
    place(wanUnit, fx, -cellH(wanUnit) - 46);
    wanUnit.cell = { x0: fx, x1: fx + g.fw };
    wanUnit.textMax = wanX - 8 - fx;
    const cloud = { x: wanX, y: wanUnit.y - 46 };
    const e = edgeBy.get(key(x.serial, local));
    const via = local !== coreSerial ? out.name(local) : null;
    out.links.push({ kind: "wan", a: coreSerial, b: x.serial, edge: via ? null : e, pts: [[wanX, cu.ft], [wanX, wanUnit.fb]], via });
    out.links.push({ kind: "wan", a: x.serial, b: "internet", edge: null, decor: true, pts: [[wanX, wanUnit.ft], [wanX, cloud.y + 14]] });
    out.wan = { x: wanX, cloud, unit: wanUnit };
  }

  const top = out.wan ? out.wan.cloud.y - 30 : -Infinity;
  for (const side of ["L", "R"]) {
    const wing = wings[side];
    if (!wing.length) continue;
    const k = wing.length, Sg = 40 + k * 10;
    const boxEdge = side === "L" ? coreSec.x : coreSec.x + coreSec.w;
    const wingInner = side === "L" ? boxEdge - Sg : boxEdge + Sg;
    const total = wing.reduce((a, s) => a + meas.get(s), 0) + g.secgap * (k - 1);
    let y = Math.max(coreSec.y + coreSec.h / 2 - total / 2, top);
    for (const s of wing) {
      // Measure with the real side so one-column sections sit on the outer side.
      layoutSection(s, side, 0, 0);
      const w = s.w;
      layoutSection(s, side, side === "L" ? wingInner - w : wingInner, y);
      y += s.h + g.secgap;
    }
    // Core ports spread over the solid faceplate height, skipping stack gaps.
    // Below the minimum gap, fall back to an even LANDING_GAP pitch centred
    // on the stack, and draw a landing rail on that end of the core.
    const tot = cu.n * g.fh;
    const ymap = (t) => { const m = Math.min(Math.floor(t / g.fh), cu.n - 1); return cu.ft + m * (g.fh + g.sgap) + (t - m * g.fh); };
    let ports = wing.map((_, i) => ymap(((i + 0.5) / k) * tot));
    if (ports.some((y, i) => i && y - ports[i - 1] < g.landingGap)) {
      const mid = (cu.ft + cu.fb) / 2;
      ports = wing.map((_, i) => mid + (i - (k - 1) / 2) * g.landingGap);
      out.rails.push({ side, x: side === "L" ? cu.l - 3 : cu.r, y0: Math.min(ports[0] - 3, cu.ft), y1: Math.max(ports[k - 1] + 3, cu.fb) });
    }
    out.landings[side] = ports;
    // Nested-L ranks: rising routes rank topmost first, dropping routes bottommost first.
    const ys = wing.map((s) => { const e = edgeBy.get(key(s.head, coreSerial)); const hp = e ? (e.from === s.head ? e.fromPort : e.toPort) : null; return memberMid(unit(s.head), hp); });
    const down = wing.map((_, i) => i).filter((i) => ys[i] < ports[i] - 0.5);
    const up = wing.map((_, i) => i).filter((i) => ys[i] > ports[i] + 0.5);
    const rank = new Map();
    down.forEach((i, j) => rank.set(i, j));
    [...up].reverse().forEach((i, j) => rank.set(i, j));
    const sgn = side === "L" ? 1 : -1, coreEdge = side === "L" ? cu.l : cu.r;
    wing.forEach((s, i) => {
      const bc = unit(s.head), start = side === "L" ? bc.r : bc.l, y = ys[i];
      const e = edgeBy.get(key(s.head, coreSerial)) ?? null;
      const lane = boxEdge - sgn * (g.spineInset + (rank.get(i) ?? 0) * g.spinePitch);
      const pts = rank.has(i) ? [[start, y], [lane, y], [lane, ports[i]], [coreEdge, ports[i]]] : [[start, y], [coreEdge, ports[i]]];
      out.links.push({ kind: "backbone", a: s.head, b: coreSerial, edge: e, pts });
    });
  }

  // Risers: the real link when one exists; a daisy chain draws from the riser
  // bus with a "via NAME" note and keeps the real upstream link as represented.
  for (const s of secs) {
    for (const r of s.risers) {
      const id = r.a.id, e = edgeBy.get(key(id, s.head)) ?? null;
      const slotKind = r.a.ext && SLOT_RE.test(r.a.ext.type ?? "") ? "backbone" : "access";
      out.links.push({ kind: slotKind, a: s.head, b: id, edge: e, pts: r.pts, via: r.a.via ?? null });
    }
  }

  // Peer routes. Each end taps its faceplate's outer end (a head drops from
  // its faceplate bottom into the gutter), runs its bus lane to the bottom
  // channel, and joins the other end in the same section, or leaves: a wing
  // section through its outer channel, the core site straight down, and the
  // two meet on the canvas bottom channel.
  const placedSecs = secs.filter((s) => s.busAt);
  const wingL = placedSecs.filter((s) => s.side === "L"), wingR = placedSecs.filter((s) => s.side === "R");
  const leaving = busList.filter((b) => b.secs.size > 1);
  // Canvas channels nest the same way: a bus between two sections of one wing
  // runs innermost, then one that drops straight out of the core site, then
  // the bus that leaves its section lowest.
  const exitY = (b) => Math.max(...[...b.secs].map((s) => (s.side === "C" ? -Infinity : s.busAt.get(b).b)));
  const coreOut = (b) => [...b.secs].some((s) => s.side === "C");
  const oneSide = (b) => [...b.secs].every((s) => s.side === [...b.secs][0].side);
  const chan = new Map([...leaving].sort((x, y) => oneSide(y) - oneSide(x) || coreOut(y) - coreOut(x) || exitY(y) - exitY(x) || x.id - y.id).map((b, i) => [b, i]));
  const xgL = Math.min(...wingL.map((s) => s.x)) - g.outerGap, xgR = Math.max(...wingR.map((s) => s.x + s.w)) + g.outerGap;
  const ygBase = Math.max(...placedSecs.map((s) => s.y + s.h)) + g.outerGap;
  const gx = (s, b) => (s.side === "L" ? xgL - chan.get(b) * g.lane : xgR + chan.get(b) * g.lane);
  const yg = (b) => ygBase + chan.get(b) * g.lane;
  // Taps: one y per bus on each unit end, spread when buses share a member.
  const taps = new Map();
  const tapY = (u, b, port) => {
    const base = memberMid(u, port), k = `${u.id}|${base}`;
    if (!taps.has(k)) taps.set(k, []);
    const list = taps.get(k);
    if (!list.includes(b)) list.push(b);
    return { base, k };
  };
  for (const b of busList) { const r0 = b.routes[0]; tapY(unit(b.hub), b, r0.hubPort); for (const r of b.routes) { tapY(unit(b.hub), b, r.hubPort); tapY(unit(r.other), b, r.otherPort); } }
  const tapAt = (u, b, port) => {
    const { base, k } = tapY(u, b, port), list = taps.get(k), i = list.indexOf(b);
    const off = Math.max(-(g.fh / 2 - 2), Math.min(g.fh / 2 - 2, (i - (list.length - 1) / 2) * g.tapSpread));
    return base + off;
  };
  // An end's way from its faceplate to its lane: points, then the lane x.
  const leg = (id, b, port) => {
    const u = unit(id), s = secOf.get(id), sd = s.sideIn.get(id), at = s.busAt.get(b);
    if (sd === "h") return { s, x: at.h, pts: [[at.h, u.fb]] };
    const y = tapAt(u, b, port), x = at[sd];
    return { s, x, pts: [[sd === "l" ? u.l : u.r, y], [x, y]] };
  };
  // From the lane out of the section, to the point where it meets the canvas channels.
  const exit = (lg, b) => {
    const { s, x } = lg, at = s.busAt.get(b);
    if (s.side === "C") return [[x, yg(b)]];
    return [[x, at.b], [gx(s, b), at.b]];
  };
  const tidy = (pts) => {
    const q = [];
    for (const pt of pts) if (!q.length || q.at(-1)[0] !== pt[0] || q.at(-1)[1] !== pt[1]) q.push(pt);
    return q.filter((pt, i) => i === 0 || i === q.length - 1 || !((q[i - 1][0] === pt[0] && pt[0] === q[i + 1][0]) || (q[i - 1][1] === pt[1] && pt[1] === q[i + 1][1])));
  };
  for (const b of busList) for (const r of b.routes) {
    const A = leg(b.hub, b, r.hubPort), B = leg(r.other, b, r.otherPort);
    let mid;
    if (A.s === B.s) {
      const at = A.s.busAt.get(b);
      mid = A.x === B.x ? [] : [[A.x, at.b], [B.x, at.b]];
    } else {
      const ea = exit(A, b), eb = exit(B, b);
      const pa = ea.at(-1), pb = eb.at(-1);
      const join = pa[0] === pb[0] ? [] : [[pa[0], yg(b)], [pb[0], yg(b)]];
      mid = [...ea, ...join, ...[...eb].reverse()];
    }
    out.links.push({ kind: "peer", a: b.hub, b: r.other, edge: r.e, bus: b.id, cross: A.s !== B.s, pts: tidy([...A.pts, ...mid, ...[...B.pts].reverse()]) });
  }
  out.sections = secs;
  // VSX boxes: a dashed rounded box tight around the pair's cells, with
  // VSX_PAD clear of every faceplate and name (rowGap is 12).
  for (const v of out.vsx) {
    const us = v.members.map(unit), P = VSX_PAD;
    v.box = { x0: Math.min(...us.map((u) => u.l)) - P, x1: Math.max(...us.map((u) => u.r)) + P,
      y0: Math.min(...us.map((u) => u.y)) - P, y1: Math.max(...us.map((u) => u.fb)) + P };
  }

  // Labels: every piece of structured text, with its box.
  const L = out.labels;
  const label = (kind, text, full, x, base, st, opt = {}) => {
    if (!text) return null;
    const w = measure(text, st);
    const lb = { kind, text, full, x, y: base, size: st.size, weight: st.weight ?? 400, mono: !!st.mono, ls: st.ls ?? 0, anchor: opt.anchor ?? "start", color: opt.color ?? "muted", w,
      box: textBox(x, base, w, st.size, opt.anchor), unit: opt.unit ?? null, section: opt.section ?? null };
    L.push(lb);
    return lb;
  };
  for (const s of secs) {
    const max = Math.min(s.inner.x1 - s.inner.x0, s.titleMax ?? Infinity);
    const title = s.name.toUpperCase();
    const count = `${s.nsw} switch${s.nsw === 1 ? "" : "es"}${s.aps ? ` · ${s.aps} AP${s.aps === 1 ? "" : "s"}` : ""}`;
    const tw = measure(title, TYPE.title), cw = measure(count, TYPE.count);
    const base = s.y + 21;
    const t = label("title", tw <= max ? title : ellipsize(title, TYPE.title, max, measure), s.name, s.inner.x0, base, TYPE.title, { color: "fg", section: s.name });
    if (t && tw + 8 + cw <= max) label("count", count, count, s.inner.x0 + tw + 8, base, TYPE.count, { section: s.name });
  }
  for (const u of out.units.values()) {
    if (u.x == null) continue;
    const sec = secOf.get(u.id)?.name ?? null;
    const tx = u.l + g.textInset;
    const maxW = Math.min(u.cell.x1, u.l + (u.textMax ?? Infinity)) - tx;
    label("name", ellipsize(u.name, TYPE.name, maxW, measure), u.name, tx, u.y + 12.5, TYPE.name, { color: "fg", unit: u.id, section: sec });
    let ly = u.y + g.nameH;
    if (u.via) { label("via", ellipsize(`via ${u.via}`, TYPE.sub, maxW, measure), `via ${u.via}`, tx, ly + 10.5, TYPE.sub, { unit: u.id, section: sec }); ly += g.lineH; }
    if (u.node) label("ip", ellipsize(u.ipText, TYPE.ip, maxW, measure), u.ipText, tx, ly + 10.5, TYPE.ip, { unit: u.id, section: sec });
    // Faceplates: stack number square on the left, warning badge on the right,
    // model text centred between them when it fits at 10px, else tooltip only.
    const members = u.node?.stack && !u.collapsed ? u.node.stack : [{ model: u.model, memberId: null }];
    u.faces = members.map((mb, i) => {
      const fy = u.ft + i * (g.fh + g.sgap);
      const f = { y: fy, model: mb.model ?? u.model, jNumber: mb.jNumber ?? u.node?.jNumber, square: null, pill: null, badge: null };
      let left = u.l + 8;
      if (members.length > 1) { f.square = { x: u.l + 5, y: fy + 2, w: g.square, h: g.square, text: String(mb.memberId ?? i + 1) }; left = u.l + 5 + g.square + 4; }
      if (u.collapsed) { f.pill = { x: u.l + 5, y: fy + 2, w: 28, h: g.square, text: `×${u.collapsed}` }; left = u.l + 5 + 28 + 4; }
      const right = u.r - (u.warn ? g.badgeReserve : 8);
      if (u.warn && i === 0) f.badge = { cx: u.r - g.badgeInset - g.badgeR, cy: fy + g.fh / 2, r: g.badgeR };
      const full = shortModel(f.model);
      const text = [full, modelFamily(f.model)].find((t) => t && measure(t, TYPE.model) <= right - left) ?? null;
      f.text = text;
      if (f.square) label("badge", f.square.text, f.square.text, f.square.x + g.square / 2, fy + g.fh / 2 + 3.5, TYPE.badge, { anchor: "middle", color: "bg", unit: u.id, section: sec });
      if (f.pill) label("badge", f.pill.text, f.pill.text, f.pill.x + f.pill.w / 2, fy + g.fh / 2 + 3.5, TYPE.badge, { anchor: "middle", color: "bg", unit: u.id, section: sec });
      if (f.badge) f.badge.label = label("badge", "!", "!", f.badge.cx, f.badge.cy + 3.5, TYPE.badge, { anchor: "middle", color: "bg", unit: u.id, section: sec });
      if (text) label("model", text, f.model, (left + right) / 2, fy + g.fh / 2 + 3.5, TYPE.model, { anchor: "middle", unit: u.id, section: sec });
      return f;
    });
  }

  // Bounds: every box, path, and label, padding, and the title block.
  const xs = [], ys = [];
  for (const s of secs) { xs.push(s.x, s.x + s.w); ys.push(s.y, s.y + s.h); }
  for (const v of out.vsx) { xs.push(v.box.x0, v.box.x1); ys.push(v.box.y0, v.box.y1); }
  for (const l of out.links) for (const [x, y] of l.pts) { xs.push(x); ys.push(y); }
  for (const lb of L) { xs.push(lb.box.x0, lb.box.x1); ys.push(lb.box.y0, lb.box.y1); }
  if (out.wan) { xs.push(out.wan.cloud.x - 50, out.wan.cloud.x + 50); ys.push(out.wan.cloud.y - 26); }
  const x0 = Math.min(...xs) - g.canvasPad, x1 = Math.max(...xs) + g.canvasPad;
  const y0 = Math.min(...ys) - g.titleH, y1 = Math.max(...ys) + g.canvasPad;
  out.bounds = { x: x0, y: y0, w: Math.max(x1 - x0, 1000), h: y1 - y0 };
  for (const u of out.units.values()) {
    if (u.x == null) continue;
    (u.node ? out.pos : out.extPos).set(u.id, { x: u.x + g.fw / 2, y: (u.y + u.fb) / 2 });
  }
  out.peerEdges = peerEdges;
  out.switchCount = nsw;
  out.minFont = Math.min(...L.map((lb) => lb.size));
  return out;
}

/** Geometry check (LAYOUT-SPEC §7 step 8, a port of mock.py check()), plus text. */
export function checkLayout(lay) {
  const g = lay.geom;
  const segs = [];
  lay.links.forEach((l, li) => l.pts.slice(1).forEach((q, i) => segs.push([li, l.pts[i], q])));
  const diagonal = lay.links.filter((l) => l.pts.slice(1).some((q, i) => q[0] !== l.pts[i][0] && q[1] !== l.pts[i][1])).length;
  const box = (p, q) => [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1])];
  const crossings = [], peerCrossings = [];
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    if (segs[i][0] === segs[j][0]) continue;
    const bi = lay.links[segs[i][0]].bus, bj = lay.links[segs[j][0]].bus;
    if (bi != null && bi === bj) continue; // one bus, drawn as one branching line
    const A = box(segs[i][1], segs[i][2]), B = box(segs[j][1], segs[j][2]);
    if (A[0] > B[2] + 0.01 || B[0] > A[2] + 0.01 || A[1] > B[3] + 0.01 || B[1] > A[3] + 0.01) continue;
    (bi != null && bj != null ? peerCrossings : crossings).push(`${lay.name(lay.links[segs[i][0]].a)}–${lay.name(lay.links[segs[i][0]].b)} x ${lay.name(lay.links[segs[j][0]].a)}–${lay.name(lay.links[segs[j][0]].b)}`);
  }
  const through = [];
  const hit = (p, q, [x0, x1, y0, y1]) => { const [sx0, sy0, sx1, sy1] = box(p, q); return sx1 > x0 && sx0 < x1 && sy1 > y0 && sy0 < y1; };
  for (const u of lay.units.values()) {
    if (u.x == null) continue;
    for (const [, p, q] of segs) if (hit(p, q, [u.l + 1, u.r - 1, u.ft + 1, u.fb - 1])) through.push(`${u.name} faceplate`);
  }
  for (const lb of lay.labels) {
    for (const [, p, q] of segs) if (hit(p, q, [lb.box.x0, lb.box.x1, lb.box.y0, lb.box.y1])) through.push(`${lb.kind} "${lb.text}"`);
  }
  // Title bands are reserved for the title. The WAN lane is the one route
  // that must cross the core site's band to reach the firewall above it.
  for (const s of lay.sections) {
    for (const [li, p, q] of segs) if (lay.links[li].kind !== "wan" && hit(p, q, [s.x, s.x + s.w, s.y, s.y + g.titleBand])) through.push(`${s.name} title band`);
  }
  return { links: lay.links.length, crossings: crossings.length, diagonal, throughNodes: through.length, detail: [...crossings, ...through], peerCrossings: peerCrossings.length, peerDetail: peerCrossings };
}

/**
 * Text check: every label inside its cell (or its section's inner area) and
 * section, titles alone in the title band, nothing under MIN_FONT_PX at scale.
 */
export function checkText(lay, scale = 1) {
  const bad = [];
  const secBy = new Map(lay.sections.map((s) => [s.name, s]));
  const eps = 0.01;
  const inside = (b, x0, x1, y0, y1) => b.x0 >= x0 - eps && b.x1 <= x1 + eps && b.y0 >= y0 - eps && b.y1 <= y1 + eps;
  for (const lb of lay.labels) {
    const b = lb.box, u = lb.unit ? lay.units.get(lb.unit) : null, s = lb.section ? secBy.get(lb.section) : null;
    if (lb.size * scale < MIN_FONT_PX - eps) bad.push(`${lb.kind} "${lb.text}" ${lb.size * scale}px`);
    if (u && !inside(b, u.cell.x0, u.cell.x1, u.y, u.bottom)) bad.push(`${lb.kind} "${lb.text}" leaves its cell`);
    if (s && !inside(b, s.x + lay.geom.pad, s.x + s.w - lay.geom.pad, s.y, s.y + s.h)) bad.push(`${lb.kind} "${lb.text}" leaves ${s.name}`);
    const band = !!s && b.y0 < s.y + lay.geom.titleBand;
    if (band !== (lb.kind === "title" || lb.kind === "count")) bad.push(`${lb.kind} "${lb.text}" ${band ? "in" : "outside"} the title band`);
  }
  // The WAN line keeps WAN_CLEAR px from title text it passes.
  for (const l of lay.links) if (l.kind === "wan") for (let i = 1; i < l.pts.length; i++) {
    const [[ax, ay], [bx, by]] = [l.pts[i - 1], l.pts[i]];
    for (const lb of lay.labels) {
      if (lb.kind !== "title" && lb.kind !== "count") continue;
      const b = lb.box;
      const dx = Math.max(b.x0 - Math.max(ax, bx), Math.min(ax, bx) - b.x1, 0);
      const dy = Math.max(b.y0 - Math.max(ay, by), Math.min(ay, by) - b.y1, 0);
      if (Math.hypot(dx, dy) < WAN_CLEAR - eps) bad.push(`WAN line within ${WAN_CLEAR}px of ${lb.kind} "${lb.text}"`);
    }
  }
  for (const u of lay.units.values()) {
    for (const f of u.faces ?? []) {
      for (const m of [f.square, f.pill]) if (m && !(m.x >= u.l && m.x + m.w <= u.r && m.y >= f.y && m.y + m.h <= f.y + lay.geom.fh)) bad.push(`${u.name} square outside faceplate`);
      if (f.badge) for (const lb of lay.labels) {
        if (lb.unit === u.id && lb.kind === "model" && lb.box.y0 < f.y + lay.geom.fh && lb.box.y1 > f.y && lb.box.x1 > f.badge.cx - f.badge.r) bad.push(`${u.name} model text under its badge`);
      }
      if (f.badge && !(f.badge.cx - f.badge.r >= u.l && f.badge.cx + f.badge.r <= u.r && f.badge.cy - f.badge.r >= f.y && f.badge.cy + f.badge.r <= f.y + lay.geom.fh)) bad.push(`${u.name} badge outside faceplate`);
    }
  }
  // No two labels overlap.
  const ls = lay.labels;
  for (let i = 0; i < ls.length; i++) for (let j = i + 1; j < ls.length; j++) {
    const a = ls[i].box, b = ls[j].box;
    if (a.x0 < b.x1 - eps && b.x0 < a.x1 - eps && a.y0 < b.y1 - eps && b.y0 < a.y1 - eps) bad.push(`"${ls[i].text}" overlaps "${ls[j].text}"`);
  }
  return bad;
}
