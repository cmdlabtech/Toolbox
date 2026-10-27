// Layouts for the topology diagram. Each one is a pure function: model in,
// positions out. Hub and spoke is the default. Position overrides are applied
// afterwards, per layout, and never written back into the model.

export const GEOM = { r1: 290, r2: 600, rExt: 740, nodeW: 156, nodeH: 46, pad: 40 };

const LAYOUT_FNS = {
  hub: (model) => layout(model),
  "tree-tb": (model) => layoutTree(model, "tb"),
  "tree-lr": (model) => layoutTree(model, "lr"),
  radial: (model) => layoutRadial(model),
  sites: (model) => layoutSites(model),
  force: (model) => layoutForce(model),
};

export const LAYOUTS = [
  { id: "hub", label: "Hub and spoke" },
  { id: "tree-tb", label: "Tiered tree, top-down" },
  { id: "tree-lr", label: "Tiered tree, left to right" },
  { id: "radial", label: "Radial rings" },
  { id: "sites", label: "Grouped by site" },
  { id: "force", label: "Force-directed" },
];

export function layoutById(id, model) {
  const spec = LAYOUTS.find((l) => l.id === id) ?? LAYOUTS[0];
  return { ...LAYOUT_FNS[spec.id](model), id: spec.id };
}

// On-screen px per user unit. Never below the left-to-right tree fitted into
// the same pane, so a wide layout scrolls instead of shrinking its labels.
// `bounds` and `reference` are {w, h}. The SVG width/height attributes stay
// in user units; only the display size uses this scale.
export function displayScale(bounds, avail, reference) {
  const fitOf = (b) => Math.min(avail.w / b.w, avail.h / b.h);
  const fit = fitOf(bounds);
  const floor = reference ? fitOf(reference) : fit;
  if (!Number.isFinite(fit) || !Number.isFinite(floor)) return 1;
  return Math.max(fit, floor);
}

// Radial hub-and-spoke: district core in the middle, one sector per building
// with its building core on the inner ring and access switches on the outer ring.
export function layout(model) {
  const pos = new Map();
  const { nodes, coreSerial, byId } = model;
  if (!coreSerial) return { pos, sectors: [], bounds: { x: -300, y: -300, w: 600, h: 600 } };
  pos.set(coreSerial, { x: 0, y: 0 });
  const core = byId.get(coreSerial);

  const sectors = [];
  for (const b of model.buildings) {
    const members = nodes.filter((n) => n.building === b && n.serial !== coreSerial);
    if (!members.length) continue;
    const hub = model.hubs[b] && model.hubs[b] !== coreSerial ? byId.get(model.hubs[b]) : null;
    const spokes = members.filter((n) => n !== hub);
    sectors.push({ building: b, hub, spokes, own: b === core.building, weight: Math.max(2, spokes.length + (hub ? 0.5 : 0)) });
  }
  const total = sectors.reduce((a, s) => a + s.weight, 0);
  let a0 = -Math.PI / 2 - (Math.PI * 2 * (sectors[0]?.weight ?? 0)) / total / 2;
  for (const s of sectors) {
    const span = (Math.PI * 2 * s.weight) / total;
    s.mid = a0 + span / 2;
    s.span = span;
    if (s.hub) pos.set(s.hub.serial, polar(GEOM.r1, s.mid));
    // The district core's own switches sit on the inner ring, others outer.
    const r = s.hub ? GEOM.r2 : GEOM.r1 + 40;
    const spread = span * 0.72;
    s.spokes.sort((x, y) => (x.hop ?? 99) - (y.hop ?? 99) || x.name.localeCompare(y.name));
    s.spokes.forEach((n, i) => {
      const t = s.spokes.length === 1 ? 0 : i / (s.spokes.length - 1) - 0.5;
      const stagger = s.spokes.length > 4 && i % 2 ? 70 : 0;
      pos.set(n.serial, polar(r + stagger, s.mid + t * spread));
    });
    const outer = Math.max(s.hub ? GEOM.r1 : 0, ...s.spokes.map((n) => Math.hypot(pos.get(n.serial).x, pos.get(n.serial).y)));
    const label = sectorLabel(s.mid, outer);
    s.labelAt = label.labelAt;
    s.anchor = label.anchor;
    a0 += span;
  }

  // External (non-switch) neighbors: pushed outward from the switch they hang off.
  const extPos = new Map();
  for (const e of model.edges.filter((e) => e.external)) {
    const local = byId.has(e.from) ? e.from : e.to;
    const other = local === e.from ? e.to : e.from;
    const p = pos.get(local);
    if (!p || extPos.has(other)) continue;
    const ang = p.x === 0 && p.y === 0 ? Math.PI / 2 : Math.atan2(p.y, p.x);
    const r = Math.hypot(p.x, p.y) + 140;
    extPos.set(other, polar(r, ang + 0.06));
  }

  const all = [...pos.values(), ...extPos.values()];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of all) {
    minX = Math.min(minX, p.x - GEOM.nodeW / 2);
    maxX = Math.max(maxX, p.x + GEOM.nodeW / 2);
    minY = Math.min(minY, p.y - GEOM.nodeH / 2);
    maxY = Math.max(maxY, p.y + GEOM.nodeH / 2);
  }
  for (const s of sectors) {
    const lb = labelBox(s);
    if (!lb) continue;
    minX = Math.min(minX, lb.x);
    maxX = Math.max(maxX, lb.x + lb.w);
    minY = Math.min(minY, lb.y);
    maxY = Math.max(maxY, lb.y + lb.h);
  }
  minX -= GEOM.pad;
  maxX += GEOM.pad;
  minY -= GEOM.pad + 70; // room for the title block
  maxY += GEOM.pad + 30;
  return { pos, extPos, sectors, bounds: { x: minX, y: minY, w: maxX - minX, h: maxY - minY } };
}

