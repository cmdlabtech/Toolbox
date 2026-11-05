import test from "node:test";
import assert from "node:assert/strict";
import { central } from "../worker/src/central.ts";
import { incompleteModel, mergeTenant, pickModel } from "../worker/src/merge.ts";

test("a model is incomplete when blank or digit-free", () => {
  for (const m of [null, "", "  ", "CX-", "Aruba", "CX"]) assert.equal(incompleteModel(m), true, String(m));
  for (const m of ["Aruba 6300M 48G", "8360-32Y4C", "CX 6100"]) assert.equal(incompleteModel(m), false, m);
  assert.equal(pickModel("Aruba 6100 24G", ["Aruba 6300M"]), "Aruba 6100 24G", "complete model is never replaced");
  assert.equal(pickModel("CX-", [null, "CX-", " Aruba 6300F 48G "]), "Aruba 6300F 48G");
  assert.equal(pickModel("CX-", [null, "", "CX"]), "CX-", "nothing better: Central's value stays");
});

// HAR-MDF-616: topology says "CX-"; detail and inventory may carry the real model.
function tenant({ detailModel = null, invModel = null, invBy = "serial" } = {}) {
  const dev = (serial, name, model) => ({ serial, name, type: "Switch", model, status: "OFFLINE", deviceFunction: "Core Switch", deployment: "Standalone" });
  const topo = { devices: [dev("SGHAR616", "HAR-MDF-616", "CX-"), dev("SGOK0001", "HAR-IDF-1", "Aruba 6100 24G 4SFP+")],
    links: [{ from: "SGHAR616", to: "SGOK0001", fromPortList: [{ name: "1/1/1" }], toPortList: [{ name: "1/1/49" }] }] };
  const get = async (path) => {
    if (path.endsWith("/sites-health")) return { items: [{ id: "s1", siteName: "Harney Elementary" }], total: 1 };
    if (path.endsWith("/device-inventory")) return { items: [
      invBy === "stack" ? { serialNumber: "MEMBER1", stackId: "SGHAR616", model: invModel } : { serialNumber: "SGHAR616", model: invModel },
      { serialNumber: "SGOK0001", model: "Aruba 6300M 48G" },
    ], next: null };
    if (path.endsWith("/topology/s1")) return topo;
    if (path.endsWith("/switches/SGHAR616")) return { siteId: "s1", serialNumber: "SGHAR616", model: detailModel };
    if (path.endsWith("/switches/SGOK0001")) return { siteId: "s1", serialNumber: "SGOK0001", model: "Aruba 6300M 48G" };
    return { neighbours: [] };
  };
  return central(get);
}
const pool = async (xs, _n, f) => Promise.all(xs.map(f));
async function models(opts) {
  const c = tenant(opts);
  const { switches } = await mergeTenant(c, await c.sites(), pool, () => {});
  const by = (s) => switches.find((x) => x.serial === s).model;
  return [by("SGHAR616"), by("SGOK0001")];
}

test("Worker: a 'CX-' topology model is filled from switch detail first", async () => {
  assert.deepEqual(await models({ detailModel: "Aruba 6300F 24G", invModel: "Aruba 6300M 48G" }), ["Aruba 6300F 24G", "Aruba 6100 24G 4SFP+"]);
});

test("Worker: then from device-inventory by serial or stackId", async () => {
  assert.deepEqual(await models({ detailModel: "CX-", invModel: "Aruba 6300M 24G" }), ["Aruba 6300M 24G", "Aruba 6100 24G 4SFP+"]);
  assert.deepEqual(await models({ invModel: "Aruba 6200F 48G", invBy: "stack" }), ["Aruba 6200F 48G", "Aruba 6100 24G 4SFP+"]);
});

test("Worker: with no complete model anywhere, Central's 'CX-' is passed through", async () => {
  assert.deepEqual(await models({}), ["CX-", "Aruba 6100 24G 4SFP+"]);
});
