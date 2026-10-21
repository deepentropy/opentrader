/*
 * "Download data as XLSX" of a strategy report (Strategy Tester and Replay
 * Trading tab menus), laid out as the reference app Desktop 3.4.1 writes it
 * (modules 119909 downloadXlsxReport, 699354 generateExcelReport, 137984 the
 * report fields, 712444 generateTradesJSON, 285858 the properties, 8726
 * formatExportedValue, excel-report-saver 894679 on SheetJS json_to_sheet):
 * - sheets "Performance", "Trades analysis", "Risk-adjusted performance",
 *   "Trades" and, for a strategy, "Properties" (Replay Trading has none);
 * - metric sheets: a header row "" | All USD | All % | Long USD | Long % |
 *   Short USD | Short %, one row per report field (blank where the value is
 *   not computed); money rounded to 2 decimals, percents x 100 rounded to 2
 *   decimals in the "%" columns (number format 0.00), counts to 0 decimals,
 *   ratios to 3 decimals;
 * - "Trades": the columns of the CSV download (trades-csv.ts) with numbers,
 *   dates as Excel dates (yyyy-mm-dd, yyyy-mm-dd hh:mm intraday,
 *   yyyy-mm-dd hh:mm:ss on seconds) in the chart time zone;
 * - "Properties": name | value rows (date range, symbol info, strategy
 *   properties);
 * - column widths: the longest value of the first 101 rows + 1;
 * - file `<title with _>_<symbol>_<yyyy-MM-dd>.xlsx`.
 */
import type { BacktestReport, Performance, SidePerformance, Trade } from "../../backtester/types";
import { longIntervalLabel } from "../chart/interval-favorites";
import { outliers, cagr } from "./metrics";
import type { XlsxCell, XlsxSheet } from "./xlsx-writer";

export type ReportTab = "Performance" | "Trades Analysis" | "Ratios" | "List of Trades" | "Properties";

/** Tabs the Strategy Tester exports (m296372) and Replay Trading (m374574). */
export const STRATEGY_TABS: ReportTab[] = ["Performance", "Trades Analysis", "Ratios", "List of Trades", "Properties"];
export const REPLAY_TABS: ReportTab[] = ["Performance", "Trades Analysis", "Ratios", "List of Trades"];

const SHEET_NAME: Record<ReportTab, string> = {
  Performance: "Performance",
  "Trades Analysis": "Trades analysis",
  Ratios: "Risk-adjusted performance",
  "List of Trades": "Trades",
  Properties: "Properties",
};

type Unit = "currency" | "percent" | "pc" | "duration";
type Field = { title: string; key: string; unit?: Unit; percentKey?: string };

