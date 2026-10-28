// Bring-your-own credentials, held only in this browser.
//
// - sessionStorage by default (cleared when the tab closes).
// - localStorage only when "Remember on this device" is ticked.
// - forget() wipes both stores and the in-memory copy.
// - Credentials are sent in request headers only, never in a URL.
//
// The client secret, if used, goes from the browser straight to the HPE
// GreenLake token endpoint (CORS-enabled). The Worker pass-through
// (/api/token) is a fallback only and keeps nothing.

export const STORE_KEY = "ct-auth";
export const SSO_URL = "https://sso.common.cloud.hpe.com/as/token.oauth2";

export const CLUSTERS = [
  ["us1", "United States"], ["us2", "United States"], ["us4", "United States"], ["us5", "United States"], ["us6", "United States"],
  ["ca1", "Canada"], ["gb1", "United Kingdom"], ["de1", "Germany"], ["de2", "Germany"], ["de3", "Germany"],
  ["in1", "India"], ["jp1", "Japan"], ["au1", "Australia"], ["ae1", "United Arab Emirates"], ["cn1", "China"],
].map(([id, where]) => ({ id, label: `${id} (${where})`, url: `https://${id}.api.central.arubanetworks.com${id === "cn1" ? ".cn" : ""}` }));

const BASE_RE = /^https:\/\/[a-z]{2}\d\.api\.central\.arubanetworks\.com(\.cn)?$/;
const EXPIRY_SKEW_MS = 60_000;
const JWT_RE = /^[A-Za-z0-9_-]+=*(?:\.[A-Za-z0-9_-]+=*){2}$/;
const TOPOLOGY_PATH = "/api/topology?include=vlans,interfaces";

