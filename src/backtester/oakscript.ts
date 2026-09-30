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
 *   - strategy() properties that change fills and are not implemented by the Broker
 *     (calc_on_order_fills, use_bar_magnifier, backtest_fill_limits_assumption) throw when set;
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
import { backtestReport } from './run';
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
  if (p.use_bar_magnifier) throw new Error('strategy(use_bar_magnifier = true) is not supported by the OpenTrader broker');
  if (p.backtest_fill_limits_assumption !== 0) {
    throw new Error('strategy(backtest_fill_limits_assumption) is not supported by the OpenTrader broker');
  }
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
  ) {
    this.broker = new Broker(bars, properties, symbol);
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
    const closed = b.closedTrades;
    const wins = closed.filter((t) => t.profit > 0);
    const losses = closed.filter((t) => t.profit < 0);
    const sum = (xs: Trade[], f: (t: Trade) => number) => xs.reduce((s, t) => s + f(t), 0);
    const avg = (xs: Trade[], f: (t: Trade) => number) => (xs.length ? sum(xs, f) / xs.length : NaN);
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
        return sum(wins, (t) => t.profit);
      case 'grossprofit_percent':
        return (sum(wins, (t) => t.profit) / capital) * 100;
      case 'grossloss':
        return -sum(losses, (t) => t.profit);
      case 'grossloss_percent':
        return (-sum(losses, (t) => t.profit) / capital) * 100;
      case 'opentrades':
        return b.openTradesCount;
      case 'closedtrades':
        return closed.length;
      case 'wintrades':
        return wins.length;
      case 'losstrades':
        return losses.length;
      case 'eventrades':
        return closed.length - wins.length - losses.length;
      case 'avg_trade':
        return avg(closed, (t) => t.profit);
      case 'avg_trade_percent':
        return avg(closed, (t) => t.profitPercent * 100);
      case 'avg_winning_trade':
        return avg(wins, (t) => t.profit);
      case 'avg_winning_trade_percent':
        return avg(wins, (t) => t.profitPercent * 100);
      case 'avg_losing_trade':
        return -avg(losses, (t) => t.profit);
      case 'avg_losing_trade_percent':
        return -avg(losses, (t) => t.profitPercent * 100);
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

export interface OakScriptRunOptions {
  inputs?: Record<string, unknown>;
  /** Overrides of the script's strategy() properties (Strategy Tester / Properties tab). */
  properties?: Partial<StrategyProperties>;
  symbol?: Partial<SymbolInfo>;
  /** Chart context of the script (timeframe, session...); the symbol fields come from `symbol`. */
  chart?: ChartContext;
}

export interface OakScriptRunResult {
  /** undefined when the script did not declare strategy() or did not run strategy.eachBar(). */
  report?: BacktestReport;
  /** Everything the script declared: inputs, plots, strategy properties. */
  script: ScriptRunResult;
}

/** Runs an OakScript strategy (a script body using oakscriptjs/script) on the OpenTrader broker. */
export function runOakScriptStrategy(body: () => void, bars: Bar[], opts: OakScriptRunOptions = {}): OakScriptRunResult {
  const t0 = performance.now();
  const symbol = { ...DEFAULT_SYMBOL, ...opts.symbol };
  const chart: ChartContext = {
    timezone: symbol.timezone,
    ...opts.chart,
    mintick: symbol.mintick,
    pointvalue: symbol.pointValue,
    mincontract: symbol.qtyStep,
  };
  let engine: BrokerEngine | undefined;
  const script = executeScript(body, bars, opts.inputs ?? {}, chart, {
    strategyEngine: ({ properties }) =>
      (engine = new BrokerEngine(bars, { ...brokerProperties(properties), ...opts.properties }, symbol)),
  });
  const ran = engine !== undefined && !engine.equity.some(Number.isNaN);
  return { script, report: ran ? backtestReport(bars, engine!.broker, engine!.equity, t0) : undefined };
}
