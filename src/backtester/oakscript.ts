/**
 * OakScript strategies on the OpenTrader broker.
 *
 * `BrokerEngine` implements oakscriptjs's `StrategyEngine` with `Broker`: the script API
 * (`strategy()`, `strategy.eachBar()`, `strategy.entry()`...) forwards its calls here.
 * `runOakScriptStrategy` runs a script body and returns the same `BacktestReport` as `runBacktest`.
 *
 * Mapping:
 *   - order options: Pine names (from_entry, qty_percent, trail_points...) to the Broker options;
 *     alert_message / alert_profit / alert_loss / alert_trailing ride on the fills (alerts on the order fills);
 *     disable_alert is ignored;
 *   - OCA groups of entries and orders, and the risk rules allow_entry_in, max_intraday_loss and
 *     max_intraday_filled_orders go to the Broker; strategy.exit(oca_name), `strategy.close(immediately)`, the
 *     other risk rules and default_entry_qty are not implemented by the Broker: they throw;
 *   - calc_on_order_fills / calc_on_every_history_tick: the broker runs the script again inside the bar
 *     (executeIntrabar of oakscriptjs: the bars up to that bar, the last one as it stands at the tick);
 *   - variables: the Broker state; trade statistics from its closed trades (Pine definitions,
 *     percent in %); max_drawdown / max_runup / margin_liquidation_price are not provided
 *     during the run (the report computes the drawdown at the end).
 */
import {
  createScriptRun,
  executeIntrabar,
  executeScript,
  StrategyRecorder,
  type ChartContext,
  type ScriptOptions,
  type ScriptRun,
  type SymbolInfo as ScriptSymbolInfo,
  type ScriptRunResult,
  type StrategyCloseAllOptions,
  type StrategyCloseOptions,
  type StrategyDirection,
  type StrategyEngine,
  type StrategyEntryOptions,
  type StrategyExitOptions,
  type StrategyProperties as ScriptStrategyProperties,
  type StrategyRiskRule,
  type StrategyTrade,
  type StrategyVariable,
} from 'oakscriptjs/script';
import { isPackedSeries } from 'lightweight-charts-indicators/helpers';
import { Broker } from './broker';
import { backtestReport, binIntrabars, heikinAshiBars } from './run';
import { SessionSpec } from '../data/session/spec';
import { localDay, localToUtc } from '../data/session/zone';
import { seedSymbol } from '../data/symbol-name';
import {
  DEFAULT_SYMBOL,
  type BacktestReport,
  type Bar,
  type StrategyProperties,
  type SymbolInfo,
  type Trade,
} from './types';

/** oakscriptjs strategy() properties to the Broker properties. */
export function brokerProperties(p: ScriptStrategyProperties): StrategyProperties {
  return {
    initialCapital: p.initial_capital,
    currency: p.currency ?? 'USD',
    defaultQtyType: p.default_qty_type,
    defaultQtyValue: p.default_qty_value,
    pyramiding: p.pyramiding,
    commissionType: p.commission_type,
    commissionValue: p.commission_value,
    slippage: p.slippage,
    processOrdersOnClose: p.process_orders_on_close,
    closeEntriesRule: p.close_entries_rule,
    marginLong: p.margin_long,
    marginShort: p.margin_short,
    fillLimitsTicks: p.backtest_fill_limits_assumption ?? 0,
    barMagnifier: p.use_bar_magnifier ?? false,
    calcOnOrderFills: p.calc_on_order_fills ?? false,
    calcOnEveryTick: p.calc_on_every_tick ?? false,
    calcOnEveryHistoryTick: p.calc_on_every_history_tick ?? false,
    fillOrdersOnStandardOhlc: p.fill_orders_on_standard_ohlc ?? false,
  };
}

function unsupported(what: string): never {
  throw new Error(`${what} is not supported by the OpenTrader broker`);
}

