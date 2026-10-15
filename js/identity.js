/* identity.js — IdentityService (SRS §12, §4.2, FR-01…FR-05 + V2 features)
 *
 * "A user's identity is a cryptographic keypair generated in their browser."
 * ECDSA P-256 via Web Crypto API, both halves exported as JWK and stored in
 * IndexedDB. The private key never leaves the device (FR-03, NFR-03).
 *
 * V2 additions (beyond SRS v2.3, user-specified):
 *   - getMyPrivateKeyString()  — raw private key JWK string, the passphrase
 *     used to derive the backup encryption key (Settings → COPY PRIVATE KEY)
 *   - validateKeyPair()        — ECDSA sign/verify round-trip proving a
 *     private JWK and public JWK belong to the same keypair (import gate)
 *   - replaceIdentity()        — overwrite the identity record from an
 *     imported backup (Import Identity feature)
 *   - regenerateIdentity()     — fresh ECDSA keypair + clear identity and
 *     known_peers (Regenerate Identity feature; irreversible by design)
 */

import { tx, reqAsPromise, openDB } from "./db.js";
import { nowISO, isValidPublicJwk } from "./utils.js";

const ECDSA_ALG = { name: "ECDSA", namedCurve: "P-256" };
const IDENTITY_KEY = "identity"; // out-of-line key of the single record

let cachedIdentity = null;

/* E-09 — if IndexedDB is unavailable the identity lives in memory only
 * (regenerated next launch; the banner explains the data loss risk). */
async function tryStorePut(record) {
  try {
    await tx("identity", "readwrite", (store) => store.put(record, IDENTITY_KEY));
  } catch (err) {
    console.warn("[identity] store write failed (degraded mode)", err);
  }
}

/** UC-01 — first launch: generate the keypair, store JWKs, return record.
 *  UC-02 — subsequent launch: load from IndexedDB. */
export async function initIdentity() {
  const existing = await loadIdentity();
  if (existing) {
    cachedIdentity = existing;
    return existing;
  }

  /* SRS §4.2 — extractable so we can export to JWK for IndexedDB storage */
  const keypair = await crypto.subtle.generateKey(ECDSA_ALG, true, [
    "sign",
    "verify",
  ]);

  const publicKeyJwk = await crypto.subtle.exportKey("jwk", keypair.publicKey);
  const privateKeyJwk = await crypto.subtle.exportKey(
    "jwk",
    keypair.privateKey
  );

  const record = {
    public_key: publicKeyJwk,
    private_key: privateKeyJwk,
    created_at: nowISO(),
  };

  await tryStorePut(record);

  cachedIdentity = record;
  return record;
}

async function loadIdentity() {
  try {
    await openDB();
    return await tx("identity", "readonly", (store) => reqAsPromise(store.get(IDENTITY_KEY)));
  } catch {
    return null; // degraded mode — no persisted identity
  }
}

export function getIdentity() {
  if (!cachedIdentity) throw new Error("identity not initialised");
  return cachedIdentity;
}

/** My public key as JWK — the shareable address (FR-04). */
export function getMyPublicKeyJwk() {
  return getIdentity().public_key;
}

/** Import my private key for signing — kept available for future use;
 *  V1 has no signing operations (identity is possession of the keypair). */
export async function importMyPrivateKey() {
  return crypto.subtle.importKey(
    "jwk",
    getIdentity().private_key,
    ECDSA_ALG,
    false,
    ["sign"]
  );
}

/** Import any ECDSA public JWK (verification side, kept symmetric). */
export async function importPublicJwk(jwk) {
  return crypto.subtle.importKey("jwk", jwk, ECDSA_ALG, false, ["verify"]);
}

/** Import any ECDSA private JWK (signing side). Extractable so imported
 *  identities keep the export ability (import-service uses this for the
 *  sign/verify consistency check of a restored backup). */
async function importPrivateJwk(jwk) {
  return crypto.subtle.importKey("jwk", jwk, ECDSA_ALG, true, ["sign"]);
}

/* ====================== V2 — backup identity features ==================== */

/** My private key as a raw JSON string — V2 "the private key string".
 *  This is the passphrase that derives the backup encryption key and the
 *  string the COPY PRIVATE KEY button places on the clipboard. */
export function getMyPrivateKeyString() {
  return JSON.stringify(getIdentity().private_key);
}

/** Minimal structural check of a private JWK (EC P-256 with a secret `d`). */
export function isValidPrivateJwk(jwk) {
  return Boolean(
    jwk &&
      typeof jwk === "object" &&
      jwk.kty === "EC" &&
      jwk.crv === "P-256" &&
      typeof jwk.x === "string" &&
      jwk.x.length > 0 &&
      typeof jwk.y === "string" &&
      jwk.y.length > 0 &&
      typeof jwk.d === "string" &&
      jwk.d.length > 0
  );
}

/**
 * Prove that a private JWK and a public JWK form ONE keypair: sign a fresh
 * random challenge with the private half and verify the signature with the
 * public half. A mismatched pair (or a corrupt key) fails verification.
 * This is the cryptographic gate every imported backup must pass — it
 * guarantees the restored identity is internally consistent.
 */
export async function validateKeyPair(privateKeyJwk, publicKeyJwk) {
  if (!isValidPrivateJwk(privateKeyJwk) || !isValidPublicJwk(publicKeyJwk)) {
    return false;
  }
  try {
    const priv = await importPrivateJwk(privateKeyJwk);
    const pub = await importPublicJwk(publicKeyJwk);
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      priv,
      challenge
    );
    return crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pub,
      signature,
      challenge
    );
  } catch {
    return false;
  }
}

/** Overwrite the identity record from an imported backup (Import Identity).
 *  Writes to IndexedDB then refreshes the in-memory cache. */
export async function replaceIdentity(record) {
  await tx("identity", "readwrite", (store) => store.put(record, IDENTITY_KEY));
  cachedIdentity = record;
  return record;
}

/**
 * Regenerate Identity (V2) — generate a FRESH ECDSA keypair, replace the
 * identity record, and clear the known_peers store.
 *
 * IRREVERSIBLE BY DESIGN: the old public key address is permanently lost —
 * peers who only know the old key can never be reached on it again. The
 * caller (Settings UI) must have shown the confirmation warning first.
 *
 * What is cleared : identity (replaced), known_peers (cleared).
 * What is kept    : messages (SRS §10.3 philosophy — history is never deleted
 *   except by CLEAR ALL DATA; old threads become unreachable because their
 *   peers are gone, exactly like removing a contact) and preferences/theme
 *   (device-level UI config, not identity data).
 */
export async function regenerateIdentity() {
  const keypair = await crypto.subtle.generateKey(ECDSA_ALG, true, [
    "sign",
    "verify",
  ]);
  const publicKeyJwk = await crypto.subtle.exportKey("jwk", keypair.publicKey);
  const privateKeyJwk = await crypto.subtle.exportKey(
    "jwk",
    keypair.privateKey
  );
  const record = {
    public_key: publicKeyJwk,
    private_key: privateKeyJwk,
    created_at: nowISO(),
  };

  /* Replace identity and wipe known_peers. Memory fallback of known-peers
   * is refreshed by the reload that follows in the UI flow. */
  await replaceIdentity(record);
  await tx("known_peers", "readwrite", (store) => store.clear());
  return record;
}
