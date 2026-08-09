// New Central (HPE Aruba Networking Central on GreenLake) API client.
// Authenticates with GreenLake platform tokens (same SSO endpoint) and reads
// monitoring data from a per-tenant cluster base URL, e.g.
// https://us1.api.central.arubanetworks.com
// Async port of glc/new_central.py.

export class NewCentralError extends Error {}

const SSO_URL = "https://sso.common.cloud.hpe.com/as/token.oauth2";

export class NewCentralClient {
  private baseUrl: string;
  private token: string | null = null;

  constructor(
    baseUrl: string,
    private clientId: string,
    private clientSecret: string,
    private ssoUrl: string = SSO_URL,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
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
      throw new NewCentralError(
        `New Central auth failed (HTTP ${resp.status}): ${(await resp.text()).slice(0, 300)}`,
      );
    }
    const body = (await resp.json()) as { access_token?: string };
    if (!body.access_token) {
      throw new NewCentralError("New Central auth response contained no access_token");
    }
    this.token = body.access_token;
  }

  async getAps(): Promise<any[]> {
    if (this.token === null) await this.authenticate();
    const aps: any[] = [];
    let cursor: string | null = null;
    while (true) {
      const url = new URL(this.baseUrl + "/network-monitoring/v1/aps");
      url.searchParams.set("limit", "1000");
      if (cursor) url.searchParams.set("next", cursor);
      const auth = () => ({ Authorization: `Bearer ${this.token}` });
      let resp = await fetch(url, { headers: auth() });
      if (resp.status === 401) {
        // GLP tokens are short-lived (~15 min); re-auth once mid-run
        await this.authenticate();
        resp = await fetch(url, { headers: auth() });
      }
      if (resp.status !== 200) {
        throw new NewCentralError(
          `GET /network-monitoring/v1/aps failed (HTTP ${resp.status}): ${(await resp.text()).slice(0, 300)}`,
        );
      }
      const body = (await resp.json()) as Record<string, any>;
      let page: any[] | null = null;
      for (const key of ["items", "aps", "data", "list"]) {
        if (Array.isArray(body[key])) {
          page = body[key];
          break;
        }
      }
      if (page === null) {
        throw new NewCentralError(
          "GET /network-monitoring/v1/aps: no item list in response keys " +
            Object.keys(body).sort().join(", "),
        );
      }
      aps.push(...page);
      cursor = body.next ?? null;
      if (!cursor || page.length === 0) break;
    }
    return aps;
  }
}