const PERFORMANCE_FIELDS: Field[] = [
  { title: "Initial capital", key: "initialCapital", unit: "currency" },
  { title: "Open PnL", key: "openPL", unit: "currency", percentKey: "openPLPercent" },
  { title: "Net profit", key: "netProfit", unit: "currency", percentKey: "netProfitPercent" },
  { title: "Gross profit", key: "grossProfit", unit: "currency", percentKey: "grossProfitPercent" },
  { title: "Gross loss", key: "grossLoss", unit: "currency", percentKey: "grossLossPercent" },
  { title: "Expectancy", key: "avgTrade", unit: "currency" },
  { title: "Commission paid", key: "commissionPaid", unit: "currency" },
  { title: "Buy and hold PnL", key: "buyHoldReturn", unit: "currency", percentKey: "buyHoldReturnPercent" },
  { title: "Buy and hold % gain", key: "buyHoldGainPercent", unit: "percent" },
  { title: "Strategy outperformance", key: "strategyOutperformance", unit: "currency", percentKey: "strategyOutperformancePercent" },
  { title: "Max contracts held", key: "maxContractsHeld", unit: "pc" },
  { title: "Annualized return (CAGR)", key: "annualizedReturn", unit: "percent" },
  { title: "Return on initial capital", key: "returnOnInitialCapital", unit: "percent" },
  { title: "Account size required", key: "accountSizeRequired", unit: "currency" },
  { title: "Return on account size required", key: "returnOnAccount", unit: "percent" },
  { title: "Average margin used", key: "avgMarginUsed", unit: "currency" },
  { title: "Max margin used", key: "maxMarginUsed", unit: "currency" },
  { title: "Margin efficiency", key: "marginEfficiency", unit: "currency" },
  { title: "Total liquidated volume", key: "totalLiquidatedVolume", unit: "currency" },
  { title: "Largest liquidated volume", key: "largestLiquidatedVolume", unit: "currency" },
  { title: "Average run-up duration (close-to-close)", key: "averageRunupDuration", unit: "duration" },
  { title: "Average run-up (close-to-close)", key: "averageRunup", unit: "currency", percentKey: "averageRunupPercent" },
  { title: "Max run-up (close-to-close)", key: "maxRunup", unit: "currency", percentKey: "maxRunupPercent" },
  { title: "Max run-up (intrabar)", key: "maxStrategyRunUp", unit: "currency", percentKey: "maxStrategyRunUpPercent" },
  { title: "Max run-up as % of initial capital (intrabar)", key: "maxEquityRunUpAsPercentOfInitialCapital", unit: "percent" },
  { title: "Average drawdown duration (close-to-close)", key: "averageDrawdownDuration", unit: "duration" },
  { title: "Average drawdown (close-to-close)", key: "averageDrawdown", unit: "currency", percentKey: "averageDrawdownPercent" },
  { title: "Return of max drawdown", key: "returnOfMaxEquityDrawdown", unit: "currency" },
  { title: "Max drawdown (close-to-close)", key: "maxDrawdown", unit: "currency", percentKey: "maxDrawdownPercent" },
  { title: "Max drawdown (intrabar)", key: "maxStrategyDrawDown", unit: "currency", percentKey: "maxStrategyDrawDownPercent" },
  { title: "Max drawdown as % of initial capital (intrabar)", key: "maxEquityDrawdownAsPercentOfInitialCapital", unit: "percent" },
  { title: "Net PnL as % of largest loss", key: "netProfitAsPercentOfLargestLoss", unit: "percent" },
  { title: "Largest profit as % of gross profit", key: "largestWinnerAsPercentOfGrossProfit", unit: "percent" },
  { title: "Largest loss as % of gross loss", key: "largestLoserAsPercentOfGrossLoss", unit: "percent" },
];

const RATIO_FIELDS: Field[] = [
  { title: "Sharpe ratio", key: "sharpeRatio" },
  { title: "Sortino ratio", key: "sortinoRatio" },
  { title: "Profit factor", key: "profitFactor" },
  { title: "Margin calls", key: "marginCalls", unit: "pc" },
];

const TRADE_ANALYSIS_FIELDS: Field[] = [
  { title: "Total open trades", key: "totalOpenTrades", unit: "pc" },
  { title: "Total trades", key: "totalTrades", unit: "pc" },
  { title: "Total winners", key: "numberOfWiningTrades", unit: "pc" },
  { title: "Total losers", key: "numberOfLosingTrades", unit: "pc" },
  { title: "Even trades", key: "numberOfEvenTrades", unit: "pc" },
  { title: "Percent profitable", key: "percentProfitable", unit: "percent", percentKey: "percentProfitablePercent" },
  { title: "Expectancy", key: "avgTrade", unit: "currency", percentKey: "avgTradePercent" },
  { title: "Average profit", key: "avgWinTrade", unit: "currency", percentKey: "avgWinTradePercent" },
  { title: "Average loss", key: "avgLosTrade", unit: "currency", percentKey: "avgLosTradePercent" },
  { title: "Average profit / average loss", key: "ratioAvgWinAvgLoss" },
  { title: "Largest profit", key: "largestWinTrade", unit: "currency" },
  { title: "Largest profit %", key: "largestWinTradePercent", unit: "percent" },
  { title: "Largest loss", key: "largestLosTrade", unit: "currency" },
  { title: "Largest loss %", key: "largestLosTradePercent", unit: "percent" },
  { title: "Outliers", key: "outliersCount", unit: "pc" },
  { title: "Outliers P&L", key: "outliersPnL", unit: "currency", percentKey: "outliersPnLPercent" },
  { title: "Average bars in trades", key: "avgBarsInTrade", unit: "pc", percentKey: "avgBarsInTradePercent" },
  { title: "Average bars in winners", key: "avgBarsInWinTrade", unit: "pc" },
  { title: "Average bars in losers", key: "avgBarsInLossTrade", unit: "pc" },
];

