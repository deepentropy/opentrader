import { translateWith } from "../../../i18n/translator";
/*
 * Strategies on a chart view: their filled orders as trade marks on the price
 * series, and the Settings dialog config of a strategy study. The trade
 * journal's trades on the chart's symbol share the same marks.
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
import { createEffect } from "solid-js";
import { createSeriesMarkers, type ISeriesMarkersPluginApi, type SeriesMarker, type ISeriesApi, type Time } from "lightweight-charts";
import { cachedSymbolSessions } from "../../../data/session";
import { type StrategyDialogConfig } from "../IndicatorSettingsDialog";
import { DEFAULT_SYMBOL, type StrategyProperties } from "../../../backtester/types";
import { PROPERTIES_INPUT, hasHistoryTickOption, isStrategyId, strategyDefaults, strategyKeyOf, strategyStyleOf } from "../indicators/strategy-entries";
import { strategyTester } from "../../../data/strategy-tester-store";
import { tradeJournal, type JournalTrade } from "../../../data/trade-journal";
import { intervalSec } from "../../../data/trade-journal-calc";
import { type ChartCx } from "./context";
import { lastAtOrBefore } from "../time-search";

/** What createStrategyMarks adds to the chart context. */
export interface StrategyMarksApi {
  applyStrategyMarkers: () => void;
  forgetTradeMarkers: () => void;
  /** New bars (a symbol load, older history, a new bar): journal marks placed again. */
  syncJournalMarks: () => void;
  strategyDialogConfig: (id: string, inputs: Record<string, unknown>) => StrategyDialogConfig | undefined;
}

