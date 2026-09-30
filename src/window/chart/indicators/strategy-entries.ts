/*
 * strategy-entries — the backtester's strategy ports as registry entries with
 * id `strategy:<key>`. registry.ts routes those ids here, so a strategy is
 * added, persisted, listed in the legend and recomputed (load, history
 * paging, live bars) by the same pipeline as any indicator.
 *
 * `calculate(bars, inputs, { chartId })` is synchronous; the backtest runs in
 * the backtest worker. Same stale-while-revalidate scheme as user-scripts.ts,
 * but the cache is per chart AND strategy (a report belongs to one chart's
 * bars): calculate() returns the last result and schedules a run when the
 * bars or inputs moved; the worker's answer is published to the Strategy
 * Tester store and STRATEGY_UPDATED_EVENT makes that chart re-render.
 */
import type { IndicatorRegistryEntry } from "lightweight-charts-indicators";
import { BacktestFailed, getBacktestClient } from "../../../backtester/client";
import { STRATEGIES } from "../../../backtester/strategies";
import type { StrategyDefinition } from "../../../backtester/run";
import type { Bar, StrategyProperties } from "../../../backtester/types";
import { strategyTester } from "../../../data/strategy-tester-store";

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

async function run(def: StrategyDefinition<any>, chartId: string, rt: Runtime, bars: Bar[], allInputs: Record<string, unknown>, key: string): Promise<void> {
  const { [PROPERTIES_INPUT]: properties, ...inputs } = allInputs;
  rt.running = true;
  rt.key = key;
  const prev = strategyTester.run(chartId, def.key);
  strategyTester.setRun(chartId, def.key, { status: "running", report: prev?.report ?? null, error: null, bars: bars.length });
  try {
    const report = await getBacktestClient().run(`${chartId}|${def.key}`, {
      strategy: def.key,
      bars,
      inputs,
      properties: (properties ?? {}) as Partial<StrategyProperties>,
    });
    if (report) strategyTester.setRun(chartId, def.key, { status: "done", report, error: null, bars: bars.length });
  } catch (err) {
    const error = err instanceof BacktestFailed ? err.detail : { message: String(err) };
    strategyTester.setRun(chartId, def.key, { status: "error", report: null, error, bars: bars.length });
  } finally {
    rt.running = false;
    const next = rt.queued;
    rt.queued = null;
    if (next) void run(def, chartId, rt, next.bars, next.inputs, next.key);
    else window.dispatchEvent(new CustomEvent<StrategyUpdatedDetail>(STRATEGY_UPDATED_EVENT, { detail: { chartId, key: def.key } }));
  }
}

function makeCalculate(def: StrategyDefinition<any>): IndicatorRegistryEntry["calculate"] {
  return ((bars: Bar[], inputs?: Record<string, unknown>, ctx?: { chartId?: string }) => {
    const chartId = ctx?.chartId ?? "";
    // Strategy properties (Strategy Tester pills / Properties) ride in the
    // study inputs under PROPERTIES_INPUT, so they persist with the pane.
    const { [PROPERTIES_INPUT]: props, [STYLE_INPUT]: _style, ...rest } = (inputs ?? {}) as Record<string, unknown>;
    const typedInputs = { ...def.defaultInputs, ...rest, [PROPERTIES_INPUT]: props ?? {} };
    const key = stalenessKey(bars, typedInputs);
    const rtKey = `${chartId}|${def.key}`;
    let rt = runtimes.get(rtKey);
    if (!rt) runtimes.set(rtKey, (rt = { key: null, running: false, queued: null }));
    if (bars.length && rt.key !== key && rt.queued?.key !== key) {
      // Snapshot: ChartView mutates its bar array in place on live ticks.
      const snapshot = bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
      if (rt.running) rt.queued = { bars: snapshot, inputs: typedInputs, key };
      else void run(def, chartId, rt, snapshot, typedInputs, key);
    }
    return EMPTY_RESULT;
  }) as IndicatorRegistryEntry["calculate"];
}

/** Resolve `strategy:<key>` (undefined for an unknown key). */
export function getStrategyEntry(id: string): IndicatorRegistryEntry | undefined {
  if (!isStrategyId(id)) return undefined;
  const cached = entries.get(id);
  if (cached) return cached;
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
    calculate: makeCalculate(def),
  } as unknown as IndicatorRegistryEntry;
  entries.set(id, entry);
  return entry;
}

/** Every strategy port, for the Indicators dialog. */
export function strategyRows(): { id: string; name: string; author: string }[] {
  return STRATEGIES.map((s) => ({ id: strategyId(s.key), name: s.source.name, author: s.source.author }));
}
