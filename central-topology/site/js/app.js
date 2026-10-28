import { buildModel, mgmtOptions, parseOverrides, ROLES, UNASSIGNED } from "./model.js";
import { largeSample } from "./large-sample.js";
import { LAYOUTS, applyPositionOverrides, chipsExpanded, clearPosition, fitScale, layoutById, openingScale, orthoBend, shownBounds, writePosition } from "./layout.js";
import { renderSvg, readTokens } from "./render.js";
import { download, jsonExport, pngBlob, stamp, svgBlob } from "./export.js";
import { CLUSTERS, apiRequest, createVault, mintToken, normalise, tokenValid } from "./creds.js";

const $ = (id) => document.getElementById(id);
// Device data comes from the tenant; escape it before it touches innerHTML.
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const KEYS = { overrides: "ct-overrides", mgmt: "ct-mgmt", theme: "ct-theme", layout: "ct-layout", positions: "ct-positions" };
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));

const state = {
  data: null,
  overrides: load(KEYS.overrides, { coreSerial: null, switches: {} }),
  positions: load(KEYS.positions, {}),
  layout: load(KEYS.layout, "hub"),
  mgmt: load(KEYS.mgmt, "monitor"),
  model: null, lay: null, svg: "",
  view: null,
  openChips: new Set(),
};
if (!LAYOUTS.some((l) => l.id === state.layout)) state.layout = "hub";
if (!state.positions || typeof state.positions !== "object" || Array.isArray(state.positions)) state.positions = {};
document.documentElement.dataset.theme = load(KEYS.theme, "light");

function status(msg, err = false) { const s = $("status"); s.textContent = msg; s.className = err ? "err" : ""; }

const apiBase = (window.CT_CONFIG?.apiBase ?? "").replace(/\/+$/, "");
const vault = createVault({ session: sessionStorage, local: localStorage });
vault.load();

/** Current credentials with a usable token, minting one if needed. Null = mock. */
async function activeCreds() {
  const c = vault.get();
  if (!c) return null;
  if (tokenValid(c)) return c;
  if (c.method !== "client") throw new Error("The bearer token has expired. Paste a new one in Credentials.");
  const fresh = await mintToken(c, { apiBase });
  vault.save(fresh);
  return fresh;
}

function connState() {
  const c = vault.get(); const el = $("connState");
  el.textContent = c ? `Live: ${new URL(c.baseUrl).hostname.split(".")[0]}${vault.remembered() ? " (remembered)" : ""}` : "Not connected (mock)";
  el.className = c ? "conn live" : "conn";
}

async function refresh() {
  status("Loading topology…");
  try {
    if (new URLSearchParams(location.search).get("sample") === "large") {
      const sample = largeSample();
      state.data = sample;
      const saved = state.overrides.coreSerial;
      const known = sample.switches.some((s) => s.serial === saved);
      if (!known) state.overrides = { ...state.overrides, coreSerial: sample.coreSerial };
      $("mockBadge").hidden = false;
      draw();
      return;
    }
    const creds = await activeCreds();
    const { url, init } = apiRequest(apiBase, "/api/topology?include=vlans,interfaces", creds);
    const resp = await fetch(url, init);
    const body = await resp.json();
    if (resp.status === 401 && creds) vault.save({ ...creds, token: null, expiresAt: null });
    if (!resp.ok) throw new Error(body.error ?? `HTTP ${resp.status}`);
    state.data = body;
    $("mockBadge").hidden = !body.mock;
    draw();
  } catch (e) {
    status(`Could not load topology: ${e.message}`, true);
  }
}