/** Round to `d` decimals (the reference app 8726). */
const roundTo = (v: number, d: number) => {
  const m = parseFloat(Math.pow(10, d || 0).toFixed(d < 0 ? -d : 0));
  return Math.round(v * m) / m;
};
/** Currency value: 2 decimals; below 0.01 the first of 2..8 decimals that is not 0. */
function money(v: number): number {
  if (v < 0.01) {
    for (let d = 2; d <= 8; d++) {
      const x = roundTo(v, d);
      if (x !== 0) return x;
    }
    return 0;
  }
  return roundTo(v, 2);
}

/** formatExportedValue: "" for no value. */
function exported(v: unknown, unit: Unit | "change" | undefined): number | "" {
  if (typeof v !== "number" || !Number.isFinite(v)) return "";
  switch (unit) {
    case "currency":
      return money(v);
    case "percent":
    case "change":
      return roundTo(v * 100, 2);
    case "pc":
      return roundTo(v, 0);
    case "duration":
      // Durations are not computed in this port.
      return "";
    default:
      return roundTo(v, 3);
  }
}

type Side = "all" | "long" | "short";

/** Values of the report not kept in `performance` (per side where the
 *  reference app reports them per side). */
function extra(r: BacktestReport, side: Side, key: string): number | undefined {
  const closed = r.trades.filter((t) => !t.open && (side === "all" || t.direction === side));
  switch (key) {
    case "numberOfEvenTrades":
      return closed.filter((t) => t.profit === 0).length;
    default:
      break;
  }
  if (side !== "all") return undefined;
  switch (key) {
    case "initialCapital":
      return r.properties.initialCapital;
    case "outliersCount":
      return outliers(r).trades.length;
    case "outliersPnL":
      return outliers(r).pnl;
    case "marginCalls":
      return r.filledOrders.filter((o) => o.id.startsWith("Margin call")).length;
    case "annualizedReturn":
      // As the report's Annualized return (CAGR) cell.
      return cagr(r) ?? undefined;
    default:
      return undefined;
  }
}

/** getPerformanceData: All = all[key] ?? performance[key]; Long / Short = their side only. */
function valueOf(r: BacktestReport, side: Side, key: string): unknown {
  const p = r.performance as Performance & Record<string, unknown>;
  const s = p[side] as SidePerformance & Record<string, unknown>;
  const v = side === "all" ? s[key] ?? p[key] : s?.[key];
  return v ?? extra(r, side, key);
}

const PERCENT_FORMAT = "0.00";
const pctCell = (v: number | ""): XlsxCell => (v === "" ? "" : { v, z: PERCENT_FORMAT });

function metricsSheet(r: BacktestReport, fields: Field[], name: string): XlsxSheet {
  const cur = r.currency ? ` ${r.currency}` : "";
  const header: XlsxCell[] = [""];
  for (const t of ["All", "Long", "Short"]) header.push(`${t}${cur}`, `${t} %`);
  const rows: XlsxCell[][] = [header];
  for (const f of fields) {
    const row: XlsxCell[] = [f.title];
    for (const side of ["all", "long", "short"] as const) {
      const v = valueOf(r, side, f.key);
      if (f.unit === "percent") {
        row.push("", pctCell(exported(v, "percent")));
      } else {
        row.push(exported(v, f.unit), pctCell(f.percentKey ? exported(valueOf(r, side, f.percentKey), "change") : ""));
      }
    }
    rows.push(row);
  }
  return { name, rows };
}

export type XlsxReportContext = {
  report: BacktestReport;
  /** Chart symbol "EXCHANGE:TICKER" (Properties, file name). */
  symbol: string;
  /** Chart interval ("5", "30S", "1D"...). */
  interval: string;
  timeZone: string;
  mintick: number;
  pointValue: number;
  /** Currency of the prices (Price column). */
  priceCurrency: string;
};

/** Excel date format of the chart interval (reference 387654). */
export function excelDateFormat(interval: string): string {
  const unit = interval.trim().toUpperCase();
  if (/[DWM]$/.test(unit)) return "yyyy-mm-dd";
  return /S$/.test(unit) ? "yyyy-mm-dd hh:mm:ss" : "yyyy-mm-dd hh:mm";
}

/** UNIX ms -> Excel serial date of the wall clock in `timeZone` (date only
 *  on D / W / M charts). */
