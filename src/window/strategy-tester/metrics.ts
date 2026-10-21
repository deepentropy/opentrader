/*
 * Metrics the Strategy Tester shows that are not fields of the report. Each
 * formula was checked against the numbers the reference app 3.4.1 displayed for a
 * captured report (.tmp/backtester/design, Supertrend strategy on
 * BATS:BE 1D, 30/09/2026). Metrics whose formula could not be matched are
 * not shown (see the design doc "Open").
 */
import type { BacktestReport, MarginPoint, MarginUsage, Trade } from "../../backtester/types";
import { runupDrawdownPeriods, type EquityPeriod } from "./equity-data";
import { zoneFormat } from "./format";

const closedTrades = (r: BacktestReport) => r.trades.filter((t) => !t.open);

/** Total PnL = net profit + open PnL (133,192.13 = 129,974.00 + 3,218.13). */
export function totalPnl(r: BacktestReport): number {
  return r.performance.all.netProfit + r.performance.openPL;
}

/** PnL of every trade (open ones included) grouped by entry signal or side;
 *  the first row is the total. Matched: +152,119.50 / −18,927.37. */
export type PnlRow = { label: string; pnl: number; profitSum: number; lossSum: number; commission: number };

export function pnlBy(r: BacktestReport, by: "signal" | "side"): PnlRow[] {
  const rows = new Map<string, PnlRow>();
  const add = (label: string, t: Trade) => {
    let row = rows.get(label);
    if (!row) rows.set(label, (row = { label, pnl: 0, profitSum: 0, lossSum: 0, commission: 0 }));
    row.pnl += t.profit;
    if (t.profit >= 0) row.profitSum += t.profit;
    else row.lossSum -= t.profit;
    row.commission += t.commission;
  };
  for (const t of r.trades) {
    add(by === "signal" ? "All signals" : "Both sides", t);
    add(by === "signal" ? t.entry.signal : t.direction === "long" ? "Longs" : "Shorts", t);
  }
  const order = by === "side" ? ["Both sides", "Longs", "Shorts"] : null;
  const list = [...rows.values()];
  return order ? order.map((l) => rows.get(l)).filter((x): x is PnlRow => !!x) : list;
}

/** Win / loss streaks over closed trades in exit order (7 / 5, 2.5 / 1.9). */
export function streaks(r: BacktestReport): { longestWin: number; longestLoss: number; avgWin: number | null; avgLoss: number | null } {
  const seq = closedTrades(r)
    .slice()
    .sort((a, b) => a.exit.time - b.exit.time)
    .map((t) => Math.sign(t.profit));
  const runs: [number, number][] = [];
  for (const s of seq) {
    const last = runs[runs.length - 1];
    if (last && last[0] === s) last[1]++;
    else runs.push([s, 1]);
  }
  const win = runs.filter(([s]) => s > 0).map(([, n]) => n);
  const loss = runs.filter(([s]) => s < 0).map(([, n]) => n);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return { longestWin: Math.max(0, ...win), longestLoss: Math.max(0, ...loss), avgWin: avg(win), avgLoss: avg(loss) };
}

/** CAGR from the net profit over the testing period, 365-day years (+10.71%); 0 under 30 days or for a
 *  non-positive final equity. */
export function cagr(r: BacktestReport): number {
  return annualized(r.performance.all.netProfit, r.properties.initialCapital, r);
}

/**
 * Outliers: closed trades whose return is more than 2 standard deviations
 * from the mean return (the 3 trades above 106.07% gave Outliers PnL
 * 112,407.28 and "Average profit" 21.63% without them). Population and
 * sample deviation gave the same split on the captured report.
 */
export function outliers(r: BacktestReport): { pnl: number; trades: Trade[] } {
  // A trade closed at price 0 has no return (NaN): it is left out.
  const closed = closedTrades(r).filter((t) => !Number.isNaN(t.profitPercent));
  if (closed.length < 2) return { pnl: 0, trades: [] };
  // Mean and sample deviation (the reference app's running computation).
  let mean = 0;
  let m2 = 0;
  closed.forEach((t, i) => {
    const d = t.profitPercent - mean;
    mean += d / (i + 1);
    m2 += d * (t.profitPercent - mean);
  });
  const sd = Math.sqrt(m2 / (closed.length - 1));
  if (sd === 0) return { pnl: 0, trades: [] };
  const out = closed.filter((t) => Math.abs(t.profitPercent - mean) > 2 * sd);
  return { pnl: out.reduce((a, t) => a + t.profit, 0), trades: out };
}

