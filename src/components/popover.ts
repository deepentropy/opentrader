/*
 * Popover plumbing shared by menus, selects and colour panels: placing the popover next to its anchor (or at a
 * point) fitted into the window, and closing it on a press outside or on Escape.
 *
 * Call `createPopover` while the popover component is set up and put the returned ref on the popover element. A
 * press on the anchor element is left to the anchor, so a trigger button keeps toggling its popover.
 */
import { onCleanup, onMount } from "solid-js";
import { fitToWindow } from "./menu-fit";

/** A point is the popover's corner (`endX` / `endY`: its right / bottom edge, a menu opened left of or above it). */
export type PopoverPoint = { x: number; y: number; endX?: boolean; endY?: boolean };

export type PopoverPlacement = {
  /** Under the anchor (default) or above it. */
  side?: "below" | "above";
  /** Left edges aligned (default) or right edges. */
  align?: "start" | "end";
  /** Space between the anchor and the popover, px. */
  gap?: number;
};

export type PopoverOptions = {
  onClose: () => void;
  /** How to place the popover against an anchor element; a point anchor is placed as given. Either way it is
   *  fitted into the window. `false`: the caller places it. */
  placement?: PopoverPlacement | false;
  /** More elements whose presses do not close the popover (a nested panel in its own portal). */
  inside?: () => readonly (Node | null | undefined)[];
  /** Presses on elements matching this selector do not close it either. */
  insideSelector?: string;
  /** The press that closes: `pointerdown` (default) or `mousedown` (menus whose rows act on mouse down). */
  press?: "pointerdown" | "mousedown";
  /** Escape: "stop" (default) closes and keeps the key from the dialog under the popover, "pass" closes and lets
   *  it go on, "none" leaves Escape alone. */
  escape?: "stop" | "pass" | "none";
  /** Listen only while this is true (a popover kept mounted and shown by a flag). */
  active?: () => boolean;
};

/** Where a popover goes against an anchor rectangle, before it is fitted into the window. */
export function anchorPoint(r: { left: number; right: number; top: number; bottom: number }, p: PopoverPlacement = {}): PopoverPoint {
  const gap = p.gap ?? 0;
  const end = p.align === "end";
  const above = p.side === "above";
  return { x: end ? r.right : r.left, y: above ? r.top - gap : r.bottom + gap, endX: end, endY: above };
}

/** Wires a popover; returns the ref for the popover element. */
export function createPopover(
  anchor: (() => Element | PopoverPoint | null | undefined) | undefined,
  opts: PopoverOptions,
): (el: HTMLElement) => void {
  let el: HTMLElement | undefined;
  const anchorEl = () => {
    const a = anchor?.();
    return a instanceof Element ? a : undefined;
  };

  const place = () => {
    if (!el || opts.placement === false) return;
    const a = anchor?.();
    if (!a) return;
    const p = a instanceof Element ? anchorPoint(a.getBoundingClientRect(), opts.placement) : a;
    fitToWindow(el, p.x, p.y, p.endX, p.endY);
  };

  const onPress = (e: Event) => {
    if (opts.active && !opts.active()) return;
    const t = e.target as Node;
    if (el?.contains(t) || anchorEl()?.contains(t)) return;
    if (opts.inside?.().some((n) => n?.contains(t))) return;
    if (opts.insideSelector && (t as Element).closest?.(opts.insideSelector)) return;
    opts.onClose();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || opts.escape === "none") return;
    if (opts.active && !opts.active()) return;
    if (opts.escape !== "pass") e.stopPropagation();
    opts.onClose();
  };

  onMount(() => {
    // Placed once the element is in the document (a portal inserts it during the same render).
    queueMicrotask(place);
    const press = opts.press ?? "pointerdown";
    document.addEventListener(press, onPress, true);
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => {
      document.removeEventListener(press, onPress, true);
      window.removeEventListener("keydown", onKey, true);
    });
  });

  return (node: HTMLElement) => { el = node; };
}