// Tiered tree. Top-down puts the root on the first row and each hop on the
// next. Left-to-right uses the same tiers, with hops running across the page.
export function layoutTree(model, orientation) {
  const tb = orientation !== "lr";
  const { nodes, coreSerial, byId } = model;
  if (!coreSerial) return emptyLay();
  const children = new Map(nodes.map((n) => [n.serial, []]));
  for (const n of nodes) {
    if (n.serial === coreSerial) continue;
    const parent = n.parent && children.has(n.parent) ? n.parent : coreSerial;
    if (parent !== n.serial) children.get(parent).push(n.serial);
  }
  // Each tier follows its parent. Siblings stay contiguous, and a switch with
  // a link into another building sits on the side facing that building so the
  // extra link does not cross its siblings.
  const buildingIndex = new Map(model.buildings.map((b, i) => [b, i]));
  const neighbors = new Map(nodes.map((n) => [n.serial, []]));
  for (const e of model.edges) {
    if (!neighbors.has(e.from) || !neighbors.has(e.to)) continue;
    neighbors.get(e.from).push(e.to);
    neighbors.get(e.to).push(e.from);
  }
  const siblingPull = (id) => {
    const n = byId.get(id);
    const home = buildingIndex.get(n.building) ?? 0;
    let best = null;
    for (const other of neighbors.get(id) ?? []) {
      if (other === n.parent || !byId.has(other)) continue;
      const o = byId.get(other);
      if (!o || o.building === n.building) continue;
      const idx = buildingIndex.get(o.building) ?? home;
      const dist = Math.abs(idx - home);
      if (!best || dist > best.dist) best = { idx, dist };
    }
    if (!best) return home * 2;
    return best.idx < home ? home * 2 - 1 : home * 2 + 1;
  };
  for (const kids of children.values()) {
    kids.sort((a, b) => siblingPull(a) - siblingPull(b) || byId.get(a).name.localeCompare(byId.get(b).name));
  }
  // Siblings share a tier. The gap clears a node rect plus a fallback ring.
  const unit = tb ? GEOM.nodeW + 36 : GEOM.nodeH + 28;
  const tier = tb ? GEOM.nodeH + 76 : GEOM.nodeW + 88;
  const width = new Map();
  const measure = (id, seen) => {
    if (width.has(id)) return width.get(id);
    if (seen.has(id)) return unit;
    seen.add(id);
    const kids = children.get(id) ?? [];
    const sum = kids.reduce((s, k) => s + measure(k, seen), 0);
    const w = Math.max(unit, sum);
    width.set(id, w);
    return w;
  };
  measure(coreSerial, new Set());
  const pos = new Map();
  const place = (id, start, depth, seen) => {
    if (seen.has(id)) return;
    seen.add(id);
    const mid = start + width.get(id) / 2;
    const along = depth * tier;
    pos.set(id, tb ? { x: Math.round(mid), y: Math.round(along) } : { x: Math.round(along), y: Math.round(mid) });
    let cursor = start;
    for (const k of children.get(id) ?? []) {
      place(k, cursor, depth + 1, seen);
      cursor += width.get(k) ?? unit;
    }
  };
  place(coreSerial, 0, 0, new Set());
  const missing = nodes.filter((n) => !pos.has(n.serial)).sort((a, b) => a.name.localeCompare(b.name));
  if (missing.length && pos.size) {
    const maxCross = Math.max(...[...pos.values()].map((p) => (tb ? p.x : p.y)));
    missing.forEach((n, i) => {
      const cross = maxCross + unit * (i + 1);
      pos.set(n.serial, tb ? { x: Math.round(cross), y: 0 } : { x: 0, y: Math.round(cross) });
    });
  }
  const extPos = placeExternals(model, pos, tb ? "tb" : "lr");
  return { ...pack(pos, extPos, []), route: "ortho", axis: tb ? "y" : "x" };
}

