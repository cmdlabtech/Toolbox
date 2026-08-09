# Toolbox

Small, open utilities for network admins — especially **HPE Aruba**, **ClearPass**, and **GreenLake**.

Each folder is standalone. Clone the whole repo or copy a single tool. Most were originally built with Claude Code and then cleaned up for public use.

## Tools

| Tool | Folder | What it does | Stack |
|------|--------|--------------|--------|
| **[NetWatch](netwatch/)** | `netwatch/` | Continuous ping loss monitoring → automatic packet capture → Claude/Grok root-cause analysis | Python, local browser GUI |
| **[AOS-CX Config Backup](aos-cx-config-backup/)** | `aos-cx-config-backup/` | Scheduled config backups for AOS-CX switches (local, GitHub, or Wasabi S3) from a Windows tray app | Python / Windows EXE |
| **[GreenLake AP Licensing](greenlake-ap-licensing/)** | `greenlake-ap-licensing/` | Joins HPE GreenLake subscriptions with Aruba Central AP status into one searchable HTML report — **[use the hosted app](https://ap-license-report.admin2655.workers.dev/)** | Python (Flask/CLI) + Cloudflare Worker |
| **[ClearPass Endpoint Console](clearpass-endpoint-console/)** | `clearpass-endpoint-console/` | Bulk or manual import of MACs into ClearPass Policy Manager endpoint and guest device repositories | Single-file HTML (browser → CPPM API) |
| **[ClearPass CertKit notes](clearpass-certkit/)** | `clearpass-certkit/` | Setup checklist for automating ClearPass certificate deployment via CertKit + ISRG Root X1 PEM | Ops guide |

## Quick start

```bash
git clone https://github.com/cmdlabtech/Toolbox.git
cd Toolbox
```

Then open the tool folder you need and follow its README.

### Common entry points

```bash
# NetWatch (requires Python 3.11+)
cd netwatch && python3 netwatch.py

# GreenLake AP licensing report — hosted (no install):
#   https://ap-license-report.admin2655.workers.dev/
# Local UI (optional):
cd greenlake-ap-licensing
pip install -r requirements.txt
python app.py   # http://localhost:8321

# ClearPass endpoint console — open in a browser
open clearpass-endpoint-console/index.html
# or: double-click index.html / serve via any static file server
```

Windows AOS-CX backups: see [aos-cx-config-backup/README.md](aos-cx-config-backup/README.md) for the prebuilt EXE or source build.

## Who this is for

- Network engineers running **Aruba Central**, **AOS-CX**, **ClearPass**, or **HPE GreenLake**
- Anyone who wants small tools without a heavy install or SaaS dependency
- People who prefer credentials to stay on their machine (or in their own browser), not in a third-party cloud

## Design notes

- **No account required** for these tools themselves. Where APIs are involved, you use *your* GreenLake / Central / ClearPass credentials.
- **Prefer local-first.** NetWatch and the GreenLake Flask app bind to localhost. The ClearPass console keeps tokens in memory only (reload clears them).
- **Binaries** (where available) live on GitHub Releases of the original standalone repos or future monorepo releases — this tree is source-focused.
- **No maintainer secrets in this repo.** Samples are synthetic; runtime configs and API keys stay on your machine. See [SECURITY.md](SECURITY.md).

### Related standalone repos

Some tools also exist (or existed) as separate repositories:

| Tool | Standalone repo |
|------|-----------------|
| NetWatch | [cmdlabtech/Netwatch](https://github.com/cmdlabtech/Netwatch) |
| AOS-CX Config Backup | [cmdlabtech/AOS-CX-Config-Backup-Tool](https://github.com/cmdlabtech/AOS-CX-Config-Backup-Tool) |

This monorepo is the **central public home** for browsing and contributing. Prefer opening issues and PRs here unless you are only updating a standalone release pipeline.

## License

[MIT](LICENSE) — free to use, modify, and redistribute.

## Contributing

1. Keep each tool self-contained under its folder.
2. Do not commit secrets, `config.ini`, virtualenvs, `node_modules`, or built binaries.
3. Prefer small, focused fixes with a short description of the environment you tested on (OS, firmware, API type).

---

**Made by Cameron / [cmdlabtech](https://github.com/cmdlabtech)**
