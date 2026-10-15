/* utils.js — shared helpers: JWK handling, fingerprints, timestamps, colours.
 * SRS §1.4 "Key String": JSON.stringify() serialisation of a JWK object.
 * SRS §12: KnownPeers exposes getPublicKeyFingerprint(JWK).
 */

/** Key String — the canonical serialisation used as IndexedDB out-of-line
 *  key and as the signaling channel identifier (SRS §1.4, §11, §15.1). */
export function jwkToString(jwk) {
  return JSON.stringify(jwk);
}

export function stringToJwk(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

/** UC-03 step 4 — validate a pasted key is a JWK ECDSA P-256 public key. */
export function isValidPublicJwk(jwk) {
  return Boolean(
    jwk &&
      typeof jwk === "object" &&
      jwk.kty === "EC" &&
      jwk.crv === "P-256" &&
      typeof jwk.x === "string" &&
      jwk.x.length > 0 &&
      typeof jwk.y === "string" &&
      jwk.y.length > 0 &&
      jwk.d === undefined
  );
}

/** SHA-256 hex digest of a string (Web Crypto). */
export async function sha256Hex(str) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(str)
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Public key fingerprint — short display handle for a JWK.
 * SHA-256 over the raw EC point coordinates, hex, first 12 nibbles,
 * formatted XXXX-XXXX-XXXX. Used as default nickname for auto-added
 * peers (FR-15b) and as the "truncated public key" display (§10.2/§10.3).
 */
export async function getPublicKeyFingerprint(jwk) {
  const hex = await sha256Hex(`${jwk.x}|${jwk.y}`);
  return (hex.slice(0, 12).toUpperCase().match(/.{4}/g) || []).join("-");
}

/* ---------------------------- time formatting ----------------------------- */

export function nowISO() {
  return new Date().toISOString();
}

/** §10.2 — HH:MM next to the sender label. */
export function formatTime(iso) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes()
  ).padStart(2, "0")}`;
}

/** §10.2 — full ISO date on hover/tap. */
export function formatFullISO(iso) {
  return new Date(iso).toISOString().replace("T", " ").slice(0, 19);
}

/** §10.2 — date separator, e.g. "2 JAN 2025". */
export function formatDateSeparator(iso) {
  const d = new Date(iso);
  const months = [
    "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
    "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
  ];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

/** Local calendar day key — used to detect day boundaries for separators. */
export function dayKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** "LAST SEEN" style relative stamp for the contacts list (§10.3). */
export function formatSeen(iso) {
  if (!iso) return "NEVER";
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return "JUST NOW";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}M AGO`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}H AGO`;
  return formatDateSeparator(iso);
}

/* -------------------------------- base64 ---------------------------------- */

export function bytesToB64(buf) {
  let s = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/* ------------------------------ DOM helpers ------------------------------- */

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2), v);
    } else if (v !== null && v !== undefined && v !== false) {
      node.setAttribute(k, v === true ? "" : String(v));
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

export function $(id) {
  return document.getElementById(id);
}

/** Copy text to clipboard with a legacy fallback (FR-04, §10.3, §10.4). */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

/* --------------------------- colour derivation ----------------------------
 * Used by the Custom theme (NFR-18): remaining tokens derive automatically
 * from the two user-chosen colours.
 * -------------------------------------------------------------------------- */

export function hexToRgb(hex) {
  const m = hex.replace("#", "");
  const n = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  return [
    parseInt(n.slice(0, 2), 16),
    parseInt(n.slice(2, 4), 16),
    parseInt(n.slice(4, 6), 16),
  ];
}

export function rgbToHex([r, g, b]) {
  return (
    "#" +
    [r, g, b]
      .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0"))
      .join("")
  );
}

/** Blend two hex colours; t = weight of colour b. */
export function blendHex(a, b, t) {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return rgbToHex(A.map((v, i) => v + (B[i] - v) * t));
}

/** Relative luminance 0..1 (used to detect light vs dark base). */
export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * NFR-18 derivation: panels are bg-base lightened 8% for dark themes and
 * darkened 8% for light themes; sunken surfaces a further 6% same direction.
 * `dir` = +1 lightens (dark base), -1 darkens (light base).
 */
export function shiftHex(hex, percent, dir) {
  const target = dir > 0 ? "#ffffff" : "#000000";
  return blendHex(hex, target, percent / 100);
}
