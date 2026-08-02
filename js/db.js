/* db.js — IndexedDB access layer.
 *
 * SRS §11 Data Model — four stores:
 *   identity     : single record, out-of-line key "identity"
 *                  { public_key, private_key, created_at }
 *   known_peers  : NO keyPath (SRS §15.1 binding decision) — records are
 *                  written with an explicit out-of-line STRING key equal to
 *                  JSON.stringify(publicKeyJWK). A plain JWK object is not a
 *                  valid IndexedDB key and causes DataError on put().
 *   messages     : keyPath "id" (sender public key + timestamp + random),
 *                  indexes on "peer" and "timestamp" for history queries.
 *   preferences  : single record, out-of-line key "app" (theme selection).
 *
 * DB version 2 — the v1→v2 migration deletes and recreates known_peers
 * without keyPath exactly as SRS §11 specifies.
 *
 * NFR-12 / E-09: if IndexedDB is unavailable the app continues in degraded
 * mode without writes — open() rejects and callers handle it.
 */

const DB_NAME = "p2p-chat";
const DB_VERSION = 2;

let dbPromise = null;
let degraded = false;

export function isDegraded() {
  return degraded;
}

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      degraded = true;
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = event.oldVersion;

      /* ---- v1 → v2 migration (SRS §11 / §15.1) -------------------------
       * The old schema used keyPath: 'public_key' on known_peers, which
       * causes DataError because a JWK object is not a valid key. Delete
       * the store and recreate it WITHOUT keyPath. Data in the old store
       * was unreachable by the buggy key scheme anyway. */
      if (oldVersion >= 1 && oldVersion < 2) {
        if (db.objectStoreNames.contains("known_peers")) {
          db.deleteObjectStore("known_peers");
        }
      }

      if (!db.objectStoreNames.contains("identity")) {
        db.createObjectStore("identity"); // out-of-line keys
      }
      if (!db.objectStoreNames.contains("known_peers")) {
        db.createObjectStore("known_peers"); // NO keyPath (§15.1)
      }
      if (!db.objectStoreNames.contains("messages")) {
        const msgs = db.createObjectStore("messages", { keyPath: "id" });
        msgs.createIndex("by-peer", "peer", { unique: false });
        msgs.createIndex("by-time", "timestamp", { unique: false });
      }
      if (!db.objectStoreNames.contains("preferences")) {
        db.createObjectStore("preferences"); // out-of-line keys
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      degraded = true;
      reject(req.error || new Error("IndexedDB open failed"));
    };
    req.onblocked = () => {
      /* Another tab holds an older DB version open — surface as error. */
      degraded = true;
      reject(new Error("IndexedDB blocked by another tab"));
    };
  });
  return dbPromise;
}

/** Promise wrapper around a single-store transaction. */
export async function tx(storeName, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    let result;
    try {
      result = fn(store, t);
    } catch (err) {
      reject(err);
      return;
    }
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("transaction aborted"));
  });
}

/** Promise wrapper for a single IDBRequest. */
export function reqAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Wipe every store (Danger Zone, §10.4). Deletes the database itself. */
export async function deleteDatabase() {
  const db = await openDB();
  db.close();
  dbPromise = null;
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve(); // proceed; the close() above normally avoids this
  });
}