/** Month names, January first (Best month for entries). */
export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// ---------------------------------------------------------------------------
// Derived report metrics, as the reference app's report converter adds them
// to the server report. Checked on the 87 reference reports of
// .tmp/backtester (8 datasets, 5 min to 1 W) against the converter's own
// output (.tmp/backtester/derived).

export type SideKey = "all" | "long" | "short";
const SIDES: SideKey[] = ["all", "long", "short"];
const div = (a: number, b: number) => (b === 0 ? 0 : a / b);
const num = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? 0 : v);

/** The trades of a side (all = every trade). */
const sideTrades = (r: BacktestReport, side: SideKey) => (side === "all" ? r.trades : r.trades.filter((t) => t.direction === side));

/** CAGR of a net profit over the report period: 0 under 30 days or for a
 *  non-positive final equity. */
function annualized(net: number, capital: number, r: BacktestReport): number {
  const days = (r.range.to - r.range.from) / 86_400_000;
  if (capital === 0 || !(r.range.to > r.range.from) || days < 30) return 0;
  const end = capital + net;
  return end <= 0 || capital <= 0 ? 0 : Math.pow(end / capital, 365 / days) - 1;
}

/** Margin calls' volume: the quantity x exit price of the trades a margin
 *  call closed; the largest one sums the trades closed at one price and time. */
function liquidated(trades: Trade[]): { total: number; largest: number } {
  let total = 0;
  let largest = 0;
  let event = 0;
  let at: string | null = null;
  for (const t of trades) {
    if (t.open || t.exit.signal !== "Margin call") continue;
    const key = `${t.exit.price}@${t.exit.time}`;
    if (key !== at) {
      event = 0;
      at = key;
    }
    const v = t.qty * t.exit.price;
    total += v;
    event += v;
    largest = Math.max(largest, event);
  }
  return { total, largest };
}

/** Buy & hold equity before the first trade and after each closed trade:
 *  whole shares bought with the initial capital at the first entry price,
 *  valued at the trade's exit price; trailing open trades repeat the final
 *  buy & hold equity. */
export function tradeBuyHold(r: BacktestReport): number[] {
  const cap = r.properties.initialCapital;
  const closed = closedTrades(r);
  const first = closed[0] ?? r.trades.find((t) => t.open);
  if (!first) return [];
  const shares = Math.floor(cap / first.entry.price);
  const out = [cap, ...closed.map((t) => cap + shares * (t.exit.price - first.entry.price))];
  for (let i = closed.length; i < r.trades.length; i++) out.push(cap + r.performance.buyHoldReturn);
  return out;
}

/** Correlation of each closed trade's PnL with the buy & hold change over it. */
export function correlation(r: BacktestReport): number | undefined {
  const bh = tradeBuyHold(r);
  if (bh.length < 2) return undefined;
  const avgTrade = num(r.performance.all.avgTrade);
  const avgBh = (bh[bh.length - 1] - bh[0]) / (bh.length - 1);
  let cov = 0;
  let vt = 0;
  let vb = 0;
  for (let i = 0; i < r.trades.length && !r.trades[i].open; i++) {
    const a = r.trades[i].profit - avgTrade;
    const b = bh[i + 1] - bh[i] - avgBh;
    cov += a * b;
    vt += a * a;
    vb += b * b;
  }
  const c = cov / Math.sqrt(vt * vb);
  return Number.isFinite(c) ? c : undefined;
}

/** Run-up and drawdown periods of the closed-trade PnL (exit times, UNIX ms). */
export function growthPeriods(r: BacktestReport): EquityPeriod[] {
  const samples = r.trades.map((t) => ({ time: t.exit.time, value: t.cumProfit, delta: t.profit, pending: t.open }));
  return runupDrawdownPeriods(samples, r.properties.initialCapital);
}

export type GrowthStats = Record<
  `${"average" | "max"}${"Runup" | "Drawdown"}${"" | "Percent"}` | `average${"Runup" | "Drawdown"}Duration`,
  number | null
