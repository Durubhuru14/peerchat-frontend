/* import-service.js — ImportService (V2 feature: Import Identity)
 *
 * V2 requirement (beyond SRS v2.3, user-specified):
 *   "Allow a user to import a previously exported JSON file to restore their
 *    identity (keypair + known peers + message history) on a new device.
 *    This is the counterpart to the existing export feature. On import, the
 *    user must paste their private key to decrypt the file."
 *
 * Pipeline:
 *   1. readBackupFile(file)        — File → text → parsed JSON
 *   2. inspectBackup(parsed)       — detect encrypted v2 envelope vs legacy
 *                                    plaintext V1 export vs foreign file
 *   3. unlockBackup(parsed, key)   — decrypt the envelope with the pasted
 *                                    private key string (wrong key ⇒ GCM
 *                                    authentication failure)
 *   4. validateBackup(doc)         — structural checks + ECDSA sign/verify
 *                                    keypair consistency gate
 *   5. restoreBackup(doc)          — REPLACE identity, known_peers, messages
 *                                    and preferences in IndexedDB, then the
 *                                    caller reloads the app
 *
 * Restore is REPLACE semantics, not merge: an import on a new device brings
 * the device to exactly the state of the export. The UI warns that current
 * data on this device will be replaced before restore runs.
 */

import { tx, reqAsPromise, isDegraded } from "./db.js";
import { jwkToString, isValidPublicJwk, stringToJwk } from "./utils.js";
import { isEncryptedBackupEnvelope, decryptBackupEnvelope } from "./backup-crypto.js";
import { validateKeyPair, replaceIdentity } from "./identity.js";

/* ---------------------------- 1. read the file ---------------------------- */

/** Read a chosen File object as text (UTF-8). Throws on read failure. */
export function readBackupFile(file) {
  return file.text().then((text) => text.trim());
}

/* --------------------------- 2. detect the format -------------------------- */

/**
 * @param {*} parsed — a parsed JSON value
 * @returns {{ kind: "encrypted" | "legacy" | "unknown", label: string }}
 */
export function inspectBackup(parsed) {
  if (isEncryptedBackupEnvelope(parsed)) {
    return {
      kind: "encrypted",
      label: `ENCRYPTED BACKUP V2 — EXPORTED ${parsed.exported_at || "?"}`,
    };
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    parsed.app === "p2p-decentralised-chat" &&
    (parsed.version === 1 || parsed.version === 2) &&
    "identity" in parsed &&
    Array.isArray(parsed.known_peers) &&
    Array.isArray(parsed.messages)
  ) {
    return {
      kind: "legacy",
      label: `UNENCRYPTED V1 EXPORT — EXPORTED ${parsed.exported_at || "?"}`,
    };
  }
  return { kind: "unknown", label: "NOT A PEERCHAT BACKUP FILE" };
}

/* --------------------------- 3. unlock / decrypt --------------------------- */

/**
 * Validate a pasted passphrase as a private key string and unlock the backup.
 * @param {object} parsed    the parsed envelope
 * @param {string} pastedKey the raw pasted private key string (JWK JSON)
 * @returns {Promise<object>} the inner backup document
 * @throws Error with a user-facing message on failure
 */
export async function unlockBackup(parsed, pastedKey) {
  const trimmed = (pastedKey || "").trim();
  if (!trimmed) {
    throw new Error("PASTE THE PRIVATE KEY (JWK STRING) TO DECRYPT THE FILE.");
  }
  const jwk = stringToJwk(trimmed);
  if (!jwk || jwk.kty !== "EC" || !jwk.d) {
    throw new Error("THAT IS NOT A VALID ECDSA PRIVATE KEY STRING.");
  }
  try {
    return await decryptBackupEnvelope(parsed, trimmed);
  } catch {
    /* GCM authentication failed — wrong private key or a corrupt file. */
    throw new Error(
      "DECRYPTION FAILED — WRONG PRIVATE KEY OR CORRUPT FILE."
    );
  }
}

/* ------------------------------ 4. validation ------------------------------ */

/**
 * Structural + cryptographic validation of an inner backup document.
 * @returns {{ ok: boolean, error?: string, summary: { peers: number,
 *            messages: number, created_at: string|null } }}
 */
