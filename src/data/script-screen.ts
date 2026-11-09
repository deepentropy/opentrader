/*
 * Script screen: what a row of the script screener holds and how it is read
 * from one run of an indicator (see ./script-screener for the scan).
 *
 *  - value columns: each line plot (and shape / character / arrow series) of
 *    the indicator on the newest bar, with its value on the bar before (for
 *    "crosses" filters);
 *  - signal columns: each alert condition of the indicator and each kind of
 *    mark it draws (plotshape-like markers, by id, else text, else shape):
 *    how many bars ago it last happened (0 = the newest bar), null when it
 *    never did in the loaded history. A mark drawn with an offset (a
 *    divergence label drawn on its pivot) counts on the bar it is drawn on.
 */
import type { IndicatorRegistryEntry } from "lightweight-charts-indicators";
import type { Bar } from "oakscriptjs";
import type { Candle } from "../bindings";
import { messageOutputs, outputKey, outputValue, type MessageOutput } from "./alert-outputs";
import { studyConditions, conditionBars } from "./alert-study-conditions";

/** Intervals of the screener and of an indicator's own calculation timeframe (the reference list): minutes as chart
 *  ids ("60" = 1 hour), then 1D / 1W / 1M. */
export type ScriptInterval = "1" | "5" | "15" | "30" | "60" | "120" | "240" | "1D" | "1W" | "1M";
export const SCRIPT_INTERVALS: { id: ScriptInterval; label: string; short: string }[] = [
  { id: "1", label: "1 minute", short: "1m" },
  { id: "5", label: "5 minutes", short: "5m" },
  { id: "15", label: "15 minutes", short: "15m" },
  { id: "30", label: "30 minutes", short: "30m" },
  { id: "60", label: "1 hour", short: "1h" },
  { id: "120", label: "2 hours", short: "2h" },
  { id: "240", label: "4 hours", short: "4h" },
  { id: "1D", label: "1 day", short: "1D" },
  { id: "1W", label: "1 week", short: "1W" },
  { id: "1M", label: "1 month", short: "1M" },
];
export const isScriptInterval = (v: unknown): v is ScriptInterval => SCRIPT_INTERVALS.some((i) => i.id === v);
/** Minutes of an intraday interval; null for 1D / 1W / 1M. */
export const intradayMinutes = (iv: ScriptInterval): number | null => (/^\d+$/.test(iv) ? Number(iv) : null);
/** Symbols an intraday scan takes at most: each symbol costs a history request per scan (the session in progress
 *  cannot be served from a cache). */
export const INTRADAY_MAX_SYMBOLS = 200;
/** Bars an indicator is given at most (the newest ones), as the reference screener. */
export const MAX_BARS = 500;

/** A column of the script screen. */
export type ScriptColumn = { key: string; title: string; kind: "value" | "signal" };

/** Value of a column on one row: a value column's newest and previous values, a signal's bars since it happened. */
export type ScriptCell = { value: number | null; prev?: number | null };
export type ScriptRow = { symbol: string; cells: Record<string, ScriptCell>; error?: string };

/** The columns an indicator declares before any run: its value outputs, then its alert conditions. */
export function declaredColumns(entry: IndicatorRegistryEntry, inputs?: Record<string, unknown>): ScriptColumn[] {
  const values = valueOutputs(entry).map((o) => ({ key: valueKey(o), title: o.title, kind: "value" as const }));
  const conditions = studyConditions(entry, inputs).map((c) => ({ key: `cond:${c.id}`, title: c.title, kind: "signal" as const }));
  return [...values, ...conditions];
}

/** Line plots, shapes, characters, arrows (candle and bar prices are left out: the symbol's own prices). */
function valueOutputs(entry: IndicatorRegistryEntry): MessageOutput[] {
  return messageOutputs(entry).filter((o) => o.source === "plot" || o.source === "series");
}
const valueKey = (o: MessageOutput) => `out:${outputKey(o)}`;

type Marker = { time: number; id?: string; text?: string; shape?: string };

