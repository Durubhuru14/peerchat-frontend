/* main.js — application bootstrap & orchestration (SRS v2.6 §10.1, UC-01…UC-10
 * + v2.2 §19 mesh sessions)
 *
 * Boot order (UC-01 first launch / UC-02 subsequent launch):
 *   1. capability checks (E-11 WebRTC, E-09 IndexedDB)
 *   2. theme from preferences (instant :root swap)
 *   3. identity — generate on first launch, else load (INITIALISING...)
 *   4. signaling connect + join own public key room (CONNECTING... → ONLINE)
 *   5. views, contacts, initial thread, first-launch banner
 *
 * MESH SESSIONS (v2.2, FR-51): `sessions` is a Map of live PeerConnection
 * objects, keyed by the remote peer's key string — one simultaneous
 * DataChannel per remote peer, any number of peers at once. Threads are
 * switched freely while every session keeps running in the background;
 * messages that land in a background thread raise the unread badge on the
 * peer selector and a transient toast (FR-54).
 *
 * Signaling event routing (§15.2/§8.9, mesh form): ONE app-level router is
 * registered per event for the app's lifetime; it resolves the target
 * session by the event's `from` key at event time. Stale sessions can never
 * intercept another session's traffic because routing consults the live
 * sessions Map, not registration order.
 *
 * App-level knock flow (FR-15): known_peers check → auto-add if unknown
 * (fingerprint nickname) → handshake proceeds automatically. A fresh knock
 * from a peer replaces any stale session for that peer (self-healing).
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
import { showToast, initToast } from "./toast.js";
import { makeDraggable, showModal } from "./components.js";
import { $ } from "./utils.js";

const statusText = $("status-text");
const statusExtra = $("status-extra");

let myKeyString = null;
let signaling = null;
const sessions = new Map();     // peer key string → live PeerConnection (mesh: many)
const unreadCounts = new Map(); // peer key string → unseen background messages
let peersCache = [];            // decorated known_peers records
const fingerprintCache = new Map(); // key string → fingerprint

/* ============================== status bar ================================ */

function setStatusText(text) {
  statusText.textContent = text;
}

function updateStatus() {
  statusText.title = "";
  const open = [...sessions.values()].filter((s) => s.isOpen);
  if (open.length > 0) {
    /* UC-04 step 10 — `ONLINE — [nickname or truncated key]`; with several
     * live sessions the bar summarises instead of listing. */
    statusText.textContent = open.length === 1
      ? `ONLINE — ${peerLabelFor(open[0].peerKeyString)}`
      : `ONLINE — ${open.length} PEERS`;
  } else {
    switch (signaling?.state) {
      case "online": statusText.textContent = "ONLINE"; break;
      case "connecting": statusText.textContent = "CONNECTING..."; break;
      case "reconnecting": statusText.textContent = "RECONNECTING..."; break; // FR-33 / E-02
      case "lost": {
        /* E-01 / E-03 — carry the probed cause (signaling-client diagnosis):
         * e.g. "SIGNAL LOST — 404 — NO SOCKET.IO HERE" when the page is
         * served by a static file server without the signaling server. */
        const d = signaling?.getDiagnosis?.();
        statusText.textContent = d ? `SIGNAL LOST — ${d.short}` : "SIGNAL LOST";
        statusText.title = d
          ? d.long
          : "Signaling server unreachable. Tap here to retry.";
        break;
      }
      default: statusText.textContent = "INITIALISING...";
    }
  }
  settingsView.setNetworkStatus(signaling?.state || "idle");
}

/* ============================ session wiring =============================== */

function peerLabelFor(keyString) {
  const rec = peersCache.find((p) => p._key === keyString);
  return rec ? contactsView.peerLabel(rec) : "PEER";
}

function systemMessageFor(keyString, text) {
  if (chatUI.getDisplayedThread() === keyString) {
    chatUI.appendSystemMessage(text);
  }
}

