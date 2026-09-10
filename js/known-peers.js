/* known-peers.js — KnownPeers service (SRS §12, §5.2, §11, §15.1)
 *
 * All store operations use JSON.stringify(publicKeyJWK) as the explicit
 * out-of-line STRING key (FR-08, §15.1 binding):
 *
 *     const keyString = JSON.stringify(publicKeyJWK);
 *     store.put(record, keyString);   // write
 *     store.get(keyString);           // read
 *     store.delete(keyString);        // delete
 *
 * The store itself was created WITHOUT keyPath and autoIncrement (db.js).
 * Nicknames are local-only labels and are never transmitted (FR-07).
 * getPublicKeyFingerprint() is exposed for the auto-add flow (FR-15b).
 */

import { tx, reqAsPromise } from "./db.js";
import { jwkToString, getPublicKeyFingerprint, nowISO } from "./utils.js";

/* E-09 fallback — if IndexedDB is unavailable, contacts live in a memory
 * map for the session (NFR-12: inform the user, do not attempt writes). */
const memoryPeers = new Map();

async function safeRead(keyString) {
  try {
    return await tx("known_peers", "readonly", (store) =>
      reqAsPromise(store.get(keyString)));
  } catch {
    return memoryPeers.get(keyString) || null;
  }
}

async function safeWrite(keyString, record) {
  memoryPeers.set(keyString, record);
  await tx("known_peers", "readwrite", (store) => store.put(record, keyString));
}

export async function addPeer(publicKeyJwk, nickname = null) {
  const keyString = jwkToString(publicKeyJwk);
  const record = {
    public_key: publicKeyJwk,
    nickname: nickname || null,
    added_at: nowISO(),
    last_seen: null,
  };
  await safeWrite(keyString, record);
  return record;
}

export async function getPeer(publicKeyJwk) {
  return safeRead(jwkToString(publicKeyJwk));
}

/** FR-15 — the known_peers check that gates every inbound knock. */
export async function hasPeer(publicKeyJwk) {
  const record = await getPeer(publicKeyJwk);
  return Boolean(record);
}

/**
 * FR-15b (v2.3) — auto-add an unknown knocker using their key fingerprint
 * as the default nickname. Rejects (throws) if the IndexedDB write fails —
 * the caller must handle E-12 (auto-add failure → drop the connection).
 */
export async function autoAddPeer(publicKeyJwk) {
  const fingerprint = await getPublicKeyFingerprint(publicKeyJwk);
  const record = await addPeer(publicKeyJwk, fingerprint);
  return record;
}

export async function removePeer(publicKeyJwk) {
  const keyString = jwkToString(publicKeyJwk);
  memoryPeers.delete(keyString);
  await tx("known_peers", "readwrite", (store) => store.delete(keyString));
}

/** Peer records with their out-of-line keys attached as `_key`. */
export async function listPeers() {
  try {
    const [records, keys] = await Promise.all([
      tx("known_peers", "readonly", (store) => reqAsPromise(store.getAll())),
      tx("known_peers", "readonly", (store) =>
        reqAsPromise(store.getAllKeys())
      ),
    ]);
    return records.map((r, i) => ({ ...r, _key: keys[i] }));
  } catch {
    return [...memoryPeers.entries()].map(([k, r]) => ({ ...r, _key: k }));
  }
}

export async function updateNickname(publicKeyJwk, nickname) {
  const keyString = jwkToString(publicKeyJwk);
  const record = await getPeer(publicKeyJwk);
  if (!record) return null;
  record.nickname = nickname.trim() ? nickname.trim() : null;
  await safeWrite(keyString, record);
  return record;
}

/** Touch last_seen on session events (connect / disconnect). */
export async function touchLastSeen(publicKeyJwk) {
  const keyString = jwkToString(publicKeyJwk);
  const record = await getPeer(publicKeyJwk);
  if (!record) return;
  record.last_seen = nowISO();
  await safeWrite(keyString, record);
}

export { getPublicKeyFingerprint };
