// Imported stencils live on this device only, in IndexedDB. Nothing here
// talks to the Worker: the .vssx is parsed in the page and stays in the page.
const DB = "central-topology", STORE = "stencils";

function open(idb = indexedDB) {
  return new Promise((resolve, reject) => {
    const r = idb.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "sku" });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function tx(mode, fn, idb) {
  const db = await open(idb);
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode), s = t.objectStore(STORE);
      const out = fn(s);
      t.oncomplete = () => resolve(out?.result ?? out);
      t.onerror = t.onabort = () => reject(t.error);
    });
  } finally { db.close(); }
}

/** Add or replace stencils (keyed by part number). */
export const saveStencils = (list, idb) => tx("readwrite", (s) => { for (const x of list) s.put(x); }, idb);
export const loadStencils = (idb) => tx("readonly", (s) => s.getAll(), idb);
export const clearStencils = (idb) => tx("readwrite", (s) => { s.clear(); }, idb);
