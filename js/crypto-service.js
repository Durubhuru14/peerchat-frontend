/* crypto-service.js — CryptoService (SRS §12, §4.3, §4.4, NFR-01…06)
 *
 * Three concerns, kept separate (SRS §4.1):
 *   identity  → ECDSA keypair       (identity.js)
 *   key agree → ECDH  P-256         (this file)
 *   messages  → AES-GCM 256-bit     (this file)
 *
 * Why two keypairs? ECDSA and ECDH are different key usages in the Web
 * Crypto API and cannot share one keypair (SRS §4.3). The ECDH session
 * keypair is EPHEMERAL: memory only, never persisted, regenerated each
 * session (C-06, NFR-04).
 */

import { b64ToBytes, bytesToB64 } from "./utils.js";

const ECDH_ALG = { name: "ECDH", namedCurve: "P-256" };

/**
 * Generate the per-session ECDH keypair (SRS §4.3).
 * Extractable flag is false for the private half — it never leaves memory.
 * The PUBLIC half is exportable (public keys in a generated pair are always
 * extractable) and travels inside the knock / knock-accepted payload.
 */
export async function generateSessionEcdh() {
  const keypair = await crypto.subtle.generateKey(ECDH_ALG, false, [
    "deriveKey",
  ]);
  const publicKeyJwk = await crypto.subtle.exportKey("jwk", keypair.publicKey);
  return { keypair, publicKeyJwk };
}

/** Import a peer's ECDH session public key (JWK received via signaling). */
export async function importEcdhPublicKey(jwk) {
  return crypto.subtle.importKey("jwk", jwk, ECDH_ALG, true, []);
}

/**
 * Derive the shared AES-GCM key (SRS §4.3).
 * Each side runs this independently with its own private half and the other
 * side's public half — the secret is never transmitted.
 * Called immediately after both ECDH public keys are available and BEFORE
 * the DataChannel opens (FR-14, §4.3 timing).
 */
export async function deriveSharedSecret(myEcdhPrivateKey, theirEcdhPublicJwk) {
  const theirPublicKey = await importEcdhPublicKey(theirEcdhPublicJwk);
  return crypto.subtle.deriveKey(
    { name: "ECDH", public: theirPublicKey },
    myEcdhPrivateKey,
    { name: "AES-GCM", length: 256 },
    false, // not extractable — lives in memory for the session only
    ["encrypt", "decrypt"]
  );
}

/**
 * Encrypt one message (SRS §4.4). A FRESH 12-byte IV is generated for every
 * message — IV reuse with AES-GCM breaks security (NFR-05).
 * Returns { iv, ct } base64-encoded for the DataChannel JSON envelope.
 */
export async function encryptMessage(key, plaintextString) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintextString)
  );
  return { iv: bytesToB64(iv), ct: bytesToB64(ciphertext) };
}

/**
 * Decrypt one message. Throws OperationError on tampered payload —
 * the caller renders it as `[DECRYPTION FAILED]` (E-10).
 */
export async function decryptMessage(key, ivB64, ctB64) {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBytes(ivB64) },
    key,
    b64ToBytes(ctB64)
  );
  return new TextDecoder().decode(plaintext);
}