>;

/** Average / largest run-up and drawdown periods (close to close): mean change
 *  and relative change, mean duration (ms, rounded down), the largest change
 *  with its relative change. */
export function growthStats(r: BacktestReport, periods = growthPeriods(r)): GrowthStats {
  const out = {} as GrowthStats;
  for (const [type, name] of [["runup", "Runup"], ["drawdown", "Drawdown"]] as const) {
    const ps = periods.filter((p) => p.type === type);
    let max: EquityPeriod | null = null;
    for (const p of ps) if (!max || p.change > max.change) max = p;
    const n = ps.length;
    const sum = (f: (p: EquityPeriod) => number) => ps.reduce((s, p) => s + f(p), 0);
    out[`average${name}`] = n ? sum((p) => p.change) / n : null;
    out[`average${name}Percent`] = n ? sum((p) => p.relativeChange) / n : null;
    out[`average${name}Duration`] = n ? Math.floor(sum((p) => p.endTime - p.startTime) / n) : null;
    out[`max${name}`] = max && max.change > 0 ? max.change : n ? 0 : null;
    out[`max${name}Percent`] = max && max.change > 0 ? max.relativeChange : n ? 0 : null;
  }
  return out;
}

export type TimeUnit = "hour" | "day" | "month";
export type EntryBuckets = Record<TimeUnit, { winning: number; losing: number }[]>;
const DETAIL = ["hour", "day", "week", "month", "quarter", "year"] as const;
export type Detail = (typeof DETAIL)[number];

/** The details of `list` a chart interval allows (none finer than the interval: a 1 D chart reads by week). */
export function allowedDetails<T extends Detail>(intervalSec: number, list: readonly T[]): T[] {
  const level = detailLevel(intervalSec);
  return list.filter((d) => DETAIL.indexOf(d) >= level);
}

/** Finest detail a chart interval allows: an interval of a day reads by week,
 *  1 or 2 months by quarter. */
function detailLevel(intervalSec: number): number {
  const ms = intervalSec * 1000;
  if (ms < 3_600_000) return 0;
  if (ms < 86_400_000) return 1;
  if (ms < 604_800_000) return 2;
  if (ms < 2_419_200_000) return 3;
  if (ms < 7_689_600_000) return 4;
  return 5;
}

/**
 * Winning / losing trades (open ones included, breakevens left out) by entry
 * hour (0-23), weekday (0 = Sunday) and month (0 = January), for the units the
 * chart interval allows (no hour from 1 h up, no weekday from 1 D up). On
 * intraday charts the times read in the local time zone, on D / W / M charts
 * as the trading day in the exchange zone.
 */
export function entryBuckets(r: BacktestReport, intervalSec: number, timeZone: string): EntryBuckets {
  const out: EntryBuckets = { hour: [], day: [], month: [] };
  const size = { hour: 24, day: 7, month: 12 };
  for (const u of allowedDetails(intervalSec, ["hour", "day", "month"] as const)) out[u] = Array.from({ length: size[u] }, () => ({ winning: 0, losing: 0 }));
  const dwm = intervalSec >= 86_400;
  const dayOf = dwm ? zoneFormat("en-US", { year: "numeric", month: "numeric", day: "numeric" }, timeZone) : null;
  for (const t of r.trades) {
    if (t.profit === 0) continue;
    const d = new Date(t.entry.time);
    let at: Record<TimeUnit, number>;
    if (dayOf) {
      const p = Object.fromEntries(dayOf.formatToParts(d).map((x) => [x.type, Number(x.value)]));
      const day = new Date(Date.UTC(p.year, p.month - 1, p.day));
      at = { hour: d.getHours(), day: day.getUTCDay(), month: day.getUTCMonth() };
    } else at = { hour: d.getHours(), day: d.getDay(), month: d.getMonth() };
    for (const u of ["hour", "day", "month"] as const) {
      const b = out[u][at[u]];
      if (b) t.profit > 0 ? b.winning++ : b.losing++;
    }
  }
  // No trade counted: no buckets at all.
  const any = (["hour", "day", "month"] as const).some((u) => out[u].some((b) => b.winning > 0 || b.losing > 0));
  return any ? out : { hour: [], day: [], month: [] };
}

