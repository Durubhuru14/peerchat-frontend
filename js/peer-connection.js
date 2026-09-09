/* peer-connection.js — PeerConnection (SRS v2.6 §12, §3.6, §3.7, §8, §15.2
 * + v2.2 §19 mesh)
 *
 * Manages the full WebRTC lifecycle for ONE session (one remote peer —
 * the app holds a Map of these, one entry per connected peer, which is
 * what makes the connection mesh-shaped):
 *   - role assignment (§8.1): the peer that knocks is the OFFERER, the peer
 *     that accepts is the ANSWERER — fixed for the session
 *   - ICE configured with the Google public STUN server (§3.6, FR-17)
 *   - DataChannel "chat", ordered + reliable (§3.7)
 *   - §8.3 timeouts: knock 30 s, ICE 15 s from offer, DataChannel 5 s
 *   - §8.4 ICE failure / 5 s disconnected-recovery window
 *   - §8.5 DataChannel loss + single re-create attempt (offerer side)
 *   - §8.9 / §15.2 (v2.2 mesh): signaling handlers are registered ONCE by
 *     main.js as app-level routers that resolve the target session by the
 *     event's `from` peer key — this class exposes the per-session event
 *     methods (_onOffer, _onAnswer, …) the router calls. Sessions therefore
 *     never mutate the shared handler map, and a stale session can never
 *     intercept another session's traffic.
 *   - E-04 / E-05 / E-06 / E-07 / E-08 error states surfaced as callbacks
 *   - v2.2 FR-53: disconnect() — clean, user-initiated session end: an
 *     encrypted {action:"bye"} control frame tells the far side, a
 *     session-end event clears the server pair state, teardown keeps the
 *     contact and the message history intact
 *
 * DataChannel payload envelopes (AES-GCM encrypted, §4.4):
 *   { t: "msg",  iv, ct }  ct = JSON {id, content, timestamp, sender}
 *   { t: "seed", iv, ct }  ct = JSON [ {id, content, timestamp, sender}, … ]
 *   { t: "ctrl", iv, ct }  ct = JSON {action:"bye"}   (v2.2 disconnect)
 */

import {
  generateSessionEcdh,
  deriveSharedSecret,
  encryptMessage,
  decryptMessage,
} from "./crypto-service.js";
import { seedHistory, receiveSeed } from "./message-syncer.js";
import { addLocalMessage } from "./message-store.js";
import { jwkToString } from "./utils.js";

const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }]; // §3.6
const KNOCK_TIMEOUT_MS = 30_000; // §8.3 — waiting for acceptance
const ICE_TIMEOUT_MS = 15_000;   // §8.3 — from offer creation
const DC_OPEN_TIMEOUT_MS = 5_000; // §8.3 — after ICE connected
const ICE_DISCONNECT_GRACE_MS = 5_000; // §8.4 — recovery window
const DC_RECREATE_TIMEOUT_MS = 5_000; // §8.5 — re-created channel open window

export default class PeerConnection {
  /**
   * @param {object} deps
   *   signaling       — SignalingClient instance
   *   myKeyString     — my ECDSA public key, JSON string (my channel id)
   *   onSystemMessage — (text) → ChatUI system row for this peer's thread
   *   onSessionOpen   — (session) DataChannel open, chat input enabled
   *   onSessionClosed — (session, {silent}) teardown complete, input disabled
   *   onIncomingMessage — (record, {history:boolean}) decrypted+stored msg
   */
  constructor(deps) {
    this.deps = deps;
    this.signaling = deps.signaling;
    this.myKeyString = deps.myKeyString;

    this.role = null; // "offerer" | "answerer"
    this.peerKeyString = null;
    this.peerRecord = null;

    this.pc = null;
    this.dc = null;
    this.sharedKey = null;      // AES-GCM CryptoKey (session, memory only)
    this.ecdhSession = null;    // { keypair, publicKeyJwk } — dropped on teardown

    this._timers = {};
    this._pendingCandidates = [];
    this._remoteDescSet = false;
    this._open = false;         // DataChannel reached "open"
    this._dropNotified = false; // dedupe PEER DISCONNECTED vs CONNECTION LOST
    this._tornDown = false;
    this._iceConnectedAtLeastOnce = false;
    this._channelRecreateTried = false;
  }

