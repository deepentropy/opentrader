/*
 * The outputs of a study that an alert message numbers: `{{plot_<n>}}` and
 * the "Plot <n>" rows of the "Add placeholder" menu count every output of the
 * study in the order the script declares them: line plots, shapes, characters
 * and arrows, and the four prices (open, high, low, close) of a candle or bar
 * output. Colour outputs are not counted.
 *
 * - A script gives that order in its entry (`outputs`, oakscriptjs
 *   ScriptRunResult.outputs). A study without it (a script compiled before)
 *   numbers its line plots in plot order, then the prices of its candles.
 * - The same list is the plot select of an alert condition on the study: a
 *   line plot is read by its plotConfig index (`Operand.plot`), any other
 *   output by its key (`Operand.output`, outputKey).
 * - The value of an output on a bar: a line plot's value, the value of a
 *   shape's / character's / arrow's series (`outputValues` of the result: a
 *   condition gives 1 or 0), a candle's or bar's price; null when it has none
 *   on that bar (na).
 */
import type { IndicatorRegistryEntry } from "lightweight-charts-indicators";

type OhlcPart = "open" | "high" | "low" | "close";

/** One numbered output. `named`: it has a `{{plot("<title>")}}` row in the menu (the four prices of a candle or bar
 *  output have none). */
export type MessageOutput = {
  title: string;
  named: boolean;
  source: "plot" | "series" | "candle" | "bar";
  id: string;
  part?: OhlcPart;
};

type Declared = { kind: "plot" | "shape" | "char" | "arrow" | "candle" | "bar"; id: string; title?: string };

/** Title of an untitled shape / character output, as the reference names it. */
const UNTITLED: Partial<Record<Declared["kind"], string>> = { shape: "Shapes", char: "Chars" };

const OHLC: { part: OhlcPart; title: string }[] = [
  { part: "open", title: "Open" },
  { part: "high", title: "High" },
  { part: "low", title: "Low" },
  { part: "close", title: "Close" },
];

/** The outputs of `entry` in message order. */
export function messageOutputs(entry: IndicatorRegistryEntry | null | undefined): MessageOutput[] {
  if (!entry) return [];
  const plots = (entry.plotConfig ?? []) as { id: string; title?: string }[];
  const declared = (entry as { outputs?: Declared[] }).outputs;
  if (!Array.isArray(declared) || !declared.length) {
    const candles = ((entry as { plotCandleConfig?: { id: string; title?: string }[] }).plotCandleConfig ?? []).map((c): Declared => ({ kind: "candle", id: c.id, title: c.title }));
    return [...plots.map((p): Declared => ({ kind: "plot", id: p.id })), ...candles].flatMap((o) => outputsOf(o, plots));
  }
  return declared.flatMap((o) => outputsOf(o, plots));
}

/** The numbered outputs of one declared output (four for a candle or a bar). */
function outputsOf(o: Declared, plots: { id: string; title?: string }[]): MessageOutput[] {
  switch (o.kind) {
    case "plot": {
      const p = plots.find((x) => x.id === o.id);
      return [{ title: p?.title || o.title || o.id, named: true, source: "plot", id: o.id }];
    }
    case "shape":
    case "char":
    case "arrow":
      return [{ title: o.title || UNTITLED[o.kind] || o.id, named: true, source: "series", id: o.id }];
    case "candle":
    case "bar": {
      const source = o.kind;
      return OHLC.map(({ part, title }) => ({ title: o.title ? `${o.title} (${title})` : title, named: false, source, id: o.id, part }));
    }
    default:
      return [];
  }
}

/** Key of an output other than a line plot, as an alert operand keeps it (`Operand.output`): its id, and the price
 *  of a candle or bar output ("<id>:close"). */
export function outputKey(o: MessageOutput): string {
  return o.part ? `${o.id}:${o.part}` : o.id;
}

/** One row of the plot select of an alert condition on a study: a line plot (`plot`: its plotConfig index) or another
 *  output (`output`: its key). `index`: the row (the output's number in messages). */
