/* settings-view.js — Settings view (SRS §10.4, UC-08, UC-10, NFR-14…NFR-19)
 *
 * Sections:
 *   IDENTITY    — full public key, COPY KEY, EXPORT DATA
 *   APPEARANCE  — radio-style theme buttons (Void Brown, Slime Green, CRT
 *                 Phosphor, Dust, Custom) + custom colour pickers, preview
 *                 applies immediately to :root
 *   NETWORK     — signaling status + RECONNECT (enabled only when lost)
 *   DANGER ZONE — CLEAR ALL DATA with confirmation prompt
 */

import { el, $, copyText } from "./utils.js";
import { THEME_IDS, setTheme, previewCustom, getThemeRecord } from "./theme-service.js";
import { showModal } from "./components.js";

let callbacks = null;
let netState = "idle";

export function initSettingsView(cb) {
  callbacks = cb;

  $("btn-copy-key").addEventListener("click", async () => {
    await copyText(callbacks.getMyPublicKeyString());
    flashButton($("btn-copy-key"), "COPIED!");
  });

  $("btn-export-data").addEventListener("click", async () => {
    try {
      const filename = await callbacks.onExportData();
      flashButton($("btn-export-data"), filename ? "SAVED" : "DONE");
    } catch {
      flashButton($("btn-export-data"), "FAILED");
    }
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
