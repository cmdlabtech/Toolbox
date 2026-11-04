// Structured (sections) layout, after Riri's LAYOUT-SPEC. Pure function:
// model in, geometry and routed orthogonal polylines out. structured-render.js
// draws it; the card layouts in layout.js do not share this geometry.
//   Spine: Internet cloud, firewall, then the core-site section.
//   Wings: every other building is a section box on the left or right.
//   Routes: risers inside a section, nested-L spine routes from the core to
//   each building core, one WAN lane. Each kind is crossing-free by
//   construction. Links outside that tree become off-page stubs.

export const TIERS = {
  full: { fw: 200, fh: 18, lab: 16, font: 12.5, rowgap: 18, gutMin: 48, sgap: 6, collapseOver: 4 },
  compact: { fw: 150, fh: 14, lab: 14, font: 11, rowgap: 14, gutMin: 40, sgap: 4, collapseOver: 2 },
};
export const SGEOM = { lgap: 4, pad: 16, head: 36, lane: 7, secgap: 24, spinePitch: 10, spineInset: 18, canvasPad: 40, titleH: 112, stub: 16, landingGap: 12 };

const WAN_RE = /firewall|router|sd-?wan/i;
const SLOT_RE = /gateway|controller/i;
const AP_RE = /access point/i;
const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const memberOf = (port) => Number(/^(\d+)\/\d+\/\d+/.exec(port ?? "")?.[1] ?? 1);

export function headerWidth(name, nsw, naps) {
  return 7.9 * name.length + 8 + 6.2 * `${nsw} switches${naps ? ` · ${naps} APs` : ""}`.length;
}

