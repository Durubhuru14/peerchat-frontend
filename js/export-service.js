/* export-service.js — ExportService (SRS §12, FR-29…FR-32, UC-08)
 *
 * Reads identity, contacts, messages and preferences from IndexedDB and
 * produces a timestamped JSON file downloaded directly to the user's device
 * (FR-31). Manual export keeps data ownership with the user — there is no
 * cloud backup by design (§14).
 *
 * NOTE: the export contains the ECDSA PRIVATE key in plaintext (the identity
 * record of §4.6, "browser storage is the boundary"). Losing this file is
 * losing the identity — treat it accordingly.
 */

import { tx, reqAsPromise } from "./db.js";
import { nowISO } from "./utils.js";

export async function exportAllData() {
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

  const doc = {
    app: "p2p-decentralised-chat",
    version: 1,
    srs: "2.3",
    exported_at: nowISO(),
    identity: identity
      ? { public_key: identity.public_key, private_key: identity.private_key, created_at: identity.created_at }
      : null,
    known_peers,
    messages,
    preferences: preferences || null,
  };

  /* FR-32 — filename includes a timestamp (filesystem-safe form). */
  const stamp = nowISO().replace(/[:.]/g, "-");
  const filename = `p2p-chat-export-${stamp}.json`;

  const blob = new Blob([JSON.stringify(doc, null, 2)], {
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