/** A Broker trade as a Pine strategy.opentrades / strategy.closedtrades record (percent in %). */
function tradeInfo(t: Trade): StrategyTrade {
  const info: StrategyTrade = {
    entry_id: t.entryId,
    entry_price: t.entry.price,
    entry_bar_index: t.entry.bar,
    entry_time: t.entry.time,
    size: t.direction === 'long' ? t.qty : -t.qty,
    profit: t.profit,
    profit_percent: t.profitPercent * 100,
    commission: t.commission,
    max_runup: t.runUp,
    max_runup_percent: t.runUpPercent * 100,
    max_drawdown: t.drawdown,
    max_drawdown_percent: t.drawdownPercent * 100,
  };
  if (!t.open) {
    info.exit_price = t.exit.price;
    info.exit_bar_index = t.exit.bar;
    info.exit_time = t.exit.time;
  }
  return info;
}

/** Broker fields that are its setup, not its state: the engine a state is restored on has its own. */
const BROKER_SETUP = new Set(['bars', 'props', 'sym', 'intrabars', 'onIntrabar', 'long', 'short']);

/** What BrokerEngine.save() gives: the broker state (orders, trades, position, report records) and the equity. */
type EngineState = { broker: Record<string, unknown>; equity: number[] };

/** oakscriptjs StrategyEngine on the OpenTrader Broker. `equity` holds the equity at each bar close. */
export class BrokerEngine implements StrategyEngine {
  readonly broker: Broker;
  readonly equity: number[];

  constructor(
    private readonly bars: Bar[],
    readonly properties: StrategyProperties,
    symbol: SymbolInfo,
    intrabars?: readonly (readonly Bar[] | undefined)[],
  ) {
    this.broker = new Broker(bars, properties, symbol, intrabars);
    this.equity = new Array<number>(bars.length).fill(NaN);
  }

  processBar(bar: number): void {
    this.broker.processBar(bar);
    this.broker.readMarginUsed();
  }

  processClose(bar: number): void {
    if (this.properties.processOrdersOnClose) {
      this.broker.processClose(bar);
      this.broker.readMarginUsed();
    }
    // The average margin used leaves the last bar out (as runBacktest).
    if (bar < this.bars.length - 1) this.broker.countMarginUsed();
    this.equity[bar] = this.broker.equity;
  }

  entry(id: string, direction: StrategyDirection, o: StrategyEntryOptions): void {
    this.broker.entry(id, direction, { qty: o.qty, limit: o.limit, stop: o.stop, comment: o.comment, alertMessage: o.alert_message, ocaName: o.oca_name, ocaType: o.oca_type });
  }

  order(id: string, direction: StrategyDirection, o: StrategyEntryOptions): void {
    this.broker.order(id, direction, { qty: o.qty, limit: o.limit, stop: o.stop, comment: o.comment, alertMessage: o.alert_message, ocaName: o.oca_name, ocaType: o.oca_type });
  }

  risk(rule: StrategyRiskRule): void {
    switch (rule.rule) {
      case 'allow_entry_in':
      case 'max_intraday_loss':
      case 'max_intraday_filled_orders':
        this.broker.risk(rule);
        return;
      default:
        unsupported(`strategy.risk.${rule.rule}()`);
    }
  }

  exit(id: string, o: StrategyExitOptions): void {
    if (o.oca_name !== undefined) unsupported('strategy.exit(oca_name)');
    this.broker.exit(id, {
      fromEntry: o.from_entry,
      qty: o.qty,
      qtyPercent: o.qty_percent,
      profit: o.profit,
      loss: o.loss,
      limit: o.limit,
      stop: o.stop,
      trailPoints: o.trail_points,
      trailPrice: o.trail_price,
      trailOffset: o.trail_offset,
      comment: o.comment,
      commentProfit: o.comment_profit,
      commentLoss: o.comment_loss,
      commentTrailing: o.comment_trailing,
      alertMessage: o.alert_message,
      alertProfit: o.alert_profit,
      alertLoss: o.alert_loss,
      alertTrailing: o.alert_trailing,
    });
  }

