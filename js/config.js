/* Runtime configuration — Decentralised P2P Chat.
 *
 * signalingPath: the Socket.io connection target.
 *   - Standalone deployment (default): null → same-origin socket (the Express
 *     server in server/index.js serves both the frontend and Socket.io).
 *   - Hosted preview behind a gateway: "/?XTransformPort=3003" (the gateway
 *     routes any request carrying that query to the signaling service).
 *
 * Only this file differs between deployment shapes; the app code is identical.
 */
window.APP_CONFIG = {
  signalingPath: null,
  /* Optional label shown in the status bar right slot (deployment info) */
  statusSuffix: "",
};
