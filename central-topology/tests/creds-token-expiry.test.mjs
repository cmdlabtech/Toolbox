// Bearer-token expiry: JWT `exp` is read locally, and a dead token is never sent again.
import test from "node:test";
import assert from "node:assert/strict";
import {
  SSO_URL, connectionState, fetchWithAuth, formatExpiry, normalise, readJwtExp, reuseSavedToken, tokenPlaceholder, tokenValid,
} from "../site/js/creds.js";

const BASE = "https://de1.api.central.arubanetworks.com";
const NOW = Date.UTC(2026, 0, 15, 18, 0, 0);

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const jwt = (payload) => `${b64url({ alg: "none", typ: "JWT" })}.${b64url(payload)}.sig`;

function bearer(expMs, extra = {}) {
  const exp = expMs / 1000;
  return { method: "token", baseUrl: BASE, token: jwt({ exp, sub: "user-FAKE" }), expiresAt: expMs, ...extra };
}

test("JWT exp parsing: valid, expired, non-JWT, and malformed", () => {
  const future = Math.floor(NOW / 1000) + 7200;
  const past = Math.floor(NOW / 1000) - 3600;
  const validTok = jwt({ exp: future, sub: "user-FAKE" });
  const parsed = readJwtExp(`Bearer ${validTok}`);
  assert.equal(parsed.kind, "jwt");
  assert.equal(parsed.expiresAt, future * 1000);

  const saved = normalise({ method: "token", baseUrl: BASE + "/", token: `Bearer ${validTok}` }, NOW);
  assert.equal(saved.token, validTok);
  assert.equal(saved.expiresAt, future * 1000);
  assert.equal(tokenValid(saved, NOW), true);
  assert.equal(saved.expiresAt - 60_000 > NOW, true);

  const expiredTok = jwt({ exp: past });
  assert.equal(readJwtExp(expiredTok).kind, "jwt");
  assert.throws(
    () => normalise({ method: "token", baseUrl: BASE, token: expiredTok }, NOW),
    (e) => e.message === `This bearer token expired at ${formatExpiry(past * 1000)}. Paste a new one.` && !e.message.includes(expiredTok),
  );

  const soon = Math.floor((NOW + 30_000) / 1000);
  assert.throws(
    () => normalise({ method: "token", baseUrl: BASE, token: jwt({ exp: soon }) }, NOW),
    /too soon to use/,
  );

  const opaque = normalise({ method: "token", baseUrl: BASE, token: "Bearer tok-FAKE-browser" }, NOW);
  assert.equal(readJwtExp(opaque.token).kind, "non-jwt");
  assert.equal(opaque.expiresAt, null);
  assert.equal(tokenValid(opaque, NOW), true);
  assert.equal(readJwtExp("abc.def").kind, "non-jwt");

  const malformed = ["aaaa.e30.bbbb", jwt({ exp: "7200" }), jwt(["nope"]), "aaaa.abc.bbbb"];
  for (const token of malformed) {
    assert.equal(readJwtExp(token).kind, "malformed", token);
    assert.throws(() => normalise({ method: "token", baseUrl: BASE, token }, NOW), /Could not read this bearer token/);
  }
});

test("Connect does not reuse an expired, cleared, or legacy saved token", () => {
  const past = NOW - 3_600_000;
  const future = NOW + 7_200_000;
  const expired = bearer(past);
  assert.throws(
    () => reuseSavedToken("", expired, NOW),
    (e) => e.message === `Paste a new bearer token (the saved one expired at ${formatExpiry(past)}).` && !e.message.includes(expired.token),
  );
  assert.throws(() => reuseSavedToken("   ", { ...expired, expiresAt: null }, NOW), /saved one expired at /);
  assert.equal(tokenValid({ ...expired, expiresAt: null }, NOW), false, "a remembered JWT with no stored expiry is still expired");

  const cleared = { ...bearer(future), token: null };
  assert.throws(() => reuseSavedToken("", cleared, NOW), /saved one was rejected/);
  assert.equal(reuseSavedToken("fresh-FAKE", expired, NOW), "fresh-FAKE");

  const good = bearer(future);
  assert.equal(reuseSavedToken("", good, NOW), good.token);
  assert.throws(
    () => reuseSavedToken("", { method: "token", baseUrl: BASE, token: null, expiresAt: null }, NOW),
    /Paste a new bearer token \(the saved one expired or was rejected\)/,
  );
  assert.throws(() => reuseSavedToken("", { method: "client", baseUrl: BASE, token: "tok-FAKE" }, NOW), (e) => e.message === "Paste a bearer token.");
});

