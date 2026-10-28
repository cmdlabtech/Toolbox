// Mock mode: answers the same New Central paths from synthetic fixtures, so
// the real client and merge code runs end to end with no network.
import sitesHealth from "../fixtures/sites-health.json" with { type: "json" };
import topology from "../fixtures/topology.json" with { type: "json" };
import switchDetail from "../fixtures/switch-detail.json" with { type: "json" };
import neighbours from "../fixtures/neighbours.json" with { type: "json" };
import vlans from "../fixtures/vlans.json" with { type: "json" };
import interfaces from "../fixtures/interfaces.json" with { type: "json" };
import deviceInventory from "../fixtures/device-inventory.json" with { type: "json" };
import { CentralError, type GetJson } from "./central.ts";

const routes: [RegExp, Record<string, unknown>][] = [
  [/^\/network-monitoring\/v1\/topology\/([^/]+)$/, topology],
  [/^\/network-monitoring\/v1\/neighbours\/([^/]+)$/, neighbours],
  [/^\/network-monitoring\/v1\/switches\/([^/]+)\/vlans$/, vlans],
  [/^\/network-monitoring\/v1\/switches\/([^/]+)\/interfaces$/, interfaces],
  [/^\/network-monitoring\/v1\/switches\/([^/]+)$/, switchDetail],
];

export const mockGetter: GetJson = async (path) => {
  if (path === "/network-monitoring/v1/sites-health") return sitesHealth;
  if (path === "/network-monitoring/v1/device-inventory") return deviceInventory;
  for (const [re, table] of routes) {
    const m = path.match(re);
    if (m) {
      const hit = table[decodeURIComponent(m[1])];
      if (!hit) throw new CentralError(`Fixture has no entry for ${m[1]}.`, 404);
      return hit;
    }
  }
  throw new CentralError(`No fixture for ${path}.`, 404);
};
