/*
 * Strategies on a chart view: their filled orders as trade marks on the price
 * series, and the Settings dialog config of a strategy study.
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
import { PROPERTIES_INPUT, isStrategyId, strategyDefaults, strategyKeyOf, strategyStyleOf } from "../indicators/strategy-entries";
import { strategyTester } from "../../../data/strategy-tester-store";
import { type ChartCx } from "./context";

/** What createStrategyMarks adds to the chart context. */
export interface StrategyMarksApi {
  applyStrategyMarkers: () => void;
  forgetTradeMarkers: () => void;
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

  /** A rebuilt series took its trade marks with it: they are made again. */
  function forgetTradeMarkers() {
    tradeMarkersSeries = null;
    tradeMarkers = null;
  }

  return {
    applyStrategyMarkers,
    forgetTradeMarkers,
    strategyDialogConfig,
  };
}
