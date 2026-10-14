/*
 * Time-scale navigation of a chart view: wheel-free zoom / scroll animations,
 * the held scroll gestures, reset of the scales, date-range presets, and the
 * control bars (centred group bar + "Scroll to the most recent bar").
 */
import { createEffect, createSignal, onCleanup } from "solid-js";
import { type UTCTimestamp } from "lightweight-charts";
import {
  DEFAULT_BAR_SPACING,
  GOTO_MS,
  ZOOM_MS,
  barAnchor,
  canShow,
  easeInOutQuint,
  easeOutCubic,
  groupsWidth,
  liveBarSpacing,
  moveEndAfterStop,
  movePixels,
  pointerNearBox,
  type GroupId,
} from "../control-bar";
import { barsSpan } from "./helpers";
import { type ChartCx } from "./context";
import type { Accessor } from "solid-js";

/** What createNavigation adds to the chart context. */
export interface NavigationApi {
  applyRangeSpan: (id: string) => boolean;
  barFits: Accessor<Set<GroupId>>;
  barLeft: Accessor<number>;
  barShown: Accessor<boolean>;
  gotoBox: Accessor<{
    bottom: number;
    right: number;
  }>;
  gotoShown: Accessor<boolean>;
  installControlBars: () => void;
  moveBars: (dir: -1 | 1) => void;
  readonly refreshBarsRef: (() => void) | undefined;
  resetAvailable: Accessor<boolean>;
  resetChartView: () => void;
  resetTimeScale: () => void;
  scrollToFirstBar: () => void;
  scrollToRealtime: () => void;
  startPan: (dir: -1 | 1) => void;
  stopScroll: () => void;
  timeScaleOffDefault: () => boolean;
  zoomSpan: (factor: number) => void;
}