  close(id: string, o: StrategyCloseOptions): void {
    if (o.immediately) unsupported('strategy.close(immediately = true)');
    this.broker.close(id, { comment: o.comment, alertMessage: o.alert_message, qty: o.qty, qtyPercent: o.qty_percent });
  }

  close_all(o: StrategyCloseAllOptions): void {
    if (o.immediately) unsupported('strategy.close_all(immediately = true)');
    this.broker.closeAll({ comment: o.comment, alertMessage: o.alert_message });
  }

  cancel(id: string): void {
    this.broker.cancel(id);
  }

  cancel_all(): void {
    this.broker.cancelAll();
  }

  get(variable: StrategyVariable): number | string | undefined {
    const b = this.broker;
    const { all, win, loss } = b.closedStats;
    const avg = (sum: number, count: number) => (count ? sum / count : NaN);
    const capital = this.properties.initialCapital;
    // Gross loss counts the entry commission of the open trades; net profit is gross profit - gross loss (the
    // reference app's values, binary noise included: 137,364.2600000007, not the running sum 137,364.2600000003).
    const grossLoss = () => -loss.profit + b.openEntryCommission;
    const netProfit = () => win.profit - grossLoss();
    switch (variable) {
      case 'position_size':
        return b.positionSize;
      case 'position_avg_price':
        return b.positionAvgPrice;
      case 'position_entry_name':
        return this.bars.length ? (b.openTradeReports()[0]?.entryId ?? '') : '';
      case 'equity':
        // No bar yet (compile dry run on zero bars): no open profit.
        return this.bars.length ? b.equity : capital + b.netProfit;
      case 'initial_capital':
        return capital;
      case 'netprofit':
        return netProfit();
      case 'netprofit_percent':
        return (netProfit() / capital) * 100;
      case 'openprofit':
        return this.bars.length ? b.scriptOpenProfit : 0;
      case 'openprofit_percent':
        return this.bars.length ? (b.scriptOpenProfit / (capital + netProfit())) * 100 : 0;
      case 'grossprofit':
        return win.profit;
      case 'grossprofit_percent':
        return (win.profit / capital) * 100;
      case 'grossloss':
        return grossLoss();
      case 'grossloss_percent':
        return (grossLoss() / capital) * 100;
      case 'opentrades':
        return b.openTradesCount;
      case 'closedtrades':
        return all.count;
      case 'wintrades':
        return win.count;
      case 'losstrades':
        return loss.count;
      case 'eventrades':
        return all.count - win.count - loss.count;
      case 'avg_trade':
        return avg(all.profit, all.count);
      case 'avg_trade_percent':
        return avg(all.percent, all.count);
      case 'avg_winning_trade':
        return avg(win.profit, win.count);
      case 'avg_winning_trade_percent':
        return avg(win.percent, win.count);
      case 'avg_losing_trade':
        return -avg(loss.profit, loss.count);
      case 'avg_losing_trade_percent':
        return -avg(loss.percent, loss.count);
      case 'max_contracts_held_all':
        return b.maxContractsHeld.all;
      case 'max_contracts_held_long':
        return b.maxContractsHeld.long;
      case 'max_contracts_held_short':
        return b.maxContractsHeld.short;
      case 'account_currency':
        return this.properties.currency;
      default:
        // max_drawdown(_percent), max_runup(_percent), margin_liquidation_price
        return undefined;
    }
  }

  openTrade(index: number): StrategyTrade | undefined {
    const t = this.bars.length ? this.broker.openTradeReports()[index] : undefined;
    return t && tradeInfo(t);
  }

  closedTrade(index: number): StrategyTrade | undefined {
    const t = this.broker.closedTrades[index];
    return t && tradeInfo(t);
  }

