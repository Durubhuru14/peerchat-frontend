/* settings-view.js — Settings view (SRS §10.4, UC-08, UC-10, NFR-14…NFR-19 + V2)
 *
 * Sections:
 *   IDENTITY    — full public key, COPY KEY, EXPORT DATA (V2: encrypted),
 *                 COPY PRIVATE KEY (V2 — passphrase for backup decryption)
 *   BACKUP      — IMPORT BACKUP (V2 — restore identity + contacts + history
 *                 from an encrypted export file on a new device)
 *   APPEARANCE  — radio-style theme buttons (Void Brown, Slime Green, CRT
 *                 Phosphor, Dust, Custom) + custom colour pickers, preview
 *                 applies immediately to :root
 *   NETWORK     — signaling status + RECONNECT (enabled only when lost)
 *   DANGER ZONE — REGENERATE KEYS (V2 — fresh keypair, old address lost
 *                 forever) and CLEAR ALL DATA with confirmation prompt
 *
 * V2 modals are built with el() and passed to showModal() as bodyNode so
 * they can host inputs, status lines and inline error text.
 */

import { el, $, copyText } from "./utils.js";
import { THEME_IDS, setTheme, previewCustom, getThemeRecord } from "./theme-service.js";
import { showModal } from "./components.js";
import {
  readBackupFile,
  inspectBackup,
  unlockBackup,
  validateBackup,
  restoreBackup,
} from "./import-service.js";

let callbacks = null;
let netState = "idle";

export function initSettingsView(cb) {
  callbacks = cb;

  $("btn-copy-key").addEventListener("click", async () => {
    await copyText(callbacks.getMyPublicKeyString());
    flashButton($("btn-copy-key"), "COPIED!");
  });

  /* ---- V2: COPY PRIVATE KEY (the backup passphrase) --------------------- */
  $("btn-copy-privkey").addEventListener("click", async () => {
    await copyText(callbacks.getMyPrivateKeyString());
    flashButton($("btn-copy-privkey"), "COPIED!");
  });

  $("btn-export-data").addEventListener("click", async () => {
    try {
      const filename = await callbacks.onExportData();
      flashButton($("btn-export-data"), filename ? "SAVED" : "DONE");
    } catch {
      flashButton($("btn-export-data"), "FAILED");
    }
  });

  /* ---- V2: IMPORT BACKUP — multi-step restore modal ---------------------- */
  $("btn-import-backup").addEventListener("click", showImportBackupModal);

  /* ---- V2: REGENERATE KEYS — destructive confirmation -------------------- */
  $("btn-regenerate-keys").addEventListener("click", () => {
    showModal({
      title: "REGENERATE.DAT",
      bodyText:
        "THIS WILL GENERATE A FRESH KEYPAIR AND PERMANENTLY DELETE YOUR CURRENT IDENTITY AND CONTACT LIST. " +
        "YOUR OLD PUBLIC KEY ADDRESS WILL BE LOST FOREVER — NOBODY CAN REACH YOU ON IT AGAIN. " +
        "OLD ENCRYPTED BACKUPS CAN ONLY BE DECRYPTED WITH THE OLD PRIVATE KEY: COPY IT NOW IF YOU STILL WANT IT. " +
        "MESSAGE HISTORY IS KEPT BUT BECOMES UNREACHABLE. THIS CANNOT BE UNDONE.",
      buttons: [
        {
          label: "REGENERATE KEYS",
          primary: true,
          onClick: () => {
            callbacks.onRegenerateKeys(); // async: regenerate + reload
          },
        },
        { label: "CANCEL" },
      ],
    });
  });

  /* ---- theme radio group (square widgets, x glyph for selection) ------ */
  const options = [...$("theme-selector").querySelectorAll(".theme-option")];
  options.forEach((opt, i) => {
    opt.addEventListener("click", async () => {
      const id = THEME_IDS[i];
      if (id === "custom") {
        $("custom-theme-controls").classList.remove("hidden");
        $("custom-theme-controls").classList.add("flex");
        applyCustomPreview();
      } else {
        $("custom-theme-controls").classList.add("hidden");
        $("custom-theme-controls").classList.remove("flex");
        await setTheme(id); // UC-10 — immediate :root swap + persistence
      }
      syncThemeSelection(id);
    });
  });

  $("custom-accent").addEventListener("input", applyCustomPreview);
  $("custom-bg").addEventListener("input", applyCustomPreview);
  $("btn-custom-apply").addEventListener("click", async () => {
    const accent = $("custom-accent").value;
    const bg = $("custom-bg").value;
    await setTheme("custom", { accent, bg });
    syncThemeSelection("custom");
  });

  $("btn-reconnect").addEventListener("click", () => callbacks.onReconnect());

  /* ---- Danger zone (§10.4) — exact confirmation text ------------------ */
  $("btn-clear-data").addEventListener("click", () => {
    showModal({
      title: "CLEAR ALL DATA",
      bodyText: "THIS WILL DELETE YOUR IDENTITY AND ALL MESSAGES. THIS CANNOT BE UNDONE.",
      buttons: [
        {
          label: "DELETE EVERYTHING",
          primary: true,
          onClick: async () => {
            await callbacks.onClearAllData(); // deletes DB, reloads app
          },
        },
        { label: "CANCEL" },
      ],
    });
  });

  renderMyKey();
}

