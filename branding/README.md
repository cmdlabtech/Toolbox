# CMDLAB branding

Official visual identity for **CMDLAB** / [cmdlabtech](https://github.com/cmdlabtech) projects in this monorepo.

## Assets

| File | Use |
|------|-----|
| [`cmdlab-wordmark.png`](cmdlab-wordmark.png) | Primary wordmark — white geometric logotype on deep navy |
| [`cmdlab-logo.png`](cmdlab-logo.png) | Same asset (alias for tools that expect a “logo” filename) |

**Source:** official CMDLAB wordmark (monoline / neon-outline style). Do not recolor, stretch, or add effects that change letter geometry.

## Usage guidelines

1. **Prefer the provided PNG** over recreations so the mark stays exact.
2. **Clear space** — leave padding around the wordmark roughly equal to the height of the “C” stroke.
3. **Background** — designed for dark surfaces (`#0a0a18` family). On light pages, keep the navy plate (the PNG includes its background) rather than knocking out to transparent white-on-white.
4. **Minimum size** — at least ~120px wide in UI; ~280–360px in README headers.
5. **Do not** place the mark over busy photos or recolor individual letters.

## In this monorepo

| Surface | How it’s applied |
|---------|------------------|
| Hub & tool READMEs | Relative path to `branding/cmdlab-wordmark.png` |
| GreenLake Worker (hosted) | `worker/public/branding/cmdlab-wordmark.png` |
| GreenLake local Flask | Served from repo `branding/` at `/branding/...` |
| ClearPass Endpoint Console | `../branding/cmdlab-wordmark.png` when opened from monorepo tree |
| NetWatch UI | Served at `/branding/cmdlab-wordmark.png` from monorepo branding dir |

## Credit line

Use **CMDLAB** as the public product brand and **cmdlabtech** for the GitHub organization URL:

```text
CMDLAB · https://github.com/cmdlabtech
```
