/* theme-service.js — ThemeService (SRS §12, NFR-13…NFR-19, UC-10)
 *
 * Token system: every colour is a CSS custom property on :root (NFR-13,
 * NFR-17 minimum set). The @theme block in css/src/input.css maps those
 * runtime tokens to first-class Tailwind utilities; because utilities
 * resolve through var() chains, swapping :root values takes effect
 * immediately without a reload (NFR-16).
 *
 * Four built-in themes ship with V1 (NFR-15):
 *   void-brown   default — charcoal/brown/amber, CRT-warm (§2.3 palette)
 *   slime-green  dark charcoal + acid green, Winamp skin energy
 *   crt-phosphor near-black + green-white, monochrome terminal monitor
 *   dust         light parchment, beige 90s PC tower in daylight (NFR-19)
 * plus "custom" (NFR-18): user picks --accent-primary and --bg-base; the
 * remaining tokens derive automatically.
 */

import { tx, reqAsPromise } from "./db.js";
import { blendHex, luminance, shiftHex, hexToRgb, rgbToHex } from "./utils.js";

export const THEME_IDS = [
  "void-brown",
  "slime-green",
  "crt-phosphor",
  "dust",
  "custom",
];

/* ---------------------------------------------------------------------------
 * Built-in token sets. Every set covers the NFR-17 minimum plus the
 * documented extensions: --titlebar-from/--titlebar-to (§2.3 title bar
 * gradient) and --error (E-10 red-tinted border).
 * ------------------------------------------------------------------------ */
const BUILT_INS = {
  "void-brown": {
    "--bg-base": "#1A1410",
    "--bg-panel": "#2C1F14",
    "--bg-sunken": "#120D08",
    "--border-highlight": "#8B6914",
    "--border-shadow": "#000000",
    "--accent-primary": "#8B6914",
    "--accent-secondary": "#B08A2E",
    "--text-primary": "#D4C4A0",
    "--text-secondary": "#8A7A5C",
    "--scrollbar-track": "#14100A",
    "--scrollbar-thumb": "#4A3820",
    "--titlebar-from": "#3C2510",
    "--titlebar-to": "#1A1410",
    "--error": "#B0402E",
  },

  "slime-green": {
    "--bg-base": "#0F120C",
    "--bg-panel": "#1B2113",
    "--bg-sunken": "#080A06",
    "--border-highlight": "#5A8A10",
    "--border-shadow": "#000000",
    "--accent-primary": "#7CB518",
    "--accent-secondary": "#A3E635",
    "--text-primary": "#C8E6B0",
    "--text-secondary": "#5F7A42",
    "--scrollbar-track": "#0B0E08",
    "--scrollbar-thumb": "#2A3A18",
    "--titlebar-from": "#223312",
    "--titlebar-to": "#0F120C",
    "--error": "#C24A2A",
  },

  "crt-phosphor": {
    "--bg-base": "#040804",
    "--bg-panel": "#0A120A",
    "--bg-sunken": "#020402",
    "--border-highlight": "#1FA34C",
    "--border-shadow": "#000000",
    "--accent-primary": "#33FF66",
    "--accent-secondary": "#7FFFA8",
    "--text-primary": "#C9FFD6",
    "--text-secondary": "#4D9966",
    "--scrollbar-track": "#030603",
    "--scrollbar-thumb": "#0F2A14",
    "--titlebar-from": "#0C2A12",
    "--titlebar-to": "#040804",
    "--error": "#FF5C5C",
  },

  /* NFR-19 — exact specified values; same widget control language as the
   * dark themes but on a light base. It shall not resemble a modern light
   * mode. */
  dust: {
    "--bg-base": "#E8DFD0",
    "--bg-panel": "#D4C8B4",
    "--bg-sunken": "#BFB49E",
    "--border-highlight": "#C9B896",
    "--border-shadow": "#6B5A42",
    "--accent-primary": "#7A4F1A",
    "--accent-secondary": "#9C6A26",
    "--text-primary": "#1A1410",
    "--text-secondary": "#6A5A42",
    "--scrollbar-track": "#D4C8B4",
    "--scrollbar-thumb": "#A89878",
    "--titlebar-from": "#C4AE8C",
    "--titlebar-to": "#8A7A5E",
    "--error": "#A03A28",
  },
};

