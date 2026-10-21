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
  isIntradayResolution,
  isSecondResolution,
  splitSymbol,
} from "../../../data/datafeed";
import { type Candle } from "../../../bindings";
import { isTransformType, setDataForType } from "../chart-types";
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
  INDICATOR_RENDER_DEBOUNCE_MS,
  SYNC_LOAD_QUIET_MS,
} from "./helpers";
import { type ChartCx } from "./context";
import { emitAppEvent } from "../../../data/app-events";
import { waitBeforeRetry } from "../../../data/connection";
import type { SessionId } from "../../../data/session";

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
  readonly historyEndClose: (() => void) | null;
  historyExhausted: boolean;
  holdLinkQuiet: () => void;
  loadingMore: boolean;
  maybeLoadOlder: () => void;
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
  const { afterSeriesData, chartReady, currentTokens, dataExtras, historyEnd, mainLastIndex, paneId, props, refreshIndicatorLegend, refreshLegend, updateSessionBreaks } = cx;
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
  // True while the sync loader awaits its history request.
  let syncLoading = false;
  // Guard while an inbound range lands. The library applies setVisibleRange on
  // its NEXT paint and fires the range-change callback there, so the guard is
  // held for two frames: no broadcast, no persist, no scroll-back pager for a
  // view the pane did not choose itself.
  let syncGuard = false;
  let syncGuardSeq = 0;
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

  let historyEndClose: (() => void) | null = null;
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
    if (!historyExhausted || loadingMore || cx.raw.length === 0) return null;
    const ent = providerCapabilities()?.entitlements;
    if (!ent) return null;
    const iv = props.interval ?? "1D";
    const daily = cx.rawDaily.length > 0;
    const floor = daily ? ent.historyFloor.day : isSecondResolution(iv) ? ent.historyFloor.second : ent.historyFloor.minute;
    const oldest = (daily ? cx.rawDaily[0].time : cx.raw[0].time) as number;
    const floorSec = floor ? Date.parse(`${floor}T00:00:00Z`) / 1000 : NaN;
    if (Number.isFinite(floorSec) && oldest - floorSec <= 7 * 86400) return "limit";
    if (daily && oldest - Date.parse(`${DAILY_ARCHIVE_START}T00:00:00Z`) / 1000 <= 7 * 86400) return "limit";
    return cx.raw.length >= HISTORY_END_MIN_BARS ? "end" : null;
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
          ? `This is the first bar of ${sym}: there is no older data.`
          : `Older ${sym} data exists but is not available: history on this interval stops here.`,
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

  /** Scroll-back: when the visible range's left edge nears the oldest loaded
   *  bar, take one older window — from the read-ahead buffer if it's ready, else
   *  fetched inline — prepend it, shift the visible range by the number of bars
   *  added so the candles under the cursor stay put, then pipeline the *next*
   *  window so the following scroll-back is instant too. Guards against
   *  overlapping/duplicate fetches and a stale page landing after a
   *  symbol/interval switch. Mirrors the mock (ChartView.tsx:685-747). */
  function maybeLoadOlder() {
    if (!cx.chart || !cx.series || loadingMore || historyExhausted) return;
    // Don't page while the initial/refetch window is still loading: the live
    // poller can seed `raw` with a single forming bar before history lands, and
    // paging off that would compute a bogus `before` (the newest bar) and
    // duplicate the recent window. Wait until real history has populated `raw`.
    if (cx.history.loading) return;
    // The daily family pages its underlying daily bars (so 1W/1M re-aggregate);
    // second/minute page the displayed bars directly.
    const isDaily = cx.rawDaily.length > 0;
    const oldestSrc: { time: unknown }[] = isDaily ? cx.rawDaily : cx.raw;
    if (oldestSrc.length === 0) return;
    const ts = cx.chart.timeScale();
    const range = ts.getVisibleLogicalRange();
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
        if (((isDaily ? cx.rawDaily[0]?.time : cx.raw[0]?.time) as number | undefined) !== beforeSec) return;
        const older = rows.filter((r) => (r.time as number) < beforeSec);
        if (older.length === 0) {
          historyExhausted = true;
          return;
        }
        if (!prependOlder(older, isDaily, reqInt)) return;
        // Pipeline the next older window so the following scroll-back is instant.
        const nextOldest = (isDaily ? cx.rawDaily[0]?.time : cx.raw[0]?.time) as number | undefined;
        if (nextOldest !== undefined) startPrefetch(reqSym, reqInt, reqGen, nextOldest);
      })
      .finally(() => {
        loadingMore = false;
        updateHistoryEnd();
      });
  }

  /** Put `older` (bars older than every loaded one: daily rows for the daily
   *  family, which re-aggregates them, else display bars) in front of the
   *  series, the view kept on the same bars. False when the symbol's sessions
   *  needed to aggregate them are not known yet. */
  function prependOlder(older: Candle[], isDaily: boolean, int: string): boolean {
    if (!cx.chart || !cx.series) return false;
    const ts = cx.chart.timeScale();
    const prevRange = ts.getVisibleLogicalRange();
    // Brick types re-derive their items from the whole history (item
    // count unrelated to the bars added): keep the distance to the last
    // item, at the same bar spacing.
    const prevLast = isTransformType(cx.activeType) ? mainLastIndex() : null;
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
      cx.raw = toOHLC(unit ? aggregateCandles(cx.rawDaily, unit, spec!) : cx.rawDaily);
    } else if (cx.replayActive) {
      cx.replayOnPrepend(toOHLC(older));
    } else {
      cx.raw = [...toOHLC(older), ...cx.raw];
    }
    setDataForType(cx.series, cx.activeType, cx.raw, currentTokens(), dataExtras());
    afterSeriesData();
    updateSessionBreaks();
    scheduleIndicatorRender();
    if (!cx.crosshairActive) refreshLegend();
    // Pin the view by the bars actually added — aggregation can change the
    // count for 1W/1M, so use the length delta, not the raw page length.
    const delta = cx.raw.length - prevLen;
    if (isTransformType(cx.activeType)) {
      const last = mainLastIndex();
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
    const src: readonly { time: unknown }[] = isDaily ? cx.rawDaily : cx.raw;
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
    const prevRange = ts.getVisibleLogicalRange();
    // Brick types re-derive their items from the whole history: keep the
    // distance to the last item instead.
    const prevLast = isTransformType(cx.activeType) ? mainLastIndex() : null;
    const anchor = prevRange ? Math.min(Math.max(Math.round(prevRange.to), 0), cx.raw.length - 1) : -1;
    const anchorSec = anchor >= 0 ? (cx.raw[anchor].time as number) : null;
    const byTime = (a: { time: unknown }, b: { time: unknown }) => (a.time as number) - (b.time as number);
    if (isDaily) {
      cx.rawDaily = [...cx.rawDaily, ...missing].sort(byTime);
      cx.raw = toOHLC(unit ? aggregateCandles(cx.rawDaily, unit, spec!) : cx.rawDaily);
    } else {
      cx.raw = [...cx.raw, ...toOHLC(missing)].sort(byTime);
    }
    setDataForType(cx.series, cx.activeType, cx.raw, currentTokens(), dataExtras());
    afterSeriesData();
    updateSessionBreaks();
    scheduleIndicatorRender();
    if (!cx.crosshairActive) refreshLegend();
    if (isTransformType(cx.activeType)) {
      const last = mainLastIndex();
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
    let lo = 0,
      hi = cx.raw.length - 1,
      ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((cx.raw[mid].time as number) <= targetSec) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  /** Index of the oldest loaded bar at or after `targetSec` (lower bound);
   *  the newest bar when the target is past every bar. */
  function indexAtOrAfter(targetSec: number): number {
    let lo = 0,
      hi = cx.raw.length - 1,
      ans = cx.raw.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((cx.raw[mid].time as number) >= targetSec) {
        ans = mid;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    return ans;
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

  /** True when the target predates the loaded bars and more can be loaded for
   *  sync. The daily family holds its full history already. */
  function needsSyncLoad(fromSec: number): boolean {
    return (
      cx.rawDaily.length === 0 &&
      !historyExhausted &&
      cx.raw.length > 0 &&
      cx.raw.length < SYNC_LOAD_MAX_BARS &&
      (cx.raw[0].time as number) > fromSec
    );
  }

  /** Trading days from `fromSec` up to `beforeSec` (the backend sizes history
   *  windows in trading days): weekdays plus a holiday margin. */
  function tradingDaysBetween(fromSec: number, beforeSec: number): number {
    const cal = Math.max(0, (beforeSec - fromSec) / 86400);
    return Math.max(1, Math.ceil((cal * 5) / 7) + 2 + Math.ceil(cal / 36));
  }

  /** Distinct local calendar days among the loaded bars (≥ 1). */
  function loadedSessionDays(): number {
    if (cx.raw.length === 0) return 1;
    const dayOf = dayKeyer(props.timeZone ?? "UTC");
    let days = 1;
    let cur = dayOf(cx.raw[0].time as number);
    for (let i = 1; i < cx.raw.length; i++) {
      const d = dayOf(cx.raw[i].time as number);
      if (d !== cur) {
        days++;
        cur = d;
      }
    }
    return days;
  }

  /** Load history back to the target time in ONE request that reaches it,
   *  keeping the current view on the same bars meanwhile.
   *  `target` is re-read after each await, so a newer target that arrived
   *  during the load is honoured; normally one round, more only when the
   *  trading-day estimate fell short (holidays) or the target moved further
   *  back. Every round must add older bars, else the loop stops. Sync-driven
   *  depth is capped at SYNC_LOAD_MAX_BARS. `minDays`: least trading days per
   *  request (date-range sync loads one more screen, so a continued scroll
   *  lands on loaded bars instead of prepending on every move). Returns false
   *  when the series changed underneath (the caller must stop). */
  async function loadHistoryTo(target: () => number | null, wanted: () => boolean, minDays = 0): Promise<boolean> {
    const reqGen = fetchGen;
    const reqSym = props.symbol ?? "";
    const reqInt = props.interval ?? "1D";
    let t = target();
    while (t != null && needsSyncLoad(t) && wanted()) {
      const beforeSec = cx.raw[0].time as number;
      // Size the request so the depth cap holds: bars per day measured on the
      // loaded bars, window clipped to the bars still allowed.
      const perDay = Math.max(1, cx.raw.length / loadedSessionDays());
      const allowedDays = Math.floor((SYNC_LOAD_MAX_BARS - cx.raw.length) / perDay);
      if (allowedDays < 1) break;
      const spanDays = Math.min(Math.max(tradingDaysBetween(t, beforeSec), minDays), allowedDays);
      syncLoading = true;
      loadingMore = true;
      let rows: Candle[] | null = null;
      try {
        rows = await fetchOlder(reqSym, reqInt, beforeSec, spanDays);
      } finally {
        syncLoading = false;
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
      const prevRange = ts.getVisibleLogicalRange();
      const prevLast = isTransformType(cx.activeType) ? mainLastIndex() : null;
      const prevLen = cx.raw.length;
      // In Bar Replay the replayed series takes them in front.
      if (cx.replayActive) cx.replayOnPrepend(toOHLC(older));
      else cx.raw = toOHLC(older).concat(cx.raw);
      prefetch = null;
      // The prepend itself fires a range change (same logical range, older
      // dates) before the view is put back below: guard it too, so it is not
      // persisted, paged or sent to synced panes / linked tabs.
      holdSyncGuard();
      setDataForType(cx.series, cx.activeType, cx.raw, currentTokens(), dataExtras());
      afterSeriesData();
      updateSessionBreaks();
      scheduleIndicatorRender();
      if (!cx.crosshairActive) refreshLegend();
      const delta = cx.raw.length - prevLen;
      if (isTransformType(cx.activeType)) {
        const last = mainLastIndex();
        if (prevRange && prevLast != null && last != null) {
          holdSyncGuard();
          ts.setVisibleLogicalRange({ from: prevRange.from + last - prevLast, to: prevRange.to + last - prevLast });
        }
      } else if (prevRange && delta > 0) {
        holdSyncGuard();
        ts.setVisibleLogicalRange({ from: prevRange.from + delta, to: prevRange.to + delta });
      }
      t = target();
    }
    const nextOldest = (cx.rawDaily.length > 0 ? cx.rawDaily[0]?.time : cx.raw[0]?.time) as number | undefined;
    if (nextOldest !== undefined) startPrefetch(reqSym, reqInt, reqGen, nextOldest);
    return true;
  }

  /** Apply the latest date-range target: load missing history (one request),
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
    // Missing history: wait until the driver is still, so a scroll loads once
    // at its end instead of on every move (the pane holds its view meanwhile).
    const quietIn = SYNC_LOAD_QUIET_MS - (performance.now() - syncTargetAt);
    if (quietIn > 0 && needsSyncLoad(syncTarget.from)) {
      scheduleSyncRun(quietIn);
      return;
    }
    const screenDays = tradingDaysBetween(syncTarget.from, syncTarget.to);
    if (!(await loadHistoryTo(() => syncTarget?.from ?? null, () => true, screenDays))) return;
    const t = syncTarget;
    syncTarget = null;
    if (t) applySyncRange(t.from, t.to);
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
    const ts = cx.chart.timeScale();
    const last = cx.raw.length - 1;
    // Target entirely older than the loaded history (history floor or the sync
    // depth cap): show the oldest bars at the current zoom instead of
    // collapsing onto one bar.
    if (toSec < (cx.raw[0].time as number)) {
      const cur = ts.getVisibleLogicalRange();
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
  /** Receiving side of "Time" sync (target aligned to the centre, no
   *  alignment when already visible): when the
   *  clicked time is already in view nothing moves; otherwise the pane loads
   *  history back to it if needed (one request, capped) and centres it at the
   *  current bar spacing. It only scrolls: the crosshair is the crosshair
   *  sync's business. The Go to dialog uses it with `alignIfVisible` and
   *  `driver` (the reference app `gotoTime`). */
  async function goToTime(targetSec: number, opts: GotoOpts = {}) {
    if (!cx.chart || !cx.series || cx.raw.length === 0) return;
    const ts = cx.chart.timeScale();
    const indexOf = opts.index ?? syncIndex;
    const loaded = (cx.raw[0].time as number) <= targetSec || cx.rawDaily.length > 0 || historyExhausted;
    const cur = ts.getVisibleLogicalRange();
    if (loaded && cur && !opts.alignIfVisible) {
      const idx = indexOf(targetSec);
      if (idx >= cur.from && idx <= cur.to) return;
    }
    // Another loader is prepending: retry once it is done.
    if (loadingMore) {
      window.setTimeout(() => void goToTime(targetSec, opts), 50);
      return;
    }
    const myGoto = ++gotoGen;
    // Darken while the target history loads (same dim-and-hold treatment as a
    // symbol load), debounced so an in-memory jump never flashes it.
    const dimTimer = needsSyncLoad(targetSec) ? window.setTimeout(() => cx.setDimmed(true), 160) : 0;
    try {
      if (!(await loadHistoryTo(() => targetSec, () => myGoto === gotoGen))) return;
      if (myGoto !== gotoGen || !cx.chart) return;
      const r = ts.getVisibleLogicalRange();
      const span = r ? r.to - r.from : 120;
      const idx = indexOf(targetSec);
      if (!opts.driver) holdSyncGuard();
      ts.setVisibleLogicalRange({ from: idx - span / 2, to: idx + span / 2 });
    } finally {
      clearTimeout(dimTimer);
      // Only the latest jump clears the dim.
      if (myGoto === gotoGen) cx.setDimmed(false);
    }
  }

  /** Go to "Custom range" (the reference app `setTimeFrame` with a time range): load history
   *  back to `fromSec` if needed, then frame [fromSec, toSec] like a date-range
   *  sync target. The user's own move: persisted and sent to synced panes. */
  async function goToRange(fromSec: number, toSec: number) {
    if (!cx.chart || !cx.series || cx.raw.length === 0) return;
    if (loadingMore) {
      window.setTimeout(() => void goToRange(fromSec, toSec), 50);
      return;
    }
    const myGoto = ++gotoGen;
    const dimTimer = needsSyncLoad(fromSec) ? window.setTimeout(() => cx.setDimmed(true), 160) : 0;
    try {
      if (!(await loadHistoryTo(() => fromSec, () => myGoto === gotoGen))) return;
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
    get historyEndClose() {
      return historyEndClose;
    },
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
    maybeLoadOlder,
    openHistoryEndDialog,
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
      return syncGuard;
    },
    get syncTarget() {
      return syncTarget;
    },
    updateHistoryEnd,
  };
}