// Concentric rings by tier. Ring 0 is the district core, ring 1 the building
// cores, and further rings the access switches. Each building keeps an arc.
export function layoutRadial(model) {
  const { nodes, coreSerial, byId } = model;
  if (!coreSerial) return emptyLay();
  const pos = new Map();
  pos.set(coreSerial, { x: 0, y: 0 });
  const core = byId.get(coreSerial);
  const ringR = [0, 360, 680, 1000, 1300];
  const radius = (ring) => (ring < ringR.length ? ringR[ring] : ringR[ringR.length - 1] + (ring - ringR.length + 1) * 280);

  const groups = [];
  for (const b of model.buildings) {
    const members = nodes.filter((n) => n.building === b && n.serial !== coreSerial);
    const hub = model.hubs[b] && model.hubs[b] !== coreSerial ? byId.get(model.hubs[b]) : null;
    const spokes = members.filter((n) => n !== hub);
    if (!spokes.length && !hub) continue;
    const byRing = new Map();
    for (const n of spokes) {
      const ring = n.building === core.building ? Math.max(2, (n.hop ?? 1) + 1) : Math.max(2, n.hop ?? 2);
      byRing.set(ring, [...(byRing.get(ring) ?? []), n]);
    }
    let weight = 1;
    for (const list of byRing.values()) weight = Math.max(weight, list.length);
    groups.push({ building: b, hub, byRing, weight });
  }
  const total = groups.reduce((a, g) => a + g.weight, 0) || 1;
  let a0 = -Math.PI / 2;
  for (const g of groups) {
    const span = (Math.PI * 2 * g.weight) / total;
    const mid = a0 + span / 2;
    let outer = 0;
    if (g.hub) {
      pos.set(g.hub.serial, polar(radius(1), mid));
      outer = radius(1);
    }
    for (const ring of [...g.byRing.keys()].sort((a, b) => a - b)) {
      const list = g.byRing.get(ring).sort((a, b) => a.name.localeCompare(b.name));
      const r = radius(ring);
      outer = Math.max(outer, r);
      const spread = span * 0.68;
      list.forEach((n, i) => {
        const t = list.length === 1 ? 0 : i / (list.length - 1) - 0.5;
        pos.set(n.serial, polar(r, mid + t * spread));
      });
    }
    const label = sectorLabel(mid, outer);
    g.labelAt = label.labelAt;
    g.anchor = label.anchor;
    a0 += span;
  }
  const extPos = placeExternals(model, pos, "out");
  const sectors = groups.map((g) => ({ building: g.building, labelAt: g.labelAt, anchor: g.anchor }));
  return pack(pos, extPos, sectors);
}

