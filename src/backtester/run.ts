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
  /** Pine source this port follows (TradingView script id). */
  source: { id: string; name: string; author: string };
  /** strategy() declaration arguments that differ from the Pine defaults. */
  properties: Partial<StrategyProperties>;
  defaultInputs: I;
  /** The script's inputs in Pine order (Inputs tab of the strategy settings),
   *  from TradingView's compiled metaInfo (research/backtester/settings). */
  inputs: StrategyInput<I>[];
  /** Indicator series drawn by the Pine script, keyed by TradingView plot id (plot_0, ...). */
  plots?(bars: Bar[], inputs: I, symbol: SymbolInfo): Record<string, number[]>;
  /** Precompute series, return the per-bar script body. */
  setup(bars: Bar[], inputs: I, symbol: SymbolInfo): OnBar;
}

export interface RunOptions<I> {
  inputs?: Partial<I>;
  properties?: Partial<StrategyProperties>;
  symbol?: Partial<SymbolInfo>;
}

export function runBacktest<I extends object>(bars: Bar[], def: StrategyDefinition<I>, opts: RunOptions<I> = {}): BacktestReport {
  const t0 = performance.now();
  const properties = { ...DEFAULT_PROPERTIES, ...def.properties, ...opts.properties };
  const symbol = { ...DEFAULT_SYMBOL, ...opts.symbol };
  const inputs = { ...def.defaultInputs, ...opts.inputs } as I;
  const broker = new Broker(bars, properties, symbol);
  const onBar = def.setup(bars, inputs, symbol);
  const equity = new Array<number>(bars.length);
  for (let i = 0; i < bars.length; i++) {
    broker.processBar(i);
    onBar(i, broker);
    if (properties.processOrdersOnClose) broker.processClose(i);
    equity[i] = broker.equity;
  }
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
    ),
    equity,
    buyHold,
    range: { from: bars.length ? bars[0].time * 1000 : 0, to: bars.length ? bars[bars.length - 1].time * 1000 : 0 },
    elapsedMs: performance.now() - t0,
  };
}
