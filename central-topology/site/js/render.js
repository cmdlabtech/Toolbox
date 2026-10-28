// SVG renderer. Produces one self-contained SVG string: every color is
// resolved from theme tokens at render time, so a downloaded file looks the
// same outside the page. Pure function except for tokens passed in.
import { CARD_NAME_FONT, GEOM, accessChipBoxes, labelBox, linkLeavesBucket, orthoBend, shownBounds } from "./layout.js";
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

function labelSize(text) {
  return { w: Math.ceil(String(text ?? "").length * 6.15) + 8, h: 14 };
}

function misses(box, avoid, gap = 3) {
  const ax2 = box.x + box.w + gap;
  const ay2 = box.y + box.h + gap;
  const ax = box.x - gap;
  const ay = box.y - gap;
  for (const o of avoid) {
    if (ax2 <= o.x || o.x + o.w <= ax || ay2 <= o.y || o.y + o.h <= ay) continue;
    return false;
  }
  return true;
}

/** Label just outside this switch, on the side the link leaves, clear of cards and other labels. */
function placePortLabel(anchor, points, text, slot, avoid) {
  const { w, h } = labelSize(text);
  const nxt = points[1] ?? points[points.length - 1] ?? anchor;
  const horizontal = Math.abs(nxt.x - anchor.x) >= Math.abs(nxt.y - anchor.y);
  const face = horizontal ? Math.sign(nxt.x - anchor.x) || -1 : Math.sign(nxt.y - anchor.y) || 1;
  const pitchX = w + 6;
  const pitchY = h + 4;
  const tryAt = (x, y) => {
    const box = { x: x - w / 2, y: y - h / 2, w, h };
    return misses(box, avoid) ? { x, y, w, h } : null;
  };
  const stack = Math.ceil(slot / 2) * (slot % 2 === 0 ? 1 : -1);
  if (horizontal) {
    const x0 = anchor.x + face * (GEOM.nodeW / 2 + 8 + w / 2);
    for (let col = 0; col < 6; col++) {
      for (let row = 0; row < 16; row++) {
        const dir = row % 2 === 0 ? 1 : -1;
        const step = Math.ceil(row / 2);
        const hit = tryAt(x0 + face * col * pitchX, anchor.y + (stack + dir * step) * pitchY);
        if (hit) return hit;
      }
    }
  } else {
    const y0 = anchor.y + face * (GEOM.nodeH / 2 + 8 + h / 2);
    for (let col = 0; col < 6; col++) {
      for (let row = 0; row < 16; row++) {
        const dir = row % 2 === 0 ? 1 : -1;
        const step = Math.ceil(row / 2);
        const hit = tryAt(anchor.x + (stack + dir * step) * Math.min(pitchX, 72), y0 + face * col * pitchY);
        if (hit) return hit;
      }
    }
  }
  for (let step = 0; step < 80; step++) {
    const col = step % 8;
    const row = Math.floor(step / 8) - 4;
    const hit = tryAt(
      anchor.x + face * (GEOM.nodeW / 2 + 8 + w / 2 + col * pitchX),
      anchor.y + row * pitchY,
    );
    if (hit) return hit;
  }
  return {
    x: anchor.x + face * (GEOM.nodeW / 2 + 8 + w / 2),
    y: anchor.y + stack * pitchY,
    w,
    h,
  };
}

function openChipSet(opts) {
  return opts.openChips instanceof Set ? opts.openChips : new Set(opts.openChips ?? []);
}

function framingBase(model, lay, opts) {
  if (opts.collapseAps || opts.padTop != null || opts.padX != null || opts.minWidth != null) return shownBounds(lay, model, opts);
  return lay.bounds ?? shownBounds(lay, model, opts);
}

function inflate(bounds, rects, pad = 16) {
  let x = bounds.x;
  let y = bounds.y;
  let right = bounds.x + bounds.w;
  let bottom = bounds.y + bounds.h;
  for (const box of rects) {
    if (!box || !Number.isFinite(box.x) || !Number.isFinite(box.y)) continue;
    const w = box.w || 0;
    const h = box.h || 0;
    if (box.x - pad < x) x = box.x - pad;
    if (box.y - pad < y) y = box.y - pad;
    if (box.x + w + pad > right) right = box.x + w + pad;
    if (box.y + h + pad > bottom) bottom = box.y + h + pad;
  }
  return { x, y, w: right - x, h: bottom - y };
}

