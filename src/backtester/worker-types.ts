import type { ChartContext } from 'oakscriptjs/script';
import type { BacktestReport, Bar, StrategyProperties, SymbolInfo } from './types';

/** Bar magnifier series: `bars` rides once per worker and version; later requests carry the key and version only. */
export interface IntrabarsRef {
  key: string;
  version: number;
  /** Lower-timeframe interval id. */
  interval: string;
  bars?: Bar[];
}

export interface BacktestRequest {
  id: number;
  /** StrategyDefinition.key */
  strategy: string;
  bars: Bar[];
  inputs?: Record<string, unknown>;
  properties?: Partial<StrategyProperties>;
  symbol?: Partial<SymbolInfo>;
  /** Chart context (timeframe, session, realtime last bar...); the ports read `realtime` only. */
  chart?: ChartContext;
  /** Bar magnifier: the lower-timeframe series. `bars` is sent once per worker and version; later requests
   *  carry the key and version only (the worker keeps the bars). */
  intrabars?: IntrabarsRef;
  /** The chart shows Heikin Ashi bars of `bars` (strategy on them; fills too unless fill_orders_on_standard_ohlc). */
  heikinAshi?: boolean;
}

export interface BacktestError {
  message: string;
  /** The reference app runtime error code (e.g. RE10141) and bar, when the strategy stopped. */
  code?: string;
  bar?: number;
}

/** A finished run: the report, and the script's drawing output (plots, markers...) for OakScript strategies. */
export interface BacktestOutput {
  report: BacktestReport;
  visuals?: unknown;
}

export type BacktestResponse = ({ id: number; ok: true } & BacktestOutput) | { id: number; ok: false; error: BacktestError };