  /**
   * The state at the end of a bar, for a live update that calculates the newest bars only: every field of the
   * broker but its setup, copied as one graph (an open trade is in the open trades and in the exit legs: still one
   * trade once restored).
   */
  save(): unknown {
    const broker: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(this.broker)) if (!BROKER_SETUP.has(k)) broker[k] = v;
    return structuredClone({ broker, equity: this.equity } satisfies EngineState);
  }

  /** Puts back a state of save() on this engine (same script and properties, the bars it was saved on and newer
   *  ones). Copied again: the state is restored on each update until the next bar closes. */
  restore(state: unknown): void {
    const s = structuredClone(state as EngineState);
    Object.assign(this.broker, s.broker);
    const n = Math.min(s.equity.length, this.equity.length);
    for (let i = 0; i < n; i++) this.equity[i] = s.equity[i];
  }
}

/** A built-in strategy written as an OakScript script (src/backtester/scripts/). Its title, inputs and
 *  strategy() properties are the ones the script declares. */
export interface ScriptStrategy {
  /** Stable id, e.g. "ut-bot-v2". */
  key: string;
  /** Pine source this script follows (the reference app script id). */
  source: { id: string; name: string; author: string };
  /** The script body (oakscriptjs/script API). */
  body: () => void;
}

export interface OakScriptRunOptions {
  inputs?: Record<string, unknown>;
  /** Overrides of the script's strategy() properties (Strategy Tester / Properties tab). */
  properties?: Partial<StrategyProperties>;
  symbol?: Partial<SymbolInfo>;
  /** Chart context of the script (timeframe, session...); the symbol fields come from `symbol`. */
  chart?: ChartContext;
  /** Lower-timeframe bars (time ascending) for the bar magnifier (`barMagnifier` property). */
  intrabars?: Bar[];
  /** Period of the lower-timeframe bars, seconds (default: inferred from their times). */
  intrabarSeconds?: number;
  /** The chart shows Heikin Ashi bars of `bars` (see RunOptions.heikinAshi of run.ts). */
  heikinAshi?: boolean;
  /** Bars and properties of other symbols the script reads (`request.security` of another ticker). */
  symbols?: OtherSymbolData;
}

/** Bars of other symbols for `request.security` (keyed `symbol|timeframe` as the script asks) and the calendar and
 *  properties of each symbol: plain data, sent to the workers. */
export type OtherSymbolData = {
  bars: Record<string, Bar[]>;
  info: Record<string, ScriptSymbolInfo>;
};

/** The chart context with the accessors of the other symbols' bars (a request not in `symbols` is missing: the run
 *  ends with a MissingSymbolDataError listing it). */
export function chartWithSymbols(chart: ChartContext | undefined, symbols: OtherSymbolData | undefined): ChartContext {
  // request.seed reads the imported series of its symbol name (asked for like any other symbol).
  if (!symbols) return { ...chart, seedSymbol };
  return {
    ...chart,
    bars: (symbol, timeframe) => symbols.bars[`${symbol}|${timeframe}`],
    symbolInfo: (symbol) => symbols.info[symbol],
    seedSymbol,
  };
}

/** The bar of another symbol in a declaration run (no bars at all would be an invalid symbol). */
const DECLARATION_BAR: Bar = { time: 0, open: 0, high: 0, low: 0, close: 0, volume: 0 };

/**
 * Chart context of a declaration run (zero bars): what a script declares (title, inputs, plots, strategy()
 * properties) does not depend on the symbol, but the session functions (timeframe.change, time(tf, session)...)
 * need a session and a time zone to be called at all, and the symbol values (syminfo.mintick...) must be known to be
 * read. No bar is read, so the always-open session in UTC and the default symbol stand in for any symbol.
 */