/** Key and title of a kind of mark: its declaration id, else its text, else its shape. */
export function markKind(m: Marker): { key: string; title: string } | null {
  const text = m.text?.trim().split("\n")[0];
  if (m.id) return { key: `mark:${m.id}`, title: text || m.id };
  if (text) return { key: `mark:t:${text}`, title: text };
  if (m.shape) return { key: `mark:s:${m.shape}`, title: m.shape };
  return null;
}

/** Bars since the newest true flag (0 = the newest bar), null when none. */
export function barsSince(flags: readonly boolean[]): number | null {
  for (let i = flags.length - 1; i >= 0; i--) if (flags[i]) return flags.length - 1 - i;
  return null;
}

/**
 * The cells of one run: `bars` as given to the indicator, `chartTimes[i]` the time bar i has in the history (daily
 * bars are given at their session open). Mark kinds met are added to `marks`.
 */
export function readRun(
  entry: IndicatorRegistryEntry,
  result: unknown,
  bars: readonly Bar[],
  chartTimes: readonly number[],
  inputs: Record<string, unknown> | undefined,
  marks: Map<string, string>,
): Record<string, ScriptCell> {
  const cells: Record<string, ScriptCell> = {};
  const n = bars.length;
  if (!n) return cells;
  const timesOf = (i: number) => [bars[i].time as number, chartTimes[i]];
  // The symbol's own prices, the right side of a filter ("Price", "High"...).
  for (const p of ["close", "high", "low", "open"] as const) {
    cells[`price:${p}`] = { value: bars[n - 1][p], prev: n > 1 ? bars[n - 2][p] : null };
  }
  for (const o of valueOutputs(entry)) {
    cells[valueKey(o)] = { value: outputValue(result, o, timesOf(n - 1)), prev: n > 1 ? outputValue(result, o, timesOf(n - 2)) : null };
  }
  for (const c of studyConditions(entry, inputs)) {
    const flags = conditionBars(entry, result, c.id, bars as unknown as { time: number }[]);
    cells[`cond:${c.id}`] = { value: flags ? barsSince(flags) : null };
  }
  const index = new Map<number, number>();
  bars.forEach((b, i) => {
    index.set(b.time as number, i);
    index.set(chartTimes[i], i);
  });
  const markers = ((result as { markers?: Marker[] } | null)?.markers ?? []) as Marker[];
  for (const m of markers) {
    const kind = markKind(m);
    const i = index.get(m.time);
    if (!kind || i === undefined) continue;
    marks.set(kind.key, kind.title);
    const ago = n - 1 - i;
    const cell = cells[kind.key];
    if (!cell || cell.value === null || ago < cell.value) cells[kind.key] = { value: ago };
  }
  return cells;
}

/** The session in progress (or the last one) of a symbol, from the live table. */
export type SessionBar = { time: number; open: number; high: number; low: number; close: number; volume: number };

/** `daily` with the live session: it replaces the bar of the same day, or follows the newest one. */
export function withSession(daily: readonly Candle[], s: SessionBar | null | undefined): Candle[] {
  const out = [...daily];
  if (!s || !(s.close > 0) || !(s.open > 0)) return out;
  const last = out[out.length - 1];
  const bar: Candle = { time: s.time, open: s.open, high: Math.max(s.high, s.open, s.close), low: Math.min(s.low > 0 ? s.low : s.close, s.open, s.close), close: s.close, volume: s.volume };
  const lastTime = last?.time ?? null;
  if (lastTime === null || s.time > lastTime) out.push(bar);
  else if (s.time === lastTime) out[out.length - 1] = bar;
  return out;
}

/** Bare ticker of a symbol ("NASDAQ:AAPL" → "AAPL"), as the live table keys its rows. */
export const bareTicker = (symbol: string) => symbol.split(":").pop() ?? symbol;

// ── Filters and sort ──────────────────────────────────────────────────────

/** Operations of a filter on a value column, in menu order, and of a filter on a signal column. */
export type ValueOp = "above" | "aboveOrEqual" | "below" | "belowOrEqual" | "crosses" | "crossesUp" | "crossesDown" | "between" | "outside" | "equal";
export type SignalOp = "true" | "trueWithin";
export type ScriptOp = ValueOp | SignalOp;
export const VALUE_OPS: ValueOp[] = ["above", "aboveOrEqual", "below", "belowOrEqual", "crosses", "crossesUp", "crossesDown", "between", "outside", "equal"];
export const SIGNAL_OPS: SignalOp[] = ["true", "trueWithin"];

