/* signaling-client.js — SignalingClient (SRS §12, §3.5, §8.9, §15.2, §15.3)
 *
 * "The signaling server is a post box, not a service."
 *
 * v2.3 BINDING INTERFACE (§15.2) — dynamic handler registration:
 *
 *     signalingClient.setHandler(eventName, handlerFn);  // register/replace
 *     signalingClient.removeHandler(eventName);           // deregister
 *     signalingClient.clearHandlers();                    // deregister all
 *
 * All socket events route through the internal handler map. PeerConnection
 * registers its handlers via setHandler() using a tracked list and removes
 * them on session teardown (§8.9). PROHIBITED: assigning handlers as direct
 * object properties (signalingClient.onOffer = fn) — silently ignored.
 *
 * Every handler invocation uses optional chaining `?.` (§15.3): a missing
 * handler is not an error, it means no subscriber for this session.
 *
 * Reconnection (FR-33/34/35): socket.io built-in reconnection is DISABLED;
 * an explicit ladder with exponential backoff 1s → 2s → 4s (cap 30s) runs
 * while no WebRTC DataChannel is active. After 3 failed attempts the client
 * stops and reports SIGNAL LOST until the user manually retries.
 */

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];
const MAX_ATTEMPTS = 3; // FR-35 — stop after 3 attempts
const CONNECT_TIMEOUT_MS = 6000;

export default class SignalingClient {
  /**
   * @param {string|null} path null → same-origin ("/"); or a gateway path
   *        such as "/?XTransformPort=3003" (see config.js).
   */
  constructor(path = null) {
    this._path = path;
    this._socket = null;
    this._handlers = {};          // §15.2 handler map
    this._myPublicKey = null;     // re-join room after reconnect (FR-05)
    this._sessionActive = false;  // true while a DataChannel is open (FR-34)
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._state = "idle"; // idle | connecting | online | reconnecting | lost
    this._statusCb = null;
  }

  /* ------------------------------------------------------------------ status */

  onStatusChange(cb) {
    this._statusCb = cb;
    cb(this._state);
  }

  _setState(state) {
    if (this._state === state) return;
    this._state = state;
    if (this._statusCb) this._statusCb(state);
  }

  get state() {
    return this._state;
  }

  isConnected() {
    return Boolean(this._socket && this._socket.connected);
  }

  /** FR-34 — the app marks a live DataChannel so a signaling drop never
   *  disrupts the session (no reconnect attempts while active). */
  setSessionActive(active) {
    this._sessionActive = active;
    if (!active && this._socket && !this._socket.connected && this._state === "online") {
      // Session just ended but the socket quietly died during it — recover.
      this._scheduleReconnect(0);
    }
  }

  /* ------------------------------------------------------------- connection */

  connect(myPublicKeyString) {
    this._myPublicKey = myPublicKeyString;
    this._clearReconnectTimer();
    this._reconnectAttempts = 0;
    this._openSocket();
  }

  _openSocket() {
    if (this._socket) {
      this._socket.removeAllListeners();
      this._socket.disconnect();
      this._socket = null;
    }

    this._setState(this._reconnectAttempts > 0 ? "reconnecting" : "connecting");

    const opts = {
      reconnection: false, // explicit ladder below (FR-33)
      timeout: CONNECT_TIMEOUT_MS,
      transports: ["polling", "websocket"],
    };
    this._socket = this._path ? io(this._path, opts) : io(opts);

    this._wireSocket(this._socket);
  }

