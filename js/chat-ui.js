/* chat-ui.js — ChatUI (SRS §12, §10.2, FR-18…FR-28, E-04…E-10)
 *
 * Message rendering rules (§10.2 table):
 *   sent by self        right-aligned block, amber left border, label YOU
 *   received from peer  left-aligned block, dim border, peer label
 *   system message      centred, ALL CAPS, dim, no border, no sender label
 *   seeded history      same as sent/received + dim [HISTORY] prefix tag
 *   decryption failure  left-aligned, red-tinted border, [DECRYPTION FAILED]
 *
 * Timestamps: HH:MM right of the sender label, full ISO on hover (title),
 * `── 2 JAN 2025 ──` date separator for the first message of a new day.
 * The chat surface carries the CRT scanline overlay (§2.3).
 */

import { el, $, formatTime, formatFullISO, formatDateSeparator, dayKey } from "./utils.js";
import { attachScrollbar } from "./components.js";

let displayedThreadKey = null; // key string of the thread on screen
let lastDayKey = null;
let lastSenderKey = null; // v2.1 grouping: sender of the previous row
let onSendMessage = null;
let scroller = null;

export function initChatUI({ send }) {
  scroller = $("chat-messages");
  onSendMessage = send;
  attachScrollbar(scroller, $("chat-scrollbar"));

  $("chat-input-row").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("message-input");
    const text = input.value.trim();
    if (!text || input.disabled) return;
    input.value = "";
    onSendMessage(text);
  });
}

/* ------------------------------- thread mgmt ------------------------------ */

/** Which peer's thread is currently displayed (key string or null). */
export function getDisplayedThread() {
  return displayedThreadKey;
}

export function setDisplayedThread(peerKeyString) {
  displayedThreadKey = peerKeyString;
  lastDayKey = null;
  lastSenderKey = null;
  scroller.replaceChildren();
}

/** Load a full thread from the store and render it (FR-24, NFR-07). */
export function renderThread(peerKeyString, records, { mine, peerLabel }) {
  setDisplayedThread(peerKeyString);
  for (const r of records) appendMessage(r, { history: false, mine, peerLabel });
  if (records.length > 0) scrollToBottom();
}

export function setThreadHeader(name) {
  const header = $("chat-peer-header").querySelector("#peer-select");
  header.title = name || "";
}
export function clearThread() {
  setDisplayedThread(null);
  scroller.replaceChildren();
}

/** UC-01 step 7 — first-launch prompt in the chat area. */
export function showFirstLaunchBanner({ onCopyKey, onGoContacts }) {
  const banner = el("div", { class: "bevel-out bg-panel p-3 my-6 mx-auto max-w-[520px] flex flex-col gap-2" },
    el("div", { class: "text-[11px] uppercase tracking-tight text-accent2", text: "── WELCOME TO P2P_CHAT ──" }),
    el("div", { class: "text-[12px] leading-relaxed" },
      "YOUR IDENTITY IS A KEYPAIR GENERATED IN THIS BROWSER. NOBODY CAN REGISTER YOU, ADMINISTRATE YOU, OR READ YOUR MESSAGES."),
    el("ol", { class: "text-[12px] leading-relaxed list-decimal pl-5 flex flex-col gap-1" },
      el("li", {}, "COPY YOUR PUBLIC KEY (SETTINGS → IDENTITY) AND SHARE IT WITH A FRIEND OVER ANY CHANNEL YOU TRUST."),
      el("li", {}, "ADD THEIR PUBLIC KEY UNDER CONTACTS."),
      el("li", {}, "PRESS CONNECT. THE SIGNALING SERVER ONLY INTRODUCES YOU — AFTER THAT, MESSAGES TRAVEL BROWSER TO BROWSER, ENCRYPTED."),
    ),
    el("div", { class: "flex gap-1 flex-wrap" },
      el("button", { class: "widget-btn widget-btn--primary", type: "button", text: "COPY MY PUBLIC KEY", onclick: onCopyKey }),
      el("button", { class: "widget-btn", type: "button", text: "OPEN CONTACTS", onclick: onGoContacts }),
    ),
  );
  scroller.replaceChildren();
  scroller.appendChild(banner);
  displayedThreadKey = "__banner__";
}

