// Browser-side credential handling (site/js/creds.js) with in-memory Web Storage.
import test from "node:test";
import assert from "node:assert/strict";
import { CLIENT_REJECTED, SSO_URL, STORE_KEY, apiRequest, createVault, mintToken, normalise, tokenValid } from "../site/js/creds.js";

class Mem { constructor() { this.m = new Map(); } getItem(k) { return this.m.has(k) ? this.m.get(k) : null; } setItem(k, v) { this.m.set(k, String(v)); } removeItem(k) { this.m.delete(k); } }
const BASE = "https://de1.api.central.arubanetworks.com";
const TOKEN = "tok-FAKE-browser";

test("sessionStorage by default; remember moves to localStorage; forget clears both", () => {
  const stores = { session: new Mem(), local: new Mem() };
  const v = createVault(stores);
  const c = normalise({ method: "token", baseUrl: BASE + "/", token: `Bearer ${TOKEN}` });
  assert.equal(c.token, TOKEN);
  v.save(c);
  assert.ok(stores.session.getItem(STORE_KEY));
  assert.equal(stores.local.getItem(STORE_KEY), null);
  v.save(c, true);
  assert.equal(stores.session.getItem(STORE_KEY), null);
  assert.ok(stores.local.getItem(STORE_KEY));
  assert.equal(createVault(stores).load().token, TOKEN, "remembered across a new tab");
  v.save(c, false);
  assert.equal(stores.local.getItem(STORE_KEY), null);
  v.save(c, true);
  stores.session.setItem(STORE_KEY, "{}");
  v.forget();
  assert.equal(stores.session.getItem(STORE_KEY), null);
  assert.equal(stores.local.getItem(STORE_KEY), null);
  assert.equal(v.get(), null);
  assert.equal(createVault(stores).load(), null);
});

test("API requests carry credentials in headers only, never the URL", () => {
  const c = { method: "token", baseUrl: BASE, token: TOKEN, expiresAt: null };
  const { url, init } = apiRequest("", "/api/topology?include=vlans,interfaces", c);
  assert.ok(!url.includes(TOKEN) && !url.includes("arubanetworks"));
  assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(init.headers["X-Central-Base"], BASE);
  assert.equal(init.cache, "no-store");
  const mock = apiRequest("", "/api/topology", null);
  assert.equal(mock.init.headers.Authorization, undefined, "no credentials -> mock request");
});

test("input validation: cluster allowlist and required fields", () => {
  assert.throws(() => normalise({ method: "token", baseUrl: "https://evil.example.com", token: "x" }));
  assert.throws(() => normalise({ method: "client", baseUrl: BASE, clientId: "a" }));
  assert.throws(() => normalise({ method: "token", baseUrl: BASE, token: " " }));
  assert.equal(normalise({ method: "client", baseUrl: BASE, clientId: " id ", clientSecret: "s" }).clientId, "id");
});

test("token mint: direct to GreenLake first, Worker pass-through only on network/CORS failure", async () => {
  const creds = normalise({ method: "client", baseUrl: BASE, clientId: "id-FAKE", clientSecret: "sec-FAKE" });
  const seen = [];
  const direct = async (url, init) => { seen.push(url); return Response.json({ access_token: TOKEN, expires_in: 7200 }); };
  const out = await mintToken(creds, { fetchImpl: direct, now: 1000 });
  assert.deepEqual(seen, [SSO_URL]);
  assert.equal(out.token, TOKEN);
  assert.equal(out.expiresAt, 1000 + 7200 * 1000);
  assert.ok(tokenValid(out, 2000));
  assert.ok(!tokenValid(out, out.expiresAt));

  seen.length = 0;
  const corsBlocked = async (url, init) => {
    seen.push(url);
    if (url === SSO_URL) throw new TypeError("Failed to fetch");
    assert.ok(!url.includes("sec-FAKE"));
    assert.equal(JSON.parse(init.body).clientSecret, "sec-FAKE");
    return Response.json({ access_token: TOKEN, expires_in: 60 });
  };
  const fb = await mintToken(creds, { fetchImpl: corsBlocked, apiBase: "https://api.example" });
  assert.deepEqual(seen, [SSO_URL, "https://api.example/api/token"]);
  assert.equal(fb.token, TOKEN);

  await assert.rejects(mintToken(creds, { fetchImpl: async () => Response.json({ error: "unauthorized_request" }, { status: 401 }) }), /unauthorized_request/);
});

test("token mint: documented request shape and clear credential-type errors", async () => {
  const creds = normalise({ method: "client", baseUrl: BASE, clientId: "id-FAKE", clientSecret: "sec-FAKE" });
  let seen;
  await mintToken(creds, { fetchImpl: async (url, init) => { seen = { url, init }; return Response.json({ access_token: TOKEN, expires_in: 7199 }); } });
  assert.equal(seen.url, "https://sso.common.cloud.hpe.com/as/token.oauth2");
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(seen.init.headers.Authorization, undefined, "credentials go in the form body, not HTTP Basic");
  const form = new URLSearchParams(seen.init.body);
  assert.deepEqual([...form.keys()].sort(), ["client_id", "client_secret", "grant_type"]);
  assert.equal(form.get("grant_type"), "client_credentials");

  for (const status of [400, 401]) {
    await assert.rejects(
      mintToken(creds, { fetchImpl: async () => Response.json({ error: "unauthorized_request" }, { status }) }),
      (e) => e.message.startsWith(CLIENT_REJECTED) && /personal API client/.test(e.message) && /Bearer token/.test(e.message));
  }
  await assert.rejects(mintToken(creds, { fetchImpl: async () => new Response("down", { status: 503 }) }), /Token request failed \(HTTP 503\)/);
  assert.throws(() => normalise({ method: "client", baseUrl: BASE, clientId: "a" }), /personal API client/);
});
