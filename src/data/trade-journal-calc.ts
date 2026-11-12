import { translateWith } from "../i18n/translator";
import { dateText } from "../i18n/format";
/*
 * Trade journal values: what a trade earned and how far it went for and
 * against it, read on the bars between its entry and its exit; the groups of
 * the list; the chart interval and frame that show a trade.
 *
 * Bars are split-adjusted while a journal holds the prices actually paid, so
 * the excursions are measured in percent on the bars and applied to the
 * trade's own entry price.
 */
import { localDay } from "./session";
import { intervalSeconds } from "./interval";

export type Side = "long" | "short";

/** OHLC bar, time in UTC seconds (bar open). */
export type Bar = { time: number; open: number; high: number; low: number; close: number };

/** What the journal knows of a trade (times in UTC seconds; a date-only
 *  trade holds the local midnight of its dates in the exchange zone, the
 *  stamp of a daily bar). */
export type TradeInput = {
  side: Side;
  entryTime: number;
  exitTime: number;
  dateOnly: boolean;
  qty?: number;
  entryPrice?: number;
  exitPrice?: number;
  fees?: number;
};

export type TradeCalc = {
  entryPrice: number;
  exitPrice: number;
  /** The price came from the bars (the file had none). */
  entryEstimated: boolean;
  exitEstimated: boolean;
  /** Net P&L: price move x quantity (1 when none) less fees. */
  pnl: number;
  /** Price move in the trade's direction / entry price. */
  pnlPct: number;
  /** Largest move for the trade (money, fraction of entry price). */
  runUp: number;
  runUpPct: number;
  /** Largest move against the trade (money, fraction of entry price), >= 0. */
  drawdown: number;
  drawdownPct: number;
  /** Interval of the bars it was read on ("1", "60", "1D"). */
  interval: string;
};

/** Bars that overlap [entry, exit] on bars `barSec` long. */
function barsOf(t: TradeInput, bars: Bar[], barSec: number): Bar[] {
  return bars.filter((b) => b.time + barSec > t.entryTime && b.time <= t.exitTime);
}

/** The bar holding `sec` (open <= sec < open + barSec), else the last one before. */
function barAt(bars: Bar[], sec: number): Bar | undefined {
  let found: Bar | undefined;
  for (const b of bars) {
    if (b.time > sec) break;
    found = b;
  }
  return found;
}

/** A trade's values on `bars` (ascending, `barSec` long, read at `interval`);
 *  null when the bars do not cover its entry and exit. Estimated prices: the
 *  open of the bar of the time on intraday bars, the close of the day on
 *  daily ones. */
export function tradeMetrics(t: TradeInput, bars: Bar[], barSec: number, interval: string): TradeCalc | null {
  const span = barsOf(t, bars, barSec);
  if (span.length === 0) return null;
  const entryBar = barAt(span, t.entryTime) ?? span[0];
  const exitBar = barAt(span, t.exitTime) ?? span[span.length - 1];
  if (exitBar.time + barSec <= t.exitTime && !t.dateOnly) {
    // The bars stop before the exit (history not reached yet).
    if (bars[bars.length - 1].time + barSec <= t.exitTime) return null;
  }
  const daily = barSec >= 86400;
  const priceOf = (b: Bar) => (daily ? b.close : b.open);
  const refEntry = priceOf(entryBar);
  const refExit = priceOf(exitBar);
  if (!(refEntry > 0)) return null;
  const dir = t.side === "long" ? 1 : -1;
  const entryPrice = t.entryPrice ?? refEntry;
  const exitPrice = t.exitPrice ?? (t.entryPrice !== undefined ? t.entryPrice * (refExit / refEntry) : refExit);
  let hi = -Infinity;
  let lo = Infinity;
  for (const b of span) {
    hi = Math.max(hi, b.high);
    lo = Math.min(lo, b.low);
  }
  const movePct = (dir * (exitPrice - entryPrice)) / entryPrice;
  // Excursions on the bars, at least the trade's own result.
  const upPct = Math.max(0, movePct, t.side === "long" ? hi / refEntry - 1 : 1 - lo / refEntry);
  const ddPct = Math.max(0, -movePct, t.side === "long" ? 1 - lo / refEntry : hi / refEntry - 1);
  const qty = t.qty ?? 1;
  return {
    entryPrice,
    exitPrice,
    entryEstimated: t.entryPrice === undefined,
    exitEstimated: t.exitPrice === undefined,
    pnl: dir * (exitPrice - entryPrice) * qty - (t.fees ?? 0),
    pnlPct: movePct,
    runUp: upPct * entryPrice * qty,
    runUpPct: upPct,
    drawdown: ddPct * entryPrice * qty,
    drawdownPct: ddPct,
    interval,
  };
}

