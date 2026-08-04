/* components.js — 90s widget interaction library (SRS §2.3)
 *
 * Signature element: "The title bar of every panel behaves like an old
 * application window: it is draggable, displays the app name in a bold 90s
 * title bar gradient…" — makeDraggable implements this for the main window
 * and for modal panels.
 *
 * Scrollbars: "explicit track and thumb geometry, narrow, boxy… arrow
 * buttons on both ends rendered as bevelled boxes" — attachScrollbar builds
 * a fully custom scrollbar (native pseudo-elements cannot render arrow
 * buttons).
 */

import { el } from "./utils.js";

/* -------------------------------------------------------------- dragging --- */

/**
 * Make `panel` draggable via its `handle` (a .titlebar), constrained to
 * `bounds` (defaults to viewport). Pointer events; works with touch.
 */
export function makeDraggable(handle, panel, bounds = null) {
  let dragging = false;
  let offX = 0;
  let offY = 0;

  function onDown(e) {
    if (e.target.closest(".tb-btn, button, input, textarea, select, a")) return;
    dragging = true;
    const rect = panel.getBoundingClientRect();
    /* Switch from transform-centring to explicit left/top coordinates. */
    panel.style.transform = "none";
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    offX = e.clientX - rect.left;
    offY = e.clientY - rect.top;
    e.preventDefault();
  }

  function onMove(e) {
    if (!dragging) return;
    const b = bounds ? bounds.getBoundingClientRect() : {
      left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight,
    };
    const w = panel.offsetWidth;
    const h = panel.offsetHeight;
    const x = Math.min(Math.max(e.clientX - offX, b.left), b.right - w);
    const y = Math.min(Math.max(e.clientY - offY, b.top), b.bottom - h);
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
  }

  function onUp() {
    dragging = false;
  }

  handle.addEventListener("pointerdown", onDown);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

/* ------------------------------------------------------- custom scrollbar --- */

/**
 * Attach a boxy 90s scrollbar (track + thumb + bevelled arrow buttons on
 * both ends) to `scroller` (an overflow-y-auto element). The widget is
 * placed inside `mountEl` (a .scrollbar-widget div).
 */
export function attachScrollbar(scroller, mountEl) {
  mountEl.replaceChildren(
    el("button", { class: "sb-btn", type: "button", "aria-label": "Scroll up" },
      el("span", { class: "sb-arrow sb-arrow-up" })),
    el("div", { class: "sb-track" },
      el("div", { class: "sb-thumb sb-thumb--hidden" })),
    el("button", { class: "sb-btn", type: "button", "aria-label": "Scroll down" },
      el("span", { class: "sb-arrow sb-arrow-down" }))
  );

  const [upBtn, downBtn] = mountEl.querySelectorAll(".sb-btn");
  const track = mountEl.querySelector(".sb-track");
  const thumb = mountEl.querySelector(".sb-thumb");

  const LINE = 24; // px per scroll tick
  let holdTimer = null;

  function scrollTo(y) {
    scroller.scrollTop = Math.max(0, Math.min(scroller.scrollHeight, y));
  }

  function sync() {
    const maxScroll = scroller.scrollHeight - scroller.clientHeight;
    if (maxScroll <= 4) {
      /* Fits without scrolling — 90s widgets still SHOW the scrollbar:
       * full-height thumb, disabled arrows (period-correct, never hidden). */
      thumb.classList.remove("sb-thumb--hidden");
      thumb.style.height = `${track.clientHeight}px`;
      thumb.style.top = "0px";
      upBtn.disabled = true;
      downBtn.disabled = true;
      return;
    }
    thumb.classList.remove("sb-thumb--hidden");
    upBtn.disabled = scroller.scrollTop <= 0;
    downBtn.disabled = scroller.scrollTop >= maxScroll - 1;

    const ratio = scroller.scrollTop / maxScroll;
    const trackH = track.clientHeight;
    const thumbH = Math.max(18, (scroller.clientHeight / scroller.scrollHeight) * trackH);
    thumb.style.height = `${thumbH}px`;
    thumb.style.top = `${ratio * (trackH - thumbH)}px`;
  }

  function step(dir) {
    scrollTo(scroller.scrollTop + dir * LINE);
  }

  function startHold(dir, ev) {
    step(dir);
    clearInterval(holdTimer);
    holdTimer = setInterval(() => step(dir), 90);
    const stop = () => {
      clearInterval(holdTimer);
      holdTimer = null;
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    ev.preventDefault();
  }

  upBtn.addEventListener("pointerdown", (e) => startHold(-1, e));
  downBtn.addEventListener("pointerdown", (e) => startHold(1, e));

  /* Drag the thumb. */
  thumb.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const maxScroll = scroller.scrollHeight - scroller.clientHeight;
    const trackH = track.clientHeight;
    const startY = e.clientY;
    const startTop = parseFloat(thumb.style.top || "0");
    const thumbH = thumb.offsetHeight;

    const move = (ev) => {
      const top = Math.max(0, Math.min(trackH - thumbH, startTop + (ev.clientY - startY)));
      thumb.style.top = `${top}px`;
      scrollTo((top / (trackH - thumbH)) * maxScroll);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  /* Click the track to page. */
  track.addEventListener("pointerdown", (e) => {
    if (e.target === thumb) return;
    const rect = track.getBoundingClientRect();
    const above = e.clientY < rect.top + thumb.offsetTop + thumb.offsetHeight / 2;
    scrollTo(scroller.scrollTop + (above ? -1 : 1) * scroller.clientHeight * 0.9);
  });

  scroller.addEventListener("scroll", sync);
  const ro = new ResizeObserver(sync);
  ro.observe(scroller);
  sync();
  return { sync };
}

/* --------------------------------------------------------------- modals --- */

/**
 * A draggable 90s dialog window over a dim overlay. One primary action is
 * supported plus an X button; every button closes the modal.
 *
 * @param {object} opts { title, bodyNode | bodyText, danger?:boolean,
 *                        buttons: [{label, primary, onClick}] }
 */
export function showModal({ title, bodyNode = null, bodyText = "", buttons = [] }) {
  const overlay = el("div", { class: "modal-overlay" });
  const win = el("div", {
    class: "bevel-out bg-panel shadow-widget-lg flex flex-col",
    style: "width:min(480px, calc(100vw - 32px))",
  });

  const close = () => overlay.remove();

  const titlebar = el("div", { class: "titlebar" },
    el("span", { class: "px-1", text: title }),
    el("span", { class: "titlebar-buttons" },
      el("button", { class: "tb-btn", type: "button", "aria-label": "Close", onclick: close, text: "×" })));

  const body = el("div", { class: "p-3 text-[12px] leading-relaxed" });
  if (bodyNode) body.appendChild(bodyNode);
  else if (bodyText) body.textContent = bodyText;

  const actions = el("div", { class: "flex gap-1 justify-end p-2 pt-0 flex-wrap" });
  for (const b of buttons) {
    actions.appendChild(
      el("button", {
        class: `widget-btn ${b.primary ? "widget-btn--primary" : ""}`,
        type: "button",
        text: b.label,
        onclick: () => {
          const keep = b.onClick && b.onClick() === false;
          if (!keep) close();
        },
      })
    );
  }

  win.append(titlebar, body, actions);
  overlay.appendChild(win);
  document.body.appendChild(overlay);

  /* Draggable + centred initially. */
  win.style.position = "relative";
  overlay.addEventListener("pointerdown", (e) => {
    if (e.target === overlay) close();
  });
  makeDraggable(titlebar, win, overlay);

  return { close, win };
}

/** §10.5-style inline notice row (used by E-12 and app-level notices). */
export function systemRowDom(text) {
  return el("div", { class: "msg-row msg-row--sys", text });
}
