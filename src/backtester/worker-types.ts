import type { ChartContext } from 'oakscriptjs/script';
import type { BacktestReport, Bar, StrategyProperties, SymbolInfo } from './types';

export interface BacktestRequest {
  id: number;
  /** StrategyDefinition.key */
  strategy: string;
  bars: Bar[];
  inputs?: Record<string, unknown>;
  properties?: Partial<StrategyProperties>;
  symbol?: Partial<SymbolInfo>;
  /** Chart context of OakScript strategies (timeframe, session...); the ports ignore it. */
  chart?: ChartContext;
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
