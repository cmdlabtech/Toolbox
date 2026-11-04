// Tiny XML reader for Visio package parts. Elements and attributes only; text
// nodes, comments, processing instructions and CDATA are skipped. Works the
// same in the browser and in Node, so the import is testable without a DOM.

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescape = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
  e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e] ?? m);

export function parseXml(text) {
  const root = { name: "#root", attrs: {}, children: [] };
  const stack = [root];
  const tag = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>/g;
  const attr = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (let m; (m = tag.exec(text));) {
    if (!m[2]) continue;
    if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
    const el = { name: m[2].replace(/^\w+:/, ""), attrs: {}, children: [] };
    for (let a; (a = attr.exec(m[3]));) el.attrs[a[1]] = unescape(a[2] ?? a[3]);
    stack[stack.length - 1].children.push(el);
    if (!m[4]) stack.push(el);
  }
  return root;
}

export const kids = (el, name) => (el?.children ?? []).filter((c) => c.name === name);
export const kid = (el, name) => (el?.children ?? []).find((c) => c.name === name) ?? null;
