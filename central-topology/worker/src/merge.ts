// Merge per-site topology into one tenant graph.
import { isSwitch, type Central, type NeighbourLink, type Site, type StackMember, type SwitchDetail, type TopoDevice, type TopoLink } from "./central.ts";

export interface MergedSwitch extends TopoDevice {
  siteId: string | null;
  site: string | null;
  siteSource: string;
  group: string | null;
  central: boolean;
  jNumber: string | null;        // part number, for stencil matching
  stackMemberId: number | null;  // member number inside a stack
}

function blank(v: string | null | undefined) {
  return v == null || v.trim() === "";
}

/**
 * True for a switch Central manages. Unmanaged LLDP cards (`tpd_` / `mac:`
 * serials, or a device missing from a successful inventory that has no model
 * and no device function, or a serial-shaped name and no device function)
 * are false. `hardware` lists the serials behind a stack id. A failed or
 * empty inventory does not mark managed switches false.
 */
export function isCentralSwitch(
  sw: { serial: string; name: string; model: string | null; deviceFunction: string | null },
  inventory: Set<string> | null,
  hardware: (string | null | undefined)[] = [],
): boolean {
  if (/^(tpd_|mac:)/i.test(sw.serial)) return false;
  // A stack id is not in the inventory; its member hardware is.
  if (inventory?.has(sw.serial) || hardware.some((h) => h && inventory?.has(h))) return true;
  if (inventory && !inventory.has(sw.serial)) {
    const name = (sw.name ?? "").trim();
    const serialLike = name.length >= 8 && (name.toUpperCase() === sw.serial.toUpperCase() || /^[A-Z0-9]+$/.test(name));
    if (blank(sw.model) && blank(sw.deviceFunction)) return false;
    if (serialLike && blank(sw.deviceFunction)) return false;
  }
  return true;
}

// A stack shows up in topology under its stack id (a UUID), not a hardware
// serial. LLDP and other sites name the member hardware instead.
export const STACK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "mac:" + 12 lowercase hex digits from a MAC, `tpd_<mac>` or `mac:<mac>`; else null. */
export function macKey(v: string | null | undefined): string | null {
  const hex = String(v ?? "").trim().replace(/^(tpd_|mac:)/i, "").replace(/[^0-9a-f]/gi, "").toLowerCase();
  return hex.length === 12 ? `mac:${hex}` : null;
}

/**
 * Maps any identifier a neighbour row or another site's link can use for a
 * switch (its own serial, a stack member serial, the hardware serial behind a
 * stack id, a MAC, a unique name) to the serial the graph uses for it.
 */
export function aliasIndex(
  switches: { serial: string; name: string; mac?: string | null }[],
  extra: { id: string | null | undefined; serial: string }[] = [],
) {
  const ids = new Map<string, string>();
  const macs = new Map<string, string>();
  const names = new Map<string, string | null>();
  const add = (id: string | null | undefined, serial: string) => {
    if (!id || !id.trim()) return;
    const k = id.trim().toUpperCase();
    if (!ids.has(k)) ids.set(k, serial);
    const mk = macKey(id);
    if (mk && !macs.has(mk)) macs.set(mk, serial);
  };
  for (const s of switches) ids.set(s.serial.toUpperCase(), s.serial);
  for (const s of switches) {
    const mk = macKey(s.mac);
    if (mk && !macs.has(mk)) macs.set(mk, s.serial);
    const n = s.name?.trim().toUpperCase();
    if (n) names.set(n, names.has(n) && names.get(n) !== s.serial ? null : s.serial);
  }
  for (const e of extra) add(e.id, e.serial);
  return (id: string | null | undefined, name?: string | null): string | null => {
    if (id) {
      const hit = ids.get(id.trim().toUpperCase()) ?? macs.get(macKey(id) ?? "");
      if (hit) return hit;
    }
    const n = name?.trim().toUpperCase();
    return (n && names.get(n)) || null;
  };
}

/** One LLDP row as the browser-side link check export shows it. No IPs. */
export interface LldpRow {
  queried: string; localMember: string | null; localPort: string | null;
  neighbourSerial: string; neighbourName: string | null; remotePort: string | null;
  matched: string | null;
}

