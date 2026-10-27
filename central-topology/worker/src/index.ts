// central-topology-api: stateless, read-only pass-through for the topology page.
// New Central (MRT API) only.
//
// Credentials never live here. The browser sends, per request:
//   Authorization: Bearer <access token>       (minted in the browser)
//   X-Central-Base: https://<cluster>.api.central.arubanetworks.com
// They are used for that request only: never stored, cached or logged, and
// every API response is Cache-Control: no-store.
//
// No credentials: MOCK="1" (default) serves synthetic fixtures; MOCK="0"
// answers 401 so a live-only deployment fails clearly.

import { CentralError, central, checkBaseUrl, exchangeToken, liveGetter, scrub, type Central } from "./central.ts";
import { mergeTenant } from "./merge.ts";
import { mockGetter } from "./mock.ts";

export interface Env {
  ASSETS?: Fetcher;
  MOCK?: string;
  ALLOWED_ORIGINS?: string;
}

const mockAllowed = (env: Env) => (env.MOCK ?? "1") !== "0";

const NO_STORE = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin");
  const allowed = (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return origin && allowed.includes(origin)
    ? {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, X-Central-Base, Content-Type",
        "Access-Control-Expose-Headers": "X-Data-Source",
        "Access-Control-Max-Age": "600",
        Vary: "Origin",
      }
    : {};
}

function json(obj: unknown, status: number, source?: "mock" | "live"): Response {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...NO_STORE };
  if (source) headers["X-Data-Source"] = source;
  return new Response(JSON.stringify(obj), { status, headers });
}

/** Per-request client. Returns null when no credentials were sent. */
function liveClient(request: Request): { c: Central; secrets: string[] } | null {
  const auth = request.headers.get("Authorization");
  const base = request.headers.get("X-Central-Base");
  if (!auth && !base) return null;
  const m = auth?.match(/^Bearer\s+(\S+)$/i);
  if (!m) throw new CentralError("Send Authorization: Bearer <token> together with X-Central-Base.", 401);
  return { c: central(liveGetter(checkBaseUrl(base), m[1])), secrets: [m[1]] };
}

async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

async function topology(c: Central, mock: boolean, include: Set<string>, secrets: string[]) {
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(scrub(m, ...secrets));
  const sites = await c.sites();
  const { switches, externals, links } = await mergeTenant(c, sites, pool, warn);
  const detailed = await pool(switches, 4, async (sw) => {
    let vlans = null, interfaces = null;
    if (include.has("vlans")) {
      try { vlans = (await c.vlans(sw.serial)).filter((v) => v.ipv4); } catch (e) { warn(`${sw.name}: VLANs unavailable (${(e as Error).message})`); }
    }
    if (include.has("interfaces")) {
      try { interfaces = (await c.interfaces(sw.serial)).filter((i) => i.ipv4 && i.kind !== "other"); } catch (e) { warn(`${sw.name}: interfaces unavailable (${(e as Error).message})`); }
    }
    return { ...sw, vlans, interfaces };
  });
  return { mock, generatedAt: new Date().toISOString(), sites, switches: detailed, externals, links, warnings };
}

async function tokenRoute(request: Request): Promise<Response> {
  const type = request.headers.get("Content-Type") ?? "";
  if (!type.includes("application/json")) throw new CentralError("Send the client ID and secret as a JSON body.", 415);
  const body = (await request.json().catch(() => null)) as { clientId?: unknown; clientSecret?: unknown } | null;
  const id = typeof body?.clientId === "string" ? body.clientId.trim() : "";
  const secret = typeof body?.clientSecret === "string" ? body.clientSecret : "";
  if (!id || !secret) throw new CentralError("clientId and clientSecret are required.", 400);
  return json(await exchangeToken(id, secret), 200, "live");
}

async function api(request: Request, env: Env, url: URL): Promise<Response> {
  const p = url.pathname;
  if (p === "/api/token") {
    if (request.method !== "POST") return json({ error: "POST only." }, 405);
    return tokenRoute(request);
  }
  if (request.method !== "GET") return json({ error: "Read-only API: GET only." }, 405);
  if (p === "/api/health") return json({ ok: true, mockAvailable: mockAllowed(env) }, 200);

  const live = liveClient(request);
  if (!live && !mockAllowed(env)) {
    throw new CentralError("No Central credentials sent. Connect in the credentials panel (Authorization + X-Central-Base headers).", 401);
  }
  const c = live?.c ?? central(mockGetter);
  const source = live ? "live" : "mock";
  const secrets = live?.secrets ?? [];
  let m: RegExpMatchArray | null;
  if (p === "/api/sites") return json({ sites: await c.sites() }, 200, source);
  if ((m = p.match(/^\/api\/sites\/([^/]+)\/topology$/))) return json(await c.topology(decodeURIComponent(m[1])), 200, source);
  if ((m = p.match(/^\/api\/switches\/([^/]+)\/(neighbors|vlans|interfaces)$/))) {
    const serial = decodeURIComponent(m[1]);
    if (m[2] === "neighbors") return json({ serial, links: await c.neighbours(serial) }, 200, source);
    if (m[2] === "vlans") return json({ serial, vlans: await c.vlans(serial) }, 200, source);
    return json({ serial, interfaces: await c.interfaces(serial) }, 200, source);
  }
  if (p === "/api/topology") {
    const raw = url.searchParams.get("include") ?? "vlans,interfaces";
    const include = new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
    return json(await topology(c, !live, include, secrets), 200, source);
  }
  return json({ error: "Not found" }, 404);
}

function secretsOf(request: Request): string[] {
  const m = request.headers.get("Authorization")?.match(/^Bearer\s+(\S+)$/i);
  return m ? [m[1]] : [];
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const cors = corsHeaders(request, env);
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, ...NO_STORE } });
      let resp: Response;
      try {
        resp = await api(request, env, url);
      } catch (e) {
        // Error text never carries the caller's token; nothing is logged.
        resp = e instanceof CentralError
          ? json({ error: scrub(e.message, ...secretsOf(request)) }, e.status)
          : json({ error: "Unexpected error." }, 500);
      }
      for (const [k, v] of Object.entries(cors)) resp.headers.set(k, v);
      return resp;
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return json({ error: "Not found" }, 404);
  },
};