/* ------------------------------ message rows ------------------------------ */

/**
 * Append one message row, inserting a date separator at day boundaries.
 * @param {object} record message store record (or {decryptionFailed:true})
 * @param {object} opts  { history:boolean, mine:boolean, peerLabel:string }
 *        history — the dim [HISTORY] tag (§10.2)
 *        mine    — sender is the local user (right block, label YOU)
 */
export function appendMessage(record, { history = false, mine = false, peerLabel = "PEER" } = {}) {
  if (displayedThreadKey !== record.peer) return; // wrong thread on screen

  const dk = dayKey(record.timestamp || new Date().toISOString());
  if (dk !== lastDayKey) {
    lastDayKey = dk;
    lastSenderKey = null; // day break resets the grouping
    scroller.appendChild(
      el("div", {
        class: "msg-row msg-row--sys",
        text: `── ${formatDateSeparator(record.timestamp)} ──`,
      })
    );
  }

  if (record.decryptionFailed) {
    /* E-10 — renders inline, informational only. */
    lastSenderKey = null;
    scroller.appendChild(
      el("div", { class: "msg-row msg-row--err" },
        el("div", { class: "msg-meta" }, el("span", { class: "msg-label", text: "PEER" })),
        el("div", { class: "text-err", text: "[DECRYPTION FAILED]" }),
      )
    );
    scrollToBottomIfNear();
    return;
  }

  /* v2.1 — consecutive messages from the same sender stack tight, the meta
   * line (label + time) is shown only on the first of the group; the time
   * stays available on hover via the row title. */
  const senderKey = mine ? "YOU" : peerLabel;
  const grouped = senderKey === lastSenderKey;
  lastSenderKey = senderKey;

  const row = el("div", {
    class: `msg-row ${mine ? "msg-row--sent" : "msg-row--recv"}${grouped ? " msg-row--cont" : ""}`,
  });
  if (grouped) row.title = `${senderKey} — ${formatTime(record.timestamp)} (${formatFullISO(record.timestamp)})`;
  const label = el("span", { class: "msg-label" });
  label.textContent = mine ? "YOU" : peerLabel;
  const time = el("span", {
    class: "msg-time",
    text: formatTime(record.timestamp),
    title: formatFullISO(record.timestamp),
  });
  const meta = el("div", { class: "msg-meta" });
  if (history) meta.appendChild(el("span", { class: "msg-history-tag", text: "[HISTORY]" }));
  meta.append(label, time);
  const content = el("div", {});
  content.textContent = record.content;
  row.append(meta, content);
  scroller.appendChild(row);
  scrollToBottomIfNear();
}

/** System message row (§10.2: centred, ALL CAPS, dim, no border). */
export function appendSystemMessage(text, { withTime = true } = {}) {
  lastSenderKey = null; // system line breaks the sender grouping
  const t = withTime ? `${formatTime(new Date().toISOString())} ${text}` : text;
  scroller.appendChild(el("div", { class: "msg-row msg-row--sys", text: `── ${t} ──` }));
  scrollToBottomIfNear();
}

/* --------------------------------- input ---------------------------------- */

/** FR-26 / FR-28 — input disabled unless a DataChannel is open. */
export function setInputEnabled(enabled, { placeholder } = {}) {
  const input = $("message-input");
  const btn = $("btn-send");
  input.disabled = !enabled;
  btn.disabled = !enabled;
  if (placeholder) input.placeholder = placeholder;
}

/** v2.1 — focus the composer (called when a session opens). */
export function focusInput() {
  const input = $("message-input");
  if (!input.disabled) input.focus();
}

/* -------------------------------- scrolling -------------------------------- */

function isNearBottom() {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
}

function scrollToBottomIfNear() {
  if (isNearBottom()) scrollToBottom();
}

export function scrollToBottom() {
  scroller.scrollTop = scroller.scrollHeight;
}
