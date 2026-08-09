// Worker entry: serves the browser UI (static assets) and the /api/* routes.
// Port of app.py's Flask routing. Credentials arrive per-request from the
// browser, are used for the API calls, and are never stored server-side.

import { GreenLakeClient, GreenLakeError } from "./greenlake";
import { CentralClient, CentralError } from "./central";
import { NewCentralClient, NewCentralError } from "./newCentral";
import { correlate } from "./correlate";
import { renderReport } from "./report";

interface Env {
  ASSETS: Fetcher;
}

const SOURCE_LABELS: Record<string, string> = {
  new: "New Central (GreenLake-native)",
  classic: "Classic Aruba Central",
};

class RequestError extends Error {}

function need(value: unknown, message: string): string {
  const v = (value ?? "").toString().trim();
  if (!v) throw new RequestError(message);
  return v;
}

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function readJson(request: Request): Promise<any> {
  try {
    return (await request.json()) ?? {};
  } catch {
    return {};
  }
}

interface LiveResult {
  devices: any[];
  subs: any[];
  aps: any[];
  source: string;
  rotatedRefresh: string | null;
}

async function fetchLive(body: any): Promise<LiveResult> {
  const glCfg = body.greenlake || {};
  const glId = need(glCfg.client_id, "GreenLake Client ID is required.");
  const glSecret = need(glCfg.client_secret, "GreenLake Client Secret is required.");

  const mode = body.central_mode;
  if (!(mode in SOURCE_LABELS)) {
    throw new RequestError("Pick a Central type: New Central or Classic Central.");
  }

  const gl = new GreenLakeClient(glId, glSecret);
  const devices = await gl.getDevices();
  const subs = await gl.getSubscriptions();

  let aps: any[];
  let rotatedRefresh: string | null = null;

  if (mode === "new") {
    const nc = body.new || {};
    const base = need(
      nc.base_url,
      "New Central base URL is required (e.g. https://us1.api.central.arubanetworks.com).",
    );
    let cid = glId;
    let csec = glSecret;
    if (!(nc.use_gl_creds ?? true)) {
      cid = need(
        nc.client_id,
        "New Central API client ID is required (or tick 'use my GreenLake credentials').",
      );
      csec = need(nc.client_secret, "New Central API client secret is required.");
    }
    aps = await new NewCentralClient(base, cid, csec).getAps();
  } else {
    const cc = body.classic || {};
    const base = need(cc.base_url, "Classic Central API gateway base URL is required.");
    let client: CentralClient;
    if (cc.auth === "token") {
      client = new CentralClient(base, {
        accessToken: need(cc.access_token, "Classic Central access token is required."),
      });
    } else {
      client = new CentralClient(base, {
        clientId: need(cc.client_id, "Classic Central client ID is required."),
        clientSecret: need(cc.client_secret, "Classic Central client secret is required."),
        refreshToken: need(cc.refresh_token, "Classic Central refresh token is required."),
      });
    }
    aps = await client.getAps();
    rotatedRefresh = client.rotatedRefreshToken;
  }

  return { devices, subs, aps, source: SOURCE_LABELS[mode], rotatedRefresh };
}

async function apiReport(request: Request): Promise<Response> {
  const body = await readJson(request);

  let devices: any[];
  let subs: any[];
  let aps: any[];
  let source: string;
  let rotatedRefresh: string | null = null;

  try {
    ({ devices, subs, aps, source, rotatedRefresh } = await fetchLive(body));
  } catch (e) {
    if (e instanceof RequestError) return jsonResponse({ error: e.message }, 400);
    if (e instanceof GreenLakeError || e instanceof CentralError || e instanceof NewCentralError) {
      return jsonResponse({ error: e.message }, 502);
    }
    return jsonResponse({ error: `Unexpected error: ${(e as Error).message}` }, 500);
  }

  let expiringDays = parseInt(body.expiring_days, 10);
  if (!Number.isFinite(expiringDays)) expiringDays = 90;
  const ignored = Array.isArray(body.ignored_serials) ? body.ignored_serials : [];

  const data = correlate(devices, subs, aps, {
    expiringDays,
    centralSource: source,
    ignoredSerials: ignored,
  });

  const headers: Record<string, string> = { "Content-Type": "text/html; charset=utf-8" };
  // Classic Central rotates the refresh token on every use; hand the new one
  // back so the browser can persist it with the instance (no server storage).
  if (rotatedRefresh) headers["X-Central-Refresh-Token"] = rotatedRefresh;

  return new Response(renderReport(data), { status: 200, headers });
}

