import { test } from "node:test";
import assert from "node:assert/strict";
import { mgmtLine, resolveMgmt } from "../site/js/model.js";

const sw = {
  ipv4: "10.1.0.1",
  vlans: [{ id: "10", name: "MGMT", ipv4: "192.168.168.168/24" }, { id: "20", name: "DATA", ipv4: "10.20.0.1" }],
  interfaces: [{ name: "mgmt", kind: "oobm", ipv4: "192.168.100.1" }, { name: "loopback0", kind: "loopback", ipv4: "10.255.0.1" }],
};
const line = (opt, s = sw) => mgmtLine(resolveMgmt(s, opt), opt);

test("mgmt line is '{label}: {address}' per source", () => {
  assert.equal(line("vlan:10"), "VLAN 10: 192.168.168.168/24", "prefix kept when the address carries one");
  assert.equal(line("vlan:20"), "VLAN 20: 10.20.0.1", "no invented prefix");
  assert.equal(line("oobm"), "mgmt: 192.168.100.1", "OOBM uses the interface name");
  assert.equal(line("loopback"), "loopback0: 10.255.0.1");
  assert.equal(line("monitor"), "Mgmt: 10.1.0.1");
});

test("missing source falls back to the monitoring IP, or says there is none", () => {
  assert.equal(line("vlan:99"), "Fallback: 10.1.0.1");
  assert.equal(line("vlan:99", { vlans: [], interfaces: [] }), "No mgmt IP");
  assert.equal(line("oobm", { ipv4: null }), "No mgmt IP");
});
