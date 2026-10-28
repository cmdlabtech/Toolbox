import test from "node:test";
import assert from "node:assert/strict";
import { topologyFromFixtures } from "./helpers.mjs";
import { asList, central, interfaceKind, scrub } from "../worker/src/central.ts";

test("switch list still comes from sites-health + per-site topology", async () => {
  const calls = [];
  const data = await topologyFromFixtures(calls);
  assert.equal(data.switches.length, 19);
  assert.ok(calls.includes("/network-monitoring/v1/sites-health"));
  assert.equal(calls.filter((c) => c.startsWith("/network-monitoring/v1/topology/")).length, 5);
  assert.ok(calls.includes("/network-monitoring/v1/device-inventory"));
  for (const c of calls) {
    assert.doesNotMatch(c, /\/network-monitoring\/v1\/(devices|switches)$/, `inventory call made: ${c}`);
    assert.doesNotMatch(c, /\/monitoring\/v1\//);
  }
});

test("device group names come from device-inventory deviceGroupName", async () => {
  const data = await topologyFromFixtures();
  const byName = (n) => data.switches.find((s) => s.name === n);
  assert.equal(byName("DO-CORE-01").group, "Group 1");
  assert.equal(byName("WHS-ACC-01").group, "Group 2");
  assert.equal(byName("MES-CORE-01").group, "Group 3");
  assert.equal(byName("DO-ACC-02").group, null);
  assert.equal(byName("SPARE-SW-07").group, null);
  for (const s of data.switches) if (s.group) assert.match(s.group, /^Group \d+$/);
});

test("device inventory pages with the next cursor", async () => {
  const pages = [
    { items: [{ serialNumber: "A", deviceGroupName: "Group 1" }], count: 1, total: 2, next: "2" },
    { items: [{ serialNumber: "B", deviceGroupName: "  " }, { serialNumber: "C" }], count: 2, total: 2, next: null },
  ];
  let i = 0;
  const c = central(async (path, params) => {
    assert.equal(path, "/network-monitoring/v1/device-inventory");
    assert.equal(params.filter, "deviceType eq 'SWITCH'");
    assert.equal(params.limit, "100");
    if (i === 0) assert.equal(params.next, undefined);
    else assert.equal(params.next, "2");
    return pages[i++];
  });
  assert.deepEqual(await c.deviceGroups(), [
    { serial: "A", group: "Group 1" },
    { serial: "B", group: null },
    { serial: "C", group: null },
  ]);
  assert.equal(i, 2);
});

test("switches seen in several site topologies get their home site from switch detail", async () => {
  const data = await topologyFromFixtures();
  const core = data.switches.find((s) => s.name === "DO-CORE-01");
  assert.equal(core.site, "District Office");
  assert.equal(core.siteSource, "switch-detail");
  const mes = data.switches.find((s) => s.name === "MES-CORE-01");
  assert.equal(mes.site, "Maple ES");
  assert.equal(data.switches.find((s) => s.name === "WHS-ACC-01").siteSource, "topology");
});

test("LLDP fill-in reconnects a site whose topology omits the cross-site uplink", async () => {
  const data = await topologyFromFixtures();
  const pes = data.switches.find((s) => s.name === "PES-CORE-01").serial;
  const core = data.switches.find((s) => s.name === "DO-CORE-01").serial;
  const l = data.links.find((x) => [x.from, x.to].includes(pes) && [x.from, x.to].includes(core));
  assert.ok(l, "PES uplink present");
  assert.equal(l.source, "neighbours");
});

test("non-switch topology devices are kept as externals", async () => {
  const data = await topologyFromFixtures();
  assert.deepEqual(data.externals.map((e) => e.name).sort(), ["DO-FW-01", "WHS-AP-114"]);
});

test("helpers", () => {
  assert.deepEqual(asList({ serial: "A" }), [{ serial: "A" }]);
  assert.equal(asList(null).length, 0);
  assert.equal(interfaceKind("mgmt", null), "oobm");
  assert.equal(interfaceKind("loopback0", null), "loopback");
  assert.equal(interfaceKind("1/1/1", "ETHERNET"), "other");
  const s = scrub('Bearer abc.def {"access_token":"xyz"}');
  assert.doesNotMatch(s, /abc\.def|xyz/);
});
