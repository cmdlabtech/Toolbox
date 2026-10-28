// Pure data model: role inference, building grouping, management-IP choice.
// No DOM access, so tests/ can import it in Node.

export const ROLES = ["district-core", "building-core", "access"];
export const UNASSIGNED = "Unassigned";

/** Undirected switch-to-switch adjacency from merged topology links. */
export function adjacency(switches, links) {
  const ids = new Set(switches.map((s) => s.serial));
  const adj = new Map(switches.map((s) => [s.serial, new Set()]));
  for (const l of links) {
    if (ids.has(l.from) && ids.has(l.to) && l.from !== l.to) {
      adj.get(l.from).add(l.to);
      adj.get(l.to).add(l.from);
    }
  }
  return adj;
}

/** Highest switch-to-switch degree wins; ties go to the lower name. */
export function pickCore(switches, adj) {
  let best = null;
  for (const s of switches) {
    const d = adj.get(s.serial).size;
    if (!best || d > best.d || (d === best.d && s.name < best.s.name)) best = { s, d };
  }
  return best ? best.s.serial : null;
}

export function bfs(adj, root) {
  const hop = new Map([[root, 0]]);
  const parents = new Map([[root, []]]);
  const q = [root];
  while (q.length) {
    const x = q.shift();
    for (const y of adj.get(x) ?? []) {
      if (!hop.has(y)) { hop.set(y, hop.get(x) + 1); parents.set(y, [x]); q.push(y); }
      else if (hop.get(y) === hop.get(x) + 1) parents.get(y).push(x);
    }
  }
  return { hop, parents };
}

/**
 * Build the hub-and-spoke model.
 * data: /api/topology response. overrides: { coreSerial, switches: { serial: { building, role } } }
 */
export function buildModel(data, overrides = {}) {
  const switches = data.switches ?? [];
  const links = data.links ?? [];
  const ov = overrides.switches ?? {};
  const adj = adjacency(switches, links);
  const bySerial = new Map(switches.map((s) => [s.serial, s]));

  const forced = Object.entries(ov).find(([, o]) => o.role === "district-core")?.[0];
  let coreSerial = [overrides.coreSerial, forced].find((c) => c && bySerial.has(c)) ?? pickCore(switches, adj);
  const coreSource = coreSerial === overrides.coreSerial || coreSerial === forced ? "override" : "inferred";
  const { hop, parents } = coreSerial ? bfs(adj, coreSerial) : { hop: new Map(), parents: new Map() };

  // Building = override, else site assignment from topology.
  const nodes = switches.map((s) => {
    const o = ov[s.serial] ?? {};
    const building = o.building || s.site || UNASSIGNED;
    return {
      ...s,
      building,
      buildingSource: o.building ? "override" : s.site ? "site" : "none",
      group: typeof s.group === "string" && s.group.trim() ? s.group.trim() : null,
      hop: hop.get(s.serial) ?? null,
      degree: adj.get(s.serial).size,
      flags: [],
    };
  });
  const byId = new Map(nodes.map((n) => [n.serial, n]));
  const coreNode = byId.get(coreSerial);

  // Building core: the switch in each building closest to the district core
  // (ties: higher degree, then name). The district core's own building has
  // no separate hub; its switches hang off the district core directly.
  const groups = new Map();
  for (const n of nodes) groups.set(n.building, [...(groups.get(n.building) ?? []), n]);
  const hubs = new Map();
  for (const [b, members] of groups) {
    if (coreNode && b === coreNode.building) { hubs.set(b, coreSerial); continue; }
    const pinned = members.find((m) => ov[m.serial]?.role === "building-core");
    if (pinned) { hubs.set(b, pinned.serial); continue; }
    const cands = members.filter((m) => m.hop !== null && ov[m.serial]?.role !== "access")
      .sort((a, c) => a.hop - c.hop || c.degree - a.degree || a.name.localeCompare(c.name));
    if (cands[0]) hubs.set(b, cands[0].serial);
  }

  for (const n of nodes) {
    const o = ov[n.serial] ?? {};
    let role = n.serial === coreSerial ? "district-core" : hubs.get(n.building) === n.serial ? "building-core" : "access";
    if (o.role && ROLES.includes(o.role) && n.serial !== coreSerial && o.role !== "district-core") role = o.role;
    n.role = role;
    n.roleSource = o.role ? "override" : "inferred";

    // Ambiguity flags.
    if (n.buildingSource === "none") n.flags.push("no site assignment");
    if (n.siteSource === "ambiguous") n.flags.push("listed in several site topologies");
    if (n.hop === null && n.serial !== coreSerial) n.flags.push("no path to district core");
    const peerBuildings = new Set([...adj.get(n.serial)].map((p) => byId.get(p).building).filter((b) => b !== n.building));
    const up = parents.get(n.serial) ?? [];
    if (n.role === "access" && peerBuildings.size > 0) n.flags.push(`linked to ${[...peerBuildings].join(", ")}`);
    if (n.role === "access" && up.length > 1) n.flags.push("multi-homed");
  }

  // Tree parent for drawing: building core -> district core, access -> its
  // building core when adjacent, else the BFS parent in the same building.
  for (const n of nodes) {
    if (n.serial === coreSerial) { n.parent = null; continue; }
    const hub = hubs.get(n.building);
    const nb = adj.get(n.serial);
    if (n.role === "building-core") n.parent = nb.has(coreSerial) ? coreSerial : (parents.get(n.serial) ?? [])[0] ?? coreSerial;
    else if (hub && nb.has(hub)) n.parent = hub;
    else {
      const up = parents.get(n.serial) ?? [];
      n.parent = up.find((p) => byId.get(p).building === n.building) ?? up[0] ?? hub ?? coreSerial;
    }
    n.parentInferred = !nb.has(n.parent);
  }

  const buildings = [...groups.keys()].sort((a, b) =>
    (coreNode && a === coreNode.building ? -1 : 0) - (coreNode && b === coreNode.building ? -1 : 0) || a.localeCompare(b));
  const edges = links
    .filter((l) => byId.has(l.from) || byId.has(l.to))
    .map((l) => ({ ...l, external: !(byId.has(l.from) && byId.has(l.to)) }));
  return { nodes, byId, coreSerial, coreSource, buildings, hubs: Object.fromEntries(hubs), edges, externals: data.externals ?? [] };
}

