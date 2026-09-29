/*
 * Popup menu placement = TV PopupMenu `_handleMeasure` (module 671464): the
 * menu keeps its requested position (a context menu opens at the cursor, a
 * submenu next to its row), then is clamped into the window with no margin:
 *   left = clamp(x, 0, windowWidth − menuWidth)
 *   top  = clamp(y, 0, windowHeight − menuHeight)
 * A menu taller than the window gets the window height and scrolls.
 */
import { createEffect } from "solid-js";

/** Place a `position: fixed` menu element at (x, y), fitted to the window. */
export function fitToWindow(el: HTMLElement, x: number, y: number): void {
  el.style.maxHeight = "";
  el.style.overflowY = "";
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  const r = el.getBoundingClientRect();
  const W = document.documentElement.clientWidth;
  const H = document.documentElement.clientHeight;
  let h = r.height;
  if (h > H) {
    el.style.maxHeight = `${H}px`;
    el.style.overflowY = "auto";
    h = H;
  }
  el.style.left = `${Math.max(0, Math.min(x, W - r.width))}px`;
  el.style.top = `${Math.max(0, Math.min(y, H - h))}px`;
}

/** Ref callback that keeps a menu fitted whenever its requested position
 *  changes (runs after the element is in the document). */
export function fitMenuRef(pos: () => { x: number; y: number }) {
  return (el: HTMLElement) => {
    createEffect(() => {
      const p = pos();
      queueMicrotask(() => fitToWindow(el, p.x, p.y));
    });
  };
}
