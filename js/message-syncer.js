/* message-syncer.js — MessageSyncer (SRS §12, FR-23, FR-23a)
 *
 * "On connection the local message history for that peer shall be seeded
 * across."  Direction per SRS §8.2 (v2.3): BILATERAL — BOTH peers seed
 * their copy when the DataChannel opens, so a fresh device on either
 * side recovers the full thread. (V1 seeded offerer → answerer only —
 * documented as limitation L-6, resolved in v2.3.0.)
 *
 * Seeded payloads are encrypted with the session AES-GCM key exactly like
 * live messages (FR-23a); the receiver decrypts and stores them as
 * status "seeded".
 *
 * Merge semantics: each side's copy contains the whole thread (its sent
 * AND its received messages). Both sides already own most of those ids —
 * insertion is idempotent, existing records are never overwritten, and
 * only genuinely-new records are returned for rendering (with the dim
 * [HISTORY] tag, §10.2). A fresh device on either side therefore recovers
 * the full conversation.
 */

import { encryptMessage, decryptMessage } from "./crypto-service.js";
import { getHistoryFor, addSeededIfAbsent } from "./message-store.js";

/**
 * SENDING side (either peer — bilateral since v2.3): send this device's
 * full history for the session peer, encrypted with the session key, as
 * one batch envelope over the DataChannel. Called by PeerConnection right
 * after the channel opens (§8.2) for BOTH roles.
 *
 * @param {PeerConnection} session — the live session (dc, sharedKey, …)
 */
export async function seedHistory(session) {
  const history = await getHistoryFor(session.peerKeyString);
  console.log("[sync] seedHistory:", history.length, "records; dc:", session.dc?.readyState, "key:", Boolean(session.sharedKey), "peer:", session.peerKeyString?.slice(0, 40));
  if (!session.dc || session.dc.readyState !== "open" || !session.sharedKey) {
    return;
  }

  const payload = history.map((r) => ({
    id: r.id,
    content: r.content,
    timestamp: r.timestamp,
    sender: r.sender,
  }));

  const { iv, ct } = await encryptMessage(
    session.sharedKey,
    JSON.stringify(payload)
  );
  session.dc.send(JSON.stringify({ t: "seed", iv, ct }));
  console.log("[sync] seed envelope sent:", payload.length, "records");
}

/**
 * RECEIVING side (either peer — bilateral since v2.3) — decrypt and merge
 * an incoming batch (or a single live message) into the local store.
 * Returns only the records that were NEWLY inserted (for rendering).
 * Decryption happens in PeerConnection before this is called.
 *
 * @param {Array}  payload  decrypted records [{id, content, timestamp, sender}]
 * @param {string} peerKeyString the session peer (other party)
 * @param {string} myKeyString   my own key — used to normalise `sender`
 */
export async function receiveSeed(payload, peerKeyString, myKeyString) {
  if (!Array.isArray(payload)) return [];
  const inserted = [];
  for (const p of payload) {
    if (!p || typeof p.id !== "string" || typeof p.content !== "string") continue;
    const record = {
      id: p.id,
      content: p.content,
      timestamp: p.timestamp || new Date().toISOString(),
      sender: p.sender || peerKeyString,
      peer: peerKeyString,
      status: "seeded", // UC-07 / §11 — received from peer or synced history
    };
    const stored = await addSeededIfAbsent(record);
    if (stored) inserted.push(stored);
  }
  return inserted;
}