/** Management-IP choices the data actually supports, with coverage counts. */
export function mgmtOptions(switches) {
  const opts = [];
  const count = (f) => switches.filter(f).length;
  const mon = count((s) => s.ipv4);
  if (mon) opts.push({ id: "monitor", label: "Monitoring IP (topology ipv4)", count: mon });
  const vlanIds = new Map();
  for (const s of switches) for (const v of s.vlans ?? []) if (v.ipv4) vlanIds.set(v.id, v.name);
  for (const [id, name] of [...vlanIds].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    opts.push({ id: `vlan:${id}`, label: `VLAN ${id}${name ? ` (${name})` : ""} SVI`, count: count((s) => (s.vlans ?? []).some((v) => v.id === id && v.ipv4)) });
  }
  for (const kind of ["oobm", "loopback"]) {
    const c = count((s) => (s.interfaces ?? []).some((i) => i.kind === kind && i.ipv4));
    if (c) opts.push({ id: kind, label: kind === "oobm" ? "OOBM port" : "Loopback", count: c });
  }
  return opts.map((o) => ({ ...o, total: switches.length }));
}

/** IP for one switch under the chosen option; falls back to the monitoring IP. */
export function resolveMgmt(sw, optionId) {
  let ip = null;
  if (optionId === "monitor") ip = sw.ipv4 ?? null;
  else if (optionId?.startsWith("vlan:")) ip = (sw.vlans ?? []).find((v) => v.id === optionId.slice(5))?.ipv4 ?? null;
  else if (optionId === "oobm" || optionId === "loopback") ip = (sw.interfaces ?? []).find((i) => i.kind === optionId && i.ipv4)?.ipv4 ?? null;
  if (ip) return { ip, fallback: false, source: optionId };
  if (sw.ipv4) return { ip: sw.ipv4, fallback: optionId !== "monitor", source: "monitor" };
  return { ip: null, fallback: true, source: null };
}

/** Validate an imported overrides file; throws on bad shape. */
export function parseOverrides(text) {
  const o = JSON.parse(text);
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("Overrides must be a JSON object.");
  const out = { coreSerial: typeof o.coreSerial === "string" ? o.coreSerial : null, switches: {} };
  for (const [serial, v] of Object.entries(o.switches ?? {})) {
    if (!v || typeof v !== "object") continue;
    const e = {};
    if (typeof v.building === "string" && v.building.trim()) e.building = v.building.trim();
    if (ROLES.includes(v.role)) e.role = v.role;
    if (Object.keys(e).length) out.switches[serial] = e;
  }
  const positions = parsePositionStore(o.positions);
  if (positions) out.positions = positions;
  return out;
}

/** Per-layout {x,y} maps. Unknown layout ids are kept. Invalid points are dropped. */
function parsePositionStore(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  for (const [layoutId, map] of Object.entries(raw)) {
    if (!/^[a-z0-9-]{1,40}$/.test(layoutId) || !map || typeof map !== "object" || Array.isArray(map)) continue;
    const m = {};
    for (const [serial, p] of Object.entries(map)) {
      if (!p || typeof p !== "object") continue;
      const x = Number(p.x), y = Number(p.y);
      if (Number.isFinite(x) && Number.isFinite(y)) m[serial] = { x: Math.round(x), y: Math.round(y) };
    }
    if (Object.keys(m).length) out[layoutId] = m;
  }
  return Object.keys(out).length ? out : null;
}