/** True when the user is actively viewing a DIFFERENT peer's live thread —
 *  used to decide whether a new session may take over the chat view. */
function isViewingLiveOther(peerKey) {
  if ($("view-chat").classList.contains("hidden")) return false;
  const displayed = chatUI.getDisplayedThread();
  if (!displayed || displayed === peerKey) return false;
  const s = sessions.get(displayed);
  return Boolean(s && !s._tornDown && s.isOpen);
}

function createSession() {
  const s = new PeerConnection({
    signaling,
    myKeyString,
    onSystemMessage: (text) => systemMessageFor(s.peerKeyString, text),
    onSessionOpen: async (sess) => {
      signaling.setSessionActive(sessions.size > 0); // FR-34 — any live channel
      knownPeers.touchLastSeen(stringToJwk(sess.peerKeyString)).catch(() => {});
      refreshContacts().catch(() => {});

      /* Focus policy (mesh-aware v2.2): the live thread takes over the chat
       * view unless the user is reading ANOTHER live conversation — then a
       * toast keeps the new session one click away instead of stealing
       * focus. v2.1's deliberate click-through (initiator path) is covered
       * by the displayed-thread check inside the condition. */
      const inChatView = !$("view-chat").classList.contains("hidden");
      if (inChatView && !isViewingLiveOther(sess.peerKeyString)) {
        await loadThread(sess.peerKeyString);
        chatUI.appendSystemMessage("PEER CONNECTED");
        chatUI.focusInput();
      } else {
        showToast(`${peerLabelFor(sess.peerKeyString)} CONNECTED`, {
          peerKey: sess.peerKeyString,
        });
      }
      updateStatus();
    },
    onSessionClosed: (sess) => {
      if (sessions.get(sess.peerKeyString) === sess) {
        sessions.delete(sess.peerKeyString);
      }
      signaling.setSessionActive(sessions.size > 0); // FR-34 — any live channel
      if (chatUI.getDisplayedThread() === sess.peerKeyString) {
        chatUI.setInputEnabled(false, { placeholder: "NO OPEN DATA CHANNEL" }); // FR-28
      }
      knownPeers.touchLastSeen(stringToJwk(sess.peerKeyString)).catch(() => {});
      refreshContacts().catch(() => {});
      updateStatus();
    },
    onIncomingMessage: (record, opts) => {
      const inForeground =
        chatUI.getDisplayedThread() === record.peer &&
        !$("view-chat").classList.contains("hidden");
      if (inForeground) {
        chatUI.appendMessage(record, {
          history: Boolean(opts.history),
          mine: record.sender === myKeyString,
          peerLabel: peerLabelFor(record.peer),
        });
        return;
      }
      if (opts.history) return; // background seeding merges silently (FR-23)

      /* v2.2 FR-54 — live message in a background thread: unread badge +
       * toast with a content preview; one click opens the thread. */
      unreadCounts.set(record.peer, (unreadCounts.get(record.peer) || 0) + 1);
      const preview = record.content.length > 48
        ? `${record.content.slice(0, 48)}…`
        : record.content;
      showToast(`MSG FROM ${peerLabelFor(record.peer)}: "${preview}"`, {
        peerKey: record.peer,
      });
      renderPeerSelect();
    },
  });
  return s;
}

/* UC-06 — send a text message over the DISPLAYED thread's DataChannel. */
async function sendText(content) {
  const peerKey = chatUI.getDisplayedThread();
  const s = peerKey && sessions.get(peerKey);
  if (!s || !s.isOpen) return;
  const record = await s.sendText(content);
  if (record) {
    chatUI.appendMessage(record, { mine: true, peerLabel: peerLabelFor(record.peer) });
  }
}

/* UC-04 — connect to a known peer (the user-initiated knock). Mesh: other
 * sessions keep running; this adds one more pair. */
