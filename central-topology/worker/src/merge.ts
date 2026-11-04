// Merge per-site topology into one tenant graph.
import { isSwitch, type Central, type InventoryRow, type Site, type SwitchDetail, type TopoDevice, type TopoLink } from "./central.ts";

export interface MergedSwitch extends TopoDevice {
  siteId: string | null;
  site: string | null;
  siteSource: string;
  group: string | null;
  central: boolean;
  jNumber: string | null;        // part number, for stencil matching
  stackMemberId: number | null;  // member number inside a stack
  nameFrom: "topology" | "switch-detail" | "inventory";
}

/**
 * A name that is only an identifier: blank, a stack UUID, or a serial the
 * tenant knows (this switch's ids, or any serial in inventory, switch detail
 * or topology), optionally with a short "G-" style prefix. A hostname that
 * merely looks like a serial is kept.
 */
export function serialLikeName(name: string | null | undefined, ids: (string | null | undefined)[] = [], known?: Set<string>): boolean {
  const n = (name ?? "").trim();
  if (!n) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(n)) return true;
  const up = n.toUpperCase();
  const hit = (v: string) => ids.some((id) => id && id.trim().toUpperCase() === v) || !!known?.has(v);
  return hit(up) || hit(up.replace(/^[A-Z]{1,2}-/, ""));
}

/** First candidate that is a real name; else the topology name unchanged. */
export function pickName(
  topologyName: string,
  ids: (string | null | undefined)[],
  candidates: [MergedSwitch["nameFrom"], string | null | undefined][],
  known?: Set<string>,
): { name: string; nameFrom: MergedSwitch["nameFrom"] } {
  if (!serialLikeName(topologyName, ids, known)) return { name: topologyName, nameFrom: "topology" };
  for (const [from, v] of candidates) {
    const t = (v ?? "").trim();
    if (t && !serialLikeName(t, ids, known)) return { name: t, nameFrom: from };
  }
  return { name: topologyName, nameFrom: "topology" };
}

function blank(v: string | null | undefined) {
  return v == null || v.trim() === "";
}

/**
 * True for a switch Central manages. Unmanaged LLDP cards (`tpd_` / `mac:`
 * serials, or a device missing from a successful inventory that has no model
 * and no device function, or a serial-shaped name and no device function)
 * are false. A failed or empty inventory does not mark managed switches false.
 */
export function isCentralSwitch(
  sw: { serial: string; name: string; model: string | null; deviceFunction: string | null },
  inventory: Set<string> | null,
): boolean {
  if (/^(tpd_|mac:)/i.test(sw.serial)) return false;
  if (inventory?.has(sw.serial)) return true;
  if (inventory && !inventory.has(sw.serial)) {
    const name = (sw.name ?? "").trim();
    const serialLike = name.length >= 8 && (name.toUpperCase() === sw.serial.toUpperCase() || /^[A-Z0-9]+$/.test(name));
    if (blank(sw.model) && blank(sw.deviceFunction)) return false;
    if (serialLike && blank(sw.deviceFunction)) return false;
  }
  return true;
}

const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function portCount(l: TopoLink) {
  return (l.fromPorts?.length ?? 0) + (l.toPorts?.length ?? 0);
}

// Same undirected pair, ports lined up with `base`'s from/to.
function orientTo(base: TopoLink, l: TopoLink): TopoLink {
  if (l.from === base.from && l.to === base.to) return l;
  if (l.from === base.to && l.to === base.from) {
    return {
      ...l, from: base.from, to: base.to,
      fromPort: l.toPort, toPort: l.fromPort,
      fromPorts: l.toPorts ?? [], toPorts: l.fromPorts ?? [],
    };
  }
  return l;
}

function keepRicher(prev: TopoLink, next: TopoLink): TopoLink {
  const o = orientTo(prev, next);
  if (portCount(o) <= portCount(prev)) return prev;
  return {
    ...prev,
    fromPort: o.fromPort, toPort: o.toPort,
    fromPorts: o.fromPorts ?? [], toPorts: o.toPorts ?? [],
    speedGbps: prev.speedGbps ?? o.speedGbps,
  };
}

