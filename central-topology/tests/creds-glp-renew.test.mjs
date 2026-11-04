// GreenLake platform (GLP) clients, early renewal and the countdown (site/js/creds.js).
import test from "node:test";
import assert from "node:assert/strict";
import {
  BEARER_HINT, CLIENT_REJECTED, SECRET_REVOKED, SSO_URL, WORKSPACE_REJECTED, WORKSPACE_UNKNOWN,
  connectionState, fetchWithAuth, formatCountdown, glpTokenUrl, mintToken, normalise, renewAt, renewDue, tokenScopes,
} from "../site/js/creds.js";

const BASE = "https://us1.api.central.arubanetworks.com";
const WS = "0123456789abcdef0123456789abcdef";
const GLP = glpTokenUrl(WS);
const NOW = Date.UTC(2026, 10, 4, 18, 0, 0);
const client = (extra = {}) => normalise({ method: "client", baseUrl: BASE, clientId: "id-FAKE", clientSecret: "sec-FAKE", ...extra });

/** fetch stub: url -> reply; records urls and asserts the secret never rides in a URL. */
function hpe(replies) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(url);
    assert.equal(String(url).includes("sec-FAKE"), false);
    const r = replies[url];
    if (r instanceof Error) throw r;
    if (!r) throw new Error(`unexpected ${url}`);
    return Response.json(r.body, { status: r.status });
  };
  return { fetchImpl, seen };
}
const ok = (ttl, token = "tok-FAKE") => ({ status: 200, body: { access_token: token, token_type: "Bearer", expires_in: ttl } });
const no = (status = 401, error = "unauthorized_request") => ({ status, body: { error } });

test("Workspace ID: optional, trimmed, and checked before anything is sent", () => {
  assert.equal(client().workspaceId, null);
  assert.equal(client({ workspaceId: `  ${WS} ` }).workspaceId, WS);
  for (const bad of ["abc", "../../evil", "a/b/c/d/e/f/g/h", "x".repeat(65), "ws?id=1&x=2"]) {
    assert.throws(() => client({ workspaceId: bad }), /Workspace ID does not look right/, bad);
  }
  assert.equal(glpTokenUrl(WS), `https://global.api.greenlake.hpe.com/authorization/v2/oauth2/${WS}/token`);
});

test("clear messages for missing client fields", () => {
  assert.throws(() => normalise({ method: "client", baseUrl: BASE }), /client ID and secret of your HPE GreenLake personal API client/);
  assert.throws(() => normalise({ method: "client", baseUrl: BASE, clientSecret: "s" }), /Enter the client ID/);
  assert.throws(() => normalise({ method: "client", baseUrl: BASE, clientId: "a", clientSecret: "  " }), /Enter the client secret.*only once/);
});

test("auto-detect: with a Workspace ID try GLP first, then Central; remember which worked", async () => {
  assert.deepEqual(tokenScopes(client()), ["central"]);
  assert.deepEqual(tokenScopes(client({ workspaceId: WS })), ["glp", "central"]);

  const glp = hpe({ [GLP]: ok(899, "tok-FAKE-glp") });
  const a = await mintToken(client({ workspaceId: WS }), { fetchImpl: glp.fetchImpl, now: NOW });
  assert.deepEqual(glp.seen, [GLP]);
  assert.equal(a.scope, "glp");
  assert.equal(a.issuedAt, NOW);
  assert.equal(a.expiresAt, NOW + 899_000);
  assert.deepEqual(tokenScopes(a), ["glp"], "renewals go straight to the endpoint that worked");

  // A Central client with a Workspace ID typed in anyway still works.
  const central = hpe({ [GLP]: no(401), [SSO_URL]: ok(7199) });
  const b = await mintToken(client({ workspaceId: WS }), { fetchImpl: central.fetchImpl, now: NOW });
  assert.deepEqual(central.seen, [GLP, SSO_URL]);
  assert.equal(b.scope, "central");
  assert.equal(b.expiresAt, NOW + 7199_000);
});

test("rejections name the next step", async () => {
  const both401 = hpe({ [GLP]: no(401), [SSO_URL]: no(401) });
  await assert.rejects(mintToken(client({ workspaceId: WS }), { fetchImpl: both401.fetchImpl }), (e) => e.message === WORKSPACE_REJECTED);
  const unknownWs = hpe({ [GLP]: no(404, "invalid_request"), [SSO_URL]: no(401) });
  await assert.rejects(mintToken(client({ workspaceId: WS }), { fetchImpl: unknownWs.fetchImpl }), (e) => e.message === WORKSPACE_UNKNOWN);
  const noWs = hpe({ [SSO_URL]: no(401) });
  await assert.rejects(mintToken(client(), { fetchImpl: noWs.fetchImpl }), (e) => e.message === CLIENT_REJECTED);
  // A client that minted before and is now refused: the secret was reset or deleted.
  const revoked = hpe({ [GLP]: no(401) });
  await assert.rejects(mintToken({ ...client({ workspaceId: WS }), scope: "glp" }, { fetchImpl: revoked.fetchImpl }), (e) => e.message === SECRET_REVOKED);
  assert.deepEqual(revoked.seen, [GLP]);
  for (const m of [CLIENT_REJECTED, WORKSPACE_REJECTED, WORKSPACE_UNKNOWN, SECRET_REVOKED]) assert.equal(m.includes("sec-FAKE"), false);
});