export const DECLARATION_CHART: ChartContext = {
  timeframe: '1D',
  timezone: 'Etc/UTC',
  sessionType: 'regular',
  session: '24x7',
  mintick: DEFAULT_SYMBOL.mintick,
  pointvalue: DEFAULT_SYMBOL.pointValue,
  mincontract: DEFAULT_SYMBOL.qtyStep,
  // Another symbol of request.security runs on one empty bar.
  bars: () => [DECLARATION_BAR],
};

/**
 * The bars as a Pine script sees them: a daily, weekly or monthly bar is stamped at the open of its trading day's
 * regular session in the symbol's exchange zone (US equities: 09:30 New York, as the reference app's bars), not at
 * local midnight as the datafeed stamps them. Other bars (and bars not at local midnight) are unchanged. Only the
 * times the script reads change; the broker and the report keep the chart's bar times.
 */
export function scriptBars(bars: Bar[], chart: ChartContext | undefined): Bar[] {
  if (!chart?.timeframe || !/^\d*[DWM]$/i.test(chart.timeframe)) return bars;
  const tz = chart.timezone;
  const regular = chart.regularSession ?? chart.session;
  if (!tz || !regular) return bars;
  // With its corrections and holidays, a special session off the weekly calendar opens its own day.
  const spec = typeof regular === 'string'
    ? new SessionSpec(tz, regular)
    : new SessionSpec(tz, regular.session, [regular.holidays ?? ''].flat().join(','), regular.corrections ?? '');
  if (spec.always) return bars;
  return bars.map((b) => {
    const day = localDay(tz, b.time);
    if (localToUtc(tz, day, 0) !== b.time) return b;
    const open = spec.dayBounds(day)?.start;
    return open === undefined || open === b.time ? b : { ...b, time: open };
  });
}

/** The script's output back on the chart's bar times: every `time`, `time1`, `time2`... number in it (plots, candles,
 *  markers, bar / background colors, arrows, labels, lines, boxes, linefills, polylines, and the result fields of a
 *  library indicator such as the pivots of a zigzag). A time after the last bar (a drawing on a future bar) keeps its
 *  distance from the last bar. In place; an object reached twice (the lines of a linefill) moves once. */
export function restoreTimes(result: unknown, seen: Bar[], bars: Bar[]): void {
  const at = chartTimeOf(seen, bars);
  const done = new Set<object>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object' || done.has(node)) return;
    done.add(node);
    if (Array.isArray(node)) {
      // A packed list (lightweight-charts-indicators) reads each point as a new object: the point is written back.
      const packed = isPackedSeries(node);
      for (let i = 0; i < node.length; i++) {
        const item = node[i];
        walk(item);
        if (packed && item !== undefined) node[i] = item;
      }
      return;
    }
    const obj = node as Record<string, unknown>;
    for (const k in obj) {
      const v = obj[k];
      if (typeof v === 'number') {
        if (TIME_KEY.test(k)) obj[k] = at(v);
      } else if (v && typeof v === 'object') walk(v);
    }
  };
  walk(result);
}
const TIME_KEY = /^time\d*$/;

/** The chart time of a time the script saw (see restoreTimes). */
function chartTimeOf(seen: Bar[], bars: Bar[]): (t: number) => number {
  const back = new Map<number, number>();
  seen.forEach((b, i) => back.set(b.time, bars[i].time));
  const lastSeen = seen.length ? seen[seen.length - 1].time : NaN;
  const lastBar = bars.length ? bars[bars.length - 1].time : NaN;
  return (t) => back.get(t) ?? (t > lastSeen ? lastBar + (t - lastSeen) : t);
}

/** restoreTimes on a copy: the result of a live run shares its points with the next update's (which compares them
 *  with a full run's), so they keep the script's times. An object reached twice is copied once. `kept`: the copies
 *  of the plots' points made before, taken again for the same points (a live update copies the new points only; a
 *  resumed run gives its unchanged points again as the same objects). */
