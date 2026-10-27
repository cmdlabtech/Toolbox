import { buildModel, mgmtOptions, parseOverrides, ROLES, UNASSIGNED } from "./model.js";
import { layout } from "./layout.js";
import { renderSvg, readTokens } from "./render.js";
import { download, jsonExport, pngBlob, stamp, svgBlob } from "./export.js";
import { CLUSTERS, apiRequest, createVault, mintToken, normalise, tokenValid } from "./creds.js";

const $ = (id) => document.getElementById(id);
// Device data comes from the tenant; escape it before it touches innerHTML.
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const KEYS = { overrides: "ct-overrides", mgmt: "ct-mgmt", theme: "ct-theme" };
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));

const state = { data: null, overrides: load(KEYS.overrides, { coreSerial: null, switches: {} }), mgmt: load(KEYS.mgmt, "monitor"), model: null, svg: "" };
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

function draw() {
  if (!state.data) return;
  const model = (state.model = buildModel(state.data, state.overrides));
  const opts = mgmtOptions(state.data.switches);
  if (!opts.some((o) => o.id === state.mgmt)) state.mgmt = opts[0]?.id ?? "monitor";
  $("mgmtSel").innerHTML = opts.map((o) => `<option value="${esc(o.id)}"${o.id === state.mgmt ? " selected" : ""}>${esc(o.label)} — ${o.count}/${o.total}</option>`).join("");
  const sorted = [...model.nodes].sort((a, b) => a.name.localeCompare(b.name));
  $("coreSel").innerHTML = `<option value="">Auto (highest degree)</option>` + sorted.map((n) => `<option value="${esc(n.serial)}"${state.overrides.coreSerial === n.serial ? " selected" : ""}>${esc(n.name)}</option>`).join("");

  const mgmtLabel = opts.find((o) => o.id === state.mgmt)?.label ?? state.mgmt;
  const lay = layout(model);
  state.svg = renderSvg(model, lay, {
    tokens: readTokens(), mgmt: state.mgmt, title: "Switch topology",
    subtitle: `${model.nodes.length} switches · ${model.buildings.length} buildings · Mgmt: ${mgmtLabel} · ${state.data.mock ? "MOCK DATA · " : ""}${new Date(state.data.generatedAt).toLocaleString()}`,
  });
  $("diagram").innerHTML = state.svg;
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
      html.push(`<div class="sw" data-serial="${esc(n.serial)}"><div class="name">${esc(n.name)} ${o.role || o.building ? '<span class="ovr">override</span>' : ""}</div>
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
  const body = jsonExport(state.model, state.mgmt, state.overrides, { mock: state.data.mock, generatedAt: state.data.generatedAt });
  download(new Blob([JSON.stringify(body, null, 2)], { type: "application/json" }), `central-topology-${stamp()}.json`);
});
$("ovExport").addEventListener("click", () => download(new Blob([JSON.stringify(state.overrides, null, 2)], { type: "application/json" }), `central-topology-overrides-${stamp()}.json`));
$("ovImport").addEventListener("click", () => $("ovFile").click());
$("ovFile").addEventListener("change", async (e) => {
  const f = e.target.files?.[0]; e.target.value = "";
  if (!f) return;
  try { state.overrides = parseOverrides(await f.text()); persist(); } catch (err) { status(`Import failed: ${err.message}`, true); }
});
$("ovReset").addEventListener("click", () => { state.overrides = { coreSerial: null, switches: {} }; persist(); });

refresh();
