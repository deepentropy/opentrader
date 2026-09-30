import type { BacktestReport, Bar, StrategyProperties, SymbolInfo } from './types';

export interface BacktestRequest {
  id: number;
  /** StrategyDefinition.key */
  strategy: string;
  bars: Bar[];
  inputs?: Record<string, unknown>;
  properties?: Partial<StrategyProperties>;
  symbol?: Partial<SymbolInfo>;
}

export interface BacktestError {
  message: string;
  /** TradingView runtime error code (e.g. RE10141) and bar, when the strategy stopped. */
  code?: string;
  bar?: number;
}

export type BacktestResponse = { id: number; ok: true; report: BacktestReport } | { id: number; ok: false; error: BacktestError };
