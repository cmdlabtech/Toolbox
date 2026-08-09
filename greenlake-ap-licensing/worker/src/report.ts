// Standalone HTML report generator. The template embeds the correlated
// dataset as JSON and renders entirely client-side, so the downloaded copy
// works anywhere with no server. Port of glc/report.py.

import template from "./report-template.html";

export function renderReport(data: unknown): string {
  let payload = JSON.stringify(data);
  // keep the embedded JSON from terminating the <script> block early
  payload = payload.replaceAll("</", "<\\/");
  // function replacement avoids $-pattern interpretation in String.replace
  return template.replace("__DATA__", () => payload);
}
