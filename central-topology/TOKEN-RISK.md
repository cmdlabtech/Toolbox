# Credential model: bring your own, held in the browser

**Decision (2026-10-27):** authentication stays in the user's browser or device. Credentials are never saved on the backend.

The page (Cloudflare Pages) and the Worker can therefore be public without exposing a tenant. Every live view uses the viewer's own new Central credentials. A viewer who has none sees mock data or gets a 401, never another tenant's data.

## How credentials flow

1. **Entry.** The Credentials panel takes a new Central cluster plus either:
   - the client ID and secret of an HPE GreenLake personal API client (OAuth2 client credentials), plus an optional Workspace ID for GreenLake platform (GLP) clients, or
   - a bearer token.
2. **Storage, browser only.**
   - `sessionStorage` (key `ct-auth`) by default. It clears when the tab closes.
   - **Remember on this device** moves the entry to `localStorage` and removes it from `sessionStorage`.
   - **Forget** removes it from both, plus the in-memory copy, and the page returns to mock data.
3. **Token.** The browser POSTs the client ID and secret straight to HPE (see `docs/API-NOTES.md`):
   - no Workspace ID: `https://sso.common.cloud.hpe.com/as/token.oauth2`
   - with a Workspace ID: `https://global.api.greenlake.hpe.com/authorization/v2/oauth2/<workspace-id>/token` first, then the SSO endpoint. The one that works is remembered.

   It keeps the token, the time it was issued and its expiry. While the tab is visible it mints a new token at 80% of the lifetime, and the status line counts down to that point. A hidden tab does not renew; the next data request renews first instead. If Central rejects a token, the browser mints one new token and retries the data request once.
   - If the direct call fails at the network or CORS level, the browser falls back to `POST /api/token` on the Worker.
   - The fallback takes a JSON body only, relays it once, and returns the token to the browser with `Cache-Control: no-store`. It builds only the two token URLs above, and a Workspace ID that fails `^[A-Za-z0-9-]{8,64}$` gets 400 before any outbound call.
4. **Data.** The new Central API does not allow CORS, so the browser calls the Worker with:
   - `Authorization: Bearer <token>`
   - `X-Central-Base: https://<cluster>.api.central.arubanetworks.com`

   The Worker uses them for that one request: read-only `GET /network-monitoring/v1/...` calls to that cluster only.
5. **URLs.** Credentials never appear in a URL. Query-string credentials are ignored by the data routes and refused by `/api/token`.

## Server-side guarantees (enforced by tests)

`tests/byo-credentials.test.mjs` checks each of these:

- **Config:** no credential settings in `wrangler.toml`, `.dev.vars.example`, or the Worker `Env`.
- **No storage:** no KV, Durable Object, R2, D1, Queue or secrets-store binding, and no Cache API use.
- **No retention:** a request with credentials followed by one without returns mock data or 401. No upstream call reuses the earlier token, and no global state is added.
- **No logging:** the Worker writes nothing to the console, including on errors.
- **Scrubbing:** upstream error text has the caller's token, bearer strings and token fields redacted before it reaches the response or warnings.
- **No caching:** every `/api/*` response sets `Cache-Control: no-store`, `Pragma: no-cache` and `Referrer-Policy: no-referrer`.
- **No open proxy:** `X-Central-Base` must be `https://<cluster>.api.central.arubanetworks.com` (or `.com.cn`). Anything else gets 400 before any outbound call.
- **No credentials:** mock data with `MOCK=1` (the default), or a clear 401 with `MOCK=0`.
- **CORS:** the credential headers are allowed only for origins in `ALLOWED_ORIGINS`.
- **Token URL allowlist:** `/api/token` calls only the SSO URL or the GLP URL for a well-formed Workspace ID. A bad Workspace ID gets 400 with no outbound call, and nothing is logged.
- **CSP:** `site/_headers` sets `script-src 'self'`, `object-src 'none'` and `frame-ancestors 'none'`, and `connect-src` lists every host the page calls (the HPE token hosts plus each `config.js` Worker URL). The page has no inline scripts.