export function withChartTimes<T>(result: T, seen: Bar[], bars: Bar[], kept?: WeakMap<object, object>): T {
  const at = chartTimeOf(seen, bars);
  const copies = new Map<object, unknown>();
  const point = (p: unknown): unknown => {
    if (!kept || !p || typeof p !== 'object') return copy(p);
    let c = kept.get(p);
    if (!c) kept.set(p, (c = copy(p) as object));
    return c;
  };
  const copy = (node: unknown, plots = false): unknown => {
    if (!node || typeof node !== 'object') return node;
    const done = copies.get(node);
    if (done) return done;
    if (Array.isArray(node)) {
      const out: unknown[] = [];
      copies.set(node, out);
      for (const item of node) out.push(copy(item));
      return out;
    }
    const out: Record<string, unknown> = {};
    copies.set(node, out);
    const obj = node as Record<string, unknown>;
    for (const k in obj) {
      const v = obj[k];
      if (typeof v === 'number' && TIME_KEY.test(k)) out[k] = at(v);
      else if (plots && Array.isArray(v)) out[k] = v.map(point);
      else out[k] = copy(v, !plots && k === 'plots' && node === result);
    }
    return out;
  };
  return copy(result) as T;
}

export interface OakScriptRunResult {
  /** undefined when the script did not declare strategy() or did not run strategy.eachBar(). */
  report?: BacktestReport;
  /** Everything the script declared: inputs, plots, strategy properties. */
  script: ScriptRunResult;
}

/** The symbol fields a chart context carries (`timezone`, `mintick`). */
export function symbolOf(chart: ChartContext | undefined): Partial<SymbolInfo> {
  const out: Partial<SymbolInfo> = {};
  if (chart?.timezone) out.timezone = chart.timezone;
  if (chart?.mintick) out.mintick = chart.mintick;
  return out;
}

/** The bars of one calculation of a strategy, read by its engine factory (a live run keeps one factory for all its
 *  updates). */
interface StrategyPass {
  /** The chart bars, the bars the strategy runs on (Heikin Ashi or the chart bars) and the bars the script sees. */
  bars: Bar[];
  ha: Bar[];
  seen: Bar[];
  /** The bars the broker fills on. */
  fills: Bar[];
  /** The chart context of the intrabar runs. */
  chart: ChartContext;
  engine?: BrokerEngine;
}

/** The charted symbol of a run: the chart context carries its exchange zone and tick. */
function strategySymbol(opts: OakScriptRunOptions): SymbolInfo {
  return { ...DEFAULT_SYMBOL, ...symbolOf(opts.chart), ...opts.symbol };
}

/** The chart context of a strategy script: the chart's (with the accessors of other symbols' bars) and the symbol's. */
function strategyChart(chart: ChartContext, symbol: SymbolInfo): ChartContext {
  return { timezone: symbol.timezone, ...chart, mintick: symbol.mintick, pointvalue: symbol.pointValue, mincontract: symbol.qtyStep };
}

/** The strategy() properties a script declares: a run on zero bars (undefined when it declares none). */
function declaredProperties(body: () => void, opts: OakScriptRunOptions, chart: ChartContext, symbol: SymbolInfo): ScriptStrategyProperties | undefined {
  return executeScript(body, [], opts.inputs ?? {}, chart, {
    strategyEngine: ({ properties }) => new BrokerEngine([], brokerProperties(properties), symbol),
  }).strategyConfig;
}

/** The script options of a strategy on the broker: its engine on the bars of the current pass. With a recorder, the
 *  script runs again inside the bars when its properties ask for it. */
