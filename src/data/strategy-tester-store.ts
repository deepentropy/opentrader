/*
 * Strategy Tester state: the bottom panel (open / height / minimized, kv
 * persisted) and the backtest reports per chart. Reports are written by the
 * strategy registry entries (window/chart/indicators/strategy-entries.ts) when
 * the worker answers; the panel shows the report of the active chart's
 * strategy.
 */
import { createRoot, createSignal } from "solid-js";
import type { BacktestReport } from "../backtester/types";
import type { BacktestError } from "../backtester/worker-types";
import * as kv from "./kv";
import { oneOf, persisted } from "./persisted";

export type StrategyRunState = {
  status: "running" | "done" | "error";
  report: BacktestReport | null;
  error: BacktestError | null;
  /** Number of bars the report was computed on. */
  bars: number;
};

const HEIGHT_KEY = "ot:strategy-tester:height";
const COLLAPSED_KEY = "ot:strategy-tester:collapsed";
const VIEW_KEY = "ot:strategy-tester:view";
const EQUITY_KEY = "ot:strategy-tester:equity";

export type ReportView = "metrics" | "trades";

/** Performance chart settings (the reference app keeps them per user in
 *  localStorage: backtesting_overview_data_type / _equity_whitespace_mode /
 *  _widget_legend_collapsed / _overview_visibility). */
export type EquitySettings = {
  percent: boolean;
  whitespaces: boolean;
  legendCollapsed: boolean;
  visible: { pnl: boolean; buyHold: boolean; excursions: boolean; periods: boolean };
};
const DEFAULT_EQUITY: EquitySettings = {
  percent: false,
  whitespaces: false,
  legendCollapsed: false,
  visible: { pnl: true, buyHold: false, excursions: true, periods: true },
};
/** Stored settings over the defaults (a setting added later keeps its default). */
function parseEquity(raw: string): EquitySettings {
  const v = JSON.parse(raw) as Partial<EquitySettings> | null;
  return { ...DEFAULT_EQUITY, ...(v ?? {}), visible: { ...DEFAULT_EQUITY.visible, ...(v?.visible ?? {}) } };
}

export const strategyTester = createRoot(() => {
  /** Report content height (the 38 px footer bar excluded); 0 = default. */
  const [height, setHeightRaw] = createSignal(Number(kv.getItem(HEIGHT_KEY)) || 0);
  // The panel's state (minimized, height, view) belongs to each window; the
  // performance chart settings follow every window.
  const [collapsed, setCollapsed] = persisted(COLLAPSED_KEY, { parse: (raw) => raw === "1", format: (v) => (v ? "1" : "0"), default: false });
  const [maximized, setMaximized] = createSignal(false);
  const [view, setView] = persisted<ReportView>(VIEW_KEY, { parse: oneOf("metrics", "trades"), format: String, default: "metrics" });
  /** Chart id (ChartView pane id) of the active chart. */
  const [activeChartId, setActiveChartId] = createSignal<string | null>(null);
  const [equity, setEquity] = persisted(EQUITY_KEY, { parse: parseEquity, default: DEFAULT_EQUITY, sync: true });
  /** Performance chart expanded over the whole report (Expand chart). */
  const [equityExpanded, setEquityExpanded] = createSignal(false);
  // Reports stay plain objects (no store proxies over thousands of trades);
  // `version` makes readers reactive.
  const runs = new Map<string, StrategyRunState>();
  const [version, setVersion] = createSignal(0);
  const k = (chartId: string, key: string) => `${chartId}|${key}`;

  return {
    height,
    setHeight(px: number, commit: boolean) {
      setHeightRaw(px);
      if (commit) kv.setItem(HEIGHT_KEY, String(Math.round(px)));
    },
    collapsed,
    setCollapsed,
    maximized,
    setMaximized,
    view,
    setView,
    activeChartId,
    setActiveChartId,
    equity,
    patchEquity(patch: Partial<EquitySettings>) {
      const next = { ...equity(), ...patch, visible: { ...equity().visible, ...(patch.visible ?? {}) } };
      setEquity(next);
    },
    equityExpanded,
    setEquityExpanded,
    /** Reactive read of one chart's run of one strategy. */
    run(chartId: string | null, key: string): StrategyRunState | undefined {
      version();
      return chartId ? runs.get(k(chartId, key)) : undefined;
    },
    setRun(chartId: string, key: string, state: StrategyRunState) {
      runs.set(k(chartId, key), state);
      setVersion((v) => v + 1);
    },
    dropChart(chartId: string) {
      for (const key of [...runs.keys()]) if (key.startsWith(`${chartId}|`)) runs.delete(key);
      setVersion((v) => v + 1);
    },
  };
});
