# AP Licensing Report — Cloudflare Worker

<p align="left">
  <a href="../../README.md"><img src="https://img.shields.io/badge/Toolbox-cmdlabtech-181717?style=flat-square&logo=github" alt="Toolbox"/></a>
  <a href="../README.md"><img src="https://img.shields.io/badge/Parent-GreenLake%20tool-0B5FFF?style=flat-square" alt="Parent"/></a>
  <img src="https://img.shields.io/badge/Runtime-Cloudflare%20Workers-F38020?style=flat-square" alt="Workers"/>
  <a href="https://www.paypal.com/donate/?hosted_button_id=Z5SDZULELYGNS"><img src="https://img.shields.io/badge/Donate-PayPal-00457C?style=flat-square&logo=paypal&logoColor=white" alt="Donate"/></a>
</p>

<p align="center">
  <a href="../../README.md"><img src="../../branding/cmdlab-wordmark.png" alt="CMDLAB" width="280"/></a>
</p>


> **Part of [Toolbox](../../README.md)** · parent tool docs: [GreenLake AP Licensing](../README.md)

A public, hosted version of the GreenLake × Aruba Central AP licensing tool.
Same UI and report as the local Flask app ([../README.md](../README.md)), but
runs as a Cloudflare Worker so anyone can open the URL, enter their own
credentials, and generate a report — no local install.

## Live URL

<p align="center">
  <a href="https://ap-license-report.admin2655.workers.dev/"><img src="https://img.shields.io/badge/Launch_hosted_app-Live-0A7B3E?style=for-the-badge" alt="Launch hosted app"/></a>
</p>

**https://ap-license-report.admin2655.workers.dev/**

That is the public instance used for day-to-day work. Open it in a browser,
enter credentials, and run reports or detach actions there.

The Python code in `../glc/` and `../app.py` is unchanged and still works for
CLI / local use. This directory is a standalone TypeScript rewrite of the
backend (the Flask server and `requests`-based clients don't run on Workers).

## Layout

```
worker/
  wrangler.toml          # Worker + static-assets config
  package.json           # wrangler + typescript (dev only)
  public/index.html      # the browser UI (served as a static asset)
  src/
    index.ts             # Worker entry: routes /api/report, /api/detach
    greenlake.ts         # HPE GreenLake client (devices, subs, detach)
    central.ts           # Classic Aruba Central client
    newCentral.ts        # New Central (GreenLake-native) client
    correlate.ts         # the GreenLake × Central join
    report.ts            # renders the report from report-template.html
    report-template.html # the self-contained report (imported as a string)
```

## Local development

```bash
cd worker
npm install
npm run dev          # wrangler dev → http://localhost:8787
npm run typecheck    # tsc --noEmit
```

Open the URL, enter credentials for an instance, and generate a report.
`wrangler dev` runs the Worker locally (no Cloudflare login).

## Deploy

```bash
npx wrangler login          # once, authorizes wrangler with your CF account
npm run deploy              # wrangler deploy
```

Wrangler prints the deployed URL (`https://ap-license-report.<subdomain>.workers.dev`).
Add a custom domain in the Cloudflare dashboard (Workers & Pages → your Worker
→ Settings → Domains & Routes) if you want a friendlier address.

### Plan

Use the **Workers Paid plan** ($5/mo). The free tier caps a single request at
50 external subrequests and 10 ms of CPU; a full device + subscription + AP
pull across a large estate can exceed both. Paid raises subrequests to 10,000
and CPU to the `cpu_ms` set in `wrangler.toml` (300 s here).

## Access control (important)

This deploys as an **open URL with no login**. That is deliberate — every
request carries the caller's *own* GreenLake / Aruba Central credentials, so a
stranger who finds the URL still can't read your data or touch your workspace
without already having valid credentials for it. But the Worker will relay
API calls for anyone, and there's no audit trail of who ran a detach.

Recommended guardrails (both are dashboard-only, no code):

1. **Rate limiting** on `/api/*` — Cloudflare dashboard → your Worker/zone →
   Security → Rate limiting rules. Caps abuse and protects you from tripping
   HPE/Aruba's own API rate limits.
2. If you later want a login wall, put **Cloudflare Access (Zero Trust)** in
   front of the Worker — again no code, just a dashboard policy (email OTP or
   SSO). This is the cleanest way to restrict who can reach the app.

## How credentials are handled

- Entered in the browser; **saved instances live in that browser's
  localStorage** (unencrypted, per device) — never on the server.
- On each report/detach, credentials go browser → Worker (HTTPS) → HPE/Aruba,
  are used for the calls, and are discarded. **Nothing is persisted
  server-side** (no KV, no D1, no files).
- Classic Central rotates its refresh token on every use. The Worker returns
  the rotated token in an `X-Central-Refresh-Token` response header and the
  browser folds it back into the instance — replacing the file cache the local
  Flask app uses (Workers have no filesystem).
- The Worker never logs request bodies or credential fields.

## Differences from the Flask app

| | Flask (`../app.py`) | Worker (this dir) |
|---|---|---|
| Runtime | Python + `requests` | TypeScript + `fetch` |
| Binding | `127.0.0.1` only | public HTTPS URL |
| Classic refresh token | cached in `.central_token_*.json` | returned to the browser, stored on the instance |
| Config file (`config.ini`) | supported (CLI) | n/a — browser-entered only |

The generated report HTML is byte-identical in structure; the downloadable
copy is static (no action buttons, no credentials) in both.

## Support

Hosting this Worker and maintaining the tooling takes time. If it helps your team, a donation is appreciated:

[![Donate with PayPal](https://img.shields.io/badge/Donate_with-PayPal-00457C?style=for-the-badge&logo=paypal&logoColor=white)](https://www.paypal.com/donate/?hosted_button_id=Z5SDZULELYGNS)

## License

MIT — see the [Toolbox LICENSE](../../LICENSE).

---

<p align="center">
  <sub>
    <a href="../../README.md">Toolbox</a>
    · <a href="../README.md">GreenLake tool</a>
    · <a href="../../SECURITY.md">Security</a>
    · <a href="https://www.paypal.com/donate/?hosted_button_id=Z5SDZULELYGNS">Donate</a>
  </sub>
</p>
