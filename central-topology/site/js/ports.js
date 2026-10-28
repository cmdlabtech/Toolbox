// Port labels for switch-to-switch links. Pure: no DOM, so tests import it.

export const PORT_FONT = 10;
export const PORT_MIN_PX = 10;
export const PORTS_KEY = "ct-ports";

/** On unless the caller turns it off. Hidden when screen size would fall under ~10px. */
export function portsVisible(opts = {}) {
  if (opts.showPorts === false) return false;
  const scale = Number.isFinite(opts.portScale) ? opts.portScale : 1;
  return PORT_FONT * scale + 1e-6 >= PORT_MIN_PX;
}

/** Missing key stays on. `false` stays off. */
export function readShowPorts(storage) {
  try {
    const raw = storage.getItem(PORTS_KEY);
    if (raw == null || raw === "") return true;
    return JSON.parse(raw) !== false;
  } catch {
    return true;
  }
}

export function writeShowPorts(storage, on) {
  storage.setItem(PORTS_KEY, JSON.stringify(on !== false));
}

function normPort(p) {
  if (typeof p === "string") {
    const name = p.trim();
    return name ? { name, lag: null } : null;
  }
  if (!p || typeof p !== "object") return null;
  const name = String(p.name ?? "").trim();
  if (!name) return null;
  const lag = typeof p.lag === "string" && p.lag.trim() ? p.lag.trim() : null;
  return { name, lag };
}

/** Collapse 1/1/49, 1/1/50 into 1/1/49-50. Gaps stay listed. */
export function compactPortNames(names) {
  const unique = [];
  for (const n of names) if (n && !unique.includes(n)) unique.push(n);
  if (!unique.length) return "";
  const raw = [];
  const nums = [];
  for (const name of unique) {
    const m = /^(.*?)(\d+)$/.exec(name);
    if (!m || m[1] === undefined) raw.push(name);
    else nums.push({ name, prefix: m[1], n: Number(m[2]) });
  }
  nums.sort((a, b) => (a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : a.n - b.n));
  const ranges = [];
  for (const p of nums) {
    const last = ranges[ranges.length - 1];
    if (last && last.prefix === p.prefix && p.n === last.end + 1) last.end = p.n;
    else ranges.push({ prefix: p.prefix, start: p.n, end: p.n });
  }
  const parts = ranges.map((r) => (r.start === r.end ? `${r.prefix}${r.start}` : `${r.prefix}${r.start}-${r.end}`));
  return [...parts, ...raw].join(", ");
}

/**
 * One end of a link. A shared LAG name wraps the member ports:
 * lag1 (1/1/49-50). A single interface is just its name.
 * `fallback` is the first-port string when no port list was stored.
 */
export function formatPortEnd(ports, fallback = null) {
  const list = [];
  if (Array.isArray(ports)) {
    for (const p of ports) {
      const n = normPort(p);
      if (n) list.push(n);
    }
  }
  if (!list.length) {
    const fb = typeof fallback === "string" ? fallback.trim() : "";
    return fb || null;
  }
  const byLag = new Map();
  const bare = [];
  for (const p of list) {
    if (p.lag) {
      const arr = byLag.get(p.lag) ?? [];
      arr.push(p.name);
      byLag.set(p.lag, arr);
    } else bare.push(p.name);
  }
  const parts = [];
  for (const [lag, names] of byLag) {
    const members = names.filter((n) => n.toLowerCase() !== lag.toLowerCase());
    const shown = members.length ? members : names;
    const compact = compactPortNames(shown);
    parts.push(members.length ? `${lag} (${compact})` : lag);
  }
  const bareText = compactPortNames(bare);
  if (bareText) parts.push(bareText);
  return parts.join(", ") || null;
}
