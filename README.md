# Toolbox

<p align="center">
  <img src="branding/cmdlab-wordmark.png" alt="CMDLAB" width="360" />
</p>

<p align="center">
  <strong>CMDLAB Toolbox</strong><br/>
  <sub>Open-source network utilities for HPE Aruba, ClearPass &amp; GreenLake</sub>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-0A7B3E?style=flat-square" alt="MIT License"/></a>
  <a href="https://github.com/cmdlabtech/Toolbox"><img src="https://img.shields.io/badge/GitHub-cmdlabtech%2FToolbox-181717?style=flat-square&logo=github" alt="Repository"/></a>
  <a href="SECURITY.md"><img src="https://img.shields.io/badge/Security-policy-0B5FFF?style=flat-square" alt="Security"/></a>
  <a href="https://cmdlab.tech/donate"><img src="https://img.shields.io/badge/Donate-PayPal-00457C?style=flat-square&logo=paypal&logoColor=white" alt="Donate with PayPal"/></a>
</p>

---

## Overview

**CMDLAB Toolbox** is a curated collection of small, production-minded tools for network engineers. Each project lives in its own folder, runs independently, and keeps **your credentials on your machine** (or in your browser)—not in a third-party SaaS account.

| | |
|---|---|
| **Audience** | Network admins, MSP engineers, and lab operators |
| **Focus** | HPE Aruba Central, AOS-CX, ClearPass, GreenLake |
| **Model** | Free & open source (MIT) · optional support via donation |
| **Secrets** | Never committed — see [SECURITY.md](SECURITY.md) |

---

## Catalog

| Tool | Description | Get started |
|------|-------------|-------------|
| **[NetWatch](netwatch/)** | Continuous ICMP loss monitoring, automatic packet capture, Claude / Grok root-cause analysis | [Docs](netwatch/) · [Releases](https://github.com/cmdlabtech/Netwatch/releases) |
| **[AOS-CX Config Backup](aos-cx-config-backup/)** | Scheduled AOS-CX config backups from a Windows tray app (local, GitHub, or Wasabi S3) | [Docs](aos-cx-config-backup/) · [EXE V3.7](https://github.com/cmdlabtech/AOS-CX-Config-Backup-Tool/releases/download/V3.7/AOS-CX.Config.Backup.Tool.exe) |
| **[GreenLake AP Licensing](greenlake-ap-licensing/)** | Join GreenLake subscriptions with Central AP status into one searchable HTML report | **[Launch hosted app](https://ap-license-report.admin2655.workers.dev/)** · [Docs](greenlake-ap-licensing/) |
| **[ClearPass Endpoint Console](clearpass-endpoint-console/)** | Bulk / manual MAC import into Policy Manager endpoints and Guest devices | [Open console](clearpass-endpoint-console/) · [Docs](clearpass-endpoint-console/) |
| **[ClearPass CertKit notes](clearpass-certkit/)** | Ops checklist for CertKit → ClearPass certificate deploy + ISRG Root X1 PEM | [Docs](clearpass-certkit/) |

---

## Quick start

```bash
git clone https://github.com/cmdlabtech/Toolbox.git
cd Toolbox
```

Open the tool folder you need and follow its README. Common entry points:

```bash
# NetWatch (Python 3.11+)
cd netwatch && python3 netwatch.py

# GreenLake AP licensing — hosted (no install)
# https://ap-license-report.admin2655.workers.dev/

# GreenLake AP licensing — local UI
cd greenlake-ap-licensing
pip install -r requirements.txt
python app.py    # http://localhost:8321

# ClearPass Endpoint Console
open clearpass-endpoint-console/index.html
```

Windows AOS-CX backups: use the [prebuilt EXE](https://github.com/cmdlabtech/AOS-CX-Config-Backup-Tool/releases) or build from [aos-cx-config-backup/](aos-cx-config-backup/).

---

## Design principles

- **No account required** for Toolbox itself — you supply vendor API credentials only when a tool needs them.
- **Local-first** — NetWatch and the GreenLake Flask UI bind to localhost; the ClearPass console keeps tokens in memory only.
- **Source-focused repo** — binaries ship via GitHub Releases where available; this tree is for reading, building, and contributing.
- **Transparent security** — samples are synthetic; maintainer secrets are never stored here ([SECURITY.md](SECURITY.md)).

### Related standalone repositories

| Tool | Standalone repo |
|------|-----------------|
| NetWatch | [cmdlabtech/Netwatch](https://github.com/cmdlabtech/Netwatch) |
| AOS-CX Config Backup | [cmdlabtech/AOS-CX-Config-Backup-Tool](https://github.com/cmdlabtech/AOS-CX-Config-Backup-Tool) |

This monorepo is the **central public home**. Prefer issues and pull requests here unless you are updating a standalone release pipeline.

---

## Support the project

These tools are free to use and share. If they save you time in the field or the lab, consider a donation—it helps fund hosting, continued development, and new utilities.

<p align="center">
  <a href="https://cmdlab.tech/donate">
    <img src="https://img.shields.io/badge/Donate_with-PayPal-00457C?style=for-the-badge&logo=paypal&logoColor=white" alt="Donate with PayPal"/>
  </a>
</p>

<p align="center">
  <a href="https://cmdlab.tech/donate"><strong>paypal.com/donate</strong></a>
  · one-time or recurring · USD
</p>

---

## Contributing

1. Keep each tool self-contained under its folder.
2. Do not commit secrets, `config.ini`, virtualenvs, `node_modules`, or built binaries.
3. Prefer small, focused fixes with a short note on the environment you tested (OS, firmware, API type).

## License

Distributed under the [MIT License](LICENSE). Copyright © 2026 **CMDLAB LLC**.

---

<p align="center">
  <sub>
    <img src="branding/cmdlab-wordmark.png" alt="CMDLAB" height="18"/><br/><br/>
    <a href="https://github.com/cmdlabtech/Toolbox">Toolbox</a>
    · <a href="SECURITY.md">Security</a>
    · <a href="branding/">Branding</a>
    · <a href="https://cmdlab.tech/donate">Donate</a>
    · <a href="https://github.com/cmdlabtech">cmdlabtech</a>
  </sub>
</p>
