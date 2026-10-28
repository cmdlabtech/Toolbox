// SVG renderer. Produces one self-contained SVG string: every color is
// resolved from theme tokens at render time, so a downloaded file looks the
// same outside the page. Pure function except for tokens passed in.
import { CARD_NAME_FONT, GEOM, accessChipBoxes, orthoBend } from "./layout.js";
import { resolveMgmt } from "./model.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const TOKEN_NAMES = ["--diagram-bg", "--diagram-fg", "--diagram-muted", "--node-core", "--node-bcore", "--node-access",
  "--node-ext", "--node-fill", "--edge", "--edge-inferred", "--warn", "--font-sans", "--font-mono"];

export function readTokens(el = document.documentElement) {
  const cs = getComputedStyle(el);
  return Object.fromEntries(TOKEN_NAMES.map((t) => [t, cs.getPropertyValue(t).trim()]));
}

function orthoPath(a, b, lay) {
  const pts = orthoBend(a, b, lay.axis);
  if (pts.length < 3) return null;
  return pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
}

function routeEdge(a, b, from, to, lay) {
  if (lay.route === "ortho") return orthoPath(a, b, lay);
  if (lay.route !== "gutter" || !lay.boxBySerial) return null;
  const ba = lay.boxBySerial.get(from);
  const bb = lay.boxBySerial.get(to);
  if (!ba || !bb) return null;
  const ga = ba.x - 22;
  const gb = bb.x - 22;
  if (ba === bb) return `M ${a.x} ${a.y} L ${ga} ${a.y} L ${ga} ${b.y} L ${b.x} ${b.y}`;
  const lane = lay.laneY ?? Math.min(ba.y, bb.y) - 28;
  return `M ${a.x} ${a.y} L ${ga} ${a.y} L ${ga} ${lane} L ${gb} ${lane} L ${gb} ${b.y} L ${b.x} ${b.y}`;
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
    const cross = !e.external && fromN && toN && fromN.building !== toN.building;
    const stroke = e.external ? T["--node-ext"] : T["--edge"];
    const width = e.external ? 1.2 : 2;
    drawEdge(a.x, a.y, b.x, b.y, e.from, e.to, `stroke="${stroke}" stroke-width="${width}"${cross ? ` stroke-opacity="0.45"` : ""}${lldp ? ` stroke-dasharray="7 5"` : ""}`, esc(`${e.fromPort ?? "?"} ↔ ${e.toPort ?? "?"}${lldp ? " (LLDP fill-in)" : ""}`));
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

  // Legend
  const lx = x + w - 230, ly = y + 20;
  const items = [["District core", T["--node-core"]], ["Building core", T["--node-bcore"]], ["Access", T["--node-access"]], ["Other device", T["--node-ext"]]];
  items.forEach(([label, c], i) => {
    out.push(`<rect x="${lx}" y="${ly + i * 18}" width="12" height="12" rx="3" fill="${c}"/><text x="${lx + 18}" y="${ly + i * 18 + 10}" font-size="11" fill="${T["--diagram-muted"]}">${label}</text>`);
  });
  out.push(`<rect x="${lx + 110}" y="${ly}" width="12" height="12" rx="3" fill="none" stroke="${T["--warn"]}" stroke-dasharray="3 2"/><text x="${lx + 128}" y="${ly + 10}" font-size="11" fill="${T["--diagram-muted"]}">IP fallback</text>`);
  out.push(`<line x1="${lx + 110}" y1="${ly + 24}" x2="${lx + 124}" y2="${ly + 24}" stroke="${T["--edge"]}" stroke-width="2" stroke-dasharray="4 3"/><text x="${lx + 128}" y="${ly + 28}" font-size="11" fill="${T["--diagram-muted"]}">LLDP fill-in</text>`);
  out.push(`<line x1="${lx + 110}" y1="${ly + 42}" x2="${lx + 124}" y2="${ly + 42}" stroke="${T["--edge-inferred"]}" stroke-width="1.5" stroke-dasharray="2 3"/><text x="${lx + 128}" y="${ly + 46}" font-size="11" fill="${T["--diagram-muted"]}">Inferred</text>`);
  out.push(`</svg>`);
  return out.join("");
}