// One labelled box per site. Switches stack in a column. Cross-site links are
// routed through the gutter and a lane above the boxes (see render.js).
export function layoutSites(model) {
  const { nodes, coreSerial } = model;
  if (!coreSerial) return emptyLay();
  const pos = new Map();
  const extPos = new Map();
  const boxBySerial = new Map();
  const sectors = [];
  const gapX = 72;
  const padX = 28;
  const padTop = 36;
  const padBot = 28;
  const rowGap = 18;
  const extGap = 28;
  const extInset = 40;
  const pillW = 120;
  const laneY = 0;
  let x = 0;
  for (const b of model.buildings) {
    const members = nodes.filter((n) => n.building === b).sort((a, c) => {
      const rank = (n) => (n.role === "district-core" || n.role === "building-core" ? 0 : 1);
      return rank(a) - rank(c) || (a.hop ?? 99) - (c.hop ?? 99) || a.name.localeCompare(c.name);
    });
    if (!members.length) continue;
    const exts = externalsOf(model, members);
    const boxW = exts.length ? padX + GEOM.nodeW + extGap + pillW + extInset : padX * 2 + GEOM.nodeW;
    const box = { x, y: 40, w: boxW, h: 0 };
    const cx = box.x + padX + GEOM.nodeW / 2;
    members.forEach((n, i) => {
      const y = box.y + padTop + GEOM.nodeH / 2 + i * (GEOM.nodeH + rowGap);
      pos.set(n.serial, { x: Math.round(cx), y: Math.round(y) });
      boxBySerial.set(n.serial, box);
    });
    let bottom = box.y + padTop + members.length * GEOM.nodeH + Math.max(0, members.length - 1) * rowGap + padBot;
    exts.forEach((ext, i) => {
      const anchor = pos.get(ext.local);
      const y = anchor.y + i * (GEOM.nodeH + rowGap);
      const px = Math.round(box.x + padX + GEOM.nodeW + extGap + pillW / 2);
      extPos.set(ext.id, { x: px, y });
      bottom = Math.max(bottom, y + 15 + padBot);
    });
    box.h = bottom - box.y;
    sectors.push({
      building: b,
      box,
      anchor: "middle",
      labelAt: { x: box.x + box.w / 2, y: box.y + 20 },
    });
    x += box.w + gapX;
  }
  const extra = [{ x: -24, y: laneY }, { x: Math.max(0, x - gapX) + 24, y: laneY }];
  return { ...pack(pos, extPos, sectors, extra), laneY, boxBySerial, route: "gutter" };
}

// Fruchterman–Reingold with a fixed seed. Runs until movement falls under
// the settle threshold (or the iteration cap), then a separation pass.
// Nothing is animated: the function returns the settled positions.
const FORCE_SEED = 0xC70B0101;

