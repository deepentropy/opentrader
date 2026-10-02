import { Broker } from './broker';
import { computePerformance } from './report';
import {
  DEFAULT_PROPERTIES,
  DEFAULT_SYMBOL,
  type BacktestReport,
  type Bar,
  type StrategyProperties,
  type SymbolInfo,
  type Trade,
} from './types';

/** Called at each bar close with the bar index; places orders through `strategy`. */
export type OnBar = (i: number, strategy: Broker) => void;

/** One Pine input: `id` is the port's input key, `title` the metaInfo name. */
export interface StrategyInput<I = Record<string, unknown>> {
  id: Extract<keyof I, string>;
  title: string;
  type: 'int' | 'float' | 'bool' | 'string' | 'source' | 'time';
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  group?: string;
  inline?: string;
  tooltip?: string;
}

export interface StrategyDefinition<I extends object = Record<string, unknown>> {
  /** Stable id, e.g. "alphatrend". */
  key: string;
  title: string;
  /** strategy(shorttitle=) when the script sets one: the legend / report tab label. */
  shortTitle?: string;
  /** Pine source this port follows (the reference app script id). */
  source: { id: string; name: string; author: string };
  /** strategy() declaration arguments that differ from the Pine defaults. */
  properties: Partial<StrategyProperties>;
  defaultInputs: I;
  /** The script's inputs in Pine order (Inputs tab of the strategy settings),
   *  from the reference app's compiled metaInfo (.tmp/backtester/settings). */
  inputs: StrategyInput<I>[];
  /** Indicator series drawn by the Pine script, keyed by the reference app plot id (plot_0, ...). */
  plots?(bars: Bar[], inputs: I, symbol: SymbolInfo): Record<string, number[]>;
  /** Precompute series, return the per-bar script body. */
  setup(bars: Bar[], inputs: I, symbol: SymbolInfo): OnBar;
}

export interface RunOptions<I> {
  inputs?: Partial<I>;
  properties?: Partial<StrategyProperties>;
  symbol?: Partial<SymbolInfo>;
  /** Lower-timeframe bars (time ascending) for the bar magnifier (`properties.barMagnifier`). */
  intrabars?: Bar[];
  /** Period of the lower-timeframe bars, seconds (default: inferred from their times). */
  intrabarSeconds?: number;
  /** The last bar is a realtime (open) bar: the script runs on it only with `properties.calcOnEveryTick`
   *  (Script execution "On realtime bar tick"); orders placed before it still fill on it. */
  realtime?: boolean;
  /** The chart shows Heikin Ashi bars of `bars`: the script runs on them, and fills too unless
   *  `properties.fillOrdersOnStandardOhlc` (then fills use `bars`). No bar magnifier on them. */
  heikinAshi?: boolean;
}

/**
 * Heikin Ashi bars of standard bars (the chart style transform, as the reference app's series): close = ohlc4,
 * open = (previous open + previous close) / 2 (the first one (open + close) / 2), high / low = the extremes of
 * high / low, open and close.
 */
export function heikinAshiBars(bars: Bar[]): Bar[] {
  const out = new Array<Bar>(bars.length);
  let po = NaN;
  let pc = NaN;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const close = (b.open + b.high + b.low + b.close) / 4;
    const open = i === 0 ? (b.open + b.close) / 2 : (po + pc) / 2;
    out[i] = { time: b.time, open, high: Math.max(b.high, open, close), low: Math.min(b.low, open, close), close, volume: b.volume };
    po = open;
    pc = close;
  }
  return out;
}

/** Bars the script sees and bars the broker fills on (see RunOptions.heikinAshi). */
export function chartBars(bars: Bar[], heikinAshi: boolean | undefined, standardFills: boolean): { script: Bar[]; fills: Bar[] } {
  if (!heikinAshi) return { script: bars, fills: bars };
  const ha = heikinAshiBars(bars);
  return { script: ha, fills: standardFills ? bars : ha };
}

/**
 * The lower-timeframe bars of each chart bar: a lower-timeframe bar belongs to the chart bar its last second
 * falls in (a 2-minute bar 13:44-13:46 is part of the 13:45 bar of a 15-minute chart, as the reference app
 * counts it). A chart bar gets them only when the lower-timeframe data starts at or before its open (a partly
 * covered bar keeps its own OHLC path). `ltfSeconds`: the lower-timeframe period (default: the most frequent
 * gap between the first bars).
 */
