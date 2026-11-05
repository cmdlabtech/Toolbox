// Topology load phases. Each one is a real step the page waits on; there is
// no percentage because the Worker answers /api/topology in one response.
export const PHASES = {
  connecting: "Connecting to Central…",
  fetching: "Fetching sites, switches and links (LLDP)…",
  reading: "Reading switches…",
  layout: "Laying out…",
  sample: "Building sample topology…",
};

/**
 * A loader on one status element. phase(id) shows the spinner and label;
 * done(msg) and fail(msg) stop it and show plain status text (fail in the
 * existing error style). Phases after done/fail are ignored.
 */
export function createLoader(el) {
  let active = false;
  const show = (text, cls) => { el.textContent = text; el.className = cls; };
  return {
    get active() { return active; },
    get current() { return el.dataset.phase ?? null; },
    start() { active = true; },
    phase(id) {
      if (!active || !PHASES[id]) return;
      el.dataset.phase = id;
      el.setAttribute("aria-busy", "true");
      el.textContent = "";
      const dot = el.ownerDocument.createElement("span");
      dot.className = "ld-spin"; dot.setAttribute("aria-hidden", "true");
      el.append(dot, PHASES[id]);
      el.className = "loading";
    },
    done(msg = "") { active = false; delete el.dataset.phase; el.removeAttribute("aria-busy"); show(msg, ""); },
    fail(msg) { active = false; delete el.dataset.phase; el.removeAttribute("aria-busy"); show(msg, "err"); },
  };
}
