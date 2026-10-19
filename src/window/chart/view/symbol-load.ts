/*
 * Loading a symbol / interval / session on a chart view: the switch (keep the
 * old candles dimmed, carry the bar spacing and distance to the last bar),
 * applying the loaded bars and framing them, and the dim overlay.
 */
/*
 * ChartView — single chart pane backed by lightweight-charts (v5).
 *
 * Chart and series are imperative state held in plain `let` bindings.
 * Theme + chart-type changes both flow in via Solid effects that swap the
 * active series via createSeriesForType / setDataForType.
 *
 * Drawings: every kind lives in the <DrawingsOverlay> SVG layer fed a
 * Coords bridge (refreshed on every series rebuild) and a `coordEpoch`
 * counter that bumps on pan/zoom. Horizontal-line was the last holdout
 * (native priceLine through Feature 5a); Feature 5c moved it to the
 * overlay for parity with the other 13 kinds.
 */
import { createEffect, createSignal, onCleanup, untrack } from "solid-js";
import { type Time } from "lightweight-charts";
import { liveBarSpacing } from "../control-bar";
import { initialViewBars, type BarsResult, type SessionId } from "../../../data/datafeed";
import { isTransformType, setDataForType } from "../chart-types";
import { type ChartCx } from "./context";
import { toOHLC, barsSpan, MIN_VISIBLE_BARS, SYMBOL_CHANGE_MAX_BACK } from "./helpers";
import type { Accessor, Setter } from "solid-js";

/** What createSymbolLoad adds to the chart context. */
export interface SymbolLoadApi {
  dimmed: Accessor<boolean>;
  setDimmed: Setter<boolean>;
}