/** The symbol's own prices a value can be compared with (the right side of a filter), as cell keys. */
export const PRICE_TARGETS: { key: string; title: string }[] = [
  { key: "price:close", title: "Price" },
  { key: "price:high", title: "High" },
  { key: "price:low", title: "Low" },
  { key: "price:open", title: "Open" },
];

/**
 * A filter on a column. A value column is compared with a number (`value`; `value2` too for a range) or with another
 * column (`other`: a value column or one of PRICE_TARGETS); the crossing operations compare the bar before too. A
 * signal column is true on the newest bar ("true"), or within the last `value` bars ("trueWithin": 0 = the newest).
 * No operation: a pill not set yet (a signal's, until "True" is picked).
 */
export type ScriptFilter = { id: string; key: string; op: ScriptOp | null; value?: number | null; value2?: number | null; other?: string };

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Right side of a filter on a row: the number or the other column (`prev`: on the bar before). */
function rightOf(f: ScriptFilter, row: ScriptRow, prev: boolean): number | null {
  if (f.other) {
    const c = row.cells[f.other];
    return (prev ? c?.prev : c?.value) ?? null;
  }
  return num(f.value) ? f.value : null;
}

/** A filter is set (it applies): the numbers its operation needs are there. */
export function filterComplete(f: ScriptFilter): boolean {
  if (!f.key || !f.op) return false;
  if (f.op === "true") return true;
  if (f.op === "trueWithin") return num(f.value);
  if (f.op === "between" || f.op === "outside") return num(f.value) && num(f.value2);
  return !!f.other || num(f.value);
}

/** The row passes the filter (a filter that is not set lets every row pass; a missing value does not pass). */
export function passes(row: ScriptRow, f: ScriptFilter): boolean {
  if (!filterComplete(f)) return true;
  const cell = row.cells[f.key];
  const v = cell?.value ?? null;
  if (v === null) return false;
  switch (f.op) {
    case "true":
      return v === 0;
    case "trueWithin":
      return v <= (f.value as number);
    case "between":
    case "outside": {
      const lo = Math.min(f.value as number, f.value2 as number);
      const hi = Math.max(f.value as number, f.value2 as number);
      const inside = v >= lo && v <= hi;
      return f.op === "between" ? inside : !inside;
    }
  }
  const r = rightOf(f, row, false);
  if (r === null) return false;
  switch (f.op) {
    case "above":
      return v > r;
    case "aboveOrEqual":
      return v >= r;
    case "below":
      return v < r;
    case "belowOrEqual":
      return v <= r;
    case "equal":
      return v === r;
    case "crosses":
    case "crossesUp":
    case "crossesDown": {
      const p = cell?.prev ?? null;
      const rp = rightOf(f, row, true);
      if (p === null || rp === null) return false;
      const up = v > r && p <= rp;
      const down = v < r && p >= rp;
      return f.op === "crossesUp" ? up : f.op === "crossesDown" ? down : up || down;
    }
  }
  return true;
}

export type ScriptSort = { key: string; order: "asc" | "desc" };
/** Sort key of the symbol column. */
export const SYMBOL_KEY = "symbol";

/** Rows that pass every filter, sorted (rows without a value last, either way). A symbol that could not be computed
 *  is listed last, with its error, while no filter applies. */
export function screenRows(rows: readonly ScriptRow[], filters: readonly ScriptFilter[], sort: ScriptSort | null): ScriptRow[] {
  const active = filters.filter(filterComplete);
  const kept = rows.filter((r) => !r.error && active.every((f) => passes(r, f)));
  const failed = active.length ? [] : rows.filter((r) => r.error);
  if (!sort) return [...kept, ...failed];
  const dir = sort.order === "asc" ? 1 : -1;
  const sorted = [...kept].sort((a, b) => {
    if (sort.key === SYMBOL_KEY) return dir * bareTicker(a.symbol).localeCompare(bareTicker(b.symbol));
    const x = a.cells[sort.key]?.value ?? null;
    const y = b.cells[sort.key]?.value ?? null;
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    return dir * (x - y);
  });
  return [...sorted, ...failed];
}