export function binIntrabars(bars: Bar[], ltf: Bar[] | undefined, ltfSeconds?: number): (Bar[] | undefined)[] | undefined {
  if (!ltf?.length || !bars.length) return undefined;
  const period = ltfSeconds ?? commonGap(ltf);
  const out = new Array<Bar[] | undefined>(bars.length);
  const start = ltf[0].time;
  let j = 0;
  for (let i = 0; i < bars.length; i++) {
    const from = bars[i].time;
    const to = i + 1 < bars.length ? bars[i + 1].time : Infinity;
    while (j < ltf.length && ltf[j].time + period - 1 < from) j++;
    const k0 = j;
    while (j < ltf.length && ltf[j].time + period - 1 < to) j++;
    if (from >= start && j > k0) out[i] = ltf.slice(k0, j);
  }
  return out;
}

/** Most frequent positive time gap between the first 200 bars (seconds). */
function commonGap(bars: Bar[]): number {
  const count = new Map<number, number>();
  for (let k = 1; k < Math.min(bars.length, 200); k++) {
    const d = bars[k].time - bars[k - 1].time;
    if (d > 0) count.set(d, (count.get(d) ?? 0) + 1);
  }
  let best = 1;
  let n = 0;
  for (const [d, c] of count) if (c > n || (c === n && d < best)) [best, n] = [d, c];
  return best;
}

export function runBacktest<I extends object>(bars: Bar[], def: StrategyDefinition<I>, opts: RunOptions<I> = {}): BacktestReport {
  const t0 = performance.now();
  const properties = { ...DEFAULT_PROPERTIES, ...def.properties, ...opts.properties };
  const symbol = { ...DEFAULT_SYMBOL, ...opts.symbol };
  const inputs = { ...def.defaultInputs, ...opts.inputs } as I;
  const { script, fills } = chartBars(bars, opts.heikinAshi, properties.fillOrdersOnStandardOhlc);
  const magnify = properties.barMagnifier && !opts.heikinAshi;
  const broker = new Broker(fills, properties, symbol, magnify ? binIntrabars(fills, opts.intrabars, opts.intrabarSeconds) : undefined);
  const onBar = def.setup(script, inputs, symbol);
  const equity = new Array<number>(bars.length);
  const skipLast = opts.realtime === true && !properties.calcOnEveryTick;
  for (let i = 0; i < bars.length; i++) {
    broker.processBar(i);
    if (!(skipLast && i === bars.length - 1)) {
      onBar(i, broker);
      if (properties.processOrdersOnClose) broker.processClose(i);
    }
    equity[i] = broker.equity;
  }
  return backtestReport(fills, broker, equity, t0);
}

/** The report of a finished run: `equity` holds the equity at each bar close, `t0` the start time (performance.now()). */
export function backtestReport(bars: Bar[], broker: Broker, equity: number[], t0: number): BacktestReport {
  const properties = broker.props;
  const open = bars.length ? broker.openTradeReports() : [];
  const trades = [...broker.closedTrades, ...open];
  const first = trades.reduce<Trade | null>((a, t) => (!a || t.entry.bar < a.entry.bar ? t : a), null);
  const buyHold = new Array<number>(bars.length).fill(0);
  if (first) {
    const p0 = first.entry.price;
    const shares = Math.floor(properties.initialCapital / p0);
    for (let i = first.entry.bar; i < bars.length; i++) buyHold[i] = shares * (bars[i].close - p0);
  }
  return {
    currency: properties.currency,
    properties,
    trades,
    filledOrders: broker.filledOrders,
    performance: computePerformance(
      bars,
      broker.closedTrades,
      open,
      properties.initialCapital,
      broker.maxContractsHeld,
      bars.length ? broker.openProfitAt(broker.roundPrice(bars[bars.length - 1].close)) : 0,
      broker.equityEvents,
      bars.length ? broker.roundPrice(bars[bars.length - 1].close) : undefined,
    ),
    equity,
    buyHold,
    range: { from: bars.length ? bars[0].time * 1000 : 0, to: bars.length ? bars[bars.length - 1].time * 1000 : 0 },
    elapsedMs: performance.now() - t0,
  };
}