test("a remembered JWT with no stored expiry is sent once and then stored with that expiry", async () => {
  const exp = NOW + 7_200_000;
  const token = jwt({ exp: exp / 1000, sub: "user-FAKE" });
  const legacy = { method: "token", baseUrl: BASE, token, expiresAt: null };
  let calls = 0;
  const out = await fetchWithAuth(legacy, {
    now: NOW,
    fetchImpl: async (url, init) => {
      calls += 1;
      assert.equal(String(url).includes(token), false);
      assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${token}`);
      return Response.json({ mock: false });
    },
  });
  assert.equal(calls, 1);
  assert.equal(out.creds.expiresAt, exp);
  assert.equal(tokenValid(legacy, NOW), true);
});

test("bearer placeholder only while a saved token is still valid", () => {
  const future = NOW + 7_200_000;
  const good = bearer(future);
  const placeholder = tokenPlaceholder(good, NOW);
  assert.equal(placeholder, `(saved, expires ${formatExpiry(future)})`);
  assert.match(placeholder, /^\(saved, expires \d{1,2}:\d{2} [AP]M\)$/);
  assert.equal(tokenPlaceholder(bearer(NOW - 1000), NOW), "");
  assert.equal(tokenPlaceholder({ ...good, token: null }, NOW), "");
  assert.equal(tokenPlaceholder({ method: "token", baseUrl: BASE, token: "tok-FAKE", expiresAt: null }, NOW), "(saved in this browser)");
  assert.equal(tokenPlaceholder({ method: "client", baseUrl: BASE, clientId: "id-FAKE", clientSecret: "sec-FAKE", token: "tok-FAKE", expiresAt: future }, NOW), "");

  const view = connectionState(good, true, NOW);
  assert.equal(view.live, true);
  assert.equal(view.text, `Live: de1 (remembered), expires ${formatExpiry(future)}`);
  assert.equal(connectionState(bearer(NOW - 1000), false, NOW).text, `de1, token expired ${formatExpiry(NOW - 1000)}`);
});

test("401 on bearer sign-in clears the token and does not call Central again", async () => {
  const good = bearer(NOW + 7_200_000);
  let fetches = 0;
  let mints = 0;
  const err = await fetchWithAuth(good, {
    now: NOW,
    fetchImpl: async (url, init) => {
      fetches += 1;
      assert.equal(String(url).includes(good.token), false);
      assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${good.token}`);
      return Response.json({ error: "Central rejected the token (HTTP 401). Reconnect in the credentials panel." }, { status: 401 });
    },
    mint: async () => { mints += 1; throw new Error("bearer sign-in must not mint"); },
  }).catch((e) => e);
  assert.equal(fetches, 1);
  assert.equal(mints, 0);
  assert.equal(err.name, "AuthError");
  assert.equal(err.reopen, true);
  assert.equal(err.creds.token, null);
  assert.equal(err.creds.expiresAt, good.expiresAt);
  assert.match(err.message, /rejected/);
  assert.match(err.message, /new one is needed/);
  assert.equal(err.message.includes(good.token), false);

  let expiredFetches = 0;
  const expired = bearer(NOW - 3_600_000);
  await assert.rejects(
    fetchWithAuth(expired, { now: NOW, fetchImpl: async () => { expiredFetches += 1; return Response.json({}); } }),
    (e) => e.reopen === true && e.message.startsWith("Paste a new bearer token (the saved one expired at "),
  );
  assert.equal(expiredFetches, 0);
});

function clientCreds(token) {
  return { method: "client", baseUrl: BASE, clientId: "id-FAKE", clientSecret: "sec-FAKE", token, expiresAt: NOW + 3_600_000 };
}

function scriptedFetch(replies, newToken) {
  let topo = 0;
  let sso = 0;
  const fetchImpl = async (url, init) => {
    if (url === SSO_URL) {
      sso += 1;
      assert.equal(String(url).includes("sec-FAKE"), false);
      assert.equal(new URLSearchParams(init.body).get("client_secret"), "sec-FAKE");
      return Response.json({ access_token: newToken, expires_in: 7200 });
    }
    const reply = replies[topo];
    topo += 1;
    assert.equal(String(url).includes("tok-FAKE"), false);
    assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${reply.token}`);
    return Response.json(reply.body, { status: reply.status });
  };
  return { fetchImpl, counts: () => ({ topo, sso }) };
}

test("401 on client sign-in mints once and retries once", async () => {
  const oldToken = "tok-FAKE-old";
  const newToken = "tok-FAKE-new";
  const creds = clientCreds(oldToken);
  const rejected = { error: "Central rejected the token (HTTP 401)." };

  const ok = scriptedFetch([
    { token: oldToken, status: 401, body: rejected },
    { token: newToken, status: 200, body: { mock: false, ok: true } },
  ], newToken);
  const out = await fetchWithAuth(creds, { fetchImpl: ok.fetchImpl, apiBase: "https://api.example", now: NOW });
  assert.deepEqual(ok.counts(), { topo: 2, sso: 1 });
  assert.equal(out.creds.token, newToken);
  assert.equal(out.body.ok, true);
  assert.equal(out.creds.expiresAt, NOW + 7200 * 1000);

  const both = scriptedFetch([
    { token: oldToken, status: 401, body: rejected },
    { token: newToken, status: 401, body: rejected },
  ], newToken);
  const err = await fetchWithAuth(creds, { fetchImpl: both.fetchImpl, apiBase: "https://api.example", now: NOW }).catch((e) => e);
  assert.deepEqual(both.counts(), { topo: 2, sso: 1 });
  assert.equal(err.reopen, false);
  assert.equal(err.creds.token, null);
  assert.match(err.message, /Central rejected the token/);
  assert.equal(err.message.includes(newToken), false);

  let topo = 0;
  let sso = 0;
  const mintFail = await fetchWithAuth(creds, {
    now: NOW,
    fetchImpl: async (url) => {
      if (url === SSO_URL) {
        sso += 1;
        return Response.json({ error: "unauthorized_request" }, { status: 401 });
      }
      topo += 1;
      return Response.json(rejected, { status: 401 });
    },
  }).catch((e) => e);
  assert.equal(topo, 1);
  assert.equal(sso, 1);
  assert.equal(mintFail.creds.token, null);
  assert.match(mintFail.message, /personal API client/);
});
