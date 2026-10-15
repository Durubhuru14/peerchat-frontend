/* Runtime configuration — PeerChat.
 *
 * signalingPath: the Socket.io connection target.
 *   - Standalone deployment (default): null → same-origin socket (the Express
 *     server in backend/index.js serves both the frontend and Socket.io).
 *   - Hosted preview behind a gateway: "/?XTransformPort=3003" (the gateway
 *     routes any request carrying that query to the signaling service).
 *   - Split hosting (frontend and backend deployed as their own repos, e.g.
 *     Netlify + Render): the backend's full origin, e.g.
 *     "https://peerchat-signal.onrender.com".
 *
 * Only this file differs between deployment shapes; the app code is identical.
 */
window.APP_CONFIG = {
  signalingPath: "https://peerchat-backend-i484.onrender.com",
  /* Optional label shown in the status bar right slot (deployment info) */
  statusSuffix: "",
};
