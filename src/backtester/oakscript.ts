/**
 * OakScript strategies on the OpenTrader broker.
 *
 * `BrokerEngine` implements oakscriptjs's `StrategyEngine` with `Broker`: the script API
 * (`strategy()`, `strategy.eachBar()`, `strategy.entry()`...) forwards its calls here.
 * `runOakScriptStrategy` runs a script body and returns the same `BacktestReport` as `runBacktest`.
 *
 * Mapping:
 *   - order options: Pine names (from_entry, qty_percent, trail_points...) to the Broker options;
 *     alert_message / alert_* / disable_alert are ignored (no alerts in a backtest);
 *   - OCA groups, `strategy.close(immediately)`, risk rules and default_entry_qty are not
 *     implemented by the Broker: they throw;
 *   - calc_on_order_fills is not implemented (an extra script run inside processBar): it throws when set;
 *   - variables: the Broker state; trade statistics from its closed trades (Pine definitions,
 *     percent in %); max_drawdown / max_runup / margin_liquidation_price are not provided
 *     during the run (the report computes the drawdown at the end).
 */
import {
  executeScript,
  type ChartContext,
  type ScriptRunResult,
  type StrategyCloseAllOptions,
  type StrategyCloseOptions,
  type StrategyDirection,
  type StrategyEngine,
  type StrategyEntryOptions,
  type StrategyExitOptions,
  type StrategyProperties as ScriptStrategyProperties,
  type StrategyTrade,
  type StrategyVariable,
} from 'oakscriptjs/script';
import { Broker } from './broker';
import { backtestReport, binIntrabars, heikinAshiBars } from './run';
import { SessionSpec } from '../data/session/spec';
import { localDay, localToUtc } from '../data/session/zone';
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
  if (p.calc_on_order_fills) throw new Error('strategy(calc_on_order_fills = true) is not supported by the OpenTrader broker');
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
    calcOnOrderFills: false,
    calcOnEveryTick: p.calc_on_every_tick ?? false,
    calcOnEveryHistoryTick: false,
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
  }

  processClose(bar: number): void {
    if (this.properties.processOrdersOnClose) this.broker.processClose(bar);
    this.equity[bar] = this.broker.equity;
  }

  entry(id: string, direction: StrategyDirection, o: StrategyEntryOptions): void {
    if (o.oca_name !== undefined || o.oca_type !== undefined) unsupported('strategy.entry(oca_name, oca_type)');
    this.broker.entry(id, direction, { qty: o.qty, limit: o.limit, stop: o.stop, comment: o.comment });
  }

  order(id: string, direction: StrategyDirection, o: StrategyEntryOptions): void {
    if (o.oca_name !== undefined || o.oca_type !== undefined) unsupported('strategy.order(oca_name, oca_type)');
    this.broker.order(id, direction, { qty: o.qty, limit: o.limit, stop: o.stop, comment: o.comment });
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
    });
  }

  close(id: string, o: StrategyCloseOptions): void {
    if (o.immediately) unsupported('strategy.close(immediately = true)');
    this.broker.close(id, { comment: o.comment, qty: o.qty, qtyPercent: o.qty_percent });
  }

  close_all(o: StrategyCloseAllOptions): void {
    if (o.immediately) unsupported('strategy.close_all(immediately = true)');
    this.broker.closeAll({ comment: o.comment });
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
        return b.netProfit;
      case 'netprofit_percent':
        return (b.netProfit / capital) * 100;
      case 'openprofit':
        return this.bars.length ? b.openProfit : 0;
      case 'openprofit_percent':
        return this.bars.length ? (b.openProfit / (capital + b.netProfit)) * 100 : 0;
      case 'grossprofit':
        return win.profit;
      case 'grossprofit_percent':
        return (win.profit / capital) * 100;
      case 'grossloss':
        return -loss.profit;
      case 'grossloss_percent':
        return (-loss.profit / capital) * 100;
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
}

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
  if (!tz || typeof regular !== 'string') return bars;
  const spec = new SessionSpec(tz, regular);
  if (spec.always) return bars;
  return bars.map((b) => {
    const day = localDay(tz, b.time);
    if (localToUtc(tz, day, 0) !== b.time) return b;
    const open = spec.dayBounds(day)?.start;
    return open === undefined || open === b.time ? b : { ...b, time: open };
  });
}

