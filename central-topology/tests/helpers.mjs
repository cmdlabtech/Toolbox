// Runs the real Worker client + merge code against the fixtures, with a
// getter equivalent to src/mock.ts (kept independent of src/mock.ts so the two cross-check).
import { readFileSync } from "node:fs";
import { central, CentralError } from "../worker/src/central.ts";
import { mergeTenant } from "../worker/src/merge.ts";

const fx = (f) => JSON.parse(readFileSync(new URL(`../worker/fixtures/${f}`, import.meta.url)));
export const FIX = {
  sites: fx("sites-health.json"), topology: fx("topology.json"), detail: fx("switch-detail.json"),
  neighbours: fx("neighbours.json"), vlans: fx("vlans.json"), interfaces: fx("interfaces.json"),
  inventory: fx("device-inventory.json"),
};

export function fixtureGetter(calls = []) {
  return async (path) => {
    calls.push(path);
    let m;
    if (path === "/network-monitoring/v1/sites-health") return FIX.sites;
    if (path === "/network-monitoring/v1/device-inventory") return FIX.inventory;
    if ((m = path.match(/topology\/([^/]+)$/))) return FIX.topology[m[1]];
    if ((m = path.match(/neighbours\/([^/]+)$/))) return FIX.neighbours[m[1]];
    if ((m = path.match(/switches\/([^/]+)\/vlans$/))) return FIX.vlans[m[1]];
    if ((m = path.match(/switches\/([^/]+)\/interfaces$/))) return FIX.interfaces[m[1]];
    if ((m = path.match(/switches\/([^/]+)$/))) return FIX.detail[m[1]];
    throw new CentralError(`no fixture ${path}`, 404);
  };
}

const pool = async (xs, _n, f) => Promise.all(xs.map(f));

/** Same shape as GET /api/topology. */
export async function topologyFromFixtures(calls = []) {
  const c = central(fixtureGetter(calls));
  const warnings = [];
  const sites = await c.sites();
  const { switches, externals, links } = await mergeTenant(c, sites, pool, (w) => warnings.push(w));
  const out = [];
  for (const s of switches) {
    out.push({ ...s, vlans: (await c.vlans(s.serial)).filter((v) => v.ipv4),
      interfaces: (await c.interfaces(s.serial)).filter((i) => i.ipv4 && i.kind !== "other") });
  }
  return { mock: true, generatedAt: new Date().toISOString(), sites, switches: out, externals, links, warnings };
}
