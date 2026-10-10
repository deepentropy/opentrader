/*
 * "Download .csv" of the List of trades, byte for byte as the reference app
 * Desktop 3.4.1 writes it (.tmp/backtester/design/doc §15; the reference app
 * modules 362566 generateTradesJSON, 380072 formatExportedValue, 568642
 * ExcelReportSaver, SheetJS 0.20.4 `sheet_to_csv` + General number format):
 * - UTF-8 with BOM, `,`, LF, no line end after the last row, a field quoted
 *   only when it holds `,` `"` CR or LF;
 * - fixed 17 columns (the Column setup does not apply);
 * - 2 rows per trade, exit row then entry row, trade 1 first, open trade last
 *   (its exit row: `Open`, `Open`, U+2014 price, live values);
 * - dates in the chart time zone: `yyyy-mm-dd hh:mm` intraday,
 *   `yyyy-mm-dd hh:mm:ss` on seconds charts, `yyyy-mm-dd` on D / W / M;
 * - money: 2 decimals (below 0.01, the first of 2..8 decimals that is not 0),
 *   ASCII minus, no grouping, no trailing zeros; percents: x 100, always 2
 *   decimals, no `%`; Cumulative PnL % = cumulative PnL / initial capital.
 * Validated against the reference app's own files: .tmp/backtester/ui-check/code/check-csv.ts.
 */
import type { Trade } from "../../backtester/types";

export type CsvContext = {
  trades: Trade[];
  /** Report currency (PnL columns). */
  currency: string;
  /** Chart symbol currency (Price column). */
  priceCurrency: string;
  initialCapital: number;
  /** Symbol minimum tick: prices are rounded to its precision. */
  mintick: number;
  pointValue: number;
  timeZone: string;
  /** Chart interval ("5", "30S", "1D"...). */
  interval: string;
};

/** SheetJS General number format (SSF functions K / Y, integer shortcut). */
const trimZeros = (e: string) => (e.indexOf(".") === -1 ? e : e.replace(/(?:\.0*|(\.\d*[1-9])0+)$/, "$1"));
export function general(e: number): string {
  if ((e | 0) === e) return String(e);
  if (!isFinite(e)) return isNaN(e) ? "#NUM!" : "#DIV/0!";
  const r = Math.floor(Math.log(Math.abs(e)) * Math.LOG10E);
  let t: string;
  if (r >= -4 && r <= -1) t = e.toPrecision(10 + r);
  else if (Math.abs(r) <= 9) {
    const lim = e < 0 ? 12 : 11;
    let s = trimZeros(e.toFixed(12));
    t = s.length <= lim || (s = e.toPrecision(10)).length <= lim ? s : e.toExponential(5);
  } else if (r === 10) t = e.toFixed(10).substr(0, 12);
  else {
    const s = trimZeros(e.toFixed(11));
    t = s.length > (e < 0 ? 12 : 11) || s === "0" || s === "-0" ? e.toPrecision(6) : s;
  }
  t = t.toUpperCase();
  if (t.indexOf("E") !== -1) t = t.replace(/(?:\.0*|(\.\d*[1-9])0+)[Ee]/, "$1E").replace(/(E[+-])(\d)$/, "$10$2");
  return trimZeros(t);
}

/** Round to `d` decimals (the reference app 380072). */
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
/** Fraction -> percent text: x 100, 2 decimals, "-0.00" printed "0.00". */
function pct(fraction: number): string {
  if (Number.isNaN(fraction)) return "";
  let n = roundTo(fraction * 100, 2);
  if (n) {
    const dec = String(n).split(".")[1] ?? "";
    n = Number(n.toFixed(dec.length + 2));
  }
  return (Object.is(n, -0) ? 0 : n).toFixed(2).replace(/^-(0\.00)$/, "$1");
}

function field(v: string | number): string {
  const s = typeof v === "number" ? general(v) : v;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const EMPTY = "—";
const TYPE = { entry: { long: "Entry long", short: "Entry short" }, exit: { long: "Exit long", short: "Exit short" } } as const;

export function tradesCsv(c: CsvContext): string {
  const unit = c.interval.trim().toUpperCase();
  const seconds = /S$/.test(unit);
  const intraday = !/[DWM]$/.test(unit);
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: c.timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const date = (ms: number) => {
    const o = Object.fromEntries(dtf.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    const d = `${o.year}-${o.month}-${o.day}`;
    return seconds ? `${d} ${o.hour}:${o.minute}:${o.second}` : intraday ? `${d} ${o.hour}:${o.minute}` : d;
  };
  const decimals = Math.max(0, Math.round(-Math.log10(c.mintick)));
  const scale = Math.pow(10, decimals);
  const price = (v: number) => Number((Math.round(v * scale) / scale).toFixed(decimals));

  const header = [
    "Trade number", "Type", "Date and time", "Signal", `Price ${c.priceCurrency}`, "Size (qty)", "Size (value)",
    `Net PnL ${c.currency}`, "Return %", `Commission ${c.currency}`, `Favorable excursion ${c.currency}`, "Favorable excursion %",
    `Adverse excursion ${c.currency}`, "Adverse excursion %", `Cumulative PnL ${c.currency}`, "Cumulative PnL %", "Duration (bars)",
  ];
  const lines = [header.map(field).join(",")];
  c.trades.forEach((t, i) => {
    const n = i + 1;
    const common: (string | number)[] = [
      t.qty,
      t.qty * t.entry.price * c.pointValue,
      money(t.profit),
      pct(t.profitPercent),
      money(t.commission),
      money(t.runUp),
      pct(t.runUpPercent),
      money(-t.drawdown),
      pct(-t.drawdownPercent),
      money(t.cumProfit),
      pct(c.initialCapital <= 0 ? 0 : t.cumProfit / c.initialCapital),
      t.exit.bar - t.entry.bar,
    ];
    const exit = t.open ? ["Open", "Open", EMPTY] : [date(t.exit.time), t.exit.signal, price(t.exit.price)];
    lines.push([n, TYPE.exit[t.direction], ...exit, ...common].map(field).join(","));
    lines.push([n, TYPE.entry[t.direction], date(t.entry.time), t.entry.signal, price(t.entry.price), ...common].map(field).join(","));
  });
  return "﻿" + lines.join("\n");
}

/** File name: `<short title, spaces as _>_<EXCHANGE_TICKER>_<local yyyy-MM-dd>.csv`
 *  (the reference app asks for `NASDAQ:GTLB`; the browser saves `:` as `_`). */
export function tradesCsvFileName(title: string, symbol: string, now = new Date()): string {
  const p2 = (x: number) => String(x).padStart(2, "0");
  const day = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
  return `${title.replace(/\s/g, "_")}_${symbol}_${day}.csv`.replace(/[\\/:*?"<>|]/g, "_");
}