  /* =============================== OFFERER ================================ */

  /** §8.2 — the initiator path: knock, wait acceptance, offer, connect. */
  async initiate(peerRecord) {
    this.role = "offerer";
    this.peerRecord = peerRecord;
    this.peerKeyString = jwkToString(peerRecord.public_key);

    /* Session ECDH keypair + knock payload carrying my ECDH public half
     * (FR-13 — initiator exchanges the ECDH key via the knock payload). */
    this.ecdhSession = await generateSessionEcdh();
    const sent = this.signaling.knock(this.peerKeyString, {
      ecdhPublicKey: this.ecdhSession.publicKeyJwk,
      timestamp: new Date().toISOString(),
    });
    if (!sent) {
      this.deps.onSystemMessage("SIGNAL LOST — RECONNECT BEFORE KNOCKING");
      this._teardown({ silent: true });
      return false;
    }

    /* §8.3 — knock acceptance timeout → E-04 PEER UNAVAILABLE. */
    this._arm("knock", KNOCK_TIMEOUT_MS, () => {
      this.deps.onSystemMessage("PEER UNAVAILABLE");
      this._teardown({});
    });

    /* v2.2 mesh — event handlers are invoked by main.js's app-level router
     * (lookup by `from` key), not self-registered per session. */
    return true;
  }

  async _onKnockAccepted(from, theirEcdhJwk) {
    if (from !== this.peerKeyString || this._tornDown) return;

    this._disarm("knock");

    /* §4.3 — derive the shared secret immediately after both ECDH public
     * keys are available, BEFORE the DataChannel opens (FR-14). */
    this.sharedKey = await deriveSharedSecret(
      this.ecdhSession.keypair.privateKey,
      theirEcdhJwk
    );

    this._createPeerConnection();

    /* §3.7 — offerer creates the DataChannel: ordered, reliable. */
    this._wireDataChannel(this.pc.createDataChannel("chat", { ordered: true }));

    /* §8.2 — create and send the SDP offer. */
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.signaling.sendOffer(this.peerKeyString, this.pc.localDescription);

    /* §8.3 — ICE gathering/connection timeout, 15 s from offer creation. */
    this._arm("ice", ICE_TIMEOUT_MS, () => this._connectionFailed());
  }

  _onRoomFull() {
    /* E-06, v2.2 mesh semantics — the SAME pair already has a session or a
     * handshake in flight (the server dropped this knock so the two
     * handshakes could not interleave SDP). A third peer knocking a busy
     * target is never blocked anymore. */
    this.deps.onSystemMessage(
      "SESSION WITH THIS PEER IS ALREADY ACTIVE OR CONNECTING — SWITCH THREADS OR DISCONNECT FIRST."
    );
    this._teardown({});
  }

  _onKnockRejected() {
    /* E-05 — the receiver declined (FR-15c path). */
    this.deps.onSystemMessage("CONNECTION DECLINED");
    this._teardown({});
  }

  async _onAnswer(from, answer) {
    if (from !== this.peerKeyString || this._tornDown || !this.pc) return;
    if (this.pc.signalingState === "have-local-offer") {
      await this.pc.setRemoteDescription(answer);
      this._remoteDescSet = true;
      this._flushPendingCandidates();
    }
  }

  /* =============================== ANSWERER =============================== */

  /**
   * §8.2 answerer path. main.js has ALREADY done the known_peers check and
   * auto-add (FR-15 / E-12 handling) before calling this.
   * @param {object} knock { from (key string), ecdhPublicKey (JWK) }
   * @param {object} peerRecord the (new or existing) known_peers record
   */
  async acceptIncoming(knock, peerRecord) {
    this.role = "answerer";
    this.peerRecord = peerRecord;
    this.peerKeyString = knock.from;

    /* My own session ECDH keypair; derive the shared secret right away —
     * both ECDH public keys are available at knock time (§4.3 timing). */
    this.ecdhSession = await generateSessionEcdh();
    this.sharedKey = await deriveSharedSecret(
      this.ecdhSession.keypair.privateKey,
      knock.ecdhPublicKey
    );

    /* §4.5 — knock acceptance message back to the initiator, carrying my
     * ECDH session public key, BEFORE the SDP offer is created. */
    this.signaling.knockAccept(this.peerKeyString, this.ecdhSession.publicKeyJwk);

    this._createPeerConnection();
  }