export function excelDate(ms: number, interval: string, timeZone: string): number {
  const unit = interval.trim().toUpperCase();
  const dwm = /[DWM]$/.test(unit);
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const o = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
  const wall = dwm ? Date.UTC(o.year, o.month - 1, o.day) : Date.UTC(o.year, o.month - 1, o.day, o.hour, o.minute, /S$/.test(unit) ? o.second : 0);
  return wall / 864e5 + 25569;
}

const TYPE = { entry: { long: "Entry long", short: "Entry short" }, exit: { long: "Exit long", short: "Exit short" } } as const;

function tradesSheet(c: XlsxReportContext, name: string): XlsxSheet {
  const r = c.report;
  const z = excelDateFormat(c.interval);
  const header = [
    "Trade number", "Type", "Date and time", "Signal", `Price ${c.priceCurrency}`, "Size (qty)", "Size (value)",
    `Net PnL ${r.currency}`, "Return %", `Commission ${r.currency}`, `Favorable excursion ${r.currency}`, "Favorable excursion %",
    `Adverse excursion ${r.currency}`, "Adverse excursion %", `Cumulative PnL ${r.currency}`, "Cumulative PnL %", "Duration (bars)",
  ];
  const decimals = Math.max(0, Math.round(-Math.log10(c.mintick)));
  const scale = Math.pow(10, decimals);
  const price = (v: number) => Number((Math.round(v * scale) / scale).toFixed(decimals));
  const date = (ms: number): XlsxCell => ({ v: excelDate(ms, c.interval, c.timeZone), z });
  const cap = r.properties.initialCapital;
  const rows: XlsxCell[][] = [header];
  r.trades.forEach((t: Trade, i) => {
    const n = i + 1;
    const common: XlsxCell[] = [
      t.qty,
      t.qty * t.entry.price * c.pointValue,
      exported(t.profit, "currency"),
      pctCell(exported(t.profitPercent, "change")),
      exported(t.commission, "currency"),
      exported(t.runUp, "currency"),
      pctCell(exported(t.runUpPercent, "change")),
      exported(-t.drawdown, "currency"),
      pctCell(exported(-t.drawdownPercent, "change")),
      exported(t.cumProfit, "currency"),
      pctCell(exported(cap <= 0 ? 0 : t.cumProfit / cap, "change")),
      t.exit.bar - t.entry.bar,
    ];
    const exit: XlsxCell[] = t.open ? ["Open", "Open", "—"] : [date(t.exit.time), t.exit.signal, price(t.exit.price)];
    rows.push([n, TYPE.exit[t.direction], ...exit, ...common]);
    rows.push([n, TYPE.entry[t.direction], date(t.entry.time), t.entry.signal, price(t.entry.price), ...common]);
  });
  return { name, rows };
}

const DASH = "—";

function propertiesSheet(c: XlsxReportContext, name: string): XlsxSheet {
  const r = c.report;
  const p = r.properties;
  const rows: XlsxCell[][] = [["name", "value"]];
  const add = (n: string, v: string | number) => rows.push([n, String(v)]);
  // Date range (formatDateFn: "Oct 21, 2026", with the time on intraday charts).
  const unit = c.interval.trim().toUpperCase();
  const dwm = /[DWM]$/.test(unit);
  const fmt = new Intl.DateTimeFormat("en", {
    timeZone: c.timeZone, year: "numeric", month: "short", day: "numeric",
    ...(dwm ? {} : { hour: "2-digit", minute: "2-digit", ...(/S$/.test(unit) ? { second: "2-digit" } : {}), hour12: false }),
  });
  const d = (ms: number) => fmt.format(new Date(ms));
  if (r.range.to > 0) {
    const first = r.trades.reduce((m, t) => Math.min(m, t.entry.time), Infinity);
    add("Trading range", `${d(Number.isFinite(first) ? first : r.range.from)} ${DASH} ${d(r.range.to)}`);
    add("Backtesting range", `${d(r.range.from)} ${DASH} ${d(r.range.to)}`);
  }
  // Symbol info.
  add("Symbol", c.symbol);
  add("Timeframe", longIntervalLabel(c.interval));
  add("Point value", c.pointValue);
  add("Currency", r.currency);
  add("Tick size", c.mintick);
  // Strategy properties.
  const qtyUnit = p.defaultQtyType === "fixed" ? " contracts" : p.defaultQtyType === "percent_of_equity" ? "% of equity" : "";
  const exec = ["On bar close"];
  if (p.calcOnOrderFills) exec.push("On order fill");
  if (p.calcOnEveryHistoryTick) exec.push("On history bar tick");
  if (p.calcOnEveryTick) exec.push("On realtime bar tick");
  const leverage = (m: number) => (m === 0 ? String(Number.POSITIVE_INFINITY) : `${100 / m}x`);
  add("Initial capital", p.initialCapital);
  add("Default order size", `${p.defaultQtyValue}${qtyUnit}`);
  add("Pyramiding", `${p.pyramiding} orders`);
  add("Bar detalization", p.barMagnifier ? `High (~${detalizationTicks(c.interval)} ticks per bar)` : "Default (4 ticks per bar)");
  add("Script execution", exec.join(", "));
  add("Commission", p.commissionValue);
  add("Long leverage", leverage(p.marginLong));
  add("Short leverage", leverage(p.marginShort));
  add("Slippage", `${p.slippage} ticks`);
  add("Limit order execution", p.fillLimitsTicks === 0 ? "Requested price" : "Requested price and 1 tick beyond");
  add("Order execution delay", p.processOrdersOnClose ? "None" : "One tick");
  return { name, rows };
}

