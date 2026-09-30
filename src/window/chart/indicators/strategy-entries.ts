/*
 * strategy-entries — the backtester's strategy ports as registry entries with
 * id `strategy:<key>`. registry.ts routes those ids here, so a strategy is
 * added, persisted, listed in the legend and recomputed (load, history
 * paging, live bars) by the same pipeline as any indicator.
 *
 * OakScript strategies (editor panel scripts that declare strategy()) use the
 * same pipeline with key `user:<scriptId>` (id `strategy:user:<scriptId>`):
 * they run in the OakScript worker through the backtester's oakscriptjs
 * adapter (backtester/oakscript.ts) instead of the backtest worker.
 *
 * `calculate(bars, inputs, { chartId })` is synchronous; the backtest runs in
 * a worker. Same stale-while-revalidate scheme as user-scripts.ts, but the
 * cache is per chart AND strategy (a report belongs to one chart's bars):
 * calculate() returns the last result and schedules a run when the bars or
 * inputs moved; the worker's answer is published to the Strategy Tester store
 * and STRATEGY_UPDATED_EVENT makes that chart re-render.
 */
import type { IndicatorRegistryEntry } from "lightweight-charts-indicators";
import type { StrategyProperties as ScriptStrategyProperties } from "oakscriptjs/script";
import { BacktestFailed, getBacktestClient } from "../../../backtester/client";
import { brokerProperties } from "../../../backtester/oakscript";
import { STRATEGIES } from "../../../backtester/strategies";
import { DEFAULT_PROPERTIES, type BacktestReport, type Bar, type StrategyProperties } from "../../../backtester/types";
import type { BacktestError } from "../../../backtester/worker-types";
import * as scripts from "../../../data/oakscript-store";
import { strategyTester } from "../../../data/strategy-tester-store";
import { getOakEngine, OakEngineError } from "../../oakscript/engine";
import type { OakCompiledMeta } from "../../oakscript/engine-types";

export const STRATEGY_PREFIX = "strategy:";
/** Study input key holding the strategy() property overrides (initial capital...). */
export const PROPERTIES_INPUT = "__properties";
/** Study input key holding the Settings > Style options (trade marks only, no rerun). */
export const STYLE_INPUT = "__style";
export type StrategyStyle = { tradesOnChart: boolean; signalLabels: boolean; quantity: boolean };
export const DEFAULT_STRATEGY_STYLE: StrategyStyle = { tradesOnChart: true, signalLabels: true, quantity: true };
export function strategyStyleOf(inputs: Record<string, unknown> | null | undefined): StrategyStyle {
  return { ...DEFAULT_STRATEGY_STYLE, ...((inputs?.[STYLE_INPUT] as Partial<StrategyStyle> | undefined) ?? {}) };
}
export const STRATEGY_UPDATED_EVENT = "strategy-report-updated";
export type StrategyUpdatedDetail = { chartId: string; key: string };

export const isStrategyId = (id: string): boolean => id.startsWith(STRATEGY_PREFIX);
export const strategyId = (key: string): string => STRATEGY_PREFIX + key;
export const strategyKeyOf = (id: string): string => id.slice(STRATEGY_PREFIX.length);

/** OakScript strategies: key `user:<scriptId>`, id `strategy:user:<scriptId>`. */
const USER_KEY_PREFIX = "user:";
export const userStrategyId = (scriptId: string): string => strategyId(USER_KEY_PREFIX + scriptId);
const userScriptIdOf = (key: string): string | null => (key.startsWith(USER_KEY_PREFIX) ? key.slice(USER_KEY_PREFIX.length) : null);

const EMPTY_RESULT = { metadata: { title: "", overlay: true }, plots: {} };

type Runtime = {
  /** Staleness key of the last requested run. */
  key: string | null;
  running: boolean;
  queued: { bars: Bar[]; inputs: Record<string, unknown>; key: string } | null;
};

const runtimes = new Map<string, Runtime>();
const entries = new Map<string, IndicatorRegistryEntry>();

function stalenessKey(bars: Bar[], inputs: Record<string, unknown>): string {
  const last = bars[bars.length - 1];
  return `${bars.length}:${bars[0]?.time}:${last?.time}:${last?.close}:${last?.high}:${last?.low}:${JSON.stringify(inputs)}`;
}

/** Runs one backtest: resolves with the report, or null when a newer run superseded it. */
type Execute = (
  channel: string,
  bars: Bar[],
  inputs: Record<string, unknown>,
  properties: Partial<StrategyProperties>,
) => Promise<BacktestReport | null>;

