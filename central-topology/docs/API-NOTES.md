# New Central API notes

This app uses the **new Central (HPE GreenLake) MRT API only**. Every call is a read-only `GET` under `/network-monitoring/v1`. The checks on 2026-10-27 used the OpenAPI blocks embedded in each reference page (`<page>.md`), listed in the index at https://developer.arubanetworks.com/new-central/reference/llms.txt.

## Auth

- **Flow:** OAuth2 client credentials (`grant_type=client_credentials`). No `scope` or `audience` parameter is documented or sent.
- **Request:** `POST https://sso.common.cloud.hpe.com/as/token.oauth2` with `Content-Type: application/x-www-form-urlencoded` and form fields `grant_type=client_credentials`, `client_id` and `client_secret` (all required). This is the documented form; the issuer's discovery document also lists HTTP Basic (`client_secret_basic`), which this project does not use.
- **Credentials:** a **personal API client for the new Central instance** (HPE GreenLake: Manage Workspace > Personal API clients, service = your Central instance).
- **GreenLake platform (GLP) API clients** can also call new Central, but they use a different, workspace-specific token endpoint: `POST https://global.api.greenlake.hpe.com/authorization/v2/oauth2/<workspace-id>/token` with the same form body. That endpoint rejects browser preflights (no CORS), so this project does not exchange GLP credentials; a token from it can be used with Bearer token sign-in.
- **Response:** `{access_token, token_type: "Bearer", expires_in}`. `expires_in` is 7199 seconds for Central personal API clients and 899 seconds for GLP clients. There is no refresh token; request a new token when it expires (the browser does this automatically for client-credential sign-in).
- **Tokens do not work with Classic Central.**
  - Reference: https://developer.arubanetworks.com/new-central/reference/generate-access-token
  - Guide: https://developer.arubanetworks.com/new-central/docs/generating-and-managing-access-tokens
  - GreenLake authentication: https://developer.greenlake.hpe.com/docs/greenlake/guides/public/authentication/authentication
- **Using the token:** send it as `Authorization: Bearer <token>` to the cluster base URL.
  - Base URLs come from the spec `servers` list, for example `https://us1.api.central.arubanetworks.com`, `us2`, `us4`, `us5`, `us6`, `de1`–`de3`, `gb1`, `ca1`, `in1`, `jp1`, `au1` and `ae1`.
  - The user picks the cluster in the browser's credentials panel. It reaches the Worker in the `X-Central-Base` header, and the Worker accepts only `https://<cluster>.api.central.arubanetworks.com` (or `.com.cn`).
- **Where credentials live:** in the user's browser only (see `TOKEN-RISK.md`). The Worker has no secrets, never mints a token on its own, and never retries with stored credentials. A Central 401 or 403 is returned to the browser as 401, and the browser drops that token. Client-credential sign-in mints one new token and retries that request once. Bearer sign-in opens the credentials panel and asks for a new token. A pasted JWT stores its `exp` claim, so an expired token is not sent again.

## CORS check (direct browser calls vs pass-through)

Checked on 2026-10-27 at about 15:00 EDT. Each endpoint got a preflight (`OPTIONS` with `Origin` and `Access-Control-Request-*`) from curl, and a real `fetch()` from headless Chrome on `http://127.0.0.1:8799`. Only obviously fake credential values were used. The HPE developer docs do not say anything about CORS for either host.

| Endpoint | Preflight result | Browser `fetch()` | Verdict |
|---|---|---|---|
| `POST https://sso.common.cloud.hpe.com/as/token.oauth2` | 200. `Access-Control-Allow-Origin` echoes the caller's origin, with `Allow-Methods: POST,GET,DELETE,PUT` and `Allow-Headers: Content-Type,...,Authorization`. The actual 401 response also carries `Access-Control-Allow-Origin` | Readable: `HTTP 401 {"error":"unauthorized_request"}` | **Direct.** The browser mints its own token, so the client secret goes only from the browser to HPE |
| `GET https://<cluster>.api.central.arubanetworks.com/network-monitoring/v1/...` (us1, us2 and de1 checked) | `401 Unauthorized` with no `Access-Control-Allow-*` headers. A preflight never carries `Authorization`, so it can never pass | `TypeError: Failed to fetch` (blocked by CORS) | **Pass-through required.** The Worker relays each GET statelessly |

