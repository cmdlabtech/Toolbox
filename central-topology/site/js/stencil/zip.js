// Read-only ZIP reader: end-of-central-directory, central directory, and
// stored or deflated entries inflated with the platform DecompressionStream.
// No ZIP64, no encryption (Visio packages use neither).

export function listZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("Not a ZIP file (no end of central directory).");
  const count = dv.getUint16(eocd + 10, true), cdOff = dv.getUint32(eocd + 16, true);
  if (cdOff === 0xffffffff) throw new Error("ZIP64 archives are not supported.");
  const entries = new Map();
  const dec = new TextDecoder();
  for (let i = 0, p = cdOff; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("Corrupt ZIP central directory.");
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), size = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), local = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
    entries.set(name, { name, method, csize, size, local });
    p += 46 + nlen + xlen + clen;
  }
  return entries;
}

export async function readEntry(bytes, e) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(e.local, true) !== 0x04034b50) throw new Error(`Corrupt ZIP local header for ${e.name}.`);
  const start = e.local + 30 + dv.getUint16(e.local + 26, true) + dv.getUint16(e.local + 28, true);
  const raw = bytes.subarray(start, start + e.csize);
  if (e.method === 0) return raw;
  if (e.method !== 8) throw new Error(`Unsupported ZIP method ${e.method} for ${e.name}.`);
  const out = await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer();
  return new Uint8Array(out);
}

export async function readText(bytes, entries, name) {
  const e = entries.get(name);
  return e ? new TextDecoder().decode(await readEntry(bytes, e)) : null;
}