async function run(
  strategyKey: string,
  execute: Execute,
  chartId: string,
  rt: Runtime,
  bars: Bar[],
  allInputs: Record<string, unknown>,
  key: string,
): Promise<void> {
  const { [PROPERTIES_INPUT]: properties, ...inputs } = allInputs;
  rt.running = true;
  rt.key = key;
  const prev = strategyTester.run(chartId, strategyKey);
  strategyTester.setRun(chartId, strategyKey, { status: "running", report: prev?.report ?? null, error: null, bars: bars.length });
  try {
    const report = await execute(`${chartId}|${strategyKey}`, bars, inputs, (properties ?? {}) as Partial<StrategyProperties>);
    if (report) strategyTester.setRun(chartId, strategyKey, { status: "done", report, error: null, bars: bars.length });
  } catch (err) {
    const error: BacktestError =
      err instanceof BacktestFailed || err instanceof OakEngineError ? err.detail : { message: String(err) };
    strategyTester.setRun(chartId, strategyKey, { status: "error", report: null, error, bars: bars.length });
  } finally {
    rt.running = false;
    const next = rt.queued;
    rt.queued = null;
    if (next) void run(strategyKey, execute, chartId, rt, next.bars, next.inputs, next.key);
    else window.dispatchEvent(new CustomEvent<StrategyUpdatedDetail>(STRATEGY_UPDATED_EVENT, { detail: { chartId, key: strategyKey } }));
  }
}

function makeCalculate(
  strategyKey: string,
  defaultInputs: () => Record<string, unknown>,
  execute: Execute,
): IndicatorRegistryEntry["calculate"] {
  return ((bars: Bar[], inputs?: Record<string, unknown>, ctx?: { chartId?: string }) => {
    const chartId = ctx?.chartId ?? "";
    // Strategy properties (Strategy Tester pills / Properties) ride in the
    // study inputs under PROPERTIES_INPUT, so they persist with the pane.
    const { [PROPERTIES_INPUT]: props, [STYLE_INPUT]: _style, ...rest } = (inputs ?? {}) as Record<string, unknown>;
    const typedInputs = { ...defaultInputs(), ...rest, [PROPERTIES_INPUT]: props ?? {} };
    const key = stalenessKey(bars, typedInputs);
    const rtKey = `${chartId}|${strategyKey}`;
    let rt = runtimes.get(rtKey);
    if (!rt) runtimes.set(rtKey, (rt = { key: null, running: false, queued: null }));
    if (bars.length && rt.key !== key && rt.queued?.key !== key) {
      // Snapshot: ChartView mutates its bar array in place on live ticks.
      const snapshot = bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
      if (rt.running) rt.queued = { bars: snapshot, inputs: typedInputs, key };
      else void run(strategyKey, execute, chartId, rt, snapshot, typedInputs, key);
    }
    return EMPTY_RESULT;
  }) as IndicatorRegistryEntry["calculate"];
}

// ── OakScript strategies (editor panel scripts) ──────────────────────────────

/** Worker generation each user strategy script was compiled in (the compile
 *  cache dies with the worker). */
const compiledGen = new Map<string, number>();

function applyUserMeta(entry: IndicatorRegistryEntry, name: string, meta: OakCompiledMeta | undefined): void {
  const e = entry as unknown as Record<string, unknown>;
  e.name = name;
  e.shortName = meta?.shortTitle ?? name;
  e.metadata = { title: meta?.title ?? name, shortTitle: meta?.shortTitle ?? name, overlay: true };
  e.inputConfig = meta?.inputConfig ?? [];
  e.defaultInputs = meta?.defaultInputs ?? {};
}

function userExecute(scriptId: string, entry: IndicatorRegistryEntry): Execute {
  return async (_channel, bars, inputs, properties) => {
    const engine = getOakEngine();
    if (compiledGen.get(scriptId) !== engine.generation) {
      const script = scripts.loadScript(scriptId);
      if (!script) throw new OakEngineError({ message: "Script no longer exists." });
      const meta = await engine.compile(scriptId, script.source);
      compiledGen.set(scriptId, engine.generation);
      scripts.saveCompiledMeta(scriptId, meta);
      applyUserMeta(entry, script.name, meta);
    }
    return engine.backtest(scriptId, bars, inputs, properties);
  };
}