Resulting design:
1. **Token:** the browser POSTs to the GreenLake token endpoint directly. Only if that request fails at the network or CORS level (for example, if HPE changes its CORS policy) does the browser fall back to `POST /api/token` on the Worker. That route takes a JSON body, never a query string, forwards it to the same endpoint, and returns `{access_token, expires_in}` with `Cache-Control: no-store`. The browser holds the token.
2. **Data:** the browser calls the Worker with `Authorization: Bearer <token>` and `X-Central-Base: <cluster URL>`. The Worker uses them for that one request and returns `Cache-Control: no-store`.
3. If HPE ever adds CORS to the cluster API hosts, `site/js/creds.js` and `app.js` could call Central directly and the Worker could be retired. Re-run the probe above before relying on that.

## Request-method check (token and data calls)

Checked on 2026-10-27 at about 18:15 EDT with curl and obviously fake values only (no real client, secret or token). The OpenAPI specs behind the reference pages were also compared with the code: every data call is `GET` under `/network-monitoring/v1` with `Authorization: Bearer`, and list calls page with `limit` (max 1000; this project uses 100) and `offset`.

| Request | Result | Meaning |
|---|---|---|
| `POST /as/token.oauth2`, form body (`grant_type`, `client_id`, `client_secret`) | `401 {"error":"unauthorized_request"}` | Format accepted; the fake client is rejected. This is the method the project uses |
| `POST /as/token.oauth2`, JSON body with the same fields | `400 {"error":"invalid_request"}` | JSON is not accepted. The Worker fallback therefore converts the browser's JSON to a form body before calling HPE |
| `POST /as/token.oauth2`, HTTP Basic plus form `grant_type` | `401 {"error":"unauthorized_request"}` | Also accepted (discovery lists `client_secret_basic`), but not the documented form |
| `POST /as/token.oauth2`, form body without `grant_type` | `400 {"error":"invalid_request"}` | `grant_type` is required |
| `GET /as/token.oauth2` | `404` | Token requests must be `POST` |
| `POST https://global.api.greenlake.hpe.com/authorization/v2/oauth2/<fake-workspace-id>/token`, form body | `404 {"error":"invalid_request"}` | GLP workspace issuer; needs a real workspace ID |
| `OPTIONS` on the GLP workspace issuer with `Origin` | `401`, no `Access-Control-Allow-*` | No CORS; a browser cannot call it directly |
| `HEAD`, `GET` (fake bearer) and `OPTIONS` on `us1`, `de1` and `cn1` `/network-monitoring/v1/sites-health` | `401`, `WWW-Authenticate: Bearer realm=api, error=invalid_token`; body `HPE_GL_NETWORKING_ERROR_UNAUTHORIZED` | Bearer auth confirmed; no CORS. The gateway authenticates before routing, so unauthenticated probes cannot confirm individual paths; the paths come from the specs |

## Source of truth: topology

| Purpose | New Central call | Doc | Status |
|---|---|---|---|
| Site list (site id → name). Not an inventory call. | `GET /network-monitoring/v1/sites-health?limit&offset` → `items[].id`, `items[].siteName`, `total` | https://developer.arubanetworks.com/new-central/reference/listsiteshealthv1 | Path and fields verified in spec |
| **Switches, sites, links (inventory)** | `GET /network-monitoring/v1/topology/{site-id}` | https://developer.arubanetworks.com/new-central/reference/getlinktopology | Path and fields verified in spec. See the caveats below |
| Home site of a switch listed in more than one site topology | `GET /network-monitoring/v1/switches/{serial-number}` → `siteId`, `siteName` | https://developer.arubanetworks.com/new-central/reference/getswitchv1 | Verified in spec |
| LLDP fill-in, only for switches the merged topology leaves disconnected | `GET /network-monitoring/v1/neighbours/{serial-number}` → `neighbours[].serial`, `localPort`, `toPort` | https://developer.arubanetworks.com/new-central/reference/getneighbours | Verified in spec |
| VLAN SVI addresses (mgmt candidates) | `GET /network-monitoring/v1/switches/{serial-number}/vlans?limit&offset` → `items[].id`, `name`, `ipv4` | https://developer.arubanetworks.com/new-central/reference/listvlansv1 | Verified in spec |
| OOBM / loopback addresses (mgmt candidates) | `GET /network-monitoring/v1/switches/{serial-number}/interfaces?limit&offset` → `items[].name`, `type`, `ipv4` | https://developer.arubanetworks.com/new-central/reference/listinterfacesv1 | Fields verified. Whether OOBM or loopback rows appear is **unverified** |

