// SVG renderer. Produces one self-contained SVG string: every color is
// resolved from theme tokens at render time, so a downloaded file looks the
// same outside the page. Pure function except for tokens passed in.
import { CARD_NAME_FONT, GEOM, accessChipBoxes, labelBox, linkLeavesBucket, orthoBend } from "./layout.js";
import { resolveMgmt } from "./model.js";
import { PORT_FONT, portsVisible } from "./ports.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const TOKEN_NAMES = ["--diagram-bg", "--diagram-fg", "--diagram-muted", "--node-core", "--node-bcore", "--node-access",
  "--node-ext", "--node-fill", "--edge", "--edge-inferred", "--warn", "--font-sans", "--font-mono"];

export function readTokens(el = document.documentElement) {
  const cs = getComputedStyle(el);
  return Object.fromEntries(TOKEN_NAMES.map((t) => [t, cs.getPropertyValue(t).trim()]));
}

function routeEdge(a, b, from, to, lay) {
  if (lay.route !== "ortho" && lay.route !== "gutter") return null;
  const pts = edgePoints(a, b, from, to, lay);
  if (!pts || pts.length < 3) return null;
  return pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
}

function edgePoints(a, b, from, to, lay) {
  if (lay.route === "ortho") {
    const pts = orthoBend(a, b, lay.axis);
    return pts.length >= 2 ? pts : [a, b];
  }
  if (lay.route === "gutter" && lay.boxBySerial) {
    const ba = lay.boxBySerial.get(from);
    const bb = lay.boxBySerial.get(to);
    if (ba && bb) {
      const ga = ba.x - 22;
      const gb = bb.x - 22;
      if (ba === bb) return [a, { x: ga, y: a.y }, { x: ga, y: b.y }, b];
      const lane = lay.laneY ?? Math.min(ba.y, bb.y) - 28;
      return [a, { x: ga, y: a.y }, { x: ga, y: lane }, { x: gb, y: lane }, { x: gb, y: b.y }, b];
    }
  }
  return [a, b];
}

function pointAlong(points, dist) {
  let left = dist;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    if (left <= len) return { x: a.x + (dx / len) * left, y: a.y + (dy / len) * left, ux: dx / len, uy: dy / len };
    left -= len;
  }
  const a = points[Math.max(0, points.length - 2)];
  const b = points[points.length - 1];
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: b.x, y: b.y, ux: dx / len, uy: dy / len };
}

function polyLength(points) {
  let n = 0;
  for (let i = 0; i < points.length - 1; i++) n += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
  return n;
}

function boxesMiss(a, b) {
  return a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
}

/** Label center just outside the node, beside the link, toward the other end.
 * The first candidate is the #12 spot. Later candidates step aside so a packed
 * block does not land the label on a card. */