function strategyOptions(body: () => void, opts: OakScriptRunOptions, symbol: SymbolInfo, pass: StrategyPass, recorder?: StrategyRecorder): ScriptOptions {
  return {
    strategyEngine: ({ properties }) => {
      const props = { ...brokerProperties(properties), ...opts.properties };
      pass.fills = opts.heikinAshi && !props.fillOrdersOnStandardOhlc ? pass.ha : pass.bars;
      const magnify = props.barMagnifier && !opts.heikinAshi;
      const e = (pass.engine = new BrokerEngine(pass.fills, props, symbol, magnify ? binIntrabars(pass.fills, opts.intrabars, opts.intrabarSeconds) : undefined));
      // "On order fill" / "On history bar tick": the script runs again inside the bar, on the bars up to it.
      if (recorder && (props.calcOnOrderFills || props.calcOnEveryHistoryTick)) {
        const { seen, chart } = pass;
        e.broker.onIntrabar = (i, tick) => {
          const bar = { ...seen[i], high: tick.high, low: tick.low, close: tick.close, volume: tick.volume };
          executeIntrabar(body, [...seen.slice(0, i), bar], opts.inputs ?? {}, chart, { bar: i, lastBarIndex: seen.length - 1, engine: e, recorder });
        };
      }
      return e;
    },
    recorder,
  };
}

/**
 * Sets `pass` to the bars of a calculation; returns the chart context of the script run. `skipLast`: a realtime last
 * bar the script does not run on without calc_on_every_tick ("On realtime bar tick"); the broker still fills the
 * pending orders on it (see strategyResult).
 */
function setPass(pass: StrategyPass, bars: Bar[], opts: OakScriptRunOptions, chart: ChartContext, skipLast: boolean): ChartContext {
  pass.bars = bars;
  pass.ha = opts.heikinAshi ? heikinAshiBars(bars) : bars;
  pass.fills = bars;
  const seen = scriptBars(pass.ha, opts.chart);
  pass.seen = skipLast ? seen.slice(0, -1) : seen;
  pass.chart = chart;
  pass.engine = undefined;
  return skipLast ? { ...chart, realtime: false, lastBarConfirmed: true } : chart;
}

/** The report of a calculation, and the script's output on the chart's bar times. `copyTimes`: the output is a live
 *  run's (see withChartTimes). */
function strategyResult(pass: StrategyPass, script: ScriptRunResult, skipLast: boolean, t0: number, copyTimes: boolean): OakScriptRunResult {
  const engine = pass.engine;
  if (skipLast && engine && pass.seen.length) {
    const last = pass.bars.length - 1;
    engine.processBar(last);
    engine.equity[last] = engine.broker.equity;
  }
  if (pass.seen !== pass.ha) {
    if (copyTimes) script = { ...script, result: withChartTimes(script.result, pass.seen, pass.bars) };
    else restoreTimes(script.result, pass.seen, pass.bars);
  }
  const ran = engine !== undefined && !engine.equity.some(Number.isNaN);
  return { script, report: ran ? backtestReport(pass.fills, engine!.broker, engine!.equity, t0) : undefined };
}

/** Runs an OakScript strategy (a script body using oakscriptjs/script) on the OpenTrader broker. */
export function runOakScriptStrategy(body: () => void, bars: Bar[], opts: OakScriptRunOptions = {}): OakScriptRunResult {
  const t0 = performance.now();
  const symbol = strategySymbol(opts);
  const chart = strategyChart(chartWithSymbols(opts.chart, opts.symbols), symbol);
  // The declared "On realtime bar tick" is read from a zero-bar run.
  const realtime = chart.realtime === true && bars.length > 0;
  const everyTick = opts.properties?.calcOnEveryTick ?? (realtime ? (declaredProperties(body, opts, chart, symbol)?.calc_on_every_tick ?? false) : true);
  const skipLast = realtime && !everyTick;
  const pass = {} as StrategyPass;
  const runChart = setPass(pass, bars, opts, chart, skipLast);
  const recorder = new StrategyRecorder();
  const script = executeScript(body, pass.seen, opts.inputs ?? {}, runChart, strategyOptions(body, opts, symbol, pass, recorder));
  return strategyResult(pass, script, skipLast, t0, false);
}

