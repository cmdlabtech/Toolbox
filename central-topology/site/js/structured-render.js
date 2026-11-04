// SVG renderer for the Structured (sections) layout. One self-contained SVG
// string: every color is resolved from theme tokens at render time, so a
// downloaded file looks the same outside the page. The legend lives in the
// page header, as it does for the card layouts. All text comes from
// lay.labels, already measured, placed, and ellipsised by structured.js.
import { resolveMgmt } from "./model.js";
import { EMPTY_REGISTRY } from "./stencils.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const weight = (e) => { const s = e?.speedGbps; return s == null || s <= 1 ? 1.5 : s >= 40 ? 3.5 : 2.5; };
const portsOf = (e, end) => (end === "from" ? e.fromLabel || e.fromPort : e.toLabel || e.toPort) || "?";

export function renderStructuredSvg(model, lay, opts) {
  const T = opts.tokens, g = lay.geom;
  const stencils = opts.stencils ?? EMPTY_REGISTRY;
  const { x, y, w, h } = lay.bounds;
  const role = { "district-core": T["--node-core"], "building-core": T["--node-bcore"], access: T["--node-access"], ext: T["--node-ext"] };
  const color = { fg: T["--diagram-fg"], muted: T["--diagram-muted"], bg: T["--diagram-bg"] };
  const o = [];
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" width="${Math.round(w)}" height="${Math.round(h)}" font-family="${esc(T["--font-sans"])}" role="img" aria-label="Switch topology">`);
  o.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${T["--diagram-bg"]}"/>`);
  o.push(`<text x="${x + 24}" y="${y + 34}" font-size="20" font-weight="700" fill="${T["--diagram-fg"]}">${esc(opts.title)}</text>`);
  o.push(`<text x="${x + 24}" y="${y + 56}" font-size="12" fill="${T["--diagram-muted"]}">${esc(opts.subtitle)}</text>`);

  // Section boxes.
  for (const s of lay.sections) {
    o.push(`<rect class="section" data-building="${esc(s.name)}" x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="10" fill="${T["--section-fill"]}" stroke="${s.unassigned ? T["--warn"] : T["--section-border"]}" stroke-width="1"${s.unassigned ? ` stroke-dasharray="5 4"` : ""}/>`);
  }

  // Internet cloud.
  if (lay.wan) {
    const { x: cx, y: cy } = lay.wan.cloud;
    o.push(`<g class="wan"><path d="M${cx - 46},${cy + 14} a16,16 0 0 1 8,-26 a20,20 0 0 1 36,-6 a16,16 0 0 1 30,10 a14,14 0 0 1 -4,22 z" fill="${T["--section-fill"]}" stroke="${T["--node-ext"]}" stroke-width="1.2"/>`);
    o.push(`<text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="11.5" font-weight="600" fill="${T["--diagram-muted"]}">Internet</text></g>`);
  }

  // Links. Port and LAG names live in the tooltip, not inline. A wide
  // transparent twin makes thin lines easy to hover.
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
      : `${lay.name(e.from)} ${portsOf(e, "from")} ↔ ${lay.name(e.to)} ${portsOf(e, "to")}${e.legs > 1 ? ` (${e.legs} links)` : ""}${e.source === "neighbours" ? " (LLDP fill-in)" : ""}${down ? " (down)" : ""}`;
    o.push(`<path data-edge="" data-kind="${l.kind}" data-ends="${esc(l.a)}|${esc(l.b)}" d="${d}" stroke="${stroke}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ""}><title>${esc(tip)}</title></path>`);
    o.push(`<path class="edge-hit" data-hit="${esc(l.a)}|${esc(l.b)}" d="${d}" stroke="transparent" stroke-width="9"><title>${esc(tip)}</title></path>`);
    if (e?.legs > 1 && l.kind !== "stub") {
      const segs = l.pts.slice(1).map((q, i) => [l.pts[i], q]);
      const [[ax, ay], [bx]] = segs.reduce((m, s) => (Math.abs(s[0][0] - s[1][0]) > Math.abs(m[0][0] - m[1][0]) ? s : m));
      const mx = (ax + bx) / 2;
      o.push(`<ellipse cx="${mx}" cy="${ay}" rx="4.5" ry="9" stroke="${T["--diagram-fg"]}" stroke-width="1"/>`);
      o.push(`<text x="${mx}" y="${ay - 12}" text-anchor="middle" font-size="10" font-weight="700" fill="${T["--diagram-fg"]}" stroke="none">×${e.legs}</text>`);
    }
  }
  o.push(`</g>`);

  // Faceplate art: one <image> per stencil in <defs>, placed with <use>.
  const arts = new Map();
  const artFor = (m, sku) => {
    const a = stencils.lookup(m, sku);
    if (!a) return null;
    const id = a.sku ?? a.match;
    if (!arts.has(id)) arts.set(id, { ref: `fp-${arts.size}`, href: a.href });
    return arts.get(id).ref;
  };
  const defsAt = o.length;
  o.push("");

  const labelsBy = new Map();
  const loose = [];
  for (const lb of lay.labels) {
    if (lb.unit) labelsBy.set(lb.unit, [...(labelsBy.get(lb.unit) ?? []), lb]);
    else loose.push(lb);
  }
  const text = (lb) => {
    const tip = lb.full && lb.full !== lb.text ? `<title>${esc(lb.full)}</title>` : "";
    return `<text class="lbl-${lb.kind}" x="${lb.x}" y="${lb.y}"${lb.anchor !== "start" ? ` text-anchor="${lb.anchor}"` : ""} font-size="${lb.size}" font-weight="${lb.weight}"${lb.mono ? ` font-family="${esc(T["--font-mono"])}"` : ""}${lb.ls ? ` letter-spacing="${lb.ls}"` : ""} fill="${color[lb.color] ?? color.muted}">${esc(lb.text)}${tip}</text>`;
  };

  // Units: name block, then faceplate(s), then their labels.
  for (const u of lay.units.values()) {
    if (u.x == null) continue;
    const n = u.node, rc = role[u.role] ?? T["--node-ext"];
    const m = u.mgmt ?? (n ? resolveMgmt(n, opts.mgmt) : null);
    const attr = n ? `data-serial="${esc(u.id)}"` : `data-ext="${esc(u.id)}"`;
    const offline = (n?.status ?? "").toUpperCase() === "OFFLINE";
    const links = model.edges.filter((e) => e.from === u.id || e.to === u.id)
      .map((e) => (e.from === u.id ? `${portsOf(e, "from")} → ${lay.name(e.to)} ${portsOf(e, "to")}` : `${portsOf(e, "to")} → ${lay.name(e.from)} ${portsOf(e, "from")}`));
    const tip = n ? [`${u.name}${u.name !== n.name ? ` (serial ${n.serial})` : ""}`, `${n.model ?? "unknown model"} · ${n.role} · ${n.building}`, `Serial ${n.serial}`,
      `Mgmt ${m.ip ? m.ip + (m.fallback ? " (fallback IP)" : "") : "none"}`,
      ...(n.stack ? [`Stack of ${n.stack.length}`] : []), ...(n.flags.length ? [n.flags.join("; ")] : []), ...links].join("\n")
      : [`${u.name} · ${u.ext?.type ?? "device"}${u.via ? ` · connected via ${u.via}` : ""}`, ...links].join("\n");
    o.push(`<g ${attr}${offline ? ` opacity="0.6"` : ""}><title>${esc(tip)}</title>`);
    // First rect: the faceplate area (crossing checks read it).
    o.push(`<rect x="${u.l}" y="${u.ft}" width="${g.fw}" height="${u.fb - u.ft}" fill="none"/>`);
    o.push(`<rect x="${u.x}" y="${u.y + 3}" width="3" height="11" rx="1.5" fill="${rc}"/>`);
    // Stack connector: a 3px bar joining the member-number squares.
    const faces = u.faces ?? [];
    for (let i = 0; i < faces.length - 1; i++) {
      const a = faces[i].square, b = faces[i + 1].square;
      if (a && b) o.push(`<rect class="stack-link" x="${a.x + a.w / 2 - 1.5}" y="${a.y + a.h}" width="3" height="${b.y - a.y - a.h}" fill="${T["--link-stack"]}"/>`);
    }
    for (const f of faces) {
      const ref = n ? artFor(f.model, f.jNumber) : null;
      if (ref) o.push(`<use href="#${ref}" x="${u.l}" y="${f.y}"/>`);
      else {
        o.push(`<rect x="${u.l}" y="${f.y}" width="${g.fw}" height="${g.fh}" rx="3" fill="${T["--node-fill"]}" stroke="${rc}" stroke-width="1.5"/>`);
        o.push(`<rect x="${u.l}" y="${f.y}" width="4" height="${g.fh}" rx="2" fill="${rc}"/>`);
      }
      if (f.square) o.push(`<rect x="${f.square.x}" y="${f.square.y}" width="${f.square.w}" height="${f.square.h}" rx="2" fill="${T["--diagram-fg"]}"/>`);
      if (f.pill) o.push(`<rect x="${f.pill.x}" y="${f.pill.y}" width="${f.pill.w}" height="${f.pill.h}" rx="7" fill="${T["--diagram-fg"]}"/>`);
      if (f.badge) o.push(`<circle class="warn-badge" cx="${f.badge.cx}" cy="${f.badge.cy}" r="${f.badge.r}" fill="${T["--warn"]}"/>`);
    }
    for (const rl of u.id === lay.coreSerial ? lay.rails ?? [] : []) {
      o.push(`<rect class="landing-rail" x="${rl.x}" y="${rl.y0}" width="3" height="${rl.y1 - rl.y0}" rx="1.5" fill="${rc}"/>`);
    }
    for (const lb of labelsBy.get(u.id) ?? []) o.push(text(lb));
    o.push(`</g>`);
  }
  for (const lb of loose) o.push(text(lb));
  if (arts.size) o[defsAt] = `<defs>${[...arts.values()].map((a) => `<image id="${a.ref}" width="${g.fw}" height="${g.fh}" preserveAspectRatio="none" href="${esc(a.href)}"/>`).join("")}</defs>`;
  o.push(`</svg>`);
  return o.join("");
}