export type OutputChoice = { index: number; title: string; plot?: number; output?: string };

/** The plot select of a study: its outputs in message order. */
export function outputChoices(entry: IndicatorRegistryEntry | null | undefined): OutputChoice[] {
  const plots = (entry?.plotConfig ?? []) as { id: string }[];
  return messageOutputs(entry)
    .flatMap((o): Omit<OutputChoice, "index">[] => {
      if (o.source !== "plot") return [{ title: o.title, output: outputKey(o) }];
      const plot = plots.findIndex((p) => p.id === o.id);
      return plot < 0 ? [] : [{ title: o.title, plot }];
    })
    .map((c, index) => ({ index, ...c }));
}

/** The row of the plot select an operand reads (0 when it is gone). */
export function choiceIndex(entry: IndicatorRegistryEntry | null | undefined, op: { plot?: number; output?: string }): number {
  const list = outputChoices(entry);
  const i = op.output ? list.findIndex((c) => c.output === op.output) : list.findIndex((c) => c.plot === (op.plot ?? 0));
  return Math.max(0, i);
}

/** The output other than a line plot an operand reads, by key. */
export function outputByKey(entry: IndicatorRegistryEntry | null | undefined, key: string): MessageOutput | undefined {
  return messageOutputs(entry).find((o) => o.source !== "plot" && outputKey(o) === key);
}

type TimePoint = { time: number };
type StudyResult = {
  plots?: Record<string, (TimePoint & { value?: number | null })[]>;
  outputValues?: Record<string, (TimePoint & { value: number })[]>;
  plotCandles?: Record<string, (TimePoint & Record<OhlcPart, number>)[]>;
  plotBars?: Record<string, (TimePoint & Record<OhlcPart, number>)[]>;
};

/** The point of `series` on a bar whose time is one of `times` (the bar's time as given to the study and as charted),
 *  searched from the newest point. */
function pointAt<T extends TimePoint>(series: T[] | undefined, times: readonly number[]): T | undefined {
  if (!series) return undefined;
  for (let k = series.length - 1; k >= 0; k--) {
    const p = series[k];
    if (p && times.includes(p.time)) return p;
  }
  return undefined;
}

const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Value of output `o` in a study `result` on the bar whose time is one of `times`; null for na. */
export function outputValue(result: unknown, o: MessageOutput, times: readonly number[]): number | null {
  const r = result as StudyResult | null;
  if (!r) return null;
  switch (o.source) {
    case "plot":
      return finite(pointAt(r.plots?.[o.id], times)?.value);
    case "series":
      return finite(pointAt(r.outputValues?.[o.id], times)?.value);
    case "candle":
      return finite(pointAt(r.plotCandles?.[o.id], times)?.[o.part ?? "close"]);
    case "bar":
      return finite(pointAt(r.plotBars?.[o.id], times)?.[o.part ?? "close"]);
  }
}

/** Values of output `o` in a study `result` on every bar (`times[i]`: the times bar i has, as given to the study and
 *  as charted); null for na. */
export function outputSeries(result: unknown, o: MessageOutput, times: readonly (readonly number[])[]): (number | null)[] {
  const r = result as StudyResult | null;
  const series: (TimePoint & Record<string, unknown>)[] | undefined =
    o.source === "plot" ? r?.plots?.[o.id] : o.source === "series" ? r?.outputValues?.[o.id] : o.source === "candle" ? r?.plotCandles?.[o.id] : r?.plotBars?.[o.id];
  if (!series) return times.map(() => null);
  const field = o.source === "candle" || o.source === "bar" ? (o.part ?? "close") : "value";
  const byTime = new Map<number, unknown>();
  for (const p of series) if (p) byTime.set(p.time, p[field]);
  return times.map((ts) => {
    for (const t of ts) if (byTime.has(t)) return finite(byTime.get(t));
    return null;
  });
}
