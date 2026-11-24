---
name: iris-bom
description: Build Intangi Iris style BOM exports (normal xlsx, Juniper CSV) and, only when asked, an Iris project file (.isf) from a part list, using the Intangi Iris app and catalog installed on the user's own computer. Use when someone wants a BOM or Iris project generated for Iris. Requires a local Iris install; stops if Iris is not installed.
---

# iris-bom

Generates Iris-style BOM files from a part list by reading the Intangi Iris
catalog that is already installed on the user's own computer. The skill ships
no catalog data. Every part id, product id, configurator property, option
code, and country number is looked up at run time from the user's local Iris
cache.

Unofficial. Not affiliated with, endorsed by, or supported by Intangi or HPE.

## When to use

- The user asks for a BOM in Iris format, an Iris export, or a Juniper BOM CSV.
- The user asks for an Iris project file (`.isf`) built from a part list.
- Do not use it for pricing. Output is budgetary, and prices stay blank
  unless the user supplies them.

## Requirements

- Intangi Iris installed on this computer (macOS `/Applications/Iris.app`,
  bundle id `com.intangi.iris`, or a Windows install under an `Intangi`
  folder) and signed in at least once so its catalogs are downloaded.
- Python 3.9 or newer with `openpyxl` (`python3 -m pip install --user openpyxl`).
- No network access is used or needed.

## Step 1: preflight (always first)

```bash
python3 scripts/iris_bom.py preflight
```

If it exits non-zero, **stop**. Tell the user: "This needs Intangi Iris
installed and signed in on this computer, and it isn't. Install Iris, open it
once so it downloads the catalogs, then ask again." Do not try to work around
it, do not look for catalog data elsewhere, and do not fabricate part
numbers or ids. Every other command runs the same preflight and exits with
code 2 if it fails.

If Iris lives somewhere non-standard, pass `--iris-app PATH` and/or
`--iris-cache PATH` (before the command name). They are checked the same way.

## Step 2: write the spec

Make a JSON (or CSV) spec from what the user gave you. Use their part numbers
exactly; never invent SKUs.

```json
{
  "project": "Project name",
  "client": "Client name",
  "vendor": "juniper",
  "region": "US",
  "sites": [
    {"name": "Site 1", "lines": [
      {"sku": "<SWITCH-SKU>", "qty": 2},
      {"sku": "<PSU-SKU>", "qty": 2, "parent": "<SWITCH-SKU>"},
      {"sku": "<AP-SKU>", "qty": 4},
      {"sku": "<SUBSCRIPTION-SKU>", "qty": 4, "parent": "<AP-SKU>"},
      {"sku": "<OPTIC-SKU>", "qty": 2}
    ]}
  ]
}
```

Line fields: `sku`, `qty` (required); `description`, `parent` (SKU of the
line it belongs under), `unit_price`, `included`, `standalone`, `duration`
(months) are optional. For `.isf` troubleshooting only: `model_option` (exact
option text of the model picker in Iris), `family_sku` (a SKU from the same
product family that Iris lists), `iris_sku` (the number Iris uses if the
user's differs), `power_cord` (exact power cord option text).

CSV specs need a header row: `site, sku (or Part Number), qty, description,
parent (or Parent SKU), unit_price, ...`.

## Step 3: check the parts resolve (optional but recommended)

```bash
python3 scripts/iris_bom.py lookup SKU1 SKU2 ...
```

The first run builds a private index of the user's own catalog in
`~/.iris-bom/` (override with `IRIS_BOM_HOME`). That index stays on the
computer: never commit, upload, paste, or share it or its contents.

## Step 4: build

```bash
# Exports only (default): normal xlsx, plus Juniper CSV when vendor is juniper
python3 scripts/iris_bom.py build --spec spec.json --out ./bom-output

# Put files in an existing per-client folder layout (matches existing names)
python3 scripts/iris_bom.py build --spec spec.json --client "Client" --client-root "~/Clients"

# Also an .isf, only when the user asks for one
python3 scripts/iris_bom.py build --spec spec.json --out ./bom-output --isf --template ~/iris-template.isf
```

- `.isf` is opt-in. Only add `--isf` when the user asks for an Iris file.
- `--template` is a project the user saved in their own Iris: a new project
  with one site, one configurable device placed, and (if the BOM has loose
  parts such as optics) one loose part. No customer details. The generated
  file copies that template's settings and record layout and zeroes account
  ids.
- `--region` (default `US`) sets the AP regulatory domain option and the
  power cord option by text, and the project country from Iris's own
  localization table. Use `--country "Name"` if the region code isn't known.
- If a line can't be resolved exactly (missing part, no matching model
  option, ambiguous power cord), that line is reported as an error and the
  `.isf` is not written (exit code 3). Fix the spec (for example set
  `model_option` or `power_cord`) or pass `--allow-partial` only if the user
  accepts a partial file. Use `inspect SKU --filter "select|cord|domain"` to
  see the option texts from the user's own model.
- Existing files are never overwritten; a numbered copy is written instead.

## Step 5: report back

Tell the user which files were written and repeat any `note:` / `error:`
lines. For an `.isf`, ask them to open it in Iris, save it under a new name,
and check each device's model, regulatory domain, and power cords.

## Limits and disclaimers

- Unofficial tool. Not affiliated with, endorsed by, or supported by Intangi
  or HPE. The `.isf` layout was inferred from files the author's own Iris
  saved; Intangi has not published it and may change it.
- Generated projects are simplified: they set quantities, model pickers,
  regulatory domain, and power cords, but not the full configurator sheet,
  ports, or add-ons. Iris may fill the rest when the file is opened.
- Output is budgetary. This tool never reads Iris price lists, account files
  (`user.mod`, `deploy/`), or saved projects in the cache, and never contacts
  Intangi or any other server.
- The user is responsible for complying with their own Iris license and
  vendor catalog terms, including any confidentiality terms. Keep generated
  indexes and outputs private where those terms require it.
