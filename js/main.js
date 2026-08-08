/* main.js — application bootstrap & orchestration (SRS §10.1, UC-01…UC-10)
 *
 * Boot order (UC-01 first launch / UC-02 subsequent launch):
 *   1. capability checks (E-11 WebRTC, E-09 IndexedDB)
 *   2. theme from preferences (instant :root swap)
 *   3. identity — generate on first launch, else load (INITIALISING...)
 *   4. signaling connect + join own public key room (CONNECTING... → ONLINE)
 *   5. views, contacts, initial thread, first-launch banner
 *
 * App-level knock flow (FR-15, v2.3): known_peers check → auto-add if
 * unknown (fingerprint nickname) → handshake proceeds automatically.
 * One session at a time (the server enforces busy via room-full).
 */

import { jwkToString, stringToJwk, isValidPublicJwk, getPublicKeyFingerprint, copyText } from "./utils.js";
import { isDegraded } from "./db.js";
import { initIdentity, getMyPublicKeyJwk, getMyPrivateKeyString, regenerateIdentity } from "./identity.js";
import SignalingClient from "./signaling-client.js";
import PeerConnection from "./peer-connection.js";
import * as knownPeers from "./known-peers.js";
import * as messageStore from "./message-store.js";
import { exportAllData } from "./export-service.js";
import { initTheme, setTheme } from "./theme-service.js";
import * as chatUI from "./chat-ui.js";
import * as contactsView from "./contacts-view.js";
import * as settingsView from "./settings-view.js";
import { makeDraggable, showModal } from "./components.js";
import { $ } from "./utils.js";

const statusText = $("status-text");
const statusExtra = $("status-extra");

let myKeyString = null;
let signaling = null;
let session = null; // the single active PeerConnection (V1: one session)
let peersCache = []; // decorated known_peers records
const fingerprintCache = new Map(); // key string → fingerprint

/* ============================== status bar ================================ */

function setStatusText(text) {
  statusText.textContent = text;
}

function updateStatus() {
  let text;
  if (session && session.isOpen) {
    /* UC-04 step 10 — `ONLINE — [nickname or truncated key]` */
    const rec = peersCache.find((p) => p._key === session.peerKeyString);
    text = `ONLINE — ${rec ? contactsView.peerLabel(rec) : "PEER"}`;
  } else {
    switch (signaling?.state) {
      case "online": text = "ONLINE"; break;
      case "connecting": text = "CONNECTING..."; break;
      case "reconnecting": text = "RECONNECTING..."; break; // FR-33 / E-02
      case "lost": text = "SIGNAL LOST"; break;             // E-01 / E-03
      default: text = "INITIALISING...";
    }
  }
  setStatusText(text);
  settingsView.setNetworkStatus(signaling?.state || "idle");
}

/* ============================ session wiring =============================== */

function peerLabelFor(keyString) {
  const rec = peersCache.find((p) => p._key === keyString);
  return rec ? contactsView.peerLabel(rec) : "PEER";
}

async function systemMessageFor(keyString, text) {
  if (chatUI.getDisplayedThread() === keyString) {
    chatUI.appendSystemMessage(text);
  }
}

function createSession() {
  const s = new PeerConnection({
    signaling,
    myKeyString,
    onSystemMessage: (text) => systemMessageFor(s.peerKeyString, text),
    onSessionOpen: async (sess) => {
      signaling.setSessionActive(true); // FR-34
      await loadThread(sess.peerKeyString); // switch to the live thread
      chatUI.setInputEnabled(true, { placeholder: "TYPE MESSAGE..." });
      chatUI.appendSystemMessage("PEER CONNECTED");
      knownPeers.touchLastSeen(stringToJwk(sess.peerKeyString)).catch(() => {});
      refreshContacts().catch(() => {});
      updateStatus();
    },
    onSessionClosed: (sess) => {
      if (session === s) session = null;
      signaling.setSessionActive(false);
      chatUI.setInputEnabled(false, { placeholder: "NO OPEN DATA CHANNEL" }); // FR-28
      knownPeers.touchLastSeen(stringToJwk(sess.peerKeyString)).catch(() => {});
      refreshContacts().catch(() => {});
      updateStatus();
    },
    onIncomingMessage: (record, opts) => {
      if (chatUI.getDisplayedThread() !== record.peer) return;
      chatUI.appendMessage(record, {
        history: Boolean(opts.history),
        mine: record.sender === myKeyString,
        peerLabel: peerLabelFor(record.peer),
      });
    },
  });
  return s;
}