// ---------- credentials panel ----------
function cMsg(text, err = false) { $("cMsg").textContent = text; $("cMsg").className = err ? "err" : ""; }
const method = () => document.querySelector("input[name=cMethod]:checked").value;
function showMethod() {
  for (const el of document.querySelectorAll("#credsPanel [data-for]")) el.hidden = el.dataset.for !== method();
}
function fillPanel() {
  const c = vault.get();
  $("cBase").innerHTML = CLUSTERS.map((k) => `<option value="${k.url}"${c?.baseUrl === k.url ? " selected" : ""}>${k.label}</option>`).join("");
  document.querySelector(`input[name=cMethod][value=${c?.method ?? "client"}]`).checked = true;
  $("cId").value = c?.clientId ?? "";
  $("cSecret").value = ""; $("cToken").value = "";
  $("cSecret").placeholder = c?.clientSecret ? "(saved in this browser)" : "";
  $("cToken").placeholder = c?.method === "token" ? "(saved in this browser)" : "";
  $("cRemember").checked = vault.remembered();
  showMethod();
}
function togglePanel(open = $("credsPanel").hidden) {
  $("credsPanel").hidden = !open; $("credsBtn").setAttribute("aria-expanded", String(open));
  if (open) { fillPanel(); cMsg(""); }
}
$("credsBtn").addEventListener("click", () => togglePanel());
$("cClose").addEventListener("click", () => togglePanel(false));
for (const r of document.querySelectorAll("input[name=cMethod]")) r.addEventListener("change", showMethod);
$("cRemember").addEventListener("change", () => { const c = vault.get(); if (c) { vault.save(c, $("cRemember").checked); connState(); } });
$("cConnect").addEventListener("click", async () => {
  const prev = vault.get();
  try {
    const creds = normalise({
      method: method(), baseUrl: $("cBase").value, clientId: $("cId").value,
      clientSecret: $("cSecret").value || (prev?.clientId === $("cId").value.trim() ? prev?.clientSecret : ""),
      token: $("cToken").value || (prev?.method === "token" ? prev.token : ""),
    });
    cMsg(creds.method === "client" ? "Requesting a token from HPE GreenLake…" : "Saved.");
    const ready = creds.method === "client" ? await mintToken(creds, { apiBase }) : creds;
    vault.save(ready, $("cRemember").checked);
    $("cSecret").value = ""; $("cToken").value = "";
    connState(); cMsg("Connected. Loading live data…");
    await refresh();
  } catch (e) { cMsg(e.message, true); }
});
$("cForget").addEventListener("click", () => {
  vault.forget(); fillPanel(); connState(); cMsg("Credentials removed from this browser. Showing mock data.");
  refresh();
});
connState();

function persist() { save(KEYS.overrides, state.overrides); draw(); }

function paint() {
  if (!state.model) return;
  const model = state.model;
  const opts = mgmtOptions(state.data.switches);
  const mgmtLabel = opts.find((o) => o.id === state.mgmt)?.label ?? state.mgmt;
  const layoutLabel = LAYOUTS.find((l) => l.id === state.layout)?.label ?? "Hub and spoke";
  const lay = (state.lay = applyPositionOverrides(layoutById(state.layout, model), state.positions[state.layout]));
  const subtitle = `${model.nodes.length} switches · ${model.buildings.length} buildings · ${layoutLabel} · Mgmt: ${mgmtLabel} · ${state.data.mock ? "MOCK DATA · " : ""}${new Date(state.data.generatedAt).toLocaleString()}`;
  state.svg = renderSvg(model, lay, {
    tokens: readTokens(), mgmt: state.mgmt, title: "Switch topology", subtitle,
  });
  state.subtitle = subtitle;
  mountDiagram();
}

// Title band drawn above the graph in the SVG. A scrolling layout lifts this
// band out of the scroller so it stays on screen.
const HEADER_BAND = 72;

function paneSize(host) {
  const padX = 32;
  const padY = 32;
  let w = host.clientWidth - padX;
  let h = host.clientHeight - padY;
  if (h < 200) h = window.innerHeight - host.getBoundingClientRect().top - padY - 8;
  return { w: Math.max(280, w), h: Math.max(280, h) };
}

function legendHtml(T) {
  const chip = (style, label) => `<span class="lg"><i style="${style}"></i>${esc(label)}</span>`;
  return `<div class="diagram-legend">${[
    chip(`background:${T["--node-core"]}`, "District core"),
    chip(`background:${T["--node-bcore"]}`, "Building core"),
    chip(`background:${T["--node-access"]}`, "Access"),
    chip(`background:${T["--node-ext"]}`, "Other device"),
    chip(`background:transparent;border:1.5px dashed ${T["--warn"]}`, "IP fallback"),
    chip(`background:${T["--edge"]}`, "LLDP fill-in"),
    chip(`background:${T["--edge-inferred"]}`, "Inferred"),
  ].join("")}</div>`;
}

