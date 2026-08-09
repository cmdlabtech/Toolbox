# Security

This document describes what is (and is not) in the public Toolbox repository, and how each tool handles credentials.

## What’s in the public repo

The GitHub repository contains **source code, docs, and synthetic sample data only**.

It does **not** intentionally include:

- API keys, client secrets, access tokens, or passwords
- Live `config.ini` / `.env` files
- Packet captures (`.pcap` / `.pcapng`)
- Switch backup inventories, encrypted app configs, or Fernet key files
- `node_modules/`, virtualenvs, or built binaries (`.exe` / `.dmg`)

A normal `git clone` or GitHub **Download ZIP** only includes tracked files. Runtime secrets are created **on the user’s machine** (or entered in the browser) after download.

## How credentials are handled per tool

| Tool | Where secrets live | What leaves the machine |
|------|--------------------|-------------------------|
| **NetWatch** | `~/.netwatch.conf` (local only, gitignored pattern) | Anthropic/xAI API calls if the user enables AI analysis; traffic capture stays local |
| **AOS-CX Config Backup** | Encrypted `backup_config.json` + `encryption_key.key` next to the app (gitignored) | HTTPS to the user’s switches; optional GitHub/Wasabi upload if the user configures it |
| **GreenLake AP Licensing (local Flask)** | Browser localStorage for UI instances; optional `config.ini` for CLI (gitignored) | API calls to HPE GreenLake / Aruba Central from localhost |
| **GreenLake AP Licensing (hosted Worker)** | Browser localStorage only; Worker does not persist credentials | Browser → Worker (HTTPS) → HPE/Aruba; credentials used per request then discarded |
| **ClearPass Endpoint Console** | In-memory only for the browser tab (reload clears) | Direct browser calls to the user’s CPPM API (or their CORS proxy) |
| **ClearPass CertKit notes** | Docs + public ISRG Root X1 PEM only | N/A |

## Hosted GreenLake app

Public URL: https://ap-license-report.admin2655.workers.dev/

- You enter **your** GreenLake / Central credentials.
- They are **not** stored on the server (no KV/D1/files for secrets).
- Anyone who finds the URL can use the Worker as a relay with **their own** credentials. Rate limiting / Cloudflare Access are recommended operational controls (see `greenlake-ap-licensing/worker/README.md`).

## Public certificate included

`clearpass-certkit/Root X1 Cert.pem` is the **public** ISRG Root X1 trust anchor (Let’s Encrypt / ISRG). It is not a private key.

## Reporting a vulnerability or secret leak

If you believe a secret was committed or a vulnerability exists:

1. **Do not** open a public issue with the secret value.
2. Contact the maintainer via GitHub: [@cmdlabtech](https://github.com/cmdlabtech).
3. If a credential was exposed, **rotate it immediately** in GreenLake, Central, ClearPass, Anthropic, xAI, GitHub, or Wasabi as applicable.

## Maintainer checklist (before commit / release)

- [ ] No `config.ini`, `.env`, `.netwatch.conf`, `encryption_key.key`, or `backup_config.json`
- [ ] No real serial numbers, customer names, or live MAC inventories in samples
- [ ] No `node_modules/`, `.venv/`, `dist/`, or binaries
- [ ] Sample data uses placeholders (`example.com`, `DEMO…` serials)
- [ ] GitHub Actions only use `GITHUB_TOKEN` / documented public downloads (no personal PATs in workflows)