/** The bucket with the best win rate (the first of equal ones); undefined
 *  without a winning trade. */
export function bestEntry(buckets: EntryBuckets, unit: TimeUnit): { index: number; winRate: number } | undefined {
  const bs = buckets[unit];
  if (!bs.some((b) => b.winning > 0)) return undefined;
  let best = { index: -1, winRate: 0 };
  bs.forEach((b, index) => {
    const rate = b.winning / (b.winning + b.losing);
    if (best.winRate < rate) best = { index, winRate: rate };
  });
  return best;
}

/** Fields of the report converter per side (the reference app names). */
export function derivedPerformance(r: BacktestReport): Record<SideKey, Record<string, number | undefined>> {
  const p = r.performance;
  const cap = r.properties.initialCapital;
  const maxDd = num(p.maxStrategyDrawDown);
  const account = num(p.maxMarginUsed) + maxDd;
  const outs = outliers(r).trades;
  const out = {} as Record<SideKey, Record<string, number | undefined>>;
  for (const side of SIDES) {
    const s = p[side];
    const net = num(s.netProfit);
    const largestLoss = num(s.largestLosTrade);
    const o = outs.filter((t) => side === "all" || t.direction === side);
    const liq = liquidated(sideTrades(r, side));
    out[side] = {
      // (net profit + open P&L) / average margin used, 0 without margin.
      marginEfficiency: div(net + num(p.openPL), num(p.avgMarginUsed)),
      returnOnAccount: div(net, account),
      annualizedReturn: annualized(net, cap, r),
      returnOnInitialCapital: div(net, cap),
      returnOfMaxEquityDrawdown: maxDd === 0 ? 0 : (net + num(p.openPL)) / Math.abs(maxDd),
      netProfitAsPercentOfLargestLoss: largestLoss === 0 ? 0 : net / Math.abs(largestLoss),
      largestWinnerAsPercentOfGrossProfit: div(num(s.largestWinTrade), num(s.grossProfit)),
      largestLoserAsPercentOfGrossLoss: num(s.grossLoss) === 0 ? 0 : Math.abs(largestLoss) / Math.abs(num(s.grossLoss)),
      outliersCount: o.length,
      outliersPnL: o.reduce((a, t) => a + t.profit, 0),
      outliersPnLPercent: div(o.reduce((a, t) => a + t.profit, 0), cap),
      totalLiquidatedVolume: liq.total,
      largestLiquidatedVolume: liq.largest,
    };
  }
  const net = num(p.all.netProfit);
  const outperformance = net - num(p.buyHoldReturn);
  Object.assign(out.all, {
    accountSizeRequired: account,
    maxEquityRunUpAsPercentOfInitialCapital: div(num(p.maxStrategyRunUp), cap),
    maxEquityDrawdownAsPercentOfInitialCapital: cap === 0 ? 0 : Math.abs(maxDd) / cap,
    strategyOutperformance: outperformance,
    strategyOutperformancePercent: div(outperformance, cap),
    totalProfit: net + num(p.openPL),
    totalProfitPercent: div(net + num(p.openPL), cap),
    commissionLoadPercent: div(num(p.all.commissionPaid), num(p.all.grossProfit)),
    strategyAndBuyHoldCorrelation: correlation(r),
  });
  return out;
}

/** Winners / losers / breakevens among closed trades (27 / 21 / 0). */
export function distribution(r: BacktestReport): { total: number; winners: number; losers: number; breakevens: number } {
  const c = closedTrades(r);
  const winners = c.filter((t) => t.profit > 0).length;
  const losers = c.filter((t) => t.profit < 0).length;
  return { total: c.length, winners, losers, breakevens: c.length - winners - losers };
}

/** Cumulative PnL curve: one point per trade at its exit time (the open trade
 *  at the last bar), starting at 0. The reference app's last point = Total PnL
 *  (133,192.12 on the captured report). */
export function equityPoints(r: BacktestReport): { time: number; value: number; buyHold: number }[] {
  const pts: { time: number; value: number; buyHold: number }[] = [];
  const trades = r.trades;
  if (!trades.length) return pts;
  pts.push({ time: trades[0].entry.time / 1000, value: 0, buyHold: 0 });
  for (const t of trades) {
    const time = t.exit.time / 1000;
    const p = { time, value: t.cumProfit, buyHold: r.buyHold[t.exit.bar] ?? 0 };
    // Several records can close on one bar (partial exits): keep the last.
    if (pts[pts.length - 1].time >= time) pts[pts.length - 1] = p;
    else pts.push(p);
  }
  return pts;
}

