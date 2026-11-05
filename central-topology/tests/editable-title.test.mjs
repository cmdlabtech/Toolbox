// Browser-only diagram title and subtitle edits (localStorage), mirrored into
// the SVG used for SVG/PNG/HTML exports.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { topologyFromFixtures } from "./helpers.mjs";
import { buildModel } from "../site/js/model.js";
import { layoutById } from "../site/js/layout.js";
import { renderSvg } from "../site/js/render.js";
import { htmlExport } from "../site/js/export.js";
import {
  DEFAULT_TITLE, UI_KEYS, cleanLabel, loadPref, readUiPrefs, writeUiPref,
} from "../site/js/prefs.js";

const TOKENS = {
  "--diagram-bg": "#fff", "--diagram-fg": "#111", "--diagram-muted": "#667",
  "--node-core": "#b42318", "--node-bcore": "#1f6feb", "--node-access": "#2f9e6e",
  "--node-ext": "#98a2b3", "--node-fill": "#fff", "--edge": "#8b95a7",
  "--edge-inferred": "#c0c6d2", "--warn": "#c77700", "--link-stack": "#000",
  "--font-sans": "sans-serif", "--font-mono": "monospace",
};

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

test("cleanLabel trims, collapses space, and caps length", () => {
  assert.equal(cleanLabel("  Acme  District  "), "Acme District");
  assert.equal(cleanLabel("x".repeat(200), 120).length, 120);
  assert.equal(cleanLabel(null), "");
  assert.equal(cleanLabel(42), "");
});

test("readUiPrefs defaults title and leaves subtitle auto until saved", () => {
  const empty = readUiPrefs(memoryStorage());
  assert.equal(empty.title, DEFAULT_TITLE);
  assert.equal(empty.subtitleCustom, null);
  const storage = memoryStorage();
  writeUiPref(storage, "title", "Acme · Switch topology");
  writeUiPref(storage, "subtitle", "Site survey · Building A");
  const saved = readUiPrefs(storage);
  assert.equal(saved.title, "Acme · Switch topology");
  assert.equal(saved.subtitleCustom, "Site survey · Building A");
  assert.equal(loadPref(storage, UI_KEYS.title, null), "Acme · Switch topology");
});

test("blank saved title falls back to the default; blank subtitle stays custom empty", () => {
  const storage = memoryStorage();
  writeUiPref(storage, "title", "   ");
  writeUiPref(storage, "subtitle", "");
  const prefs = readUiPrefs(storage);
  assert.equal(prefs.title, DEFAULT_TITLE);
  assert.equal(prefs.subtitleCustom, "");
});

test("SVG and HTML export draw the custom title and subtitle", async () => {
  const data = await topologyFromFixtures();
  const model = buildModel(data, {});
  const title = "Acme ISD · Switch topology";
  const subtitle = "Client site survey";
  const svg = renderSvg(model, layoutById("hub", model), {
    tokens: TOKENS, mgmt: "monitor", title, subtitle, badges: false,
  });
  assert.ok(svg.includes(">" + title + "<"), "SVG draws the custom title");
  assert.ok(svg.includes(">" + subtitle + "<"), "SVG draws the custom subtitle");
  assert.equal(svg.includes(">Switch topology</text>"), false, "default title is gone");
  const html = htmlExport(svg, { title, subtitle, tokens: TOKENS });
  assert.match(html, /<title>Acme ISD · Switch topology · Client site survey<\/title>/);
  assert.ok(html.includes(title), "HTML export keeps the custom title");
});

test("app wires editable title and subtitle inputs to localStorage only", () => {
  const app = readFileSync(new URL("../site/js/app.js", import.meta.url), "utf8");
  assert.match(app, /id="diagramTitle"/);
  assert.match(app, /id="diagramSubtitle"/);
  assert.match(app, /function commitDiagramLabels/);
  assert.match(app, /writeUiPref\(localStorage, "title"/);
  assert.match(app, /writeUiPref\(localStorage, "subtitle"/);
  assert.match(app, /KEYS\.subtitle/);
  assert.match(app, /relatedTarget/, "blur between title and subtitle must not remount");
  assert.match(app, /title: state\.title \|\| DEFAULT_TITLE/);
  assert.match(app, /htmlExport\(state\.svg, \{ title: state\.title \|\| DEFAULT_TITLE/);
  const fn = app.slice(app.indexOf("function commitDiagramLabels"), app.indexOf("function wireDiagramLabels"));
  assert.doesNotMatch(fn, /fetch|api\(|POST|PUT|PATCH/);
  const css = readFileSync(new URL("../site/app.css", import.meta.url), "utf8");
  assert.match(css, /\.diagram-labels/);
  assert.match(css, /\.diagram-title:focus/);
});
