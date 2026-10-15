/*
 * The outputs of a study that an alert message numbers: `{{plot_<n>}}` and
 * the "Plot <n>" rows of the "Add placeholder" menu count every output of the
 * study in the order the script declares them: line plots, shapes, characters
 * and arrows, and the four prices (open, high, low, close) of a candle or bar
 * output. Colour outputs are not counted.
 *
 * - A script gives that order in its entry (`outputs`, oakscriptjs
 *   ScriptRunResult.outputs). A study without it (the built-in studies, a
 *   script compiled before) numbers its line plots only, in plot order.
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
    return plots.map((p) => ({ title: p.title || p.id, named: true, source: "plot", id: p.id }));
  }
  return declared.flatMap((o): MessageOutput[] => {
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
  });
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