// ---------------------------------------------------------------------------
// Data of the report tab charts, as the reference app's report converter
// builds it (its calculators: periodicals 436164, benchmarking 574000,
// streaks 947126 / 88522; the returns histogram 754610; the growth and
// decline comparison 392642; the margin usage chart 151996).

export type BucketDetail = "day" | "week" | "quarter" | "year";
export const BUCKET_DETAILS: readonly BucketDetail[] = ["day", "week", "quarter", "year"];
/** One bar of a periodical chart: the bucket start (UNIX seconds, UTC) and its values. */
export type BucketBar = { time: number; values: number[] };

/** Start of the UTC day / week (from Sunday) / quarter / year holding `ms`, UNIX seconds. */
export function bucketStart(ms: number, d: BucketDetail): number {
  const t = new Date(ms);
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth();
  if (d === "day") return Date.UTC(y, m, t.getUTCDate()) / 1000;
  if (d === "week") return Date.UTC(y, m, t.getUTCDate() - t.getUTCDay()) / 1000;
  if (d === "quarter") return Date.UTC(y, 3 * Math.floor(m / 3), 1) / 1000;
  return Date.UTC(y, 0, 1) / 1000;
}

function nextBucket(sec: number, d: BucketDetail): number {
  if (d === "day") return sec + 86_400;
  if (d === "week") return sec + 604_800;
  const t = new Date(sec * 1000);
  const y = t.getUTCFullYear();
  return (d === "quarter" ? Date.UTC(y, t.getUTCMonth() + 3, 1) : Date.UTC(y + 1, 0, 1)) / 1000;
}

/** The buckets between two bars as empty slots (the time axis keeps one slot per bucket). */
export function withEmptyBuckets(bars: BucketBar[], d: BucketDetail): (BucketBar | { time: number })[] {
  const out: (BucketBar | { time: number })[] = [];
  bars.forEach((b, i) => {
    out.push(b);
    const next = bars[i + 1];
    if (next) for (let s = nextBucket(b.time, d); s < next.time; s = nextBucket(s, d)) out.push({ time: s });
  });
  return out;
}

/** Closed trades in the bucket of their exit time, per detail the chart interval allows; `add` gets the trade's
 *  bucket, created with `size` zeros when the trade starts a new one. */
function byBucket(
  r: BacktestReport,
  intervalSec: number,
  size: number,
  start: () => void,
  add: (bar: BucketBar, t: Trade, index: number, created: boolean) => void,
): Record<BucketDetail, BucketBar[]> {
  const out: Record<BucketDetail, BucketBar[]> = { day: [], week: [], quarter: [], year: [] };
  for (const d of allowedDetails(intervalSec, BUCKET_DETAILS)) {
    start();
    const bars = out[d];
    r.trades.forEach((t, i) => {
      if (t.open) return;
      const time = bucketStart(t.exit.time, d);
      let bar = bars[bars.length - 1];
      const created = !bar || bar.time !== time;
      if (created) bars.push((bar = { time, values: new Array<number>(size).fill(0) }));
      add(bar, t, i, created);
    });
  }
  return out;
}

/**
 * Periodical PnL (Weekly / Quarterly / Yearly PnL chart): the running PnL of
 * the closed trades of each bucket gives [its highest point (favorable
 * excursion, 0 or more), the final PnL if positive (realized profit), its
 * lowest point (adverse excursion, 0 or less), the final PnL if negative
 * (realized loss)].
 */
export function periodicals(r: BacktestReport, intervalSec: number): Record<BucketDetail, BucketBar[]> {
  let sum = 0;
  return byBucket(r, intervalSec, 4, () => (sum = 0), (bar, t, _i, created) => {
    if (created) sum = 0;
    sum += t.profit;
    const v = bar.values;
    bar.values = [Math.max(v[0], sum), Math.max(0, sum), Math.min(v[2], sum), Math.min(0, sum)];
  });
}

