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

test("stack members collapse into one logical switch on the conductor", () => {
  assert.equal(data.switches.length, 22);
  const m = buildModel(data);
  assert.equal(m.nodes.length, 19);
  const whs = byName(m, "WHS-CORE-01");
  assert.deepEqual(whs.stack.map((x) => x.name), ["WHS-CORE-01", "WHS-CORE-02"]);
  assert.deepEqual(byName(m, "OMS-ACC-02").stack.map((x) => x.name), ["OMS-ACC-02", "OMS-ACC-02-2", "OMS-ACC-02-3"]);
  assert.equal(byName(m, "WHS-CORE-02"), undefined);
  assert.equal(m.edges.some((e) => e.isSibling), false, "sibling links fold into the stack");
  const up = m.edges.filter((e) => [e.from, e.to].includes(whs.serial) && [e.from, e.to].includes(m.coreSerial));
  assert.equal(up.length, 1, "both uplink legs merge into one logical edge");
  assert.equal(up[0].legs, 2);
  assert.equal(up[0].toLabel, "1/1/49, 2/1/49");
  assert.equal(whs.role, "building-core");
});

test("stack members order by member id and keep their part numbers", () => {
  const m = buildModel(data);
  for (const n of m.nodes.filter((x) => x.stack)) {
    const ids = n.stack.map((x) => x.memberId);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b), `${n.name} member order`);
    for (const x of n.stack) assert.ok(x.jNumber, `${x.name} jNumber`);
  }
  // Without member ids: conductor first, then by name.
  const sw = data.switches.map((s) => ({ ...s, stackMemberId: null }));
  sw.find((s) => s.name === "OMS-ACC-02-3").stackMemberId = 1;
  const m2 = buildModel({ ...data, switches: sw });
  assert.deepEqual(byName(m2, "OMS-ACC-02").stack.map((x) => x.name), ["OMS-ACC-02-3", "OMS-ACC-02", "OMS-ACC-02-2"]);
});

test("data with no stacks passes through the stack fold unchanged", () => {
  const flat = { ...data, switches: data.switches.filter((s) => !s.conductorSerial || s.conductorSerial === s.serial).map((s) => ({ ...s, conductorSerial: null })), links: data.links.filter((l) => !l.isSibling) };
  const m = buildModel(flat);
  assert.equal(m.nodes.length, flat.switches.length);
  assert.equal(m.nodes.some((n) => n.stack), false);
});