// ── Reading bars ─────────────────────────────────────────────────────────────

/** Interval the values of a trade are read on: minutes for a trade of a few
 *  days, hours up to two months, days beyond and for date-only trades. */
export function metricsInterval(t: Pick<TradeInput, "entryTime" | "exitTime" | "dateOnly">): string {
  const dur = t.exitTime - t.entryTime;
  if (t.dateOnly || dur > 60 * 86400) return "1D";
  if (dur > 5 * 86400) return "60";
  return "1";
}

/** Bar length of an interval id in seconds ("1" → 60, "60" → 3600, "1D" → 86400, "1W" → 604800);
 *  a day for an id that is no interval, so a frame still has a width. */
export function intervalSec(id: string): number {
  return intervalSeconds(id) ?? 86400;
}

/** Trading days from `from` to `to` (weekdays plus a holiday margin), at least 1. */
export function tradingDays(from: number, to: number): number {
  const cal = Math.max(0, (to - from) / 86400);
  return Math.max(1, Math.ceil((cal * 5) / 7) + 2 + Math.ceil(cal / 36));
}

// ── Showing a trade ──────────────────────────────────────────────────────────

/** Most bars the chart loads to show a trade (the depth of SYNC_LOAD_MAX_BARS):
 *  a finer interval would load a long history back to an old trade. */
const MAX_HISTORY_BARS = 90_000;
/** Bars of a trading day with extended hours, per minute interval. */
const DAY_MINUTES = 16 * 60;

const CHART_STEPS = ["1", "5", "15", "60", "1D", "1W"];

/** Chart interval that shows a trade: about 20 to 400 bars across it, coarser
 *  when the chart could not load history back to it at that interval. */
export function chartInterval(t: Pick<TradeInput, "entryTime" | "exitTime" | "dateOnly">, nowSec: number): string {
  const dur = t.exitTime - t.entryTime;
  let i: number;
  if (t.dateOnly) i = dur > 400 * 86400 ? 5 : 4;
  else if (dur <= 2 * 3600) i = 0;
  else if (dur <= 8 * 3600) i = 1;
  else if (dur <= 3 * 86400) i = 2;
  else if (dur <= 20 * 86400) i = 3;
  else if (dur <= 400 * 86400) i = 4;
  else i = 5;
  const back = tradingDays(t.entryTime, nowSec);
  while (i < 4 && (back * DAY_MINUTES) / Number(CHART_STEPS[i]) > MAX_HISTORY_BARS) i++;
  return CHART_STEPS[i];
}

/** Range framing a trade on a chart of `interval`: its span plus a third on
 *  each side, at least 15 bars. */
export function chartFrame(t: Pick<TradeInput, "entryTime" | "exitTime">, interval: string): { from: number; to: number } {
  const pad = Math.max((t.exitTime - t.entryTime) / 3, 15 * intervalSec(interval));
  return { from: Math.floor(t.entryTime - pad), to: Math.ceil(t.exitTime + pad) };
}

// ── Groups ───────────────────────────────────────────────────────────────────

export type GroupBy = "none" | "symbol" | "day" | "week" | "month" | "year" | "profit" | "drawdown";

export const GROUP_LABELS: Record<GroupBy, string> = {
  none: "No grouping",
  symbol: "Symbol",
  day: "Day",
  week: "Week",
  month: "Month",
  year: "Year",
  profit: "Profit",
  drawdown: "Drawdown",
};

export type GroupKey = { key: string; label: string; order: number };

/** Profit ranges (lower bound of P&L %, label), best first. */
const PROFIT_BANDS: [number, string][] = [
  [0.2, "+20% and more"],
  [0.1, "+10% to +20%"],
  [0.05, "+5% to +10%"],
  [0, "0% to +5%"],
  [-0.05, "−5% to 0%"],
  [-0.1, "−10% to −5%"],
  [-0.2, "−20% to −10%"],
  [-Infinity, "Below −20%"],
];
/** Drawdown ranges (lower bound of drawdown %, label), smallest first. */
const DRAWDOWN_BANDS: [number, string][] = [
  [0, "0% to 1%"],
  [0.01, "1% to 2%"],
  [0.02, "2% to 5%"],
  [0.05, "5% to 10%"],
  [0.1, "10% to 20%"],
  [0.2, "20% and more"],
];

