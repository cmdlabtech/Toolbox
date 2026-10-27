import test from "node:test";
import assert from "node:assert/strict";
import { topologyFromFixtures } from "./helpers.mjs";
import { buildModel, mgmtOptions, parseOverrides, resolveMgmt } from "../site/js/model.js";

const data = await topologyFromFixtures();
const byName = (m, n) => m.nodes.find((x) => x.name === n);

test("district core is the highest-degree switch; every switch traces back to it", () => {
  const m = buildModel(data);
  assert.equal(byName(m, "DO-CORE-01").role, "district-core");
  assert.equal(m.coreSource, "inferred");
  for (const n of m.nodes) assert.notEqual(n.hop, null, `${n.name} unreachable`);
  for (const n of m.nodes) {
    let cur = n, guard = 0;
    while (cur.parent && guard++ < 10) cur = m.byId.get(cur.parent);
    assert.equal(cur.serial, m.coreSerial, `${n.name} does not trace to core`);
  }
});

test("buildings come from site assignment; one building core per building", () => {
  const m = buildModel(data);
  assert.deepEqual([...m.buildings].sort(), ["District Office", "Maple ES", "Oak MS", "Pine ES", "Westfield HS"]);
  for (const code of ["WHS", "OMS", "MES", "PES"]) assert.equal(byName(m, `${code}-CORE-01`).role, "building-core");
  assert.equal(byName(m, "PES-ACC-02").hop, 3);
  assert.equal(byName(m, "PES-ACC-02").parent, byName(m, "PES-ACC-01").serial);
  assert.equal(byName(m, "DO-ACC-01").role, "access");
});

test("ambiguous spare switch is flagged", () => {
  const n = byName(buildModel(data), "SPARE-SW-07");
  assert.equal(n.building, "Oak MS");
  assert.ok(n.flags.some((f) => f.includes("Maple ES")));
  assert.ok(n.flags.includes("multi-homed"));
});

test("overrides: pick core, reassign building and role", () => {
  const spare = byName(buildModel(data), "SPARE-SW-07").serial;
  const whs = byName(buildModel(data), "WHS-CORE-01").serial;
  const m = buildModel(data, { coreSerial: whs, switches: { [spare]: { building: "Maple ES", role: "access" } } });
  assert.equal(m.coreSerial, whs);
  assert.equal(m.coreSource, "override");
  assert.equal(byName(m, "SPARE-SW-07").building, "Maple ES");
  assert.equal(byName(m, "SPARE-SW-07").parent, byName(m, "MES-CORE-01").serial);
  assert.equal(byName(m, "DO-CORE-01").role, "building-core");
});

test("mgmt options only list what the data supports, with counts", () => {
  const ids = mgmtOptions(data.switches).map((o) => o.id);
  assert.deepEqual(ids, ["monitor", "vlan:10", "vlan:99", "oobm", "loopback"].filter((i) => ids.includes(i)));
  assert.ok(ids.includes("monitor") && ids.includes("vlan:99") && ids.includes("oobm") && ids.includes("loopback"));
  const opts = mgmtOptions(data.switches.map((s) => ({ ...s, interfaces: [] })));
  assert.ok(!opts.some((o) => o.id === "oobm" || o.id === "loopback"));
});

test("missing interface falls back to the monitoring IP and is marked", () => {
  const m = buildModel(data);
  const mes2 = byName(m, "MES-ACC-02");
  const r = resolveMgmt(mes2, "vlan:99");
  assert.equal(r.fallback, true);
  assert.equal(r.ip, mes2.ipv4);
  const ok = resolveMgmt(byName(m, "DO-CORE-01"), "oobm");
  assert.equal(ok.fallback, false);
  assert.equal(ok.ip, "192.168.100.1");
  assert.equal(resolveMgmt(byName(m, "PES-CORE-01"), "oobm").fallback, true);
});

test("override import validates shape", () => {
  const o = parseOverrides('{"coreSerial":"X","switches":{"A":{"role":"access","building":" B "},"C":{"role":"bogus"}}}');
  assert.deepEqual(o, { coreSerial: "X", switches: { A: { role: "access", building: "B" } } });
  assert.throws(() => parseOverrides("[]"));
});
