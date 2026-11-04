// SVG renderer for the Structured (sections) layout. One self-contained SVG
// string: every color is resolved from theme tokens at render time, so a
// downloaded file looks the same outside the page. The legend lives in the
// page header, as it does for the card layouts.
import { headerWidth, stubLines } from "./structured.js";
import { resolveMgmt } from "./model.js";
import { EMPTY_REGISTRY } from "./stencils.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const shortModel = (m) => String(m ?? "").replace(/^(aruba|hpe)\s+/i, "").replace(/\s+switch$/i, "");
const weight = (e) => { const s = e?.speedGbps; return s == null || s <= 1 ? 1.5 : s >= 40 ? 3.5 : 2.5; };

export function renderStructuredSvg(model, lay, opts) {
  const T = opts.tokens, g = lay.tier;
  const stencils = opts.stencils ?? EMPTY_REGISTRY;
  const { x, y, w, h } = lay.bounds;
  const role = { "district-core": T["--node-core"], "building-core": T["--node-bcore"], access: T["--node-access"], ext: T["--node-ext"] };
  const o = [];
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(h)}" font-family="${esc(T["--font-sans"])}" role="img" aria-label="Switch topology">`);
  o.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${T["--diagram-bg"]}"/>`);
  o.push(`<text x="${x + 24}" y="${y + 34}" font-size="20" font-weight="700" fill="${T["--diagram-fg"]}">${esc(opts.title)}</text>`);
  o.push(`<text x="${x + 24}" y="${y + 56}" font-size="12" fill="${T["--diagram-muted"]}">${esc(opts.subtitle)}</text>`);

  // Section boxes and headers.
  for (const s of lay.sections) {
    o.push(`<g class="section" data-building="${esc(s.name)}"><rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="10" fill="${T["--section-fill"]}" stroke="${s.unassigned ? T["--warn"] : T["--section-border"]}" stroke-width="1"${s.unassigned ? ` stroke-dasharray="5 4"` : ""}/>`);
    const count = `${s.nsw} switch${s.nsw === 1 ? "" : "es"}${s.aps ? ` · ${s.aps} AP${s.aps === 1 ? "" : "s"}` : ""}`;
    const clip = s.headerMax && headerWidth(s.name, s.nsw, s.aps) > s.headerMax ? ` textLength="${s.headerMax}" lengthAdjust="spacingAndGlyphs"` : "";
    o.push(`<text x="${s.x + 16}" y="${s.y + 23}" font-size="12" font-weight="700" letter-spacing="0.72" fill="${T["--diagram-muted"]}"${clip}>${esc(s.name.toUpperCase())}<tspan font-weight="400" letter-spacing="0" dx="8">${esc(count)}</tspan></text></g>`);
  }

  // Internet cloud.
  if (lay.wan) {
    const { x: cx, y: cy } = lay.wan.cloud;
    o.push(`<g class="wan"><path d="M${cx - 46},${cy + 14} a16,16 0 0 1 8,-26 a20,20 0 0 1 36,-6 a16,16 0 0 1 30,10 a14,14 0 0 1 -4,22 z" fill="${T["--section-fill"]}" stroke="${T["--node-ext"]}" stroke-width="1.2"/>`);
    o.push(`<text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="11.5" font-weight="600" fill="${T["--diagram-muted"]}">Internet</text></g>`);
  }

  // Links.
  o.push(`<g class="edges" fill="none" stroke-linecap="square">`);
  for (const l of lay.links) {
    const e = l.edge;
    const down = [l.a, l.b].some((id) => (lay.units.get(id)?.node?.status ?? "").toUpperCase() === "OFFLINE");
    const tok = down ? "--link-down" : l.kind === "stub" ? "--edge" : `--link-${l.kind}`;
    const inferred = !e && !l.decor;
    const stroke = inferred ? T["--edge-inferred"] : T[tok];
    const dash = inferred ? "2 5" : down ? "4 3" : e?.source === "neighbours" ? "7 5" : null;
    const sw = down || inferred ? 1.5 : l.kind === "stub" ? 1.5 : weight(e ?? { speedGbps: 10 });
    const d = l.pts.map(([px, py], i) => `${i ? "L" : "M"}${px} ${py}`).join(" ");
    const tip = l.decor ? "WAN uplink" : !e ? `Inferred: no ${lay.name(l.a)}–${lay.name(l.b)} link in topology data${l.via ? ` (upstream via ${l.via})` : ""}`
      : `${lay.name(e.from)} ${e.fromLabel || e.fromPort || "?"} ↔ ${lay.name(e.to)} ${e.toLabel || e.toPort || "?"}${e.legs > 1 ? ` (${e.legs} links)` : ""}${e.source === "neighbours" ? " (LLDP fill-in)" : ""}${down ? " (down)" : ""}`;
    o.push(`<path data-edge="" data-kind="${l.kind}" data-ends="${esc(l.a)}|${esc(l.b)}" d="${d}" stroke="${stroke}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ""}><title>${esc(tip)}</title></path>`);
    if (e?.legs > 1 && l.kind !== "stub") {
      const segs = l.pts.slice(1).map((q, i) => [l.pts[i], q]);
      const [[ax, ay], [bx]] = segs.reduce((m, s) => (Math.abs(s[0][0] - s[1][0]) > Math.abs(m[0][0] - m[1][0]) ? s : m));
      const mx = (ax + bx) / 2;
      o.push(`<ellipse cx="${mx}" cy="${ay}" rx="4.5" ry="9" stroke="${T["--diagram-fg"]}" stroke-width="1"/>`);
      o.push(`<text x="${mx}" y="${ay - 12}" text-anchor="middle" font-size="10" font-weight="700" fill="${T["--diagram-fg"]}" stroke="none">×${e.legs}</text>`);
    }
  }
  o.push(`</g>`);
  for (const st of lay.stubs) {
    const anchor = st.side === "l" ? "end" : "start", tx = st.side === "l" ? st.x - 4 : st.x + 4;
    o.push(`<g class="stub"><title>${esc(st.labels.join("\n"))}</title>`);
    stubLines(st.labels).forEach((t, i) => o.push(`<text x="${tx}" y="${st.y + 3.5 + i * 12}" text-anchor="${anchor}" font-size="10" fill="${T["--diagram-muted"]}">${esc(t)}</text>`));
    o.push(`</g>`);
  }

  // Faceplate art: one <image> per stencil in <defs>, placed with <use>.
  const arts = new Map();
  const artFor = (model, sku) => {
    const a = stencils.lookup(model, sku);
    if (!a) return null;
    const id = a.sku ?? a.match;
    if (!arts.has(id)) arts.set(id, { ref: `fp-${arts.size}`, href: a.href });
    return arts.get(id).ref;
  };
  const defsAt = o.length;
  o.push("");

  // Units: name label row, then faceplate(s).
  for (const u of lay.units.values()) {
    if (u.x == null) continue;
    const n = u.node, color = role[u.role] ?? T["--node-ext"];
    const m = n ? resolveMgmt(n, opts.mgmt) : null;
    const attr = n ? `data-serial="${esc(u.id)}"` : `data-ext="${esc(u.id)}"`;
    const offline = (n?.status ?? "").toUpperCase() === "OFFLINE";
    const tip = n ? `${n.name} · ${n.model ?? "unknown model"} · ${n.role} · ${n.building} · ${m.ip ? m.ip + (m.fallback ? " (fallback IP)" : "") : "no IP"}${n.stack ? ` · stack of ${n.stack.length}` : ""}${n.flags.length ? " · " + n.flags.join("; ") : ""}`
      : `${u.name} · ${u.ext?.type ?? "device"}${u.via ? ` · connected via ${u.via}` : ""}`;
    o.push(`<g ${attr}${offline ? ` opacity="0.6"` : ""}><title>${esc(tip)}</title>`);
    // First rect: the faceplate area (crossing checks read it).
    o.push(`<rect x="${u.l}" y="${u.ft}" width="${g.fw}" height="${u.fb - u.ft}" fill="none"/>`);
    o.push(`<rect x="${u.x}" y="${u.y + 2}" width="3" height="${g.lab - 5}" rx="1.5" fill="${color}"/>`);
    o.push(`<text x="${u.x + 7}" y="${u.y + g.lab - 4}" font-size="${g.font}" font-weight="700" fill="${T["--diagram-fg"]}">${esc(u.name)}${u.via ? `<tspan font-size="10" font-weight="400" fill="${T["--diagram-muted"]}" dx="6">via ${esc(u.via)}</tspan>` : ""}${u.chips?.length ? `<tspan font-size="10" font-weight="400" fill="${T["--diagram-muted"]}" dx="6">${esc(u.chips.join("  "))}</tspan>` : ""}</text>`);
    const members = n?.stack && !u.collapsed ? n.stack : [{ model: u.model, jNumber: n?.jNumber }];
    members.forEach((mb, i) => {
      const fy = u.ft + i * (g.fh + g.sgap);
      const ref = n ? artFor(mb.model ?? u.model, mb.jNumber) : null;
      if (ref) o.push(`<use href="#${ref}" x="${u.l}" y="${fy}"/>`);
      else {
        o.push(`<rect x="${u.l}" y="${fy}" width="${g.fw}" height="${g.fh}" rx="3" fill="${T["--node-fill"]}" stroke="${color}" stroke-width="1.5"/>`);
        o.push(`<rect x="${u.l}" y="${fy}" width="4" height="${g.fh}" rx="2" fill="${color}"/>`);
        o.push(`<text x="${u.l + g.fw / 2 + 2}" y="${fy + g.fh / 2 + 3.5}" text-anchor="middle" font-size="${g.fh >= 16 ? 9.5 : 8.5}" font-family="${esc(T["--font-mono"])}" fill="${T["--diagram-muted"]}">${esc(shortModel(mb.model ?? u.model) || "Unknown model")}</text>`);
      }
      if (members.length > 1) {
        o.push(`<rect x="${u.l + 5}" y="${fy + g.fh / 2 - 5.5}" width="12" height="11" rx="2" fill="${T["--diagram-fg"]}"/>`);
        o.push(`<text x="${u.l + 11}" y="${fy + g.fh / 2 + 3}" text-anchor="middle" font-size="8.5" font-weight="700" font-family="${esc(T["--font-mono"])}" fill="${T["--diagram-bg"]}">${mb.memberId ?? i + 1}</text>`);
      }
    });
    if (members.length > 1) {
      // Stack connector: a 3px bar near the outer end bridging each member gap.
      const cx = u.outer === "l" ? u.l + 24 : u.r - 14;
      o.push(`<g class="stack-link">`);
      for (let i = 0; i < members.length - 1; i++) {
        const y1 = u.ft + i * (g.fh + g.sgap) + g.fh - 5, y2 = y1 + g.sgap + 10;
        o.push(`<line x1="${cx}" y1="${y1}" x2="${cx}" y2="${y2}" stroke="${T["--link-stack"]}" stroke-width="3"/><rect x="${cx - 3}" y="${y1 - 1}" width="6" height="2.5" fill="${T["--link-stack"]}"/><rect x="${cx - 3}" y="${y2 - 1.5}" width="6" height="2.5" fill="${T["--link-stack"]}"/>`);
      }
      o.push(`</g>`);
    }
    for (const rl of u.id === lay.coreSerial ? lay.rails ?? [] : []) {
      o.push(`<rect class="landing-rail" x="${rl.x}" y="${rl.y0}" width="3" height="${rl.y1 - rl.y0}" rx="1.5" fill="${color}"/>`);
    }
    if (u.collapsed) {
      o.push(`<rect x="${u.r - 38}" y="${u.y}" width="38" height="${g.lab - 2}" rx="7" fill="${T["--diagram-fg"]}"/><text x="${u.r - 19}" y="${u.y + g.lab - 5.5}" text-anchor="middle" font-size="10" font-weight="700" fill="${T["--diagram-bg"]}">×${u.collapsed}</text>`);
    }
    if (m?.fallback || n?.flags.length) {
      const bx = u.r - (u.collapsed ? 46 : 2);
      o.push(`<circle cx="${bx}" cy="${u.ft}" r="7" fill="${T["--warn"]}"/><text x="${bx}" y="${u.ft + 3.5}" text-anchor="middle" font-size="10" font-weight="700" fill="${T["--diagram-bg"]}">!</text>`);
    }
    o.push(`</g>`);
  }
  if (arts.size) o[defsAt] = `<defs>${[...arts.values()].map((a) => `<image id="${a.ref}" width="${g.fw}" height="${g.fh}" preserveAspectRatio="none" href="${esc(a.href)}"/>`).join("")}</defs>`;
  o.push(`</svg>`);
  return o.join("");
}
