# iris-bom (agent skill)

Generate Intangi Iris style BOM exports, and on request an Iris project file
(`.isf`), from a part list, using the Iris app and catalog installed on your
own computer.

Unofficial. Not affiliated with, endorsed by, or supported by Intangi or HPE.

## What it is

A self-contained skill folder that any agent which reads `SKILL.md` folders
can use (Claude Code, Codex, Cursor, Grok Bot, and others), and that a person
can run directly from a terminal. Python 3.9+ standard library plus
`openpyxl`. No network access.

It contains **no Intangi catalog data**: no part or product ids, property
ids, option codes, flags, price lists, or catalog excerpts. All of that is
read at run time from your own Iris cache and kept in a private index under
`~/.iris-bom/`. If Iris is not installed, it refuses to run.

## Install

Copy this folder into your agent's skills directory (for example
`~/.claude/skills/iris-bom`, `.cursor/skills/iris-bom`, or wherever your agent
loads skills from), or keep it anywhere and run it by path.

```bash
python3 -m pip install --user openpyxl
python3 scripts/iris_bom.py preflight
```

## Use

```bash
python3 scripts/iris_bom.py lookup EX-SKU-1 AP-SKU-2        # check parts resolve
python3 scripts/iris_bom.py build --spec spec.json --out ./bom-output
python3 scripts/iris_bom.py build --spec spec.json --out ./bom-output \
    --isf --template ~/iris-template.isf                     # .isf only on request
python3 scripts/iris_bom.py inspect SKU --filter "select|cord|domain"
```

See `SKILL.md` for the spec format, the template project, region options,
and how failures are reported. `examples/example-spec.json` shows the shape
with placeholder SKUs.

| Command | Does |
|---|---|
| `preflight` | Verifies the Iris app (macOS bundle id `com.intangi.iris`, or a Windows install) and its local catalog cache |
| `index [--rebuild]` | Builds the private local index from your cache |
| `lookup SKU...` | Shows whether each SKU is in your catalog and configurable |
| `inspect SKU` | Lists a product model's property labels and option texts |
| `build` | Writes the xlsx (always), Juniper CSV (vendor juniper), `.isf` (`--isf`) |
| `decode` / `encode` / `roundtrip` | Low-level `.isf` utilities |

Exit codes: 0 ok, 2 Iris not installed, 3 some `.isf` lines failed (no
`.isf` written), 4 usage or template problem.

## What it reads and never reads

Reads, from your Iris cache: `misc/prodlist_*.mod`, `part/part_*.mod`,
`manu_*.mod`, `look_*.mod`, and `prod/prod*_*.mod`. Plus the template `.isf`
you pass in.

Never reads: `user.mod`, anything under `deploy/` or `systems/`, or any
`plist*.mod` price list. Generated `.isf` files have account ids set to 0.

## Tests

```bash
python3 -m unittest discover -s tests -v
```

Unit tests build fake catalogs and projects at test time (all values are
made up and labeled fake). The real-catalog test runs only when Iris is
installed on the machine running the tests. Set `IRIS_BOM_IT_SKUS=SKU1,SKU2`
to also check specific SKUs resolve.

## Disclaimers

- Budgetary only. Prices are blank unless you supply them.
- The `.isf` layout is inferred, not published by Intangi, and may change.
  Generated projects are simplified; open them in Iris and check them.
- You are responsible for your own Iris license and vendor catalog terms,
  including confidentiality. Don't share the index or outputs where those
  terms forbid it.

## License

MIT, under the repository's [LICENSE](../LICENSE).
