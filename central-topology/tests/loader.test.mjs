import test from "node:test";
import assert from "node:assert/strict";
import { PHASES, createLoader } from "../site/js/loader.js";
import { fetchWithAuth } from "../site/js/creds.js";

// Minimal element: enough DOM for the loader.
function fakeEl() {
  const attrs = new Map();
  const el = {
    textContent: "", className: "", dataset: {}, children: [],
    ownerDocument: { createElement: () => ({ className: "", setAttribute() {} }) },
    setAttribute: (k, v) => attrs.set(k, v), removeAttribute: (k) => attrs.delete(k), getAttribute: (k) => attrs.get(k) ?? null,
    append(...xs) { el.children = xs; el.textContent = xs.filter((x) => typeof x === "string").join(""); },
  };
  return el;
}

test("loader shows each phase label, then clears on success", () => {
  const el = fakeEl(), ld = createLoader(el);
  ld.phase("fetching");
  assert.equal(el.textContent, "", "no phase before start");
  ld.start();
  for (const id of ["connecting", "fetching", "reading", "layout"]) {
    ld.phase(id);
    assert.equal(ld.current, id);
    assert.equal(el.textContent, PHASES[id]);
    assert.equal(el.className, "loading");
    assert.equal(el.getAttribute("aria-busy"), "true");
    assert.equal(el.children[0].className, "ld-spin");
  }
  ld.done("44 switches, 620 links.");
  assert.equal(ld.active, false);
  assert.equal(el.textContent, "44 switches, 620 links.");
  assert.equal(el.className, "");
  assert.equal(el.getAttribute("aria-busy"), null);
  assert.equal(ld.current, null);
  ld.phase("layout");
  assert.equal(el.textContent, "44 switches, 620 links.", "late phases ignored");
});

test("loader error replaces the spinner with the error message", () => {
  const el = fakeEl(), ld = createLoader(el);
  ld.start(); ld.phase("fetching");
  ld.fail("Could not load topology: HTTP 502");
  assert.equal(el.textContent, "Could not load topology: HTTP 502");
  assert.equal(el.className, "err");
  assert.equal(ld.active, false);
});

test("fetchWithAuth reports connecting → fetching → reading from real steps", async () => {
  const seen = [];
  await fetchWithAuth(null, { fetchImpl: async () => Response.json({ switches: [] }), onPhase: (p) => seen.push(p) });
  assert.deepEqual(seen, ["connecting", "fetching", "reading"]);
  const err = [];
  await assert.rejects(fetchWithAuth(null, { fetchImpl: async () => { throw new Error("offline"); }, onPhase: (p) => err.push(p) }), /offline/);
  assert.deepEqual(err, ["connecting", "fetching"], "no reading phase when the request fails");
  for (const id of [...seen, "layout", "sample"]) assert.ok(PHASES[id], `${id} has a label`);
});