/* UC-06 — send a text message over the open DataChannel. */
async function sendText(content) {
  if (!session || !session.isOpen) return;
  const record = await session.sendText(content);
  if (record && chatUI.getDisplayedThread() === record.peer) {
    chatUI.appendMessage(record, { mine: true, peerLabel: peerLabelFor(record.peer) });
  }
}

/* UC-04 — connect to a known peer (the user-initiated knock). */
async function initiateConnection(peerRecord) {
  if (session) return;
  if (!signaling.isConnected()) {
    chatUI.appendSystemMessage("CANNOT KNOCK — SIGNAL LOST. RECONNECT FIRST.");
    return;
  }
  /* Render the thread FIRST and await it — the knock and all subsequent
   * system messages (KNOCKING, PEER IS BUSY, PEER UNAVAILABLE) must land
   * AFTER the thread render or the re-render would wipe them. */
  await loadThread(peerRecord._key);
  chatUI.appendSystemMessage(`KNOCKING ON ${contactsView.peerLabel(peerRecord)}...`);
  const s = createSession();
  session = s;
  const ok = await s.initiate(peerRecord);
  if (!ok && session === s) session = null;
}

/* FR-15 (v2.3) — inbound knock: known_peers check, auto-add, handshake. */
async function handleKnock(fromKeyString, ecdhPublicKey, timestamp) {
  if (session && !session._tornDown) return; // busy guard (server room-full is primary)

  const fromJwk = stringToJwk(fromKeyString);
  if (!fromJwk || !isValidPublicJwk(fromJwk) || !ecdhPublicKey) return;

  let record = await knownPeers.getPeer(fromJwk);
  if (!record) {
    /* FR-15b — auto-add with fingerprint nickname. */
    try {
      record = await knownPeers.autoAddPeer(fromJwk);
      await refreshContacts();
    } catch {
      /* E-12 — auto-add write failed: drop the connection, notify. */
      await systemMessageFor(fromKeyString,
        "INCOMING KNOCK — COULD NOT AUTO-ADD PEER. CONNECTION DROPPED.");
      signaling.knockReject(fromKeyString);
      return;
    }
  }

  /* FR-15d — known peer (or freshly auto-added): proceed automatically.
   * The answerer switches to the incoming peer's thread before the
   * handshake so every system message renders into the right place. */
  const s = createSession();
  session = s;
  await loadThread(fromKeyString);
  await s.acceptIncoming({ from: fromKeyString, ecdhPublicKey, timestamp }, record);
}

/* ============================== thread view ================================ */

async function loadThread(peerKeyString) {
  if (!peerKeyString) return;
  const [records] = await Promise.all([
    messageStore.getHistoryFor(peerKeyString),
    ensureFingerprints(),
  ]);
  chatUI.renderThread(peerKeyString, records, {
    peerLabel: peerLabelFor(peerKeyString),
  });
  /* Idle thread: no live session → guidance message + disabled input
   * (FR-26). A live session enables the input in onSessionOpen AFTER the
   * thread render completes (ordering matters — the render is async). */
  const live = session && session.peerKeyString === peerKeyString && session.isOpen;
  if (!live) {
    chatUI.appendSystemMessage("NO SESSION — PRESS CONNECT TO KNOCK", { withTime: false });
    chatUI.setInputEnabled(false, { placeholder: "NO OPEN DATA CHANNEL" });
  }
}

async function ensureFingerprints() {
  for (const p of peersCache) {
    if (!p._fingerprint) {
      let fp = fingerprintCache.get(p._key);
      if (!fp) {
        fp = await getPublicKeyFingerprint(p.public_key);
        fingerprintCache.set(p._key, fp);
      }
      p._fingerprint = fp;
    }
  }
}

/* ============================== contacts =================================== */

async function refreshContacts() {
  const records = await knownPeers.listPeers();
  peersCache = records.map((r) => ({
    ...r,
    _key: r._key,
    _fingerprint: fingerprintCache.get(r._key) || null,
  }));
  await ensureFingerprints();

  contactsView.renderContacts(peersCache, {
    activeSessionPeerKey: session ? session.peerKeyString : null,
  });
  renderPeerSelect();
  updateStatus();
}

