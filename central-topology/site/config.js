// API base for the Worker, chosen by the page's host.
// - Local `npm run dev` (wrangler dev): same origin ("").
// - Hosted preview (Pages project central-topology-preview): the preview Worker.
// The Worker's ALLOWED_ORIGINS must list the page origin (see worker/wrangler.toml).
(() => {
  const hosted = {
    "central-topology-preview.pages.dev": "https://central-topology-preview.admin2655.workers.dev",
  };
  window.CT_CONFIG = { apiBase: hosted[location.hostname] ?? "" };
})();