export async function validateBackup(doc) {
  if (!doc || typeof doc !== "object" || doc.app !== "p2p-decentralised-chat") {
    return { ok: false, error: "NOT A PEERCHAT BACKUP DOCUMENT." };
  }
  const identity = doc.identity;
  if (!identity || !isValidPublicJwk(identity.public_key)) {
    return { ok: false, error: "BACKUP HAS NO VALID IDENTITY." };
  }
  if (!identity.private_key || identity.private_key.d === undefined) {
    return { ok: false, error: "BACKUP IDENTITY HAS NO PRIVATE KEY." };
  }
  if (!Array.isArray(doc.known_peers)) {
    return { ok: false, error: "BACKUP CONTACTS SECTION IS CORRUPT." };
  }
  if (!Array.isArray(doc.messages)) {
    return { ok: false, error: "BACKUP MESSAGE HISTORY IS CORRUPT." };
  }
  for (const p of doc.known_peers) {
    if (!p || !isValidPublicJwk(p.public_key)) {
      return { ok: false, error: "A BACKED-UP CONTACT HAS AN INVALID PUBLIC KEY." };
    }
  }
  for (const m of doc.messages) {
    if (!m || typeof m.id !== "string" || typeof m.content !== "string" ||
        typeof m.sender !== "string" || typeof m.peer !== "string") {
      return { ok: false, error: "A BACKED-UP MESSAGE RECORD IS CORRUPT." };
    }
  }

  /* The cryptographic gate — sign a challenge with the backup's private key,
   * verify with the backup's public key. A mismatched pair is rejected. */
  const consistent = await validateKeyPair(identity.private_key, identity.public_key);
  if (!consistent) {
    return { ok: false, error: "BACKUP KEYPAIR IS INCONSISTENT — REFUSING TO RESTORE." };
  }

  return {
    ok: true,
    summary: {
      peers: doc.known_peers.length,
      messages: doc.messages.length,
      created_at: identity.created_at || null,
    },
  };
}

/* ------------------------------- 5. restore -------------------------------- */

/**
 * REPLACE the local state with the backup contents:
 *   identity     ← backup identity (keypair + created_at)
 *   known_peers  ← backup contacts (clear + write, out-of-line string keys)
 *   messages     ← backup history  (clear + write, in-line id keys)
 *   preferences  ← backup theme    (clear + write)
 *
 * Peer keys: the explicit `key` string from the export is authoritative —
 * message records reference peers by exactly that string, so preserving it
 * keeps threads linked to contacts. When absent, recompute from the JWK.
 *
 * @returns {Promise<{peers:number, messages:number}>} restore summary
 */
export async function restoreBackup(doc) {
  if (isDegraded()) {
    throw new Error("LOCAL STORAGE UNAVAILABLE — CANNOT RESTORE A BACKUP HERE.");
  }

  const identityRecord = {
    public_key: doc.identity.public_key,
    private_key: doc.identity.private_key,
    created_at: doc.identity.created_at || new Date().toISOString(),
  };

  const peers = doc.known_peers.map((p) => {
    const key =
      typeof p.key === "string" && p.key.length > 0
        ? p.key
        : jwkToString(p.public_key);
    return {
      key,
      record: {
        public_key: p.public_key,
        nickname: typeof p.nickname === "string" ? p.nickname : null,
        added_at: p.added_at || new Date().toISOString(),
        last_seen: p.last_seen || null,
      },
    };
  });

  /* Clear, then write — all inside the awaited transaction helpers. */
  await tx("known_peers", "readwrite", (store) => store.clear());
  await tx("messages", "readwrite", (store) => store.clear());
  await tx("preferences", "readwrite", (store) => store.clear());

  for (const { key, record } of peers) {
    await tx("known_peers", "readwrite", (store) => store.put(record, key));
  }
  for (const m of doc.messages) {
    await tx("messages", "readwrite", (store) =>
      store.put({
        id: m.id,
        content: m.content,
        timestamp: m.timestamp || new Date().toISOString(),
        sender: m.sender,
        peer: m.peer,
        status: m.status === "seeded" ? "seeded" : "local_only",
      })
    );
  }
  if (doc.preferences && typeof doc.preferences === "object") {
    await tx("preferences", "readwrite", (store) =>
      store.put(doc.preferences, "app")
    );
  }

  await replaceIdentity(identityRecord);

  return { peers: peers.length, messages: doc.messages.length };
}
