# Iris `.isf` and catalog module format (as observed)

Intangi has not published this format. This is what files saved by Iris 6
look like, and what this tool relies on. Concrete values (ids, codes, flags,
header numbers) are deliberately not listed here: the tool reads them from
the user's own files at run time.

## Wrapper (both `.isf` projects and catalog `.mod` files)

```
<?xml version="1.0" encoding="UTF-8" ?>
<INTANGI_FILE_EX>
<FILE_TYPE>…</FILE_TYPE>
<FILE_VERSION>…</FILE_VERSION>
<FILE_DATE>YYYY-MM-DD:HH:MM:SS</FILE_DATE>
<APPLICATION>…</APPLICATION>
<APP_VERSION>…</APP_VERSION>
<USER_ORG>…</USER_ORG>
<USER>…</USER>
<zlib stream, compression level 6>
</INTANGI_FILE_EX>
```

- `USER_ORG` / `USER` identify the signed-in Iris account. Generated files set
  both to 0; the rest of the header is copied from the user's template.
- No extra checksum or signature was found beyond zlib's own Adler-32.
- Recompressing a saved payload at level 6 reproduced the saved file byte for
  byte in testing, and `roundtrip` checks this on any file.

## Payload

Almost-XML: one tag per line, no attributes, no self-closing tags, empty
leaves as `<NAME></NAME>`, empty containers as `<TAG>` / `</TAG>` on two
lines, and bare `&` left unescaped. `scripts/irisbom/xmlfmt.py` parses and
re-serializes it without changes.

Top-level `SYSTEM` sections: `DETAIL` (project metadata, country, dates),
`DESIGNS/DESIGN` (quote header, currency, price-list selection,
`DISPLAYGROUP`), `USERIMAGES`, `SITES/SITE` (one per site, with
`DESIGNSET/EQUIPMENTS`, optional `MISCPARTS`, and `WORKSPACES`), `PATHS`,
`MATERIALS`, `LAYERS`, `DESGRPS`, `ACTIVITYLOG`, `PLUGINDATAARRAY`.

## Equipment

Each configurable device is an `EQUIPMENT` with `PARTID` (from
`part/part_*.mod`), `PRODUCTID` + `MODELVERSION` (from `misc/prodlist_*.mod`,
or the product whose model picker lists the SKU), `PROPERTYS`, `PORTS`, and
`EQPARTS` (the device SKU plus its child SKUs). Loose parts are `MISCPART`
records.

Each `PROPERTY` has `PROPERTYID`, `LABEL`, `VALUE`, `CODE`, `PROPFLAGSCUR`.
For choice properties, `CODE` is the chosen option's `OPTIONID` in the
product model.

## Product models (`prod/prod<PRODUCTID>_<MODELVER>.mod`)

`PROPERTIES/PROPERTY` records carry `PROPERTYID`, `LABEL`, `PROPFLAGSDEF`,
`VALUEDEF`, `CODEDEF`, and `OPTIONS/OPTION` (`OPTIONID`, `LABEL`, `TOOLTIP`).
`SUBMODELS` reference other models (for example a power-cord model used once
per power-supply slot). A sub-model's properties appear in a project with
ids of the form `(instance << 16) | local id`. The tag names inside
`SUBMODELS` are read best-effort; if they can't be read the tool says so.

## How the generator fills properties

By label and option text only (see `scripts/irisbom/configure.py`):

- Model picker (`Select Model`, `Select Model_`, `Select_Model`): option whose
  text equals the SKU, the SKU without its `-<REGION>` suffix, or the line's
  `model_option`. Unused pickers are written empty.
- Regulatory domain (label contains "Regulatory Domain"): option whose text is
  exactly the region code.
- Power cords (`Power Cord Selection`, plus `Power Cord Quantity` and
  `Make Power Cords INCLUDED` in the same slot): the option mentioning the
  region; ties broken by plain-text preferences, then by Iris's own
  localization table for the country. Extra slots are included only when the
  BOM lists a power supply under the device.
- Quantity Multiplier: id and flags taken from the template's device.
- If the template contains the same product, the ids and flags Iris wrote
  there take priority over model defaults.
