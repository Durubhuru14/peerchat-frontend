/* toast.js — transient notification bar (v2.2 mesh, FR-54)
 *
 * One visible notification at a time (latest wins), auto-hidden after 8 s.
 * A toast may carry a peer key: clicking it OPENS that peer's thread, so a
 * message that arrived in the background is one click away. Toasts without
 * a peer key are click-to-dismiss.
 *
 * Rendered into #app-toast above the status bar (v2.1's #knock-toast,
 * generalised from missed knocks to all transient notices).
 */

import { $ } from "./utils.js";

const DEFAULT_DURATION_MS = 8000;

let hideTimer = null;
let currentPeerKey = null; // peer whose thread opens on click (or null)
let openThreadCb = null;   // main.js: (peerKeyString) => void

/** Wire the toast element; call once from boot. */
export function initToast({ onOpenThread }) {
  openThreadCb = onOpenThread;
  $("app-toast").addEventListener("click", () => {
    const peer = currentPeerKey;
    hideToast();
    if (peer && typeof openThreadCb === "function") openThreadCb(peer);
  });
}

/**
 * @param {string} text  fully-formed, uppercase notification line
 * @param {object} opts  { peerKey?: string, durationMs?: number }
 */
export function showToast(text, { peerKey = null, durationMs = DEFAULT_DURATION_MS } = {}) {
  const toast = $("app-toast");
  currentPeerKey = peerKey;
  toast.textContent = peerKey
    ? `${text} — CLICK TO OPEN`
    : `${text} — CLICK TO DISMISS`;
  toast.classList.remove("hidden");
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(hideToast, durationMs);
}

export function hideToast() {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  $("app-toast").classList.add("hidden");
  currentPeerKey = null;
}
