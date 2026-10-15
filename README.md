# PeerChat — Frontend (v2.3.0)

The browser half of **PeerChat**, a decentralised chat application where
users talk **directly, with no central message server**. Your identity is a
cryptographic keypair generated in your browser — your public key *is* your
address. Messages travel browser-to-browser over WebRTC DataChannels,
encrypted end-to-end with AES-GCM using an ECDH-derived session key that is
never transmitted. History lives in your own IndexedDB, and encrypted backups
move it between devices.

> This repository is **static only** — pure HTML/CSS/JS, no build step, no
> dependencies, nothing to install. To actually connect to another peer it
> needs the **PeerChat signaling server** (the `backend/` repo) running
> somewhere. The signaling server is a "post box": it introduces peers and
> then steps out — it never sees message content, and killing it mid-chat
> does not interrupt an established session.

## What's inside

```
frontend/
├── index.html            the whole app — one page, ES modules
├── js/
│   ├── main.js           boot, views, session routing (mesh)
│   ├── peer-connection.js  WebRTC + ECDH + AES-GCM per-peer sessions
│   ├── signaling-client.js  Socket.io knock/accept/SDP/ICE client
│   ├── crypto-service.js / identity.js / backup-crypto.js
│   ├── message-store.js / message-syncer.js   IndexedDB + bilateral seeding
│   ├── contacts-view.js / chat-ui.js / settings-view.js / components.js
│   ├── known-peers.js / import-service.js / export-service.js
│   ├── theme-service.js / toast.js / utils.js / config.js
│   └── vendor/socket.io.min.js   the only bundled library
├── css/                  Tailwind v4 build (output.css) + source
└── assets/               PeerChat favicon set (SVG + PNG + apple-touch)
```

## Features (v2.3.0)

- **Mesh sessions** — several simultaneous peer chats, one DataChannel each;
  switching threads, unread badges and background-message toasts.
- **Bilateral history seeding** — on connect *both* peers send their local
  thread history; a fresh device on either end recovers the conversation
  (idempotent merge, crossing envelopes are harmless).
- **End-to-end crypto** — ECDSA P-256 identity keys, ECDH P-256 session
  keys, AES-GCM 256 messages; clean disconnect via an encrypted `bye` frame.
- **Encrypted backups** — export identity + contacts + history as an
  AES-256-GCM envelope; import on a new device with your private key.
- **1990s dark-widget UI** — four themes (Void Brown, Slime Green, CRT
  Phosphor, Dust) plus a custom theme with derived tokens.

## Run it locally

The frontend needs a signaling server. Easiest: clone the backend repo
next to this one (as `backend/`, like the combined `peerchat/` layout) —
the server then also serves this folder for you:

```bash
# sibling layout:   ./frontend   ./backend
cd backend && npm install && npm start
# app:  http://localhost:3000
```

Or serve this folder with any static server and point the app at a
separately running backend in `js/config.js`:

```bash
npx serve .                                   # or python3 -m http.server
# backend repo, elsewhere:  npm install && npm start   (→ :3000)
```

```js
// js/config.js
window.APP_CONFIG = { signalingPath: "http://localhost:3000", statusSuffix: "" };
```

Open the app in **two different browser profiles**, copy the public key
from one (Settings → Identity), add it as a contact in the other, press
CONNECT — both sides must be online at the same time.

## Configuration

Only `js/config.js` differs between deployment shapes; the app code is
identical everywhere:

| `signalingPath` | meaning |
|---|---|
| `null` (default) | same-origin Socket.io (frontend served by the backend) |
| `"https://your-service.onrender.com"` | split hosting — backend's full origin |

## Deploy to Netlify

This repo is a ready-made Netlify site — static, no build command:

1. **From Git (recommended):** push this repo to GitHub/GitLab, then in
   Netlify: *Add new site → Import an existing project* → pick the repo.
   Build command: **none** · Publish directory: **`.`** (repo root).
2. **Drag & drop:** zip this folder and drop it on
   [app.netlify.com/drop](https://app.netlify.com/drop).
3. **CLI:** `npx netlify-cli deploy --dir . --prod`

After deploying the backend (see the backend repo), set
`js/config.js` → `signalingPath` to the backend's public origin
(e.g. `https://peerchat-signal.onrender.com`) and redeploy. The backend's
Socket.io CORS reflects the requester's origin by default, so the Netlify
origin works out of the box.

> ⚠️ Don't rely on GitHub Pages' *default* setup or any server without
> HTTPS/wss if you mix http/https origins — browsers block mixed content.
> Netlify + Render are both HTTPS, so the split setup above just works.

## Stack

Vanilla HTML/CSS/JS · Tailwind CSS v4 (prebuilt `output.css`, zero JS
config) · WebRTC DataChannel (ordered, reliable) · Web Crypto API
(ECDSA P-256, ECDH P-256, AES-GCM, PBKDF2) · IndexedDB · Google public
STUN. Modern browsers only (Chrome/Edge/Firefox/Safari, recent).

## The other halves

- **`(backend/)[https://github.com/Durubhuru14/peerchat-backend]`** — the Node signaling server (deploy that one to Render).

## License

MIT