const LLDP_BUDGET = 80;

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
    (e) => { inventoryFailed = true; warn(`Device groups unavailable (${(e as Error).message})`); return [] as { serial: string; group: string | null }[]; },
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
    const extra = { group: null, central: true, jNumber: det?.jNumber ?? null, stackMemberId: det?.stackMemberId ?? null };
    if (seen.length === 1) switches.push({ ...d, ...extra, siteId: seen[0].id, site: seen[0].name, siteSource: "topology" });
    else if (det?.siteName) switches.push({ ...d, ...extra, siteId: det.siteId, site: det.siteName, siteSource: "switch-detail" });
    else switches.push({ ...d, ...extra, siteId: seen[0]?.id ?? null, site: seen[0]?.name ?? null, siteSource: "ambiguous" });
  }

  // Stack ids: read the member hardware so LLDP rows that name a member, and
  // other sites' links to a member, land on the stack.
  const members = new Map<string, StackMember[]>();
  await pool(all.filter((d) => STACK_ID_RE.test(d.serial)), 4, async (d) => {
    try { members.set(d.serial, await c.stackMembers(d.serial)); }
    catch (e) { warn(`${d.name}: stack members unavailable (${(e as Error).message})`); }
  });
  const aliasRows: { id: string | null; serial: string }[] = [];
  for (const d of all) {
    const det = detail.get(d.serial);
    aliasRows.push({ id: det?.serialNumber ?? null, serial: d.serial }, { id: det?.macAddress ?? null, serial: d.serial });
    for (const m of members.get(d.serial) ?? []) aliasRows.push({ id: m.serial, serial: d.serial }, { id: m.mac, serial: d.serial });
  }
  const resolve = aliasIndex(all, aliasRows);

  // Topology links whose end is a member serial or MAC of a known switch
  // (a cross-site uplink, say) are re-pointed at that switch.
  for (const [k, l] of [...links]) {
    if (devices.has(l.from) && devices.has(l.to)) continue;
    const from = devices.has(l.from) ? l.from : resolve(l.from) ?? l.from;
    const to = devices.has(l.to) ? l.to : resolve(l.to) ?? l.to;
    if (from === l.from && to === l.to) continue;
    links.delete(k);
    if (from === to) continue;
    const nk = key(from, to);
    const moved = { ...l, from, to };
    const prev = links.get(nk);
    links.set(nk, prev ? keepRicher(prev, moved) : moved);
  }

  const groupRows = await groupTask;
  const groupBySerial = new Map<string, string | null>();
  for (const row of groupRows) {
    const prev = groupBySerial.get(row.serial);
    if (prev === undefined || (prev === null && row.group)) groupBySerial.set(row.serial, row.group);
  }
  for (const sw of switches) sw.group = groupBySerial.get(sw.serial) ?? null;

  // LLDP fill-in when the switch graph is in pieces. The district core is
  // picked in the browser, so the biggest piece is not assumed to hold it:
  // smaller pieces are asked first, then the biggest, within LLDP_BUDGET.
  // Each row's neighbour is matched by serial, member serial, MAC, then
  // unique name.
  const sw = new Set(switches.map((s) => s.serial));
  const nameOf = new Map(switches.map((s) => [s.serial, s.name]));
  const comp = components(sw, [...links.values()]);
  const lldpRows: LldpRow[] = [];
  if (comp.length > 1) {
    const order = [...comp.slice(1).flat(), ...comp[0]];
    const stray = order.slice(0, LLDP_BUDGET);
    if (order.length > stray.length) warn(`LLDP check covered ${stray.length} of ${order.length} switches.`);
    const extra = await pool(stray, 4, async (serial) => {
      let rows: NeighbourLink[] = [];
      try { rows = await c.neighbours(serial); }
      catch (e) { warn(`${nameOf.get(serial) ?? serial}: LLDP neighbors unavailable (${(e as Error).message})`); }
      // A stack id may answer with nothing; ask each member instead.
      if (rows.length === 0) {
        for (const m of members.get(serial) ?? []) {
          try { rows.push(...(await c.neighbours(m.serial)).map((r) => ({ ...r, from: serial, localMember: r.localMember ?? m.serial }))); }
          catch { /* the stack id call already warned or answered empty */ }
        }
      }
      return rows;
    });
    for (const raw of extra.flat()) {
      const to = resolve(raw.to, raw.peerName);
      lldpRows.push({
        queried: raw.from, localMember: raw.localMember, localPort: raw.fromPort,
        neighbourSerial: raw.to, neighbourName: raw.peerName, remotePort: raw.toPort, matched: to,
      });
      if (!to || to === raw.from || !sw.has(to)) continue;
      const { peerName: _n, localMember: _m, ...plain } = raw;
      const l: TopoLink = { ...plain, to };
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
  for (const sw of switches) {
    const hw = [detail.get(sw.serial)?.serialNumber, ...(members.get(sw.serial) ?? []).map((m) => m.serial)];
    sw.central = isCentralSwitch(sw, inventory, hw);
  }

  const externals = [...devices.values()].filter((d) => !isSwitch(d));
  return { switches, externals, links: [...links.values()], lldpRows };
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
