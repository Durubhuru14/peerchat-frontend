/* backup-crypto.js — BackupCrypto (V2 feature: encrypted export / import)
 *
 * V2 requirement (beyond SRS v2.3, user-specified):
 *   "The exported JSON must be encrypted before download. The user's private
 *    key string is the passphrase (hash salt) used to derive the encryption
 *    key. On import, the user must paste their private key to decrypt."
 *
 * Design:
 *   passphrase  = JSON.stringify(privateKeyJWK)  — "the private key string"
 *   KDF         = PBKDF2-HMAC-SHA256 (the hash that mixes passphrase + salt),
 *                 100 000 iterations, 256-bit output
 *   salt        = 16 fresh random bytes per export, stored IN the envelope
 *                 (a salt is not secret; it hardens the hash against
 *                 precomputation and makes every export unique)
 *   cipher      = AES-256-GCM with a fresh 12-byte IV (NFR-05 discipline:
 *                 a fresh IV per encryption, never reused)
 *   envelope    = the downloaded JSON file:
 *
 *     {
 *       "app": "p2p-decentralised-chat",
 *       "format": "encrypted-backup",
 *       "version": 2,
 *       "srs": "2.3",
 *       "exported_at": "<ISO>",
 *       "kdf":  { "algo": "PBKDF2", "hash": "SHA-256",
 *                 "iterations": 100000, "salt": "<base64 16B>" },
 *       "cipher": { "algo": "AES-256-GCM", "iv": "<base64 12B>" },
 *       "payload": "<base64 ciphertext of the inner JSON document>"
 *     }
 *
 * The inner document is identical to the V1 export structure (identity,
 * known_peers, messages, preferences) — see export-service.js.
 *
 * Threat model (documented in DOCUMENTATION.md):
 *   The backup file may be stored anywhere (cloud drive, email attachment,
 *   USB stick). Without the private key string it is opaque: a wrong or
 *   missing passphrase fails GCM authentication (OperationError) and yields
 *   nothing. An attacker who already possesses the private key owns the
 *   identity anyway — the keypair IS the identity (SRS §2.2), so encrypting
 *   the backup with it adds no new exposure.
 */

import { bytesToB64, b64ToBytes } from "./utils.js";

const KDF_ALGO = "PBKDF2";
const KDF_HASH = "SHA-256";
const KDF_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const CIPHER = "AES-256-GCM";

/** Random bytes helper (crypto.getRandomValues — same source as message IVs). */
function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

/**
 * Derive the AES-256-GCM backup key from the private key string.
 *
 * The private key string is the PASSPHRASE; the per-export random salt is
 * hashed together with it (PBKDF2 = Password-Based Key Derivation Function,
 * a salted hash chain). The derived key is non-extractable — it exists only
 * for the encrypt/decrypt call and never appears in the envelope.
 */
export async function deriveBackupKey(passphraseString, saltBytes, iterations = KDF_ITERATIONS) {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphraseString),
    { name: KDF_ALGO },
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: KDF_ALGO,
      hash: KDF_HASH,
      salt: saltBytes,
      iterations,
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false, // non-extractable
    ["encrypt", "decrypt"]
  );
}

/** Detection helper — is this parsed JSON an encrypted backup envelope? */
export function isEncryptedBackupEnvelope(obj) {
  return Boolean(
    obj &&
      typeof obj === "object" &&
      obj.app === "p2p-decentralised-chat" &&
      obj.format === "encrypted-backup" &&
      typeof obj.payload === "string" &&
      obj.kdf &&
      typeof obj.kdf.salt === "string" &&
      typeof obj.kdf.iterations === "number" &&
      obj.cipher &&
      typeof obj.cipher.iv === "string"
  );
}

/**
 * Encrypt an inner backup document (already serialised to a JSON string)
 * with a key derived from the private key string.
 * Returns the complete envelope object (ready for download).
 */
export async function encryptBackupDocument(innerDocObject, passphraseString) {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveBackupKey(passphraseString, salt);

  const plaintext = new TextEncoder().encode(JSON.stringify(innerDocObject));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);

  return {
    app: "p2p-decentralised-chat",
    format: "encrypted-backup",
    version: 2,
    srs: "2.3",
    exported_at: new Date().toISOString(),
    kdf: {
      algo: KDF_ALGO,
      hash: KDF_HASH,
      iterations: KDF_ITERATIONS,
      salt: bytesToB64(salt),
    },
    cipher: {
      algo: CIPHER,
      iv: bytesToB64(iv),
    },
    payload: bytesToB64(ciphertext),
  };
}

/**
 * Decrypt an encrypted backup envelope with the pasted private key string.
 * Throws (OperationError) when the passphrase is wrong or the file is
 * corrupt — GCM authentication fails before any plaintext is produced.
 *
 * @returns {object} the inner backup document
 */
export async function decryptBackupEnvelope(envelope, passphraseString) {
  if (!isEncryptedBackupEnvelope(envelope)) {
    throw new Error("not an encrypted backup envelope");
  }
  /* Iterations are taken from the file (KDF agility) but clamped to a sane
   * range so a tampered file cannot force absurd work. */
  const iterations = Math.min(Math.max(1, envelope.kdf.iterations | 0), 5_000_000);
  const salt = b64ToBytes(envelope.kdf.salt);
  const iv = b64ToBytes(envelope.cipher.iv);
  const key = await deriveBackupKey(passphraseString, salt, iterations);

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    b64ToBytes(envelope.payload)
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}
