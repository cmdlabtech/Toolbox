// View preferences. One JSON localStorage load/save path for the controls
// the page already keeps (layout, theme, management IP) and for whether
// access-layer LLDP neighbors are drawn. `storage` is localStorage or a
// test double with getItem/setItem.

export const UI_KEYS = {
  overrides: "ct-overrides",
  mgmt: "ct-mgmt",
  theme: "ct-theme",
  layout: "ct-layout",
  positions: "ct-positions",
  showAccessNeighbors: "ct-show-access-neighbors",
};

export function loadPref(storage, key, fallback) {
  try {
    const raw = storage.getItem(key);
    if (raw == null) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

export function savePref(storage, key, value) {
  storage.setItem(key, JSON.stringify(value));
}

/** Missing showAccessNeighbors stays on. */
export function readUiPrefs(storage) {
  const show = loadPref(storage, UI_KEYS.showAccessNeighbors, true);
  return {
    layout: loadPref(storage, UI_KEYS.layout, "hub"),
    mgmt: loadPref(storage, UI_KEYS.mgmt, "monitor"),
    theme: loadPref(storage, UI_KEYS.theme, "light"),
    showAccessNeighbors: show !== false,
  };
}

export function writeUiPref(storage, name, value) {
  const key = UI_KEYS[name];
  if (!key) throw new Error(`Unknown UI pref: ${name}`);
  savePref(storage, key, value);
}