export function layoutForce(model) {
  const { nodes, coreSerial } = model;
  if (!coreSerial) return emptyLay();
  const ids = nodes.map((n) => n.serial).sort((a, b) => a.localeCompare(b));
  const exts = [];
  for (const e of model.edges) {
    if (!e.external) continue;
    const local = model.byId.has(e.from) ? e.from : model.byId.has(e.to) ? e.to : null;
    if (!local) continue;
    const other = local === e.from ? e.to : e.from;
    if (!exts.some((x) => x.id === other)) exts.push({ id: other, local });
  }
  const all = [...ids, ...exts.map((e) => e.id)];
  const extIds = new Set(exts.map((e) => e.id));
  const rand = mulberry32(FORCE_SEED);
  const P = new Map();
  all.forEach((id, i) => {
    const ang = -Math.PI / 2 + (i / all.length) * Math.PI * 2;
    const r = 240 + rand() * 48;
    P.set(id, { x: r * Math.cos(ang), y: r * Math.sin(ang) });
  });
  const seen = new Set();
  const links = [];
  const addLink = (u, v) => {
    if (!u || !v || u === v || !P.has(u) || !P.has(v)) return;
    const key = u < v ? `${u}|${v}` : `${v}|${u}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push([u, v]);
  };
  for (const e of model.edges) addLink(e.from, e.to);
  for (const n of nodes) addLink(n.serial, n.parent);

  const n = all.length;
  const k = Math.sqrt((1500 * 1000) / n);
  let temp = 160;
  for (let iter = 0; iter < 360; iter++) {
    const disp = new Map(all.map((id) => [id, { x: 0, y: 0 }]));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = P.get(all[i]), b = P.get(all[j]);
        let dx = a.x - b.x, dy = a.y - b.y;
        let dist = Math.hypot(dx, dy) || 0.01;
        const force = (k * k) / dist;
        dx /= dist; dy /= dist;
        const di = disp.get(all[i]), dj = disp.get(all[j]);
        di.x += dx * force; di.y += dy * force;
        dj.x -= dx * force; dj.y -= dy * force;
      }
    }
    for (const [u, v] of links) {
      const a = P.get(u), b = P.get(v);
      let dx = a.x - b.x, dy = a.y - b.y;
      let dist = Math.hypot(dx, dy) || 0.01;
      const force = (dist * dist) / k;
      dx /= dist; dy /= dist;
      const du = disp.get(u), dv = disp.get(v);
      du.x -= dx * force; du.y -= dy * force;
      dv.x += dx * force; dv.y += dy * force;
    }
    let maxStep = 0;
    for (const id of all) {
      const p = P.get(id);
      const d = disp.get(id);
      d.x -= p.x * 0.012;
      d.y -= p.y * 0.012;
      const dist = Math.hypot(d.x, d.y) || 0.01;
      const step = Math.min(dist, temp);
      p.x += (d.x / dist) * step;
      p.y += (d.y / dist) * step;
      if (step > maxStep) maxStep = step;
    }
    temp *= 0.965;
    if (iter > 40 && maxStep < 0.35) break;
  }
  const sizeOf = (id) => (extIds.has(id) ? { w: 140, h: 50 } : { w: 176, h: 66 });
  separate(P, all, sizeOf);
  const pos = new Map();
  const extPos = new Map();
  for (const id of ids) pos.set(id, { x: Math.round(P.get(id).x), y: Math.round(P.get(id).y) });
  for (const e of exts) extPos.set(e.id, { x: Math.round(P.get(e.id).x), y: Math.round(P.get(e.id).y) });
  // Rounding can close a 1px gap. Push apart on the integer grid.
  separate(pos, [...pos.keys()], () => ({ w: 168, h: 58 }));
  const both = new Map([...pos, ...extPos]);
  const gapOf = (id) => (extPos.has(id) && !pos.has(id) ? { w: 136, h: 46 } : { w: 168, h: 58 });
  separate(both, [...both.keys()], gapOf);
  // The repulsion pass leaves large gaps. Pull inward and separate again so
  // the settled graph fills its frame instead of sitting in a sparse box.
  compact(both, [...both.keys()], gapOf);
  for (const id of ids) pos.set(id, { x: Math.round(both.get(id).x), y: Math.round(both.get(id).y) });
  for (const e of exts) extPos.set(e.id, { x: Math.round(both.get(e.id).x), y: Math.round(both.get(e.id).y) });
  frameSettled(pos, extPos);
  return pack(pos, extPos, []);
}

/** Replace positions for serials present in `map`. Other layouts are not involved. */
export function applyPositionOverrides(lay, map) {
  if (!map || typeof map !== "object") return lay;
  const pos = new Map(lay.pos);
  let changed = false;
  for (const [id, p] of Object.entries(map)) {
    if (!pos.has(id) || !p || !Number.isFinite(+p.x) || !Number.isFinite(+p.y)) continue;
    pos.set(id, { x: Math.round(+p.x), y: Math.round(+p.y) });
    changed = true;
  }
  if (!changed) return lay;
  const extPos = lay.extPos ?? new Map();
  return { ...lay, pos, bounds: boundsFor(pos, extPos, lay.sectors ?? [], lay.extra ?? []) };
}

/** Copy-on-write. Maps for other layout ids are left as they were. */
export function writePosition(store, layoutId, serial, point) {
  const base = store && typeof store === "object" && !Array.isArray(store) ? store : {};
  const cur = base[layoutId] ?? {};
  return { ...base, [layoutId]: { ...cur, [serial]: { x: Math.round(point.x), y: Math.round(point.y) } } };
}

export function clearPosition(store, layoutId, serial) {
  const base = store && typeof store === "object" && !Array.isArray(store) ? store : {};
  const cur = { ...(base[layoutId] ?? {}) };
  delete cur[serial];
  const next = { ...base };
  if (Object.keys(cur).length) next[layoutId] = cur;
  else delete next[layoutId];
  return next;
}

/** Approximate sector-label box. Baseline is `labelAt.y`. */
export function labelBox(sector) {
  if (!sector?.labelAt) return null;
  const text = String(sector.building ?? "").toUpperCase();
  if (!text) return null;
  const w = Math.ceil(text.length * 8.4);
  const h = 14;
  const anchor = sector.anchor ?? "middle";
  const x = anchor === "end" ? sector.labelAt.x - w : anchor === "start" ? sector.labelAt.x : sector.labelAt.x - w / 2;
  const y = sector.labelAt.y - 11;
  return { x, y, w, h };
}

function emptyLay() {
  return { pos: new Map(), extPos: new Map(), sectors: [], bounds: { x: -300, y: -300, w: 600, h: 600 } };
}

function pack(pos, extPos, sectors, extra = []) {
  return { pos, extPos, sectors, extra, bounds: boundsFor(pos, extPos, sectors, extra) };
}

function boundsFor(pos, extPos, sectors, extra) {
  const edges = [...(extra ?? [])];
  for (const s of sectors ?? []) {
    if (s.box) edges.push({ x: s.box.x, y: s.box.y }, { x: s.box.x + s.box.w, y: s.box.y + s.box.h });
    const lb = labelBox(s);
    if (lb) edges.push({ x: lb.x, y: lb.y }, { x: lb.x + lb.w, y: lb.y + lb.h });
  }
  const centers = [...pos.values(), ...(extPos?.values() ?? [])];
  if (!centers.length && !edges.length) return { x: -300, y: -300, w: 600, h: 600 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const take = (x, y) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const p of centers) {
    take(p.x - GEOM.nodeW / 2, p.y - GEOM.nodeH / 2);
    take(p.x + GEOM.nodeW / 2, p.y + GEOM.nodeH / 2);
  }
  for (const p of edges) take(p.x, p.y);
  minX -= GEOM.pad;
  maxX += GEOM.pad;
  minY -= GEOM.pad + 70;
  maxY += GEOM.pad + 30;
  // Title on the left, legend on the right, both in the header band.
  const minW = 1240;
  if (maxX - minX < minW) {
    const grow = (minW - (maxX - minX)) / 2;
    minX -= grow;
    maxX += grow;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function externalsOf(model, members) {
  const ids = new Set(members.map((m) => m.serial));
  const out = [];
  for (const e of model.edges) {
    if (!e.external) continue;
    const local = ids.has(e.from) ? e.from : ids.has(e.to) ? e.to : null;
    if (!local) continue;
    const other = local === e.from ? e.to : e.from;
    if (!out.some((x) => x.id === other)) out.push({ id: other, local });
  }
  return out;
}

function placeExternals(model, pos, mode) {
  const extPos = new Map();
  const obstacles = [...pos.values()].map((p) => ({ p, w: GEOM.nodeW, h: GEOM.nodeH }));
  const segments = switchSegments(model, pos, mode === "out" ? null : mode === "lr" ? "x" : "y");
  for (const e of model.edges) {
    if (!e.external) continue;
    const local = model.byId.has(e.from) ? e.from : model.byId.has(e.to) ? e.to : null;
    if (!local) continue;
    const other = local === e.from ? e.to : e.from;
    if (extPos.has(other)) continue;
    const p = pos.get(local);
    if (!p) continue;
    let ang = Math.atan2(p.y, p.x);
    if (!Number.isFinite(ang) || (p.x === 0 && p.y === 0)) ang = 0.7;
    const candidates = externalCandidates(p, mode, ang);
    let placed = candidates[candidates.length - 1];
    for (const c of candidates) {
      if (hits(c, 120, 30, obstacles)) continue;
      if (rectHitsAnySegment(pillRect(c, 8), segments)) continue;
      placed = c;
      break;
    }
    extPos.set(other, placed);
    obstacles.push({ p: placed, w: 120, h: 30 });
  }
  return extPos;
}

// Point the label out from the rim of its own sector. Text grows away from
// the ring so a long name stays next to that arc instead of the canvas corner.
function sectorLabel(mid, outer) {
  const c = Math.cos(mid);
  const s = Math.sin(mid);
  const rim = polar(outer, mid);
  const gap = 16;
  if (Math.abs(c) >= Math.abs(s)) {
    const dir = c >= 0 ? 1 : -1;
    return {
      anchor: dir > 0 ? "start" : "end",
      labelAt: { x: rim.x + dir * (GEOM.nodeW / 2 + gap), y: rim.y + 4 },
    };
  }
  const dir = s >= 0 ? 1 : -1;
  return {
    anchor: "middle",
    labelAt: { x: rim.x, y: rim.y + dir * (GEOM.nodeH / 2 + gap + 11) },
  };
}

// Translate the settled force graph so node centers sit in the middle of the
// frame. boundsFor pads every center the same way, so the padding stays even.
function frameSettled(pos, extPos) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of [...pos.values(), ...extPos.values()]) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX)) return;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  for (const p of pos.values()) {
    p.x = Math.round(p.x - cx);
    p.y = Math.round(p.y - cy);
  }
  for (const p of extPos.values()) {
    p.x = Math.round(p.x - cx);
    p.y = Math.round(p.y - cy);
  }
}

/** Bend points for a tree edge that runs in the gap between two tiers.
 * `axis` is the depth direction: "y" top-down, "x" left-to-right.
 */
export function orthoBend(a, b, axis) {
  if (a.x === b.x || a.y === b.y) return [a, b];
  const alongX = axis === "x" || (axis !== "y" && Math.abs(b.x - a.x) >= Math.abs(b.y - a.y));
  if (alongX) {
    const mx = Math.round((a.x + b.x) / 2);
    return [a, { x: mx, y: a.y }, { x: mx, y: b.y }, b];
  }
  const my = Math.round((a.y + b.y) / 2);
  return [a, { x: a.x, y: my }, { x: b.x, y: my }, b];
}

function externalCandidates(p, mode, ang) {
  if (mode === "out") {
    const dist0 = Math.hypot(p.x, p.y) + 180;
    const out = [];
    for (let k = 0; k < 8; k++) {
      const dist = dist0 + k * 48;
      out.push({ x: Math.round(dist * Math.cos(ang)), y: Math.round(dist * Math.sin(ang)) });
    }
    return out;
  }
  // Tree links leave along the depth axis. Sit on the opposite side, then
  // fall back to the cross axis, and only then along the links.
  const dirs = mode === "lr" ? [[-1, 0], [0, -1], [0, 1], [1, 0]] : [[-1, 0], [1, 0], [0, -1], [0, 1]];
  const gapX = Math.round(GEOM.nodeW / 2 + 76);
  const gapY = Math.round(GEOM.nodeH / 2 + 36);
  const out = [];
  for (let step = 0; step < 6; step++) {
    for (const [dx, dy] of dirs) {
      out.push({
        x: Math.round(p.x + dx * (gapX + step * 40)),
        y: Math.round(p.y + dy * (gapY + step * 32)),
      });
    }
  }
  return out;
}

function switchSegments(model, pos, axis) {
  const segs = [];
  const add = (u, v) => {
    const a = pos.get(u);
    const b = pos.get(v);
    if (!a || !b) return;
    const pts = axis ? orthoBend(a, b, axis) : [a, b];
    for (let i = 0; i < pts.length - 1; i++) segs.push([pts[i], pts[i + 1]]);
  };
  for (const e of model.edges) {
    if (e.external) continue;
    add(e.from, e.to);
  }
  for (const n of model.nodes) if (n.parent) add(n.serial, n.parent);
  return segs;
}

function pillRect(p, margin) {
  return { x: p.x - 60 - margin, y: p.y - 15 - margin, w: 120 + margin * 2, h: 30 + margin * 2 };
}

function rectHitsAnySegment(rect, segments) {
  for (const [a, b] of segments) if (rectHitsSegment(rect, a, b)) return true;
  return false;
}

function rectHitsSegment(rect, a, b) {
  if (pointInRect(a, rect) || pointInRect(b, rect)) return true;
  const corners = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.w, y: rect.y },
    { x: rect.x + rect.w, y: rect.y + rect.h },
    { x: rect.x, y: rect.y + rect.h },
  ];
  for (let i = 0; i < 4; i++) if (segmentsTouch(a, b, corners[i], corners[(i + 1) % 4])) return true;
  return false;
}

function pointInRect(p, rect) {
  return p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h;
}

function segmentsTouch(a, b, c, d) {
  const o = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const o1 = o(a, b, c);
  const o2 = o(a, b, d);
  const o3 = o(c, d, a);
  const o4 = o(c, d, b);
  if (o1 === 0 && onSeg(c, a, b)) return true;
  if (o2 === 0 && onSeg(d, a, b)) return true;
  if (o3 === 0 && onSeg(a, c, d)) return true;
  if (o4 === 0 && onSeg(b, c, d)) return true;
  return o1 * o2 < 0 && o3 * o4 < 0;
}

function onSeg(p, a, b) {
  return p.x >= Math.min(a.x, b.x) - 0.5 && p.x <= Math.max(a.x, b.x) + 0.5
    && p.y >= Math.min(a.y, b.y) - 0.5 && p.y <= Math.max(a.y, b.y) + 0.5;
}

function hits(p, w, h, obstacles) {
  for (const o of obstacles) {
    if (Math.abs(p.x - o.p.x) < (w + o.w) / 2 && Math.abs(p.y - o.p.y) < (h + o.h) / 2) return true;
  }
  return false;
}

function compact(points, ids, sizeOf) {
  for (let pass = 0; pass < 48; pass++) {
    let cx = 0, cy = 0;
    for (const id of ids) {
      cx += points.get(id).x;
      cy += points.get(id).y;
    }
    cx /= ids.length;
    cy /= ids.length;
    for (const id of ids) {
      const p = points.get(id);
      p.x = cx + (p.x - cx) * 0.9;
      p.y = cy + (p.y - cy) * 0.9;
    }
    separate(points, ids, sizeOf);
  }
}

function separate(points, ids, sizeOf) {
  for (let pass = 0; pass < 120; pass++) {
    let moved = false;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = points.get(ids[i]), b = points.get(ids[j]);
        const sa = sizeOf(ids[i]), sb = sizeOf(ids[j]);
        const minX = (sa.w + sb.w) / 2;
        const minY = (sa.h + sb.h) / 2;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        if (Math.abs(dx) >= minX || Math.abs(dy) >= minY) continue;
        const ox = minX - Math.abs(dx);
        const oy = minY - Math.abs(dy);
        if (ox <= oy) {
          const s = dx === 0 ? (i % 2 ? 1 : -1) : Math.sign(dx);
          const push = ox / 2 + 0.5;
          a.x -= s * push;
          b.x += s * push;
        } else {
          const s = dy === 0 ? (i % 2 ? 1 : -1) : Math.sign(dy);
          const push = oy / 2 + 0.5;
          a.y -= s * push;
          b.y += s * push;
        }
        moved = true;
      }
    }
    if (!moved) break;
  }
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const polar = (r, a) => ({ x: Math.round(r * Math.cos(a)), y: Math.round(r * Math.sin(a)) });