The app makes **no** device-inventory call. It never calls `GET /network-monitoring/v1/devices`, `GET /network-monitoring/v1/switches` (the list) or the device-inventory endpoints. The tests assert this.

### Topology response fields (getlinktopology)

- `devices[]`: `serial` (unmanaged devices are `tpd_<mac>`), `mac`, `name`, `health`, `model`, `deviceFunction` (example "Access Switch"), `deployment`, `status`, `type` (example "Switch"), **`ipv4`**, `healthReason`, `conductorSerial`, `internet`, `lastSeen`, `vlans` (VLAN IDs only, no addresses).
- `links[]`: `from`, `to` (serials), `edgeType` (example "ETHERNET"), `health`, `healthReason`, `speed` (Gbps), `stpState`, `fromPortList[]`/`toPortList[]` (`index`, `name`, `lag`, `health`, `vlanId`, `vlanMode`, `allowedVlans`, `nativeVlan`), `isSibling`.
- Merged link ports: `fromPorts[]` and `toPorts[]` are `{name, lag}` from every `fromPortList` / `toPortList` entry (`name` and `lag`). `fromPort` and `toPort` stay the first port name. An LLDP fill-in uses `neighbours[].localPort` on the queried switch and `neighbours[].toPort` on the neighbor; several rows for one neighbor are one link. `include=interfaces` is still only the management-IP fetch (OOBM and loopback). Link interfaces come from the topology port lists and the LLDP port fields above.
- Top level: `id`, `type`, `isolatedDevicesCount`, `isolatedHealth`.

### Unverified or ambiguous (needs a live tenant)

1. **`devices` and `links` are typed as single objects** in the schema, not arrays. The client accepts an array, a single object, or a keyed object (`asList`).
2. **Cross-site links.** We don't know whether a site's topology includes the peer device and link when a building core uplinks to a district core in another site. The Worker merges every site's topology and de-duplicates devices and links. If a switch is still cut off, it asks `neighbours/{serial}` for the missing adjacency. The fixtures cover both cases: Pine ES leaves its uplink out, and the other sites include it.
3. **Home site of shared devices.** If a device appears in several site topologies, the Worker asks switch detail for its `siteName`. The topology response has no explicit "home site" field.
4. **`type` values.** Only the example "Switch" is documented. The Worker treats any `type` that contains "switch" as a switch. Everything else (APs, gateways, `tpd_` devices) is drawn as an external device.
5. **OOBM and loopback in `interfaces`.** The type enum is not documented. Rows are classified by `type` or `name` (`mgmt`, `oobm`, `loopback*`, `lo*`). If none match, the option does not appear.
6. **Rate limits.** The spec lists 429 responses for each call. The Worker caps concurrency at 4 and reports 429 to the UI. The documented quota has not been checked.
7. **Large tenants.** The call count is 1 (sites) + N sites + up to 2 × switches (vlans, interfaces) + a few detail and neighbour calls.

## Management IP: end to end

1. **Central fields**
   - Monitoring IP is `devices[].ipv4` from the topology response.
   - VLAN SVI is `items[].ipv4` from `switches/{serial}/vlans`, and the user picks the VLAN.
   - OOBM and loopback are `items[].ipv4` from `switches/{serial}/interfaces`, classified as described above.
   - Switch detail also returns `ipv6` and `publicIp`. They are not offered: v4-only diagram, and the public IP is not a management address.
2. **Worker** (`/api/topology?include=vlans,interfaces`). Each switch carries:
   - `ipv4` from the topology response
   - `vlans[]`, keeping only VLANs that have an `ipv4`
   - `interfaces[]`, keeping only `oobm` or `loopback` rows that have an `ipv4`
3. **Client model** (`site/js/model.js`)
   - `mgmtOptions()` lists only the options that at least one switch can supply, with a count such as "VLAN 99 (MGMT) SVI — 17/19".
   - `resolveMgmt(switch, option)` returns `{ip, fallback, source}`. When the chosen source is missing it falls back to the monitoring IP and sets `fallback: true`.
4. **UI.** The Mgmt IP selector is saved in `localStorage` (`ct-mgmt`). Every node is labeled with its name and the resolved IP. A fallback shows as amber "(fallback)" text with a dashed amber outline.
5. **Exports**
   - SVG and PNG are the same rendered SVG, so they carry the same labels and markers.
   - JSON records `mgmtSelection` and, for each switch, `mgmtIp`, `mgmtIpSource` and `mgmtFallback`.
