# ClearPass Endpoint Console

<p align="left">
  <a href="../README.md"><img src="https://img.shields.io/badge/Toolbox-cmdlabtech-181717?style=flat-square&logo=github" alt="Toolbox"/></a>
  <a href="../LICENSE"><img src="https://img.shields.io/badge/License-MIT-0A7B3E?style=flat-square" alt="MIT"/></a>
  <img src="https://img.shields.io/badge/Type-Single--file%20HTML-E34F26?style=flat-square" alt="HTML"/>
  <img src="https://img.shields.io/badge/ClearPass-REST%20API-00ADEF?style=flat-square" alt="ClearPass"/>
  <a href="https://cmdlab.tech/donate"><img src="https://img.shields.io/badge/Donate-PayPal-00457C?style=flat-square&logo=paypal&logoColor=white" alt="Donate"/></a>
</p>

<p align="center">
  <a href="../README.md"><img src="../branding/cmdlab-wordmark.png" alt="CMDLAB" width="280"/></a>
</p>


> **Part of [Toolbox](../README.md)** — open network utilities by **CMDLAB** / [cmdlabtech](https://github.com/cmdlabtech).

One-page browser tool for importing MAC addresses into **ClearPass Policy Manager** — the **endpoint repository**, the **guest device repository**, or both.

No install: open [`index.html`](index.html) in a modern browser, authenticate to your CPPM REST API, then bulk-import from CSV/TSV or enter devices manually.

---

## Features

| Capability | Detail |
|------------|--------|
| **OAuth** | `client_credentials` or `password` grant |
| **Bulk import** | CSV/TSV — file picker, paste, sample, downloadable template |
| **Manual entry** | One-off devices without a spreadsheet |
| **Dual destination** | Policy Manager endpoints (`/api/endpoint`) and Guest devices (`/api/device`) — required for MPSK |
| **Write modes** | Create only, update only, or upsert |
| **MAC formats** | Bare / colon / dash |
| **Roles** | TIPS + Guest roles loaded from the API |
| **Privacy** | No disk or localStorage for credentials — a reload clears everything |

---

## Requirements

1. ClearPass Policy Manager with REST API enabled  
2. An API client with rights to read roles and create/update endpoints (and guest devices if you use that path)  
3. Browser trust of the CPPM TLS certificate (open `https://your-cppm/api-docs` once and accept if needed)  
4. **CORS** — the browser calls CPPM directly. If token requests work but later calls fail with a vague network error, CPPM is not returning CORS headers for your page origin. Front CPPM with a small reverse proxy and set **API base override** in the Connection tab.

---

## Quick start

1. Open [`index.html`](index.html) (file URL or any static web server).
2. **Connection** tab:
   - Enter CPPM host (hostname only)
   - Optional API base override (proxy URL)
   - Client ID / secret (and user/password if using password grant)
   - **Get token** → **Load roles** → optional **Test endpoint read**
3. **Bulk import** or **Manual entry** to write devices.
4. Check **Results** and the activity log for successes and API errors.

---

## CSV columns

Header row required. Common columns:

| Column | Notes |
|--------|--------|
| `mac` | Required. Any common MAC format; normalized before send |
| `status` | e.g. `Known`, `Unknown` (endpoint repo) |
| `description` | Free text |
| `Department`, `Owner`, … | Extra attributes as your dictionary allows |
| `guest_role` | Guest role name/id when writing guest devices |
| `mpsk` | Pre-shared key for guest device / MPSK workflows |
| `expire_time` | Optional expiry (`YYYY-MM-DD HH:MM:SS` style) |

Use **Download template** or **Load sample** in the UI for an exact starter row.

---

## Security notes

- Credentials and tokens live only in page memory for the session.
- Prefer an API client with the **minimum roles** needed (endpoint write; guest device write only if required).
- Do not host this page on a public website that also forces users to type production secrets unless you understand the trust model. Running it as a local file or on an internal admin host is the intended use.

See also [Toolbox SECURITY.md](../SECURITY.md).

---

## CORS proxy (optional)

If you need a proxy, it should:

- Terminate TLS to the browser  
- Forward `/api/*` to `https://your-cppm/api/*`  
- Add CORS headers for your page origin (`Access-Control-Allow-Origin`, methods, headers including `Authorization`)

Then set **API base override** to that proxy origin + path prefix (for example `https://proxy.example.com/cppm`).

---

## Support

If this console shortens your MAC import fire drills, consider supporting continued development:

[![Donate with PayPal](https://img.shields.io/badge/Donate_with-PayPal-00457C?style=for-the-badge&logo=paypal&logoColor=white)](https://cmdlab.tech/donate)

## License

MIT — see the [Toolbox LICENSE](../LICENSE).

---

<p align="center">
  <sub>
    <a href="../README.md">Toolbox</a>
    · <a href="../clearpass-certkit/">CertKit notes</a>
    · <a href="../SECURITY.md">Security</a>
    · <a href="https://cmdlab.tech/donate">Donate</a>
    · <a href="https://github.com/cmdlabtech">CMDLAB</a>
  </sub>
</p>