/* ---------------------------------------------------------------------------
 * Custom derivation (NFR-18, binding rules):
 *   panels   = bg-base lightened 8% (dark base) / darkened 8% (light base)
 *   sunken   = a further 6% shift in the same direction
 *   highlight= --accent-primary at 60% opacity
 *   shadow   = #000000 at 80% opacity  (always)
 * Remaining tokens (text colours, accents, scrollbar, titlebar) are derived
 * with documented formulas below.
 * ------------------------------------------------------------------------ */
export function deriveCustomTokens(accent, bgBase) {
  const isLight = luminance(bgBase) > 0.5;
  const dir = isLight ? -1 : 1; // -1 darkens, +1 lightens

  const panel = shiftHex(bgBase, 8, dir);
  const sunken = shiftHex(bgBase, 14, dir); // further 6% in same direction
  const shadow = "rgba(0, 0, 0, 0.8)";

  const [ar, ag, ab] = hexToRgb(accent);
  const highlight = `rgba(${ar}, ${ag}, ${ab}, 0.6)`;

  const accent2 = isLight
    ? shiftHex(accent, 12, -1)
    : shiftHex(accent, 15, 1);

  const textPrimary = isLight ? "#241C12" : "#E8E0CE";
  const textSecondary = blendHex(textPrimary, bgBase, 0.42);

  return {
    "--bg-base": bgBase,
    "--bg-panel": panel,
    "--bg-sunken": sunken,
    "--border-highlight": highlight,
    "--border-shadow": shadow,
    "--accent-primary": accent,
    "--accent-secondary": accent2,
    "--text-primary": textPrimary,
    "--text-secondary": textSecondary,
    "--scrollbar-track": sunken,
    "--scrollbar-thumb": blendHex(panel, accent, 0.35),
    "--titlebar-from": blendHex(panel, accent, 0.28),
    "--titlebar-to": bgBase,
    "--error": isLight ? "#A03A28" : "#D05038",
  };
}

/* ---------------------------------------------------------------------------
 * Application & persistence
 * ------------------------------------------------------------------------ */

let current = { theme: "void-brown", custom_accent: null, custom_bg: null };

export function getThemeRecord() {
  return { ...current };
}

/** NFR-16 — apply a token set to :root immediately (no reload). */
function applyTokens(tokens) {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(tokens)) {
    root.style.setProperty(name, value);
  }
}

function tokensFor(record) {
  if (record.theme === "custom" && record.custom_accent && record.custom_bg) {
    return deriveCustomTokens(record.custom_accent, record.custom_bg);
  }
  return BUILT_INS[record.theme] || BUILT_INS["void-brown"];
}

/** UC-10 — select theme, apply immediately, persist to IndexedDB (NFR-14). */
export async function setTheme(theme, custom = {}) {
  const record = {
    theme,
    custom_accent: theme === "custom" ? custom.accent || current.custom_accent : null,
    custom_bg: theme === "custom" ? custom.bg || current.custom_bg : null,
  };
  applyTokens(tokensFor(record));
  current = record;
  try {
    await tx("preferences", "readwrite", (store) => store.put(record, "app"));
  } catch (err) {
    console.warn("[theme] persist failed (degraded mode?)", err);
  }
  return record;
}

/** Load persisted theme on launch and apply before first paint of chat. */
export async function initTheme() {
  let record = null;
  try {
    record = await tx("preferences", "readonly", (store) =>
      reqAsPromise(store.get("app"))
    );
  } catch {
    /* E-09 degraded mode — default theme still applies. */
  }
  current = record && BUILT_INS[record.theme]
    ? record
    : record && record.theme === "custom"
      ? record
      : { theme: "void-brown", custom_accent: null, custom_bg: null };
  applyTokens(tokensFor(current));
  return current;
}

/* Live preview from the colour pickers without persisting yet (§10.4). */
export function previewCustom(accent, bg) {
  applyTokens(deriveCustomTokens(accent, bg));
}
