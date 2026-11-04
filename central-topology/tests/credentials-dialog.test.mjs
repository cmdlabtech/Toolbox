// The credentials form is a modal dialog opened from the header button.
// Behaviour (focus trap, Esc, backdrop, auto-open) is proven in a browser;
// these checks pin the markup and wiring so a refactor cannot drop them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
const html = read("../site/index.html");
const app = read("../site/js/app.js");

test("credentials live in a <dialog> opened by the header button", () => {
  const header = html.slice(html.indexOf("<header>"), html.indexOf("</header>"));
  assert.match(header, /<button id="credsBtn"[^>]*aria-haspopup="dialog"[^>]*aria-controls="credsPanel"/);
  assert.match(html, /<dialog id="credsPanel" class="creds" aria-labelledby="credsTitle">/);
  assert.doesNotMatch(html, /<section id="credsPanel"/);
  assert.match(html, /<button id="cX"[^>]*aria-label="Close"/);
  assert.match(header, /id="connState"/, "status and countdown stay in the header");
});

test("dialog wiring: modal, Esc/close return focus, backdrop closes, Tab wraps", () => {
  assert.match(app, /panel\.showModal\(\)/);
  assert.match(app, /addEventListener\("close", \(\) => \{[^}]*credsBtn"\)\.focus\(\)/);
  assert.match(app, /e\.target === panel && \(e\.clientX < r\.left/);
  assert.match(app, /e\.key !== "Tab"/);
  for (const id of ["cX", "cClose"]) assert.match(app, new RegExp(`\\$\\("${id}"\\)\\.addEventListener\\("click", \\(\\) => togglePanel\\(false\\)\\)`));
});

test("opens on first load without credentials and closes after a successful sign-in", () => {
  assert.match(app, /if \(!vault\.get\(\) && [^\n]*\) togglePanel\(true\);\nrefresh\(\);\n?$/);
  assert.match(app, /if \(await refresh\(\)\) togglePanel\(false\);/);
});
