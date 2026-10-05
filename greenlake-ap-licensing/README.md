# GreenLake × Aruba Central — AP Licensing Report

<p align="left">
  <a href="../README.md"><img src="https://img.shields.io/badge/Toolbox-cmdlabtech-181717?style=flat-square&logo=github" alt="Toolbox"/></a>
  <a href="../LICENSE"><img src="https://img.shields.io/badge/License-MIT-0A7B3E?style=flat-square" alt="MIT"/></a>
  <img src="https://img.shields.io/badge/Stack-Python%20%7C%20Cloudflare%20Workers-F38020?style=flat-square" alt="Stack"/>
  <a href="https://ap-license-report.admin2655.workers.dev/"><img src="https://img.shields.io/badge/Hosted-Live-0A7B3E?style=flat-square" alt="Live"/></a>
  <a href="https://www.paypal.com/donate/?hosted_button_id=Z5SDZULELYGNS"><img src="https://img.shields.io/badge/Donate-PayPal-00457C?style=flat-square&logo=paypal&logoColor=white" alt="Donate"/></a>
</p>

<p align="center">
  <a href="../README.md"><img src="../branding/cmdlab-wordmark.png" alt="CMDLAB" width="280"/></a>
</p>


> **Part of [Toolbox](../README.md)** — open network utilities by **CMDLAB** / [cmdlabtech](https://github.com/cmdlabtech).

There is no built-in bridge between HPE GreenLake subscription data and Aruba
Central AP status. This tool builds that bridge: it pulls device + subscription
data from the GreenLake platform APIs, pulls AP up/down status from the Aruba
Central monitoring API, joins them on serial number (MAC as fallback), and
writes a **single self-contained HTML report** you can email or drop on a share.

The report answers:

- **Which exact APs are licensed or unlicensed?**
- **Which Down APs are still holding a subscription** and should be detached to
  free the seat?
- **Which subscription key is attached to which AP, by AP name** — including
  seats used/free and expiration dates.
- Which devices exist in one system but not the other (inventory drift).

Every table is searchable, sortable, and exportable to CSV. The report is a
static file with the data baked in — no credentials or API access are needed to
view it, so it is safe to share with people who have no GreenLake/Central login.

Works with **both flavors of Central**: New Central (GreenLake-native) and
Classic Aruba Central — pick the mode in the UI or in `config.ini`.

## Use it now (hosted)

<p align="center">
  <a href="https://ap-license-report.admin2655.workers.dev/"><img src="https://img.shields.io/badge/Launch_hosted_app-ap--license--report-0B5FFF?style=for-the-badge" alt="Launch hosted app"/></a>
</p>

**Public app:** [https://ap-license-report.admin2655.workers.dev/](https://ap-license-report.admin2655.workers.dev/)

Open that URL, enter your own GreenLake / Aruba Central credentials, and
generate the report. No install. Credentials stay in your browser’s
localStorage and are only sent over HTTPS for each API call — nothing is
stored on the server. Source for the hosted app is under [`worker/`](worker/).

## Quick start — local web UI

```bash
pip install -r requirements.txt
python app.py          # then open http://localhost:8321
```

Enter credentials in the browser (a **?** button in the top-right corner has
step-by-step setup instructions), pick your Central type, and generate the
report in-page or download it as a standalone file. Try the **demo data**
button to see the output without any credentials.

In a generated report's **Action needed** tab, each detach candidate has two
buttons (in-app only — downloaded reports are static snapshots):

- **Detach** removes the subscription assignment in GreenLake after a
  confirmation, freeing the seat
  (`PATCH /devices/v1/devices` with an empty subscription list; processed
  asynchronously by GreenLake). The GreenLake credential needs write access
  to Devices — Operator role or higher.
- **Ignore** marks the AP as *down temporarily* for the current instance: it
  moves to an "Ignored" list, is excluded from detach candidates in future
  reports, and can be unignored any time. Ignore lists are saved per
  instance.

The **Instances** sidebar keeps one saved credential set per customer,
workspace, or region — add one with **+**, switch by clicking, delete with
the 🗙 that appears on hover. Instances (including secrets) are stored
unencrypted in that browser's localStorage on the user's own machine — never
on the server — so treat a shared computer's browser profile accordingly.
The credentials panel collapses (click its header) and folds away
automatically once a report is generated.

The server binds to `127.0.0.1` — if you want teammates to use it, put it
behind a reverse proxy with HTTPS and authentication, or just send them the
generated report file instead.

## Quick start — command line

```bash
pip install -r requirements.txt

# preview with sample data (no credentials needed)
python run_report.py --demo
open ap_license_report.html

# real data
cp config.example.ini config.ini   # then fill in credentials
python run_report.py
```

## Which Central do I have?

| | **New Central** (GreenLake-native) | **Classic Central** |
|---|---|---|
| Login | via the GreenLake portal (`common.cloud.hpe.com`) | directly at `central.arubanetworks.com` |
| API base URL | `https://<cluster>.api.central.arubanetworks.com` (us1, eu1, de1…) | `https://apigw-…central.arubanetworks.com` |
| AP status API | `GET /network-monitoring/v1/aps` | `GET /monitoring/v2/aps` |
| Auth | GreenLake platform tokens (reuses the same credentials) | Central access/refresh tokens |
| config.ini | `mode = new` | `mode = classic` |

## Credentials

### HPE GreenLake

1. In your GreenLake workspace: **Manage Workspace → API → Create Credentials**.
2. Choose the workspace, create the credential, and copy the **Client ID** and
   **Client Secret** into the `[greenlake]` section of `config.ini`.
3. The credential needs read access to *Devices* and *Subscriptions* (an
   Observer role on the workspace is sufficient).

### New Central (GreenLake-native)

Set `mode = new` and `base_url` to your cluster
(e.g. `https://us1.api.central.arubanetworks.com`). No extra credentials
needed — New Central accepts GreenLake platform tokens, so the GreenLake
client ID/secret above are reused. If you prefer a dedicated API client,
create one in New Central (**Global Settings → API**) and put its ID/secret
in the `[central]` section.

### Classic Central

Set `mode = classic` and `base_url` to your regional API gateway (Central UI →
**Organization → Platform Integration → REST API** shows it), then pick one
auth option:

- **Option A — quick test:** in Central go to **API Gateway → System Apps &
  Tokens**, generate a token, paste it as `access_token`. Tokens last ~2 hours.
- **Option B — repeat runs:** create an app under **API Gateway → My Apps &
  Tokens**, copy `client_id`, `client_secret`, and the `refresh_token` into
  `config.ini`. The tool refreshes automatically and caches rotated tokens in
  `.central_token.json` (chmod 600, gitignored).

All settings can also come from environment variables (`GL_CLIENT_ID`,
`GL_CLIENT_SECRET`, `CENTRAL_BASE_URL`, `CENTRAL_ACCESS_TOKEN`,
`CENTRAL_CLIENT_ID`, `CENTRAL_CLIENT_SECRET`, `CENTRAL_REFRESH_TOKEN`) —
handy for CI or scheduled runs.

## Usage

```
python run_report.py [options]

  -c, --config FILE      config file (default: config.ini)
  -o, --output FILE      output HTML (default: ap_license_report.html)
  --demo                 use synthetic sample data, no API calls
  --expiring-days N      flag subscriptions ending within N days (default 90)
  --include-non-ap       include switches/gateways, not just APs
  --dump-json FILE       also save raw API payloads for debugging
```

Schedule it (cron, Task Scheduler, CI) and publish the HTML to a share or
intranet page for an always-current view.

## What the report shows

| Tab | Contents |
|---|---|
| **Action needed** | Down APs holding a subscription (detach candidates), ignored-as-temporarily-down APs, and unlicensed APs |
| **All APs** | Full inventory: name, serial, MAC, site, status, license state, key, tier, expiry, GreenLake tags |
| **Subscriptions** | Every key: tier, SKU, used/total/free seats, dates, days left, attached AP names, GreenLake tags |
| **Mismatches** | GreenLake devices Central has never seen (not yet provisioned, RMA'd, or spares) |

## How the join works

1. `GET /devices/v1/devices` (GreenLake) — serial, MAC, device type, and the
   subscription key(s) attached to each device.
2. `GET /subscriptions/v1/subscriptions` (GreenLake) — key, tier, quantity,
   available seats, start/end dates.
3. `GET /monitoring/v2/aps` (Classic Central) or
   `GET /network-monitoring/v1/aps` (New Central) — AP name, status (Up/Down),
   site, group, model, IP, last-seen.
4. Central APs are matched to GreenLake devices by **serial number**, falling
   back to **normalized MAC address**. Unmatched devices land in *Mismatches*.

## Notes & future ideas

- **Why does the web UI need a server?** Both APIs reject cross-origin
  browser requests (CORS), so a static HTML page can't call them directly —
  the Flask app (`app.py`) acts as the local proxy. To host it for a team,
  put it behind HTTPS + auth; the clients and correlation logic in `glc/`
  are already shared between the CLI and the web app.
- The GreenLake payload field names vary across API versions; parsing is
  defensive (`glc/correlate.py`). If a field comes back empty, run with
  `--dump-json raw.json` and inspect what your tenant actually returns.

## Support

If this report saves you a morning of spreadsheet archaeology, consider supporting continued development:

[![Donate with PayPal](https://img.shields.io/badge/Donate_with-PayPal-00457C?style=for-the-badge&logo=paypal&logoColor=white)](https://www.paypal.com/donate/?hosted_button_id=Z5SDZULELYGNS)

## License

MIT — see the [Toolbox LICENSE](../LICENSE).

---

<p align="center">
  <sub>
    <a href="../README.md">Toolbox</a>
    · <a href="worker/">Worker docs</a>
    · <a href="../SECURITY.md">Security</a>
    · <a href="https://www.paypal.com/donate/?hosted_button_id=Z5SDZULELYGNS">Donate</a>
    · <a href="https://github.com/cmdlabtech">CMDLAB</a>
  </sub>
</p>
