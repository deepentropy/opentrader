/*
 * Live bars of a chart view: the symbol's live slot, the merge of live bars
 * into the loaded series, the repaint (deferred while the tab is hidden), the
 * footprint sub-bars and the seconds REST refresh.
 */
import { createEffect, onCleanup, onMount } from "solid-js";
import { type UTCTimestamp } from "lightweight-charts";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  getBars,
  getSecondBarsTail,
  isIntradayInterval,
  isIntradayResolution,
  isSecondResolution,
  setLiveSymbol,
  subscribeBars,
  type LiveBar,
} from "../../../data/datafeed";
import { setDataForType, type OHLC } from "../chart-types";
import { toOHLC } from "./helpers";
import { type ChartCx } from "./context";

/** What createLive adds to the chart context. */
export interface LiveApi {
  liveAppendedWhileHidden: boolean;
  liveDirty: boolean;
  liveVolBase: {
    barTime: number;
    dayTime: number;
    base: number;
  } | null;
  paintLive: (next: OHLC | null, appended: boolean) => void;
  readonly subMinute: OHLC[] | null;
  withCrosshairParked: (fn: () => void) => void;
}

export function createLive(cx: ChartCx): LiveApi {
  const { afterSeriesData, currentTokens, dataExtras, hidden, history, onShownHooks, paneId, props, refreshIndicatorLegend, refreshLegend, updateSessionBreaks } = cx;
  /** Live bars merged while hidden and not drawn yet. */
  let liveDirty = false;
  let liveAppendedWhileHidden = false;

  // 1-minute sub-bars feeding the volume-footprint cells (fetched on demand
  // when that type is active on an intraday frame; null otherwise).
  let subMinute: OHLC[] | null = null;
  /** 1W/1M live-volume baseline: the forming bar's cumulative volume BEFORE the
   *  current trading day's ticks (the tick's day volume is added on top). Reset
   *  when the tick's day advances, the bar rolls over, or the series reloads. */
  let liveVolBase: { barTime: number; dayTime: number; base: number } | null = null;

  // ── Live ticks from the live feed ─────────────────────────────
  // Mirror the chart's `symbol` into the Rust WS task's subscription set,
  // under THIS pane's slot (multi-pane layouts each hold their own symbol).
  // The task diffs against its previous state and emits the minimal
  // subscribe/unsubscribe frames.
  createEffect(() => {
    const sym = props.symbol ?? null;
    setLiveSymbol(sym, String(paneId)).catch((e) => console.warn("[chart] setLiveSymbol failed:", e));
  });

  /** Merge one resolution-bucketed live bar (from the datafeed) into the
   *  chart's active bucket: extend the forming bar or append a new one.
   *
   *  Only candle/bar series get incremental updates this turn — the other
   *  chart types (line/area/baseline/Heikin-Ashi…) would need a per-type
   *  live-transform; tickets land in 3a-extras follow-ups. */
  /** Repaint after live-bar mutations: candle-family series take the cheap
   *  incremental `update`; every other type re-derives its per-type data from
   *  `raw` (line/area/HA/renko/… — a full setData at the 5s tick cadence is
   *  cheap and keeps ALL chart types live, not just candles). Studies + the
   *  legend recompute so indicators track the live bar; session breaks only
   *  need refreshing when a NEW bar appended (a day may have rolled over). */
  /** paintLive, or (hidden tab) remember that `raw` moved on and draw it
   *  once when the tab is shown. */
  function paintLiveOrDefer(next: OHLC | null, appended: boolean) {
    if (hidden()) {
      liveDirty = true;
      liveAppendedWhileHidden = liveAppendedWhileHidden || appended;
      return;
    }
    paintLive(next, appended);
  }
  /** Run `fn` (several series data changes) with the crosshair parked. While a
   *  crosshair is shown, each data change of the library re-runs its hit test,
   *  which rebuilds every changed series' points over ALL bars (05/10/2026,
   *  .tmp/scroll-lag: ~280 ms of a 400 ms live update on a 87k-bar pane).
   *  Put back at the same point afterwards, without crosshair events. */
  function withCrosshairParked(fn: () => void) {
    const at = cx.crosshairAt;
    if (!cx.chart || !cx.series || !at) {
      fn();
      return;
    }
    cx.chart.clearCrosshairPosition();
    try {
      fn();
    } finally {
      const s = cx.series;
      const price = s?.coordinateToPrice(at.y);
      if (cx.chart && s && price != null && cx.raw.length > 0 && at.time >= (cx.raw[0].time as number)) {
        try { cx.chart.setCrosshairPosition(price as number, at.time as UTCTimestamp, s); } catch { /* time no longer on the chart */ }
      }
    }
  }

  function paintLive(next: OHLC | null, appended: boolean) {
    withCrosshairParked(() => paintLiveData(next, appended));
  }
  function paintLiveData(next: OHLC | null, appended: boolean) {
    if (!cx.series) return;
    const st = currentTokens().styles;
    if (
      next &&
      // Per-bar colours (prev-close colouring, hollow candles) are computed
      // in setDataForType; a bare update() would paint the live bar with the
      // series-default colours.
      ((cx.activeType === "candle" && !st.candle.prevClose) || (cx.activeType === "bar" && !st.bar.prevClose))
    ) {
      // ISeriesApi<"Candlestick"|"Bar">.update accepts CandlestickData; our
      // OHLC is shape-compatible (time + o/h/l/c).
      (cx.series as { update: (d: OHLC) => void }).update(next);
    } else {
      setDataForType(cx.series, cx.activeType, cx.raw, currentTokens(), dataExtras());
      afterSeriesData();
    }
    // Recompute active studies against the mutated bars so indicator lines
    // track the live bar instead of lagging until the next reload.
    cx.controller?.renderAll(true);
    refreshIndicatorLegend(cx.crosshairActive ? cx.lastLegendTime : undefined);
    if (appended) { updateSessionBreaks(); cx.renderCompareAll(); }
    // A forming bar can push a new visible extreme without appending.
    else cx.updateHighLowLines();
    // Keep the legend on the latest bar unless the user is hovering one.
    if (!cx.crosshairActive) refreshLegend();
  }

  /** Merge one live bar into `raw`. Returns the merged bar + whether it
   *  appended (null = stale/ignored). `repaint=false` lets batch callers (the
   *  seconds refetch loop) merge many bars and paint once at the end. */
  function applyLiveBar(bar: LiveBar, repaint = true): { next: OHLC; appended: boolean } | null {
    // Mid-transition the outgoing symbol's candles are still painted; ignore
    // ticks (which are for the incoming symbol) until the swap completes.
    if (cx.swapping) return null;
    const lastTime = cx.raw.length > 0 ? (cx.raw[cx.raw.length - 1].time as number) : -1;
    let next: OHLC;
    let appended = false;
    let unchanged = false;
    if (lastTime === bar.time) {
      const last = cx.raw[cx.raw.length - 1];
      // Volume semantics per source: 1-minute buckets + 1D day bars carry the
      // bucket's authoritative cumulative volume → replace. 1W/1M ticks carry
      // TODAY'S day volume only, not the forming week/month's cumulative —
      // replacing would drop the prior days, so accumulate over a per-day
      // baseline (the bar's volume when the current day first ticked =
      // cumulative-before-today; re-snapped when the day advances). Coarser
      // intraday buckets only see the CURRENT minute's volume, so `max` keeps
      // the freshest value without double-counting the 5s snapshot repeats
      // (undercounts multi-minute buckets — the honest floor).
      const iv = props.interval ?? "1D";
      let vol: number;
      if (bar.volumeIsIncrement) {
        // A 1-second stream bar inside a wider seconds bucket: its volume is
        // that second only → add. The 30s REST tail merge (replace, below)
        // re-anchors the bucket to the authoritative total.
        vol = (last.volume ?? 0) + bar.volume;
      } else if (iv === "1" || iv === "1D" || isSecondResolution(iv)) {
        // Authoritative buckets: 1m/1D snapshots and the seconds tail refetch
        // both carry the bucket's full cumulative volume → replace. (Seconds
        // must NOT accumulate — every 30s tail merge would re-add the overlap.)
        vol = bar.volume;
      } else if (!isIntradayResolution(iv)) {
        const day = bar.dayTime ?? 0;
        if (!liveVolBase || liveVolBase.barTime !== bar.time || liveVolBase.dayTime !== day) {
          // Cold daily loads include today's PARTIAL bar in the aggregate;
          // subtract it so the baseline is strictly cumulative-before-today.
          // (The warm path excludes today, so the lookup simply misses.)
          const todaysPartial = cx.rawDaily.find((c) => (c.time as number) === day)?.volume ?? 0;
          liveVolBase = {
            barTime: bar.time,
            dayTime: day,
            base: Math.max(0, (last.volume ?? 0) - todaysPartial),
          };
        }
        vol = liveVolBase.base + bar.volume;
      } else {
        vol = Math.max(last.volume ?? 0, bar.volume);
      }
      next = {
        time: bar.time as UTCTimestamp,
        open: last.open,
        high: Math.max(last.high, bar.high),
        low: Math.min(last.low, bar.low),
        close: bar.close,
        volume: vol,
      };
      cx.raw[cx.raw.length - 1] = next;
      // The feed repeats a bar until it moves: nothing to repaint then.
      unchanged = next.high === last.high && next.low === last.low && next.close === last.close && next.volume === last.volume;
    } else if (bar.time > lastTime) {
      next = {
        time: bar.time as UTCTimestamp,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      };
      cx.raw.push(next);
      appended = true;
      // A fresh 1W/1M bar starts with today's volume only → baseline 0, so a
      // same-day merge tick doesn't re-snap the baseline onto today's volume
      // and double-count it.
      liveVolBase = { barTime: bar.time, dayTime: bar.dayTime ?? 0, base: 0 };
    } else {
      return null; // stale bar (older than last) — ignore
    }
    if (repaint && !unchanged) paintLiveOrDefer(next, appended);
    return { next, appended };
  }

  let unlistenAggregate: UnlistenFn | null = null;
  // Pane unmounted before the listen promise resolved — the late handle must
  // be released immediately or the Tauri listener leaks for the window's life.
  let aggregateDisposed = false;
  onMount(() => {
    // The datafeed filters by symbol and buckets by the current resolution;
    // accessors are read per-tick so the listener follows symbol/interval changes.
    subscribeBars(() => props.symbol, () => props.interval ?? "1D", applyLiveBar, () => props.session ?? "RTH").then((u) => {
      if (aggregateDisposed) { u(); return; }
      unlistenAggregate = u;
    });
  });

  // Volume footprint sub-bars: fetch the 1-minute window when the type is
  // active on an intraday frame (5 trading days — the datafeed's 1m lookback;
  // older bars render as plain candles). Cleared when the type/symbol moves on.
  createEffect(() => {
    const type = props.chartType ?? "candle";
    const sym = props.symbol;
    const id = props.interval ?? "1D";
    const sess = props.session ?? "RTH";
    subMinute = null;
    if (type !== "volFootprint" || !sym || !isIntradayInterval(id) || isSecondResolution(id)) return;
    let alive = true;
    const refresh = () => {
      getBars(sym, "1", sess)
        .then((r) => {
          if (!alive || (props.chartType ?? "candle") !== "volFootprint") return;
          subMinute = toOHLC(r.bars);
          if (cx.series && !cx.swapping) {
            setDataForType(cx.series, cx.activeType, cx.raw, currentTokens(), { ...dataExtras(), subMinute });
            afterSeriesData();
          }
        })
        .catch(() => { /* footprint stays candle-only on fetch failure */ });
    };
    refresh();
    // The forming bar's cells go stale between fetches (live ticks reuse the
    // cached sub-bars) — refresh on a 60s cadence while the type is active;
    // the effect re-runs on type/symbol/interval/session change, so the timer
    // follows the pane's state.
    let lastRefresh = Date.now();
    const timer = window.setInterval(() => {
      if (cx.swapping || hidden()) return;
      lastRefresh = Date.now();
      refresh();
    }, 60_000);
    // Hidden for a full cadence: refresh as soon as the tab is shown.
    const onShow = () => {
      if (cx.swapping || Date.now() - lastRefresh < 60_000) return;
      lastRefresh = Date.now();
      refresh();
    };
    onShownHooks.add(onShow);
    onCleanup(() => { alive = false; window.clearInterval(timer); onShownHooks.delete(onShow); });
  });

  // Seconds REST refresh. When the key is entitled to the 1-second stream,
  // live bars arrive through subscribeBars and this refetch re-anchors them to
  // the authoritative REST buckets; without the stream (or while it is
  // disconnected) this is the only live path — the per-minute snapshot
  // aggregate cannot form sub-minute bars. It refetches the TAIL (last ~10
  // minutes) on a cadence and merges it through the live-bar merge. A tail
  // that doesn't overlap the loaded series (gap — e.g. the app slept past the
  // tail window) falls back to the full 1-3 day window refetch.
  createEffect(() => {
    const sym = props.symbol;
    const id = props.interval ?? "1D";
    const sess = props.session ?? "RTH";
    if (!sym || !isSecondResolution(id)) return;
    const TAIL_SEC = 600;
    /** Batch-merge refreshed bars at/after `lastTime`, then paint ONCE
     *  (per-bar repaints would re-derive the series data dozens of times per
     *  poll). Full-redraw path (next=null) so every series type repaints. */
    const mergeRows = (rows: OHLC[], lastTime: number) => {
      let appendedAny = false;
      let merged = false;
      for (const b of rows) {
        if ((b.time as number) < lastTime) continue;
        const res = applyLiveBar(
          {
            time: b.time as number,
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
            volume: b.volume ?? 0,
          },
          false,
        );
        if (res) {
          merged = true;
          appendedAny = appendedAny || res.appended;
        }
      }
      if (merged) paintLiveOrDefer(null, appendedAny);
    };
    const stale = () => cx.swapping || sym !== props.symbol || id !== (props.interval ?? "1D");
    const fullRefetch = () =>
      getBars(sym, id, sess)
        .then((r) => {
          if (stale()) return;
          const lastTime = cx.raw.length > 0 ? (cx.raw[cx.raw.length - 1].time as number) : undefined;
          if (lastTime === undefined) return;
          mergeRows(toOHLC(r.bars), lastTime);
        })
        .catch(() => { /* transient fetch failure — next poll retries */ });
    const timer = window.setInterval(() => {
      if (cx.swapping || history.loading || cx.raw.length === 0) return;
      const lastTime = cx.raw[cx.raw.length - 1].time as number;
      const tail = getSecondBarsTail(sym, id, lastTime - TAIL_SEC, sess);
      if (!tail) return;
      tail
        .then((rows) => {
          if (stale()) return;
          const ohlc = toOHLC(rows);
          if (ohlc.length === 0) return; // nothing new (closed market) — skip
          // Overlap check: the tail must reach back to (or past) the loaded
          // series' newest bar, else there's a gap only a full window can fill.
          if ((ohlc[0].time as number) > lastTime) {
            void fullRefetch();
            return;
          }
          mergeRows(ohlc, lastTime);
        })
        .catch(() => { /* transient fetch failure — next poll retries */ });
    }, 30_000);
    onCleanup(() => clearInterval(timer));
  });
  onCleanup(() => {
    aggregateDisposed = true;
    unlistenAggregate?.();
    // Clear only THIS pane's slot — sibling panes keep their live symbols.
    setLiveSymbol(null, String(paneId)).catch(() => {});
  });

  return {
    get liveAppendedWhileHidden() {
      return liveAppendedWhileHidden;
    },
    set liveAppendedWhileHidden(v: typeof liveAppendedWhileHidden) {
      liveAppendedWhileHidden = v;
    },
    get liveDirty() {
      return liveDirty;
    },
    set liveDirty(v: typeof liveDirty) {
      liveDirty = v;
    },
    get liveVolBase() {
      return liveVolBase;
    },
    set liveVolBase(v: typeof liveVolBase) {
      liveVolBase = v;
    },
    paintLive,
    get subMinute() {
      return subMinute;
    },
    withCrosshairParked,
  };
}
