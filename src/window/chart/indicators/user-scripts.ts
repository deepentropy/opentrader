/*
 * user-scripts — bridges kv-stored OakScript indicators into the indicator
 * registry as dynamic entries with id `user:<scriptId>`. registry.ts routes
 * those ids here, so the whole existing pipeline (controller, layer, settings
 * dialog, legend, object tree, alerts) treats a user script like any shipped
 * indicator.
 *
 * The pipeline calls `entry.calculate(bars, inputs, context)` synchronously, but user
 * code runs in the execution worker. The adapter closes the gap with a
 * stale-while-revalidate cache: calculate() returns the last worker result
 * immediately and, when the staleness key (bars tip + inputs) has moved,
 * schedules an async worker run; a fresh result fires OAKSCRIPT_UPDATED_EVENT
 * and ChartView re-renders — now hitting the cache. Runs are serialized per
 * study instance on a chart (a newer request supersedes a queued one), so a
 * live-tick burst costs at most one in-flight run plus one queued. Each
 * instance keeps its own result: two instances (or two charts) of a script
 * with different inputs or bars do not overwrite each other.
 *
 * One entry OBJECT per script, mutated in place on recompile — every layer
 * re-reads plotConfig etc. from the entry on render, so non-structural shape
 * changes apply on the next render. An overlay flip is structural (the pane
 * assignment is fixed at add time) and is flagged so ChartView refresh()es
 * the study instead.
 */
import type { IndicatorRegistryEntry } from "lightweight-charts-indicators";
import type { ChartContext } from "oakscriptjs/script";
import * as scripts from "../../../data/oakscript-store";
import { getOakEngine, OakEngineError } from "../../oakscript/engine";
import type { OakBar, OakCompiledMeta, OakSourceData, OakSymbolData } from "../../oakscript/engine-types";
import { BUILTIN_SOURCES, externalSource } from "oakscriptjs";
import type { StudyCalcContext } from "./indicator-layer";
import { typeIdOf } from "./study-id";
import { emitAppEvent, type AppEvents } from "../../../data/app-events";

export const USER_INDICATOR_PREFIX = "user:";
export const OAKSCRIPT_UPDATED_EVENT = "oakscript-script-updated" as const;

export type OakScriptUpdatedDetail = AppEvents[typeof OAKSCRIPT_UPDATED_EVENT];

export function isUserIndicatorId(id: string): boolean {
  return id.startsWith(USER_INDICATOR_PREFIX);
}

export function userIndicatorId(scriptId: string): string {
  return USER_INDICATOR_PREFIX + scriptId;
}

/** Window event: open an OakScript in the editor panel ({ scriptId }). */
export const OAKSCRIPT_OPEN_EVENT = "oakscript-open-script" as const;

/** Script of a study on the chart (an OakScript indicator "user:<id>" or
 *  strategy "strategy:user:<id>", any instance), else null. */
export function scriptIdOfStudy(studyId: string): string | null {
  const id = typeIdOf(studyId);
  if (id.startsWith(USER_INDICATOR_PREFIX)) return id.slice(USER_INDICATOR_PREFIX.length);
  if (id.startsWith("strategy:" + USER_INDICATOR_PREFIX)) return id.slice(("strategy:" + USER_INDICATOR_PREFIX).length);
  return null;
}

const EMPTY_RESULT = { metadata: { title: "", overlay: true }, plots: {} };
/** What calculate() returns while the study waits for its first result (worker run, other symbols' bars): the chart
 *  shows the study as loading. */
const PENDING_RESULT = { ...EMPTY_RESULT, pending: true };

type QueuedRun = { bars: OakBar[]; inputs: Record<string, unknown>; chart: ChartContext | undefined; symbols: OakSymbolData | undefined; sources?: OakSourceData; key: string };

/** Run state of one study instance on one chart. */
type Run = {
  /** Staleness key `result` was computed for (null = nothing computed). */
  key: string | null;
  result: unknown | null;
  running: boolean;
  queued: QueuedRun | null;
  /** Bars of other symbols the script asked for (`request.security`): given with every run. */
  requests: { symbol: string; timeframe: string }[];
  /** Message of the failed run for `key` (null = it did not fail). */
  error: string | null;
};

type Runtime = {
  entry: IndicatorRegistryEntry;
  /** Worker generation this script was compiled in (-1 = not compiled); the
   *  compile cache dies with the worker. */
  compiledGen: number;
  /** Runs by `${chartId}|${studyId}`. */
  runs: Map<string, Run>;
};

const runtimes = new Map<string, Runtime>();

/** Cheap change detector: history loads/prepends move length, live ticks move
 *  the tip's time/close, settings move the inputs. */
function stalenessKey(bars: OakBar[], inputs: Record<string, unknown>): string {
  const last = bars[bars.length - 1];
  const first = bars[0];
  return `${bars.length}:${first?.time}:${last?.time}:${last?.close}:${JSON.stringify(inputs)}`;
}

function dispatchUpdated(scriptId: string, structural: boolean): void {
  emitAppEvent(OAKSCRIPT_UPDATED_EVENT, { scriptId, structural });
}

