// SVG renderer for the Structured (sections) layout. One self-contained SVG
// string: every color is resolved from theme tokens at render time, so a
// downloaded file looks the same outside the page. The legend lives in the
// page header, as it does for the card layouts. All text comes from
// lay.labels, already measured, placed, and ellipsised by structured.js.
import { resolveMgmt, stackLines } from "./model.js";
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

  // VSX pairs: a dashed rounded box around the two members, labelled on its
  // top-left border. The second MC-LAG legs it stands for are in its tooltip.
  for (const v of lay.vsx ?? []) {
    const b = v.box, names = v.members.map(lay.name);
    const tip = [`VSX pair: ${names.join(" + ")}`, ...v.absorbed.map((e) => `${lay.name(e.from)} ${portsOf(e, "from")} ↔ ${lay.name(e.to)} ${portsOf(e, "to")}`)].join("\n");
    o.push(`<g class="vsx-pair" data-vsx="${esc(v.members.join("|"))}"><title>${esc(tip)}</title>`);
    o.push(`<rect x="${b.x0}" y="${b.y0}" width="${b.x1 - b.x0}" height="${b.y1 - b.y0}" rx="8" fill="none" stroke="${T["--diagram-muted"]}" stroke-width="1.2" stroke-dasharray="5 4"/>`);
    o.push(`<rect x="${b.x0 + 8}" y="${b.y0 - 5.5}" width="26" height="11" fill="${T["--section-fill"]}"/>`);
    o.push(`<text x="${b.x0 + 21}" y="${b.y0 + 3.5}" text-anchor="middle" font-size="10" font-weight="700" letter-spacing="0.4" fill="${T["--diagram-muted"]}">VSX</text></g>`);
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
    const tok = l.kind === "peer" ? "--edge" : `--link-${l.kind}`;
    const inferred = !e && !l.decor;
    const stroke = inferred ? T["--edge-inferred"] : T[tok];
    const dash = inferred ? "2 5"  : e?.source === "neighbours" ? "7 5" : null;
    const sw = inferred ? 1.5 : l.kind === "peer" ? 1.5 : weight(e ?? { speedGbps: 10 });
    const d = l.pts.map(([px, py], i) => `${i ? "L" : "M"}${px} ${py}`).join(" ");
    const tip = l.decor ? "WAN uplink" : !e ? `Inferred: no ${lay.name(l.a)}–${lay.name(l.b)} link in topology data${l.via ? ` (upstream via ${l.via})` : ""}`
      : `${lay.name(e.from)} ${portsOf(e, "from")} ↔ ${lay.name(e.to)} ${portsOf(e, "to")}${e.legs > 1 ? ` (${e.legs} links)` : ""}${e.source === "neighbours" ? " (LLDP fill-in)" : ""}`;
    o.push(`<path data-edge="" data-kind="${l.kind}" data-ends="${esc(l.a)}|${esc(l.b)}" d="${d}" stroke="${stroke}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ""}><title>${esc(tip)}</title></path>`);
    o.push(`<path class="edge-hit" data-hit="${esc(l.a)}|${esc(l.b)}" d="${d}" stroke="transparent" stroke-width="9"><title>${esc(tip)}</title></path>`);
    // Cross-building stub: a dot marks where it leaves for the far switch.
    if (l.stub) { const [sx, sy] = l.pts.at(-1); o.push(`<circle data-stub="" cx="${sx}" cy="${sy}" r="2.5" fill="${stroke}" stroke="none"><title>${esc(`${tip} · continues to ${lay.name(l.b)}`)}</title></circle>`); }
    if (e?.legs > 1 && l.kind !== "peer") {
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
  // Warning badges are for the screen; exports leave them out.
  const badges = opts.badges !== false;
  for (const lb of lay.labels) {
    if (lb.kind === "badge" && !badges) continue;
    if (lb.unit) labelsBy.set(lb.unit, [...(labelsBy.get(lb.unit) ?? []), lb]);
    else loose.push(lb);
  }
  const text = (lb) => {
    const tip = lb.full && lb.full !== lb.text ? `<title>${esc(lb.full)}</title>` : "";
    // The mgmt tag sits on a background plate so its own risers tuck behind it.
    const plate = lb.kind === "ip" ? `<rect class="ip-plate" x="${lb.box.x0 - 2}" y="${lb.box.y0 - 1}" width="${lb.box.x1 - lb.box.x0 + 4}" height="${lb.box.y1 - lb.box.y0 + 2}" fill="${T["--diagram-bg"]}"/>` : "";
    return `${plate}<text class="lbl-${lb.kind}" x="${lb.x}" y="${lb.y}"${lb.anchor !== "start" ? ` text-anchor="${lb.anchor}"` : ""} font-size="${lb.size}" font-weight="${lb.weight}"${lb.mono ? ` font-family="${esc(T["--font-mono"])}"` : ""}${lb.ls ? ` letter-spacing="${lb.ls}"` : ""} fill="${color[lb.color] ?? color.muted}">${esc(lb.text)}${tip}</text>`;
  };

  // Units: name block, then faceplate(s), then their labels.
  for (const u of lay.units.values()) {
    if (u.x == null) continue;
    const n = u.node, rc = role[u.role] ?? T["--node-ext"];
    const m = u.mgmt ?? (n ? resolveMgmt(n, opts.mgmt) : null);
    const attr = n ? `data-serial="${esc(u.id)}"` : `data-ext="${esc(u.id)}"`;
    const links = model.edges.filter((e) => e.from === u.id || e.to === u.id)
      .map((e) => (e.from === u.id ? `${portsOf(e, "from")} → ${lay.name(e.to)} ${portsOf(e, "to")}` : `${portsOf(e, "to")} → ${lay.name(e.from)} ${portsOf(e, "from")}`));
    const tip = n ? [`${u.name}${u.name !== n.name ? ` (serial ${n.serial})` : ""}`, `${n.model ?? "unknown model"} · ${n.role} · ${n.building}`, `Serial ${n.serial}`,
      `Mgmt ${m.ip ? m.ip : "none"}`,
      ...stackLines(n), ...(n.flags.length ? [n.flags.join("; ")] : []), ...links].join("\n")
      : [`${u.name} · ${u.ext?.type ?? "device"}${u.via ? ` · connected via ${u.via}` : ""}`, ...links].join("\n");
    o.push(`<g ${attr}><title>${esc(tip)}</title>`);
    // First rect: the faceplate area (crossing checks read it).
    o.push(`<rect x="${u.l}" y="${u.ft}" width="${g.fw}" height="${u.fb - u.ft}" fill="none"/>`);
    o.push(`<rect x="${u.x}" y="${u.y + 3}" width="3" height="11" rx="1.5" fill="${rc}"/>`);
    // Stack: the member-count pill after the name.
    if (u.pill) o.push(`<rect class="stack-pill" x="${u.pill.x}" y="${u.pill.y}" width="${u.pill.w}" height="${u.pill.h}" rx="${u.pill.h / 2}" fill="${T["--diagram-fg"]}"/>`);
    for (const f of u.faces ?? []) {
      // Stack: two faded cards behind the front faceplate, back one first.
      f.shadows?.forEach((sh, i) => o.push(`<rect class="stack-shadow" x="${sh.x}" y="${sh.y}" width="${f.w}" height="${g.fh}" rx="3" fill="${T["--node-fill"]}" stroke="${rc}" stroke-width="1.2" opacity="${i === 0 ? 0.35 : 0.65}"/>`));
      const ref = n ? artFor(f.model, f.jNumber) : null;
      if (ref) o.push(f.w === g.fw ? `<use href="#${ref}" x="${u.l}" y="${f.y}"/>` : `<use href="#${ref}" transform="translate(${u.l} ${f.y}) scale(${f.w / g.fw} 1)"/>`);
      else {
        o.push(`<rect x="${u.l}" y="${f.y}" width="${f.w}" height="${g.fh}" rx="3" fill="${T["--node-fill"]}" stroke="${rc}" stroke-width="1.5"/>`);
        o.push(`<rect x="${u.l}" y="${f.y}" width="4" height="${g.fh}" rx="2" fill="${rc}"/>`);
      }
      if (f.badge && badges) o.push(`<circle class="warn-badge" cx="${f.badge.cx}" cy="${f.badge.cy}" r="${f.badge.r}" fill="${T["--warn"]}"/>`);
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
