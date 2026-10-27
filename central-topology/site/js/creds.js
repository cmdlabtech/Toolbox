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

/** Validate and normalise what the user typed. Throws on bad input. */
export function normalise(input) {
  const baseUrl = String(input.baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!BASE_RE.test(baseUrl)) throw new Error("Choose a new Central cluster API URL.");
  if (input.method === "token") {
    const token = String(input.token ?? "").trim().replace(/^Bearer\s+/i, "");
    if (!token) throw new Error("Paste a bearer token.");
    return { method: "token", baseUrl, token, expiresAt: null };
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

export const tokenValid = (c, now = Date.now()) => !!c?.token && (c.expiresAt == null || c.expiresAt - EXPIRY_SKEW_MS > now);

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