async function apiDetach(request: Request): Promise<Response> {
  const body = await readJson(request);
  const serial = (body.serial ?? "").toString().trim();

  let glId: string;
  let glSecret: string;
  let deviceId: string;
  try {
    const glCfg = body.greenlake || {};
    glId = need(glCfg.client_id, "GreenLake Client ID is required.");
    glSecret = need(glCfg.client_secret, "GreenLake Client Secret is required.");
    deviceId = need(
      body.device_id,
      "This report has no GreenLake device id for the AP — regenerate the report and try again.",
    );
  } catch (e) {
    if (e instanceof RequestError) return jsonResponse({ error: e.message }, 400);
    throw e;
  }

  try {
    const gl = new GreenLakeClient(glId, glSecret);
    const status = await gl.detachSubscriptions(deviceId);
    return jsonResponse({ ok: true, status, serial });
  } catch (e) {
    if (e instanceof GreenLakeError) return jsonResponse({ error: e.message }, 502);
    return jsonResponse({ error: `Unexpected error: ${(e as Error).message}` }, 500);
  }
}

async function apiAddInventory(request: Request): Promise<Response> {
  const body = await readJson(request);
  const keys: string[] = (Array.isArray(body.subscription_keys) ? body.subscription_keys : [])
    .map((k: unknown) => String(k ?? "").trim())
    .filter(Boolean);
  const devices = (Array.isArray(body.devices) ? body.devices : [])
    .map((d: any) => ({
      serialNumber: String(d?.serial ?? "").trim(),
      macAddress: String(d?.mac ?? "").trim(),
    }))
    .filter((d: any) => d.serialNumber && d.macAddress);

  if (!keys.length && !devices.length) {
    return jsonResponse(
      { error: "Provide at least one subscription key or one device (serial + MAC)." },
      400,
    );
  }

  let glId: string;
  let glSecret: string;
  try {
    const glCfg = body.greenlake || {};
    glId = need(glCfg.client_id, "GreenLake Client ID is required.");
    glSecret = need(glCfg.client_secret, "GreenLake Client Secret is required.");
  } catch (e) {
    if (e instanceof RequestError) return jsonResponse({ error: e.message }, 400);
    throw e;
  }

  const gl = new GreenLakeClient(glId, glSecret);
  const result: Record<string, any> = { ok: true };
  // subscriptions first so freshly added devices can pick up seats
  if (keys.length) {
    try {
      result.subscriptions = { count: keys.length, status: await gl.addSubscriptions(keys) };
    } catch (e) {
      result.ok = false;
      result.subscriptions = { count: keys.length, error: (e as Error).message };
    }
  }
  if (devices.length) {
    try {
      result.devices = { count: devices.length, status: await gl.addDevices(devices) };
    } catch (e) {
      result.ok = false;
      result.devices = { count: devices.length, error: (e as Error).message };
    }
  }
  return jsonResponse(result);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/report" && request.method === "POST") {
      return apiReport(request);
    }
    if (url.pathname === "/api/detach" && request.method === "POST") {
      return apiDetach(request);
    }
    if (url.pathname === "/api/add-inventory" && request.method === "POST") {
      return apiAddInventory(request);
    }
    if (url.pathname.startsWith("/api/")) {
      return jsonResponse({ error: "Not found" }, 404);
    }
    // everything else is the static UI
    return env.ASSETS.fetch(request);
  },
};