/**
 * Strategy vs benchmark: per bucket [the PnL of its closed trades, the buy &
 * hold PnL change from the previous bucket's last trade to its own last
 * trade] (tradeBuyHold).
 */
export function benchmarking(r: BacktestReport, intervalSec: number): Record<BucketDetail, BucketBar[]> {
  const bh = tradeBuyHold(r);
  let previous = 0;
  let current = 0;
  return byBucket(r, intervalSec, 2, () => (previous = current = bh[0] ?? 0), (bar, t, i, created) => {
    if (created) previous = current;
    bar.values[0] += t.profit;
    const b = bh[i + 1];
    if (b !== undefined) {
      current = b;
      bar.values[1] = b - previous;
    }
  });
}

export type StreakBar = { value: number; tradeNumber: number; short: boolean; profit: number; profitPercent: number; closeTime: number };

/**
 * Winning and losing streaks: one bar per closed trade, the length of the
 * streak it extends (Count: + for winners, - for losers) or the streak's PnL
 * so far (Amount). A breakeven trade ends the streak and stands at 0.
 */
export function streakBars(r: BacktestReport): { count: StreakBar[]; amount: StreakBar[] } {
  const count: StreakBar[] = [];
  const amount: StreakBar[] = [];
  let winner: boolean | null = null;
  let length = 0;
  let sum = 0;
  r.trades.forEach((t, i) => {
    if (t.open) return;
    const info = { tradeNumber: i + 1, short: t.direction === "short", profit: t.profit, profitPercent: Number.isNaN(t.profitPercent) ? 0 : t.profitPercent, closeTime: t.exit.time };
    if (t.profit === 0) {
      winner = null;
      length = sum = 0;
      count.push({ value: 0, ...info });
      amount.push({ value: 0, ...info });
      return;
    }
    const win = t.profit > 0;
    if (win === winner) {
      length++;
      sum += t.profit;
    } else {
      winner = win;
      length = 1;
      sum = t.profit;
    }
    count.push({ value: win ? length : -length, ...info });
    amount.push({ value: sum, ...info });
  });
  return { count, amount };
}

export type ReturnBin = {
  rangeStart: number;
  rangeEnd: number;
  rangeMiddle: number;
  isProfit: boolean;
  tradesCount: number;
  /** Lowest / highest outlier return beyond the first / last bin. */
  originalRangeStart?: number;
  originalRangeEnd?: number;
};

/** Closed trades' returns (a trade closed at price 0 has none), outliers apart, ascending. */
function returnSamples(r: BacktestReport): { core: number[]; outliers: number[] } {
  const outs = new Set(outliers(r).trades);
  const core: number[] = [];
  const rest: number[] = [];
  for (const t of closedTrades(r)) {
    if (Number.isNaN(t.profitPercent)) continue;
    (outs.has(t) ? rest : core).push(t.profitPercent);
  }
  const asc = (a: number, b: number) => a - b;
  return { core: core.sort(asc), outliers: rest.sort(asc) };
}

/** Number of bins (Freedman-Diaconis on the sorted returns; square-root rule when the quartiles meet). */
function binCount(v: number[]): number {
  const n = v.length;
  if (n === 0) return 1;
  const iqr = v[Math.floor(0.75 * n)] - v[Math.floor(0.25 * n)];
  const width = iqr < 1e-4 ? (v[n - 1] - v[0]) / Math.ceil(Math.sqrt(n)) : (2 * iqr) / Math.pow(n, 1 / 3);
  const c = width === 0 ? 0 : Math.ceil((v[n - 1] - v[0]) / width);
  return c === 1 && v[n - 1] > 0 && v[0] < 0 ? 2 : c;
}

/**
 * Returns distribution: bins of one width on both sides of 0 (loss bins up
 * to it, profit bins from it), shared out by the sizes of the loss and
 * profit ranges; the width fits the larger side. Outliers count in the first
 * / last bin when they reach it, which then keeps their extreme return.
 */