async function initiateConnection(peerRecord) {
  const key = peerRecord._key;
  const existing = sessions.get(key);
  if (existing && !existing._tornDown) return; // already live or connecting
  if (!signaling.isConnected()) {
    chatUI.appendSystemMessage("CANNOT KNOCK — SIGNAL LOST. RECONNECT FIRST.");
    return;
  }
  /* Render the thread FIRST and await it — the knock and all subsequent
   * system messages (KNOCKING, PEER UNAVAILABLE) must land AFTER the thread
   * render or the re-render would wipe them. The initiator stays in the
   * chat view so knock progress is visible (v2.1). */
  await loadThread(key);
  switchView("chat");
  chatUI.appendSystemMessage(`KNOCKING ON ${contactsView.peerLabel(peerRecord)}...`);
  const s = createSession();
  sessions.set(key, s);
  updateConnectButton();
  const ok = await s.initiate(peerRecord);
  if (!ok && sessions.get(key) === s) {
    sessions.delete(key);
    refreshContacts().catch(() => {});
  }
}

/* FR-15 — inbound knock: known_peers check, auto-add, handshake.
 * Mesh: never busy — a fresh knock from a peer with a stale live session
 * replaces it (asymmetric state self-heals with a fresh keypair + re-seed). */
async function handleKnock(fromKeyString, ecdhPublicKey, timestamp) {
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

  /* Replace any stale session for this peer before accepting the fresh one. */
  const stale = sessions.get(fromKeyString);
  if (stale && !stale._tornDown) {
    stale._teardown({ silent: true });
    if (sessions.get(fromKeyString) === stale) sessions.delete(fromKeyString);
  }

  const s = createSession();
  sessions.set(fromKeyString, s);
  updateConnectButton();

  /* v2.1 focus policy, mesh-aware: the answerer is taken to the incoming
   * peer's thread unless that would rip them out of another live
   * conversation (then the onSessionOpen toast covers it). */
  if (!isViewingLiveOther(fromKeyString)) {
    await loadThread(fromKeyString);
    switchView("chat");
  }
  await s.acceptIncoming({ from: fromKeyString, ecdhPublicKey, timestamp }, record);
}

/* ==================== v2.2 — session action from the UI ==================== */

/** DISCONNECT / CANCEL handler for a peer (chat header + contacts modal). */
function endSessionFor(peerRecord, { fromChatHeader = false } = {}) {
  const key = peerRecord._key || jwkToString(peerRecord.public_key);
  const s = sessions.get(key);
  if (!s || s._tornDown) return;
  if (s.isOpen) {
    /* FR-53 — clean disconnect: encrypted bye frame + server session-end. */
    s.disconnect({ note: "YOU DISCONNECTED" }).catch(console.error);
  } else {
    /* Handshake in flight — cancel the knock. */
    systemMessageFor(key, fromChatHeader ? "KNOCK CANCELLED" : "CONNECTION CANCELLED");
    s._teardown({ silent: true });
  }
}

/* ============================== thread view ================================ */

