// HPE GreenLake platform API client (devices + subscriptions + detach).
// Async port of glc/greenlake.py using fetch (no `requests`, no filesystem).

export class GreenLakeError extends Error {}

const SSO_URL = "https://sso.common.cloud.hpe.com/as/token.oauth2";
const API_BASE = "https://global.api.greenlake.hpe.com";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GreenLakeClient {
  private token: string | null = null;
  private apiBase: string;

  constructor(
    private clientId: string,
    private clientSecret: string,
    private ssoUrl: string = SSO_URL,
    apiBase: string = API_BASE,
  ) {
    this.apiBase = apiBase.replace(/\/+$/, "");
  }

  async authenticate(): Promise<void> {
    const resp = await fetch(this.ssoUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });
    if (resp.status !== 200) {
      throw new GreenLakeError(
        `GreenLake auth failed (HTTP ${resp.status}): ${(await resp.text()).slice(0, 300)}`,
      );
    }
    const body = (await resp.json()) as { access_token?: string };
    if (!body.access_token) {
      throw new GreenLakeError("GreenLake auth response contained no access_token");
    }
    this.token = body.access_token;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, ...extra };
  }

  private async getPaginated(
    path: string,
    itemKeys: string[] = ["items"],
    limit = 100,
  ): Promise<any[]> {
    if (this.token === null) await this.authenticate();
    const results: any[] = [];
    let offset = 0;
    while (true) {
      const url = new URL(this.apiBase + path);
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("offset", String(offset));
      let resp = await fetch(url, { headers: this.headers() });
      if (resp.status === 401) {
        // token expired mid-run; re-auth once and retry this page
        await this.authenticate();
        resp = await fetch(url, { headers: this.headers() });
      }
      if (resp.status !== 200) {
        throw new GreenLakeError(
          `GET ${path} failed (HTTP ${resp.status}): ${(await resp.text()).slice(0, 300)}`,
        );
      }
      const body = (await resp.json()) as Record<string, any>;
      let page: any[] | null = null;
      for (const key of itemKeys) {
        if (Array.isArray(body[key])) {
          page = body[key];
          break;
        }
      }
      if (page === null) {
        throw new GreenLakeError(
          `GET ${path}: could not find item list in response keys ` +
            Object.keys(body).sort().join(", "),
        );
      }
      results.push(...page);
      const total = body.total ?? body.count;
      offset += page.length;
      if (page.length < limit || (typeof total === "number" && offset >= total)) break;
    }
    return results;
  }

  getDevices(): Promise<any[]> {
    return this.getPaginated("/devices/v1/devices");
  }

  getSubscriptions(): Promise<any[]> {
    return this.getPaginated("/subscriptions/v1/subscriptions");
  }

  /**
   * Remove every subscription from one device.
   *
   * PATCH /devices/v1/devices?id=<uuid> with {"subscription": []}
   * (merge-patch). GreenLake answers 202 and processes asynchronously; we
   * poll the async-operation URI briefly for a real outcome where possible.
   *
   * Returns "SUCCEEDED" | "PENDING" or throws GreenLakeError.
   */
  async detachSubscriptions(deviceId: string, waitSeconds = 25): Promise<string> {
    if (this.token === null) await this.authenticate();
    const url = new URL(this.apiBase + "/devices/v1/devices");
    url.searchParams.set("id", deviceId);
    const patch = () =>
      fetch(url, {
        method: "PATCH",
        headers: this.headers({ "Content-Type": "application/merge-patch+json" }),
        body: JSON.stringify({ subscription: [] }),
      });

    let resp = await patch();
    if (resp.status === 401) {
      await this.authenticate();
      resp = await patch();
    }
    if (resp.status !== 200 && resp.status !== 202) {
      throw new GreenLakeError(
        `Detach failed (HTTP ${resp.status}): ${(await resp.text()).slice(0, 300)}`,
      );
    }
    if (resp.status === 200) return "SUCCEEDED";
    return this.waitForOp(resp, waitSeconds, "Detach");
  }

  /** Poll a 202 response's async-operation URI until it settles or times out. */
  private async waitForOp(resp: Response, waitSeconds: number, label: string): Promise<string> {
    const location = resp.headers.get("Location");
    if (!location) return "PENDING";
    const opUrl = location.startsWith("http") ? location : this.apiBase + location;
    const deadline = Date.now() + waitSeconds * 1000;
    while (Date.now() < deadline) {
      await sleep(2000);
      const op = await fetch(opUrl, { headers: this.headers() });
      if (op.status !== 200) return "PENDING";
      const opBody = (await op.json()) as Record<string, any>;
      const status = String(opBody.status ?? "").toUpperCase();
      if (status.includes("SUCCE")) return "SUCCEEDED";
      if (status.includes("FAIL") || status.includes("ERROR")) {
        const detail = opBody.resultMessage || opBody.message || status;
        throw new GreenLakeError(`${label} operation failed: ${detail}`);
      }
    }
    return "PENDING";
  }

  /**
   * Register subscription keys in the workspace.
   * POST /subscriptions/v1/subscriptions {"subscriptions":[{"key":…}]} — 202.
   * Returns "SUCCEEDED" | "PENDING".
   */
  async addSubscriptions(keys: string[], waitSeconds = 20): Promise<string> {
    if (this.token === null) await this.authenticate();
    const post = () =>
      fetch(this.apiBase + "/subscriptions/v1/subscriptions", {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ subscriptions: keys.map((key) => ({ key })) }),
      });
    let resp = await post();
    if (resp.status === 401) {
      await this.authenticate();
      resp = await post();
    }
    if (![200, 201, 202].includes(resp.status)) {
      throw new GreenLakeError(
        `Add subscriptions failed (HTTP ${resp.status}): ${(await resp.text()).slice(0, 300)}`,
      );
    }
    if (resp.status !== 202) return "SUCCEEDED";
    return this.waitForOp(resp, waitSeconds, "Add subscriptions");
  }

  /**
   * Register devices in the workspace.
   * POST /devices/v1/devices {"network":[{serialNumber, macAddress}]} — 202,
   * max five devices per call, so larger lists are sent in batches.
   * Returns "SUCCEEDED" | "PENDING" (PENDING if any batch is still processing).
   */
  async addDevices(
    devices: { serialNumber: string; macAddress: string }[],
    waitSeconds = 20,
  ): Promise<string> {
    if (this.token === null) await this.authenticate();
    let pending = false;
    for (let i = 0; i < devices.length; i += 5) {
      const batch = devices.slice(i, i + 5);
      const post = () =>
        fetch(this.apiBase + "/devices/v1/devices", {
          method: "POST",
          headers: this.headers({ "Content-Type": "application/json" }),
          body: JSON.stringify({ network: batch }),
        });
      let resp = await post();
      if (resp.status === 401) {
        await this.authenticate();
        resp = await post();
      }
      if (![200, 201, 202].includes(resp.status)) {
        throw new GreenLakeError(
          `Add devices failed on batch ${i / 5 + 1} (HTTP ${resp.status}): ` +
            (await resp.text()).slice(0, 300),
        );
      }
      if (resp.status === 202) {
        const status = await this.waitForOp(resp, waitSeconds, "Add devices");
        if (status === "PENDING") pending = true;
      }
    }
    return pending ? "PENDING" : "SUCCEEDED";
  }
}
