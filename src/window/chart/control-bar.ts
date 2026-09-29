/*
 * Shared model for a pane's two floating button boxes (the navigation
 * controls):
 *
 *   • the centred group bar   — zoom out/in, maximize, scroll left/right, reset
 *   • the "back" button       — bottom-right "Scroll to the most recent bar"
 *
 * They are separate DOM boxes with separate visibility rules, but they share an
 * anchor (both sit on the target pane's bottom edge), a pointer-proximity test
 * and the Navigation setting. That common part lives here; ChartView owns the
 * state and ChartControlBar renders the group bar.
 *
 * Every constant below is measured, not guessed.
 */
import type { IChartApi } from "lightweight-charts";
import type { NavButtonsBehavior } from "../header/chart-settings";

/** Wrapper height: a 24px content box + 5px padding top and bottom. */
export const CONTROL_BAR_H = 34;
/** Bottom margin: extra lift for a pane holding the main series. */
export const MAIN_PANE_MARGIN = 27;

/** Bar-spacing step per zoom click. The zoom animates a width/5 pinch whose
 *  compound effect works out to ≈e^0.2; measured 1.2227 across six samples,
 *  and width-independent (the pinch scales with the pane). */
export const ZOOM_FACTOR = 1.2227;
/** Zoom animation, measured: 250ms, easeOutCubic, linear in log(barSpacing). */
export const ZOOM_MS = 250;
/** Animated scroll to realtime: 1s of easeInOutQuint. */
export const GOTO_MS = 1000;
/** Reset scales restores this bar spacing (also lightweight-charts' default). */
export const DEFAULT_BAR_SPACING = 6;

// ── Scroll move (held Ctrl/Alt + arrow) ─────────────────────────────────────
// Accelerate at 0.003 px/ms² until 1.1 px/ms, reached at 367ms, then coast.
// Distances are PIXELS; callers divide by bar spacing. The move starts once on
// keydown and ignores key repeats, which is what lets the speed build.
export const MOVE_ACCEL = 0.003; // px/ms²
export const MOVE_VMAX = 1.1; // px/ms
export const MOVE_RAMP = Math.round(MOVE_VMAX / MOVE_ACCEL); // 367ms to top speed

/**
 * The move position function: unsigned pixels travelled at
 * `elapsed`, given `remaining` ms until the run ends (Infinity while held).
 *
 * Releasing does not cut the motion off. `stopMoveAt` pushes the end out by
 * `max(0, RAMP - elapsed) + RAMP`, so a run released early still accelerates to
 * full speed before the linear ramp down — `c` only starts biting once
 * `remaining` drops under RAMP, and it is what bleeds velocity to exactly zero.
 */
export function movePixels(elapsed: number, remaining: number): number {
  const a = Math.min(elapsed, MOVE_RAMP);
  const accel = (MOVE_ACCEL * a * a) / 2;
  if (elapsed <= MOVE_RAMP) return accel;
  const c = Number.isFinite(remaining) ? Math.max(0, MOVE_RAMP - remaining) : 0;
  return accel + (elapsed - a - c) * MOVE_VMAX + (MOVE_VMAX * c - (MOVE_ACCEL * c * c) / 2);
}

/** Move stop hook: when a run released at `elapsed` should finish. */
export const moveEndAfterStop = (elapsed: number) => Math.max(0, MOVE_RAMP - elapsed) + MOVE_RAMP;

export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
export const easeInOutQuint = (t: number) => (t < 0.5 ? 16 * t ** 5 : 1 - Math.pow(-2 * t + 2, 5) / 2);

/** The four groups, in *priority* order: when the pane is too narrow the
 *  later ones drop first. `width` is the space-budget figure, which runs a little wider than the rendered box. */
export type GroupId = "maximize" | "reset" | "zoom" | "scroll";
export const GROUPS: readonly { id: GroupId; width: number }[] = [
  { id: "maximize", width: 50 },
  { id: "reset", width: 50 },
  { id: "zoom", width: 86 },
  { id: "scroll", width: 86 },
];

/**
 * Pointer-near-box test: the box padded 100px left/right/bottom and
 * `100 - MAIN_PANE_MARGIN` on top. Returns `undefined` to mean "leave the
 * current state alone": that is how visibility freezes while a mouse button
 * is held or a drawing is mid-placement, rather than hiding mid-drag.
 */