function userStrategyEntry(id: string, scriptId: string): IndicatorRegistryEntry | undefined {
  const script = scripts.loadScript(scriptId);
  if (!script) return undefined;
  const entry = { id, group: "community", category: "Trend", overlay: true, plotConfig: [] } as unknown as IndicatorRegistryEntry;
  applyUserMeta(entry, script.name, script.meta);
  (entry as unknown as Record<string, unknown>).calculate = makeCalculate(
    USER_KEY_PREFIX + scriptId,
    () => (entry.defaultInputs ?? {}) as Record<string, unknown>,
    userExecute(scriptId, entry),
  );
  return entry;
}

/** Editor-side hook: the panel compiled `scriptId`. Refreshes its strategy
 *  entry (name, inputs) and reruns its backtest on every chart holding it. */
export function notifyUserStrategyCompiled(scriptId: string, meta: OakCompiledMeta): void {
  compiledGen.set(scriptId, getOakEngine().generation);
  const entry = entries.get(userStrategyId(scriptId));
  if (!entry) return;
  applyUserMeta(entry, scripts.loadScript(scriptId)?.name ?? meta.title, meta);
  const key = USER_KEY_PREFIX + scriptId;
  for (const [rtKey, rt] of runtimes) {
    if (!rtKey.endsWith(`|${key}`)) continue;
    rt.key = null; // rerun on the next render
    const chartId = rtKey.slice(0, rtKey.length - key.length - 1);
    window.dispatchEvent(new CustomEvent<StrategyUpdatedDetail>(STRATEGY_UPDATED_EVENT, { detail: { chartId, key } }));
  }
}

/** Editor-side hook: a script was deleted. */
export function dropUserStrategy(scriptId: string): void {
  entries.delete(userStrategyId(scriptId));
  compiledGen.delete(scriptId);
}

/** strategy() properties of a strategy study before overrides: the port's
 *  declaration, or the compiled OakScript declaration (undefined when not
 *  compiled yet or not supported by the broker). */
export function strategyDefaults(id: string): StrategyProperties | undefined {
  if (!isStrategyId(id)) return undefined;
  const key = strategyKeyOf(id);
  const scriptId = userScriptIdOf(key);
  if (scriptId !== null) {
    const declared = scripts.loadScript(scriptId)?.meta?.strategy;
    if (!declared) return undefined;
    try {
      return brokerProperties(declared as unknown as ScriptStrategyProperties);
    } catch {
      return undefined;
    }
  }
  const def = STRATEGIES.find((d) => d.key === key);
  return def ? { ...DEFAULT_PROPERTIES, ...def.properties } : undefined;
}

/** Resolve `strategy:<key>` (undefined for an unknown key). */
export function getStrategyEntry(id: string): IndicatorRegistryEntry | undefined {
  if (!isStrategyId(id)) return undefined;
  const cached = entries.get(id);
  if (cached) return cached;
  const scriptId = userScriptIdOf(strategyKeyOf(id));
  if (scriptId !== null) {
    const user = userStrategyEntry(id, scriptId);
    if (user) entries.set(id, user);
    return user;
  }
  const def = STRATEGIES.find((s) => s.key === strategyKeyOf(id));
  if (!def) return undefined;
  const entry = {
    id,
    group: "community",
    category: "Trend",
    name: def.title,
    shortName: def.shortTitle ?? def.title,
    overlay: true,
    metadata: { title: def.title, shortTitle: def.shortTitle ?? def.title, overlay: true },
    // Pine inputs; `time` / group / inline / tooltip ride along for the
    // strategy Inputs tab (IndicatorSettingsDialog).
    inputConfig: def.inputs.map((i) => ({ ...i, defval: (def.defaultInputs as Record<string, unknown>)[i.id] })),
    plotConfig: [],
    defaultInputs: def.defaultInputs as Record<string, unknown>,
    calculate: makeCalculate(
      def.key,
      () => def.defaultInputs as Record<string, unknown>,
      (channel, bars, inputs, properties) => getBacktestClient().run(channel, { strategy: def.key, bars, inputs, properties }),
    ),
  } as unknown as IndicatorRegistryEntry;
  entries.set(id, entry);
  return entry;
}

/** Every strategy port, for the Indicators dialog. */
export function strategyRows(): { id: string; name: string; author: string }[] {
  return STRATEGIES.map((s) => ({ id: strategyId(s.key), name: s.source.name, author: s.source.author }));
}