/** Mutate the shared entry object to the given compiled meta (or the stored
 *  fallback when a script has never compiled). */
function applyMeta(entry: IndicatorRegistryEntry, name: string, meta: OakCompiledMeta | undefined): void {
  const e = entry as unknown as Record<string, unknown>;
  e.name = name;
  e.shortName = meta?.shortTitle ?? name;
  e.overlay = meta?.overlay ?? true;
  e.metadata = {
    title: meta?.title ?? name,
    shortTitle: meta?.shortTitle ?? name,
    overlay: meta?.overlay ?? true,
  };
  e.inputConfig = meta?.inputConfig ?? [];
  e.plotConfig = meta?.plotConfig ?? [];
  e.hlineConfig = meta?.hlineConfig;
  e.fillConfig = meta?.fillConfig;
  e.shapeConfig = meta?.shapeConfig;
  e.barColorConfig = meta?.barColorConfig;
  e.arrowConfig = meta?.arrowConfig;
  e.plotCandleConfig = meta?.candleConfig;
  e.markerDrawing = meta?.markerDrawing;
  // Kinds seen in the runs stay (the declaration run makes no drawing: the kinds come with the results).
  e.drawingKinds = [...new Set([...((e.drawingKinds as string[] | undefined) ?? []), ...(meta?.drawingKinds ?? [])])];
  e.outputs = meta?.outputs;
  e.defaultInputs = meta?.defaultInputs ?? {};
  e.alertConditions = meta?.alertConditions;
  e.hasAlertFunction = meta?.hasAlertFunction;
}

async function runInWorker(
  rt: Runtime,
  run: Run,
  scriptId: string,
  bars: OakBar[],
  inputs: Record<string, unknown>,
  chart: ChartContext | undefined,
  symbols: OakSymbolData | undefined,
  key: string,
  sources?: OakSourceData,
): Promise<void> {
  const engine = getOakEngine();
  try {
    if (rt.compiledGen !== engine.generation) {
      const script = scripts.loadScript(scriptId);
      if (!script) throw new OakEngineError({ message: "Script no longer exists." });
      const meta = await engine.compile(scriptId, script.source);
      rt.compiledGen = engine.generation;
      scripts.saveCompiledMeta(scriptId, meta);
      applyMeta(rt.entry, script.name, meta);
    }
    run.result = await engine.run(scriptId, bars, inputs, chart, symbols, sources);
    noteDrawingKinds(rt.entry, run.result);
    run.key = key;
    run.error = null;
  } catch (err) {
    const missing = err instanceof OakEngineError ? err.detail.missing : undefined;
    if (missing?.length) {
      // The script reads other symbols: ask the chart for them and run again once they are loaded.
      for (const m of missing) {
        if (!run.requests.some((r) => r.symbol === m.symbol && r.timeframe === m.timeframe)) run.requests.push(m);
      }
      run.key = null;
      return;
    }
    // Cache the failure under this key too — otherwise every render would
    // re-schedule a doomed run in a hot loop.
    run.result = null;
    run.key = key;
    run.error = err instanceof Error ? err.message : String(err);
    console.warn(`[oakscript] "${scriptId}" run failed:`, err instanceof Error ? err.message : err);
  } finally {
    run.running = false;
    const next = run.queued;
    run.queued = null;
    if (next && next.key !== run.key) {
      run.running = true;
      void runInWorker(rt, run, scriptId, next.bars, next.inputs, next.chart, next.symbols, next.key, next.sources);
    } else {
      dispatchUpdated(scriptId, false);
    }
  }
}

/** The kinds of drawings a run created join the entry's (the Style tab lists one row per kind). */
function noteDrawingKinds(entry: IndicatorRegistryEntry, result: unknown): void {
  const kinds = (result as { drawingKinds?: string[] } | null)?.drawingKinds;
  if (!kinds?.length) return;
  const e = entry as unknown as { drawingKinds?: string[] };
  const have = new Set(e.drawingKinds ?? []);
  if (kinds.every((k) => have.has(k))) return;
  e.drawingKinds = [...new Set([...have, ...kinds])];
}