function renderPeerSelect() {
  const select = $("peer-select");
  const prev = select.value;
  select.replaceChildren();

  if (peersCache.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "NO KNOWN PEERS — ADD ONE IN CONTACTS";
    select.appendChild(opt);
    select.disabled = true;
    $("btn-connect").disabled = true;
    return;
  }
  select.disabled = false;
  for (const p of peersCache) {
    const opt = document.createElement("option");
    opt.value = p._key;
    opt.textContent = contactsView.peerLabel(p);
    select.appendChild(opt);
  }
  if (prev && peersCache.some((p) => p._key === prev)) select.value = prev;
  $("btn-connect").disabled = Boolean(session);
}

async function onPeerSelectChange() {
  const key = $("peer-select").value;
  if (!key) return;
  await loadThread(key);
}

/* =============================== view router =============================== */

function switchView(name) {
  for (const v of ["chat", "contacts", "settings"]) {
    $(`view-${v}`).classList.toggle("hidden", v !== name);
  }
  for (const btn of document.querySelectorAll(".nav-btn")) {
    const active = btn.dataset.view === name;
    btn.setAttribute("aria-current", active ? "true" : "false");
    btn.classList.toggle("widget-btn--primary", active);
  }
}

/* ================================ boot ===================================== */

(async function boot() {
  /* E-11 — WebRTC / Web Crypto support gate. */
  if (typeof RTCPeerConnection === "undefined" || !window.crypto || !window.crypto.subtle) {
    const err = $("webrtc-error");
    err.classList.remove("hidden");
    err.classList.add("flex");
    setStatusText("FATAL");
    return;
  }

  try {
    await initTheme(); // NFR-14 — restore persisted theme before UI work
  } catch { /* default theme already active in CSS */ }

  /* UC-01 / UC-02 — identity. */
  setStatusText("INITIALISING...");
  let identity;
  try {
    identity = await initIdentity();
  } catch (err) {
    console.error("[identity] init failed", err);
    setStatusText("FATAL — NO STORAGE");
    return;
  }

  /* E-09 — degraded mode banner (app continues without writes). */
  if (isDegraded()) $("idb-banner").classList.remove("hidden");

  myKeyString = jwkToString(identity.public_key);

  /* Nav key chip — my fingerprint as the truncated identity handle. */
  getPublicKeyFingerprint(identity.public_key).then((fp) => {
    const chip = $("nav-key-chip");
    chip.textContent = `ID: ${fp}`;
    chip.title = myKeyString;
  });

  /* Signaling — connect and subscribe to my own public key channel. */
  signaling = new SignalingClient(window.APP_CONFIG?.signalingPath || null);
  signaling.onStatusChange((state) => {
    updateStatus();
    if (state === "lost") {
      /* E-03 — surfaced via status bar; recovery by tap or Settings. */
    }
  });
  signaling.connect(myKeyString);

  /* App-level handler: route knocks (FR-15). Everything else is registered
   * per-session by PeerConnection through the handler map (§8.9). */
  signaling.setHandler("onKnock", (from, ecdhPublicKey, timestamp) =>
    handleKnock(from, ecdhPublicKey, timestamp).catch((err) =>
      console.error("[knock] handling failed", err)
    )
  );

  /* ---- views ---- */
  chatUI.initChatUI({ send: (text) => sendText(text).catch(console.error) });
  contactsView.initContactsView({
    onAddPeer: async (jwk, nickname) => {
      try {
        await knownPeers.addPeer(jwk, nickname);
        await refreshContacts();
        return true;
      } catch {
        return false;
      }
    },
    onConnect: (peerRecord) => initiateConnection(peerRecord).catch(console.error),
    onRemovePeer: async (jwk) => {
      await knownPeers.removePeer(jwk);
      await refreshContacts();
    },
    onRenamePeer: async (jwk, nickname) => {
      await knownPeers.updateNickname(jwk, nickname);
      await refreshContacts();
    },
  });
  settingsView.initSettingsView({
    getMyPublicKeyString: () => jwkToString(getMyPublicKeyJwk()),
    /* V2 — the private key string is the backup encryption passphrase
     * (COPY PRIVATE KEY button in Settings). */
    getMyPrivateKeyString: () => getMyPrivateKeyString(),
    /* V2 — export is now an ENCRYPTED backup envelope (backup-crypto.js). */
    onExportData: () => exportAllData(getMyPrivateKeyString()), // UC-08 / FR-29…32 + V2
    onReconnect: () => signaling.manualReconnect(),
    /* V2 — Import Identity: settings-view ran restoreBackup() into
     * IndexedDB; reload re-boots the app on the restored identity. */
    onBackupRestored: () => {
      window.location.reload();
    },
    /* V2 — Regenerate Identity: fresh keypair + cleared known_peers, then
     * reload onto the new identity (old room is abandoned by the reload).
     * Failures (e.g. degraded IndexedDB) surface instead of wiping. */
    onRegenerateKeys: async () => {
      try {
        await regenerateIdentity();
      } catch (err) {
        console.error("[identity] regenerate failed", err);
        showModal({
          title: "REGENERATE FAILED",
          bodyText: "THE KEYPAIR COULD NOT BE REGENERATED. NOTHING WAS CHANGED.",
          buttons: [{ label: "OK", primary: true }],
        });
        return;
      }
      window.location.reload();
    },
    onClearAllData: async () => {
      /* §10.4 Danger Zone — deletes all stores, reloads, fresh identity. */
      const { deleteDatabase } = await import("./db.js");
      try { await deleteDatabase(); } catch { /* proceed to reload */ }
      window.location.reload();
    },
  });
  settingsView.reflectThemeUI();
  $("settings-public-key").textContent = myKeyString;

  /* ---- navigation ---- */
  for (const btn of document.querySelectorAll(".nav-btn")) {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  }
  switchView("chat");

  /* ---- chat view controls ---- */
  $("peer-select").addEventListener("change", onPeerSelectChange);
  $("btn-connect").addEventListener("click", () => {
    const key = $("peer-select").value;
    const rec = peersCache.find((p) => p._key === key);
    if (rec) initiateConnection(rec).catch(console.error);
  });

  /* ---- status bar tap-to-retry (E-03) ---- */
  $("status-bar").addEventListener("click", () => {
    if (signaling && signaling.state === "lost") signaling.manualReconnect();
  });

  /* ---- title bar: drag + minimise/close chrome (§2.3) ---- */
  if (window.matchMedia("(pointer: fine)").matches && window.innerWidth >= 760) {
    makeDraggable($("app-titlebar"), $("app-window"));
  }
  let minimized = false;
  $("btn-minimize").addEventListener("click", () => {
    minimized = !minimized;
    const win = $("app-window");
    for (const id of ["nav-strip", "main-content", "status-bar"]) {
      $(id).style.display = minimized ? "none" : "";
    }
    win.style.height = minimized ? "auto" : "min(700px,100vh)";
  });
  $("btn-window-close").addEventListener("click", () => {
    showModal({
      title: "P2P_CHAT.EXE",
      bodyText: "A BROWSER PAGE CANNOT CLOSE ITSELF. MINIMISE THE CONSOLE INSTEAD?",
      buttons: [
        { label: "MINIMISE", primary: true, onClick: () => $("btn-minimize").click() },
        { label: "CANCEL" },
      ],
    });
  });

  /* ---- contacts / thread bootstrap ---- */
  await refreshContacts();
  if (peersCache.length === 0) {
    /* UC-01 step 7 — first-launch prompt. */
    chatUI.showFirstLaunchBanner({
      onCopyKey: async () => {
        await copyText(myKeyString);
      },
      onGoContacts: () => switchView("contacts"),
    });
    chatUI.setInputEnabled(false, { placeholder: "NO OPEN DATA CHANNEL" });
  } else {
    /* Most recently seen peer's thread renders immediately (FR-24). */
    const sorted = [...peersCache].sort((a, b) =>
      (b.last_seen || b.added_at || "").localeCompare(a.last_seen || a.added_at || "")
    );
    $("peer-select").value = sorted[0]._key;
    await loadThread(sorted[0]._key);
  }

  statusExtra.textContent = window.APP_CONFIG?.statusSuffix || "V2.0 — SRS 2.3 + ENCRYPTED BACKUPS";
  updateStatus();
})();