test("GLP Worker fallback sends the Workspace ID in the JSON body only on a CORS failure", async () => {
  const seen = [];
  const out = await mintToken(client({ workspaceId: WS }), {
    apiBase: "https://api.example", now: NOW,
    fetchImpl: async (url, init) => {
      seen.push(url);
      if (url === GLP) throw new TypeError("Failed to fetch");
      assert.equal(url, "https://api.example/api/token");
      assert.deepEqual(JSON.parse(init.body), { clientId: "id-FAKE", clientSecret: "sec-FAKE", workspaceId: WS });
      return Response.json({ access_token: "tok-FAKE", expires_in: 899 });
    },
  });
  assert.deepEqual(seen, [GLP, "https://api.example/api/token"]);
  assert.equal(out.scope, "glp");
});

test("renewal is due at 80% of the token lifetime", () => {
  const glp = { ...client({ workspaceId: WS }), scope: "glp", token: "tok-FAKE", issuedAt: NOW, expiresAt: NOW + 900_000 };
  assert.equal(renewAt(glp), NOW + 720_000);
  assert.equal(renewDue(glp, NOW + 719_999), false);
  assert.equal(renewDue(glp, NOW + 720_000), true);
  const central = { ...client(), scope: "central", token: "tok-FAKE", issuedAt: NOW, expiresAt: NOW + 7_200_000 };
  assert.equal(renewAt(central), NOW + 5_760_000);
  // Saved before issuedAt existed: count back from the default lifetime.
  assert.equal(renewAt({ ...central, issuedAt: undefined }), NOW + 5_760_000);
  assert.equal(renewAt({ method: "token", baseUrl: BASE, token: "tok-FAKE", expiresAt: NOW + 900_000 }), null, "bearer cannot renew");
  assert.equal(renewAt({ ...client(), token: null }), null);
});

test("status line counts down to the renewal, and bearer mode shows expiry plus a hint", () => {
  const glp = { ...client({ workspaceId: WS }), scope: "glp", token: "tok-FAKE", issuedAt: NOW, expiresAt: NOW + 900_000 };
  assert.deepEqual(connectionState(glp, false, NOW), { text: "Live: us1, token renews in 12 min", live: true });
  assert.equal(connectionState(glp, true, NOW + 690_000).text, "Live: us1 (remembered), token renews in under a minute");
  assert.equal(connectionState(glp, false, NOW + 750_000).text, "Live: us1, renewing token…");
  const central = { ...glp, scope: "central", expiresAt: NOW + 7_200_000 };
  assert.equal(connectionState(central, false, NOW).text, "Live: us1, token renews in 1 h 36 min");
  assert.equal(formatCountdown(59_999), "under a minute");
  assert.equal(formatCountdown(3_600_000), "1 h 0 min");
  assert.match(BEARER_HINT, /Client ID \+ secret/);
});

test("fetchWithAuth renews a still-valid token once it is due, and keeps it if HPE is down", async () => {
  const due = { ...client({ workspaceId: WS }), scope: "glp", token: "tok-FAKE-old", issuedAt: NOW - 800_000, expiresAt: NOW + 100_000 };
  const sent = [];
  const fetchImpl = async (url, init) => {
    if (url === GLP) return Response.json({ access_token: "tok-FAKE-new", expires_in: 899 });
    sent.push(new Headers(init.headers).get("Authorization"));
    return Response.json({ mock: false });
  };
  const out = await fetchWithAuth(due, { fetchImpl, apiBase: "https://api.example", now: NOW });
  assert.deepEqual(sent, ["Bearer tok-FAKE-new"]);
  assert.equal(out.creds.issuedAt, NOW);

  const sent2 = [];
  const down = async (url, init) => {
    if (url === GLP) return new Response("down", { status: 503 });
    sent2.push(new Headers(init.headers).get("Authorization"));
    return Response.json({ mock: false });
  };
  const kept = await fetchWithAuth(due, { fetchImpl: down, apiBase: "https://api.example", now: NOW });
  assert.deepEqual(sent2, ["Bearer tok-FAKE-old"]);
  assert.equal(kept.creds.token, "tok-FAKE-old");
});
