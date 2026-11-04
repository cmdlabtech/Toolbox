// Stencil import: ZIP reader, XML tokenizer, EMF -> SVG, and .vssx masters.
// Synthetic inputs only; the real VisioCafe file is used when it sits in the
// scratch folder outside the repo (it is never committed).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { listZip, readEntry, readText } from "../site/js/stencil/zip.js";
import { parseXml, kid, kids } from "../site/js/stencil/xml.js";
import { emfToSvg } from "../site/js/stencil/emf.js";
import { importStencils, parseMasterName } from "../site/js/stencil/vssx.js";
import { createRegistry } from "../site/js/stencils.js";

const enc = new TextEncoder();
async function deflateRaw(bytes) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
}
// Minimal ZIP writer (CRC left 0: the reader does not check it).
async function zip(files, { deflate = true } = {}) {
  const locals = [], cds = [];
  let off = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = typeof content === "string" ? enc.encode(content) : content;
    const data = deflate ? await deflateRaw(raw) : raw, n = enc.encode(name), method = deflate ? 8 : 0;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(8, method, true); lh.setUint32(18, data.length, true); lh.setUint32(22, raw.length, true); lh.setUint16(26, n.length, true);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(10, method, true); cd.setUint32(20, data.length, true); cd.setUint32(24, raw.length, true); cd.setUint16(28, n.length, true); cd.setUint32(42, off, true);
    locals.push(new Uint8Array(lh.buffer), n, data); cds.push(new Uint8Array(cd.buffer), n);
    off += 30 + n.length + data.length;
  }
  const cdSize = cds.reduce((a, b) => a + b.length, 0);
  const eo = new DataView(new ArrayBuffer(22));
  eo.setUint32(0, 0x06054b50, true); eo.setUint16(8, cds.length / 2, true); eo.setUint16(10, cds.length / 2, true); eo.setUint32(12, cdSize, true); eo.setUint32(16, off, true);
  const parts = [...locals, ...cds, new Uint8Array(eo.buffer)];
  const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
  let p = 0; for (const b of parts) { out.set(b, p); p += b.length; }
  return out;
}

test("zip: stored and deflated entries read back", async () => {
  for (const deflate of [false, true]) {
    const z = await zip({ "a.txt": "hello", "dir/b.xml": "<x>" + "y".repeat(500) + "</x>" }, { deflate });
    const e = listZip(z);
    assert.deepEqual([...e.keys()], ["a.txt", "dir/b.xml"]);
    assert.equal(await readText(z, e, "a.txt"), "hello");
    assert.equal(new TextDecoder().decode(await readEntry(z, e.get("dir/b.xml"))).length, 507);
    assert.equal(await readText(z, e, "missing"), null);
  }
  assert.throws(() => listZip(enc.encode("not a zip")));
});

test("xml: prefixes stripped from names, kept on attributes, entities decoded", () => {
  const d = parseXml(`<?xml version="1.0"?><v:Masters xmlns:r="x"><Master NameU="A &amp; B" ID="1"><Rel r:id="rId1"/></Master><Master/></v:Masters>`);
  const root = d.children[0];
  assert.equal(root.name, "Masters");
  assert.equal(kids(root, "Master").length, 2);
  assert.equal(kid(root, "Master").attrs.NameU, "A & B");
  assert.equal(kid(kid(root, "Master"), "Rel").attrs["r:id"], "rId1");
});

// header(88) + CREATEBRUSHINDIRECT + SELECTOBJECT + RECTANGLE + no-op BITBLT + EOF
function tinyEmf() {
  const recs = [];
  const rec = (type, words) => { const dv = new DataView(new ArrayBuffer(8 + words.length * 4)); dv.setUint32(0, type, true); dv.setUint32(4, dv.byteLength, true); words.forEach((w, i) => dv.setUint32(8 + i * 4, w >>> 0, true)); recs.push(new Uint8Array(dv.buffer)); };
  const h = new DataView(new ArrayBuffer(88));
  h.setUint32(0, 1, true); h.setUint32(4, 88, true); [0, 0, 99, 9].forEach((v, i) => h.setInt32(8 + i * 4, v, true)); h.setUint32(40, 0x464d4520, true);
  recs.push(new Uint8Array(h.buffer));
  rec(39, [1, 0, 0x00332211, 0]);           // solid brush, COLORREF 0x00BBGGRR
  rec(37, [1]);
  rec(43, [0, 0, 99, 9]);
  rec(76, [0, 0, 99, 9, 0, 0, 100, 10, 0xaa0029, ...new Array(15).fill(0)]); // ROP D (no-op): must draw nothing
  rec(14, [0, 0, 20]);
  const out = new Uint8Array(recs.reduce((a, b) => a + b.length, 0));
  let p = 0; for (const r of recs) { out.set(r, p); p += r.length; }
  return out;
}

