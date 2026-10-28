// Merge per-site topology into one tenant graph.
import { isSwitch, type Central, type Site, type TopoDevice, type TopoLink } from "./central.ts";

export interface MergedSwitch extends TopoDevice {
  siteId: string | null;
  site: string | null;
  siteSource: string;
  group: string | null;
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
  const groupTask = c.deviceGroups().then(
    (rows) => rows,
    (e) => { warn(`Device groups unavailable (${(e as Error).message})`); return [] as { serial: string; group: string | null }[]; },
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

  // Home site: the only site listing it, else ask the switch detail endpoint.
  const switches: MergedSwitch[] = [];
  const multi = [...devices.values()].filter((d) => isSwitch(d) && (seenIn.get(d.serial)?.length ?? 0) > 1);
  const detail = new Map<string, { siteId: string | null; siteName: string | null }>();
  await pool(multi, 4, async (d) => {
    try { detail.set(d.serial, await c.switchSite(d.serial)); }
    catch (e) { warn(`${d.name}: switch detail unavailable (${(e as Error).message})`); }
  });
  for (const d of devices.values()) {
    if (!isSwitch(d)) continue;
    const seen = seenIn.get(d.serial) ?? [];
    const det = detail.get(d.serial);
    if (seen.length === 1) switches.push({ ...d, siteId: seen[0].id, site: seen[0].name, siteSource: "topology", group: null });
    else if (det?.siteName) switches.push({ ...d, siteId: det.siteId, site: det.siteName, siteSource: "switch-detail", group: null });
    else switches.push({ ...d, siteId: seen[0]?.id ?? null, site: seen[0]?.name ?? null, siteSource: "ambiguous", group: null });
  }

  const groupBySerial = new Map<string, string | null>();
  for (const row of await groupTask) {
    const prev = groupBySerial.get(row.serial);
    if (prev === undefined || (prev === null && row.group)) groupBySerial.set(row.serial, row.group);
  }
  for (const sw of switches) sw.group = groupBySerial.get(sw.serial) ?? null;

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