/** Chips, port labels, and the view box that contains every one of them plus the links. */
export function prepareDiagram(model, lay, opts = {}) {
  const extPos = lay.extPos ?? new Map();
  const at = (id) => lay.pos.get(id) ?? extPos.get(id);
  const openChips = openChipSet(opts);
  const chips = opts.collapseAps ? accessChipBoxes(model, lay).filter((c) => !openChips.has(c.serial)) : [];
  const hidden = new Set(chips.flatMap((c) => c.ids));
  const base = framingBase(model, lay, opts);
  const avoid = [{ x: base.x, y: base.y, w: base.w, h: 72 }];
  for (const n of model.nodes) {
    const p = lay.pos.get(n.serial);
    if (p) avoid.push({ x: p.x - GEOM.nodeW / 2, y: p.y - GEOM.nodeH / 2, w: GEOM.nodeW, h: GEOM.nodeH });
  }
  for (const [id, p] of extPos) {
    if (hidden.has(id)) continue;
    avoid.push({ x: p.x - 60, y: p.y - 15, w: 120, h: 30 });
  }
  for (const s of lay.sectors ?? []) {
    const b = labelBox(s);
    if (b) avoid.push(b);
  }
  for (const chip of chips) avoid.push(chip.box);

  const portLabels = [];
  const showPorts = portsVisible(opts);
  const slots = new Map();
  if (showPorts) {
    for (const e of model.edges) {
      if (e.external || hidden.has(e.from) || hidden.has(e.to)) continue;
      const a = at(e.from);
      const b = at(e.to);
      if (!a || !b) continue;
      const pts = edgePoints(a, b, e.from, e.to, lay);
      const link = [e.from, e.to].sort().join("|");
      const add = (serial, text, points) => {
        if (!text) return;
        const slot = slots.get(serial) ?? 0;
        slots.set(serial, slot + 1);
        const placed = placePortLabel(points[0], points, text, slot, avoid);
        avoid.push({ x: placed.x - placed.w / 2, y: placed.y - placed.h / 2, w: placed.w, h: placed.h });
        portLabels.push({ serial, link, text, ...placed });
      };
      add(e.from, e.fromLabel, pts);
      add(e.to, e.toLabel, [...pts].reverse());
    }
  }

  const extras = [];
  for (const lab of portLabels) extras.push({ x: lab.x - lab.w / 2, y: lab.y - lab.h / 2, w: lab.w, h: lab.h });
  for (const chip of chips) extras.push(chip.box);
  const pushPoly = (a, b, from, to) => {
    for (const p of edgePoints(a, b, from, to, lay)) extras.push({ x: p.x, y: p.y, w: 0, h: 0 });
  };
  for (const e of model.edges) {
    if (hidden.has(e.from) || hidden.has(e.to)) continue;
    const a = at(e.from);
    const b = at(e.to);
    if (a && b) pushPoly(a, b, e.from, e.to);
  }
  for (const chip of chips) {
    const parent = lay.pos.get(chip.serial);
    if (parent) pushPoly(parent, { x: chip.x, y: chip.y }, chip.serial, chip.ids[0]);
  }
  for (const n of model.nodes) {
    if (!n.parent || !n.parentInferred) continue;
    const a = at(n.serial);
    const b = at(n.parent);
    if (a && b) pushPoly(a, b, n.serial, n.parent);
  }
  return { chips, hidden, portLabels, bounds: inflate(base, extras, 16) };
}

/** View box for the diagram that is on screen or in an export. */
export function contentBounds(model, lay, opts = {}) {
  return prepareDiagram(model, lay, opts).bounds;
}

export function renderSvg(model, lay, opts) {
  const T = opts.tokens;
  const prepared = prepareDiagram(model, lay, opts);
  const { x, y, w, h } = prepared.bounds;
  const W = GEOM.nodeW, H = GEOM.nodeH;
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(h)}" font-family="${esc(T["--font-sans"])}" role="img" aria-label="Switch topology">`);
  out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${T["--diagram-bg"]}"/>`);
  out.push(`<text x="${x + 24}" y="${y + 34}" font-size="20" font-weight="700" fill="${T["--diagram-fg"]}">${esc(opts.title)}</text>`);
  out.push(`<text x="${x + 24}" y="${y + 56}" font-size="12" fill="${T["--diagram-muted"]}">${esc(opts.subtitle)}</text>`);

  const color = { "district-core": T["--node-core"], "building-core": T["--node-bcore"], access: T["--node-access"] };
  const extPos = lay.extPos ?? new Map();
  const at = (id) => lay.pos.get(id) ?? extPos.get(id);
  const chips = prepared.chips;
  const hidden = prepared.hidden;

  for (const s of lay.sectors ?? []) {
    if (!s.box) continue;
    out.push(`<rect x="${s.box.x}" y="${s.box.y}" width="${s.box.w}" height="${s.box.h}" rx="10" fill="none" stroke="${T["--diagram-muted"]}" stroke-width="1"/>`);
  }

  // Edges first so nodes sit on top. Site layout routes links through the
  // gutter so a straight segment does not cut across a column of switches.
  out.push(`<g stroke-linecap="round" fill="none">`);
  const drawn = new Set();
  const portLabels = prepared.portLabels;
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
