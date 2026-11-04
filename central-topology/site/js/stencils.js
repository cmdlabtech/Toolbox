// Stencil registry: maps a switch to a faceplate image, or null for the plain
// box. Entries come from the user's own import on their device (never from a
// server and never committed: the HPE stencil licence bars redistribution).
// Entry: { match: "6300m 48g", sku: "JL661A", href: "data:image/svg+xml,…", u: 1, aspect: 10.86 }
// Lookup order (LAYOUT-SPEC §10): exact model key, part number, longest
// prefix, family (series before the first space or dash, only when it starts
// with a digit: 8360, 6300m, 6100), then null for the fallback box.

export function modelKey(model) {
  return String(model ?? "").toLowerCase().replace(/\b(aruba|hpe|switch)\b/g, " ").replace(/\s+/g, " ").trim();
}

export function createRegistry(entries = []) {
  const list = entries.map((e) => ({ ...e, match: modelKey(e.match) })).filter((e) => e.match || e.sku);
  const bySku = new Map(list.filter((e) => e.sku).map((e) => [e.sku.toUpperCase(), e]));
  return {
    size: list.length,
    lookup(model, sku) {
      const k = modelKey(model);
      if (k) { const exact = list.find((e) => e.match === k); if (exact) return { ...exact, how: "model" }; }
      if (sku && bySku.has(String(sku).toUpperCase())) return { ...bySku.get(String(sku).toUpperCase()), how: "part number" };
      if (!k) return null;
      const pre = list.filter((e) => e.match && k.startsWith(e.match)).sort((a, b) => b.match.length - a.match.length)[0];
      if (pre) return { ...pre, how: "prefix" };
      const family = (m) => /^\d[^\s-]*/.exec(m)?.[0] ?? "";
      const fam = family(k);
      if (!fam) return null;
      const f = list.filter((e) => e.match && family(e.match) === fam).sort((a, b) => a.match.localeCompare(b.match))[0];
      return f ? { ...f, how: "family" } : null;
    },
  };
}

export const EMPTY_REGISTRY = createRegistry([]);
