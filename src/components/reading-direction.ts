/*
 * The reading direction, for the code that places things itself (#290). The page's direction is the language's
 * (`<html dir>`, set at startup by i18n/language.ts); CSS follows it through start/end properties, code through
 * these helpers. Left to right, each helper gives the left-to-right value, so that layout is unchanged.
 *
 * What follows the reading direction: menus and popovers opened at a point or next to a row (they open toward the
 * end side, a submenu beside its row on the end side), the order inside components, a resize handle dragged inside
 * a component (a watchlist column grows toward the end side). What doesn't: the panels' arrangement (drawing toolbar
 * on the left, right rail on the right), the chart and everything drawn over it, and the panels' own resize handles.
 */

/** The page reads right to left. */
export function isRtl(): boolean {
  return typeof document !== "undefined" && document.documentElement.dir === "rtl";
}

/** The physical side where reading starts: "left", "right" right to left. */
export function startSide(): "left" | "right" {
  return isRtl() ? "right" : "left";
}

/** The physical side where reading ends: "right", "left" right to left. */
export function endSide(): "left" | "right" {
  return isRtl() ? "left" : "right";
}

/** +1, or -1 right to left: a horizontal step toward the end side (multiply a pointer's x movement by it). */
export function inlineSign(): 1 | -1 {
  return isRtl() ? -1 : 1;
}

type Horizontal = { left: number; right: number };

/** The x of a box's start edge: its left, its right right to left. */
export function startEdge(r: Horizontal): number {
  return isRtl() ? r.right : r.left;
}

/** The x of a box's end edge: its right, its left right to left. */
export function endEdge(r: Horizontal): number {
  return isRtl() ? r.left : r.right;
}

/**
 * The left of a box of `width` whose start edge is at `x` (left to right: `x`; right to left: `x - width`), the
 * way a menu opens at a point.
 */
export function leftFromStart(x: number, width: number): number {
  return isRtl() ? x - width : x;
}

/**
 * The left of a menu `width` wide opened at the pointer's `x`: its start edge on the pointer (it opens toward the
 * end side), pushed back inside the window, `margin` from its edges, when it would cross the end edge.
 */
export function menuLeftAt(x: number, width: number, windowWidth: number, margin = 0): number {
  if (!isRtl()) return x + width > windowWidth - margin ? Math.max(margin, windowWidth - width - margin) : x;
  return x - width < margin ? Math.min(margin, windowWidth - width - margin) : x - width;
}

/**
 * The left of a popover `width` wide opened under an anchor box with start edges aligned (moved `offset` toward the
 * end side), with end edges aligned instead when it would cross the window's end edge, and kept inside the window.
 */
export function startAlignedLeft(r: Horizontal, width: number, windowWidth: number, offset = 0): number {
  if (!isRtl()) {
    let x = r.left + offset;
    if (x + width > windowWidth) x = Math.max(0, r.right - width);
    return Math.max(0, x);
  }
  let right = r.right - offset;
  if (right - width < 0) right = Math.min(windowWidth, r.left + width);
  return Math.max(0, right - width);
}

/**
 * The left of a popover `width` wide under an anchor box, start edges aligned, slid back inside the window (`margin`
 * from its edges) rather than flipped.
 */
export function startAlignedClamped(r: Horizontal, width: number, windowWidth: number, margin = 0): number {
  if (!isRtl()) return Math.max(margin, Math.min(r.left, windowWidth - width - margin));
  return Math.min(windowWidth - margin, Math.max(r.right, width + margin)) - width;
}

/**
 * A physical side given as "start" or "end" (or already physical) on the page's direction: a tooltip or a popover
 * placed beside its anchor on the end side.
 */
export function physicalSide<S extends string>(side: S): Exclude<S, "start" | "end"> | "left" | "right" {
  if (side === "start") return startSide();
  if (side === "end") return endSide();
  return side as Exclude<S, "start" | "end">;
}