export function createSymbolLoad(cx: ChartCx): SymbolLoadApi {
  const { afterSeriesData, currentTokens, dataExtras, history, mainLastIndex, props, updateSessionBreaks } = cx;
  // Symbol/interval change → drop the previous series immediately so an
  // in-flight fetch can never leave another symbol's candles (or its last
  // price in the legend) on screen. The history effect below refills once the
  // new bars arrive; until then the pane reads as empty/loading.
  // `props.symbol`/`props.interval` are non-memoized accessors over the
  // active-tab signal, and the render helpers below subscribe this effect to
  // further signals (indicator/legend state). Any of those firing
  // re-runs this effect with an UNCHANGED symbol — and a re-run that lands
  // after the apply effect has painted would blank the freshly-loaded chart
  // (the "every other symbol goes blank" bug). The value guard makes the clear
  // act only on a genuine symbol/interval change, mirroring the drawings effect.
  let firstSymbol = true;
  let lastClearedSym: string | undefined;
  let lastClearedInt: string | undefined;
  // Session counts as a genuine series change (it refetches + re-buckets the
  // bars), so it resets paging and runs the swap transition just like interval.
  let lastClearedSess: SessionId | undefined;
  // Wall-clock of the last genuine symbol/interval change, so the apply effect
  // can log the true end-to-end (selection → painted) time.
  let loadStartMs = 0;

  // Pre-switch bar spacing + right offset (bars between the last bar and the
  // right edge), captured when the interval/session changes on the SAME symbol.
  // Both are kept across an interval change and the dates move, e.g.
  // 1D scrolled back 300 bars → 60 still 300 bars back at the same spacing, and
  // back to 1D on the exact previous dates. Null for symbol changes / first load.
  // With Scales → "Save chart left edge position when changing interval" on,
  // `leftTime` (the left edge's bar time) is kept instead of the right offset.
  // A symbol change keeps them too (`symbol`): same bar spacing, same number of
  // bars back from the last bar, at most SYMBOL_CHANGE_MAX_BACK; and the price
  // scale is fitted once to the new symbol, also with auto scale off.
  let pendingScaleKeep: { barSpacing: number; rightOffset: number; leftTime?: number; symbol?: boolean } | null = null;


  createEffect(() => {
    const sym = props.symbol;
    const int = props.interval;
    const sess = props.session;
    if (firstSymbol) {
      firstSymbol = false;
      lastClearedSym = sym;
      lastClearedInt = int;
      lastClearedSess = sess;
      return;
    }
    if (sym === lastClearedSym && int === lastClearedInt && sess === lastClearedSess) return;
    loadStartMs = performance.now();
    {
      const w = window as unknown as { __clickT?: number };
      const sinceClick = w.__clickT ? ` | select→symbol-effect ${(loadStartMs - w.__clickT).toFixed(0)}ms` : "";
      console.log(`[symbol-effect] ${sym} ${int} ${sess}${sinceClick}`);
    }
    // Interval/session switch on the SAME symbol: keep the bar spacing and the
    // right offset (see pendingScaleKeep). Captured now, while the old
    // interval is still painted. A symbol change frames its own window.
    if (cx.chart && sym === lastClearedSym && (int !== lastClearedInt || sess !== lastClearedSess)) {
      const bs = liveBarSpacing(cx.chart);
      const leftTime = currentTokens().saveLeftEdge ? (cx.chart.timeScale().getVisibleRange()?.from as number | undefined) : undefined;
      pendingScaleKeep = bs ? { barSpacing: bs, rightOffset: cx.chart.timeScale().scrollPosition(), leftTime } : null;
    } else {
      // Symbol change: the new symbol opens at the same bar spacing and the
      // same distance from its last bar (no farther back than
      // SYMBOL_CHANGE_MAX_BACK), not on the old symbol's bar numbers.
      const bs = cx.chart && cx.raw.length > 0 ? liveBarSpacing(cx.chart) : null;
      pendingScaleKeep = bs && sym !== lastClearedSym
        ? { barSpacing: bs, rightOffset: Math.max(cx.chart!.timeScale().scrollPosition(), -SYMBOL_CHANGE_MAX_BACK), symbol: true }
        : null;
      // A genuine symbol change drops any queued date-range preset — it rode
      // an interval change on the previous symbol.
      cx.pendingRangeSpan = null;
    }
    lastClearedSym = sym;
    lastClearedInt = int;
    lastClearedSess = sess;
    if (!cx.chart || !cx.series) return;
    // Keep the previous symbol's candles painted (the dim overlay covers them)
    // until the new data lands — a stale-while-loading
    // transition instead of a blank flash. We only invalidate paging and any
    // in-flight page here; the apply effect swaps the data when it arrives.
    // Bumping the generation token makes a page launched for the previous series
    // bail in its `.then` instead of prepending/re-ranging the new one.
    cx.swapping = true;
    cx.fetchGen++;
    cx.loadingMore = false;
    cx.historyExhausted = false;
    cx.updateHistoryEnd();
    cx.prefetch = null;
    cx.liveVolBase = null;
    // Drop any anchor-persist queued for the OUTGOING symbol so it can't land on
    // the incoming pane after the swap (the apply effect restores the new pane's
    // own saved range).
    if (cx.rangePersistTimer !== undefined) {
      clearTimeout(cx.rangePersistTimer);
      cx.rangePersistTimer = undefined;
    }
  });
  // The last resource value this effect actually applied. The render/legend
  // helpers below subscribe the effect to indicator/legend signals, and
  // onRangeChange bumps coordEpoch on every scroll — so this effect can re-run
  // with the SAME resource value. Without a guard a re-run would reset `raw`
  // back to the recent window (dropping scroll-back / time-sync pages) and
  // re-frame to the latest bars — the "scroll snaps back to today" bug. Track
  // the applied value and skip spurious re-runs (mirrors the symbol-clear
  // effect's value guard above).
  // `undefined` = nothing applied yet: a first load that resolves to null (no
  // data, or a failed fetch) must still clear the pane and end the transition.
  let lastAppliedReal: BarsResult | null | undefined = undefined;
  createEffect(() => {
    const real = history();
    if (!cx.chart || !cx.series) return;
    // Mid-refetch the resource still reports the previous symbol's bars; wait
    // for the new fetch to settle before touching the chart so we don't flash
    // stale data.
    if (history.loading) return;
    // Same dataset as last applied → a spurious re-run (legend/indicator/scroll
    // signal), not new data. Leave the chart (and the user's scroll position +
    // any paged bars) untouched.
    if (real === lastAppliedReal) return;
    lastAppliedReal = real;
    // New symbol resolved with no data (not served by the data source, entitlement gap, …).
    // Clear the previous symbol's candles instead of leaving them painted —
    // otherwise switching tabs looks like the price never changes.
    if (!real || real.bars.length === 0) {
      cx.raw = [];
      cx.rawDaily = [];
      cx.liveVolBase = null;
      setDataForType(cx.series, cx.activeType, cx.raw, currentTokens(), dataExtras());
      afterSeriesData();
      updateSessionBreaks();
      if (!cx.crosshairActive) cx.refreshLegend();
      cx.controller?.renderAll();
      cx.renderCompareAll();
      cx.refreshIndicatorLegend(cx.crosshairActive ? cx.lastLegendTime : undefined);
      cx.swapping = false;
      return;
    }
    // The datafeed already aggregated 1W/1M; `real.daily` carries the
    // underlying daily bars (null for second/minute) so scroll-back can
    // re-aggregate the full set.
    cx.rawDaily = real.daily ?? [];
    cx.raw = toOHLC(real.bars);
    // Fresh series (possibly a new ADJ basis) — re-snap the 1W/1M live-volume
    // baseline from the reloaded bars on the next tick.
    cx.liveVolBase = null;
    setDataForType(cx.series, cx.activeType, cx.raw, currentTokens(), dataExtras());
      afterSeriesData();
    updateSessionBreaks();
    // Recompute every active study against the freshly-loaded bars BEFORE
    // framing: study series add their times to the time scale (with a
    // transform type their real times sit between the synthetic ones), so
    // the saved range is checked and the view set on the final axis.
    cx.controller?.renderAll();
    cx.renderCompareAll();
    // Restore the user's last anchored view for this pane (persisted across tab
    // switches + reloads) when it still references loaded bars; otherwise fall
    // back to default framing. Read untracked so this effect re-runs only on new
    // data, not on every scroll that updates the saved range. A range that
    // shows fewer than MIN_VISIBLE_BARS of the loaded bars (e.g. a
    // shorter-history symbol, or a view saved past the last bar) is treated
    // as out of bounds.
    let saved = untrack(() => props.visibleLogicalRange);
    // Price-based types: the view follows the last item (its index moves
    // when the item count changed since the save).
    if (saved && saved.last !== undefined && isTransformType(cx.activeType)) {
      const last = mainLastIndex();
      if (last != null) saved = { from: saved.from + last - saved.last, to: saved.to + last - saved.last, last };
    }
    // A saved view narrower than MIN_VISIBLE_BARS is the 1-bar collapse the old
    // sync path could persist, not a user choice: frame by default instead.
    let savedInBounds = !!saved && saved.to - saved.from >= MIN_VISIBLE_BARS;
    if (savedInBounds) {
      // Overlap, in time-scale indices, between the saved range and the
      // series. Transform types have their own items (data() copies, so only
      // there).
      const ts = cx.chart.timeScale();
      const items: readonly { time: Time }[] = isTransformType(cx.activeType) ? cx.series.data() : cx.raw;
      const first = items.length ? ts.timeToIndex(items[0].time, true) : null;
      const last = items.length ? ts.timeToIndex(items[items.length - 1].time, true) : null;
      const shown = first != null && last != null ? Math.min(saved!.to, last) - Math.max(saved!.from, first) + 1 : 0;
      savedInBounds = shown >= MIN_VISIBLE_BARS;
    }
    // Describes the framing applied, for the [apply] perf log below.
    let framed: string;
    if (cx.pendingRangeSpan) {
      // Bottom-bar date-range tab: frame the preset span on the new interval
      // (overrides the interval-switch scale keep: the user asked for the span).
      const spanId = cx.pendingRangeSpan;
      cx.pendingRangeSpan = null;
      pendingScaleKeep = null;
      framed = `span ${spanId}`;
      cx.applyRangeSpan(spanId);
    } else if (pendingScaleKeep) {
      // Interval/session switch on the same symbol: same bar spacing, same
      // number of bars between the last bar and the right edge. A view deeper
      // than the loaded intraday window pulls older pages in through the
      // scroll-back pager, as a user scroll would.
      const keep = pendingScaleKeep;
      pendingScaleKeep = null;
      const ts = cx.chart.timeScale();
      if (isTransformType(cx.activeType)) {
        // Price-based types: same bar spacing and right offset, counted from
        // their own last item (no time of their own for a left edge).
        const to = (mainLastIndex() ?? cx.raw.length - 1) + keep.rightOffset;
        ts.setVisibleLogicalRange({ from: to - barsSpan(ts.width(), keep.barSpacing), to });
        framed = `keep bs=${keep.barSpacing.toFixed(2)} ro=${keep.rightOffset.toFixed(1)}`;
      } else if (keep.leftTime !== undefined) {
        // Left edge kept: the first bar at / after the old left-edge time
        // stays at the left edge, same bar spacing.
        let lo = 0;
        let hi = cx.raw.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if ((cx.raw[mid].time as number) < keep.leftTime) lo = mid + 1; else hi = mid; }
        const from = lo;
        ts.setVisibleLogicalRange({ from, to: from + barsSpan(ts.width(), keep.barSpacing) });
        framed = `keep-left bs=${keep.barSpacing.toFixed(2)} left=${keep.leftTime}`;
      } else {
        // A shorter history than the kept distance: its first bars stay in view.
        const ro = keep.symbol ? Math.max(keep.rightOffset, -(cx.raw.length - MIN_VISIBLE_BARS)) : keep.rightOffset;
        const to = cx.raw.length - 1 + ro;
        ts.setVisibleLogicalRange({ from: to - barsSpan(ts.width(), keep.barSpacing), to });
        framed = `keep bs=${keep.barSpacing.toFixed(2)} ro=${ro.toFixed(1)}`;
      }
      if (keep.symbol) cx.fitPriceScaleOnce();
    } else if (savedInBounds) {
      cx.chart.timeScale().setVisibleLogicalRange({ from: saved!.from, to: saved!.to });
      framed = `saved ${saved!.from.toFixed(0)}..${saved!.to.toFixed(0)}`;
    } else {
      // The daily family loads its full available history up-front, so frame the
      // most recent `view` bars (1D ≈ 1 year) with the rest preloaded behind, and
      // mark paging exhausted — scrolling back reveals already-loaded bars with no
      // network round-trip. Second/minute (rawDaily empty) keep lazy scroll-back.
      const view = initialViewBars(props.interval ?? "1D");
      // Transform types end the axis with their own last item, not at the
      // source bar count.
      let to = cx.raw.length;
      if (isTransformType(cx.activeType)) {
        const last = mainLastIndex();
        if (last != null) to = last + 1;
      }
      if (view !== null && cx.raw.length > view) {
        cx.chart.timeScale().setVisibleLogicalRange({ from: to - view, to });
      } else {
        cx.chart.timeScale().fitContent();
      }
      framed = view === null ? "all" : String(view);
    }
    if (cx.rawDaily.length > 0) cx.historyExhausted = true;
    cx.updateHistoryEnd();
    {
      const _r = cx.chart.timeScale().getVisibleLogicalRange();
      const now = performance.now();
      const e2e = loadStartMs ? ` | symbol-effect→paint ${(now - loadStartMs).toFixed(0)}ms` : "";
      const w = window as unknown as { __clickT?: number };
      const click = w.__clickT ? ` | SELECT→paint ${(now - w.__clickT).toFixed(0)}ms` : "";
      console.log(
        `[apply] ${props.symbol} ${props.interval}: set ${cx.raw.length} bars (view=${framed}), hostW=${cx.host.clientWidth}, range=${_r ? `${_r.from.toFixed(0)}..${_r.to.toFixed(0)}` : "null"}${e2e}${click}`,
      );
    }
    // This framing is not a user change: keep it off the tab links.
    cx.holdLinkQuiet();
    // New data is painted — end the transition (drop the dim, re-enable the
    // live poller).
    cx.swapping = false;
    // A date-range target that arrived while this pane was loading.
    if (cx.syncTarget) cx.scheduleSyncRun(0);
    // A linked time that arrived while this pane was loading.
    if (cx.pendingLinkTime !== null) {
      const t = cx.pendingLinkTime;
      cx.pendingLinkTime = null;
      void cx.goToTime(t);
    }
    if (!cx.crosshairActive) cx.refreshLegend();
    cx.refreshIndicatorLegend(cx.crosshairActive ? cx.lastLegendTime : undefined);
    // Warm a read-ahead window now so the first scroll-back doesn't wait on the
    // network (idempotent — startPrefetch dedupes the same gen + beforeSec).
    const firstOldest = (cx.rawDaily.length > 0 ? cx.rawDaily[0]?.time : cx.raw[0]?.time) as
      | number
      | undefined;
    if (firstOldest !== undefined)
      cx.startPrefetch(props.symbol ?? "", props.interval ?? "1D", cx.fetchGen, firstOldest);
    // Older years missing (the server could not be reached for them): read
    // them again until they come, while this dataset is still the one shown.
    if (real.partial) {
      const gen = cx.fetchGen;
      void cx.completeHistory(props.symbol ?? "", props.interval ?? "1D", props.session ?? "RTH", () => lastAppliedReal === real && cx.fetchGen === gen);
    }
  });

  // Dim-and-hold transition: rather than a spinner on a
  // blanked chart, keep the previous candles painted and fade a dim overlay over
  // them while the new symbol loads. Debounced ~160ms so cached/instant loads
  // never flash the overlay; only dim when there's an outgoing chart to hold.
  const [dimmed, setDimmed] = createSignal(false);
  let dimTimer = 0;
  createEffect(() => {
    if (history.loading) {
      clearTimeout(dimTimer);
      dimTimer = window.setTimeout(() => {
        if (cx.raw.length > 0) setDimmed(true);
      }, 160);
    } else {
      clearTimeout(dimTimer);
      setDimmed(false);
    }
  });
  onCleanup(() => clearTimeout(dimTimer));

  return {
    dimmed,
    setDimmed,
  };
}
