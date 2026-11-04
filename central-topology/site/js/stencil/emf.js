// Minimal EMF -> SVG converter for vendor stencil art (Visio ForeignData).
// Handles the records VisioCafe HPE stencils use: pens, brushes, 16- and
// 32-bit polygons/polylines/beziers, paths, rectangles, ellipses, world
// transforms, window/viewport mapping, save/restore, and DIB bitmaps.
// Text, clipping and pattern brushes are skipped and reported in `skipped`.

const STOCK = { 0: { fill: "#ffffff" }, 1: { fill: "#c0c0c0" }, 2: { fill: "#808080" }, 3: { fill: "#404040" }, 4: { fill: "#000000" }, 5: { fill: null },
  6: { stroke: "#ffffff", width: 0 }, 7: { stroke: "#000000", width: 0 }, 8: { stroke: null } };
const NAMES = { 84: "text", 83: "text", 67: "clip path", 30: "clip rect", 29: "clip rect", 94: "pattern brush", 76: "bitblt", 114: "alpha blend" };

const color = (c) => "#" + [c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff].map((v) => v.toString(16).padStart(2, "0")).join("");
const mul = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
const ID = [1, 0, 0, 1, 0, 0];
const f = (n) => Math.round(n * 10) / 10;

export function base64(bytes) {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** bytes: Uint8Array of an EMF. Returns { svg, width, height, skipped: {name: count} } or null. */
export function emfToSvg(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.byteLength < 88 || dv.getUint32(0, true) !== 1 || dv.getUint32(40, true) !== 0x464d4520) return null;
  const bounds = [0, 1, 2, 3].map((i) => dv.getInt32(8 + i * 4, true));
  const objs = new Map();
  let st = { pen: { stroke: "#000000", width: 0 }, brush: { fill: "#ffffff" }, world: ID, wOrg: [0, 0], wExt: [1, 1], vOrg: [0, 0], vExt: [1, 1], mapMode: 1, fillRule: "evenodd", cur: [0, 0] };
  const stack = [];
  const out = [];
  const skipped = {};
  let path = null; // array of subpath strings while in BEGINPATH
  let sub = "";

  const M = () => {
    const iso = st.mapMode === 8 || st.mapMode === 7;
    const sx = iso ? st.vExt[0] / st.wExt[0] : 1, sy = iso ? st.vExt[1] / st.wExt[1] : 1;
    const page = [sx, 0, 0, sy, st.vOrg[0] - st.wOrg[0] * sx, st.vOrg[1] - st.wOrg[1] * sy];
    return mul(page, st.world);
  };
  const pt = (x, y) => { const m = M(); return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; };
  const P = (x, y) => { const [a, b] = pt(x, y); return `${f(a)} ${f(b)}`; };
  const scale = () => { const m = M(); return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])); };
  const strokeAttr = () => {
    const p = st.pen;
    if (!p.stroke) return ` stroke="none"`;
    const w = p.width ? p.width * scale() : 1;
    return ` stroke="${p.stroke}" stroke-width="${f(Math.max(w, 0.5))}"`;
  };
  const fillAttr = () => (st.brush.fill ? ` fill="${st.brush.fill}" fill-rule="${st.fillRule}"` : ` fill="none"`);
  const emit = (d, fill, stroke) => { if (d && (fill || stroke)) out.push(`<path d="${d}"${fill ? fillAttr() : ` fill="none"`}${stroke ? strokeAttr() : ` stroke="none"`}/>`); };
  const pts16 = (off, n) => { const a = []; for (let i = 0; i < n; i++) a.push([dv.getInt16(off + i * 4, true), dv.getInt16(off + i * 4 + 2, true)]); return a; };
  const pts32 = (off, n) => { const a = []; for (let i = 0; i < n; i++) a.push([dv.getInt32(off + i * 8, true), dv.getInt32(off + i * 8 + 4, true)]); return a; };
  const poly = (ps, close) => (ps.length ? "M" + ps.map(([x, y]) => P(x, y)).join(" L") + (close ? " Z" : "") : "");
  const bez = (ps) => { let d = ""; for (let i = 0; i + 2 < ps.length; i += 3) d += ` C${P(...ps[i])} ${P(...ps[i + 1])} ${P(...ps[i + 2])}`; return d; };
  const draw = (d, fill, stroke) => { if (path) path.push(d); else emit(d, fill, stroke); };
  const flushSub = () => { if (sub) { path.push(sub); sub = ""; } };
  const rectD = (l, t, r, b) => `M${P(l, t)} L${P(r, t)} L${P(r, b)} L${P(l, b)} Z`;

  for (let off = 0; off + 8 <= dv.byteLength;) {
    const type = dv.getUint32(off, true), size = dv.getUint32(off + 4, true);
    if (size < 8 || off + size > dv.byteLength) break;
    const u = (o) => dv.getUint32(off + o, true), i32 = (o) => dv.getInt32(off + o, true), fl = (o) => dv.getFloat32(off + o, true);
    switch (type) {
      case 9: st.wExt = [i32(8), i32(12)]; break;
      case 10: st.wOrg = [i32(8), i32(12)]; break;
      case 11: st.vExt = [i32(8), i32(12)]; break;
      case 12: st.vOrg = [i32(8), i32(12)]; break;
      case 17: st.mapMode = u(8); break;
      case 19: st.fillRule = u(8) === 2 ? "nonzero" : "evenodd"; break;
      case 33: stack.push({ ...st }); break;
      case 34: { const n = i32(8); for (let k = 0; k < Math.max(-n, 1) - 1 && stack.length; k++) stack.pop(); if (stack.length) st = stack.pop(); break; }
      case 35: st.world = [fl(8), fl(12), fl(16), fl(20), fl(24), fl(28)]; break;
      case 36: { const x = [fl(8), fl(12), fl(16), fl(20), fl(24), fl(28)], mode = u(32);
        st.world = mode === 1 ? ID : mode === 2 ? mul(st.world, x) : mode === 3 ? mul(x, st.world) : x; break; }
      case 37: { const h = u(8);
        const o = h & 0x80000000 ? STOCK[h & 0x7fffffff] : objs.get(h);
        if (o && "fill" in o) st.brush = o; else if (o && "stroke" in o) st.pen = o; break; }
      case 38: objs.set(u(8), (u(12) & 0xf) === 5 ? { stroke: null } : { stroke: color(u(24)), width: i32(16) }); break;
      case 95: objs.set(u(8), (u(28) & 0xf) === 5 || u(36) === 1 ? { stroke: null } : { stroke: color(u(40)), width: u(32) }); break;
      case 39: objs.set(u(8), u(12) === 1 ? { fill: null } : { fill: color(u(16)) }); break;
      case 94: objs.set(u(8), { fill: "#808080" }); skipped[NAMES[94]] = (skipped[NAMES[94]] ?? 0) + 1; break;
      case 40: objs.delete(u(8)); break;
      case 27: if (path) { flushSub(); sub = `M${P(i32(8), i32(12))}`; } st.cur = [i32(8), i32(12)]; break;
      case 54: if (path) sub += ` L${P(i32(8), i32(12))}`; else emit(`M${P(...st.cur)} L${P(i32(8), i32(12))}`, false, true); st.cur = [i32(8), i32(12)]; break;
      case 59: path = []; sub = ""; break;
      case 60: if (path) flushSub(); break;
      case 61: if (path) sub += " Z"; break;
      case 62: case 63: case 64: if (path) { flushSub(); emit(path.join(" "), type !== 64, type !== 62); } path = null; break;
      case 2: case 85: draw(type === 2 ? (() => { const ps = pts32(off + 28, u(24)); return `M${P(...ps[0])}` + bez(ps.slice(1)); })() : (() => { const ps = pts16(off + 28, u(24)); return `M${P(...ps[0])}` + bez(ps.slice(1)); })(), false, true); break;
      case 3: case 86: draw(poly(type === 3 ? pts32(off + 28, u(24)) : pts16(off + 28, u(24)), true), true, true); break;
      case 4: case 87: draw(poly(type === 4 ? pts32(off + 28, u(24)) : pts16(off + 28, u(24)), false), false, true); break;
      case 5: case 88: case 6: case 89: {
        const ps = type === 5 || type === 6 ? pts32(off + 28, u(24)) : pts16(off + 28, u(24));
        const seg = type === 5 || type === 88 ? bez(ps) : ps.map(([x, y]) => ` L${P(x, y)}`).join("");
        if (path) { if (!sub) sub = `M${P(...st.cur)}`; sub += seg; } else emit(`M${P(...st.cur)}` + seg, false, true);
        if (ps.length) st.cur = ps[ps.length - 1];
        break; }
      case 7: case 8: case 90: case 91: {
        const n = u(24), wide = type === 7 || type === 8;
        const counts = Array.from({ length: n }, (_, k) => u(32 + k * 4));
        let p0 = off + 32 + n * 4, d = "";
        for (const c of counts) { const ps = wide ? pts32(p0, c) : pts16(p0, c); d += poly(ps, type === 8 || type === 91) + " "; p0 += c * (wide ? 8 : 4); }
        draw(d.trim(), type === 8 || type === 91, true); break; }
      case 43: draw(rectD(i32(8), i32(12), i32(16), i32(20)), true, true); break;
      case 44: draw(rectD(i32(8), i32(12), i32(16), i32(20)), true, true); break;
      case 42: { const [l, t, r, b] = [i32(8), i32(12), i32(16), i32(20)];
        const [cx, cy] = pt((l + r) / 2, (t + b) / 2), [ex, ey] = pt(r, b), [sx, sy] = pt(l, t);
        out.push(`<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(Math.abs(ex - sx) / 2)}" ry="${f(Math.abs(ey - sy) / 2)}"${fillAttr()}${strokeAttr()}/>`); break; }
      case 81: { // STRETCHDIBITS -> BMP data URI
        const xD = i32(24), yD = i32(28), offBmi = u(48), cbBmi = u(52), offBits = u(56), cbBits = u(60), cxD = i32(72), cyD = i32(76);
        if (!cbBmi || !cbBits) break;
        const bmi = bytes.subarray(off + offBmi, off + offBmi + cbBmi), bits = bytes.subarray(off + offBits, off + offBits + cbBits);
        const file = new Uint8Array(14 + cbBmi + cbBits), fd = new DataView(file.buffer);
        file[0] = 0x42; file[1] = 0x4d; fd.setUint32(2, file.length, true); fd.setUint32(10, 14 + cbBmi, true);
        file.set(bmi, 14); file.set(bits, 14 + cbBmi);
        const [x0, y0] = pt(xD, yD), [x1, y1] = pt(xD + cxD, yD + cyD);
        out.push(`<image x="${f(Math.min(x0, x1))}" y="${f(Math.min(y0, y1))}" width="${f(Math.abs(x1 - x0))}" height="${f(Math.abs(y1 - y0))}" preserveAspectRatio="none" href="data:image/bmp;base64,${base64(file)}"/>`);
        break; }
      case 76: { // BITBLT with no source bitmap = fill the rect with the brush
        const rop = u(40);
        if (rop === 0x00aa0029) break; // D: no-op
        if (!u(88) && rop === 0x00f00021) { const [x, y, w, h] = [i32(24), i32(28), i32(32), i32(36)]; if (st.brush.fill) out.push(`<path d="${rectD(x, y, x + w, y + h)}" fill="${st.brush.fill}"/>`); }
        else skipped.bitblt = (skipped.bitblt ?? 0) + 1;
        break; }
      case 14: off = dv.byteLength; continue;
      default: if (NAMES[type]) skipped[NAMES[type]] = (skipped[NAMES[type]] ?? 0) + 1;
    }
    off += size;
  }
  const [l, t, r, b] = bounds;
  const width = r - l + 1, height = b - t + 1;
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${l} ${t} ${width} ${height}" width="${width}" height="${height}">${out.join("")}</svg>`, width, height, skipped };
}
