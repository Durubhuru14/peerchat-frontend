/* contacts-view.js — Contacts view (SRS §10.3, FR-06…FR-09, UC-03)
 *
 * - List of known peers: nickname if set, otherwise truncated public key,
 *   plus last-seen stamp.
 * - ADD CONTACT opens an inline form: public key paste (validated as a JWK
 *   ECDSA P-256 public key, UC-03 step 4), optional local nickname, confirm.
 * - Tapping a peer opens the peer detail panel: full public key (copyable),
 *   editable nickname, date added, last seen, CONNECT and REMOVE.
 *   Removing a peer deletes them from known_peers only — their message
 *   history is NOT deleted in V1.
 */

import { el, $, stringToJwk, isValidPublicJwk, jwkToString, formatSeen, formatFullISO, copyText, getPublicKeyFingerprint } from "./utils.js";
import { attachScrollbar, showModal } from "./components.js";

let callbacks = null;

export function initContactsView(cb) {
  callbacks = cb;
  const list = $("contacts-list");
  attachScrollbar(list, $("contacts-scrollbar"));

  $("btn-add-contact").addEventListener("click", () => {
    const form = $("add-contact-form");
    form.classList.toggle("hidden");
    form.classList.toggle("flex");
    $("add-contact-key").value = "";
    $("add-contact-nickname").value = "";
    hideAddError();
    if (!form.classList.contains("hidden")) $("add-contact-key").focus();
  });

  $("btn-add-cancel").addEventListener("click", () => {
    $("add-contact-form").classList.add("hidden");
    $("add-contact-form").classList.remove("flex");
  });

  $("add-contact-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const raw = $("add-contact-key").value.trim();
    const nickname = $("add-contact-nickname").value.trim();
    const jwk = stringToJwk(raw);
    if (!jwk || !isValidPublicJwk(jwk)) {
      showAddError("INVALID KEY — EXPECTED ECDSA P-256 PUBLIC KEY IN JWK FORMAT");
      return;
    }
    const ok = await callbacks.onAddPeer(jwk, nickname || null);
    if (ok) {
      $("add-contact-form").classList.add("hidden");
      $("add-contact-form").classList.remove("flex");
    } else {
      showAddError("COULD NOT SAVE PEER — LOCAL STORAGE UNAVAILABLE?");
    }
  });
}

function showAddError(text) {
  const err = $("add-contact-error");
  err.textContent = text;
  err.classList.remove("hidden");
}
function hideAddError() {
  $("add-contact-error").classList.add("hidden");
}

/** Display label for a peer: nickname or truncated key (§10.3). */
export function peerLabel(peerRecord) {
  return peerRecord.nickname || peerRecord._fingerprint || "PEER";
}

/** Render the full contacts list (FR-09). */
export function renderContacts(peers, { activeSessionPeerKey }) {
  const list = $("contacts-list");
  list.replaceChildren();

  const count = $("contacts-count");
  count.textContent = peers.length ? `${peers.length} PEER(S)` : "";

  $("contacts-empty").classList.toggle("hidden", peers.length > 0);

  for (const p of peers) {
    const fp = p._fingerprint || "";
    const busy = activeSessionPeerKey === p._key;
    list.appendChild(
      el("div", {
        class: `contact-row ${busy ? "contact-row--active" : ""}`,
        onclick: () => openPeerDetail(p),
      },
        el("div", { class: "flex-1 min-w-0" },
          el("div", { class: "text-[12px] truncate", text: peerLabel(p) }),
          el("div", { class: "text-[10px] text-dim uppercase tracking-tight", text: `${fp || jwkToString(p.public_key).slice(0, 24)}…` }),
        ),
        el("div", { class: "flex flex-col items-end flex-none" },
          el("div", { class: "text-[10px] text-dim uppercase tracking-tight", text: `SEEN: ${formatSeen(p.last_seen)}` }),
          busy ? el("div", { class: "text-[10px] text-accent2", text: "● CONNECTED" }) : null,
        ),
      )
    );
  }
}

/** Peer detail panel (§10.3) — draggable modal window. */
function openPeerDetail(peer) {
  const keyString = jwkToString(peer.public_key);

  const body = el("div", { class: "flex flex-col gap-2" });
  body.appendChild(el("div", { class: "text-[11px] uppercase tracking-tight text-dim", text: "PUBLIC KEY (COPYABLE):" }));
  const keyBox = el("div", {
    class: "bevel-in bg-sunken p-2 h-28 overflow-y-auto text-[11px] leading-relaxed break-all select-text",
    text: keyString,
  });
  body.appendChild(keyBox);
  body.appendChild(el("div", { class: "flex gap-1 flex-wrap" },
    el("button", { class: "widget-btn", type: "button", text: "COPY KEY", onclick: async () => { await copyText(keyString); } }),
  ));

  body.appendChild(el("div", { class: "flex items-center gap-2 flex-wrap" },
    el("label", { class: "text-[11px] uppercase tracking-tight text-dim", text: "NICKNAME:" }),
    el("input", { class: "widget-input flex-1 min-w-[160px]", id: "detail-nickname", maxlength: "32", value: peer.nickname || "" }),
    el("button", {
      class: "widget-btn", type: "button", text: "SAVE",
      onclick: async () => {
        const val = document.getElementById("detail-nickname").value.trim();
        await callbacks.onRenamePeer(peer.public_key, val);
        modal.close();
      },
    }),
  ));

  body.appendChild(el("div", { class: "text-[11px] text-dim uppercase tracking-tight flex flex-col gap-1" },
    el("div", { text: `ADDED: ${peer.added_at ? formatFullISO(peer.added_at) : "UNKNOWN"}` }),
    el("div", { text: `LAST SEEN: ${peer.last_seen ? formatFullISO(peer.last_seen) : "NEVER"}` }),
  ));

  const modal = showModal({
    title: `PEER: ${peerLabel(peer)}`,
    bodyNode: body,
    buttons: [
      {
        label: "CONNECT",
        primary: true,
        onClick: () => { callbacks.onConnect(peer); },
      },
      {
        label: "REMOVE",
        onClick: async () => {
          /* Removing deletes the peer only — message history survives (§10.3). */
          const confirm = showModal({
            title: "REMOVE PEER",
            bodyText: `REMOVE ${peerLabel(peer)} FROM CONTACTS? THEIR MESSAGE HISTORY IS KEPT.`,
            buttons: [
              {
                label: "REMOVE", primary: true,
                onClick: async () => { await callbacks.onRemovePeer(peer.public_key); },
              },
              { label: "CANCEL" },
            ],
          });
          return false; // keep outer modal open underneath
        },
      },
    ],
  });
}

export function focusList() {
  $("contacts-list").focus?.();
}
