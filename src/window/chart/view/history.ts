import { translateWith } from "../../../i18n/translator";
/*
 * Bar history of a chart view: scroll-back paging with read-ahead, date-range
 * sync (driver and follower), time sync and the Go to jumps, and the
 * end-of-history icon.
 */
import { createEffect, createMemo, onCleanup, untrack } from "solid-js";
import { HISTORY_END_ICONS, HISTORY_END_MIN_BARS, isDarkColor, type HistoryEndKind } from "../history-end-marker";
import { providerCapabilities } from "../../../data/providers/capabilities";
import { showNotice } from "../../../components/Dialogs";
import {
  DAILY_ARCHIVE_START,
  aggregateCandles,
  aggregateUnitFor,
  getBars,
  getBarsBefore,
  historyPageDays,
  isIntradayResolution,
  isSecondResolution,
  splitSymbol,
} from "../../../data/datafeed";
import { type Candle } from "../../../bindings";
import { isTransformType, setDataForType, type OHLC } from "../chart-types";
import { layoutSync } from "../layout-sync";
import { dayKeyer } from "../day-key";
import { cachedSymbolSessions } from "../../../data/session";
import { activeLink, postLinkRange } from "../../../data/tab-link-bus";
import {
  toOHLC,
  LOAD_MORE_THRESHOLD,
  MIN_VISIBLE_BARS,
  SYNC_MIN_BARS,
  SYNC_LOAD_MAX_BARS,
  GOTO_WINDOW_PAGES,
  INDICATOR_RENDER_DEBOUNCE_MS,
  SYNC_LOAD_QUIET_MS,
} from "./helpers";
import { type ChartCx } from "./context";
import { emitAppEvent } from "../../../data/app-events";
import { waitBeforeRetry } from "../../../data/connection";
import type { SessionId } from "../../../data/session";
import { lastAtOrBefore, lowerBound } from "../time-search";
import { pendingRange } from "../pending-range";
import { shownRangeStart, tradingDaysBetween, wantsPastWindow } from "../past-window";

export type GotoOpts = {
  /** Centre the target even when it is already in view (the reference app Go to). */
  alignIfVisible?: boolean;
  /** The user's own move (Go to): the new view is persisted and sent to
   *  synced panes / linked tabs like a scroll. Sync followers leave it off. */
  driver?: boolean;
  /** Bar index of the target (default: the sync rule). */
  index?: (sec: number) => number;
};

/** What createHistory adds to the chart context. */
export interface HistoryApi {
  broadcastRange: (force: boolean) => void;
  completeHistory: (sym: string, int: string, session: SessionId, isCurrent: () => boolean) => Promise<void>;
  fetchGen: number;
  goToRange: (fromSec: number, toSec: number) => Promise<void>;
  goToTime: (targetSec: number, opts?: GotoOpts) => Promise<void>;
  gotoDateIndex: (sec: number) => number;
  historyExhausted: boolean;
  holdLinkQuiet: () => void;
  loadingMore: boolean;
  maybeLoadNewer: () => void;
  maybeLoadOlder: () => void;
  /** A load's bars are set: the window of past bars handed to it, or the latest bars. */
  loadLanded: () => void;
  /** A load's bars are framed: the Go to or the action waiting for it goes on. */
  loadApplied: () => void;
  /** End of the window of past bars a Go to far back loaded (the next newer
   *  page starts there); null while the bars run to the latest one. */
  readonly pastWindowEnd: number | null;
  /** Leave a window of past bars: load the latest bars again, then `then`. */
  returnToLive: (then?: () => void) => void;
  openHistoryEndDialog: () => void;
  pendingLinkTime: number | null;
  prefetch: {
    gen: number;
    beforeSec: number;
    rows: Promise<Candle[] | null>;
  } | null;
  queueSyncRange: (from: number, to: number) => void;
  scheduleSyncRun: (delayMs: number) => void;
  startPrefetch: (sym: string, int: string, gen: number, beforeSec: number) => void;
  suppressCrosshairBroadcast: boolean;
  readonly syncGuard: boolean;
  readonly syncTarget: {
    from: number;
    to: number;
  } | null;
  updateHistoryEnd: () => void;
}