export function layoutStructured(model, { tier: forced } = {}) {
  const { nodes, byId, coreSerial } = model;
  const nsw = nodes.reduce((a, n) => a + (n.stack?.length ?? 1), 0);
  const g = TIERS[forced ?? (nsw > 40 ? "compact" : "full")];
  // pos/extPos hold each drawn unit's centre so callers that look a switch up
  // by position still find it. Drag pins do not apply (app.js skips them).
  const out = { kind: "structured", pos: new Map(), extPos: new Map(), sectors: [], tier: g, units: new Map(), sections: [], links: [], wan: null, bounds: { x: -300, y: -300, w: 600, h: 600 }, name: (id) => byId.get(id)?.name ?? id };
  if (!coreSerial) return out;
  const core = byId.get(coreSerial);
  const edgeBy = new Map(model.edges.map((e) => [key(e.from, e.to), e]));
  const extBy = new Map(model.externals.map((x) => [x.serial, x]));
  out.name = (id) => byId.get(id)?.name ?? extBy.get(id)?.name ?? id;
  const drawn = new Set(); // link keys represented on the canvas

  // Units: what draws as a name label plus faceplate(s).
  const unit = (id) => {
    let u = out.units.get(id);
    if (u) return u;
    const n = byId.get(id), x = extBy.get(id);
    const members = n?.stack?.length ?? 1;
    const collapsed = members > g.collapseOver ? members : 0;
    u = { id, node: n ?? null, ext: x ?? null, name: n?.name ?? x?.name ?? id, model: n?.model ?? x?.model ?? x?.type ?? null,
      role: n?.role ?? "ext", n: collapsed ? 1 : members, collapsed };
    out.units.set(id, u);
    return u;
  };
  const stackH = (k) => k * g.fh + (k - 1) * g.sgap;
  const nodeH = (u) => g.lab + SGEOM.lgap + stackH(u.n);
  const place = (u, x, y) => { u.x = x; u.y = y; u.ft = y + g.lab + SGEOM.lgap; u.fb = u.ft + stackH(u.n); u.mid = u.ft + g.fh / 2; u.l = x; u.r = x + g.fw; };
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

  // Sections.
  const byHop = (a, b) => (a.hop ?? 99) - (b.hop ?? 99) || a.name.localeCompare(b.name);
  const secs = [];
  for (const b of model.buildings) {
    const members = nodes.filter((n) => n.building === b);
    if (!members.length) continue;
    const own = b === core.building;
    const headId = own ? coreSerial : model.hubs[b] && byId.get(model.hubs[b])?.building === b ? model.hubs[b] : [...members].sort((a, c) => a.name.localeCompare(c.name))[0].serial;
    const access = members.filter((n) => n.serial !== headId).sort(byHop).map((n) => n.serial);
    secs.push({ name: b, own, head: headId, access: [...access, ...(slots.get(b) ?? [])], aps: aps.get(b) ?? 0,
      unassigned: b === "Unassigned", nsw: members.reduce((a, n) => a + (n.stack?.length ?? 1), 0) });
  }

  // Section layout at (x0, y0). side: "L" (inner edge right), "R", or "C".
  // pad: extra space above and below the head unit (core landings, §5).
  function layoutSection(sec, side, x0, y0, pad = 0) {
    const bc = unit(sec.head), acc = sec.access.map(unit);
    const n = acc.length;
    const [L, R] = n <= 3 ? (side !== "R" ? [acc, []] : [[], acc]) : [acc.filter((_, i) => i % 2 === 0), acc.filter((_, i) => i % 2 === 1)];
    const Wg = Math.max(g.gutMin, 20 + n * SGEOM.lane + 8), fw = g.fw, p = SGEOM.pad;
    let inner, gc;
    if (L.length && R.length) { inner = 2 * fw + Wg; gc = fw + Wg / 2; }
    else if (L.length) { inner = Math.max(fw + Wg / 2 + fw / 2, fw); gc = fw + Wg / 2; }
    else if (R.length) { inner = fw / 2 + Wg / 2 + fw; gc = fw / 2; }
    else { inner = fw; gc = fw / 2; }
    const W = inner + 2 * p;
    place(bc, x0 + p + gc - fw / 2, y0 + SGEOM.head + pad);
    let y = bc.y + nodeH(bc) + 22 + pad;
    const gl = x0 + p + gc - Wg / 2, gr = x0 + p + gc + Wg / 2;
    for (let r = 0; r < Math.max(L.length, R.length); r++) {
      const hrow = Math.max(...[L, R].filter((c) => r < c.length).map((c) => nodeH(c[r])));
      if (r < L.length) place(L[r], gl - fw, y);
      if (r < R.length) place(R[r], gr, y);
      y += hrow + g.rowgap;
    }
    const risers = [];
    L.forEach((a, r) => { const lx = gl + 10 + r * SGEOM.lane; risers.push({ a, pts: [[lx, bc.fb], [lx, a.mid], [a.r, a.mid]], outer: "l" }); });
    R.forEach((a, r) => { const lx = gr - 10 - r * SGEOM.lane; risers.push({ a, pts: [[lx, bc.fb], [lx, a.mid], [a.l, a.mid]], outer: "r" }); });
    Object.assign(sec, { x: x0, y: y0, w: W, h: y - g.rowgap + p - y0, side, risers });
    bc.outer = side === "L" ? "l" : "r";
    for (const r of risers) r.a.outer = r.outer;
  }

  // Wings: biggest first into the shorter wing (tie left), alphabetical within.
  const others = secs.filter((s) => !s.own && !s.unassigned);
  const meas = new Map();
  for (const s of [...others, ...secs.filter((s) => s.unassigned)]) { layoutSection(s, "L", 0, 0); meas.set(s, s.h); }
  const wings = { L: [], R: [] }, hh = { L: 0, R: 0 };
  for (const s of [...others].sort((a, b) => b.access.length + b.nsw - (a.access.length + a.nsw) || a.name.localeCompare(b.name))) {
    const side = hh.L <= hh.R ? "L" : "R";
    wings[side].push(s); hh[side] += meas.get(s) + SGEOM.secgap;
  }
  for (const side of ["L", "R"]) wings[side].sort((a, b) => a.name.localeCompare(b.name));
  const un = secs.find((s) => s.unassigned);
  if (un) wings[hh.L <= hh.R ? "L" : "R"].push(un);

  // Core site at the origin. Wing links land on the core's outer ends at
  // least LANDING_GAP apart; when a wing has more links than the stack has
  // height, the core site grows top and bottom padding to make room.
  const coreSec = secs.find((s) => s.own);
  const coreN = unit(coreSerial).n, kmax = Math.max(wings.L.length, wings.R.length);
  const span = stackH(coreN) - 6, need = (kmax - 1) * SGEOM.landingGap;
  const corePad = Math.max(0, Math.ceil((need - span) / 2));
  layoutSection(coreSec, "C", 0, 0, corePad);
  const cu = unit(coreSerial);
  out.landings = {};
  out.rails = [];
  out.coreSerial = coreSerial;

  // WAN band above the core site.
  if (wanDevs.length) {
    const { x, local } = wanDevs[0];
    const fwU = unit(x.serial);
    const hdrEnd = coreSec.x + 16 + headerWidth(coreSec.name, coreSec.nsw, coreSec.aps);
    const wanX = Math.min(Math.max(hdrEnd + 16, cu.l + g.fw / 2), cu.r - 30);
    coreSec.headerMax = wanX - 16 - (coreSec.x + 16); // header truncates before the WAN lane
    // The uplink leaves the faceplate top through the name row, so the name
    // sits left of the WAN lane: shift the faceplate left by the label width.
    const lw = 9 + 0.64 * g.font * fwU.name.length;
    const off = Math.min(Math.max(g.fw / 2, lw + 6), g.fw - 12);
    place(fwU, Math.min(Math.max(wanX - off, coreSec.x + 16), coreSec.x + coreSec.w - 16 - g.fw), -nodeH(fwU) - 46);
    const cloud = { x: wanX, y: fwU.y - 46 };
    const e = edgeBy.get(key(x.serial, local));
    const via = local !== coreSerial ? out.name(local) : null;
    out.links.push({ kind: "wan", a: coreSerial, b: x.serial, edge: via ? null : e, pts: [[wanX, cu.ft], [wanX, fwU.fb]], via });
    out.links.push({ kind: "wan", a: x.serial, b: "internet", edge: null, decor: true, pts: [[wanX, fwU.ft], [wanX, cloud.y + 14]] });
    if (!via) drawn.add(key(x.serial, local));
    if (via) fwU.via = via;
    out.wan = { x: wanX, cloud, unit: fwU };
  }

  const top = out.wan ? out.wan.cloud.y - 30 : -Infinity;
  for (const side of ["L", "R"]) {
    const wing = wings[side];
    if (!wing.length) continue;
    const k = wing.length, Sg = 40 + k * 10;
    const boxEdge = side === "L" ? coreSec.x : coreSec.x + coreSec.w;
    const wingInner = side === "L" ? boxEdge - Sg : boxEdge + Sg;
    const total = wing.reduce((a, s) => a + meas.get(s), 0) + SGEOM.secgap * (k - 1);
    let y = Math.max(coreSec.y + coreSec.h / 2 - total / 2, top);
    for (const s of wing) {
      // Measure with the real side so one-column sections sit on the outer side.
      layoutSection(s, side, 0, 0);
      const w = s.w;
      layoutSection(s, side, side === "L" ? wingInner - w : wingInner, y);
      y += s.h + SGEOM.secgap;
    }
    // Core ports spread over the solid faceplate height, skipping stack gaps.
    // Below the minimum gap, fall back to an even LANDING_GAP pitch centred
    // on the stack, and draw a landing rail on that end of the core.
    const tot = cu.n * g.fh;
    const ymap = (t) => { const m = Math.min(Math.floor(t / g.fh), cu.n - 1); return cu.ft + m * (g.fh + g.sgap) + (t - m * g.fh); };
    let ports = wing.map((_, i) => ymap(((i + 0.5) / k) * tot));
    if (ports.some((y, i) => i && y - ports[i - 1] < SGEOM.landingGap)) {
      const mid = (cu.ft + cu.fb) / 2;
      ports = wing.map((_, i) => mid + (i - (k - 1) / 2) * SGEOM.landingGap);
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
      const pts = rank.has(i)
        ? [[start, y], [boxEdge - sgn * (SGEOM.spineInset + rank.get(i) * SGEOM.spinePitch), y], [boxEdge - sgn * (SGEOM.spineInset + rank.get(i) * SGEOM.spinePitch), ports[i]], [coreEdge, ports[i]]]
        : [[start, y], [coreEdge, ports[i]]];
      out.links.push({ kind: "backbone", a: s.head, b: coreSerial, edge: e, pts });
      if (e) drawn.add(key(s.head, coreSerial));
    });
  }

  // Risers: real link when one exists; a daisy chain draws from the riser bus
  // with a "via NAME" note and keeps the real upstream link as represented.
  for (const s of secs) {
    for (const r of s.risers) {
      const id = r.a.id, e = edgeBy.get(key(id, s.head)) ?? null;
      const n = byId.get(id);
      const slotKind = r.a.ext && SLOT_RE.test(r.a.ext.type ?? "") ? "backbone" : "access";
      out.links.push({ kind: slotKind, a: s.head, b: id, edge: e, pts: r.pts });
      if (e) drawn.add(key(id, s.head));
      else if (n?.parent && n.parent !== s.head && byId.get(n.parent)?.building === s.name) {
        r.a.via = out.name(n.parent); drawn.add(key(id, n.parent));
      } else if (r.a.ext && localOf.get(id) !== s.head) { r.a.via = out.name(localOf.get(id)); drawn.add(key(id, localOf.get(id))); }
    }
  }

  // Off-page stubs for every link not on the canvas.
  const stubs = [];
  for (const e of model.edges) {
    const k = key(e.from, e.to);
    if (drawn.has(k) || !out.units.has(e.from) || !out.units.has(e.to)) continue;
    drawn.add(k);
    for (const [me, peer, port] of [[e.from, e.to, e.toLabel || e.toPort], [e.to, e.from, e.fromLabel || e.fromPort]]) {
      const u = unit(me);
      const label = `→ ${out.name(peer)}${port ? " " + port : ""}`;
      // Stubs only leave toward the canvas edge; elsewhere they would run into
      // a riser gutter or the spine, so the chip moves to the name row.
      const sec = secs.find((s) => s.head === me || s.access.includes(me));
      const outward = sec && ((sec.side === "L" && u.outer === "l") || (sec.side === "R" && u.outer === "r"));
      if (me === coreSerial || !outward) { (u.chips ??= []).push(label); continue; }
      const x0 = u.outer === "l" ? u.l : u.r, x1 = u.outer === "l" ? u.l - SGEOM.stub : u.r + SGEOM.stub;
      const ym = memberMid(u, e.from === me ? e.fromPort : e.toPort);
      // One stub per attach point; further peers stack as extra chip lines.
      const same = stubs.find((st) => st.unit === u && st.y === ym);
      if (same) { same.labels.push(label); continue; }
      stubs.push({ unit: u, x: x1, y: ym, side: u.outer, label, labels: [label] });
      out.links.push({ kind: "stub", a: me, b: peer, edge: e, pts: [[x0, ym], [x1, ym]] });
    }
  }
  out.stubs = stubs;
  out.sections = secs;

  // Bounds: every box and path, stub chips, padding, and the title block.
  const xs = [], ys2 = [];
  for (const s of secs) { xs.push(s.x, s.x + s.w); ys2.push(s.y, s.y + s.h); }
  for (const l of out.links) for (const [x, y] of l.pts) { xs.push(x); ys2.push(y); }
  for (const st of stubs) { const len = Math.max(...stubLines(st.labels).map((t) => t.length)); xs.push(st.side === "l" ? st.x - 6 - 6 * len : st.x + 6 + 6 * len); }
  if (out.wan) { xs.push(out.wan.cloud.x - 50, out.wan.cloud.x + 50); ys2.push(out.wan.cloud.y - 26); }
  const x0 = Math.min(...xs) - SGEOM.canvasPad, x1 = Math.max(...xs) + SGEOM.canvasPad;
  const y0 = Math.min(...ys2) - SGEOM.titleH, y1 = Math.max(...ys2) + SGEOM.canvasPad;
  out.bounds = { x: x0, y: y0, w: Math.max(x1 - x0, 1000), h: y1 - y0 };
  for (const u of out.units.values()) {
    if (u.x == null) continue;
    (u.node ? out.pos : out.extPos).set(u.id, { x: u.x + g.fw / 2, y: (u.y + u.fb) / 2 });
  }
  out.switchCount = nsw;
  return out;
}