export function returnBins(r: BacktestReport): ReturnBin[] {
  const { core, outliers: outs } = returnSamples(r);
  const count = binCount(core);
  if (!core.length || count === 0) return [];
  let min = core[0];
  let max = core[core.length - 1];
  if (min === max) {
    min -= 0.1;
    max += 0.1;
  }
  const neg = min < 0 ? Math.abs(min) : 0;
  const pos = max > 0 ? max : 0;
  const posBins = pos === 0 ? 0 : count === 1 && neg === 0 ? 1 : Math.ceil((count - 1) / (1 + neg / pos));
  const negBins = count - posBins;
  const pw = posBins === 0 ? 0 : pos / posBins;
  const nw = negBins === 0 ? 0 : neg / negBins;
  const width = pw && nw ? Math.max(pw, nw) : pw || nw;
  const bins: ReturnBin[] = Array.from({ length: count }, (_, i) => {
    const loss = i < negBins;
    // 0 - x, not -x: no -0 bound.
    const rangeStart = loss ? 0 - (negBins - i) * width : (i - negBins) * width;
    const rangeEnd = loss ? 0 - (negBins - i - 1) * width : (i - negBins + 1) * width;
    return { rangeStart, rangeEnd, rangeMiddle: (rangeStart + rangeEnd) / 2, isProfit: !loss, tradesCount: 0 };
  });
  for (const v of core) bins[Math.max(width === 0 ? 0 : count - 1 - Math.floor((Math.max(max, 0) - v) / width), 0)].tradesCount++;
  const first = bins[0];
  const last = bins[count - 1];
  for (const v of outs) {
    if (v <= first.rangeEnd) first.tradesCount++;
    if (v >= last.rangeStart) last.tradesCount++;
    if (v < first.rangeStart && (first.originalRangeStart === undefined || v < first.originalRangeStart)) first.originalRangeStart = v;
    if (v > last.rangeEnd && (last.originalRangeEnd === undefined || v > last.originalRangeEnd)) last.originalRangeEnd = v;
  }
  return bins;
}

/** Average return of the winning / losing closed trades, outliers left out (null without any). */
export function averageReturns(r: BacktestReport): { profit: number | null; loss: number | null } {
  const { core } = returnSamples(r);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return { profit: avg(core.filter((v) => v > 0)), loss: avg(core.filter((v) => v < 0)) };
}

export type GrowthComparison = Record<"runup" | "drawdown", { max: number; average: number; current?: number }>;

/** Largest, average and current (the last period, when of that type) relative change of the run-ups and drawdowns. */
export function growthComparison(periods: EquityPeriod[]): GrowthComparison {
  const last = periods[periods.length - 1];
  const side = (type: EquityPeriod["type"]) => {
    const ps = periods.filter((p) => p.type === type);
    return {
      max: ps.reduce((m, p) => (p.relativeChange > m ? p.relativeChange : m), 0),
      average: ps.length ? ps.reduce((s, p) => s + p.relativeChange, 0) / ps.length : 0,
      current: last?.type === type ? last.relativeChange : undefined,
    };
  };
  return { runup: side("runup"), drawdown: side("drawdown") };
}

export type Liquidation = { tradeNumber: number; quantity: number; price: number; time: number; amount: number };

/** Trades a margin call closed, by exit time: number, quantity, exit price and time (ms), quantity x price. */
export function liquidations(r: BacktestReport): Liquidation[] {
  const out: Liquidation[] = [];
  r.trades.forEach((t, i) => {
    if (t.exit.signal === "Margin call") out.push({ tradeNumber: i + 1, quantity: t.qty, price: t.exit.price, time: t.exit.time, amount: t.qty * t.exit.price });
  });
  return out.sort((a, b) => a.time - b.time);
}

export type MarginLinePoint = { time: number; value: number; point: MarginPoint };

/**
 * Margin utilization line: each item's margin after its fills, then the
 * highest margin before the next item, at strictly ascending times (+1 ms on
 * a tie; UNIX seconds). Percent: the share of the equity, at most 100 %.
 */
export function marginLine(usage: readonly MarginUsage[], percent: boolean): MarginLinePoint[] {
  const out: MarginLinePoint[] = [];
  let last = -Infinity;
  const push = (p: MarginPoint) => {
    last = p.time <= last ? last + 1 : p.time;
    out.push({ time: last / 1000, value: percent ? Math.min(p.percent, 1) : p.value, point: p });
  };
  usage.forEach((u, i) => {
    push(u.current);
    const next = usage[i + 1];
    if (next) push(next.peak);
  });
  return out;
}