export function createHistory(cx: ChartCx): HistoryApi {
  const { chartReady, currentTokens, historyEnd, paneId, props, refreshIndicatorLegend, refreshLegend } = cx;
  // Suppress flags: set while APPLYING an inbound sync so the resulting
  // crosshair / range event isn't re-broadcast (which would echo-loop).
  let suppressCrosshairBroadcast = false;
  let suppressRangeBroadcast = false;
  // "Date range" sync rules: ONLY the active pane drives, it broadcasts only
  // when a whole bar enters/leaves the view, and followers apply the LATEST
  // target in a later task, loading any missing history to the target in one
  // request first.
  // Whole-bar key (first/last visible bar times) of the last broadcast.
  let lastRangeKey = "";
  // Latest inbound target; a newer one replaces it before it is applied.
  let syncTarget: { from: number; to: number } | null = null;
  let syncTimer: number | undefined;
  // When the latest target arrived (history loads wait for a still driver).
  let syncTargetAt = 0;
  // True while the sync loader loads the bars of its target.
  let syncLoading = false;
  // Guard while an inbound range lands. The library applies setVisibleRange on
  // its NEXT paint and fires the range-change callback there, so the guard is
  // held for two frames: no broadcast, no persist, no scroll-back pager for a
  // view the pane did not choose itself.
  let syncGuard = false;
  let syncGuardSeq = 0;
  // Loads for an inbound target in flight (sync follower, linked time): the
  // views the data apply of a window of past bars frames are not this pane's
  // own either. The view framed after them holds the guard above.
  let inboundLoads = 0;
  const holdSyncGuard = () => {
    syncGuard = true;
    const my = ++syncGuardSeq;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (my === syncGuardSeq) syncGuard = false;
    }));
  };
  // Held for two frames after new data framed the view (load, tab switch,
  // interval switch): that view is not a user change, so it is not sent to
  // linked tabs (only the active chart's range changes are sent, and a tab
  // switch reloads nothing).
  let linkQuiet = false;
  let linkQuietSeq = 0;
  const holdLinkQuiet = () => {
    linkQuiet = true;
    const my = ++linkQuietSeq;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (my === linkQuietSeq) linkQuiet = false;
    }));
  };
  // A linked time that arrived while this pane was loading its bars.
  let pendingLinkTime: number | null = null;

  /** Scroll-back paging guards — block overlapping fetches and latch once the
   *  backend reports no older bars. Reset on symbol/interval change. */
  let loadingMore = false;
  let historyExhausted = false;
  /** See HistoryApi.pastWindowEnd. Live bars wait while it is set: they would
   *  follow the window's last bar with a gap. */
  let pastWindowEnd: number | null = null;
  /** Read-ahead of the next newer page of a window of past bars. */
  let newerPrefetch: { gen: number; from: number; to: number; rows: Promise<Candle[] | null> } | null = null;
  /** Run once the latest bars are back (returnToLive). */
  let afterLive: (() => void) | null = null;
  /** A window of past bars handed to the next load (series key, end, null when it reaches now), told when applied. */
  let pendingLoad: { series: string; end: number | null; resolve: (applied: boolean) => void } | null = null;
  /** A window of past bars is landing: the views the chart passes through
   *  before the Go to frames the date do not page. */
  let landing = false;

  let historyEndClose: (() => void) | null = null;
  // The notice goes with the chart.
  onCleanup(() => historyEndClose?.());
  /** Read-ahead buffer: the window older than the current oldest bar, fetched in
   *  the background after each load (and once after the initial load) so the
   *  next scroll-back prepends instantly instead of waiting on the network.
   *  Keyed by the fetch generation + the `beforeSec` it pages before, so a stale
   *  buffer is never consumed; holds the in-flight/resolved promise so the
   *  consumer awaits the same way whether it has landed yet or not. */
  let prefetch: { gen: number; beforeSec: number; rows: Promise<Candle[] | null> } | null = null;
  /** Monotonic fetch generation, bumped on every symbol/interval change. A page
   *  captures it at launch and bails in its `.then` if it moved — so a page
   *  started for an earlier series can never prepend/re-range a later one (an
   *  A→B→A switch re-matches the symbol, which is why an equality check wasn't
   *  enough and the chart could park on year-old bars). */
  let fetchGen = 0;

  /** End-of-history icon kind: none until scroll-back has nothing older; then
   *  "limit" when the oldest bar sits on the data plan's history floor or, for
   *  the daily family, on the first session of the daily archive (within a
   *  week), else "end" (with at least 400 bars). Hidden while the floor is
   *  unknown. */
  function historyEndKind(): HistoryEndKind | null {
    // The chart's first bar is the oldest loaded one (not a slice further on).
    if (!historyExhausted || loadingMore || loaded().length === 0 || cx.sliceFrom > 0) return null;
    const ent = providerCapabilities()?.entitlements;
    if (!ent) return null;
    const iv = props.interval ?? "1D";
    const daily = cx.rawDaily.length > 0;
    const floor = daily ? ent.historyFloor.day : isSecondResolution(iv) ? ent.historyFloor.second : ent.historyFloor.minute;
    const oldest = (daily ? cx.rawDaily[0].time : loaded()[0].time) as number;
    const floorSec = floor ? Date.parse(`${floor}T00:00:00Z`) / 1000 : NaN;
    if (Number.isFinite(floorSec) && oldest - floorSec <= 7 * 86400) return "limit";
    if (daily && oldest - Date.parse(`${DAILY_ARCHIVE_START}T00:00:00Z`) / 1000 <= 7 * 86400) return "limit";
    return loaded().length >= HISTORY_END_MIN_BARS ? "end" : null;
  }
  function updateHistoryEnd() {
    const kind = historyEndKind();
    if (!kind) historyEndClose?.();
    historyEnd.setState({ kind, dark: isDarkColor(currentTokens().bg) });
  }
  function openHistoryEndDialog() {
    const kind = historyEnd.state().kind;
    if (!kind || historyEndClose) return;
    const sym = splitSymbol(props.symbol ?? "").ticker;
    historyEnd.setState({ active: true });
    historyEndClose = showNotice({
      title: kind === "end" ? "Start of history" : "History limit",
      text:
        kind === "end"
          ? translateWith("This is the first bar of {0}: there is no older data.", sym)
          : translateWith("Older {0} data exists but is not available: history on this interval stops here.", sym),
      iconPath: HISTORY_END_ICONS[kind],
      onClose: () => {
        historyEndClose = null;
        historyEnd.setState({ active: false });
      },
    });
  }

  /** One older window, or `null` on a transient backend error — so a failed
   *  fetch lets the user retry on the next scroll rather than latching
   *  "history exhausted" (which an empty result legitimately means). Never
   *  rejects, so it's safe to leave a background prefetch unawaited. */
  function fetchOlder(sym: string, int: string, beforeSec: number, spanDays?: number): Promise<Candle[] | null> {
    // Read the live session so older pages match the displayed series. A session
    // change bumps fetchGen + clears the prefetch buffer (see the symbol/session
    // effect), so an in-flight page for the old session is discarded on landing.
    return getBarsBefore(sym, int, beforeSec, props.session ?? "RTH", spanDays).then((r) => r, () => null);
  }

  /** Indicator recompute after a history prepend, debounced. Every study
   *  recomputes over ALL bars, so running it on each landed page made a deep
   *  scroll-back O(n²); the older section shows without studies for a moment
   *  and they fill in once paging pauses. */
  let indicatorRenderTimer: number | undefined;
  function scheduleIndicatorRender() {
    window.clearTimeout(indicatorRenderTimer);
    indicatorRenderTimer = window.setTimeout(() => {
      indicatorRenderTimer = undefined;
      cx.withCrosshairParked(() => {
        cx.controller?.renderAll();
        cx.renderCompareAll();
      });
      refreshIndicatorLegend(cx.crosshairActive ? cx.lastLegendTime : undefined);
    }, INDICATOR_RENDER_DEBOUNCE_MS);
  }
  onCleanup(() => window.clearTimeout(indicatorRenderTimer));

  /** Read-ahead: fetch the window older than `beforeSec` into {@link prefetch}
   *  so the next scroll-back prepends instantly. No-op once history is exhausted
   *  or when that exact window is already buffering. */
  function startPrefetch(sym: string, int: string, gen: number, beforeSec: number) {
    if (historyExhausted) return;
    if (prefetch && prefetch.gen === gen && prefetch.beforeSec === beforeSec) return;
    prefetch = { gen, beforeSec, rows: fetchOlder(sym, int, beforeSec) };
  }

  /** Every loaded bar (the chart may be given a slice of them, bar-slice.ts); in Bar Replay the bars replayed. */
  const loaded = (): OHLC[] => (cx.replayActive ? cx.raw : cx.allBars);

  /** The view: the range asked for when the chart has not drawn it yet (it
   *  answers the one before until its next frame, and pages landing in the
   *  same frame moved the view from that one), else the drawn one. */
  function viewRange() {
    return cx.chart ? (pendingRange(cx.chart) ?? cx.chart.timeScale().getVisibleLogicalRange()) : null;
  }

  /** Scroll-back: when the visible range's left edge nears the oldest loaded
   *  bar, take one older window — from the read-ahead buffer if it's ready, else
   *  fetched inline — prepend it, shift the visible range by the number of bars
   *  added so the candles under the cursor stay put, then pipeline the *next*
   *  window so the following scroll-back is instant too. Guards against
   *  overlapping/duplicate fetches and a stale page landing after a
   *  symbol/interval switch. Mirrors the mock (ChartView.tsx:685-747). */
  function maybeLoadOlder() {
    if (!cx.chart || !cx.series || loadingMore || historyExhausted || landing) return;
    // Don't page while the initial/refetch window is still loading: the live
    // poller can seed `raw` with a single forming bar before history lands, and
    // paging off that would compute a bogus `before` (the newest bar) and
    // duplicate the recent window. Wait until real history has populated `raw`.
    if (cx.history.loading) return;
    // Older bars are loaded already: the slice moves to them (followSlice).
    if (cx.sliceFrom > 0) return;
    // The daily family pages its underlying daily bars (so 1W/1M re-aggregate);
    // second/minute page the displayed bars directly.
    const isDaily = cx.rawDaily.length > 0;
    const oldestSrc: { time: unknown }[] = isDaily ? cx.rawDaily : loaded();
    if (oldestSrc.length === 0) return;
    const range = viewRange();
    if (!range || range.from > LOAD_MORE_THRESHOLD) return;
    // Don't page when the whole loaded series is in view — the initial
    // fitContent() (and a fully zoomed-out chart) sits at from≈0 / to≈len-1.
    // The old guard tested the visible SPAN, but scrolling/zooming left into the
    // whitespace past bar 0 inflates the span (`from` goes negative) and wrongly
    // suppressed paging — the very gesture meant to load older bars. Instead,
    // only block while the newest bar is still on-screen (right edge near the
    // last index); once the latest bars scroll off the right, page.
    if (range.to >= cx.raw.length - 1 - LOAD_MORE_THRESHOLD) return;

    loadingMore = true;
    const reqSym = props.symbol ?? "";
    const reqInt = props.interval ?? "1D";
    const reqGen = fetchGen;
    const beforeSec = oldestSrc[0].time as number;
    // Consume the buffered window when it matches this exact request; otherwise
    // fetch inline (the user scrolled before the read-ahead landed).
    const buffered =
      prefetch && prefetch.gen === reqGen && prefetch.beforeSec === beforeSec ? prefetch.rows : null;
    prefetch = null;
    const usedBuffer = buffered !== null;
    const tFetch = performance.now();
    console.log(
      `[scrollback] TRIGGER fired (from=${range.from.toFixed(1)}, raw=${cx.raw.length}, beforeSec=${beforeSec}) — source: ${usedBuffer ? "prefetch buffer" : "INLINE fetch"}`,
    );
    const source = buffered ?? fetchOlder(reqSym, reqInt, beforeSec);
    void source
      .then((rows) => {
        const ms = (performance.now() - tFetch).toFixed(0);
        console.log(
          `[scrollback] page landed in ${ms}ms (${usedBuffer ? "buffered" : "inline"}, ${rows?.length ?? "null"} rows)`,
        );
        // The series moved on while the page was in flight — discard it. We key
        // off the generation token, not a symbol/interval equality check: an
        // A→B→A switch re-matches the symbol and would let a stale page from
        // the first A view prepend into and re-range the second, parking the
        // chart on year-old bars. The token never re-matches.
        if (!cx.chart || !cx.series) return;
        if (reqGen !== fetchGen) return;
        if (rows === null) return; // transient error — allow a later retry
        // Another prepend (the date-range sync loader) landed first: this page
        // would overlap it.
        if (((isDaily ? cx.rawDaily[0]?.time : loaded()[0]?.time) as number | undefined) !== beforeSec) return;
        const older = rows.filter((r) => (r.time as number) < beforeSec);
        if (older.length === 0) {
          historyExhausted = true;
          return;
        }
        if (!prependOlder(older, isDaily, reqInt)) return;
        // Pipeline the next older window so the following scroll-back is instant.
        const nextOldest = (isDaily ? cx.rawDaily[0]?.time : loaded()[0]?.time) as number | undefined;
        if (nextOldest !== undefined) startPrefetch(reqSym, reqInt, reqGen, nextOldest);
      })
      .finally(() => {
        loadingMore = false;
        updateHistoryEnd();
        // The newer side of a window of past bars waited for this page.
        maybeLoadNewer();
      });
  }

  /** Newer page of a window of past bars: [from, to), `to` at most now. */
  function newerPage(sym: string, int: string, gen: number, from: number) {
    const to = Math.min(Date.now() / 1000, from + Math.ceil((historyPageDays(int) * 7) / 5 + 1) * 86400);
    if (!newerPrefetch || newerPrefetch.gen !== gen || newerPrefetch.from !== from) {
      // The trading days from `from`'s day on, holidays counted in.
      newerPrefetch = { gen, from, to, rows: fetchOlder(sym, int, to, tradingDaysBetween(from, to)) };
    }
    return newerPrefetch;
  }

  /** Scroll forward in a window of past bars: when the view nears its last
   *  bar, the next newer page is appended (the view stays on the same bars)
   *  and the following one is read ahead. The page that reaches now ends the
   *  window: live bars come again. */
  function maybeLoadNewer() {
    if (pastWindowEnd === null || !cx.chart || !cx.series || loadingMore || landing || cx.history.loading) return;
    if (cx.replayActive || cx.raw.length === 0) return;
    // Newer bars are loaded already: the slice moves to them (followSlice).
    if (!cx.sliceAtEnd()) return;
    const range = viewRange();
    if (!range || range.to < cx.raw.length - 1 - LOAD_MORE_THRESHOLD) return;
    loadingMore = true;
    const gen = fetchGen;
    const page = newerPage(props.symbol ?? "", props.interval ?? "1D", gen, pastWindowEnd);
    let empty = false;
    void page.rows
      .then((rows) => {
        if (gen !== fetchGen || pastWindowEnd !== page.from || !cx.chart || !cx.series) return;
        if (rows === null) return; // transient error: the next scroll tries again
        empty = !landNewer(page, rows);
      })
      .finally(() => {
        loadingMore = false;
        // A page without bars (holidays): the next one, the view is still at
        // the end. Else the older side, which waited for this page.
        if (empty) maybeLoadNewer();
        else maybeLoadOlder();
      });
  }

  /** A newer page of the window of past bars landed: its bars go at the end,
   *  and the window ends once a page reaches now (live bars come again), else
   *  the following page is read ahead. False when the page had no new bars. */
  function landNewer(page: { gen: number; to: number }, rows: Candle[]): boolean {
    newerPrefetch = null;
    const lastSec = cx.allBars[cx.allBars.length - 1].time as number;
    const newer = rows.filter((r) => (r.time as number) > lastSec);
    pastWindowEnd = page.to < Date.now() / 1000 ? page.to : null;
    if (newer.length > 0) appendNewer(newer);
    if (pastWindowEnd === null) cx.refreshControlBars();
    else newerPage(props.symbol ?? "", props.interval ?? "1D", page.gen, pastWindowEnd);
    return newer.length > 0;
  }

  /** Put `newer` (display bars after every loaded one) at the end of the
   *  series, the view kept on the same bars. */
  function appendNewer(newer: Candle[]) {
    if (!cx.chart || !cx.series) return;
    const ts = cx.chart.timeScale();
    const prevRange = viewRange();
    const shift = cx.appendBars(toOHLC(newer));
    setDataForType(cx.series, cx.activeType, cx.raw, currentTokens(), cx.dataExtras());
    cx.afterSeriesData();
    cx.updateSessionBreaks();
    scheduleIndicatorRender();
    if (!cx.crosshairActive) refreshLegend();
    if (prevRange) ts.setVisibleLogicalRange({ from: prevRange.from + shift, to: prevRange.to + shift });
  }

  /** Put `older` (bars older than every loaded one: daily rows for the daily
   *  family, which re-aggregates them, else display bars) in front of the
   *  series, the view kept on the same bars. False when the symbol's sessions
   *  needed to aggregate them are not known yet. */
  function prependOlder(older: Candle[], isDaily: boolean, int: string): boolean {
    if (!cx.chart || !cx.series) return false;
    const ts = cx.chart.timeScale();
    const prevRange = viewRange();
    // Brick types re-derive their items from the whole history (item
    // count unrelated to the bars added): keep the distance to the last
    // item, at the same bar spacing.
    const prevLast = isTransformType(cx.activeType) ? cx.mainLastIndex() : null;
    const prevLen = cx.raw.length;
    if (isDaily) {
      // Bar Replay: the daily family is loaded whole; a re-aggregation here
      // would bring back the bars after the replay time.
      if (cx.replayActive) return false;
      const unit = aggregateUnitFor(int);
      // Resolved with the first daily load (getBars).
      const spec = cachedSymbolSessions(props.symbol ?? "")?.regular;
      if (unit && !spec) return false;
      cx.rawDaily = [...older, ...cx.rawDaily];
      cx.replaceBars(toOHLC(unit ? aggregateCandles(cx.rawDaily, unit, spec!) : cx.rawDaily));
    } else if (cx.replayActive) {
      cx.replayOnPrepend(toOHLC(older));
    }
    // Bars added in front of the chart's first bar (a slice keeps its bars: bar-slice.ts).
    const shift = !isDaily && !cx.replayActive ? cx.prependBars(toOHLC(older)) : null;
    setDataForType(cx.series, cx.activeType, cx.raw, currentTokens(), cx.dataExtras());
    cx.afterSeriesData();
    cx.updateSessionBreaks();
    scheduleIndicatorRender();
    if (!cx.crosshairActive) refreshLegend();
    // Pin the view by the bars actually added — aggregation can change the
    // count for 1W/1M, so use the length delta, not the raw page length.
    const delta = shift ?? cx.raw.length - prevLen;
    if (isTransformType(cx.activeType)) {
      const last = cx.mainLastIndex();
      if (prevRange && prevLast != null && last != null) {
        ts.setVisibleLogicalRange({ from: prevRange.from + last - prevLast, to: prevRange.to + last - prevLast });
      }
    } else if (prevRange && delta > 0) {
      ts.setVisibleLogicalRange({ from: prevRange.from + delta, to: prevRange.to + delta });
    }
    return true;
  }

  /** Put `rows` that the loaded series lacks (by time, up to its last bar) at
   *  their place: daily rows for the daily family, which re-aggregates them,
   *  else display bars. The bar at the right edge of the view stays there, at
   *  the same bar spacing. Returns the number of bars added. */
  function mergeMissing(rows: Candle[], isDaily: boolean, int: string): number {
    // Bar Replay: completed when the chart is back to live data.
    if (!cx.chart || !cx.series || cx.replayActive) return 0;
    const src: readonly { time: unknown }[] = isDaily ? cx.rawDaily : cx.allBars;
    if (src.length === 0) return 0;
    const lastSec = src[src.length - 1].time as number;
    const have = new Set(src.map((b) => b.time as number));
    const missing = rows.filter((r) => r.time != null && (r.time as number) <= lastSec && !have.has(r.time as number));
    if (missing.length === 0) return 0;
    const unit = isDaily ? aggregateUnitFor(int) : null;
    // Resolved with the first daily load (getBars).
    const spec = cachedSymbolSessions(props.symbol ?? "")?.regular;
    if (unit && !spec) return 0;
    const ts = cx.chart.timeScale();
    const prevRange = viewRange();
    // Brick types re-derive their items from the whole history: keep the
    // distance to the last item instead.
    const prevLast = isTransformType(cx.activeType) ? cx.mainLastIndex() : null;
    const anchor = prevRange ? Math.min(Math.max(Math.round(prevRange.to), 0), cx.raw.length - 1) : -1;
    const anchorSec = anchor >= 0 ? (cx.raw[anchor].time as number) : null;
    const byTime = (a: { time: unknown }, b: { time: unknown }) => (a.time as number) - (b.time as number);
    if (isDaily) {
      cx.rawDaily = [...cx.rawDaily, ...missing].sort(byTime);
      cx.replaceBars(toOHLC(unit ? aggregateCandles(cx.rawDaily, unit, spec!) : cx.rawDaily));
    } else {
      cx.replaceBars([...cx.allBars, ...toOHLC(missing)].sort(byTime));
    }
    setDataForType(cx.series, cx.activeType, cx.raw, currentTokens(), cx.dataExtras());
    cx.afterSeriesData();
    cx.updateSessionBreaks();
    scheduleIndicatorRender();
    if (!cx.crosshairActive) refreshLegend();
    if (isTransformType(cx.activeType)) {
      const last = cx.mainLastIndex();
      if (prevRange && prevLast != null && last != null) {
        ts.setVisibleLogicalRange({ from: prevRange.from + last - prevLast, to: prevRange.to + last - prevLast });
      }
    } else if (prevRange && anchorSec !== null) {
      const delta = indexAtOrBefore(anchorSec) - anchor;
      if (delta !== 0) ts.setVisibleLogicalRange({ from: prevRange.from + delta, to: prevRange.to + delta });
    }
    return missing.length;
  }

  /** A load that came back without a part of the company's history (daily
   *  archive, an earlier symbol, a symbol used in between: the server could
   *  not be reached for it) is read again until it is whole, and the missing
   *  bars are put at their place, the view kept on the same bars. Stops once
   *  `isCurrent()` is false (another series or a reload took the pane) or on a
   *  final error. */
  async function completeHistory(sym: string, int: string, session: SessionId, isCurrent: () => boolean) {
    for (let attempt = 0; ; attempt++) {
      await waitBeforeRetry(attempt);
      if (!isCurrent()) return;
      let whole;
      try {
        whole = await getBars(sym, int, session, isCurrent);
      } catch {
        return;
      }
      if (!isCurrent()) return;
      const isDaily = whole.daily !== null && cx.rawDaily.length > 0;
      const added = mergeMissing(isDaily ? whole.daily! : whole.bars, isDaily, int);
      console.log(`[history] ${sym} ${int}: read again, ${added} missing bars put at their place${whole.partial ? ", still partial" : ""}`);
      if (added > 0) updateHistoryEnd();
      if (!whole.partial) return;
    }
  }

  /** Index of the newest loaded bar at or before `targetSec` (binary search on
   *  the time-ascending `raw`); 0 when the target predates every bar. */
  function indexAtOrBefore(targetSec: number): number {
    return Math.max(0, lastAtOrBefore(cx.raw, targetSec));
  }

  /** Index of the oldest loaded bar at or after `targetSec` (lower bound);
   *  the newest bar when the target is past every bar. */
  function indexAtOrAfter(targetSec: number): number {
    return Math.min(lowerBound(cx.raw, targetSec), cx.raw.length - 1);
  }

  // ── Date-range sync, driver side ────────────────────────────────────────
  /** Broadcast this pane's visible dates when it is the ACTIVE pane and a
   *  whole bar entered or left the view (only the active chart drives).
   *  Dates, not logical indices, so panes on
   *  other intervals line up. `force` re-sends an unchanged range (pane just
   *  became active, or sync was just switched on). A change the user made is
   *  also sent to linked tabs when the group's Date range channel is on,
   *  independent of this layout's own toggle. */
  function broadcastRange(force: boolean) {
    if (!cx.chart || !props.active || cx.swapping || suppressRangeBroadcast) return;
    const toLayout = layoutSync().dateRange;
    const toLink = !force && !linkQuiet && !!activeLink()?.channels.dateRange;
    if (!toLayout && !toLink) return;
    const r = cx.chart.timeScale().getVisibleRange();
    if (!r) return;
    const key = `${r.from}:${r.to}`;
    if (!force && key === lastRangeKey) return;
    lastRangeKey = key;
    if (toLayout) {
      emitAppEvent("chart-sync-range", { from: r.from as number, to: r.to as number, sourceId: paneId });
    }
    if (toLink) postLinkRange(r.from as number, r.to as number);
  }
  // Every chart re-syncs to the newly active chart's range when the active
  // chart changes or date-range sync is switched on. Memos, so only a real
  // change counts: `layoutSync()` and `props.active` re-run with every tab
  // update (a follower's saved view range too), which re-sent the active
  // range and undid any scroll of a pane that is not the active one.
  const dateRangeSyncOn = createMemo(() => layoutSync().dateRange);
  const isActive = createMemo(() => !!props.active);
  createEffect(() => {
    chartReady();
    if (!isActive() || !dateRangeSyncOn()) return;
    untrack(() => broadcastRange(true));
  });

  // ── Date-range sync, follower side ──────────────────────────────────────
  /** Queue an inbound date-range target. Only the latest target is kept, and
   *  it is applied in a later task so the driving pane's gesture never waits
   *  on its followers (a newer target supersedes the previous request). */
  function queueSyncRange(from: number, to: number) {
    syncTarget = { from, to };
    syncTargetAt = performance.now();
    scheduleSyncRun(0);
  }
  function scheduleSyncRun(delayMs: number) {
    if (syncTimer !== undefined) return;
    syncTimer = window.setTimeout(() => {
      syncTimer = undefined;
      void runSyncRange();
    }, delayMs);
  }
  onCleanup(() => window.clearTimeout(syncTimer));

  /** True when the target predates the loaded bars and more can be loaded
   *  (below `maxBars`: Infinity asks whether the target is loaded at all). The
   *  daily family holds its full history already. */
  function needsSyncLoad(fromSec: number, maxBars = SYNC_LOAD_MAX_BARS): boolean {
    return (
      cx.rawDaily.length === 0 &&
      !historyExhausted &&
      loaded().length > 0 &&
      loaded().length < maxBars &&
      (loaded()[0].time as number) > fromSec
    );
  }

  /** Distinct local calendar days among the loaded bars (≥ 1). */
  function loadedSessionDays(): number {
    const bars = loaded();
    if (bars.length === 0) return 1;
    const dayOf = dayKeyer(props.timeZone ?? "UTC");
    let days = 1;
    let cur = dayOf(bars[0].time as number);
    for (let i = 1; i < bars.length; i++) {
      const d = dayOf(bars[i].time as number);
      if (d !== cur) {
        days++;
        cur = d;
      }
    }
    return days;
  }

  /** Load history back to `t` in ONE request that reaches it, keeping the
   *  current view on the same bars meanwhile. Normally one round, more only
   *  when the trading-day estimate fell short (holidays). Every round must add
   *  older bars, else the loop stops. Depth is capped at SYNC_LOAD_MAX_BARS.
   *  `minDays`: least trading days per request (date-range sync loads one more
   *  screen, so a continued scroll lands on loaded bars instead of prepending
   *  on every move). Returns false when the series changed underneath (the
   *  caller must stop). */
  async function loadHistoryTo(t: number, wanted: () => boolean, minDays = 0): Promise<boolean> {
    const reqGen = fetchGen;
    const reqSym = props.symbol ?? "";
    const reqInt = props.interval ?? "1D";
    while (needsSyncLoad(t) && wanted()) {
      const beforeSec = loaded()[0].time as number;
      // Size the request so the depth cap holds: bars per day measured on the
      // loaded bars, window clipped to the bars still allowed.
      const perDay = barsPerDay();
      const allowedDays = Math.floor((SYNC_LOAD_MAX_BARS - loaded().length) / perDay);
      if (allowedDays < 1) break;
      const spanDays = Math.min(Math.max(tradingDaysBetween(t, beforeSec), minDays), allowedDays);
      loadingMore = true;
      let rows: Candle[] | null = null;
      try {
        rows = await fetchOlder(reqSym, reqInt, beforeSec, spanDays);
      } finally {
        loadingMore = false;
      }
      if (reqGen !== fetchGen || !cx.chart || !cx.series) return false;
      if (rows === null) break; // transient error: frame what is loaded
      const older = rows.filter((r) => (r.time as number) < beforeSec);
      if (older.length === 0) {
        historyExhausted = true;
        updateHistoryEnd();
        break;
      }
      const ts = cx.chart.timeScale();
      const prevRange = viewRange();
      const prevLast = isTransformType(cx.activeType) ? cx.mainLastIndex() : null;
      const prevLen = cx.raw.length;
      // In Bar Replay the replayed series takes them in front.
      let shift: number | null = null;
      if (cx.replayActive) cx.replayOnPrepend(toOHLC(older));
      else shift = cx.prependBars(toOHLC(older));
      prefetch = null;
      // The prepend itself fires a range change (same logical range, older
      // dates) before the view is put back below: guard it too, so it is not
      // persisted, paged or sent to synced panes / linked tabs.
      holdSyncGuard();
      setDataForType(cx.series, cx.activeType, cx.raw, currentTokens(), cx.dataExtras());
      cx.afterSeriesData();
      cx.updateSessionBreaks();
      scheduleIndicatorRender();
      if (!cx.crosshairActive) refreshLegend();
      const delta = shift ?? cx.raw.length - prevLen;
      if (isTransformType(cx.activeType)) {
        const last = cx.mainLastIndex();
        if (prevRange && prevLast != null && last != null) {
          holdSyncGuard();
          ts.setVisibleLogicalRange({ from: prevRange.from + last - prevLast, to: prevRange.to + last - prevLast });
        }
      } else if (prevRange && delta > 0) {
        holdSyncGuard();
        ts.setVisibleLogicalRange({ from: prevRange.from + delta, to: prevRange.to + delta });
      }
    }
    const nextOldest = (cx.rawDaily.length > 0 ? cx.rawDaily[0]?.time : loaded()[0]?.time) as number | undefined;
    if (nextOldest !== undefined) startPrefetch(reqSym, reqInt, reqGen, nextOldest);
    return true;
  }

  /** Apply the latest date-range target: load the bars it lacks (history
   *  back to it in one request, the newer pages of a window of past bars up to
   *  it, or far from the loaded bars a window around it, as the Go to does),
   *  then frame the target once. */
  async function runSyncRange() {
    if (!syncTarget || syncLoading || !cx.chart || !cx.series) return;
    // No data yet (first load / symbol swap): the apply effect re-runs this
    // once the bars land.
    if (cx.raw.length === 0 || cx.history.loading || cx.swapping) return;
    // The scroll-back pager or a time-sync jump is prepending: wait for it, so
    // two loaders never prepend overlapping windows.
    if (loadingMore) {
      scheduleSyncRun(50);
      return;
    }
    const target = syncTarget;
    const from = shownFrom(target.from, target.to);
    // Missing bars: wait until the driver is still, so a scroll loads once
    // at its end instead of on every move (the pane holds its view meanwhile).
    const missing = needsSyncLoad(from, Infinity) || newerMissing(target.to);
    const quietIn = SYNC_LOAD_QUIET_MS - (performance.now() - syncTargetAt);
    if (quietIn > 0 && missing) {
      scheduleSyncRun(quietIn);
      return;
    }
    syncLoading = true;
    inboundLoads++;
    try {
      if (!(await loadRange(from, target.to, () => true, tradingDaysBetween(from, target.to)))) return;
    } finally {
      syncLoading = false;
      inboundLoads--;
    }
    // A newer target came during the load: loaded and framed by its own run.
    if (syncTarget !== target) {
      scheduleSyncRun(0);
      return;
    }
    syncTarget = null;
    applySyncRange(from, target.to);
  }

  /** Start of the part of [fromSec, toSec] this pane can show (shownRangeStart):
   *  the range itself when its start is loaded. */
  function shownFrom(fromSec: number, toSec: number): number {
    if (!cx.chart || !needsSyncLoad(fromSec, Infinity)) return fromSec;
    const ts = cx.chart.timeScale();
    return shownRangeStart(fromSec, toSec, ts.width() / ts.options().minBarSpacing, barsPerDay());
  }

  /** Bar index holding a synced time on this pane: the bar of that day on
   *  daily/weekly/monthly (DWM targets snap to the trading day), the first
   *  bar at/after it on intraday frames. */
  function syncIndex(sec: number): number {
    const iv = props.interval ?? "1D";
    const dwm = !isIntradayResolution(iv) && !isSecondResolution(iv);
    return dwm ? indexAtOrBefore(sec) : indexAtOrAfter(sec);
  }

  /** Frame [fromSec, toSec] on this pane:
   *  the same dates as the driving pane, bar spacing adapting to fit (the
   *  library's min bar spacing then keeps the right edge). `driver`: the
   *  user's own move (Go to custom range), not guarded like an inbound sync.
   *  `indexOf`: bar index of a time (default: the sync rule). */
  function applySyncRange(fromSec: number, toSec: number, driver = false, indexOf: (sec: number) => number = syncIndex) {
    const guard = () => { if (!driver) holdSyncGuard(); };
    if (!cx.chart || cx.raw.length === 0) return;
    // The chart is given the loaded bars of the range (a slice elsewhere: bar-slice.ts).
    cx.sliceAround(toSec < (loaded()[0]?.time as number) ? toSec : fromSec);
    const ts = cx.chart.timeScale();
    const last = cx.raw.length - 1;
    // Target entirely older than the loaded history (history floor or the sync
    // depth cap): show the oldest bars at the current zoom instead of
    // collapsing onto one bar.
    if (toSec < (cx.raw[0].time as number)) {
      const cur = viewRange();
      const span = cur ? Math.max(MIN_VISIBLE_BARS, cur.to - cur.from) : 100;
      guard();
      ts.setVisibleLogicalRange({ from: -0.5, to: span - 0.5 });
      return;
    }
    const i = indexOf(fromSec);
    let l = Math.max(i, indexOf(toSec));
    if (l - i + 1 < SYNC_MIN_BARS) l = i + SYNC_MIN_BARS - 1;
    // A range reaching the latest bar keeps the pane's right margin.
    if (l >= last) l = Math.max(l, last + (ts.options().rightOffset ?? 0));
    guard();
    ts.setVisibleLogicalRange({ from: i - 0.5, to: l + 0.5 });
  }

  /** Display bars per trading day, measured on the loaded bars. */
  function barsPerDay(): number {
    return Math.max(1, loaded().length / loadedSessionDays());
  }

  /** True when a load to [fromSec, toSec] (a Go to, a sync target, a linked
   *  time) takes a window of past bars: more than GOTO_WINDOW_PAGES pages of
   *  history lie between the range and the loaded bars, before them or after
   *  the window shown. */
  function wantsWindow(fromSec: number, toSec: number): boolean {
    if (cx.rawDaily.length > 0 || cx.replayActive || cx.allBars.length === 0) return false;
    return wantsPastWindow({
      fromSec,
      toSec,
      firstSec: cx.allBars[0].time as number,
      lastSec: cx.allBars[cx.allBars.length - 1].time as number,
      olderMissing: needsSyncLoad(fromSec, Infinity),
      inWindow: pastWindowEnd !== null,
      pageDays: historyPageDays(props.interval ?? "1D"),
      maxPages: GOTO_WINDOW_PAGES,
    });
  }

  /** True when `toSec` is after the bars of a window of past bars. */
  function newerMissing(toSec: number): boolean {
    return pastWindowEnd !== null && !cx.replayActive && cx.allBars.length > 0 && toSec > (cx.allBars[cx.allBars.length - 1].time as number);
  }

  /** Page the newer bars of a window of past bars in, view kept on the same
   *  bars, until `toSec` is loaded or the window reaches now (live bars come
   *  again), as scrolling it right does. False when the series changed
   *  underneath. */
  async function loadNewerTo(toSec: number, wanted: () => boolean): Promise<boolean> {
    const gen = fetchGen;
    while (newerMissing(toSec) && wanted()) {
      const page = newerPage(props.symbol ?? "", props.interval ?? "1D", gen, pastWindowEnd!);
      loadingMore = true;
      let rows: Candle[] | null;
      try {
        rows = await page.rows;
      } finally {
        loadingMore = false;
      }
      if (gen !== fetchGen || !cx.chart || !cx.series) return false;
      if (rows === null) break; // transient error: frame what is loaded
      if (pastWindowEnd === page.from) landNewer(page, rows);
    }
    return true;
  }

  /** Load the bars a jump or a sync target to [fromSec, toSec] lacks: far from
   *  the loaded bars a window around it (wantsWindow), else the history back
   *  to it and the newer pages of a window of past bars up to it, then a window
   *  when the depth cap stopped short of it (Bar Replay, or a chart scrolled
   *  far back already). False when the series changed underneath or a newer
   *  jump took over. */
  async function loadRange(fromSec: number, toSec: number, wanted: () => boolean, minDays = 0): Promise<boolean> {
    if (wantsWindow(fromSec, toSec)) return loadPastWindow(fromSec, toSec, wanted);
    if (!(await loadHistoryTo(fromSec, wanted, minDays))) return false;
    if (!(await loadNewerTo(toSec, wanted))) return false;
    if (!wanted() || !needsSyncLoad(fromSec, Infinity)) return true;
    return loadPastWindow(fromSec, toSec, wanted);
  }

  /** Replace the bars by a window around [fromSec, toSec], half a page of the
   *  interval on each side, in one request. Older bars come with the
   *  scroll-back pager, newer ones with maybeLoadNewer; a window that reaches
   *  now is the live series again. False when the series changed underneath or
   *  a newer jump took over. */
  async function loadPastWindow(fromSec: number, toSec: number, wanted: () => boolean): Promise<boolean> {
    const sym = props.symbol ?? "";
    const int = props.interval ?? "1D";
    const gen = fetchGen;
    // Half a page of the interval on each side: about the bars of a first load.
    const side = Math.ceil(historyPageDays(int) / 2);
    const now = Date.now() / 1000;
    const end = Math.min(now, toSec + Math.ceil((side * 7) / 5) * 86400);
    const rangeDays = Math.ceil(((toSec - fromSec) / 86400) * (5 / 7));
    loadingMore = true;
    let rows: Candle[] | null;
    try {
      rows = await fetchOlder(sym, int, end, 2 * side + 1 + rangeDays);
    } finally {
      loadingMore = false;
    }
    if (gen !== fetchGen || !wanted() || !cx.chart || !cx.series) return false;
    // Nothing there (before the history floor) or an error: the loaded bars stay.
    if (!rows || rows.length === 0) return true;
    console.log(`[goto] ${sym} ${int}: window of ${rows.length} bars (${side} days each side)${end < now ? "" : ", up to now"}`);
    // Applied as a load of the series, through the chart's data apply (the
    // studies, compared symbols, framing and Bar Replay of a symbol switch).
    const series = seriesKey();
    const applied = new Promise<boolean>((resolve) => {
      pendingLoad?.resolve(false);
      pendingLoad = { series, end: end < now ? end : null, resolve };
    });
    cx.nextBars = { series, result: { bars: rows, daily: null, aggregate: null, partial: false } };
    landing = true;
    clearOldPoints();
    reload();
    return applied;
  }

  /** Before a load whose bars do not overlap the shown ones (a window of past
   *  bars, the latest bars after one): the studies and the future bars are
   *  cleared. Their old points would stay on the time scale until the studies'
   *  worker results come, and the view, kept by bar index across a study's
   *  redraw, would move to other dates when they go. */
  function clearOldPoints() {
    const shown = cx.raw;
    const all = cx.allBars;
    cx.raw = [];
    cx.allBars = [];
    cx.controller?.renderAll();
    cx.raw = shown;
    cx.allBars = all;
    cx.dropFutureSeries();
  }

  /** The shown series, as ChartCore.nextBars names it. */
  const seriesKey = () => `${props.symbol ?? ""} ${props.interval ?? "1D"} ${props.session ?? "RTH"}`;

  /** Load the series again (its next load takes cx.nextBars when set). */
  function reload() {
    fetchGen++;
    historyExhausted = false;
    prefetch = null;
    newerPrefetch = null;
    cx.setReloadTick((n) => n + 1);
  }

  function returnToLive(then?: () => void) {
    afterLive = then ?? null;
    clearOldPoints();
    reload();
  }

  /** The load the pending window was handed to (not a symbol or interval switch that came first). */
  let landedWindow = false;
  function loadLanded() {
    landedWindow = pendingLoad !== null && pendingLoad.series === seriesKey();
    pastWindowEnd = landedWindow ? pendingLoad!.end : null;
    newerPrefetch = null;
  }

  function loadApplied() {
    const load = pendingLoad;
    pendingLoad = null;
    if (pastWindowEnd !== null) newerPage(props.symbol ?? "", props.interval ?? "1D", fetchGen, pastWindowEnd);
    cx.refreshControlBars();
    load?.resolve(landedWindow);
    // The Go to frames the date right after (its awaited continuation), painted in the next frame.
    // Then a view wider than the window (a thin symbol) pages in what it lacks on either side.
    if (landing) {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          landing = false;
          maybeLoadOlder();
          maybeLoadNewer();
        }),
      );
    }
    const then = afterLive;
    afterLive = null;
    then?.();
  }

  /** Bar index for a "Go to" date (the reference app `_gotoTimeImpl`): intraday, the bar
   *  holding the time (the reference app aligns the target to its bar start), else the first
   *  bar after it; the first bar at/after the date on DWM. */
  function gotoDateIndex(sec: number): number {
    const iv = props.interval ?? "1D";
    if (!isIntradayResolution(iv) && !isSecondResolution(iv)) return indexAtOrAfter(sec);
    const step = parseInt(iv, 10) * (/S$/.test(iv) ? 1 : 60);
    const i = indexAtOrBefore(sec);
    const t = cx.raw[i].time as number;
    return t <= sec && sec < t + step ? i : indexAtOrAfter(sec);
  }


  /** Bumped per goToTime / goToRange call so a newer jump supersedes an
   *  in-flight older one. */
  let gotoGen = 0;
  /** Receiving side of "Time" sync and linked tabs (target aligned to the
   *  centre, no alignment when already visible): when the clicked time is
   *  already in view nothing moves; otherwise the pane loads the bars to it if
   *  needed (loadRange: far back a window of bars around it) and centres it at
   *  the current bar spacing. It only scrolls: the crosshair is the crosshair
   *  sync's business. The Go to dialog uses it with `alignIfVisible` and
   *  `driver` (the reference app `gotoTime`). */
  async function goToTime(targetSec: number, opts: GotoOpts = {}) {
    if (!cx.chart || !cx.series || cx.raw.length === 0) return;
    const ts = cx.chart.timeScale();
    const indexOf = opts.index ?? syncIndex;
    const isLoaded = (loaded()[0].time as number) <= targetSec || cx.rawDaily.length > 0 || historyExhausted;
    const cur = viewRange();
    const onChart = targetSec >= (cx.raw[0].time as number) && targetSec <= (cx.raw[cx.raw.length - 1].time as number);
    if (isLoaded && onChart && cur && !opts.alignIfVisible) {
      const idx = indexOf(targetSec);
      if (idx >= cur.from && idx <= cur.to) return;
    }
    // Another loader is prepending: retry once it is done.
    if (loadingMore) {
      window.setTimeout(() => void goToTime(targetSec, opts), 50);
      return;
    }
    const myGoto = ++gotoGen;
    const wanted = () => myGoto === gotoGen;
    // Darken while the target history loads (same dim-and-hold treatment as a
    // symbol load), debounced so an in-memory jump never flashes it.
    const dimTimer = wantsWindow(targetSec, targetSec) || needsSyncLoad(targetSec) ? window.setTimeout(() => cx.setDimmed(true), 160) : 0;
    // A follower's load is not its own move (see inboundLoads).
    if (!opts.driver) inboundLoads++;
    try {
      if (!(await loadRange(targetSec, targetSec, wanted))) return;
      if (myGoto !== gotoGen || !cx.chart) return;
      // The chart is given the loaded bars around the date (a slice elsewhere: bar-slice.ts).
      cx.sliceAround(targetSec);
      const r = viewRange();
      const span = r ? r.to - r.from : 120;
      const idx = indexOf(targetSec);
      if (!opts.driver) holdSyncGuard();
      ts.setVisibleLogicalRange({ from: idx - span / 2, to: idx + span / 2 });
    } finally {
      if (!opts.driver) inboundLoads--;
      clearTimeout(dimTimer);
      // Only the latest jump clears the dim.
      if (myGoto === gotoGen) cx.setDimmed(false);
    }
  }

  /** Go to "Custom range" (the reference app `setTimeFrame` with a time range): load the
   *  history back to `fromSec` if needed (far back, a window around the range),
   *  then frame [fromSec, toSec] like a date-range sync target. The user's own
   *  move: persisted and sent to synced panes. */
  async function goToRange(fromSec: number, toSec: number) {
    if (!cx.chart || !cx.series || cx.raw.length === 0) return;
    // Retried once the other loader is done; the caller waits for the frame (a journal share pictures it).
    if (loadingMore) {
      await new Promise((r) => window.setTimeout(r, 50));
      return goToRange(fromSec, toSec);
    }
    const myGoto = ++gotoGen;
    const wanted = () => myGoto === gotoGen;
    const dimTimer = wantsWindow(fromSec, toSec) || needsSyncLoad(fromSec) ? window.setTimeout(() => cx.setDimmed(true), 160) : 0;
    try {
      if (!(await loadRange(fromSec, toSec, wanted))) return;
      if (myGoto !== gotoGen || !cx.chart) return;
      // The reference app `gotoTimeRange`: both ends go to the first bar at/after their time.
      applySyncRange(fromSec, toSec, true, indexAtOrAfter);
    } finally {
      clearTimeout(dimTimer);
      if (myGoto === gotoGen) cx.setDimmed(false);
    }
  }

  return {
    broadcastRange,
    completeHistory,
    get fetchGen() {
      return fetchGen;
    },
    set fetchGen(v: typeof fetchGen) {
      fetchGen = v;
    },
    goToRange,
    goToTime,
    gotoDateIndex,
    get historyExhausted() {
      return historyExhausted;
    },
    set historyExhausted(v: typeof historyExhausted) {
      historyExhausted = v;
    },
    holdLinkQuiet,
    get loadingMore() {
      return loadingMore;
    },
    set loadingMore(v: typeof loadingMore) {
      loadingMore = v;
    },
    loadApplied,
    loadLanded,
    maybeLoadNewer,
    maybeLoadOlder,
    openHistoryEndDialog,
    get pastWindowEnd() {
      return pastWindowEnd;
    },
    returnToLive,
    get pendingLinkTime() {
      return pendingLinkTime;
    },
    set pendingLinkTime(v: typeof pendingLinkTime) {
      pendingLinkTime = v;
    },
    get prefetch() {
      return prefetch;
    },
    set prefetch(v: typeof prefetch) {
      prefetch = v;
    },
    queueSyncRange,
    scheduleSyncRun,
    startPrefetch,
    get suppressCrosshairBroadcast() {
      return suppressCrosshairBroadcast;
    },
    set suppressCrosshairBroadcast(v: typeof suppressCrosshairBroadcast) {
      suppressCrosshairBroadcast = v;
    },
    get syncGuard() {
      return syncGuard || inboundLoads > 0;
    },
    get syncTarget() {
      return syncTarget;
    },
    updateHistoryEnd,
  };
}
