/**
 * Golden runs of the backtester: every strategy on the synthetic series, written as a compact, stable text (no run
 * time, numbers at 10 significant digits) for file snapshots.
 */
import type { ChartContext } from "oakscriptjs/script";
import { StrategyRuntimeError } from "../broker";
import type { BacktestReport, Bar, FilledOrder, SidePerformance, StrategyProperties, SymbolInfo, Trade } from "../types";
import { NEW_YORK, dailySeries, intradaySeries, pennySeries } from "./synthetic";

export interface Dataset {
  name: string;
  bars: Bar[];
  /** Chart context of the OakScript runs (the app's: exchange zone, regular session, tick). */
  chart: ChartContext;
  /** Symbol of the TypeScript ports (runBacktest). */
  symbol: Partial<SymbolInfo>;
  /** Overrides of the strategies' properties (Properties tab); none for the default runs. */
  properties?: Partial<StrategyProperties>;
}

let cache: Dataset[] | undefined;

export function datasets(): Dataset[] {
  if (cache) return cache;
  const daily = dailySeries();
  const penny = pennySeries();
  const dailyChart: ChartContext = { timeframe: "1D", timezone: NEW_YORK, session: "0930-1600", tickerid: "NASDAQ:SYNTH" };
  const pennyChart: ChartContext = { timeframe: "1D", timezone: NEW_YORK, session: "0930-1600", tickerid: "NASDAQ:PENNY", mintick: 0.0001 };
  cache = [
    { name: "daily", bars: daily, chart: dailyChart, symbol: {} },
    {
      name: "intraday-5m",
      bars: intradaySeries(),
      chart: { timeframe: "5", timezone: NEW_YORK, session: "0930-1600", tickerid: "NASDAQ:SYNTH" },
      symbol: {},
    },
    { name: "penny", bars: penny, chart: pennyChart, symbol: { mintick: 0.0001 } },
    // The same series with costs: the commission and slippage paths of every strategy.
    {
      name: "daily-costs",
      bars: daily,
      chart: dailyChart,
      symbol: {},
      properties: { commissionType: "percent", commissionValue: 0.1, slippage: 2 },
    },
    {
      name: "penny-costs",
      bars: penny,
      chart: pennyChart,
      symbol: { mintick: 0.0001 },
      properties: { commissionType: "cash_per_order", commissionValue: 1, slippage: 1 },
    },
  ];
  return cache;
}

/** A number at 10 significant digits (an integer as is): stable against last-bit noise, sensitive to any real change. */
export function num(x: number | null | undefined): string {
  if (x === null || x === undefined) return "-";
  if (Number.isNaN(x)) return "NaN";
  if (!Number.isFinite(x)) return x > 0 ? "Inf" : "-Inf";
  if (Number.isInteger(x)) return String(x);
  const s = String(Number(x.toPrecision(10)));
  return s === "-0" ? "0" : s;
}

function tradeLine(t: Trade, k: number): string {
  return [
    `#${k + 1}`,
    t.direction === "long" ? "L" : "S",
    JSON.stringify(t.entryId),
    `in ${JSON.stringify(t.entry.signal)}@${t.entry.bar} ${num(t.entry.price)}`,
    `out ${t.open ? "OPEN" : JSON.stringify(t.exit.signal)}@${t.exit.bar} ${num(t.exit.price)}`,
    `q=${num(t.qty)}`,
    `pnl=${num(t.profit)} (${num(t.profitPercent)})`,
    `cm=${num(t.commission)}`,
    `ru=${num(t.runUp)} dd=${num(t.drawdown)}`,
    `cum=${num(t.cumProfit)} eq%=${num(t.profitPercentOfEquity)}`,
  ].join(" ");
}

function orderLine(o: FilledOrder): string {
  const kind = o.entry === null ? "order" : o.entry ? "entry" : "exit";
  return `${o.bar} ${o.buy ? "buy" : "sell"} ${kind} ${o.type} ${JSON.stringify(o.id)} ${num(o.price)} x${num(o.qty)}`;
}

const SIDE_FIELDS: (keyof SidePerformance)[] = [
  "netProfit",
  "grossProfit",
  "grossLoss",
  "commissionPaid",
  "profitFactor",
  "totalTrades",
  "totalOpenTrades",
  "numberOfWiningTrades",
  "numberOfLosingTrades",
  "percentProfitable",
  "avgTrade",
  "avgWinTrade",
  "avgLosTrade",
  "largestWinTrade",
  "largestLosTrade",
  "avgBarsInTrade",
  "maxContractsHeld",
];

function sideLine(name: string, s: SidePerformance): string {
  return `${name}: ` + SIDE_FIELDS.map((f) => `${f}=${num(s[f] as number | null)}`).join(" ");
}

/** cyrb53: a 53-bit string hash (pure TypeScript, no node:crypto), as 14 hex digits. */
export function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** Trades / orders listed in full at the start of a run; the rest is pinned by digests of blocks of lines. */
const LISTED = 12;
const BLOCK = 100;

/** The first `LISTED` lines, then one digest line per block of `BLOCK` lines (all lines, the listed ones too), so a
 *  change shows the block of its first difference. */
function digestLines(lines: string[]): string[] {
  const out = lines.slice(0, LISTED).map((l) => "  " + l);
  if (lines.length > LISTED) out.push(`  ... ${lines.length - LISTED} more`);
  for (let k = 0; k < lines.length; k += BLOCK) {
    const end = Math.min(lines.length, k + BLOCK);
    out.push(`  digest ${k + 1}-${end}: ${hash(lines.slice(k, end).join("\n"))}`);
  }
  return out;
}

/** The summary of one run: performance, the first trades and filled orders in full, digests of all of them. */
export function summarize(report: BacktestReport): string[] {
  const p = report.performance;
  const finalEquity = report.equity.length ? report.equity[report.equity.length - 1] : NaN;
  const kinds = new Map<string, number>();
  for (const o of report.filledOrders) {
    const k = `${o.entry === null ? "order" : o.entry ? "entry" : "exit"}/${o.type}`;
    kinds.set(k, (kinds.get(k) ?? 0) + 1);
  }
  const marginCalls = report.filledOrders.filter((o) => o.id.startsWith("Margin call")).length;
  return [
    `trades=${report.trades.length} filledOrders=${report.filledOrders.length} marginCalls=${marginCalls} finalEquity=${num(finalEquity)} minEquity=${num(Math.min(...report.equity))}`,
    `orders by kind: ${[...kinds].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, n]) => `${k}=${n}`).join(" ") || "none"}`,
    `openPL=${num(p.openPL)} maxDD=${num(p.maxStrategyDrawDown)} (${num(p.maxStrategyDrawDownPercent)}) maxRunUp=${num(p.maxStrategyRunUp)} (${num(p.maxStrategyRunUpPercent)}) buyHold=${num(p.buyHoldReturn)} (${num(p.buyHoldReturnPercent)})`,
    sideLine("all", p.all),
    sideLine("long", p.long),
    sideLine("short", p.short),
    "trades:",
    ...digestLines(report.trades.map(tradeLine)),
    "orders:",
    ...digestLines(report.filledOrders.map(orderLine)),
  ];
}

/** A run that stopped: the runtime error (code and bar) or the error message. */
export function describeError(e: unknown): string {
  if (e instanceof StrategyRuntimeError) return `runtime error ${e.code} at bar ${e.bar}${e.value === undefined ? "" : ` (value ${String(e.value)})`}`;
  return `error ${e instanceof Error ? e.message : String(e)}`;
}