/** A run of runOakScriptStrategy on each update of the chart bars (see createStrategyRun). */
export interface OakScriptStrategyRun {
  /** The strategy on `bars`, with why it calculated every bar (null: the newest bars only). */
  update(bars: Bar[], opts?: OakScriptRunOptions): OakScriptRunResult & { fullRunReason: string | null };
}

/** The run of one set of inputs, properties, symbol and lower-timeframe bars. */
type LiveStrategy = {
  fixed: string;
  intrabars: Bar[] | undefined;
  /** null: every update is a full run (`reason`). */
  run: ScriptRun | null;
  reason: string | null;
  everyTick: boolean;
  pass: StrategyPass;
  /** Bars of other symbols of the last update, read through accessors that stay the same (a new accessor is another
   *  chart context: a full run). */
  symbols: OtherSymbolData | undefined;
  barsOf: NonNullable<ChartContext['bars']>;
  infoOf: NonNullable<ChartContext['symbolInfo']>;
};

/**
 * A strategy that calculates only the newest bars on a live update (oakscriptjs createScriptRun): the broker state at
 * the last confirmed bar is put back (BrokerEngine.save / restore) and the bars from the forming bar are calculated
 * again; the report, the trades and the drawn outputs are those of runOakScriptStrategy on the same bars. Other inputs,
 * properties, symbol, Heikin Ashi or lower-timeframe bars start a new run. A strategy that runs inside the bars (on
 * order fills, on history ticks) calculates every bar. `verify`: see ScriptRunOptions.
 */
export function createStrategyRun(body: () => void, options: { verify?: number } = {}): OakScriptStrategyRun {
  let current: LiveStrategy | null = null;
  const start = (opts: OakScriptRunOptions, symbol: SymbolInfo, fixed: string): LiveStrategy => {
    const live: LiveStrategy = {
      fixed,
      intrabars: opts.intrabars,
      run: null,
      reason: null,
      everyTick: false,
      pass: {} as StrategyPass,
      symbols: opts.symbols,
      barsOf: (s, tf) => live.symbols?.bars[`${s}|${tf}`],
      infoOf: (s) => live.symbols?.info[s],
    };
    const declared = declaredProperties(body, opts, strategyChart(chartWithSymbols(opts.chart, opts.symbols), symbol), symbol);
    if (!declared) {
      live.reason = 'the script does not declare strategy()';
      return live;
    }
    const props = { ...brokerProperties(declared), ...opts.properties };
    live.everyTick = props.calcOnEveryTick;
    if (props.calcOnOrderFills || props.calcOnEveryHistoryTick) {
      live.reason = 'the strategy calculates again inside the bars (on order fills or on history ticks)';
      return live;
    }
    live.run = createScriptRun(body, opts.inputs ?? {}, {}, { ...strategyOptions(body, opts, symbol, live.pass), verify: options.verify });
    return live;
  };
  return {
    update(bars, opts = {}) {
      const t0 = performance.now();
      const symbol = strategySymbol(opts);
      const fixed = JSON.stringify([opts.inputs ?? {}, opts.properties ?? {}, symbol, opts.heikinAshi === true, opts.intrabarSeconds ?? null]);
      if (!current || current.fixed !== fixed || current.intrabars !== opts.intrabars) current = start(opts, symbol, fixed);
      const live = current;
      if (!live.run) return { ...runOakScriptStrategy(body, bars, opts), fullRunReason: live.reason };
      live.symbols = opts.symbols;
      const chart = strategyChart(opts.symbols ? { ...opts.chart, bars: live.barsOf, symbolInfo: live.infoOf, seedSymbol } : { ...opts.chart, seedSymbol }, symbol);
      const skipLast = chart.realtime === true && bars.length > 0 && !live.everyTick;
      const runChart = setPass(live.pass, bars, opts, chart, skipLast);
      const script = live.run.update(live.pass.seen, runChart);
      return { ...strategyResult(live.pass, script, skipLast, t0, true), fullRunReason: live.run.fullRunReason };
    },
  };
}