function b64urlJson(segment) {
  const pad = segment.length % 4 === 0 ? "" : "=".repeat(4 - (segment.length % 4));
  const bytes = Uint8Array.from(atob(segment.replace(/-/g, "+").replace(/_/g, "/") + pad), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * Read `exp` from a JWT payload. Base64url-decodes the payload only:
 * no signature check and no network call.
 * `expiresAt` is milliseconds, matching minted tokens.
 */
export function readJwtExp(token) {
  const raw = String(token ?? "").trim().replace(/^Bearer\s+/i, "");
  if (!JWT_RE.test(raw)) return { kind: "non-jwt" };
  try {
    const payload = b64urlJson(raw.split(".")[1]);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { kind: "malformed" };
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return { kind: "malformed" };
    return { kind: "jwt", expiresAt: payload.exp * 1000 };
  } catch {
    return { kind: "malformed" };
  }
}

/** Local time, 12-hour, e.g. "3:42 PM". */
export function formatExpiry(ms) {
  const d = new Date(ms);
  let h = d.getHours();
  const ap = h >= 12 ? "PM" : "AM";
  h %= 12;
  if (h === 0) h = 12;
  return `${h}:${String(d.getMinutes()).padStart(2, "0")} ${ap}`;
}

function bearerParse(creds) {
  if (!creds?.token || creds.method !== "token") return null;
  return readJwtExp(creds.token);
}

/** Stored expiresAt, or a JWT `exp` when an older saved token has none. */
export function effectiveExpiry(creds) {
  if (!creds) return null;
  if (creds.expiresAt != null && Number.isFinite(Number(creds.expiresAt))) return Number(creds.expiresAt);
  const parsed = bearerParse(creds);
  if (!parsed) return null;
  switch (parsed.kind) {
    case "jwt": return parsed.expiresAt;
    case "non-jwt":
    case "malformed": return null;
    default: {
      const unexpected = parsed.kind;
      throw new Error(`Unexpected token kind: ${String(unexpected)}`);
    }
  }
}

function stillGood(expiresAt, now) {
  return expiresAt - EXPIRY_SKEW_MS > now;
}

/** Validate and normalise what the user typed. Throws on bad input. */
export function normalise(input, now = Date.now()) {
  const baseUrl = String(input.baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!BASE_RE.test(baseUrl)) throw new Error("Choose a new Central cluster API URL.");
  if (input.method === "token") {
    const token = String(input.token ?? "").trim().replace(/^Bearer\s+/i, "");
    if (!token) throw new Error("Paste a bearer token.");
    const parsed = readJwtExp(token);
    switch (parsed.kind) {
      case "non-jwt":
        return { method: "token", baseUrl, token, expiresAt: null };
      case "malformed":
        throw new Error("Could not read this bearer token. Paste a new one.");
      case "jwt":
        if (!stillGood(parsed.expiresAt, now)) {
          const when = formatExpiry(parsed.expiresAt);
          if (parsed.expiresAt <= now) throw new Error(`This bearer token expired at ${when}. Paste a new one.`);
          throw new Error(`This bearer token expires at ${when}, which is too soon to use. Paste a new one.`);
        }
        return { method: "token", baseUrl, token, expiresAt: parsed.expiresAt };
      default: {
        const unexpected = parsed.kind;
        throw new Error(`Unexpected token kind: ${String(unexpected)}`);
      }
    }
  }
  const clientId = String(input.clientId ?? "").trim();
  const clientSecret = String(input.clientSecret ?? "");
  if (!clientId || !clientSecret) throw new Error("Enter the client ID and secret of a new Central personal API client.");
  return { method: "client", baseUrl, clientId, clientSecret, token: null, expiresAt: null };
}

/** Storage-backed holder. `stores` = { session, local } (Web Storage API). */
export function createVault(stores) {
  let mem = null;
  const read = (s) => { try { return JSON.parse(s.getItem(STORE_KEY)); } catch { return null; } };
  const vault = {
    load() {
      mem = read(stores.session) ?? read(stores.local);
      return mem;
    },
    get: () => mem,
    remembered: () => stores.local.getItem(STORE_KEY) !== null,
    save(creds, remember = vault.remembered()) {
      mem = creds;
      const [keep, drop] = remember ? [stores.local, stores.session] : [stores.session, stores.local];
      drop.removeItem(STORE_KEY);
      keep.setItem(STORE_KEY, JSON.stringify(creds));
    },
    forget() {
      mem = null;
      stores.session.removeItem(STORE_KEY);
      stores.local.removeItem(STORE_KEY);
    },
  };
  return vault;
}

/**
 * The client-credential sign-in uses the new Central token endpoint, which
 * accepts only personal API clients scoped to a Central instance. Clients
 * scoped to the HPE GreenLake platform (GLP) use a separate, workspace-specific
 * token endpoint; their tokens work here through Bearer token sign-in.
 */
export const CLIENT_REJECTED = "HPE rejected the client ID or secret. Use a personal API client created for your new Central instance (HPE GreenLake: Manage Workspace > Personal API clients). For a GreenLake platform (GLP) API client, request a token yourself and use Bearer token sign-in";

export function tokenValid(c, now = Date.now()) {
  if (!c?.token) return false;
  const parsed = bearerParse(c);
  if (parsed?.kind === "malformed" && c.expiresAt == null) return false;
  const exp = effectiveExpiry(c);
  return exp == null || stillGood(exp, now);
}

/** Placeholder for the bearer field. Empty unless a saved token is still usable. */
export function tokenPlaceholder(creds, now = Date.now()) {
  if (creds?.method !== "token" || !tokenValid(creds, now)) return "";
  const exp = effectiveExpiry(creds);
  if (exp == null) return "(saved in this browser)";
  return `(saved, expires ${formatExpiry(exp)})`;
}

/**
 * Token to send from Connect. A non-empty field wins. An empty field reuses
 * a saved token only while it is still valid.
 */
export function reuseSavedToken(typed, prev, now = Date.now()) {
  const pasted = String(typed ?? "").trim();
  if (pasted) return pasted;
  if (prev?.method === "token" && tokenValid(prev, now)) return prev.token;
  if (prev?.method === "token") throw new Error(missingBearerMessage(prev, now));
  throw new Error("Paste a bearer token.");
}

export function missingBearerMessage(prev, now = Date.now()) {
  const exp = effectiveExpiry(prev);
  if (exp != null && exp <= now) return `Paste a new bearer token (the saved one expired at ${formatExpiry(exp)}).`;
  if (exp != null && !prev?.token) return `Paste a new bearer token (the saved one was rejected; it was valid until ${formatExpiry(exp)}).`;
  if (exp != null) return `Paste a new bearer token (the saved one expires at ${formatExpiry(exp)}).`;
  return "Paste a new bearer token (the saved one expired or was rejected).";
}

/** Drop the token and keep the expiry so the panel can say when it ended. */
export function clearToken(creds) {
  if (!creds) return creds;
  return { ...creds, token: null, expiresAt: effectiveExpiry(creds) };
}

export function rejectedTokenMessage(creds, now = Date.now()) {
  const exp = effectiveExpiry(creds);
  if (exp != null && exp <= now) return `The bearer token expired at ${formatExpiry(exp)} or was rejected. A new one is needed.`;
  if (exp != null) return `The bearer token was rejected (it was valid until ${formatExpiry(exp)}). A new one is needed.`;
  return "The bearer token expired or was rejected. A new one is needed.";
}

export function connectionState(creds, remembered = false, now = Date.now()) {
  if (!creds?.baseUrl) return { text: "Not connected (mock)", live: false };
  const cluster = new URL(creds.baseUrl).hostname.split(".")[0];
  const tail = remembered ? " (remembered)" : "";
  const exp = effectiveExpiry(creds);
  const when = exp != null ? formatExpiry(exp) : "";
  if (tokenValid(creds, now)) return { text: when ? `Live: ${cluster}${tail}, expires ${when}` : `Live: ${cluster}${tail}`, live: true };
  if (exp != null && exp <= now) return { text: `${cluster}${tail}, token expired ${when}`, live: false };
  if (creds.token && exp != null) return { text: `${cluster}${tail}, token expires ${when}`, live: false };
  if (!creds.token && exp != null) return { text: `${cluster}${tail}, token rejected (valid until ${when})`, live: false };
  if (creds.method === "client" && creds.clientId && creds.clientSecret) return { text: `Live: ${cluster}${tail}`, live: true };
  return { text: "Not connected (mock)", live: false };
}

export class AuthError extends Error {
  constructor(message, { reopen = false, creds = null } = {}) {
    super(message);
    this.name = "AuthError";
    this.reopen = reopen;
    this.creds = creds;
  }
}

/**
 * Exchange client credentials for an access token. Tries the GreenLake token
 * endpoint directly; only a network/CORS failure falls back to the Worker.
 */
export async function mintToken(creds, { fetchImpl = fetch, apiBase = "", now = Date.now() } = {}) {
  let resp;
  try {
    resp = await fetchImpl(SSO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: creds.clientId, client_secret: creds.clientSecret }).toString(),
      cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
    });
  } catch {
    resp = await fetchImpl(`${apiBase}/api/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: creds.clientId, clientSecret: creds.clientSecret }),
      cache: "no-store", credentials: "omit",
    });
  }
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok || !body.access_token) {
    const reason = body.error_description || body.error || `HTTP ${resp.status}`;
    if (resp.status === 400 || resp.status === 401) throw new Error(`${CLIENT_REJECTED} (${reason})`);
    throw new Error(`Token request failed (${reason}).`);
  }
  const ttl = Number(body.expires_in) || 7200;
  return { ...creds, token: body.access_token, expiresAt: now + ttl * 1000 };
}

/** Build an API request. Credentials go in headers; the URL never carries them. */
export function apiRequest(apiBase, path, creds) {
  const headers = { Accept: "application/json" };
  if (creds?.token) {
    headers.Authorization = `Bearer ${creds.token}`;
    headers["X-Central-Base"] = creds.baseUrl;
  }
  return { url: `${apiBase}${path}`, init: { method: "GET", headers, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" } };
}

async function readJson(resp) {
  return await resp.json().catch(() => ({}));
}

/**
 * Load topology with the browser-held credentials.
 * A bearer 401 clears the token and asks for a new one.
 * A client-credential 401 mints one new token and retries the request once.
 */
export async function fetchWithAuth(creds, { fetchImpl = fetch, apiBase = "", mint = mintToken, path = TOPOLOGY_PATH, now = Date.now() } = {}) {
  let current = creds ?? null;
  if (current && !tokenValid(current, now)) {
    if (current.method !== "client") {
      throw new AuthError(missingBearerMessage(current, now), { reopen: current.method === "token", creds: clearToken(current) });
    }
    current = await mint(current, { fetchImpl, apiBase, now });
  }

  let mintedRetry = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { url, init } = apiRequest(apiBase, path, current);
    const resp = await fetchImpl(url, init);
    const body = await readJson(resp);
    const rejected = resp.status === 401 && current;
    if (rejected && current.method === "client" && !mintedRetry) {
      mintedRetry = true;
      try {
        current = await mint({ ...current, token: null, expiresAt: null }, { fetchImpl, apiBase, now });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        throw new AuthError(message, { reopen: false, creds: clearToken(current) });
      }
      continue;
    }
    if (rejected) {
      const cleared = clearToken(current);
      if (current.method === "token") throw new AuthError(rejectedTokenMessage(current, now), { reopen: true, creds: cleared });
      throw new AuthError(body.error ?? "Central rejected the token (HTTP 401).", { reopen: false, creds: cleared });
    }
    if (!resp.ok) throw new Error(body.error ?? `HTTP ${resp.status}`);
    if (current?.method === "token" && current.expiresAt == null) {
      const exp = effectiveExpiry(current);
      if (exp != null) current = { ...current, expiresAt: exp };
    }
    return { creds: current, body };
  }
  throw new AuthError("Central rejected the token (HTTP 401).", { reopen: false, creds: clearToken(current) });
}
