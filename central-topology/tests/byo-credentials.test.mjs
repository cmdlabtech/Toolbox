// Bring-your-own credentials: proves the Worker keeps no credential (no env
// secret, no storage, no cache, no log) and that requests without credentials
// fall back to mock or fail with a clear 401.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import worker from "../worker/src/index.ts";
import { fixtureGetter } from "./helpers.mjs";

const TOKEN = "tok-FAKE-0123456789abcdef";        // obviously fake test value
const SECRET = "sec-FAKE-fedcba9876543210";      // obviously fake test value
const BASE = "https://us1.api.central.arubanetworks.com";
const SSO = "https://sso.common.cloud.hpe.com/as/token.oauth2";
const ORIGIN = "https://central-topology.pages.dev";
const ENV = { MOCK: "1", ALLOWED_ORIGINS: ORIGIN };
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

/** Stub fetch (upstream Central/SSO) and every console method; record all. */
function harness(upstream) {
  const calls = [], logs = [];
  const realFetch = globalThis.fetch, realConsole = { ...console };
  const cacheTouches = [];
  const realCaches = globalThis.caches;
  globalThis.caches = new Proxy({}, { get: (_t, k) => { cacheTouches.push(k); return () => { throw new Error("cache used"); }; } });
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init.headers);
    const body = init.body == null ? null : String(init.body);
    calls.push({ url, headers, body, method: init.method ?? "GET" });
    return upstream(url, headers, body);
  };
  for (const k of ["log", "info", "warn", "error", "debug", "trace"]) console[k] = (...a) => logs.push(a.map(String).join(" "));
  return {
    calls, logs, cacheTouches,
    restore() { globalThis.fetch = realFetch; Object.assign(console, realConsole); globalThis.caches = realCaches; },
  };
}

const getter = fixtureGetter();
const centralUpstream = async (url, headers) => {
  if (headers.get("Authorization") !== `Bearer ${TOKEN}`) return new Response("denied", { status: 401 });
  return Response.json(await getter(url.pathname));
};

const req = (path, { headers = {}, method = "GET", body } = {}) =>
  new Request(`http://localhost${path}`, { method, headers, body });
const liveHeaders = { Authorization: `Bearer ${TOKEN}`, "X-Central-Base": BASE };

test("no credentials + MOCK default: mock data, no upstream call, no-store", async () => {
  const h = harness(centralUpstream);
  try {
    const resp = await worker.fetch(req("/api/topology"), {});
    const body = await resp.json();
    assert.equal(resp.status, 200);
    assert.equal(body.mock, true);
    assert.equal(resp.headers.get("X-Data-Source"), "mock");
    assert.equal(resp.headers.get("Cache-Control"), "no-store");
    assert.ok(body.switches.length > 0);
    assert.equal(h.calls.length, 0);
  } finally { h.restore(); }
});

test("no credentials + MOCK=0: clear 401, no upstream call", async () => {
  const h = harness(centralUpstream);
  try {
    const resp = await worker.fetch(req("/api/topology"), { MOCK: "0" });
    const body = await resp.json();
    assert.equal(resp.status, 401);
    assert.match(body.error, /No Central credentials sent/);
    assert.equal(resp.headers.get("Cache-Control"), "no-store");
    assert.equal(h.calls.length, 0);
  } finally { h.restore(); }
});

test("credentials in the query string are ignored, never used", async () => {
  const h = harness(centralUpstream);
  try {
    const q = `?access_token=${TOKEN}&token=${TOKEN}&client_secret=${SECRET}&base=${encodeURIComponent(BASE)}`;
    const mock = await worker.fetch(req(`/api/topology${q}`), ENV);
    assert.equal((await mock.json()).mock, true);
    const strict = await worker.fetch(req(`/api/topology${q}`), { MOCK: "0" });
    assert.equal(strict.status, 401);
    assert.equal(h.calls.length, 0);
  } finally { h.restore(); }
});

test("header credentials: live pass-through with the caller's token, no-store", async () => {
  const h = harness(centralUpstream);
  try {
    const resp = await worker.fetch(req("/api/topology", { headers: liveHeaders }), { MOCK: "0" });
    const body = await resp.json();
    assert.equal(resp.status, 200, JSON.stringify(body));
    assert.equal(body.mock, false);
    assert.equal(resp.headers.get("X-Data-Source"), "live");
    assert.equal(resp.headers.get("Cache-Control"), "no-store");
    assert.ok(body.switches.length >= 19);
    assert.ok(h.calls.length > 0);
    for (const c of h.calls) {
      assert.equal(c.url.origin, BASE);
      assert.equal(c.method, "GET");
      assert.equal(c.headers.get("Authorization"), `Bearer ${TOKEN}`);
      assert.ok(!c.url.search.includes(TOKEN), "token never in an upstream URL");
    }
    assert.ok(!JSON.stringify(body).includes(TOKEN));
  } finally { h.restore(); }
});

test("nothing persists between requests: a later request without credentials is mock/401", async () => {
  const h = harness(centralUpstream);
  try {
    const globalsBefore = new Set(Object.getOwnPropertyNames(globalThis));
    await worker.fetch(req("/api/sites", { headers: liveHeaders }), ENV);
    const n = h.calls.length;
    assert.ok(n > 0);
    const after = await worker.fetch(req("/api/sites"), ENV);
    assert.equal(after.headers.get("X-Data-Source"), "mock");
    assert.equal((await worker.fetch(req("/api/sites"), { MOCK: "0" })).status, 401);
    assert.equal(h.calls.length, n, "no upstream call reused the earlier token");
    const added = Object.getOwnPropertyNames(globalThis).filter((k) => !globalsBefore.has(k));
    assert.deepEqual(added, []);
    assert.deepEqual(h.cacheTouches, [], "Cache API never touched");
  } finally { h.restore(); }
});