const pad2 = (n: number) => String(n).padStart(2, "0");
/** dd/mm/yyyy of a local day number (days since 01/01/1970). */
export function dayLabel(day: number): string {
  const d = new Date(day * 86400000);
  return `${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}
/** "dd/mm/yyyy hh:mm" of a time in `zone` ("dd/mm/yyyy" when `dateOnly`). */
export function tradeDateText(sec: number, zone: string, dateOnly: boolean): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(sec * 1000))
      .map((x) => [x.type, x.value]),
  );
  const d = `${p.day}/${p.month}/${p.year}`;
  return dateOnly ? d : `${d} ${p.hour}:${p.minute}`;
}
/** How long a trade lasted: "3d 4h", "45m"; days for a date-only trade ("Same day", "12d"). */
export function durationText(t: Pick<TradeInput, "entryTime" | "exitTime" | "dateOnly">): string {
  const s = Math.max(0, t.exitTime - t.entryTime);
  if (t.dateOnly) {
    const days = Math.round(s / 86400);
    return days === 0 ? "Same day" : `${days}d`;
  }
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return h ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/** What grouping reads of a trade; `zone`: its exchange zone (a date-only
 *  trade's dates are read there). */
export type Groupable = { symbol: string; entryTime: number; dateOnly: boolean; zone?: string; calc?: TradeCalc | null };

/** Group of a trade. Dates: the entry date in `timeZone` (date-only trades:
 *  their own date). Trades with no values go last in profit / drawdown. */
export function groupOf(t: Groupable, by: GroupBy, timeZone: string): GroupKey {
  const day = localDay(t.dateOnly && t.zone ? t.zone : timeZone, t.entryTime);
  switch (by) {
    case "none":
      return { key: "", label: "", order: 0 };
    case "symbol":
      return { key: t.symbol, label: t.symbol, order: 0 };
    case "day":
      return { key: String(day), label: dayLabel(day), order: -day };
    case "week": {
      // Weeks start on Monday (01/01/1970 was a Thursday).
      const monday = day - ((day + 3) % 7);
      return { key: String(monday), label: translateWith("Week of {0}", dayLabel(monday)), order: -monday };
    }
    case "month": {
      const d = new Date(day * 86400000);
      const n = d.getUTCFullYear() * 12 + d.getUTCMonth();
      return { key: String(n), label: dateText(d, { month: "long", year: "numeric", timeZone: "UTC" }), order: -n };
    }
    case "year": {
      const y = new Date(day * 86400000).getUTCFullYear();
      return { key: String(y), label: String(y), order: -y };
    }
    case "profit": {
      if (!t.calc) return { key: "na", label: "Not computed", order: 99 };
      const i = PROFIT_BANDS.findIndex(([lo]) => t.calc!.pnlPct >= lo);
      return { key: `p${i}`, label: PROFIT_BANDS[i][1], order: i };
    }
    case "drawdown": {
      if (!t.calc) return { key: "na", label: "Not computed", order: 99 };
      let i = 0;
      while (i + 1 < DRAWDOWN_BANDS.length && t.calc.drawdownPct >= DRAWDOWN_BANDS[i + 1][0]) i++;
      return { key: `d${i}`, label: DRAWDOWN_BANDS[i][1], order: i };
    }
  }
}

export type Group<T> = { key: string; label: string; trades: T[]; pnl: number; wins: number; computed: number };

/** Trades in groups (in group order; by symbol: alphabetical), each with its
 *  total P&L and its winners among the computed trades. Trade order is kept. */
export function groupTrades<T extends Groupable>(
  trades: T[],
  by: GroupBy,
  timeZone: string,
): Group<T>[] {
  const map = new Map<string, Group<T> & { order: number }>();
  for (const t of trades) {
    const g = groupOf(t, by, timeZone);
    let e = map.get(g.key);
    if (!e) map.set(g.key, (e = { key: g.key, label: g.label, order: g.order, trades: [], pnl: 0, wins: 0, computed: 0 }));
    e.trades.push(t);
    if (t.calc) {
      e.computed++;
      e.pnl += t.calc.pnl;
      if (t.calc.pnl > 0) e.wins++;
    }
  }
  return [...map.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}
