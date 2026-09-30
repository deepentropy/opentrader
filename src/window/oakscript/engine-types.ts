/*
 * Message protocol between the OakScript engine host (engine.ts, main thread)
 * and the execution worker (oakscript-worker.ts). Everything crossing the
 * boundary is plain structured-cloneable data.
 */

/** Bar shape the worker feeds to `calculate` — oakscriptjs `Bar` (time in
 *  UNIX seconds, same as the app's `Candle`). */
export type OakBar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

/** A script failure, mapped back to user-source coordinates when the runtime
 *  exposed them (blob stack frames keep the original line numbers — the
 *  import rewrite preserves line structure). */
import type { ChartContext } from "oakscriptjs/script";
import type { BacktestReport, StrategyProperties } from "../../backtester/types";

export type OakScriptError = {
  message: string;
  line?: number;
  col?: number;
};

/** Declarative surface of a compiled script (the lightweight-charts-indicators
 *  convention), echoed back so the host can render legend/inputs without
 *  another round trip. Configs are passed through untyped — the chart layer
 *  owns their validation (phase 6). */
export type OakCompiledMeta = {
  title: string;
  shortTitle?: string;
  overlay: boolean;
  inputConfig?: unknown[];
  plotConfig?: unknown[];
  hlineConfig?: unknown[];
  fillConfig?: unknown[];
  // Tier 1 visual declarations (oakscriptjs 0.5.0): plotshape/plotchar and
  // bgcolor/barcolor config. Per-bar data rides on the run result; these carry
  // only the declarations (for legend/settings).
  shapeConfig?: unknown[];
  barColorConfig?: unknown[];
  /** plotarrow declarations (colors, min / max heights); the arrows ride in the run result. */
  arrowConfig?: unknown[];
  defaultInputs?: Record<string, unknown>;
  /** strategy() properties (oakscriptjs StrategyProperties) when the script
   *  declares a strategy: it then runs in the Strategy Tester. */
  strategy?: Record<string, unknown>;
};

/** A backtest failure: a script error, or a strategy runtime error (Pine
 *  code such as RE10141, with the bar it stopped on). */
export type OakBacktestError = OakScriptError & { code?: string; bar?: number };

export type OakRequest =
  | { id: number; type: "compile"; scriptId: string; source: string }
  | { id: number; type: "run"; scriptId: string; bars: OakBar[]; inputs?: Record<string, unknown>; chart?: ChartContext }
  | {
      id: number;
      type: "backtest";
      scriptId: string;
      bars: OakBar[];
      inputs?: Record<string, unknown>;
      /** Overrides of the script's strategy() properties. */
      properties?: Partial<StrategyProperties>;
      /** Chart context (timeframe, session...). */
      chart?: ChartContext;
    };

export type OakResponse =
  | { id: number; type: "compile"; ok: true; meta: OakCompiledMeta }
  | { id: number; type: "compile"; ok: false; error: OakScriptError }
  | { id: number; type: "run"; ok: true; result: unknown }
  | { id: number; type: "run"; ok: false; error: OakScriptError }
  | { id: number; type: "backtest"; ok: true; report: BacktestReport }
  | { id: number; type: "backtest"; ok: false; error: OakBacktestError };