test("upstream errors echoing the token are scrubbed; nothing is logged", async () => {
  const h = harness(async () => new Response(`bad gateway; Authorization: Bearer ${TOKEN}; token=${TOKEN}; raw ${TOKEN}`, { status: 502 }));
  try {
    const resp = await worker.fetch(req("/api/sites", { headers: liveHeaders }), ENV);
    const text = await resp.text();
    assert.ok(resp.status >= 400);
    assert.ok(!text.includes(TOKEN), text);
    assert.equal(resp.headers.get("Cache-Control"), "no-store");
    const topo = await worker.fetch(req("/api/topology", { headers: liveHeaders }), ENV);
    assert.ok(!(await topo.text()).includes(TOKEN));
    assert.deepEqual(h.logs, [], "Worker wrote nothing to the console");
  } finally { h.restore(); }
});

test("rejected token gives 401 with a reconnect hint", async () => {
  const h = harness(centralUpstream);
  try {
    const resp = await worker.fetch(req("/api/sites", { headers: { Authorization: "Bearer wrong-FAKE", "X-Central-Base": BASE } }), ENV);
    assert.equal(resp.status, 401);
    assert.match((await resp.json()).error, /Reconnect/);
  } finally { h.restore(); }
});

test("base URL allowlist blocks non-Central targets (no open proxy)", async () => {
  const h = harness(centralUpstream);
  try {
    for (const base of ["http://us1.api.central.arubanetworks.com", "https://169.254.169.254", "https://evil.example.com",
      "https://us1.api.central.arubanetworks.com.evil.com", "https://internal.api.central.arubanetworks.com", ""]) {
      const resp = await worker.fetch(req("/api/sites", { headers: { Authorization: `Bearer ${TOKEN}`, "X-Central-Base": base } }), ENV);
      assert.ok([400, 401].includes(resp.status), `${base} -> ${resp.status}`);
      assert.ok(!(await resp.text()).includes(TOKEN));
    }
    assert.equal(h.calls.length, 0);
  } finally { h.restore(); }
});

test("token exchange pass-through: JSON body only, returns token to caller, keeps nothing", async () => {
  const h = harness(async (url, _h, body) => {
    assert.equal(url.href, SSO);
    const p = new URLSearchParams(body);
    return p.get("client_secret") === SECRET
      ? Response.json({ access_token: TOKEN, expires_in: 7200, token_type: "Bearer" })
      : Response.json({ error: "unauthorized_request" }, { status: 401 });
  });
  try {
    const ok = await worker.fetch(req("/api/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId: "id-FAKE", clientSecret: SECRET }) }), ENV);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { access_token: TOKEN, expires_in: 7200 });
    assert.equal(ok.headers.get("Cache-Control"), "no-store");

    const bad = await worker.fetch(req("/api/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId: "id-FAKE", clientSecret: "nope-FAKE" }) }), ENV);
    assert.equal(bad.status, 401);
    assert.ok(!(await bad.text()).includes("nope-FAKE"));

    const viaQuery = await worker.fetch(req(`/api/token?client_id=id-FAKE&client_secret=${SECRET}`, { method: "POST" }), ENV);
    assert.equal(viaQuery.status, 415, "query-string credentials refused");
    assert.equal((await worker.fetch(req(`/api/token?client_secret=${SECRET}`), ENV)).status, 405);
    assert.equal(h.calls.length, 2);

    // The minted token is not retained: a following data request without headers is mock.
    const next = await worker.fetch(req("/api/sites"), ENV);
    assert.equal(next.headers.get("X-Data-Source"), "mock");
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.logs, []);
  } finally { h.restore(); }
});

test("CORS preflight allows the credential headers for the configured origin only", async () => {
  const pre = (origin) => worker.fetch(req("/api/topology", { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Headers": "authorization,x-central-base" } }), ENV);
  const ok = await pre(ORIGIN);
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.match(ok.headers.get("Access-Control-Allow-Headers"), /Authorization/);
  assert.match(ok.headers.get("Access-Control-Allow-Headers"), /X-Central-Base/);
  const other = await pre("https://evil.example.com");
  assert.equal(other.headers.get("Access-Control-Allow-Origin"), null);
});

test("config and source hold no credential, storage binding or logging", () => {
  const toml = read("../worker/wrangler.toml");
  const devVars = read("../worker/.dev.vars.example");
  for (const text of [toml, devVars]) {
    assert.doesNotMatch(text, /CENTRAL_(TOKEN|CLIENT_ID|CLIENT_SECRET)|SECRET\s*=|TOKEN\s*=/);
  }
  assert.doesNotMatch(toml, /kv_namespaces|durable_objects|r2_buckets|d1_databases|\[\[queues|hyperdrive|secrets_store/);
  const src = readdirSync(new URL("../worker/src/", import.meta.url)).filter((f) => f.endsWith(".ts"));
  for (const f of src) {
    const code = read(`../worker/src/${f}`);
    assert.doesNotMatch(code, /console\.|caches\.|KVNamespace|DurableObject|\.put\(|CENTRAL_TOKEN|CENTRAL_CLIENT/, f);
  }
  const envDecl = read("../worker/src/index.ts").match(/export interface Env \{([^}]*)\}/)[1];
  assert.doesNotMatch(envDecl, /TOKEN|SECRET|CLIENT/);
});