/* ======================= V2 — Import Backup modal ========================= */

/**
 * Multi-step restore flow:
 *   1. pick a file → format detected (encrypted v2 / legacy v1 / unknown)
 *   2. encrypted files: paste the private key that created the backup
 *   3. decrypt → validate (structure + keypair sign/verify consistency)
 *   4. confirm REPLACE of current device data → restore → reload
 *
 * The IMPORT button performs async work while keeping the modal open (it
 * returns false to showModal so the close is managed here, not there).
 */
function showImportBackupModal() {
  let parsed = null; // parsed JSON of the file
  let innerDoc = null; // unlocked inner document (encrypted) or the file itself (legacy)
  let detected = { kind: "unknown", label: "NO FILE SELECTED" };

  const errLine = el("div", {
    class: "hidden text-[11px] uppercase text-err leading-relaxed",
    id: "import-error",
  });

  const fileStatus = el("div", {
    class: "text-[11px] uppercase tracking-tight text-dim leading-relaxed",
    text: "NO FILE SELECTED",
  });

  const fileInput = el("input", {
    class: "widget-input w-full text-[11px]",
    type: "file",
    accept: ".json,.txt,application/json,text/plain",
    id: "import-file",
    "aria-label": "Backup file",
  });

  const keyLabel = el("div", {
    class: "text-[11px] uppercase tracking-tight text-dim",
    text: "PRIVATE KEY (JWK STRING) — DECRYPTION PASSPHRASE",
  });
  const keyArea = el("textarea", {
    class:
      "widget-input font-[inherit] text-[12px] h-24 resize-none leading-relaxed",
    id: "import-key",
    spellcheck: "false",
    placeholder: '{"kty":"EC","crv":"P-256","x":"...","y":"...","d":"..."}',
    "aria-label": "Private key to decrypt the backup",
  });

  const hint = el(
    "div",
    { class: "text-[10px] text-dim uppercase leading-relaxed" },
    "THE KEY THAT DECRYPTS THIS FILE IS THE PRIVATE KEY OF THE DEVICE THAT CREATED IT. COPY IT THERE VIA SETTINGS → COPY PRIVATE KEY."
  );

  const body = el(
    "div",
    { class: "flex flex-col gap-2" },
    el("div", { class: "text-[11px] uppercase tracking-tight text-dim" },
      "SELECT BACKUP FILE (.JSON)"),
    fileInput,
    fileStatus,
    keyLabel,
    keyArea,
    hint,
    errLine
  );

  function showError(text) {
    errLine.textContent = text;
    errLine.classList.remove("hidden");
  }
  function clearError() {
    errLine.classList.add("hidden");
  }

  async function onFileChange() {
    clearError();
    innerDoc = null;
    fileStatus.textContent = "READING...";
    const file = fileInput.files && fileInput.files[0];
    if (!file) {
      detected = { kind: "unknown", label: "NO FILE SELECTED" };
      fileStatus.textContent = "NO FILE SELECTED";
      return;
    }
    try {
      const text = await readBackupFile(file);
      parsed = JSON.parse(text);
      detected = inspectBackup(parsed);
      fileStatus.textContent = detected.label;
      if (detected.kind === "unknown") {
        parsed = null;
        showError("THIS FILE IS NOT A PEERCHAT BACKUP.");
      }
    } catch {
      parsed = null;
      detected = { kind: "unknown", label: "READ FAILED" };
      fileStatus.textContent = "READ FAILED";
      showError("COULD NOT READ THE FILE AS JSON.");
    }
  }

  fileInput.addEventListener("change", () =>
    onFileChange().catch(() => showError("FILE READ FAILED."))
  );

  async function runImport(modal) {
    clearError();
    if (!parsed) {
      showError("SELECT A VALID BACKUP FILE FIRST.");
      return;
    }
    try {
      if (detected.kind === "encrypted") {
        innerDoc = await unlockBackup(parsed, keyArea.value);
      } else if (detected.kind === "legacy") {
        innerDoc = parsed;
      } else {
        showError("SELECT A VALID BACKUP FILE FIRST.");
        return;
      }

      const check = await validateBackup(innerDoc);
      if (!check.ok) {
        innerDoc = null;
        showError(check.error);
        return;
      }

      modal.close();
      showRestoreConfirmation(innerDoc, check.summary);
    } catch (err) {
      innerDoc = null;
      showError(err.message || "IMPORT FAILED.");
    }
  }

  const modal = showModal({
    title: "RESTORE.DAT",
    bodyNode: body,
    buttons: [
      {
        label: "IMPORT",
        primary: true,
        onClick: () => {
          runImport(modal); // async — modal stays open, closed manually
          return false; // keep open while working / on error
        },
      },
      { label: "CANCEL" },
    ],
  });
}