  async _onOffer(from, offer) {
    if (from !== this.peerKeyString || this._tornDown || !this.pc) return;

    await this.pc.setRemoteDescription(offer);
    this._remoteDescSet = true;
    this._flushPendingCandidates();

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.signaling.sendAnswer(this.peerKeyString, this.pc.localDescription);

    /* §8.3 — the answerer arms the same 15 s ICE timeout from answer
     * creation (mirrors "from offer creation" on the offerer side). */
    this._arm("ice", ICE_TIMEOUT_MS, () => this._connectionFailed());
  }

  /* ============================ shared machinery ========================== */

  _createPeerConnection() {
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS }); // §3.6, FR-17

    this.pc.onicecandidate = (event) => {
      /* trickle ICE — every non-null local candidate goes to the peer. */
      if (event.candidate) {
        this.signaling.sendIceCandidate(this.peerKeyString, event.candidate);
      }
    };

    if (this.role === "answerer") {
      /* The answerer receives the offerer's channel. */
      this.pc.ondatachannel = (event) => this._wireDataChannel(event.channel);
    }

    this.pc.oniceconnectionstatechange = () => this._onIceStateChange();
    this.pc.onconnectionstatechange = () => {
      /* §8.5 — the RTCPeerConnection may still be healthy when a channel
       * dies; conversely a dead PC means a dead session. */
      if (
        this.pc &&
        (this.pc.connectionState === "failed" || this.pc.connectionState === "closed") &&
        !this._tornDown
      ) {
        this._connectionLost();
      }
    };
  }

  _onIceStateChange() {
    if (!this.pc || this._tornDown) return;
    const state = this.pc.iceConnectionState;

    if (state === "connected" || state === "completed") {
      this._disarm("iceDiscGrace");
      if (!this._iceConnectedAtLeastOnce) {
        this._iceConnectedAtLeastOnce = true;
        /* §8.3 — DataChannel must open within 5 s of ICE connecting. */
        if (!this._open) {
          this._arm("dcOpen", DC_OPEN_TIMEOUT_MS, () => this._connectionFailed());
        }
      }
    } else if (state === "failed") {
      /* §8.4 — immediate failure: close, E-07, no automatic retry. */
      this._connectionFailed();
    } else if (state === "disconnected") {
      /* §8.4 — transient: wait 5 s for recovery before declaring failure. */
      if (!this._timers.iceDiscGrace) {
        this._arm("iceDiscGrace", ICE_DISCONNECT_GRACE_MS, () => {
          if (this.pc && this.pc.iceConnectionState !== "connected" && this.pc.iceConnectionState !== "completed") {
            this._connectionFailed();
          }
        });
      }
    }
  }

  _wireDataChannel(dc) {
    this.dc = dc;

    dc.onopen = () => {
      this._open = true;
      this._disarm("dcOpen");
      this._disarm("ice"); // §8.3 — timers "cleared on success"
      /* v2.2 — tell the post office the pair is live: its pair state gates
       * duplicate knocks and routes the eventual clean session-end. */
      this.signaling.sessionOpen(this.peerKeyString);
      this.deps.onSessionOpen(this);
      /* §8.2 (v2.3, FR-23 revised) — BILATERAL history seeding: BOTH peers
       * send their local history for this thread when the channel opens, so
       * a fresh device on EITHER side recovers the full conversation (the
       * v1 behaviour seeded offerer → answerer only — former limitation
       * L-6, resolved). Merge is idempotent (existing ids are never
       * overwritten), so the two crossing envelopes are harmless. The
       * short delay keeps the open-event race mitigated (L-1): it
       * guarantees the receiving side's ondatachannel wiring is complete
       * before either batch lands (hardening observed in cross-browser
       * testing — see DOCUMENTATION.md §11 Step 8). */
      setTimeout(() => {
        if (this._tornDown || !this._open) return;
        seedHistory(this).catch((err) => {
          console.error("[sync] history seeding failed", err);
        });
      }, 400);
    };

    dc.onmessage = (event) => this._onChannelMessage(event);

    dc.onclose = () => this._onChannelClosed("closed");
    dc.onerror = () => this._onChannelClosed("error");
  }

  async _onChannelMessage(event) {
    let envelope;
    try {
      envelope = JSON.parse(event.data);
    } catch {
      console.warn("[dc] non-JSON frame dropped");
      return; // malformed frame — ignore (transport is DTLS-authenticated)
    }
    console.log("[dc] envelope:", envelope.t, "len:", event.data.length);
    if (envelope.t !== "msg" && envelope.t !== "seed" && envelope.t !== "ctrl") return;

    let plaintext;
    try {
      plaintext = await decryptMessage(this.sharedKey, envelope.iv, envelope.ct);
    } catch {
      /* E-10 — tampered or undecryptable payload renders inline. */
      this.deps.onIncomingMessage(
        { decryptionFailed: true, peer: this.peerKeyString },
        {}
      );
      return;
    }

    if (envelope.t === "ctrl") {
      /* v2.2 FR-53 — control frames: currently only {action:"bye"}, the
       * encrypted clean-disconnect notice from the far side. */
      let ctrl;
      try {
        ctrl = JSON.parse(plaintext);
      } catch {
        return;
      }
      if (ctrl && ctrl.action === "bye" && !this._tornDown) {
        this._dropNotified = true; // dedupe: no second CONNECTION LOST row
        this.deps.onSystemMessage("PEER DISCONNECTED — THEY ENDED THE SESSION");
        this._teardown({ silent: true });
      }
      return;
    }

    if (envelope.t === "msg") {
      const payload = JSON.parse(plaintext);
      /* UC-07 — received live messages store with status "seeded". */
      const stored = await receiveSeed([payload], this.peerKeyString, this.myKeyString, { history: false });
      for (const record of stored) this.deps.onIncomingMessage(record, { history: false });
    } else {
      const batch = JSON.parse(plaintext);
      const stored = await receiveSeed(batch, this.peerKeyString, this.myKeyString, { history: true });
      for (const record of stored) this.deps.onIncomingMessage(record, { history: true });
    }
  }

  /** UC-06 — send a text message over the open channel.
   *  1 fresh IV → encrypt → store plaintext locally → send → (caller renders). */
  async sendText(content) {
    if (!this.dc || this.dc.readyState !== "open" || !this.sharedKey) return null;

    const record = await addLocalMessage({
      content,
      timestamp: new Date().toISOString(),
      sender: this.myKeyString,
      peer: this.peerKeyString,
    });

    const { iv, ct } = await encryptMessage(
      this.sharedKey,
      JSON.stringify({
        id: record.id,
        content: record.content,
        timestamp: record.timestamp,
        sender: this.myKeyString,
      })
    );
    this.dc.send(JSON.stringify({ t: "msg", iv, ct }));
    return record;
  }

  /** v2.2 FR-53 — clean, user-initiated disconnect. Keeps the contact and
   *  the message history; ends only the live session.
   *    1. an encrypted {action:"bye"} frame tells the far side immediately
   *       (its UI settles at once instead of waiting for ICE/DC timers)
   *    2. session-end clears the server's pair state
   *    3. the normal §8.3 teardown drops the session ECDH keypair
   *  When the channel is not open yet (handshake running), the knock is
   *  simply cancelled — `note` explains that in the thread. */
  async disconnect({ note = "YOU DISCONNECTED — SESSION ENDED" } = {}) {
    if (this._tornDown) return;

    if (this.dc && this.dc.readyState === "open" && this.sharedKey) {
      try {
        const { iv, ct } = await encryptMessage(
          this.sharedKey,
          JSON.stringify({ action: "bye" })
        );
        this.dc.send(JSON.stringify({ t: "ctrl", iv, ct }));
      } catch {
        /* best effort — the far side falls back to its own loss timers */
      }
    }

    this.deps.onSystemMessage(note);
    this._teardown({ silent: true });
  }

  _onChannelClosed() {
    if (this._tornDown) return;

    /* §8.5 — display CONNECTION LOST, disable input, and if the PC is still
     * connected try to re-create the DataChannel ONCE (offerer side only —
     * the answerer re-wires via ondatachannel). */
    if (this.role === "offerer" && this.pc && this.pc.connectionState === "connected" && !this._channelRecreateTried) {
      this._channelRecreateTried = true;
      this.deps.onSystemMessage("RE-ESTABLISHING DATA CHANNEL...");
      const dc = this.pc.createDataChannel("chat", { ordered: true });
      this._wireDataChannel(dc);
      this._open = false;
      this._arm("dcRecreate", DC_RECREATE_TIMEOUT_MS, () => {
        if (!this._open) this._connectionLost();
      });
      return;
    }
    this._connectionLost();
  }

  _onPeerDisconnected(publicKey) {
    if (publicKey !== this.peerKeyString || this._tornDown) return;
    /* UC-09 — server notification that the other side went away. */
    if (!this._dropNotified) {
      this._dropNotified = true;
      this.deps.onSystemMessage("PEER DISCONNECTED");
    }
    this._teardown({});
  }

  /* ------------------------------ failure states -------------------------- */

  _connectionFailed() {
    if (this._tornDown) return;
    this.deps.onSystemMessage("CONNECTION FAILED — COULD NOT ESTABLISH P2P LINK"); // E-07
    this._teardown({});
  }

  _connectionLost() {
    if (this._tornDown) return;
    if (!this._dropNotified) {
      this._dropNotified = true;
      this.deps.onSystemMessage("CONNECTION LOST"); // E-08
    }
    this._teardown({});
  }

  /* ------------------------------ timers / teardown ------------------------ */

  _arm(name, ms, fn) {
    this._disarm(name);
    this._timers[name] = setTimeout(() => {
      this._timers[name] = null;
      fn();
    }, ms);
  }

  _disarm(name) {
    if (this._timers[name]) {
      clearTimeout(this._timers[name]);
      this._timers[name] = null;
    }
  }

  /**
   * §8.3 / §8.9 teardown: close the PC, drop the session ECDH keypair from
   * memory (NFR-04), clear every timer, tell the post office the pair is
   * over (v2.2 — session-end; best effort, the server sweeps stale
   * pending pairs), and hand control back to the app (onSessionClosed
   * drops this session from the mesh map). Handler deregistration is not
   * needed here: v2.2 routes signaling events through ONE app-level router
   * in main.js that resolves sessions by peer key at event time.
   */
  _teardown({ silent = false } = {}) {
    if (this._tornDown) return;
    this._tornDown = true;

    for (const name of Object.keys(this._timers)) this._disarm(name);

    try {
      if (this.peerKeyString) this.signaling.sessionEnd(this.peerKeyString);
    } catch {
      /* socket gone — the server's pending sweep / disconnect notice covers it */
    }

    try {
      if (this.pc) this.pc.close(); // §8.3 / §8.4
    } catch { /* already closed */ }
    this.pc = null;
    this.dc = null;
    this.sharedKey = null;    // ECDH-derived AES key: memory only
    this.ecdhSession = null;  // §8.3 — "cleans up the session ECDH keypair"

    this.deps.onSessionClosed(this, { silent });
  }

  _onRemoteCandidate(from, candidate) {
    if (from !== this.peerKeyString || this._tornDown || !this.pc) return;
    if (!candidate) return;
    if (!this._remoteDescSet) {
      /* trickle ICE — buffer until the remote description is set. */
      this._pendingCandidates.push(candidate);
      return;
    }
    this.pc.addIceCandidate(candidate).catch(() => {
      /* stale/late candidate — harmless during teardown races */
    });
  }

  _flushPendingCandidates() {
    const list = this._pendingCandidates;
    this._pendingCandidates = [];
    for (const candidate of list) {
      this.pc.addIceCandidate(candidate).catch(() => {});
    }
  }

  get isOpen() {
    return Boolean(this._open && this.dc && this.dc.readyState === "open");
  }
}
