import type { ChartContext } from 'oakscriptjs/script';
import type { BacktestReport, Bar, StrategyProperties, SymbolInfo } from './types';
import type { OtherSymbolData } from './oakscript';
import type { LiveReply, LiveRequest } from './live-runs';

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
  /** Bars and properties of other symbols the script reads (OakScript strategies). */
  symbols?: OtherSymbolData;
  /** A strategy on a chart: the worker keeps its run, `bars` are the bars from `live.from` (see live-runs.ts). */
  live?: LiveRequest;
}

export interface BacktestError {
  message: string;
  /** The reference app runtime error code (e.g. RE10141) and bar, when the strategy stopped. */
  code?: string;
  bar?: number;
  /** The run needs bars of other symbols that were not given: load them and run again. */
  missing?: { symbol: string; timeframe: string }[];
}

/** A finished run: the report, and the script's drawing output (plots, markers...) for OakScript strategies. */
export interface BacktestOutput {
  report: BacktestReport;
  visuals?: unknown;
  /** A live run calculates every bar on each update, for this reason (null or absent: it does not). */
  fullRunReason?: string | null;
}

export type BacktestResponse =
  | ({ id: number; ok: true; live?: LiveReply } & Omit<BacktestOutput, 'fullRunReason'>)
  | { id: number; ok: false; error: BacktestError }
  /** A live request counts on bars the worker no longer has (a new worker, a run dropped): send them all again. */
  | { id: number; ok: false; resend: true; error: BacktestError };