/** The script's drawing output back on the chart's bar times (plots, markers, bar / background colors, arrows). */
function restoreTimes(result: unknown, seen: Bar[], bars: Bar[]): void {
  const back = new Map<number, number>();
  seen.forEach((b, i) => back.set(b.time, bars[i].time));
  const fix = (items: unknown) => {
    if (!Array.isArray(items)) return;
    for (const item of items as { time?: number }[]) {
      const t = item && typeof item.time === 'number' ? back.get(item.time) : undefined;
      if (t !== undefined) item.time = t;
    }
  };
  const r = result as Record<string, unknown>;
  for (const series of Object.values((r.plots ?? {}) as Record<string, unknown>)) fix(series);
  fix(r.markers);
  fix(r.bgcolors);
  fix(r.barcolors);
  fix(r.arrows);
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

/** Runs an OakScript strategy (a script body using oakscriptjs/script) on the OpenTrader broker. */
export function runOakScriptStrategy(body: () => void, bars: Bar[], opts: OakScriptRunOptions = {}): OakScriptRunResult {
  const t0 = performance.now();
  // The chart context carries the charted symbol's exchange zone and tick.
  const symbol = { ...DEFAULT_SYMBOL, ...symbolOf(opts.chart), ...opts.symbol };
  const chart: ChartContext = {
    timezone: symbol.timezone,
    ...opts.chart,
    mintick: symbol.mintick,
    pointvalue: symbol.pointValue,
    mincontract: symbol.qtyStep,
  };
  let engine: BrokerEngine | undefined;
  let fills = bars;
  const ha = opts.heikinAshi ? heikinAshiBars(bars) : bars;
  let seen = scriptBars(ha, opts.chart);
  // A realtime last bar: the script does not run on it without calc_on_every_tick ("On realtime bar tick"); the
  // broker still fills the pending orders on it below. The declared property is read from a zero-bar run.
  const realtime = chart.realtime === true && bars.length > 0;
  const everyTick =
    opts.properties?.calcOnEveryTick ??
    (realtime
      ? (executeScript(body, [], opts.inputs ?? {}, chart, {
          strategyEngine: ({ properties }) => new BrokerEngine([], brokerProperties(properties), symbol),
        }).strategyConfig?.calc_on_every_tick ?? false)
      : true);
  const skipLast = realtime && !everyTick;
  if (skipLast) seen = seen.slice(0, -1);
  const script = executeScript(body, seen, opts.inputs ?? {}, skipLast ? { ...chart, realtime: false, lastBarConfirmed: true } : chart, {
    strategyEngine: ({ properties }) => {
      const props = { ...brokerProperties(properties), ...opts.properties };
      fills = opts.heikinAshi && !props.fillOrdersOnStandardOhlc ? ha : bars;
      const magnify = props.barMagnifier && !opts.heikinAshi;
      return (engine = new BrokerEngine(fills, props, symbol, magnify ? binIntrabars(fills, opts.intrabars, opts.intrabarSeconds) : undefined));
    },
  });
  if (skipLast && engine && seen.length) {
    const last = bars.length - 1;
    engine.processBar(last);
    engine.equity[last] = engine.broker.equity;
  }
  if (seen !== ha) restoreTimes(script.result, seen, bars);
  const ran = engine !== undefined && !engine.equity.some(Number.isNaN);
  return { script, report: ran ? backtestReport(fills, engine!.broker, engine!.equity, t0) : undefined };
}
