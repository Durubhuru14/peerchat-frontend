/* message-store.js — MessageStore (SRS §12, §11)
 *
 * Message record (§11):
 *   id        "sender_public_key + timestamp + random"  (in-line key)
 *   content   plaintext — encryption is for transit only (§4.6)
 *   timestamp ISO
 *   sender    sender's public key (JWK string)
 *   peer      the OTHER party's public key (JWK string) — both sent and
 *             received messages of one thread share this value
 *   status    "local_only" | "seeded"
 *
 * UC-06: sent  → status local_only (never updated later — C-08).
 * UC-07: received (live or history-seeded) → status seeded.
 * History queries go through the by-peer index; render order sorts by
 * timestamp. Insert-if-absent powers the seeding merge (FR-23).
 */

import { tx, reqAsPromise } from "./db.js";
import { nowISO } from "./utils.js";

/* E-09 fallback — volatile message list when IndexedDB is unavailable
 * (NFR-12): chats still work, nothing persists, the banner explains it. */
const memoryMessages = [];

function makeId(senderKeyString) {
  const random = crypto.getRandomValues(new Uint8Array(6));
  const rand = [...random].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${senderKeyString}+${nowISO()}+${rand}`;
}

/** Save a locally-sent message (UC-06 step 4). */
export async function addLocalMessage({ content, timestamp, sender, peer }) {
  const record = {
    id: makeId(sender),
    content,
    timestamp: timestamp || nowISO(),
    sender,
    peer,
    status: "local_only",
  };
  memoryMessages.push(record);
  try {
    await tx("messages", "readwrite", (store) => store.put(record));
  } catch {
    /* degraded mode — memory copy already recorded */
  }
  return record;
}

/**
 * Insert a received/seeding record ONLY if its id is not already present
 * (dedup merge for FR-23 — the offerer seeds the full thread, most of which
 * the answerer already owns). Returns the stored record, or null when the
 * message already existed (nothing stored, nothing to render).
 */
export async function addSeededIfAbsent(record) {
  const existingMemory = memoryMessages.find((m) => m.id === record.id);
  if (existingMemory) return null;
  try {
    return await tx("messages", "readwrite", (store, t) => {
      return new Promise((resolve, reject) => {
        const getReq = store.get(record.id);
        getReq.onsuccess = () => {
          if (getReq.result) {
            resolve(null); // already have it — keep our local copy verbatim
            return;
          }
          const putReq = store.put(record);
          putReq.onsuccess = () => {
            memoryMessages.push(record);
            resolve(record);
          };
          putReq.onerror = () => reject(putReq.error);
        };
        getReq.onerror = () => reject(getReq.error);
      });
    });
  } catch {
    /* degraded mode — keep a volatile copy so the thread still renders */
    memoryMessages.push(record);
    return record;
  }
}

/** Full history for one peer, oldest first (NFR-07 — indexed query). */
export async function getHistoryFor(peerKeyString) {
  let records;
  try {
    records = await tx("messages", "readonly", (store) => {
      const index = store.index("by-peer");
      return reqAsPromise(index.getAll(peerKeyString));
    });
  } catch {
    records = memoryMessages.filter((m) => m.peer === peerKeyString);
  }
  records.sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0
  );
  return records;
}

/** Everything — used by the export service (UC-08). */
export async function getAllMessages() {
  let records;
  try {
    records = await tx("messages", "readonly", (store) =>
      reqAsPromise(store.getAll())
    );
  } catch {
    records = [...memoryMessages];
  }
  records.sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0
  );
  return records;
}

/** Count of stored messages for a peer — first-launch banner logic. */
export async function countMessagesFor(peerKeyString) {
  const records = await getHistoryFor(peerKeyString);
  return records.length;
}