export function pointerNearBox(e: MouseEvent, box: DOMRect, frozen: boolean): boolean | undefined {
  if (e.buttons || frozen) return undefined;
  if (e.type !== "mousemove") return false; // mouseleave
  const top = 100 - MAIN_PANE_MARGIN;
  return (
    e.clientX >= box.left - 100 && e.clientX <= box.right + 100 && e.clientY >= box.top - top && e.clientY <= box.bottom + 100
  );
}

export type BarAnchor = {
  /** Distance from the chart's bottom edge to the wrapper's bottom. */
  bottom: number;
  /** `right` for the back button: clear of the price scale. */
  right: number;
  /** `left` for the centred bar, given the groups that fit. */
  centre: (visibleWidth: number) => number;
  /** Which groups fit across the pane, in priority order. */
  fits: (available: (id: GroupId) => boolean) => Set<GroupId>;
};

/**
 * Bar position, back-button position and group visibility, expressed against
 * lightweight-charts' pane/scale API.
 *
 * Returns null when no pane is tall enough to hold the bar (no target pane),
 * which leaves the anchor untouched.
 */
export function barAnchor(chart: IChartApi, hostHeight: number, hostWidth: number): BarAnchor | null {
  const panes = chart.panes();
  const heights = panes.map((p) => p.getHeight());
  const axis = chart.timeScale().height();
  // Pane separators aren't exposed by the API, so back them out of the leftover
  // height rather than hard-coding the library's value.
  const stacked = heights.reduce((a, b) => a + b, 0);
  const sep = panes.length > 1 ? Math.max(0, hostHeight - axis - stacked) / (panes.length - 1) : 0;

  // Target pane: the bottom-most pane with room for the bar.
  // Short indicator panes get skipped, so on a busy layout the bar lands on the
  // price pane rather than the bottom of the widget. Pane 0 holds the main
  // series here, which is what earns the 27px lift.
  let target = -1;
  for (let i = panes.length - 1; i >= 0; i--) {
    const margin = i === 0 ? MAIN_PANE_MARGIN : 0;
    if (heights[i] >= CONTROL_BAR_H + 28 + margin) {
      target = i;
      break;
    }
  }
  if (target < 0) return null;

  let bottom = axis;
  for (let j = panes.length - 1; j > target; j--) bottom += heights[j] + sep;
  bottom += target === 0 ? MAIN_PANE_MARGIN : 0;

  const rightScale = chart.priceScale("right").width();
  const leftScale = chart.priceScale("left").width();

  return {
    bottom,
    // 14px clear of the scale + the wrapper's own 2px inset. Both widths read 0
    // when that scale is hidden, which is the intended fallback.
    right: rightScale + 16,
    // Control bar position: centred on the whole widget, scales included.
    centre: (visibleWidth: number) => hostWidth / 2 - Math.ceil(visibleWidth / 2),
    // Group visibility: the widest centred span that still fits
    // inside the pane, less 100px of reserve, spent in priority order. Once one
    // group misses, everything after it is dropped too.
    fits: (available) => {
      let budget = hostWidth - 2 * Math.max(rightScale, leftScale) - 50 - 50;
      const out = new Set<GroupId>();
      let starved = false;
      for (const g of GROUPS) {
        if (!available(g.id)) continue;
        budget -= g.width;
        if (budget >= 0 && !starved) out.add(g.id);
        else starved = true;
      }
      return out;
    },
  };
}

/** Total space-budget width of the groups that fit, for the centring math. */
export const groupsWidth = (fits: Set<GroupId>) =>
  GROUPS.reduce((sum, g) => sum + (fits.has(g.id) ? g.width : 0), 0);

/**
 * Live bar spacing, derived rather than read back: `timeScale().options()`
 * echoes the last *applied* option, so it goes stale the moment the user zooms.
 * Width over the visible span is the same quantity and always current.
 */
export function liveBarSpacing(chart: IChartApi): number | null {
  const ts = chart.timeScale();
  const r = ts.getVisibleLogicalRange();
  if (!r) return null;
  const span = r.to - r.from;
  return span > 0 ? ts.width() / span : null;
}

/**
 * Resolve the Navigation setting into "may these buttons show at all". Only
 * `visibleOnMouseOver` consults the pointer; the other two pin it. Forcing
 * `alwaysOff` when the series fails to load is not implemented: there is no
 * series-display-error channel here.
 */
export function canShow(behavior: NavButtonsBehavior, pointerNear: boolean): boolean {
  if (behavior === "alwaysOn") return true;
  if (behavior === "alwaysOff") return false;
  return pointerNear;
}