  _wireSocket(socket) {
    socket.on("connect", () => {
      this._reconnectAttempts = 0;
      /* FR-05 — (re)subscribe to my own public key channel. */
      socket.emit("join-room", { publicKey: this._myPublicKey });
      this._setState("online");
    });

    socket.on("disconnect", () => {
      if (this._sessionActive) {
        /* FR-34 — DataChannel active: the session continues unaffected.
         * No reconnect attempts, no status change; recover lazily when the
         * session ends (see setSessionActive). */
        return;
      }
      this._scheduleReconnect(0);
    });

    socket.on("connect_error", () => {
      if (this._sessionActive) return;
      this._scheduleReconnect(this._reconnectAttempts);
    });

    /* ------------------ §15.2 routing layer (verbatim contract) ----------
     * Every invocation uses optional chaining (§15.3). A missing handler
     * is not an error — it means no subscriber registered this session. */
    socket.on("knock", (data) =>
      this._handlers.onKnock?.(data.from, data.ecdhPublicKey, data.timestamp)
    );
    socket.on("knock-accepted", (data) =>
      this._handlers.onKnockAccepted?.(data.from, data.ecdhPublicKey)
    );
    socket.on("knock-rejected", (data) =>
      this._handlers.onKnockRejected?.(data.from)
    );
    socket.on("room-full", (data) => this._handlers.onRoomFull?.(data.to));
    socket.on("offer", (data) =>
      this._handlers.onOffer?.(data.from, data.offer)
    );
    socket.on("answer", (data) =>
      this._handlers.onAnswer?.(data.from, data.answer)
    );
    socket.on("ice-candidate", (data) =>
      this._handlers.onIceCandidate?.(data.from, data.candidate)
    );
    socket.on("peer-disconnected", (data) =>
      this._handlers.onPeerDisconnected?.(data.publicKey)
    );
  }

  /* ------------------------------------------------- reconnection ladder */

  _scheduleReconnect(attemptIndex) {
    this._clearReconnectTimer();

    if (this._socket && this._socket.connected) return; // raced a recovery

    if (this._reconnectAttempts >= MAX_ATTEMPTS) {
      /* FR-35 / E-03 — SIGNAL LOST; stop until the user retries. */
      this._setState("lost");
      return;
    }

    const delay =
      RECONNECT_DELAYS[Math.min(attemptIndex, RECONNECT_DELAYS.length - 1)];
    this._setState("reconnecting");
    this._reconnectAttempts += 1;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._openSocket();
    }, delay);
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  /** Manual retry (E-01/E-03 recovery — status bar tap, Settings button). */
  manualReconnect() {
    if (this.isConnected()) return;
    this._reconnectAttempts = 0;
    this._clearReconnectTimer();
    this._openSocket();
  }

  /* ------------------------------------------------------- handler map §15.2 */

  setHandler(eventName, handlerFn) {
    if (typeof handlerFn !== "function") {
      delete this._handlers[eventName]; // setHandler(name, null) → deregister
      return;
    }
    this._handlers[eventName] = handlerFn;
  }

  removeHandler(eventName) {
    delete this._handlers[eventName];
  }

  clearHandlers() {
    this._handlers = {};
  }

  /* ------------------------------------------------------- outbound events */

  _emit(event, payload) {
    if (!this._socket || !this._socket.connected) return false;
    this._socket.emit(event, payload);
    return true;
  }

  /** FR-10 / §4.5 — knock payload carries my ECDH session public key. */
  knock(targetPublicKeyString, { ecdhPublicKey, timestamp }) {
    return this._emit("knock", {
      to: targetPublicKeyString,
      ecdhPublicKey,
      timestamp,
    });
  }

  /** §4.5 — knock acceptance: answerer's ECDH public key back to initiator. */
  knockAccept(targetPublicKeyString, ecdhPublicKey) {
    return this._emit("knock-accept", { to: targetPublicKeyString, ecdhPublicKey });
  }

  /** FR-15c — E-05 CONNECTION DECLINED path. */
  knockReject(targetPublicKeyString) {
    return this._emit("knock-reject", { to: targetPublicKeyString });
  }

  sendOffer(targetPublicKeyString, offer) {
    return this._emit("offer", { to: targetPublicKeyString, offer });
  }

  sendAnswer(targetPublicKeyString, answer) {
    return this._emit("answer", { to: targetPublicKeyString, answer });
  }

  sendIceCandidate(targetPublicKeyString, candidate) {
    return this._emit("ice-candidate", { to: targetPublicKeyString, candidate });
  }
}
