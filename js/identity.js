/* identity.js — IdentityService (SRS §12, §4.2, FR-01…FR-05)
 *
 * "A user's identity is a cryptographic keypair generated in their browser."
 * ECDSA P-256 via Web Crypto API, both halves exported as JWK and stored in
 * IndexedDB. The private key never leaves the device (FR-03, NFR-03).
 */

import { tx, reqAsPromise, openDB } from "./db.js";
import { nowISO } from "./utils.js";

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