/** Shared stubs show up to STUB_LINES labels, then "+n more" (full list in the tooltip). */
export const STUB_LINES = 3;
export function stubLines(labels) {
  return labels.length <= STUB_LINES ? labels : [...labels.slice(0, STUB_LINES), `+${labels.length - STUB_LINES} more`];
}

/** Geometry check (LAYOUT-SPEC §7 step 8, a port of mock.py check()). */
export function checkLayout(lay) {
  const g = lay.tier;
  const segs = [];
  lay.links.forEach((l, li) => l.pts.slice(1).forEach((q, i) => segs.push([li, l.pts[i], q])));
  const diagonal = lay.links.filter((l) => l.pts.slice(1).some((q, i) => q[0] !== l.pts[i][0] && q[1] !== l.pts[i][1])).length;
  const box = (p, q) => [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1])];
  const crossings = [];
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    if (segs[i][0] === segs[j][0]) continue;
    const A = box(segs[i][1], segs[i][2]), B = box(segs[j][1], segs[j][2]);
    if (A[0] > B[2] + 0.01 || B[0] > A[2] + 0.01 || A[1] > B[3] + 0.01 || B[1] > A[3] + 0.01) continue;
    crossings.push(`${lay.name(lay.links[segs[i][0]].a)}–${lay.name(lay.links[segs[i][0]].b)} x ${lay.name(lay.links[segs[j][0]].a)}–${lay.name(lay.links[segs[j][0]].b)}`);
  }
  const through = [];
  const hit = (p, q, [x0, x1, y0, y1]) => { const [sx0, sy0, sx1, sy1] = box(p, q); return sx1 > x0 && sx0 < x1 && sy1 > y0 && sy0 < y1; };
  for (const u of lay.units.values()) {
    if (u.x == null) continue;
    for (const [, p, q] of segs) {
      if (hit(p, q, [u.l + 1, u.r - 1, u.ft + 1, u.fb - 1])) through.push(`${u.name} faceplate`);
      if (hit(p, q, [u.l, u.l + 9 + 0.64 * g.font * u.name.length, u.y, u.ft])) through.push(`${u.name} label`);
    }
  }
  for (const s of lay.sections) {
    const hw = Math.min(headerWidth(s.name, s.nsw, s.aps), s.headerMax ?? Infinity);
    for (const [, p, q] of segs) if (hit(p, q, [s.x + 16, s.x + 16 + hw, s.y + 10, s.y + 28])) through.push(`${s.name} header`);
  }
  return { links: lay.links.length, crossings: crossings.length, diagonal, throughNodes: through.length, detail: [...crossings, ...through] };
}
