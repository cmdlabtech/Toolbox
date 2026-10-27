// Radial hub-and-spoke layout: district core in the middle, one sector per
// building with its building core on the inner ring and access switches on
// the outer ring. Pure function: model in, positions out.

export const GEOM = { r1: 290, r2: 600, rExt: 740, nodeW: 156, nodeH: 46, pad: 40 };

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
    s.labelAt = polar((s.hub ? GEOM.r1 : GEOM.r1 + 40) + GEOM.nodeH + 30, s.mid);
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
  const minX = Math.min(...all.map((p) => p.x)) - GEOM.nodeW / 2 - GEOM.pad;
  const maxX = Math.max(...all.map((p) => p.x)) + GEOM.nodeW / 2 + GEOM.pad;
  const minY = Math.min(...all.map((p) => p.y)) - GEOM.nodeH / 2 - GEOM.pad - 70; // room for title block
  const maxY = Math.max(...all.map((p) => p.y)) + GEOM.nodeH / 2 + GEOM.pad + 30;
  return { pos, extPos, sectors, bounds: { x: minX, y: minY, w: maxX - minX, h: maxY - minY } };
}

const polar = (r, a) => ({ x: Math.round(r * Math.cos(a)), y: Math.round(r * Math.sin(a)) });
