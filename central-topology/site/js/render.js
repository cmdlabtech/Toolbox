// SVG renderer. Produces one self-contained SVG string: every color is
// resolved from theme tokens at render time, so a downloaded file looks the
// same outside the page. Pure function except for tokens passed in.
import { GEOM } from "./layout.js";
import { resolveMgmt } from "./model.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const TOKEN_NAMES = ["--diagram-bg", "--diagram-fg", "--diagram-muted", "--node-core", "--node-bcore", "--node-access",
  "--node-ext", "--node-fill", "--edge", "--edge-inferred", "--warn", "--font-sans", "--font-mono"];

export function readTokens(el = document.documentElement) {
  const cs = getComputedStyle(el);
  return Object.fromEntries(TOKEN_NAMES.map((t) => [t, cs.getPropertyValue(t).trim()]));
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
  const at = (id) => lay.pos.get(id) ?? lay.extPos.get(id);

  // Edges first so nodes sit on top.
  out.push(`<g stroke-linecap="round">`);
  const drawn = new Set();
  for (const e of model.edges) {
    const a = at(e.from), b = at(e.to);
    if (!a || !b) continue;
    drawn.add([e.from, e.to].sort().join("|"));
    const lldp = e.source === "neighbours";
    out.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${e.external ? T["--node-ext"] : T["--edge"]}" stroke-width="${e.external ? 1.2 : 2}"${lldp ? ` stroke-dasharray="7 5"` : ""}><title>${esc(`${e.fromPort ?? "?"} ↔ ${e.toPort ?? "?"}${lldp ? " (LLDP fill-in)" : ""}`)}</title></line>`);
  }
  // Inferred tree edges (no link in the data): dotted, so a hub-and-spoke path
  // is always visible back to the district core.
  for (const n of model.nodes) {
    if (!n.parent || !n.parentInferred || drawn.has([n.serial, n.parent].sort().join("|"))) continue;
    const a = at(n.serial), b = at(n.parent);
    if (a && b) out.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${T["--edge-inferred"]}" stroke-width="1.5" stroke-dasharray="2 5"><title>Inferred: no link in topology data</title></line>`);
  }
  out.push(`</g>`);

  for (const s of lay.sectors) {
    out.push(`<text x="${s.labelAt.x}" y="${s.labelAt.y}" text-anchor="middle" font-size="12" font-weight="700" letter-spacing="0.06em" fill="${T["--diagram-muted"]}">${esc(s.building.toUpperCase())}</text>`);
  }

  for (const [id, p] of lay.extPos) {
    const ext = model.externals.find((d) => d.serial === id);
    out.push(`<g><rect x="${p.x - 60}" y="${p.y - 15}" width="120" height="30" rx="15" fill="${T["--diagram-bg"]}" stroke="${T["--node-ext"]}" stroke-dasharray="4 3"/>`);
    out.push(`<text x="${p.x}" y="${p.y + 4}" text-anchor="middle" font-size="11" fill="${T["--diagram-muted"]}">${esc(ext?.name ?? id)}</text></g>`);
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
    out.push(`<text x="${p.x + 3}" y="${p.y - 4}" text-anchor="middle" font-size="12.5" font-weight="700" fill="${T["--diagram-fg"]}">${esc(n.name)}</text>`);
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