function makeCalculate(scriptId: string): IndicatorRegistryEntry["calculate"] {
  return (bars: unknown, inputs?: unknown, ctx?: unknown) => {
    const rt = runtimes.get(scriptId);
    if (!rt) return EMPTY_RESULT;
    const typedBars = bars as OakBar[];
    const typedInputs = (inputs ?? {}) as Record<string, unknown>;
    // The chart context without the app's own fields and the accessors (functions do not cross to the worker: the
    // lower-timeframe bars and chart events accessors of the profile studies neither).
    const { chartId, studyId, heikinAshi: _heikinAshi, bars: symbolBars, symbolInfo, ...withFns } = (ctx ?? {}) as Partial<StudyCalcContext>;
    const chart = Object.fromEntries(Object.entries(withFns).filter(([, v]) => typeof v !== "function")) as typeof withFns;
    const runKey = `${chartId ?? ""}|${studyId ?? ""}`;
    let run = rt.runs.get(runKey);
    if (!run) rt.runs.set(runKey, (run = { key: null, result: null, running: false, queued: null, requests: [], error: null }));
    // Bars of the other symbols the script reads: read on every calculation (the chart loads them and keeps
    // them while a study reads them); one not loaded yet holds the run until it arrives.
    let symbols: OakSymbolData | undefined;
    let symbolsKey = "";
    if (run.requests.length) {
      symbols = { bars: {}, info: {} };
      for (const r of run.requests) {
        const b = symbolBars?.(r.symbol, r.timeframe);
        if (b === undefined) return run.result ?? PENDING_RESULT;
        symbols.bars[`${r.symbol}|${r.timeframe}`] = b;
        const info = symbolInfo?.(r.symbol);
        if (info) symbols.info[r.symbol] = info;
        const last = b[b.length - 1];
        symbolsKey += `|${r.symbol}:${r.timeframe}:${b.length}:${b[0]?.time}:${last?.time}:${last?.close}:${last?.volume}`;
      }
    }
    // Source inputs naming another source of the chart (study on study): its values, read now (the chart's
    // resolver is set around this call) and sent with the run.
    let sources: OakSourceData | undefined;
    let sourcesKey = "";
    for (const v of Object.values(typedInputs)) {
      if (typeof v !== "string" || BUILTIN_SOURCES.has(v)) continue;
      const values = externalSource(v);
      if (!values) continue;
      const arr = Array.from(values);
      (sources ??= {})[v] = arr;
      sourcesKey += `|${v}:${arr.length}:${arr[arr.length - 1]}:${arr.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0)}`;
    }
    const key = `${stalenessKey(typedBars, typedInputs)}:${JSON.stringify(chart)}${symbolsKey}${sourcesKey}`;
    if (run.key !== key) {
      // Snapshot the array (ChartView mutates `raw` in place on live ticks).
      const snapshot = typedBars.slice();
      if (run.running) {
        run.queued = { bars: snapshot, inputs: typedInputs, chart, symbols, sources, key };
      } else {
        run.running = true;
        void runInWorker(rt, run, scriptId, snapshot, typedInputs, chart, symbols, key, sources);
      }
    }
    // The run for these bars and inputs failed: the chart shows the error with the study.
    if (run.error !== null && run.key === key) throw new Error(run.error);
    return run.result ?? (run.key === key ? EMPTY_RESULT : PENDING_RESULT);
  };
}

/** Resolve `user:<scriptId>` to its dynamic registry entry (undefined when
 *  the script was deleted). Called by registry.getIndicatorEntry. */
export function getUserIndicatorEntry(id: string): IndicatorRegistryEntry | undefined {
  // `id` is a type id (registry.getIndicatorEntry drops the instance suffix).
  if (!isUserIndicatorId(id)) return undefined;
  const scriptId = id.slice(USER_INDICATOR_PREFIX.length);
  const existing = runtimes.get(scriptId);
  if (existing) return existing.entry;

  const script = scripts.loadScript(scriptId);
  if (!script) return undefined;
  const entry = {
    id,
    group: "community",
    category: "Trend",
    calculate: makeCalculate(scriptId),
  } as unknown as IndicatorRegistryEntry;
  applyMeta(entry, script.name, script.meta);
  runtimes.set(scriptId, { entry, compiledGen: -1, runs: new Map() });
  return entry;
}

/** Editor-side hook: a script was renamed — refresh the entry's display name
 *  (dialog rows, object tree). The legend keeps showing the script-declared
 *  metadata title. */
export function notifyScriptRenamed(scriptId: string): void {
  const rt = runtimes.get(scriptId);
  if (!rt) return;
  const script = scripts.loadScript(scriptId);
  if (!script) return;
  applyMeta(rt.entry, script.name, script.meta);
  dispatchUpdated(scriptId, false);
}

/** Editor-side hook: a script was deleted — drop its cached runtime so the
 *  registry stops resolving `user:<scriptId>` (charts skip unknown ids). */
export function dropUserScriptRuntime(scriptId: string): void {
  runtimes.delete(scriptId);
}

/** Editor-side hook: the panel compiled `scriptId` (after a save). Persists
 *  the fresh meta, invalidates the cached result and tells charts to redraw
 *  — structurally when the overlay flag flipped (pane move). */
export function notifyScriptCompiled(scriptId: string, meta: OakCompiledMeta): void {
  scripts.saveCompiledMeta(scriptId, meta);
  const rt = runtimes.get(scriptId);
  if (!rt) return; // not on any chart — nothing to redraw
  const structural = (rt.entry.overlay ?? true) !== meta.overlay;
  const script = scripts.loadScript(scriptId);
  applyMeta(rt.entry, script?.name ?? meta.title, meta);
  rt.compiledGen = getOakEngine().generation; // same shared worker the panel compiled on
  for (const run of rt.runs.values()) {
    run.key = null; // force a fresh run on the next render
    run.result = null; // old plots may not match the new plotConfig
  }
  dispatchUpdated(scriptId, structural);
}
