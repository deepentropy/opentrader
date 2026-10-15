/*
 * Pure helpers of the drawings overlay: overlay-relative pointer points, the
 * last pointer position (place-at-cursor hotkeys) and the anchor fill colour
 * mix.
 */
import type { Pt } from "lightweight-charts-drawing/core/_shared";

/** Last pointer position in viewport coords. The overlay SVG ignores the
 *  pointer while no tool is armed, so the place-at-cursor hotkeys read this
 *  instead of the overlay's own move events. */
export let lastPointer: { x: number; y: number } | null = null;
if (typeof window !== "undefined") {
  window.addEventListener("pointermove", (e) => { lastPointer = { x: e.clientX, y: e.clientY }; }, { capture: true, passive: true });
}

export function eventPoint(el: SVGSVGElement, e: PointerEvent): Pt {
  const r = el.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

/** Linear mix of two #rrggbb colours (t = 0 → a, 1 → b). */
export function mixHex(a: string, b: string, t: number): string {
  const pa = /^#([0-9a-f]{6})$/i.exec(a);
  const pb = /^#([0-9a-f]{6})$/i.exec(b);
  if (!pa || !pb) return a;
  const na = parseInt(pa[1], 16);
  const nb = parseInt(pb[1], 16);
  const ch = (sh: number) => Math.round(((na >> sh) & 255) + (((nb >> sh) & 255) - ((na >> sh) & 255)) * t);
  return "#" + ((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, "0");
}
