/* export-service.js — ExportService (SRS §12, FR-29…FR-32, UC-08 + V2 encryption)
 *
 * Reads identity, contacts, messages and preferences from IndexedDB,
 * serialises them to JSON, ENCRYPTS the document with a key derived from the
 * user's private key string (V2 requirement — see backup-crypto.js), and
 * downloads the encrypted envelope as a timestamped JSON file (FR-31).
 * Manual export keeps data ownership with the user — there is no cloud
 * backup by design (SRS §14).
 *
 * V1→V2 change: the downloaded file no longer contains the private key (or
 * anything else) in plaintext. Restoring the file requires the private key
 * string from the device that created it — that key is available via the
 * COPY PRIVATE KEY button in Settings, and is the ONLY passphrase that can
 * decrypt the envelope.
 *
 * The inner document (before encryption) is unchanged from V1:
 *   { app, version, srs, exported_at, identity, known_peers, messages,
 *     preferences }
 * so an imported backup restores exactly what V1 exported.
 */

import { tx, reqAsPromise } from "./db.js";
import { nowISO } from "./utils.js";
import { encryptBackupDocument } from "./backup-crypto.js";

/** Read every store and build the INNER (pre-encryption) document. */
export async function collectBackupDocument() {
  const [identity, peerRecords, peerKeys, messages, preferences] =
    await Promise.all([
      tx("identity", "readonly", (s) => reqAsPromise(s.get("identity"))),
      tx("known_peers", "readonly", (s) => reqAsPromise(s.getAll())),
      tx("known_peers", "readonly", (s) => reqAsPromise(s.getAllKeys())),
      tx("messages", "readonly", (s) => reqAsPromise(s.getAll())),
      tx("preferences", "readonly", (s) => reqAsPromise(s.get("app"))),
    ]);

  const known_peers = peerRecords.map((r, i) => ({
    key: peerKeys[i], // the JSON.stringify(JWK) out-of-line key (§11)
    public_key: r.public_key,
    nickname: r.nickname,
    added_at: r.added_at,
    last_seen: r.last_seen,
  }));

  return {
    app: "p2p-decentralised-chat",
    version: 2,
    srs: "2.3",
    exported_at: nowISO(),
    identity: identity
      ? { public_key: identity.public_key, private_key: identity.private_key, created_at: identity.created_at }
      : null,
    known_peers,
    messages,
    preferences: preferences || null,
  };
}

/**
 * UC-08 (V2) — export everything as an ENCRYPTED, timestamped JSON file.
 * The passphrase is the caller's private key string (main.js supplies it
 * from the live identity — the user never types it for export).
 *
 * @param {string} privateKeyString  JSON.stringify(privateKeyJWK) — passphrase
 * @returns {Promise<string>} the downloaded filename
 */
export async function exportAllData(privateKeyString) {
  if (typeof privateKeyString !== "string" || privateKeyString.length === 0) {
    throw new Error("private key string required to encrypt the backup");
  }

  const doc = await collectBackupDocument();
  const envelope = await encryptBackupDocument(doc, privateKeyString);

  /* FR-32 — filename includes a timestamp (filesystem-safe form). */
  const stamp = nowISO().replace(/[:.]/g, "-");
  const filename = `p2p-chat-backup-${stamp}.json`;

  const blob = new Blob([JSON.stringify(envelope, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);

  return filename;
}