/** Step 2 — final confirmation that this device's data will be replaced. */
function showRestoreConfirmation(doc, summary) {
  const created = summary.created_at || "?";
  const bodyNode = el(
    "div",
    { class: "flex flex-col gap-2" },
    el("div", { class: "text-[12px] leading-relaxed" },
      `BACKUP CONTAINS: IDENTITY (CREATED ${String(created).slice(0, 10)}), ` +
      `${summary.peers} CONTACT${summary.peers === 1 ? "" : "S"}, ` +
      `${summary.messages} MESSAGE${summary.messages === 1 ? "" : "S"}.`),
    el("div", { class: "text-err text-[12px] leading-relaxed uppercase" },
      "RESTORING WILL REPLACE THE IDENTITY, CONTACTS, MESSAGES AND THEME " +
      "CURRENTLY ON THIS DEVICE. ANY ACTIVE CONNECTION IS TERMINATED.")
  );

  showModal({
    title: "RESTORE CONFIRMATION",
    bodyNode,
    buttons: [
      {
        label: "RESTORE & RELOAD",
        primary: true,
        onClick: async () => {
          try {
            await restoreBackup(doc);
            callbacks.onBackupRestored(); // main.js reloads the app
          } catch (err) {
            showModal({
              title: "RESTORE FAILED",
              bodyText: (err && err.message) || "THE BACKUP COULD NOT BE RESTORED.",
              buttons: [{ label: "OK", primary: true }],
            });
          }
        },
      },
      { label: "CANCEL" },
    ],
  });
}

/* =========================== theme / network =============================== */

function applyCustomPreview() {
  /* §10.4 — preview of the selected theme applies immediately to :root. */
  previewCustom($("custom-accent").value, $("custom-bg").value);
  syncThemeSelection("custom");
}

export function syncThemeSelection(activeId) {
  const options = [...$("theme-selector").querySelectorAll(".theme-option")];
  options.forEach((opt, i) => {
    const check = opt.querySelector(".widget-check");
    check.textContent = THEME_IDS[i] === activeId ? "x" : "";
  });
}

/** Reflect persisted theme on launch (pickers, selection, controls). */
export function reflectThemeUI() {
  const record = getThemeRecord();
  syncThemeSelection(record.theme);
  if (record.theme === "custom") {
    if (record.custom_accent) $("custom-accent").value = record.custom_accent;
    if (record.custom_bg) $("custom-bg").value = record.custom_bg;
    $("custom-theme-controls").classList.remove("hidden");
    $("custom-theme-controls").classList.add("flex");
  }
}

function renderMyKey() {
  const box = $("settings-public-key");
  box.textContent = callbacks.getMyPublicKeyString();
}

export function setNetworkStatus(state) {
  netState = state;
  const label = {
    idle: "IDLE",
    connecting: "CONNECTING...",
    online: "ONLINE",
    reconnecting: "RECONNECTING...",
    lost: "SIGNAL LOST",
  }[state] || state.toUpperCase();
  const elx = $("settings-net-status");
  elx.textContent = label;
  elx.className = `text-[12px] uppercase ${state === "lost" ? "text-err" : state === "online" ? "text-accent2" : "text-dim"}`;
  /* §10.4 — RECONNECT enabled only when the connection is lost. */
  $("btn-reconnect").disabled = state !== "lost";
}

function flashButton(btn, text) {
  const original = btn.textContent;
  btn.textContent = text;
  setTimeout(() => {
    btn.textContent = original;
  }, 1200); // no easing — instant swap in and out (§2.3)
}
