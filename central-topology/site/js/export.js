// Downloads: SVG (the rendered string), PNG (SVG drawn onto a 2x canvas),
// JSON (model + selected management IPs + overrides).
import { resolveMgmt } from "./model.js";

export function stamp() {
  return new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "").replace(/^(\d{8})/, "$1-");
}

export function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export const svgBlob = (svg) => new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${svg}`], { type: "image/svg+xml" });

export function pngBlob(svg, scale = 2) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(svgBlob(svg));
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = Math.ceil(img.naturalWidth * scale);
      c.height = Math.ceil(img.naturalHeight * scale);
      const ctx = c.getContext("2d");
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encode failed"))), "image/png");
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("SVG could not be rasterized")); };
    img.src = url;
  });
}

export function jsonExport(model, mgmt, overrides, meta) {
  return {
    generatedAt: new Date().toISOString(),
    source: meta,
    mgmtSelection: mgmt,
    districtCore: model.coreSerial,
    buildings: model.buildings.map((b) => ({ name: b, hub: model.hubs[b] ?? null })),
    switches: model.nodes.map((n) => {
      const m = resolveMgmt(n, mgmt);
      return { serial: n.serial, name: n.name, centralName: n.centralName ?? n.name, nameSource: n.nameSource ?? "central", model: n.model, status: n.status, site: n.site, group: n.group ?? null, building: n.building,
        role: n.role, roleSource: n.roleSource, hop: n.hop, parent: n.parent, mgmtIp: m.ip, mgmtIpSource: m.source,
        mgmtFallback: m.fallback, flags: n.flags };
    }),
    links: model.edges.map((e) => ({
      from: e.from, to: e.to, fromPort: e.fromPort, toPort: e.toPort,
      fromLabel: e.fromLabel ?? null, toLabel: e.toLabel ?? null, source: e.source,
    })),
    layout: meta.layout ?? "hub",
    positions: meta.positions ?? {},
    overrides,
  };
}

/**
 * Link check: what Central returned for switches, links and LLDP rows, so a
 * missing uplink can be traced to the row that did not match. Built in the
 * browser from data already loaded. No IPs, VLANs or credentials.
 */
export function linkCheckExport(data) {
  const switches = (data.switches ?? []).map((s) => ({
    serial: s.serial, name: s.name, model: s.model ?? null, site: s.site ?? null,
    deployment: s.deployment ?? null, conductorSerial: s.conductorSerial ?? null, central: s.central ?? null,
  }));
  const known = new Set([...switches.map((s) => s.serial), ...(data.externals ?? []).map((d) => d.serial)]);
  const links = (data.links ?? []).map((l) => ({ from: l.from, to: l.to, fromPort: l.fromPort ?? null, toPort: l.toPort ?? null, source: l.source ?? null }));
  const lldpRows = (data.lldpRows ?? []).map((r) => ({ ...r }));
  return {
    generatedAt: new Date().toISOString(),
    source: { mock: Boolean(data.mock), generatedAt: data.generatedAt ?? null },
    switches,
    links,
    linksToUnknown: links.filter((l) => !known.has(l.from) || !known.has(l.to)),
    lldpRows,
    unmatchedRows: lldpRows.filter((r) => r.matched == null),
  };
}

const escHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Runs in the exported file. Reads only the inline SVG: no network, no data
// beyond what the SVG already draws. Tooltip text is set with textContent.
const HTML_SCRIPT = `(() => {
  const svg = document.querySelector("#diagram svg"), card = document.getElementById("card");
  for (const t of [...svg.querySelectorAll("title")]) { const p = t.parentNode; if (p !== svg) { p.dataset.tip = t.textContent; t.remove(); } }
  const edges = [...svg.querySelectorAll("[data-ends]")];
  const lit = new Set();
  const clear = () => { for (const e of lit) e.classList.remove("hl"); lit.clear(); svg.classList.remove("focus"); };
  const light = (list) => { clear(); for (const e of list) { e.classList.add("hl"); lit.add(e); } if (list.length) svg.classList.add("focus"); };
  svg.addEventListener("pointermove", (ev) => {
    if (drag) return;
    const el = ev.target.closest("[data-serial][data-tip],[data-ext][data-tip]") ?? ev.target.closest("[data-tip]");
    if (!el) { card.hidden = true; clear(); return; }
    card.textContent = el.dataset.tip; card.hidden = false;
    const r = card.getBoundingClientRect(), x = ev.clientX + 14, y = ev.clientY + 14;
    card.style.left = Math.min(x, innerWidth - r.width - 8) + "px"; card.style.top = Math.min(y, innerHeight - r.height - 8) + "px";
    const node = el.closest("[data-serial],[data-ext]");
    if (node) { const id = node.dataset.serial ?? node.dataset.ext; light(edges.filter((e) => e.dataset.ends.split("|").includes(id))); node.classList.add("hl"); lit.add(node); }
    else if (el.dataset.ends || el.dataset.hit) { const k = el.dataset.ends ?? el.dataset.hit; light(edges.filter((e) => e.dataset.ends === k)); }
    else clear();
  });
  svg.addEventListener("pointerleave", () => { card.hidden = true; clear(); });
  const home = svg.viewBox.baseVal, vb0 = [home.x, home.y, home.width, home.height];
  let vb = [...vb0], drag = null;
  const set = () => svg.setAttribute("viewBox", vb.join(" "));
  const zoom = (k, cx = 0.5, cy = 0.5) => { const w = vb[2] * k, h = vb[3] * k; vb = [vb[0] + (vb[2] - w) * cx, vb[1] + (vb[3] - h) * cy, w, h]; set(); };
  svg.addEventListener("wheel", (ev) => { ev.preventDefault(); const r = svg.getBoundingClientRect(); zoom(ev.deltaY > 0 ? 1.15 : 1 / 1.15, (ev.clientX - r.left) / r.width, (ev.clientY - r.top) / r.height); }, { passive: false });
  svg.addEventListener("pointerdown", (ev) => { drag = { x: ev.clientX, y: ev.clientY, vb: [...vb] }; svg.setPointerCapture(ev.pointerId); card.hidden = true; });
  svg.addEventListener("pointermove", (ev) => { if (!drag) return; const r = svg.getBoundingClientRect(), s = Math.max(vb[2] / r.width, vb[3] / r.height); vb = [drag.vb[0] - (ev.clientX - drag.x) * s, drag.vb[1] - (ev.clientY - drag.y) * s, vb[2], vb[3]]; set(); });
  svg.addEventListener("pointerup", () => { drag = null; });
  document.getElementById("zin").onclick = () => zoom(1 / 1.25);
  document.getElementById("zout").onclick = () => zoom(1.25);
  document.getElementById("zreset").onclick = () => { vb = [...vb0]; set(); };
  svg.addEventListener("dblclick", () => { vb = [...vb0]; set(); });
})();`;

/**
 * One self-contained, offline .html file: the current view's SVG inline, with
 * hover cards (from the SVG's own tooltips), link highlight, and pan/zoom.
 * The SVG already carries the title and header line. Nothing is fetched.
 */
export function htmlExport(svg, { title = "Switch topology", subtitle = "", tokens = {} } = {}) {
  const bg = tokens["--diagram-bg"] ?? "#ffffff", fg = tokens["--diagram-fg"] ?? "#16181d", muted = tokens["--diagram-muted"] ?? "#5d6573";
  const css = (v) => String(v).replace(/[^#\w(),.% -]/g, "");
  const body = svg.replace(/^<svg([^>]*?) width="[^"]*" height="[^"]*"/, '<svg$1 preserveAspectRatio="xMidYMid meet"');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<title>${escHtml(title)}${subtitle ? ` · ${escHtml(subtitle)}` : ""}</title>
<style>
html,body{margin:0;height:100%;background:${css(bg)};color:${css(fg)};font:13px system-ui,sans-serif}
#diagram{position:fixed;inset:0}#diagram svg{width:100%;height:100%;cursor:grab;touch-action:none}
#diagram svg:active{cursor:grabbing}
svg.focus [data-ends]:not(.hl){opacity:.18}
[data-ends].hl{stroke-width:4px}
g.hl>rect{stroke-width:2.5px}
#card{position:fixed;max-width:420px;padding:8px 10px;border-radius:8px;background:${css(fg)};color:${css(bg)};font:12px ui-monospace,monospace;white-space:pre-wrap;pointer-events:none;box-shadow:0 4px 16px rgba(0,0,0,.25)}
#zoom{position:fixed;right:12px;bottom:12px;display:flex;gap:4px}
#zoom button{min-width:32px;height:28px;border:1px solid ${css(muted)};border-radius:6px;background:${css(bg)};color:${css(fg)};font:inherit;cursor:pointer}
</style></head><body>
<div id="diagram">${body}</div>
<div id="card" hidden></div>
<div id="zoom"><button id="zin" type="button" aria-label="Zoom in">+</button><button id="zout" type="button" aria-label="Zoom out">−</button><button id="zreset" type="button">Reset</button></div>
<script>${HTML_SCRIPT}</script>
</body></html>
`;
}
