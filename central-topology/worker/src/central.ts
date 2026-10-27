// Read-only New Central (MRT API) client. Every call is a GET under
// /network-monitoring/v1. Topology is the source of truth for switches,
// sites and links. Doc citations for every path: ../../docs/API-NOTES.md

export class CentralError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

export type GetJson = (path: string, params?: Record<string, string>) => Promise<any>;

export interface Site { id: string; name: string }
export interface TopoDevice {
  serial: string;              // managed serial, or "tpd_<mac>" for unmanaged devices
  name: string;
  type: string | null;         // "Switch", "Access Point", ...
  model: string | null;
  status: string | null;
  deviceFunction: string | null;
  ipv4: string | null;         // topology devices[].ipv4
  vlanIds: number[];           // topology devices[].vlans (IDs only, no addresses)
}
export interface TopoLink {
  from: string; to: string;
  fromPort: string | null; toPort: string | null;
  speedGbps: number | null;
  source: "topology" | "neighbours";
}
export interface NormVlan { id: string; name: string | null; ipv4: string | null }
export interface NormInterface { name: string; type: string | null; ipv4: string | null; kind: "oobm" | "loopback" | "other" }

const str = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s : null;
};

// The schema types devices/links as a single object; real responses are
// expected to be arrays. Accept array, single object, or keyed object.
export function asList(v: unknown): any[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("serial" in o || "from" in o) return [o];
    return Object.values(o).filter((x) => x && typeof x === "object");
  }
  return [];
}

// Interface list does not document which entries are OOBM or loopback, so
// classify by type and name. Unverified against a live tenant.
export function interfaceKind(name: string, type: string | null): NormInterface["kind"] {
  const n = name.toLowerCase();
  const t = (type ?? "").toLowerCase();
  if (t.includes("loopback") || /^(loopback|lo)\s*\d*$/.test(n)) return "loopback";
  if (t.includes("manage") || t.includes("oobm") || /^(mgmt|oobm|management)\b/.test(n)) return "oobm";
  return "other";
}

export const isSwitch = (d: TopoDevice) => (d.type ?? "").toLowerCase().includes("switch");

// limit/offset pagination used by sites-health, vlans and interfaces.
async function paged(get: GetJson, path: string, limit = 100): Promise<any[]> {
  const out: any[] = [];
  for (let offset = 0, guard = 0; guard < 100; guard++) {
    const body = await get(path, { limit: String(limit), offset: String(offset) });
    const page = asList(body?.items);
    out.push(...page);
    offset += page.length;
    if (page.length < limit || (typeof body?.total === "number" && offset >= body.total)) break;
  }
  return out;
}