test("emf: header bounds, brush colour, rectangle; no-op BITBLT ignored", () => {
  const r = emfToSvg(tinyEmf());
  assert.ok(r, "parsed");
  assert.equal(r.width, 100); assert.equal(r.height, 10);
  assert.equal((r.svg.match(/<path /g) ?? []).length, 1, "only the rectangle draws");
  assert.match(r.svg, /fill="#112233"/);
  assert.equal(emfToSvg(enc.encode("x".repeat(100))), null);
});

test("vssx: front masters with a part number become stencils; rear and SKU-less ones are skipped", async () => {
  assert.deepEqual(parseMasterName("Aruba 6100 48G 4SFP+ Switch (JL676A)"), { sku: "JL676A", model: "Aruba 6100 48G 4SFP+ Switch" });
  assert.equal(parseMasterName("Aruba 6100 48G JL676A Rear"), null);
  assert.equal(parseMasterName("Aruba logo"), null);
  const master = (w, h, extra = "") => `<MasterContents><Shapes><Shape ID="1"><Cell N="PinX" V="${w / 2}"/><Cell N="PinY" V="${h / 2}"/><Cell N="Width" V="${w}"/><Cell N="Height" V="${h}"/><Cell N="LocPinX" V="${w / 2}"/><Cell N="LocPinY" V="${h / 2}"/><Cell N="FillForegnd" V="#202020"/>
    <Section N="Geometry"><Row T="MoveTo"><Cell N="X" V="0"/><Cell N="Y" V="0"/></Row><Row T="LineTo"><Cell N="X" V="${w}"/><Cell N="Y" V="0"/></Row><Row T="LineTo"><Cell N="X" V="${w}"/><Cell N="Y" V="${h}"/></Row><Row T="LineTo"><Cell N="X" V="0"/><Cell N="Y" V="${h}"/></Row><Row T="LineTo"><Cell N="X" V="0"/><Cell N="Y" V="0"/></Row></Section>${extra}</Shape></Shapes></MasterContents>`;
  const vssx = await zip({
    "visio/masters/masters.xml": `<Masters><Master NameU="Aruba 6100 48G 4SFP+ Switch JL676A"><Rel r:id="rId1"/></Master><Master NameU="Aruba 6100 48G 4SFP+ Switch JL676A Rear"><Rel r:id="rId2"/></Master><Master NameU="Cable"><Rel r:id="rId3"/></Master></Masters>`,
    "visio/masters/_rels/masters.xml.rels": `<Relationships><Relationship Id="rId1" Target="master1.xml"/><Relationship Id="rId2" Target="master2.xml"/><Relationship Id="rId3" Target="master3.xml"/></Relationships>`,
    "visio/masters/master1.xml": master(17.4, 1.73),
    "visio/masters/master2.xml": master(17.4, 1.73),
    "visio/masters/master3.xml": master(1, 1),
  });
  const r = await importStencils(vssx, "test.vssx");
  assert.equal(r.masters, 3);
  assert.equal(r.stencils.length, 1);
  const s = r.stencils[0];
  assert.equal(s.sku, "JL676A"); assert.equal(s.art, "geometry"); assert.equal(s.source, "test.vssx");
  assert.ok(Math.abs(s.aspect - 17.4 / 1.73) < 0.01);
  const svg = Buffer.from(s.href.split(",")[1], "base64").toString();
  assert.match(svg, /^<svg[^>]*viewBox/); assert.match(svg, /#202020/);
  // A zip of stencils is unpacked one level.
  const outer = await zip({ "pack/a.vssx": vssx }, { deflate: false });
  assert.equal((await importStencils(outer, "pack.zip")).stencils.length, 1);
  // Registry finds it by part number even when the model text differs.
  assert.equal(createRegistry(r.stencils).lookup("Aruba 6100 48G Class4 PoE", "JL676A").how, "part number");
});

// Optional: point CT_STENCIL_FILE at a VisioCafe .vssx kept outside the repo.
const REAL = process.env.CT_STENCIL_FILE ?? "";
test("vssx: VisioCafe switches stencil covers the mock tenant's part numbers", { skip: !(REAL && existsSync(REAL)) && "set CT_STENCIL_FILE to run" }, async () => {
  const r = await importStencils(new Uint8Array(readFileSync(REAL)), "small.vssx");
  const reg = createRegistry(r.stencils);
  for (const sku of ["JL676A", "JL678A", "JL661A", "JL700C", "JL726A"]) assert.equal(reg.lookup(null, sku)?.sku, sku, sku);
  assert.equal(r.skipped.length, 0);
});
