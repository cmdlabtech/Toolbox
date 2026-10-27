// Downloads: SVG (the rendered string), PNG (SVG drawn onto a 2x canvas),
// JSON (model + selected management IPs + overrides).
import { resolveMgmt } from "./model.js";

export function stamp() {
  return new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "").replace(/^(\d{8})/, "$1-");
}

export function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export const svgBlob = (svg) => new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${svg}`], { type: "image/svg+xml" });

export function pngBlob(svg, scale = 2) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(svgBlob(svg));
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = Math.ceil(img.naturalWidth * scale);
      c.height = Math.ceil(img.naturalHeight * scale);
      const ctx = c.getContext("2d");
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encode failed"))), "image/png");
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("SVG could not be rasterized")); };
    img.src = url;
  });
}

export function jsonExport(model, mgmt, overrides, meta) {
  return {
    generatedAt: new Date().toISOString(),
    source: meta,
    mgmtSelection: mgmt,
    districtCore: model.coreSerial,
    buildings: model.buildings.map((b) => ({ name: b, hub: model.hubs[b] ?? null })),
    switches: model.nodes.map((n) => {
      const m = resolveMgmt(n, mgmt);
      return { serial: n.serial, name: n.name, model: n.model, status: n.status, site: n.site, building: n.building,
        role: n.role, roleSource: n.roleSource, hop: n.hop, parent: n.parent, mgmtIp: m.ip, mgmtIpSource: m.source,
        mgmtFallback: m.fallback, flags: n.flags };
    }),
    links: model.edges.map((e) => ({ from: e.from, to: e.to, fromPort: e.fromPort, toPort: e.toPort, source: e.source })),
    overrides,
  };
}