function diagramHead(tokens) {
  return `<div class="diagram-head"><div><div class="diagram-title">Switch topology</div><div class="diagram-sub">${esc(state.subtitle ?? "")}</div></div><div class="diagram-tools"><button type="button" id="zoomOut" aria-label="Zoom out">−</button><button type="button" id="zoomFit">Fit</button><button type="button" id="zoomIn" aria-label="Zoom in">+</button></div>${legendHtml(tokens)}</div>`;
}

function cropped(bounds) {
  return { ...bounds, h: Math.max(1, bounds.h - HEADER_BAND) };
}

function graphAvail(scroller, host) {
  const pane = paneSize(host);
  return {
    w: scroller.clientWidth >= 160 ? scroller.clientWidth : pane.w,
    h: scroller.clientHeight >= 160 ? scroller.clientHeight : Math.max(200, pane.h - 84),
  };
}

function mountDiagram(scrollAfter) {
  const host = $("diagram");
  const lay = state.lay;
  const model = state.model;
  if (!host || !lay?.bounds || !model) return;
  const tokens = readTokens();
  host.innerHTML = `<div class="diagram-card scrolls">${diagramHead(tokens)}<div class="diagram-scroll"></div></div>`;
  const scroller = host.querySelector(".diagram-scroll");
  const avail = graphAvail(scroller, host);
  const reference = lay.id === "tree-lr" ? lay.bounds : layoutById("tree-lr", model).bounds;
  if (!state.view) {
    const opened = shownBounds(lay, model, { collapseAps: true, openChips: state.openChips });
    const scale = openingScale(cropped(opened), avail, cropped(reference));
    state.view = { scale, openedAt: scale, user: false };
    if (scrollAfter === undefined) scrollAfter = "core";
  }
  const expanded = chipsExpanded(state.view.scale, state.view.openedAt);
  const bounds = shownBounds(lay, model, { collapseAps: !expanded, openChips: state.openChips });
  scroller.innerHTML = renderSvg(model, { ...lay, bounds }, {
    tokens, mgmt: state.mgmt, title: "Switch topology", subtitle: state.subtitle,
    collapseAps: !expanded, openChips: state.openChips,
  });
  const svg = scroller.querySelector("svg");
  if (!svg) return;
  const { x, y, w, h } = bounds;
  const scale = state.view.scale;
  let drawW = w * scale;
  let drawH = h * scale;
  if (h > HEADER_BAND) {
    svg.setAttribute("viewBox", `${x} ${y + HEADER_BAND} ${w} ${h - HEADER_BAND}`);
    drawH = (h - HEADER_BAND) * scale;
  }
  svg.style.width = `${Math.max(1, Math.round(drawW))}px`;
  svg.style.height = `${Math.max(1, Math.round(drawH))}px`;
  svg.style.maxWidth = "none";
  svg.style.maxHeight = "none";
  if (drawW <= avail.w + 1 && drawH <= avail.h + 1) {
    scroller.style.display = "grid";
    scroller.style.placeItems = "center";
  }
  if (scrollAfter === "core") centerOpeningScroll();
  else if (scrollAfter && typeof scrollAfter === "object") {
    scroller.scrollLeft = Math.max(0, scrollAfter.left);
    scroller.scrollTop = Math.max(0, scrollAfter.top);
  }
}

function stepZoom(factor) {
  if (!state.view || !state.lay || !state.model) return;
  const scroller = document.querySelector("#diagram .diagram-scroll");
  const avail = graphAvail(scroller, $("diagram"));
  const cx = (scroller?.scrollLeft ?? 0) + avail.w / 2;
  const cy = (scroller?.scrollTop ?? 0) + avail.h / 2;
  const old = state.view.scale;
  const expanded = chipsExpanded(old, state.view.openedAt);
  const bounds = shownBounds(state.lay, state.model, { collapseAps: !expanded, openChips: state.openChips });
  const fit = fitScale(cropped(bounds), avail);
  const next = Math.min(Math.max(old * factor, Math.min(fit, state.view.openedAt) * 0.5), Math.max(state.view.openedAt * 8, fit));
  state.view.scale = next;
  state.view.user = true;
  const ratio = next / old;
  mountDiagram({ left: cx * ratio - avail.w / 2, top: cy * ratio - avail.h / 2 });
}

