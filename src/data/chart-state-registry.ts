/*
 * Chart-state registry — a narrow bridge that exposes per-symbol chart state
 * which otherwise lives trapped inside ChartView's closure (the latest bar and
 * the active indicators' current plot values).
 *
 * The alert engine (data/alert-engine.ts) needs these to evaluate indicator
 * conditions ("SMA crossing price") and to know a charted symbol's latest
 * price. ChartView registers a provider for its symbol on mount / symbol
 * change and unregisters on cleanup.
 *
 * Drawing operands are NOT here: drawings persist to localStorage per symbol
 * (window/drawings/persistence.ts), so the engine reads them directly and this
 * registry stays limited to the closure-only state.
 *
 * Indicator alerts therefore only evaluate while the symbol is charted — the
 * indicator values are computed by the chart. That's an accepted limit of the
 * frontend-first engine; price/drawing alerts have no such requirement.
 */
import type { IndicatorLegendRow } from "../window/chart/indicators/indicator-controller";

export type ChartStateProvider = {
  /** Latest bar close for this symbol, or null when no bars are loaded. */
  lastPrice: () => number | null;
  /** Open epoch ms of the latest (in-progress) bar, or null. */
  lastBarTime: () => number | null;
  /** Active indicator legend rows valued at the latest bar. */
  indicatorLegend: () => IndicatorLegendRow[];
};

const providers = new Map<string, ChartStateProvider>();

export function registerChartState(symbol: string, p: ChartStateProvider): void {
  providers.set(symbol.toUpperCase(), p);
}

export function unregisterChartState(symbol: string): void {
  providers.delete(symbol.toUpperCase());
}

/** Indicator legend rows for a symbol, or [] when it isn't charted. */
export function indicatorLegendFor(symbol: string): IndicatorLegendRow[] {
  return providers.get(symbol.toUpperCase())?.indicatorLegend() ?? [];
}

/** A single indicator plot value (`plot` = plotConfig index), or null when
 *  the study / plot / symbol is absent or the plot is hidden. */
export function indicatorPlotValue(
  symbol: string,
  indicatorId: string,
  plot = 0,
): number | null {
  const rows = indicatorLegendFor(symbol);
  const row = rows.find((r) => r.id === indicatorId);
  const v = row?.plots.find((p) => p.index === plot)?.value;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Latest charted price for a symbol, or null when it isn't charted. */
export function chartLastPrice(symbol: string): number | null {
  return providers.get(symbol.toUpperCase())?.lastPrice() ?? null;
}

/** Latest charted bar-open time (epoch ms) for a symbol, or null. */
export function chartLastBarTime(symbol: string): number | null {
  return providers.get(symbol.toUpperCase())?.lastBarTime() ?? null;
}