function placePortLabel(points, text, slot, avoid = []) {
  const w = Math.ceil(text.length * 6.15) + 8;
  const h = 14;
  const a = points[0];
  const b = points[1] ?? a;
  let dx = b.x - a.x, dy = b.y - a.y;
  let len = Math.hypot(dx, dy);
  if (len < 1) {
    for (let i = 1; i < points.length - 1 && len < 1; i++) {
      dx = points[i + 1].x - points[i].x;
      dy = points[i + 1].y - points[i].y;
      len = Math.hypot(dx, dy);
    }
  }
  len = len || 1;
  const ux = dx / len, uy = dy / len;
  const tx = Math.abs(ux) > 1e-6 ? (GEOM.nodeW / 2) / Math.abs(ux) : Infinity;
  const ty = Math.abs(uy) > 1e-6 ? (GEOM.nodeH / 2) / Math.abs(uy) : Infinity;
  const exit = Math.min(tx, ty);
  const along = Math.abs(ux) * w / 2 + Math.abs(uy) * h / 2;
  const total = polyLength(points);
  let capped = exit + 5 + along;
  if (capped > total * 0.42) capped = Math.max(exit + 4, Math.min(capped, total * 0.3));
  const clearDist = Math.min(exit + 5 + along, Math.max(exit + 4, total / 2 - 2));
  const primary = slot % 2 === 0 ? 1 : -1;
  const baseNudge = 9 + (slot % 3) * 11;
  const tries = [{ dist: capped, nudge: baseNudge, sign: primary }];
  for (const dist of [clearDist, capped]) {
    for (const extra of [0, 16, 32, 48]) {
      for (const sign of [primary, -primary]) tries.push({ dist, nudge: baseNudge + extra, sign });
    }
  }
  const at = (dist, nudge, sign) => {
    const p = pointAlong(points, Math.max(0, dist));
    const x = p.x + -p.uy * nudge * sign;
    const y = p.y + p.ux * nudge * sign;
    return { x, y, w, h, box: { x: x - w / 2, y: y - h / 2, w, h } };
  };
  let fallback = null;
  const seen = new Set();
  const clear = (spot) => avoid.every((o) => boxesMiss(spot.box, o));
  for (const t of tries) {
    const key = `${Math.round(t.dist)}|${t.nudge}|${t.sign}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const spot = at(t.dist, t.nudge, t.sign);
    if (!fallback) fallback = spot;
    if (clear(spot)) return { x: spot.x, y: spot.y, w, h };
  }
  // Packed blocks: keep the label on the card's own margin, beside the end that
  // faces the other switch, so it stays nearer this switch and off the next card.
  const other = points[points.length - 1];
  const horizontal = Math.abs(other.x - a.x) * GEOM.nodeH >= Math.abs(other.y - a.y) * GEOM.nodeW;
  const face = horizontal ? Math.sign(other.x - a.x) || 1 : Math.sign(other.y - a.y) || 1;
  const gap = 4;
  const edge = horizontal
    ? a.x + face * (GEOM.nodeW / 2 - w / 2)
    : a.y + face * (GEOM.nodeH / 2 - h / 2);
  const inX = a.x > 4 ? -1 : 1;
  const inY = a.y > 4 ? -1 : 1;
  const margins = horizontal
    ? [
      { x: edge, y: a.y + inY * (GEOM.nodeH / 2 + gap + h / 2) },
      { x: edge, y: a.y - inY * (GEOM.nodeH / 2 + gap + h / 2) },
    ]
    : [
      { x: a.x + inX * (GEOM.nodeW / 2 + gap + w / 2), y: edge },
      { x: a.x - inX * (GEOM.nodeW / 2 + gap + w / 2), y: edge },
    ];
  for (const base of margins) {
    for (const mul of [0, 1, -1, 2, -2]) {
      const x = base.x + (horizontal ? mul * 14 : 0);
      const y = base.y + (horizontal ? 0 : mul * 12);
      const nearer = Math.hypot(x - a.x, y - a.y) + 1e-6 < Math.hypot(x - other.x, y - other.y);
      const box = { x: x - w / 2, y: y - h / 2, w, h };
      if (nearer && clear({ box })) return { x, y, w, h };
    }
  }
  return { x: fallback.x, y: fallback.y, w, h };
}

export function renderSvg(model, lay, opts) {
  const T = opts.tokens;
  const { x, y, w, h } = lay.bounds;
  const W = GEOM.nodeW, H = GEOM.nodeH;
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(h)}" font-family="${esc(T["--font-sans"])}" role="img" aria-label="Switch topology">`);
  out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${T["--diagram-bg"]}"/>`);
  out.push(`<text x="${x + 24}" y="${y + 34}" font-size="20" font-weight="700" fill="${T["--diagram-fg"]}">${esc(opts.title)}</text>`);
  out.push(`<text x="${x + 24}" y="${y + 56}" font-size="12" fill="${T["--diagram-muted"]}">${esc(opts.subtitle)}</text>`);

  const color = { "district-core": T["--node-core"], "building-core": T["--node-bcore"], access: T["--node-access"] };
  const extPos = lay.extPos ?? new Map();
  const at = (id) => lay.pos.get(id) ?? extPos.get(id);
  const openChips = opts.openChips instanceof Set ? opts.openChips : new Set(opts.openChips ?? []);
  const chips = opts.collapseAps ? accessChipBoxes(model, lay).filter((c) => !openChips.has(c.serial)) : [];
  const hidden = new Set(chips.flatMap((c) => c.ids));

  for (const s of lay.sectors ?? []) {
    if (!s.box) continue;
    out.push(`<rect x="${s.box.x}" y="${s.box.y}" width="${s.box.w}" height="${s.box.h}" rx="10" fill="none" stroke="${T["--diagram-muted"]}" stroke-width="1"/>`);
  }

  // Edges first so nodes sit on top. Site layout routes links through the
  // gutter so a straight segment does not cut across a column of switches.
  out.push(`<g stroke-linecap="round" fill="none">`);
  const drawn = new Set();
  const portLabels = [];
  const portSlots = new Map();
  const showPorts = portsVisible(opts);
  const portAvoid = [];
  for (const n of model.nodes) {
    const p = lay.pos.get(n.serial);
    if (p) portAvoid.push({ x: p.x - W / 2, y: p.y - H / 2, w: W, h: H });
  }
  for (const s of lay.sectors ?? []) {
    const b = labelBox(s);
    if (b) portAvoid.push(b);
  }
  for (const chip of chips) portAvoid.push(chip.box);
  const drawEdge = (x1, y1, x2, y2, from, to, attrs, title) => {
    const d = routeEdge({ x: x1, y: y1 }, { x: x2, y: y2 }, from, to, lay);
    if (d) out.push(`<path d="${d}" ${attrs}><title>${title}</title></path>`);
    else out.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${attrs}><title>${title}</title></line>`);
  };
  for (const e of model.edges) {
    if (hidden.has(e.from) || hidden.has(e.to)) continue;
    const a = at(e.from), b = at(e.to);
    if (!a || !b) continue;
    drawn.add([e.from, e.to].sort().join("|"));
    const lldp = e.source === "neighbours";
    const fromN = model.byId.get(e.from);
    const toN = model.byId.get(e.to);
    const cross = !e.external && linkLeavesBucket(lay, fromN, toN);
    const stroke = e.external ? T["--node-ext"] : T["--edge"];
    const width = e.external ? 1.2 : 2;
    const fromL = e.fromLabel || e.fromPort || "?";
    const toL = e.toLabel || e.toPort || "?";
    drawEdge(a.x, a.y, b.x, b.y, e.from, e.to, `stroke="${stroke}" stroke-width="${width}"${cross ? ` stroke-opacity="0.28"` : ""}${lldp ? ` stroke-dasharray="7 5"` : ""}`, esc(`${fromL} ↔ ${toL}${lldp ? " (LLDP fill-in)" : ""}`));
    if (showPorts && !e.external) {
      const link = [e.from, e.to].sort().join("|");
      const pts = edgePoints(a, b, e.from, e.to, lay);
      const add = (serial, text, points) => {
        if (!text) return;
        const slot = portSlots.get(serial) ?? 0;
        portSlots.set(serial, slot + 1);
        portLabels.push({ serial, link, text, ...placePortLabel(points, text, slot, portAvoid) });
      };
      add(e.from, e.fromLabel, pts);
      add(e.to, e.toLabel, [...pts].reverse());
    }
  }
  for (const chip of chips) {
    const parent = lay.pos.get(chip.serial);
    if (!parent) continue;
    drawEdge(parent.x, parent.y, chip.x, chip.y, chip.serial, chip.ids[0], `stroke="${T["--node-ext"]}" stroke-width="1.2" stroke-dasharray="7 5"`, esc(chip.text));
  }
  // Inferred tree edges (no link in the data): dotted, so a path is always
  // visible back to the district core.
  for (const n of model.nodes) {
    if (!n.parent || !n.parentInferred || drawn.has([n.serial, n.parent].sort().join("|"))) continue;
    const a = at(n.serial), b = at(n.parent);
    if (a && b) drawEdge(a.x, a.y, b.x, b.y, n.serial, n.parent, `stroke="${T["--edge-inferred"]}" stroke-width="1.5" stroke-dasharray="2 5"`, "Inferred: no link in topology data");
  }
  out.push(`</g>`);

  for (const s of lay.sectors ?? []) {
    if (!s.labelAt) continue;
    out.push(`<text x="${s.labelAt.x}" y="${s.labelAt.y}" text-anchor="${s.anchor ?? "middle"}" font-size="12" font-weight="700" letter-spacing="0.06em" fill="${T["--diagram-muted"]}">${esc(s.building.toUpperCase())}</text>`);
  }

  for (const [id, p] of extPos) {
    if (hidden.has(id)) continue;
    const ext = model.externals.find((d) => d.serial === id);
    out.push(`<g><rect x="${p.x - 60}" y="${p.y - 15}" width="120" height="30" rx="15" fill="${T["--diagram-bg"]}" stroke="${T["--node-ext"]}" stroke-dasharray="4 3"/>`);
    out.push(`<text x="${p.x}" y="${p.y + 4}" text-anchor="middle" font-size="11" fill="${T["--diagram-muted"]}">${esc(ext?.name ?? id)}</text></g>`);
  }
  for (const chip of chips) {
    const { x, y, w, h } = chip.box;
    out.push(`<g data-chip="${esc(chip.serial)}" style="cursor:pointer"><title>${esc(chip.text)}</title>`);
    out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${T["--diagram-bg"]}" stroke="${T["--node-ext"]}" stroke-dasharray="4 3"/>`);
    out.push(`<text x="${chip.x}" y="${chip.y + 4}" text-anchor="middle" font-size="11" font-weight="700" fill="${T["--diagram-fg"]}">${esc(chip.text)}</text></g>`);
  }

  for (const n of model.nodes) {
    const p = lay.pos.get(n.serial);
    if (!p) continue;
    const m = resolveMgmt(n, opts.mgmt);
    const stroke = color[n.role];
    const offline = (n.status ?? "").toUpperCase() === "OFFLINE";
    out.push(`<g data-serial="${esc(n.serial)}">`);
    out.push(`<title>${esc(`${n.name} · ${n.role} · ${n.building}${n.flags.length ? " · " + n.flags.join("; ") : ""}`)}</title>`);
    out.push(`<rect x="${p.x - W / 2}" y="${p.y - H / 2}" width="${W}" height="${H}" rx="8" fill="${T["--node-fill"]}" stroke="${stroke}" stroke-width="${n.role === "access" ? 1.5 : 2.5}"${offline ? ` opacity="0.6"` : ""}/>`);
    out.push(`<rect x="${p.x - W / 2}" y="${p.y - H / 2}" width="6" height="${H}" rx="3" fill="${stroke}"/>`);
    out.push(`<text x="${p.x + 3}" y="${p.y - 4}" text-anchor="middle" font-size="${CARD_NAME_FONT}" font-weight="700" fill="${T["--diagram-fg"]}">${esc(n.name)}</text>`);
    const ipText = m.ip ? m.ip + (m.fallback ? " (fallback)" : "") : "no IP";
    out.push(`<text x="${p.x + 3}" y="${p.y + 13}" text-anchor="middle" font-size="11" font-family="${esc(T["--font-mono"])}" fill="${m.fallback ? T["--warn"] : T["--diagram-muted"]}">${esc(ipText)}</text>`);
    if (m.fallback) out.push(`<rect x="${p.x - W / 2 - 4}" y="${p.y - H / 2 - 4}" width="${W + 8}" height="${H + 8}" rx="11" fill="none" stroke="${T["--warn"]}" stroke-width="1.5" stroke-dasharray="5 4"/>`);
    if (n.flags.length) {
      out.push(`<circle cx="${p.x + W / 2 - 2}" cy="${p.y - H / 2 + 2}" r="9" fill="${T["--warn"]}"/><text x="${p.x + W / 2 - 2}" y="${p.y - H / 2 + 6}" text-anchor="middle" font-size="12" font-weight="700" fill="${T["--diagram-bg"]}">!</text>`);
    }
    out.push(`</g>`);
  }

  for (const lab of portLabels) {
    const x = lab.x - lab.w / 2;
    const y = lab.y - lab.h / 2;
    out.push(`<g data-port-end="${esc(lab.serial)}" data-port-link="${esc(lab.link)}">`);
    out.push(`<rect x="${x}" y="${y}" width="${lab.w}" height="${lab.h}" rx="3" fill="${T["--diagram-bg"]}" stroke="${T["--diagram-muted"]}" stroke-width="0.75"/>`);
    out.push(`<text x="${lab.x}" y="${lab.y}" text-anchor="middle" dominant-baseline="middle" font-size="${PORT_FONT}" font-family="${esc(T["--font-mono"])}" fill="${T["--diagram-fg"]}">${esc(lab.text)}</text></g>`);
  }

  // Legend
  const lx = x + w - 230, ly = y + 20;
  const items = [["District core", T["--node-core"]], ["Building core", T["--node-bcore"]], ["Access", T["--node-access"]]];
  items.forEach(([label, c], i) => {
    out.push(`<rect x="${lx}" y="${ly + i * 18}" width="12" height="12" rx="3" fill="${c}"/><text x="${lx + 18}" y="${ly + i * 18 + 10}" font-size="11" fill="${T["--diagram-muted"]}">${label}</text>`);
  });
  out.push(`<rect x="${lx + 110}" y="${ly}" width="12" height="12" rx="3" fill="none" stroke="${T["--warn"]}" stroke-dasharray="3 2"/><text x="${lx + 128}" y="${ly + 10}" font-size="11" fill="${T["--diagram-muted"]}">IP fallback</text>`);
  out.push(`<line x1="${lx + 110}" y1="${ly + 24}" x2="${lx + 124}" y2="${ly + 24}" stroke="${T["--edge"]}" stroke-width="2" stroke-dasharray="4 3"/><text x="${lx + 128}" y="${ly + 28}" font-size="11" fill="${T["--diagram-muted"]}">LLDP fill-in</text>`);
  out.push(`<line x1="${lx + 110}" y1="${ly + 42}" x2="${lx + 124}" y2="${ly + 42}" stroke="${T["--edge-inferred"]}" stroke-width="1.5" stroke-dasharray="2 3"/><text x="${lx + 128}" y="${ly + 46}" font-size="11" fill="${T["--diagram-muted"]}">Inferred</text>`);
  out.push(`</svg>`);
  return out.join("");
}