export async function mergeTenant(c: Central, sites: Site[], pool: <T, R>(xs: T[], n: number, f: (x: T) => Promise<R>) => Promise<R[]>, warn: (m: string) => void) {
  let inventoryFailed = false;
  const groupTask = c.deviceGroups().then(
    (rows) => rows,
    (e) => { inventoryFailed = true; warn(`Device groups unavailable (${(e as Error).message})`); return [] as InventoryRow[]; },
  );
  const perSite = await pool(sites, 4, async (s) => {
    try { return { site: s, ...(await c.topology(s.id)) }; }
    catch (e) { warn(`Site ${s.name}: topology unavailable (${(e as Error).message})`); return { site: s, devices: [], links: [] }; }
  });

  const devices = new Map<string, TopoDevice>();
  const seenIn = new Map<string, Site[]>();
  const links = new Map<string, TopoLink>();
  for (const { site, devices: ds, links: ls } of perSite) {
    for (const d of ds) {
      if (!devices.has(d.serial)) devices.set(d.serial, d);
      seenIn.set(d.serial, [...(seenIn.get(d.serial) ?? []), site]);
    }
    for (const l of ls) {
      if (l.from === l.to) continue;
      const k = key(l.from, l.to);
      const prev = links.get(k);
      links.set(k, prev ? keepRicher(prev, l) : l);
    }
  }

  // Switch detail for every switch: part number and stack member id, and the
  // home site when more than one site lists the switch.
  const switches: MergedSwitch[] = [];
  const all = [...devices.values()].filter(isSwitch);
  const detail = new Map<string, SwitchDetail>();
  const missing: string[] = [];
  await pool(all, 4, async (d) => {
    try { detail.set(d.serial, await c.switchDetail(d.serial)); }
    catch (e) {
      if ((seenIn.get(d.serial)?.length ?? 0) > 1) warn(`${d.name}: switch detail unavailable (${(e as Error).message})`);
      else missing.push(d.name);
    }
  });
  if (missing.length) warn(`Part numbers unavailable for ${missing.length} switch(es): ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""}`);
  for (const d of all) {
    const seen = seenIn.get(d.serial) ?? [];
    const det = detail.get(d.serial);
    const extra = { group: null, central: true, jNumber: det?.jNumber ?? null, stackMemberId: det?.stackMemberId ?? null, nameFrom: "topology" as const };
    if (seen.length === 1) switches.push({ ...d, ...extra, siteId: seen[0].id, site: seen[0].name, siteSource: "topology" });
    else if (det?.siteName) switches.push({ ...d, ...extra, siteId: det.siteId, site: det.siteName, siteSource: "switch-detail" });
    else switches.push({ ...d, ...extra, siteId: seen[0]?.id ?? null, site: seen[0]?.name ?? null, siteSource: "ambiguous" });
  }

  const groupRows = await groupTask;
  const groupBySerial = new Map<string, string | null>();
  for (const row of groupRows) {
    const prev = groupBySerial.get(row.serial);
    if (prev === undefined || (prev === null && row.group)) groupBySerial.set(row.serial, row.group);
  }
  for (const sw of switches) sw.group = groupBySerial.get(sw.serial) ?? null;

  // Some switches come back from topology named by a serial or stack id.
  // Prefer switch detail deviceName, then the inventory deviceName for the
  // serial (or for a member whose stackId is this switch's id). Unverified
  // which of these is set on a live tenant; the topology name stays when
  // none is a real name.
  const invName = new Map<string, string>();
  const known = new Set<string>();
  for (const id of [...devices.keys(), ...groupRows.map((r) => r.serial), ...[...detail.values()].map((d) => d.serialNumber)]) if (id) known.add(id.toUpperCase());
  for (const row of groupRows) {
    if (!row.name) continue;
    if (!invName.has(row.serial.toUpperCase())) invName.set(row.serial.toUpperCase(), row.name);
    if (row.stackId && !invName.has(row.stackId.toUpperCase())) invName.set(row.stackId.toUpperCase(), row.name);
  }
  for (const sw of switches) {
    const det = detail.get(sw.serial);
    const ids = [sw.serial, det?.serialNumber, sw.conductorSerial];
    const picked = pickName(sw.name, ids, [
      ["switch-detail", det?.deviceName],
      ["inventory", invName.get(sw.serial.toUpperCase())],
      ["inventory", det?.serialNumber ? invName.get(det.serialNumber.toUpperCase()) : null],
    ], known);
    sw.name = picked.name;
    sw.nameFrom = picked.nameFrom;
  }

  // LLDP fill-in: switches cut off from the biggest switch component.
  const sw = new Set(switches.map((s) => s.serial));
  const comp = components(sw, [...links.values()]);
  if (comp.length > 1) {
    const stray = comp.slice(1).flat().slice(0, 25);
    const extra = await pool(stray, 4, async (serial) => {
      try { return await c.neighbours(serial); }
      catch (e) { warn(`${serial}: LLDP neighbors unavailable (${(e as Error).message})`); return []; }
    });
    for (const l of extra.flat()) {
      if (!sw.has(l.to)) continue;
      const k = key(l.from, l.to);
      const prev = links.get(k);
      // Topology already carries lag member lists. LLDP only fills a missing link.
      if (!prev) links.set(k, l);
      else if (prev.source !== "topology" || portCount(prev) === 0) links.set(k, keepRicher(prev, l));
    }
  }

  const inventory = inventoryFailed || groupRows.length === 0
    ? null
    : new Set(groupRows.map((r) => r.serial));
  for (const sw of switches) sw.central = isCentralSwitch(sw, inventory);

  const externals = [...devices.values()].filter((d) => !isSwitch(d));
  return { switches, externals, links: [...links.values()] };
}

// Connected components over switch-to-switch links, largest first.
export function components(nodes: Set<string>, links: TopoLink[]): string[][] {
  const adj = new Map<string, string[]>([...nodes].map((n) => [n, []]));
  for (const l of links) if (nodes.has(l.from) && nodes.has(l.to)) { adj.get(l.from)!.push(l.to); adj.get(l.to)!.push(l.from); }
  const seen = new Set<string>(); const out: string[][] = [];
  for (const n of nodes) {
    if (seen.has(n)) continue;
    const c: string[] = []; const q = [n]; seen.add(n);
    while (q.length) { const x = q.shift()!; c.push(x); for (const y of adj.get(x)!) if (!seen.has(y)) { seen.add(y); q.push(y); } }
    out.push(c);
  }
  return out.sort((a, b) => b.length - a.length);
}