function fitView() {
  if (!state.view || !state.lay || !state.model) return;
  const scroller = document.querySelector("#diagram .diagram-scroll");
  const avail = graphAvail(scroller, $("diagram"));
  const expanded = chipsExpanded(state.view.scale, state.view.openedAt);
  const bounds = shownBounds(state.lay, state.model, { collapseAps: !expanded, openChips: state.openChips });
  state.view.scale = fitScale(cropped(bounds), avail);
  state.view.user = true;
  mountDiagram({ left: 0, top: 0 });
}

// Size the SVG in px. The width and height attributes on the export string
// stay in user units, so SVG, PNG, and JSON downloads still hold the whole graph.
function fitDiagram() {
  if (!state.svg || !state.lay) return;
  mountDiagram();
}

function centerOpeningScroll() {
  const scroller = document.querySelector("#diagram .diagram-scroll");
  const card = document.querySelector("#diagram .diagram-card");
  if (!scroller || !card?.classList.contains("scrolls") || !state.model?.coreSerial) return;
  const g = scroller.querySelector(`g[data-serial="${CSS.escape(state.model.coreSerial)}"]`);
  const rect = g?.querySelector("rect");
  if (!rect) { scroller.scrollLeft = 0; scroller.scrollTop = 0; return; }
  const nb = rect.getBoundingClientRect();
  const sb = scroller.getBoundingClientRect();
  scroller.scrollLeft += (nb.left + nb.width / 2) - (sb.left + sb.width / 2);
  scroller.scrollTop += (nb.top + nb.height / 2) - (sb.top + sb.height / 2);
}
window.addEventListener("resize", () => {
  if (state.view && !state.view.user) state.view = null;
  fitDiagram();
});
$("diagram").addEventListener("click", (ev) => {
  if (ev.target.closest?.("#zoomIn")) { stepZoom(1.25); return; }
  if (ev.target.closest?.("#zoomOut")) { stepZoom(1 / 1.25); return; }
  if (ev.target.closest?.("#zoomFit")) { fitView(); return; }
  const chip = ev.target.closest?.("[data-chip]");
  if (!chip || !state.openChips) return;
  const scroller = document.querySelector("#diagram .diagram-scroll");
  const keep = scroller ? { left: scroller.scrollLeft, top: scroller.scrollTop } : undefined;
  const id = chip.getAttribute("data-chip");
  if (state.openChips.has(id)) state.openChips.delete(id);
  else state.openChips.add(id);
  mountDiagram(keep);
});

function draw() {
  if (!state.data) return;
  state.view = null;
  state.openChips = new Set();
  const model = (state.model = buildModel(state.data, state.overrides));
  const opts = mgmtOptions(state.data.switches);
  if (!opts.some((o) => o.id === state.mgmt)) state.mgmt = opts[0]?.id ?? "monitor";
  $("mgmtSel").innerHTML = opts.map((o) => `<option value="${esc(o.id)}"${o.id === state.mgmt ? " selected" : ""}>${esc(o.label)} — ${o.count}/${o.total}</option>`).join("");
  const sorted = [...model.nodes].sort((a, b) => a.name.localeCompare(b.name));
  $("coreSel").innerHTML = `<option value="">Auto (highest degree)</option>` + sorted.map((n) => `<option value="${esc(n.serial)}"${state.overrides.coreSerial === n.serial ? " selected" : ""}>${esc(n.name)}</option>`).join("");
  $("layoutSel").value = state.layout;

  paint();
  side(model);
  const w = state.data.warnings ?? [];
  status(`${model.nodes.length} switches, ${model.edges.length} links. Core: ${model.byId.get(model.coreSerial)?.name ?? "none"} (${model.coreSource}).${w.length ? ` ${w.length} warning(s).` : ""}`);
}

