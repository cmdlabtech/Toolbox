// The interactive HTML export is one offline file: the view's SVG inline,
// with inline CSS and script. No network requests, no secrets, names escaped.
import test from "node:test";
import assert from "node:assert/strict";
import { buildModel } from "../site/js/model.js";
import { LAYOUTS, layoutById } from "../site/js/layout.js";
import { TOKEN_NAMES, renderSvg } from "../site/js/render.js";
import { htmlExport } from "../site/js/export.js";
import { sampleWithStack } from "./stack-sample.mjs";

const TOKENS = Object.fromEntries(TOKEN_NAMES.map((t) => [t, "#123456"]));
const EVIL = `<img src=x onerror=alert(1)></script><script>alert(2)</script>`;
const data = sampleWithStack();
data.switches[3].name = EVIL;
const model = buildModel(data, { coreSerial: data.coreSerial, switches: {} });
const stack = model.nodes.find((n) => n.stack?.length > 1);
const subtitle = `${model.nodes.length} switches · ${model.buildings.length} buildings · ${EVIL}`;

const exportOf = (id) => {
  const svg = renderSvg(model, layoutById(id, model), { tokens: TOKENS, title: "Switch topology", subtitle, badges: false });
  return { svg, html: htmlExport(svg, { title: "Switch topology", subtitle, tokens: TOKENS }) };
};

for (const spec of LAYOUTS) {
  test(`${spec.id}: offline, self-contained, escaped`, () => {
    const { html } = exportOf(spec.id);
    const net = html.replaceAll('xmlns="http://www.w3.org/2000/svg"', "").replaceAll('xmlns:xlink="http://www.w3.org/1999/xlink"', "");
    assert.doesNotMatch(net, /https?:\/\//i, "no URLs");
    assert.doesNotMatch(net, /<[a-z]+[^>]*\s(src|srcset)=/i, "no src attributes");
    assert.doesNotMatch(net, /<link\b|@import|url\(|fetch\(|XMLHttpRequest|import\(|WebSocket|EventSource|sendBeacon/, "no fetches");
    assert.doesNotMatch(net, /\/api\/|workers\.dev|Bearer|client_secret|access_token|"overrides"/i, "no Worker calls or secrets");
    assert.match(html, /default-src 'none'/, "CSP blocks anything that slips through");
    assert.equal((html.match(/<script\b/g) ?? []).length, 1, "only the one inline script");
    assert.equal((html.match(/<svg\b/g) ?? []).length, 1);
    assert.ok(!html.includes(EVIL) && html.includes("&lt;img src=x onerror=alert(1)&gt;&lt;/script&gt;"), "names escaped");
    assert.match(html, /<title>Switch topology · \d+ switches · \d+ buildings/);
    assert.match(html, /<text[^>]*>Switch topology<\/text>/, "title drawn in the SVG like the PNG");
    assert.ok(html.includes(`data-serial="${stack.serial}"`) && /Stack of 3\n {2}1/.test(html), "stack member list in tooltip data");
    assert.match(html, /data-ends="[^"]+\|[^"]+"/, "links carry their ends for highlight");
    assert.match(html, /<title>[^<]*(1\/1\/|eth0)[^<]*<\/title>/, "link port details in tooltip data");
    assert.match(html, /preserveAspectRatio/);
  });
}

test("each export uses that layout's SVG unchanged apart from sizing", () => {
  const { svg, html } = exportOf("structured");
  const inner = svg.replace(/^<svg[^>]*>/, "");
  assert.ok(html.includes(inner));
});
