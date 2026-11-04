// Visio stencil (.vssx) import, run entirely on the user's device.
// Reads the package with zip.js, lists the masters, keeps front views that
// carry an HPE/Aruba part number, and turns each into a self-contained SVG:
// the master's EMF faceplate art when it converts, else its shape geometry.

import { listZip, readEntry, readText } from "./zip.js";
import { parseXml, kids, kid } from "./xml.js";
import { emfToSvg, base64 } from "./emf.js";

export const SKU_RE = /\b(J[LHQ]\d{3}[A-Z]|R\d[A-Z]\d{2}[A-Z]|S\d[A-Z]\d{2}[A-Z])\b/;
const REAR = /\b(rear|back)\b/i;

const enc = new TextEncoder();
const svgHref = (svg) => "data:image/svg+xml;base64," + base64(enc.encode(svg));

function rels(xml) {
  const m = new Map();
  if (!xml) return m;
  for (const r of kids(parseXml(xml).children[0], "Relationship")) m.set(r.attrs.Id, r.attrs.Target);
  return m;
}
const resolve = (base, target) => {
  const parts = base.split("/").slice(0, -1);
  for (const seg of target.split("/")) seg === ".." ? parts.pop() : seg !== "." && parts.push(seg);
  return parts.join("/");
};

/** Name like "JL676A Aruba 6100 48G 4SFP+ Switch" -> { sku, model } or null. */
export function parseMasterName(name) {
  const m = SKU_RE.exec(name ?? "");
  if (!m || REAR.test(name)) return null;
  const model = name.replace(m[0], " ").replace(/\(\s*\)/g, " ").replace(/\s+/g, " ").trim();
  return { sku: m[1], model };
}

/** bytes: Uint8Array of a .vssx, or of a .zip holding .vssx files. */
export async function importStencils(bytes, source = "stencil") {
  const entries = listZip(bytes);
  if (!entries.has("visio/masters/masters.xml")) {
    const inner = [...entries.values()].filter((e) => /\.vssx$/i.test(e.name));
    if (!inner.length) throw new Error("No Visio masters in this file. Pick a .vssx stencil.");
    const out = { stencils: [], skipped: [], masters: 0 };
    for (const e of inner) {
      const r = await importStencils(await readEntry(bytes, e), e.name.split("/").pop());
      out.stencils.push(...r.stencils); out.skipped.push(...r.skipped); out.masters += r.masters;
    }
    return out;
  }
  const masters = kids(parseXml(await readText(bytes, entries, "visio/masters/masters.xml")).children[0], "Master");
  const mrels = rels(await readText(bytes, entries, "visio/masters/_rels/masters.xml.rels"));
  const stencils = [], skipped = [], seen = new Set();
  for (const m of masters) {
    const name = m.attrs.NameU ?? m.attrs.Name ?? "";
    const parsed = parseMasterName(name);
    if (!parsed || seen.has(parsed.sku)) continue;
    const target = mrels.get(kid(m, "Rel")?.attrs["r:id"]);
    if (!target) { skipped.push({ name, why: "no master part" }); continue; }
    const part = "visio/masters/" + target;
    const xml = await readText(bytes, entries, part);
    if (!xml) { skipped.push({ name, why: "missing master part" }); continue; }
    const doc = parseXml(xml);
    const prels = rels(await readText(bytes, entries, part.replace(/([^/]+)$/, "_rels/$1.rels")));
    const art = masterArt(doc, await foreignParts(bytes, entries, doc, prels, part));
    if (!art) { skipped.push({ name, why: "no drawable art" }); continue; }
    seen.add(parsed.sku);
    stencils.push({ sku: parsed.sku, match: parsed.model, name, source, href: art.href, aspect: art.aspect, art: art.kind, ...(art.note ? { note: art.note } : {}) });
  }
  return { stencils, skipped, masters: masters.length };
}

function* walk(el) { for (const c of el.children) { yield c; yield* walk(c); } }

// Foreign (EMF or bitmap) parts of a master, keyed by relationship id.
async function foreignParts(bytes, entries, doc, prels, part) {
  const out = new Map();
  for (const fd of [...walk(doc)].filter((e) => e.name === "ForeignData")) {
    const id = kid(fd, "Rel")?.attrs["r:id"], target = prels.get(id);
    const e = target && entries.get(resolve(part, target));
    if (!e || out.has(id)) continue;
    const data = await readEntry(bytes, e), ext = target.split(".").pop().toLowerCase();
    if (ext === "emf") {
      const r = emfToSvg(data);
      if (r && r.width > 0 && r.height > 0) out.set(id, { href: svgHref(r.svg), skipped: Object.keys(r.skipped) });
      continue;
    }
    const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp" }[ext];
    if (mime) out.set(id, { href: `data:${mime};base64,${base64(data)}`, skipped: [] });
  }
  return out;
}

