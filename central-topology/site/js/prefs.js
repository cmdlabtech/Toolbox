// View preferences. One JSON localStorage load/save path for the controls
// the page already keeps (layout, theme, management IP), whether LLDP
// neighbors are drawn, and whether switch-link port labels are drawn.
// `storage` is localStorage or a test double with getItem/setItem.

export const UI_KEYS = {
  overrides: "ct-overrides",
  mgmt: "ct-mgmt",
  theme: "ct-theme",
  layout: "ct-layout",
  positions: "ct-positions",
  showLldpNeighbors: "ct-show-lldp-neighbors",
  showPorts: "ct-ports",
};

/** Previous LLDP toggle key. Read once so a saved on/off choice survives the rename. */
const LLDP_KEY_PREV = "ct-show-access-neighbors";

function readExplicitBool(storage, key) {
  try {
    const raw = storage.getItem(key);
    if (raw == null) return null;
    const parsed = JSON.parse(raw);
    if (parsed === true || parsed === false) return parsed;
    return null;
  } catch {
    return null;
  }
}

function dropKey(storage, key) {
  if (typeof storage.removeItem === "function") storage.removeItem(key);
}

/**
 * LLDP neighbors are hidden unless a saved choice says otherwise.
 * An explicit value under the current key wins. Otherwise an explicit value
 * under the old key is copied forward and the old key is removed.
 */
export function readShowLldpNeighbors(storage) {
  const current = readExplicitBool(storage, UI_KEYS.showLldpNeighbors);
  if (current !== null) {
    dropKey(storage, LLDP_KEY_PREV);
    return current;
  }
  const previous = readExplicitBool(storage, LLDP_KEY_PREV);
  if (previous !== null) {
    storage.setItem(UI_KEYS.showLldpNeighbors, JSON.stringify(previous));
    dropKey(storage, LLDP_KEY_PREV);
    return previous;
  }
  return false;
}

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

/** Missing LLDP choice stays off. An explicit saved choice stays. Missing showPorts stays on. */
export function readUiPrefs(storage) {
  const ports = loadPref(storage, UI_KEYS.showPorts, true);
  return {
    layout: loadPref(storage, UI_KEYS.layout, "hub"),
    mgmt: loadPref(storage, UI_KEYS.mgmt, "monitor"),
    theme: loadPref(storage, UI_KEYS.theme, "light"),
    showLldpNeighbors: readShowLldpNeighbors(storage),
    showPorts: ports !== false,
  };
}

export function writeUiPref(storage, name, value) {
  const key = UI_KEYS[name];
  if (!key) throw new Error(`Unknown UI pref: ${name}`);
  savePref(storage, key, value);
}