/** Ticks per bar of the bar magnifier (reference 851549). */
export function detalizationTicks(interval: string): number {
  const m = /^(\d+)([SDWM]?)$/i.exec(interval.trim());
  if (!m) return 28;
  const n = Number(m[1]);
  const u = m[2].toUpperCase();
  if (u === "S") return n < 30 ? 4 : n < 59 ? 24 : 28;
  if (u === "") return n < 5 ? 24 : n < 10 ? 40 : n < 15 ? 40 : n < 30 ? 28 : n < 60 ? 24 : n < 240 ? 24 : n < 1440 ? 32 : 28;
  if (u === "D") return n < 3 ? 96 : n < 7 ? 72 : 28;
  return 28;
}

/** Column widths: the longest value of the first 101 rows + 1 (a date
 *  column counts its date format). */
function widths(sheet: XlsxSheet, dateFormat: string): number[] {
  const n = Math.max(...sheet.rows.map((r) => r.length));
  const out: number[] = [];
  for (let c = 0; c < n; c++) {
    const isDate = sheet.rows[0]?.[c] === "Date and time";
    let w = 0;
    for (let r = 0; r < Math.min(sheet.rows.length, 101); r++) {
      const cell = sheet.rows[r][c];
      const v = cell && typeof cell === "object" ? cell.v : cell;
      if (!v) continue;
      // The date column counts its date format, header included (the reference saver).
      const len = isDate ? dateFormat.length : String(v).length;
      w = Math.max(w, len);
    }
    out.push(w + 1);
  }
  return out;
}

/** The sheets of the report, one per exported tab. */
export function reportSheets(c: XlsxReportContext, tabs: ReportTab[]): XlsxSheet[] {
  const out: XlsxSheet[] = [];
  const name = (t: ReportTab) => SHEET_NAME[t].slice(0, 31).replace(/\//g, " ");
  for (const t of tabs) {
    let s: XlsxSheet;
    if (t === "Performance") s = metricsSheet(c.report, PERFORMANCE_FIELDS, name(t));
    else if (t === "Trades Analysis") s = metricsSheet(c.report, TRADE_ANALYSIS_FIELDS, name(t));
    else if (t === "Ratios") s = metricsSheet(c.report, RATIO_FIELDS, name(t));
    else if (t === "List of Trades") s = tradesSheet(c, name(t));
    else s = propertiesSheet(c, name(t));
    s.widths = widths(s, excelDateFormat(c.interval));
    out.push(s);
  }
  return out;
}

/** File name: `<title, spaces as _>_<symbol>_<local yyyy-MM-dd>.xlsx` (the
 *  `:` of the symbol saved as `_`). */
export function reportXlsxFileName(title: string, symbol: string, now = new Date()): string {
  const p2 = (x: number) => String(x).padStart(2, "0");
  const day = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
  return `${title.replace(/\s/g, "_")}_${symbol}_${day}.xlsx`.replace(/[\\/:*?"<>|]/g, "_");
}