export function central(get: GetJson) {
  return {
    async sites(): Promise<Site[]> {
      return (await paged(get, "/network-monitoring/v1/sites-health"))
        .filter((s) => str(s.id))
        .map((s) => ({ id: String(s.id), name: str(s.siteName) ?? String(s.id) }));
    },

    async topology(siteId: string): Promise<{ devices: TopoDevice[]; links: TopoLink[] }> {
      const body = await get(`/network-monitoring/v1/topology/${encodeURIComponent(siteId)}`);
      const devices = asList(body?.devices).map((d: any): TopoDevice => ({
        serial: str(d.serial) ?? `mac:${str(d.mac) ?? "unknown"}`,
        name: str(d.name) ?? str(d.serial) ?? "unknown",
        type: str(d.type),
        model: str(d.model),
        status: str(d.status),
        deviceFunction: str(d.deviceFunction),
        ipv4: str(d.ipv4),
        vlanIds: Array.isArray(d.vlans) ? d.vlans.map(Number).filter(Number.isFinite) : [],
      }));
      const links = asList(body?.links)
        .filter((l: any) => str(l.from) && str(l.to))
        .map((l: any): TopoLink => ({
          from: String(l.from), to: String(l.to),
          fromPort: str(asList(l.fromPortList)[0]?.name), toPort: str(asList(l.toPortList)[0]?.name),
          speedGbps: typeof l.speed === "number" ? l.speed : null,
          source: "topology",
        }));
      return { devices, links };
    },

    // Switch detail: used only to settle the home site of a switch that shows
    // up in more than one site's topology.
    async switchSite(serial: string): Promise<{ siteId: string | null; siteName: string | null }> {
      const d = await get(`/network-monitoring/v1/switches/${encodeURIComponent(serial)}`);
      return { siteId: str(d?.siteId), siteName: str(d?.siteName) };
    },

    // LLDP fill-in when topology leaves a switch cut off from the rest.
    async neighbours(serial: string): Promise<TopoLink[]> {
      const body = await get(`/network-monitoring/v1/neighbours/${encodeURIComponent(serial)}`);
      return asList(body?.neighbours)
        .filter((n: any) => str(n.serial))
        .map((n: any): TopoLink => ({
          from: serial, to: String(n.serial),
          fromPort: str(n.localPort), toPort: str(n.toPort), speedGbps: null, source: "neighbours",
        }));
    },

    async vlans(serial: string): Promise<NormVlan[]> {
      const items = await paged(get, `/network-monitoring/v1/switches/${encodeURIComponent(serial)}/vlans`);
      return items.map((v: any) => ({ id: String(v.id), name: str(v.name), ipv4: str(v.ipv4) }));
    },

    async interfaces(serial: string): Promise<NormInterface[]> {
      const items = await paged(get, `/network-monitoring/v1/switches/${encodeURIComponent(serial)}/interfaces`);
      return items.map((i: any) => {
        const name = str(i.name) ?? str(i.id) ?? "?";
        const type = str(i.type);
        return { name, type, ipv4: str(i.ipv4), kind: interfaceKind(name, type) };
      });
    },
  };
}
export type Central = ReturnType<typeof central>;

// ---------- live HTTP (stateless pass-through) ----------
// Credentials are supplied by the browser on each request and live only in
// the scope of that request. Nothing here is stored, cached or logged.

// HPE GreenLake platform OAuth2 client-credentials token endpoint.
export const SSO_URL = "https://sso.common.cloud.hpe.com/as/token.oauth2";

// Only public new Central cluster API hosts may be targeted (no open proxy).
const BASE_RE = /^https:\/\/(?!internal\.)[a-z]{2}\d\.api\.central\.arubanetworks\.com(\.cn)?$/;
export function checkBaseUrl(raw: string | null): string {
  const base = (raw ?? "").trim().replace(/\/+$/, "");
  if (!BASE_RE.test(base)) throw new CentralError("X-Central-Base must be a new Central cluster API URL, e.g. https://us1.api.central.arubanetworks.com.", 400);
  return base;
}

// Strip anything that looks like a credential from upstream error text.
export function scrub(text: string, ...secrets: (string | null | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("[redacted]");
  return out
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/("?(access_token|refresh_token|client_secret|client_id|token)"?\s*[:=]\s*"?)[^",&\s]+/gi, "$1[redacted]")
    .slice(0, 300);
}

export function liveGetter(baseUrl: string, token: string): GetJson {
  return async (path, params) => {
    const url = new URL(baseUrl + path);
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
    const resp = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
    });
    if (resp.status === 401 || resp.status === 403) throw new CentralError(`Central rejected the token (HTTP ${resp.status}). Reconnect in the credentials panel.`, 401);
    if (resp.status === 429) throw new CentralError(`Central rate limit hit on GET ${path}.`, 429);
    if (!resp.ok) throw new CentralError(`GET ${path} failed (HTTP ${resp.status}): ${scrub(await resp.text(), token)}`);
    return resp.json();
  };
}

// Token exchange pass-through, used only if the browser cannot reach the
// GreenLake token endpoint directly. The result goes straight back to the
// browser; the Worker keeps nothing.
export async function exchangeToken(clientId: string, clientSecret: string): Promise<{ access_token: string; expires_in: number | null }> {
  const resp = await fetch(SSO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
    cache: "no-store",
  });
  if (!resp.ok) throw new CentralError(`HPE token request failed (HTTP ${resp.status}). Check the client ID and secret, and that the client is a personal API client for your new Central instance.`, resp.status === 400 || resp.status === 401 ? 401 : 502);
  const body = (await resp.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new CentralError("GreenLake returned no access token.", 502);
  return { access_token: body.access_token, expires_in: typeof body.expires_in === "number" ? body.expires_in : null };
}
