import { buildModel, mgmtOptions, parseOverrides, ROLES, UNASSIGNED } from "./model.js";
import { LAYOUTS, applyPositionOverrides, clearPosition, layoutById, writePosition } from "./layout.js";
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
  state.svg = renderSvg(model, lay, {
    tokens: readTokens(), mgmt: state.mgmt, title: "Switch topology",
    subtitle: `${model.nodes.length} switches · ${model.buildings.length} buildings · ${layoutLabel} · Mgmt: ${mgmtLabel} · ${state.data.mock ? "MOCK DATA · " : ""}${new Date(state.data.generatedAt).toLocaleString()}`,
  });
  $("diagram").innerHTML = state.svg;
}

function draw() {
  if (!state.data) return;
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
    const lines = [...svg.querySelectorAll("line")].flatMap((el) => {
      const x1 = +el.getAttribute("x1"), y1 = +el.getAttribute("y1");
      const x2 = +el.getAttribute("x2"), y2 = +el.getAttribute("y2");
      const end = near(x1, y1, origin) ? "1" : near(x2, y2, origin) ? "2" : "";
      return end ? [{ el, end }] : [];
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
      if (ln.end === "1") { ln.el.setAttribute("x1", x); ln.el.setAttribute("y1", y); }
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
