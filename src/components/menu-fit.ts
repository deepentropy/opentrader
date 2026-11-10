/*
 * Popup menu placement: the menu keeps its requested position (a context
 * menu opens at the cursor, a submenu next to its row), then is clamped into
 * the window with no margin:
 *   left = clamp(x, 0, windowWidth − menuWidth)
 *   top  = clamp(y, 0, windowHeight − menuHeight)
 * A menu taller than the window gets the window height and scrolls.
 *
 * x follows the reading direction (#290): (x, y) is the menu's start corner,
 * its top-left, its top-right right to left, so a menu opens toward the end
 * side.
 */
import { createEffect } from "solid-js";
import { isRtl } from "./reading-direction";

/** Place a `position: fixed` menu element at (x, y), fitted to the window.
 *  `endX` / `endY`: (x, y) is the menu's end (right, left right to left) /
 *  bottom edge instead (a menu opened above its anchor or toward the start
 *  side). */
export function fitToWindow(el: HTMLElement, x: number, y: number, endX = false, endY = false): void {
  el.style.maxHeight = "";
  el.style.overflowY = "";
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  const r = el.getBoundingClientRect();
  // x on the menu's right edge: its end edge, or its start edge right to left.
  if (endX !== isRtl()) x -= r.width;
  if (endY) y -= r.height;
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
export function fitMenuRef(pos: () => { x: number; y: number; endX?: boolean; endY?: boolean }) {
  return (el: HTMLElement) => {
    createEffect(() => {
      const p = pos();
      queueMicrotask(() => fitToWindow(el, p.x, p.y, p.endX, p.endY));
    });
  };
}
