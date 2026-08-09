// Classic Aruba Central API client for AP monitoring.
// Async port of glc/central.py. No filesystem: when Central rotates the
// refresh token, we expose it via `rotatedRefreshToken` so the caller can
// return it to the browser to persist with the instance.

export class CentralError extends Error {}

export interface CentralOpts {
  accessToken?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
}

export class CentralClient {
  private baseUrl: string;
  private accessToken: string | null;
  private clientId: string | null;
  private clientSecret: string | null;
  private refreshToken: string | null;
  rotatedRefreshToken: string | null = null;

  constructor(baseUrl: string, opts: CentralOpts) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.accessToken = opts.accessToken || null;
    this.clientId = opts.clientId || null;
    this.clientSecret = opts.clientSecret || null;
    this.refreshToken = opts.refreshToken || null;
  }

  async authenticate(): Promise<void> {
    if (this.accessToken) return; // token supplied directly; use as-is
    if (!this.clientId || !this.clientSecret) {
      throw new CentralError("Central auth: no access_token and no OAuth client credentials");
    }
    if (!this.refreshToken) {
      throw new CentralError("Central auth: no refresh token available");
    }
    const url = new URL(this.baseUrl + "/oauth2/token");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("client_secret", this.clientSecret);
    url.searchParams.set("grant_type", "refresh_token");
    url.searchParams.set("refresh_token", this.refreshToken);
    const resp = await fetch(url, { method: "POST" });
    if (resp.status !== 200) {
      throw new CentralError(
        `Central token refresh failed (HTTP ${resp.status}): ${(await resp.text()).slice(0, 300)}\n` +
          "If the refresh token was used elsewhere it has rotated; generate a new one " +
          "in the Central API Gateway UI.",
      );
    }
    const body = (await resp.json()) as { access_token?: string; refresh_token?: string };
    if (!body.access_token) {
      throw new CentralError("Central token response contained no access_token");
    }
    this.accessToken = body.access_token;
    if (body.refresh_token) this.rotatedRefreshToken = body.refresh_token;
  }

  async getAps(): Promise<any[]> {
    await this.authenticate();
    const aps: any[] = [];
    let offset = 0;
    const limit = 1000;
    while (true) {
      const url = new URL(this.baseUrl + "/monitoring/v2/aps");
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("calculate_total", "true");
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
      if (resp.status !== 200) {
        throw new CentralError(
          `GET /monitoring/v2/aps failed (HTTP ${resp.status}): ${(await resp.text()).slice(0, 300)}`,
        );
      }
      const body = (await resp.json()) as { aps?: any[]; total?: number };
      const page = body.aps ?? [];
      aps.push(...page);
      const total = body.total;
      offset += page.length;
      if (page.length < limit || (typeof total === "number" && offset >= total)) break;
    }
    return aps;
  }
}