export function createNavigation(cx: ChartCx): NavigationApi {
  const { appearance, currentTokens, hidden, props } = cx;
  // Control bars (see control-bar.ts + the onMount block). `gotoShown` is the
  // back button's visibility, `barShown` the control bar's; the boxes
  // are the wrappers' pane-relative anchors, recomputed as panes/scales move.
  const [gotoShown, setGotoShown] = createSignal(false);
  const [gotoBox, setGotoBox] = createSignal({ bottom: 32, right: 16 });
  const [barShown, setBarShown] = createSignal(false);
  const [barLeft, setBarLeft] = createSignal(0);
  const [barFits, setBarFits] = createSignal<Set<GroupId>>(new Set());
  const [resetAvailable, setResetAvailable] = createSignal(false);
  /** Set by onMount so the actions below can re-resolve bar visibility. */
  let refreshBarsRef: (() => void) | undefined;

  /** Right-edge-anchored zoom, in bar-spacing terms: holds `rightOffset` and
   *  scales the span, so `span` is the reciprocal of the bar-spacing factor. */
  let zoomAnim: number | null = null;
  const zoomSpan = (factor: number) => {
    if (!cx.chart) return;
    const ts = cx.chart.timeScale();
    const r = ts.getVisibleLogicalRange();
    if (!r) return;
    const span0 = r.to - r.from;
    if (span0 <= 0) return;
    if (zoomAnim !== null) cancelAnimationFrame(zoomAnim);
    const started = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - started) / ZOOM_MS);
      // Progress is linear in log(barSpacing) — the pinch compounds, so the
      // eased fraction is an exponent, not a lerp.
      const span = span0 * Math.pow(factor, easeOutCubic(k));
      const cur = cx.chart?.timeScale().getVisibleLogicalRange();
      if (cur) cx.chart!.timeScale().setVisibleLogicalRange({ from: cur.to - Math.max(5, span), to: cur.to });
      zoomAnim = k < 1 ? requestAnimationFrame(step) : null;
    };
    zoomAnim = requestAnimationFrame(step);
  };

  /** Animate the view back to the last bar: 1s of easeInOutQuint onto the
   *  configured right margin. Falls back to 10 bars when that margin is
   *  negative. */
  let gotoAnim: number | null = null;
  const scrollToRealtime = () => {
    if (!cx.chart) return;
    const ts = cx.chart.timeScale();
    let target = currentTokens().rightOffset;
    if (target < 0) target = 10;
    const from = ts.scrollPosition();
    if (gotoAnim !== null) cancelAnimationFrame(gotoAnim);
    const started = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - started) / GOTO_MS);
      ts.scrollToPosition(from + (target - from) * easeInOutQuint(k), false);
      gotoAnim = k < 1 ? requestAnimationFrame(step) : null;
    };
    gotoAnim = requestAnimationFrame(step);
  };

  // ── Held scrolling ─────────────────────────────────────────────────────────
  // Both scroll gestures run through one move implementation with a single
  // animation slot, so starting either replaces the other and one `stopMove`
  // ends whichever is live — via that run's OWN stop rule (immediate for
  // moveByBar, a deceleration ramp for move). Same shape here.
  //
  // `position(elapsed, remaining)` returns signed BARS from the start offset;
  // `remaining` is Infinity until stopped, which is what lets `move` coast.
  let scrollAnim: number | null = null;
  let scrollStarted = 0;
  let scrollEnd = Infinity;
  let scrollStopAfter: (elapsed: number) => number = () => 0;

  const runScroll = (
    position: (elapsed: number, remaining: number) => number,
    stopAfter: (elapsed: number) => number,
    snapToBar: boolean,
  ) => {
    if (!cx.chart) return;
    const ts = cx.chart.timeScale();
    if (scrollAnim !== null) cancelAnimationFrame(scrollAnim);
    const from = snapToBar ? Math.round(ts.scrollPosition()) : ts.scrollPosition();
    scrollStarted = performance.now();
    scrollEnd = Infinity;
    scrollStopAfter = stopAfter;
    const step = (now: number) => {
      const at = Math.min(scrollEnd, now);
      ts.scrollToPosition(from + position(at - scrollStarted, scrollEnd - at), false);
      if (now >= scrollEnd) {
        scrollAnim = null;
        refreshBarsRef?.();
        return;
      }
      scrollAnim = requestAnimationFrame(step);
    };
    scrollAnim = requestAnimationFrame(step);
  };

  /** Stop move: end the live run on its own terms. */
  const stopScroll = () => {
    if (scrollAnim === null) return;
    scrollEnd = performance.now() + scrollStopAfter(performance.now() - scrollStarted);
  };

  /** Move by bar — plain ←/→ and the control bar's scroll buttons. Holds at
   *  one bar for the first 300ms, then adds another every 100ms. Stops dead on
   *  release. `dir` -1 walks into history ("Scroll to the left"). It snaps
   *  to a whole bar first when the last bar isn't flush with the edge. */
  const moveBars = (dir: -1 | 1) =>
    runScroll((elapsed) => dir * (Math.floor(Math.max(0, elapsed - 300) / 100) + 1), () => 0, true);

  /** Move — held Ctrl+←/→. Accelerates to a top speed and coasts; releasing
   *  ramps back to zero rather than cutting out. The move is measured in
   *  pixels, so bar spacing (fixed for the run) converts. */
  const startPan = (dir: -1 | 1) => {
    if (!cx.chart) return;
    const bs = liveBarSpacing(cx.chart);
    if (!bs) return;
    runScroll((elapsed, remaining) => dir * (movePixels(elapsed, remaining) / bs), moveEndAfterStop, false);
  };

  /** Scroll to first bar. History is paged in, so this jumps to the oldest bar
   *  loaded and lets maybeLoadOlder pull the next page — repeat presses keep
   *  walking back. Not animated. */
  const scrollToFirstBar = () => {
    if (!cx.chart || cx.raw.length === 0) return;
    const ts = cx.chart.timeScale();
    const r = ts.getVisibleLogicalRange();
    if (!r) return;
    ts.setVisibleLogicalRange({ from: 0, to: r.to - r.from });
  };

  /** Reset scales (the Alt+R / context-menu / control-bar action):
   *  default bar spacing, default right margin, price scale back to auto.
   *
   *  Bar spacing and right offset are driven through the visible range, not
   *  `applyOptions`: the library only reacts to options that *changed*, and both
   *  already hold their default values (zooming moves internal state, not the
   *  option), so re-applying them would silently do nothing. Span and edge set
   *  the same two quantities and always land. */
  /** Reset time scale (Ctrl+Alt+Q): default bar spacing + right offset,
   *  price scale untouched. */
  const resetTimeScale = () => {
    if (!cx.chart) return;
    if (zoomAnim !== null) cancelAnimationFrame(zoomAnim);
    if (gotoAnim !== null) cancelAnimationFrame(gotoAnim);
    if (scrollAnim !== null) {
      cancelAnimationFrame(scrollAnim);
      scrollAnim = null;
    }
    const t = currentTokens();
    const ts = cx.chart.timeScale();
    const last = cx.mainLastIndex();
    if (last != null) {
      const span = barsSpan(ts.width(), DEFAULT_BAR_SPACING);
      const to = last + t.rightOffset;
      ts.setVisibleLogicalRange({ from: to - span, to });
    }
  };
  /** "Reset chart view" (Alt+R): time scale + price auto-scale. */
  const resetChartView = () => {
    if (!cx.chart) return;
    resetTimeScale();
    cx.chart.priceScale(currentTokens().scalesPlacement).applyOptions({ autoScale: true });
    refreshBarsRef?.();
  };

  /** Reset available: true when bar spacing, right offset OR price
   *  auto-scale is off default — that's exactly when the reset button shows. */
  const scalesOffDefault = () => {
    if (!cx.chart) return false;
    if (timeScaleOffDefault()) return true;
    return !cx.chart.priceScale(currentTokens().scalesPlacement).options().autoScale;
  };
  /** Time-scale reset available: bar spacing or right offset off default. */
  const timeScaleOffDefault = () => {
    if (!cx.chart) return false;
    const bs = liveBarSpacing(cx.chart);
    // Derived from width/span, so sub-pixel drift is expected; 0.05px of bar
    // spacing is far below anything a user could set deliberately.
    if (bs !== null && Math.abs(bs - DEFAULT_BAR_SPACING) > 0.05) return true;
    return Math.abs(cx.chart.timeScale().scrollPosition() - currentTokens().rightOffset) > 0.01;
  };

  onCleanup(() => {
    if (gotoAnim !== null) cancelAnimationFrame(gotoAnim);
    if (zoomAnim !== null) cancelAnimationFrame(zoomAnim);
    if (scrollAnim !== null) cancelAnimationFrame(scrollAnim);
  });

  /** Frame a date-range preset: [last bar − span, last bar]. "All" fits the
   *  whole series; "YTD" starts at 01/01 of the last bar's year. Returns false
   *  when the chart/data isn't ready (the caller retries after load). */
  function applyRangeSpan(id: string): boolean {
    if (!cx.chart || cx.raw.length === 0) return false;
    const ts = cx.chart.timeScale();
    if (id === "All") {
      ts.fitContent();
      return true;
    }
    const to = cx.raw[cx.raw.length - 1].time as number;
    let from: number;
    if (id === "YTD") {
      const d = new Date(to * 1000);
      from = Date.UTC(d.getUTCFullYear(), 0, 1) / 1000;
    } else {
      // Calendar-day spans (weekend-inclusive so 5D covers a trading week).
      const days: Record<string, number> = { "1D": 1, "5D": 7, "1M": 31, "3M": 92, "6M": 183, "1Y": 366, "5Y": 1830 };
      const span = days[id];
      if (!span) return false;
      from = to - span * 86400;
    }
    try {
      ts.setVisibleRange({ from: from as UTCTimestamp, to: to as UTCTimestamp });
    } catch {
      return false;
    }
    return true;
  }

  function installControlBars() {
    // ── Control bars ────────────────────────────────────────────────────────
    // The centred group bar and the bottom-right "Scroll to the most recent
    // bar" button (see control-bar.ts for the shared geometry). The rules:
    //   • the goto button shows only while `rightOffset < 0`, i.e. the last bar
    //     has left the right edge. Empty right margin still reads as realtime.
    //   • both also need the Navigation setting to allow it: `alwaysOn` pins
    //     them on, `alwaysOff` off, and the default consults a box padded 100px
    //     around each wrapper (73px on top). Each bar tests its OWN box. A held
    //     button or an armed tool freezes the state instead of hiding.
    //   • the anchor follows the bottom-most pane tall enough to hold the bar.
    let nearGoto = false; // back button can be visible
    let nearBar = false; // control bar visible
    let gotoPoll: number | undefined;

    const refreshBars = () => {
      if (!cx.chart || hidden()) return;
      const behavior = currentTokens().navButtons;
      // Host size cached by the ResizeObserver: reading clientWidth/Height here
      // forced a synchronous layout on every pan frame (the drawings overlay
      // has just re-projected its SVG in the same task).
      const anchor = barAnchor(cx.chart, cx.hostH, cx.hostW);
      if (anchor) {
        setGotoBox((p) => (p.bottom === anchor.bottom && p.right === anchor.right ? p : { bottom: anchor.bottom, right: anchor.right }));
        const fits = anchor.fits((id) => (id === "maximize" ? !!props.canMaximize : true));
        setBarFits((p) => (p.size === fits.size && [...p].every((id) => fits.has(id)) ? p : fits));
        const left = anchor.centre(groupsWidth(fits));
        setBarLeft(left);
      }
      setGotoShown(canShow(behavior, nearGoto) && cx.chart.timeScale().scrollPosition() < 0);
      setBarShown(canShow(behavior, nearBar));
      setResetAvailable(scalesOffDefault());
    };

    // The goto button is polled at 1s to catch new bars pushing the last bar
    // off-screen. It can't show while the pointer is away (and the pinned modes
    // don't depend on scroll at all), so only poll where it can change the
    // answer — same result, no idle timer per pane.
    const syncGotoPoll = () => {
      const want = currentTokens().navButtons === "alwaysOn" || nearGoto;
      if (want && gotoPoll === undefined) gotoPoll = window.setInterval(refreshBars, 1000);
      else if (!want && gotoPoll !== undefined) {
        window.clearInterval(gotoPoll);
        gotoPoll = undefined;
      }
    };
    refreshBarsRef = () => {
      syncGotoPoll();
      refreshBars();
    };

    const onBarPointer = (e: MouseEvent) => {
      if (currentTokens().navButtons !== "visibleOnMouseOver") return;
      const g = pointerNearBox(e, cx.gotoWrap.getBoundingClientRect(), !!props.armedTool);
      const b = pointerNearBox(e, cx.barWrap.getBoundingClientRect(), !!props.armedTool);
      if ((g === undefined || g === nearGoto) && (b === undefined || b === nearBar)) return;
      if (g !== undefined) nearGoto = g;
      if (b !== undefined) nearBar = b;
      syncGotoPoll();
      refreshBars();
    };
    // Bound to the pane root, not the canvas host: the buttons are siblings of
    // the host, so hovering one would fire `mouseleave` on the host, hide it,
    // put the cursor back over the canvas and flicker forever. The pane root
    // wraps both.
    cx.paneRoot.addEventListener("mousemove", onBarPointer);
    cx.paneRoot.addEventListener("mouseleave", onBarPointer);
    onCleanup(() => {
      cx.paneRoot.removeEventListener("mousemove", onBarPointer);
      cx.paneRoot.removeEventListener("mouseleave", onBarPointer);
      if (gotoPoll !== undefined) window.clearInterval(gotoPoll);
    });

    // Navigation setting changes flip the pinned modes on/off, so re-resolve.
    createEffect(() => {
      const behavior = appearance().navButtons ?? "visibleOnMouseOver";
      if (behavior !== "visibleOnMouseOver") {
        nearGoto = false;
        nearBar = false;
      }
      refreshBarsRef?.();
    });
  }

  return {
    applyRangeSpan,
    barFits,
    barLeft,
    barShown,
    gotoBox,
    gotoShown,
    installControlBars,
    moveBars,
    get refreshBarsRef() {
      return refreshBarsRef;
    },
    resetAvailable,
    resetChartView,
    resetTimeScale,
    scrollToFirstBar,
    scrollToRealtime,
    startPan,
    stopScroll,
    timeScaleOffDefault,
    zoomSpan,
  };
}