function side(model) {
  const buildings = [...new Set([...model.buildings, ...(state.data.sites ?? []).map((s) => s.name)])].sort();
  const html = [];
  for (const b of model.buildings) {
    html.push(`<h2>${esc(b)}</h2>`);
    for (const n of model.nodes.filter((x) => x.building === b).sort((x, y) => (x.hop ?? 99) - (y.hop ?? 99) || x.name.localeCompare(y.name))) {
      const o = state.overrides.switches[n.serial] ?? {};
      const placed = state.positions[state.layout]?.[n.serial];
      html.push(`<div class="sw" data-serial="${esc(n.serial)}"><div class="name">${esc(n.name)} ${o.role || o.building || placed ? '<span class="ovr">override</span>' : ""}</div>
        <div class="meta">${esc(n.serial)} · ${esc(n.model)} · hop ${n.hop ?? "–"} · site ${esc(n.site ?? "none")}</div>
        <div class="row"><select data-k="role">${["", ...ROLES].map((r) => `<option value="${r}"${(o.role ?? "") === r ? " selected" : ""}>${r ? r : `role: ${n.role} (auto)`}</option>`).join("")}</select>
        <select data-k="building">${["", ...buildings, UNASSIGNED].map((x) => `<option value="${esc(x)}"${(o.building ?? "") === x ? " selected" : ""}>${esc(x ? x : `building: ${n.site ?? UNASSIGNED} (site)`)}</option>`).join("")}</select></div>
        ${n.flags.map((f) => `<div class="flag">⚠ ${esc(f)}</div>`).join("")}</div>`);
    }
  }
  const w = state.data.warnings ?? [];
  if (w.length) html.push(`<h2>Warnings</h2>` + w.map((x) => `<div class="warnings">${esc(x)}</div>`).join(""));
  $("side").innerHTML = html.join("");
}

$("side").addEventListener("change", (ev) => {
  const sel = ev.target.closest("select"); const card = ev.target.closest(".sw");
  if (!sel || !card) return;
  const serial = card.dataset.serial;
  const cur = { ...(state.overrides.switches[serial] ?? {}) };
  if (sel.value) cur[sel.dataset.k] = sel.value; else delete cur[sel.dataset.k];
  if (cur.role === "district-core") { state.overrides.coreSerial = serial; delete cur.role; }
  if (Object.keys(cur).length) state.overrides.switches[serial] = cur; else delete state.overrides.switches[serial];
  persist();
});
$("coreSel").addEventListener("change", (e) => { state.overrides.coreSerial = e.target.value || null; persist(); });
$("layoutSel").innerHTML = LAYOUTS.map((l) => `<option value="${esc(l.id)}">${esc(l.label)}</option>`).join("");
$("layoutSel").value = state.layout;
$("layoutSel").addEventListener("change", (e) => {
  state.layout = LAYOUTS.some((l) => l.id === e.target.value) ? e.target.value : "hub";
  save(KEYS.layout, state.layout);
  draw();
});
$("mgmtSel").addEventListener("change", (e) => { state.mgmt = e.target.value; save(KEYS.mgmt, state.mgmt); draw(); });
$("refreshBtn").addEventListener("click", refresh);
$("themeBtn").addEventListener("click", () => {
  const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = t; save(KEYS.theme, t); draw();
});
$("dlSvg").addEventListener("click", () => download(svgBlob(state.svg), `central-topology-${stamp()}.svg`));
$("dlPng").addEventListener("click", async () => {
  try { download(await pngBlob(state.svg), `central-topology-${stamp()}.png`); } catch (e) { status(e.message, true); }
});
$("dlJson").addEventListener("click", () => {
  const body = jsonExport(state.model, state.mgmt, state.overrides, { mock: state.data.mock, generatedAt: state.data.generatedAt, layout: state.layout, positions: state.positions });
  download(new Blob([JSON.stringify(body, null, 2)], { type: "application/json" }), `central-topology-${stamp()}.json`);
});
$("ovExport").addEventListener("click", () => {
  const body = { ...state.overrides };
  if (state.positions && Object.keys(state.positions).length) body.positions = state.positions;
  download(new Blob([JSON.stringify(body, null, 2)], { type: "application/json" }), `central-topology-overrides-${stamp()}.json`);
});
$("ovImport").addEventListener("click", () => $("ovFile").click());
$("ovFile").addEventListener("change", async (e) => {
  const f = e.target.files?.[0]; e.target.value = "";
  if (!f) return;
  try {
    const parsed = parseOverrides(await f.text());
    if (parsed.positions) { state.positions = parsed.positions; save(KEYS.positions, state.positions); delete parsed.positions; }
    state.overrides = parsed;
    persist();
  } catch (err) { status(`Import failed: ${err.message}`, true); }
});
$("ovReset").addEventListener("click", () => { state.overrides = { coreSerial: null, switches: {} }; persist(); });