async function loadThread(peerKeyString) {
  if (!peerKeyString) return;
  /* The selector always mirrors the displayed thread — a loadThread from a
   * toast click or a fresh knock must move the dropdown too, or the header
   * action (CONNECT/DISCONNECT) would silently target the stale selection. */
  const sel = $("peer-select");
  if (sel.value !== peerKeyString &&
      [...sel.options].some((o) => o.value === peerKeyString)) {
    sel.value = peerKeyString;
  }
  const [records] = await Promise.all([
    messageStore.getHistoryFor(peerKeyString),
    ensureFingerprints(),
  ]);
  chatUI.renderThread(peerKeyString, records, {
    peerLabel: peerLabelFor(peerKeyString),
  });

  /* Idle thread: no live session → guidance message + disabled input
   * (FR-26). A live session enables the input AFTER the render completes
   * (ordering matters — the render is async). A session still handshaking
   * keeps the composer off with a CONNECTING placeholder. */
  const s = sessions.get(peerKeyString);
  const live = s && !s._tornDown;
  if (live && s.isOpen) {
    chatUI.setInputEnabled(true, { placeholder: "TYPE MESSAGE..." });
  } else if (live) {
    chatUI.setInputEnabled(false, { placeholder: "CONNECTING..." });
  } else {
    chatUI.appendSystemMessage("NO SESSION — PRESS CONNECT TO KNOCK", { withTime: false });
    chatUI.setInputEnabled(false, { placeholder: "NO OPEN DATA CHANNEL" });
  }

  unreadCounts.delete(peerKeyString); // viewing the thread = messages seen
  renderPeerSelect();                 // drop the (n) badge from the selector
  updateConnectButton();
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

/* ===================== v2.1/v2.2 — transient notices ======================= */

/* E-06 enrichment (revised for mesh): the target of a dropped duplicate-pair
 * knock is told, transiently, that someone tried to reach them on a pair
 * that is already active. */
async function showMissedKnockToast(fromKeyString) {
  let label = "UNKNOWN PEER";
  const rec = peersCache.find((p) => p._key === fromKeyString);
  if (rec && (rec.nickname || rec._fingerprint)) {
    label = rec.nickname || rec._fingerprint;
  } else {
    const jwk = stringToJwk(fromKeyString);
    if (jwk) {
      try {
        label = await getPublicKeyFingerprint(jwk);
        fingerprintCache.set(fromKeyString, label);
      } catch {
        /* keep fallback label */
      }
    }
  }

  const note = `MISSED KNOCK — ${label} TRIED TO CONNECT (PAIR ALREADY ACTIVE)`;
  showToast(note, { peerKey: fromKeyString });

  /* If the knocker's thread happens to be on screen, log the line there too. */
  systemMessageFor(fromKeyString, note);
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
    connectedPeerKeys: new Set(
      [...sessions.values()]
        .filter((s) => !s._tornDown)
        .map((s) => s.peerKeyString)
    ),
  });
  renderPeerSelect();
  updateStatus();
}

/* The peer selector doubles as the mesh session switcher: ● marks a live
 * session, (n) counts unseen background messages. */
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
    updateConnectButton();
    return;
  }
  select.disabled = false;
  for (const p of peersCache) {
    const opt = document.createElement("option");
    opt.value = p._key;
    let label = contactsView.peerLabel(p);
    const s = sessions.get(p._key);
    if (s && !s._tornDown && s.isOpen) label = `● ${label}`;
    const unread = unreadCounts.get(p._key) || 0;
    if (unread > 0) label = `${label} (${unread})`;
    opt.textContent = label;
    select.appendChild(opt);
  }
  if (prev && peersCache.some((p) => p._key === prev)) select.value = prev;
  updateConnectButton();
}

/* v2.2 FR-52/FR-53 — the chat header action follows the selected peer's
 * session state: CONNECT → CANCEL KNOCK (handshake) → DISCONNECT (open). */