`tests/creds-client.test.mjs` and `tests/creds-token-expiry.test.mjs` check the browser side:
- sessionStorage is the default
- remember moves the entry to localStorage
- Forget clears both stores
- credentials go in headers only, never in a URL
- the cluster URL is checked against the allowlist
- the token is minted directly first, with the Worker fallback used only on a network failure
- a pasted JWT stores its `exp` claim; a non-JWT does not; a malformed token is refused
- Connect does not reuse an expired or cleared bearer token
- the bearer placeholder is shown only while the saved token is still valid
- a bearer 401 clears the token and asks for a new one; a client 401 mints once and retries once

`tests/creds-glp-renew.test.mjs` checks:
- the Workspace ID is optional, trimmed, and checked before anything is sent
- with a Workspace ID, GLP is tried first, then Central, and the working endpoint is remembered
- the GLP Worker fallback sends the Workspace ID in the JSON body only
- rejection messages say what to fix (secret, Workspace ID, or a reset secret) and never contain the secret
- renewal is due at 80% of the lifetime; the status line counts down; bearer mode shows the expiry and a hint
- a still-valid token is renewed before a request once due, and is kept if HPE is unavailable

## Residual risks

| Risk | Notes and mitigations |
|---|---|
| **Credentials at rest in the browser** | A remembered client secret or token sits in `localStorage` on that device. Leave Remember unticked on shared machines. Forget clears it. Prefer a read-only API client so a leaked secret cannot change configuration |
| **Cross-site scripting** | Script injected into the page could read the stored credentials. The page has no third-party scripts, and device data is escaped before display. `site/_headers` sets a CSP with `script-src 'self'` and a `connect-src` allowlist, so injected markup cannot run inline script or send data to other hosts. `style-src` keeps `'unsafe-inline'` for generated SVG style attributes |
| **Credentials in transit through the Worker** | The token (and, in the fallback only, the client secret) passes through Cloudflare's edge for one request. It is not stored, logged or cached by this code. Cloudflare platform logs record URLs, not headers, and credentials are never placed in URLs |
| **Token lifetime** | Tokens from a new Central personal API client last about 2 hours (`expires_in` 7199). Tokens from a GreenLake platform (GLP) API client last 15 minutes (`expires_in` 899). HPE issues no refresh token, but the client secret stays valid until it is reset or deleted, so client-credential sign-in renews silently at 80% of the lifetime while the tab is visible, renews before a request once due, and mints once more when a token is rejected. Resetting the secret in GreenLake invalidates its tokens; the page then says the secret was probably reset. A pasted bearer token that is a JWT stores its `exp` claim (the payload is decoded locally, with no signature check and no network call). Bearer sign-in does not reuse an expired or rejected token, including one remembered in localStorage; the panel asks for a new paste |
| **Public Worker as a relay** | The Worker forwards only to new Central cluster hosts and only read-only GETs, so it cannot be used as a general proxy. Rate limiting (a Workers rate-limit binding or WAF rule on `/api/*`) is still advisable to protect the Central API quota |
| **Over-privileged clients** | Users should create a new Central personal API client with the narrowest read-only role for Central monitoring |

## Still open

- A real GLP token mint (HTTP 200) has not been run; the success path is tested with mocks only.
- The Workspace ID pattern `^[A-Za-z0-9-]{8,64}$` is inferred, not documented. If real IDs fall outside it, widen it in `site/js/creds.js` and `worker/src/central.ts` together.
- `site/_headers` was confirmed under `wrangler dev --assets`; that Cloudflare Pages serves it in production is expected but unverified until deploy.

- Whether a public Toolbox listing is acceptable for this page, or whether it should sit behind Cloudflare Access anyway as defense in depth.
- Whether to ship with `MOCK=0` in production (401 without credentials) or keep the mock demo for visitors.