// Drag a node to store a position for the current layout only. Double-click
// clears that node's override. Capture stays on the diagram so the redraw
// on release does not drop the gesture.
let draggedAt = 0;
function svgPoint(svg, ev) {
  const pt = svg.createSVGPoint();
  pt.x = ev.clientX;
  pt.y = ev.clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const p = pt.matrixTransform(ctm.inverse());
  return { x: p.x, y: p.y };
}
const near = (x, y, p) => Math.hypot(x - p.x, y - p.y) < 0.5;
function edgeEnds(el) {
  if (el.tagName === "line") {
    return {
      a: { x: +el.getAttribute("x1"), y: +el.getAttribute("y1") },
      b: { x: +el.getAttribute("x2"), y: +el.getAttribute("y2") },
      ortho: false,
    };
  }
  if (el.tagName !== "path" || state.lay?.route !== "ortho") return null;
  const nums = [...(el.getAttribute("d") ?? "").matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => +m[0]);
  if (nums.length < 4) return null;
  return {
    a: { x: nums[0], y: nums[1] },
    b: { x: nums[nums.length - 2], y: nums[nums.length - 1] },
    ortho: true,
  };
}
{
  let drag = null;
  const host = $("diagram");
  host.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    const g = ev.target.closest?.("g[data-serial]");
    if (!g || !host.contains(g)) return;
    const svg = host.querySelector("svg");
    const serial = g.dataset.serial;
    const origin = state.lay?.pos.get(serial);
    if (!svg || !origin) return;
    const lines = [...svg.querySelectorAll("line, path")].flatMap((el) => {
      const ends = edgeEnds(el);
      if (!ends) return [];
      const end = near(ends.a.x, ends.a.y, origin) ? "1" : near(ends.b.x, ends.b.y, origin) ? "2" : "";
      if (!end) return [];
      return [{ el, end, ortho: ends.ortho, other: end === "1" ? ends.b : ends.a }];
    });
    drag = { serial, origin, start: svgPoint(svg, ev), g, lines, moved: false, pointer: ev.pointerId };
    host.classList.add("dragging");
    host.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });
  host.addEventListener("pointermove", (ev) => {
    if (!drag || ev.pointerId !== drag.pointer) return;
    const svg = host.querySelector("svg");
    if (!svg) return;
    const p = svgPoint(svg, ev);
    const x = Math.round(drag.origin.x + (p.x - drag.start.x));
    const y = Math.round(drag.origin.y + (p.y - drag.start.y));
    if (x !== drag.origin.x || y !== drag.origin.y) drag.moved = true;
    drag.g.setAttribute("transform", `translate(${x - drag.origin.x} ${y - drag.origin.y})`);
    for (const ln of drag.lines) {
      if (ln.ortho) {
        const a = ln.end === "1" ? { x, y } : ln.other;
        const b = ln.end === "1" ? ln.other : { x, y };
        const pts = orthoBend(a, b, state.lay?.axis);
        ln.el.setAttribute("d", pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" "));
      } else if (ln.end === "1") { ln.el.setAttribute("x1", x); ln.el.setAttribute("y1", y); }
      else { ln.el.setAttribute("x2", x); ln.el.setAttribute("y2", y); }
    }
    drag.x = x;
    drag.y = y;
  });
  const endDrag = (ev) => {
    if (!drag || (ev && ev.pointerId !== drag.pointer)) return;
    const done = drag;
    drag = null;
    host.classList.remove("dragging");
    if (done.moved && Number.isFinite(done.x) && Number.isFinite(done.y)) {
      draggedAt = Date.now();
      state.positions = writePosition(state.positions, state.layout, done.serial, { x: done.x, y: done.y });
      save(KEYS.positions, state.positions);
      paint();
      side(state.model);
    } else done.g?.removeAttribute("transform");
  };
  host.addEventListener("pointerup", endDrag);
  host.addEventListener("pointercancel", endDrag);
  host.addEventListener("dblclick", (ev) => {
    if (Date.now() - draggedAt < 400) return;
    const g = ev.target.closest?.("g[data-serial]");
    if (!g) return;
    const next = clearPosition(state.positions, state.layout, g.dataset.serial);
    state.positions = next;
    save(KEYS.positions, state.positions);
    paint();
    side(state.model);
  });
}

refresh();