export function createStrategyMarks(cx: ChartCx): StrategyMarksApi {
  const { paneId, props } = cx;
  // Strategy trade marks on `series` (see applyStrategyMarkers).
  let tradeMarkers: ISeriesMarkersPluginApi<Time> | null = null;
  let tradeMarkersSeries: ISeriesApi<any> | null = null;

  // Strategies: filled orders as trade marks on the price series (the reference app:
  // buy = #2962ff arrow up below the bar, sell = #ff1744 arrow down above it,
  // with the order signal and the signed quantity).
  /** Settings dialog config of a strategy study: effective and script
   *  strategy() properties, trade-mark style, chart currency / interval /
   *  exchange time zone (the backtest's symbol defaults). */
  function strategyDialogConfig(id: string, inputs: Record<string, unknown>): StrategyDialogConfig | undefined {
    if (!isStrategyId(id)) return undefined;
    const defaults = strategyDefaults(id);
    if (!defaults) return undefined;
    const overrides = (inputs[PROPERTIES_INPUT] ?? {}) as Partial<StrategyProperties>;
    return {
      properties: { ...defaults, ...overrides },
      defaults,
      style: strategyStyleOf(inputs),
      chartCurrency: defaults.currency,
      interval: props.interval ?? "1D",
      chartStyle: props.chartType ?? "candle",
      historyTicks: hasHistoryTickOption(id),
      // The engine runs in the charted symbol's exchange zone (chart context).
      timeZone: cachedSymbolSessions(props.symbol ?? "")?.timeZone ?? DEFAULT_SYMBOL.timezone,
    };
  }
  function applyStrategyMarkers() {
    if (!cx.series) return;
    const marks: SeriesMarker<Time>[] = [];
    for (const id of (props.indicators ?? []).filter(isStrategyId)) {
      // Settings > Style: Trades on chart / Signal labels / Quantity; nothing
      // while the study is eye-hidden or off its Visibility intervals.
      const style = strategyStyleOf(cx.controller?.getInputs(id));
      if (!style.tradesOnChart || (cx.controller && !cx.controller.isDrawn(id))) continue;
      const report = strategyTester.run(String(paneId), strategyKeyOf(id))?.report;
      for (const o of report?.filledOrders ?? []) {
        const qty = style.quantity ? `${o.buy ? "+" : "−"}${o.qty}` : "";
        const signal = style.signalLabels ? o.comment : "";
        const text = (o.buy ? [signal, qty] : [qty, signal]).filter(Boolean).join(" ");
        marks.push(
          o.buy
            ? { time: (o.time / 1000) as Time, position: "belowBar", shape: "arrowUp", color: "#2962ff", text }
            : { time: (o.time / 1000) as Time, position: "aboveBar", shape: "arrowDown", color: "#ff1744", text },
        );
      }
    }
    marks.push(...journalMarks());
    marks.sort((a, b) => (a.time as number) - (b.time as number));
    if (tradeMarkersSeries !== cx.series) {
      tradeMarkers?.detach();
      tradeMarkers = marks.length ? createSeriesMarkers(cx.series, marks) : null;
      tradeMarkersSeries = tradeMarkers ? cx.series : null;
    } else tradeMarkers?.setMarkers(marks);
  }
  createEffect(() => {
    props.indicators;
    applyStrategyMarkers();
  });

  // Trade journal: the active journal's trades on this symbol, the selected
  // one labelled. A mark sits on the bar holding its time (a date-only trade:
  // the first bar of its day), so it moves with the interval.
  const journalTrades = () => tradeJournal.marksFor(props.symbol ?? "");
  /** Bar time holding `sec`: the last bar at or before it, or (`after`) the first at or after it. */
  function barTimeAt(sec: number, after: boolean): number | null {
    const raw = cx.raw;
    if (raw.length === 0) return null;
    // The bar at or before `sec`, else the first one.
    const lo = Math.max(0, lastAtOrBefore(raw, sec));
    const t = raw[lo].time as number;
    // Past the last bar (Bar Replay hides what follows): no bar holds it.
    if (lo === raw.length - 1 && sec >= t + intervalSec(props.interval ?? "1D")) return null;
    if (!after) return t <= sec ? t : null;
    const next = t >= sec ? t : lo + 1 < raw.length ? (raw[lo + 1].time as number) : null;
    // Not the same day: the loaded bars do not hold it.
    return next !== null && next - sec < 86400 ? next : null;
  }
  function journalMarks(): SeriesMarker<Time>[] {
    const out: SeriesMarker<Time>[] = [];
    const sel = tradeJournal.selectedId();
    const push = (t: JournalTrade, sec: number, buy: boolean, text: string) => {
      // A date on intraday bars: its first bar; on W / M bars: the bar holding it.
      const at = (t.dateOnly ? barTimeAt(sec, true) : null) ?? barTimeAt(sec, false);
      if (at === null) return;
      out.push(
        buy
          ? { time: at as Time, position: "belowBar", shape: "arrowUp", color: "#2962ff", text }
          : { time: at as Time, position: "aboveBar", shape: "arrowDown", color: "#ff1744", text },
      );
    };
    for (const t of journalTrades()) {
      const on = t.id === sel;
      const long = t.side === "long";
      const pct = t.calc ? ` ${t.calc.pnlPct >= 0 ? "+" : "−"}${Math.abs(t.calc.pnlPct * 100).toFixed(2)}%` : "";
      push(t, t.entryTime, long, on ? (long ? "Long" : "Short") : "");
      push(t, t.exitTime, !long, on ? translateWith("Exit{0}", pct) : "");
    }
    return out;
  }
  createEffect(() => {
    journalTrades();
    tradeJournal.selectedId();
    applyStrategyMarkers();
  });
  let journalKey = "";
  function syncJournalMarks() {
    // First and last bar: older history, a new bar, a Bar Replay step.
    const raw = cx.raw;
    const key = `${props.symbol}|${raw.length ? `${raw[0].time as number}-${raw[raw.length - 1].time as number}` : ""}`;
    if (key === journalKey) return;
    journalKey = key;
    if (journalTrades().length > 0) applyStrategyMarkers();
  }

  /** A rebuilt series took its trade marks with it: they are made again. */
  function forgetTradeMarkers() {
    tradeMarkersSeries = null;
    tradeMarkers = null;
  }

  return {
    applyStrategyMarkers,
    forgetTradeMarkers,
    syncJournalMarks,
    strategyDialogConfig,
  };
}