function updateConnectButton() {
  const btn = $("btn-connect");
  const key = $("peer-select").value;
  if (!key || !peersCache.some((p) => p._key === key)) {
    btn.textContent = "CONNECT";
    btn.disabled = true;
    btn.classList.add("widget-btn--primary");
    return;
  }
  const s = sessions.get(key);
  if (!s || s._tornDown) {
    btn.textContent = "CONNECT";
    btn.disabled = false;
    btn.classList.add("widget-btn--primary");
  } else if (s.isOpen) {
    btn.textContent = "DISCONNECT";
    btn.disabled = false;
    btn.classList.remove("widget-btn--primary");
  } else {
    btn.textContent = "CANCEL KNOCK";
    btn.disabled = false;
    btn.classList.remove("widget-btn--primary");
  }
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

/* ===================== signaling event routing (§15.2 mesh) ================ */

/* ONE router per event, registered for the app's lifetime. Each router
 * resolves the target session from the live sessions Map by the event's
 * `from` key — sessions never touch the shared handler map, so a stale
 * session can never intercept another's traffic (§8.9's goal, achieved by
 * construction). */
function wireSessionRouting() {
  signaling.setHandler("onKnock", (from, ecdhPublicKey, timestamp) =>
    handleKnock(from, ecdhPublicKey, timestamp).catch((err) =>
      console.error("[knock] handling failed", err)
    )
  );
  signaling.setHandler("onKnockBlocked", (from) => {
    if (typeof from !== "string") return;
    showMissedKnockToast(from).catch(() => {});
  });
  signaling.setHandler("onKnockAccepted", (from, ecdhPublicKey) =>
    sessions.get(from)?._onKnockAccepted(from, ecdhPublicKey)
  );
  signaling.setHandler("onKnockRejected", (from) =>
    sessions.get(from)?._onKnockRejected()
  );
  signaling.setHandler("onRoomFull", (to) => sessions.get(to)?._onRoomFull());
  signaling.setHandler("onOffer", (from, offer) =>
    sessions.get(from)?._onOffer(from, offer)
  );
  signaling.setHandler("onAnswer", (from, answer) =>
    sessions.get(from)?._onAnswer(from, answer)
  );
  signaling.setHandler("onIceCandidate", (from, candidate) =>
    sessions.get(from)?._onRemoteCandidate(from, candidate)
  );
  signaling.setHandler("onPeerDisconnected", (publicKey) =>
    sessions.get(publicKey)?._onPeerDisconnected(publicKey)
  );
  signaling.setHandler("onSessionClosed", (from) =>
    /* Clean far-side disconnect — same handling as a socket-level drop. */
    sessions.get(from)?._onPeerDisconnected(from)
  );
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

  /* App-level event routing (knocks + per-session events, §15.2 mesh). */
  wireSessionRouting();

  /* ---- views ---- */
  initToast({
    onOpenThread: async (peerKey) => {
      await loadThread(peerKey);
      switchView("chat");
    },
  });
  chatUI.initChatUI({
    send: (text) => sendText(text).catch(console.error),
    myKey: myKeyString, // v2.2 — renderThread resolves each record's side
  });
  contactsView.initContactsView({
    isPeerConnected: (key) => {
      const s = key && sessions.get(key);
      return Boolean(s && !s._tornDown);
    },
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
    onDisconnect: (peerRecord) => endSessionFor(peerRecord),
    onOpenChat: (peerRecord) => {
      loadThread(peerRecord._key).then(() => switchView("chat"));
    },
    onRemovePeer: async (jwk) => {
      /* Removing a contact also ends any live session with them — history
       * is kept (§10.3), only the channel and the record go. */
      const key = jwkToString(jwk);
      const s = sessions.get(key);
      if (s && !s._tornDown) {
        systemMessageFor(key, "PEER REMOVED — SESSION CLOSED");
        s._teardown({ silent: true });
      }
      await knownPeers.removePeer(jwk);
      await refreshContacts();
    },
    onRenamePeer: async (jwk, nickname) => {
      await knownPeers.updateNickname(jwk, nickname);
      await refreshContacts();
      /* v2.2 FR-55 — retrospective labelling: the renamed peer's whole
       * thread re-renders, so ALREADY-DRAWN messages (and every future
       * render) carry the new nickname; the record's JSON in IndexedDB is
       * updated by updateNickname above and travels inside every export. */
      const key = jwkToString(jwk);
      if (chatUI.getDisplayedThread() === key) {
        await loadThread(key);
      }
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
    if (!rec) return;
    const s = sessions.get(key);
    if (s && !s._tornDown) {
      endSessionFor(rec, { fromChatHeader: true });
    } else {
      initiateConnection(rec).catch(console.error);
    }
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

  statusExtra.textContent =
    window.APP_CONFIG?.statusSuffix || "V2.2 — MESH SESSIONS + ENCRYPTED BACKUPS";
  updateStatus();
})();
