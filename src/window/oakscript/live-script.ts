/*
 * Worker side of a user script on a chart (#255): one run per study instance, kept with the bars it calculated. A
 * live update applies the changed bars and calls update() of the script's run (oakscriptjs createScriptRun), which
 * calculates the newest bars only when the script allows it, else every bar; the result is that of a full run.
 */
import { createScriptRun, type ChartContext, type ScriptRun } from "oakscriptjs/script";
import type { KeptRuns, LiveReply, LiveRequest } from "../../backtester/live-runs";
import { scriptBars, withChartTimes } from "../../backtester/oakscript";
import type { Bar } from "../../backtester/types";
import type { OakBar, OakSourceData, OakSymbolData } from "./engine-types";

export type UserModule = Record<string, unknown> & {
  calculate?: (bars: unknown[], inputs?: Record<string, unknown>, chart?: unknown) => unknown;
  __run?: () => void;
};

/** A compiled script: the script API (its body) or a module exporting calculate(). */
export type Compiled = { kind: "convention"; mod: UserModule } | { kind: "script"; run: () => void };

/** The run of a study instance: for one compiled script and one set of inputs. */
export type LiveScript = {
  entry: Compiled;
  inputs: string;
  /** null: a calculate() module, calculated on all the bars. */
  run: ScriptRun | null;
  /** The source values of the last update (study on study): a change before the forming bar is a new run. */
  sources: OakSourceData | undefined;
  /** Bars of other symbols of the last update, read through accessors that stay the same (a new accessor is another
   *  chart context: a full run). */
  symbols: OakSymbolData | undefined;
  barsOf: NonNullable<ChartContext["bars"]>;
  infoOf: NonNullable<ChartContext["symbolInfo"]>;
  /** The bars as the script reads them (daily bars at the session open) of the last update, null when not restamped. */
  seen: Bar[] | null;
  /** The copies on the chart's times of the plots' points sent before (withChartTimes). */
  chartTimes: WeakMap<object, object>;
};

/** A request of a live study (the fields of the worker's run request). */
export type LiveScriptRequest = {
  bars: OakBar[];
  inputs?: Record<string, unknown>;
  chart?: ChartContext;
  symbols?: OakSymbolData;
  sources?: OakSourceData;
  live: LiveRequest;
  /** Daily and longer chart bars: restamped here, the result put back on the chart's times. */
  restamp?: boolean;
};

/** The first `count` values of every source are the same in `a` and `b` (and they name the same sources). */
function sameSources(a: OakSourceData | undefined, b: OakSourceData | undefined, count: number): boolean {
  const ka = Object.keys(a ?? {});
  if (ka.length !== Object.keys(b ?? {}).length) return false;
  for (const k of ka) {
    const x = a![k];
    const y = b![k];
    if (!y) return false;
    for (let i = 0; i < count; i++) if (!Object.is(x[i], y[i])) return false;
  }
  return true;
}

function newLiveScript(entry: Compiled, inputs: Record<string, unknown>, inputsKey: string): LiveScript {
  const live: LiveScript = {
    entry,
    inputs: inputsKey,
    run: entry.kind === "script" ? createScriptRun(entry.run, inputs) : null,
    sources: undefined,
    symbols: undefined,
    barsOf: (s, tf) => live.symbols?.bars[`${s}|${tf}`],
    infoOf: (s) => live.symbols?.info[s],
    seen: null,
    chartTimes: new WeakMap(),
  };
  return live;
}

/** Why a calculate() module calculates every bar. */
const CONVENTION_REASON = "it exports calculate() instead of using the script API";

/**
 * Runs a study's request on its kept run: the result (as the changes from the host's result when the host has the
 * one before) and the live part of the reply. Null: the worker does not have the bars the request counts on.
 */
export function updateLiveScript(kept: KeptRuns<LiveScript>, entry: Compiled, req: LiveScriptRequest): { result: unknown; live: LiveReply } | null {
  const got = kept.bars(req.live, req.bars);
  if (!got) return null;
  const inputs = req.inputs ?? {};
  const inputsKey = JSON.stringify(inputs);
  const prev = got.kept;
  // The bars before the previous forming bar the update does not calculate again: their source values too.
  const same = prev && prev.run.entry === entry && prev.run.inputs === inputsKey && sameSources(prev.run.sources, req.sources, prev.bars.length - 1);
  const live = same ? prev.run : newLiveScript(entry, inputs, inputsKey);
  live.sources = req.sources;
  live.symbols = req.symbols;
  const chart: ChartContext = req.symbols ? { ...req.chart, bars: live.barsOf, symbolInfo: live.infoOf } : (req.chart ?? {});
  // Daily bars at the session open, as scripts read them: only the changed bars are restamped again.
  let seen = got.bars;
  if (req.restamp) {
    const from = same && live.seen ? Math.min(req.live.from, live.seen.length) : 0;
    const tail = scriptBars(got.bars.slice(from), req.chart);
    seen = from > 0 ? live.seen!.slice(0, from).concat(tail) : tail;
    live.seen = seen;
  }
  let result: unknown;
  try {
    if (live.run) {
      const run = live.run.update(seen as never[], chart);
      // The kinds of drawings this run created: the drawing rows of the Style settings.
      result = run.drawingKinds.length ? { ...run.result, drawingKinds: run.drawingKinds } : run.result;
    } else {
      result = (entry as Extract<Compiled, { kind: "convention" }>).mod.calculate!(seen, inputs, chart);
    }
    // Back on the chart's times, as a copy (the run keeps its points with the script's times for the next update).
    if (req.restamp && result && typeof result === "object") result = withChartTimes(result, seen, got.bars, live.chartTimes);
  } catch (err) {
    kept.drop(req.live.key);
    throw err;
  }
  return kept.keep(req.live, prev, got.bars, live, result, live.run ? live.run.fullRunReason : CONVENTION_REASON);
}