// ---------- master -> SVG ----------
// Composite the master the way Visio draws it: shape geometry (chassis, ears,
// vents) in document order, with foreign art placed in its shape's box.
const PALETTE = ["#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff00ff", "#00ffff", "#800000", "#008000", "#000080", "#808000", "#800080", "#008080", "#c0c0c0", "#e6e6e6", "#cdcdcd", "#b3b3b3", "#9a9a9a", "#808080", "#666666", "#4d4d4d", "#333333", "#1a1a1a"];
const colour = (v) => (/^#[0-9a-f]{6}$/i.test(v ?? "") ? v : PALETTE[+v] ?? null);
const cells = (el) => Object.fromEntries(kids(el, "Cell").map((c) => [c.attrs.N, c.attrs.V]));
const r4 = (n) => Math.round(n * 1e4) / 1e4;

export function masterArt(doc, foreign = new Map()) {
  const shapes = [...walk(doc)].find((e) => e.name === "Shapes");
  if (!shapes) return null;
  const items = [];
  const notes = new Set();
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  const grow = (X, Y) => { box[0] = Math.min(box[0], X); box[1] = Math.min(box[1], Y); box[2] = Math.max(box[2], X); box[3] = Math.max(box[3], Y); };
  let usedForeign = false;
  const visit = (shape, ox, oy) => {
    const c = cells(shape);
    const w = +c.Width || 0, h = +c.Height || 0;
    const x0 = ox + (+c.PinX || 0) - (+c.LocPinX || 0), y0 = oy + (+c.PinY || 0) - (+c.LocPinY || 0);
    if (shape.attrs.Type === "Foreign") {
      const art = foreign.get(kid(kid(shape, "ForeignData"), "Rel")?.attrs["r:id"]);
      if (art && w > 0 && h > 0) {
        items.push({ image: art.href, x: x0, y: y0, w, h }); grow(x0, y0); grow(x0 + w, y0 + h);
        art.skipped.forEach((n) => notes.add(n)); usedForeign = true;
      }
      return;
    }
    const fill = c.FillPattern === "0" ? null : colour(c.FillForegnd);
    const stroke = c.LinePattern === "0" ? null : colour(c.LineColor) ?? "#000000";
    for (const g of kids(shape, "Section").filter((s) => s.attrs.N === "Geometry")) {
      const gc = cells(g);
      if (gc.NoShow === "1") continue;
      let d = "", cur = [0, 0];
      const P = (x, y) => { const X = r4(x0 + x), Y = r4(y0 + y); grow(X, Y); return [X, Y]; };
      for (const r of kids(g, "Row")) {
        const rc = cells(r), t = r.attrs.T, rel = t.startsWith("Rel");
        const x = rel ? +rc.X * w : +rc.X, y = rel ? +rc.Y * h : +rc.Y;
        if (t === "MoveTo" || t === "RelMoveTo") d += ` M${P(x, y)}`;
        else if (t === "EllipticalArcTo" || t === "RelEllipticalArcTo") {
          // Quadratic through the arc's control point: close enough at faceplate scale.
          const ax = rel ? +rc.A * w : +rc.A, ay = rel ? +rc.B * h : +rc.B;
          const [qx, qy] = P(2 * ax - (cur[0] + x) / 2, 2 * ay - (cur[1] + y) / 2);
          d += ` Q${r4(qx)},${r4(qy)} ${P(x, y)}`;
        } else if (t === "Ellipse") {
          const rx = Math.abs(+rc.A - x), ry = Math.abs(+rc.D - y), [cx, cy] = P(x, y);
          P(x - rx, y - ry); P(x + rx, y + ry);
          d += ` M${r4(cx - rx)},${cy} a${r4(rx)},${r4(ry)} 0 1,0 ${r4(2 * rx)},0 a${r4(rx)},${r4(ry)} 0 1,0 ${r4(-2 * rx)},0`;
          continue;
        } else if (/To$/.test(t) || t === "SplineKnot" || t === "SplineStart" || t === "PolylineTo") {
          if (t !== "LineTo" && t !== "RelLineTo") notes.add(`${t} as line`);
          d += ` L${P(x, y)}`;
        } else continue;
        cur = [x, y];
      }
      if (d) items.push({ d: d.trim(), fill: gc.NoFill === "1" ? null : fill, stroke: gc.NoLine === "1" ? null : stroke });
    }
    for (const sub of kids(kid(shape, "Shapes"), "Shape")) visit(sub, x0, y0);
  };
  for (const s of kids(shapes, "Shape")) visit(s, 0, 0);
  const drawn = items.filter((i) => i.image || i.fill || i.stroke);
  if (!drawn.length || !(box[2] > box[0]) || !(box[3] > box[1])) return null;
  const W = box[2] - box[0], H = box[3] - box[1], sw = r4(H / 120);
  // Visio y runs up: draw in a flipped group, and un-flip each image.
  const body = drawn.map((i) => i.image
    ? `<image x="${r4(i.x)}" y="${r4(-i.y - i.h)}" width="${r4(i.w)}" height="${r4(i.h)}" preserveAspectRatio="none" transform="scale(1,-1)" href="${i.image}"/>`
    : `<path d="${i.d}" fill="${i.fill ?? "none"}" stroke="${i.stroke ?? "none"}" stroke-width="${sw}"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r4(box[0])} ${r4(-box[3])} ${r4(W)} ${r4(H)}"><g transform="scale(1,-1)">${body}</g></svg>`;
  return { href: svgHref(svg), aspect: W / H, kind: usedForeign ? "emf" : "geometry", note: notes.size ? `not drawn: ${[...notes].join(", ")}` : null };
}
