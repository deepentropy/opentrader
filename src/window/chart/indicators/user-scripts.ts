/*
 * user-scripts — bridges kv-stored OakScript indicators into the indicator
 * registry as dynamic entries with id `user:<scriptId>`. registry.ts routes
 * those ids here, so the whole existing pipeline (controller, layer, settings
 * dialog, legend, object tree, alerts) treats a user script like any shipped
 * indicator.
 *
 * The pipeline calls `entry.calculate(bars, inputs)` synchronously, but user
 * code runs in the execution worker. The adapter closes the gap with a
 * stale-while-revalidate cache: calculate() returns the last worker result
 * immediately and, when the staleness key (bars tip + inputs) has moved,
 * schedules an async worker run; a fresh result fires OAKSCRIPT_UPDATED_EVENT
 * and ChartView re-renders — now hitting the cache. Runs are serialized per
 * script (a newer request supersedes a queued one), so a live-tick burst
 * costs at most one in-flight run plus one queued.
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
import type { OakBar, OakCompiledMeta } from "../../oakscript/engine-types";

export const USER_INDICATOR_PREFIX = "user:";
export const OAKSCRIPT_UPDATED_EVENT = "oakscript-script-updated";

export type OakScriptUpdatedDetail = { scriptId: string; structural: boolean };

export function isUserIndicatorId(id: string): boolean {
  return id.startsWith(USER_INDICATOR_PREFIX);
}

export function userIndicatorId(scriptId: string): string {
  return USER_INDICATOR_PREFIX + scriptId;
}

const EMPTY_RESULT = { metadata: { title: "", overlay: true }, plots: {} };

type QueuedRun = { bars: OakBar[]; inputs: Record<string, unknown>; chart: ChartContext | undefined; key: string };

type Runtime = {
  entry: IndicatorRegistryEntry;
  /** Staleness key `result` was computed for (null = nothing computed). */
  key: string | null;
  result: unknown | null;
  running: boolean;
  queued: QueuedRun | null;
  /** Worker generation this script was compiled in (-1 = not compiled); the
   *  compile cache dies with the worker. */
  compiledGen: number;
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
  window.dispatchEvent(
    new CustomEvent<OakScriptUpdatedDetail>(OAKSCRIPT_UPDATED_EVENT, {
      detail: { scriptId, structural },
    }),
  );
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
  e.defaultInputs = meta?.defaultInputs ?? {};
}

async function runInWorker(
  rt: Runtime,
  scriptId: string,
  bars: OakBar[],
  inputs: Record<string, unknown>,
  chart: ChartContext | undefined,
  key: string,
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
    rt.result = await engine.run(scriptId, bars, inputs, chart);
    rt.key = key;
  } catch (err) {
    // Cache the failure under this key too — otherwise every render would
    // re-schedule a doomed run in a hot loop.
    rt.result = null;
    rt.key = key;
    console.warn(`[oakscript] "${scriptId}" run failed:`, err instanceof Error ? err.message : err);
  } finally {
    rt.running = false;
    const next = rt.queued;
    rt.queued = null;
    if (next && next.key !== rt.key) {
      rt.running = true;
      void runInWorker(rt, scriptId, next.bars, next.inputs, next.chart, next.key);
    } else {
      dispatchUpdated(scriptId, false);
    }
  }
}

function makeCalculate(scriptId: string): IndicatorRegistryEntry["calculate"] {
  return (bars: unknown, inputs?: unknown, ctx?: unknown) => {
    const rt = runtimes.get(scriptId);
    if (!rt) return EMPTY_RESULT;
    const typedBars = bars as OakBar[];
    const typedInputs = (inputs ?? {}) as Record<string, unknown>;
    const chart = (ctx as { chart?: ChartContext } | undefined)?.chart;
    const key = `${stalenessKey(typedBars, typedInputs)}:${JSON.stringify(chart ?? null)}`;
    if (rt.key !== key) {
      // Snapshot the array (ChartView mutates `raw` in place on live ticks).
      const snapshot = typedBars.slice();
      if (rt.running) {
        rt.queued = { bars: snapshot, inputs: typedInputs, chart, key };
      } else {
        rt.running = true;
        void runInWorker(rt, scriptId, snapshot, typedInputs, chart, key);
      }
    }
    return rt.result ?? EMPTY_RESULT;
  };
}

/** Resolve `user:<scriptId>` to its dynamic registry entry (undefined when
 *  the script was deleted). Called by registry.getIndicatorEntry. */
export function getUserIndicatorEntry(id: string): IndicatorRegistryEntry | undefined {
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
  runtimes.set(scriptId, { entry, key: null, result: null, running: false, queued: null, compiledGen: -1 });
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
  rt.key = null; // force a fresh run on the next render
  rt.result = null; // old plots may not match the new plotConfig
  dispatchUpdated(scriptId, structural);
}
