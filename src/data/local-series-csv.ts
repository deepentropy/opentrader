/*
 * CSV files of bars for the imported series (#266). Reads:
 *   • the app's own "Download chart data" export (header "time,open,high,
 *     low,close,…", UNIX or ISO 8601 times, extra study columns ignored);
 *   • the Pine Seeds layout: no header, `YYYYMMDDT,open,high,low,close,volume`;
 *   • the usual header layouts of other tools ("Date,Open,High,Low,Close,
 *     Adj Close,Volume"; "<DATE>\t<TIME>\t<OPEN>…" with a separate time
 *     column; a single "value" column).
 * Comma, semicolon or tab separated. Times without an offset are wall times
 * in the series' time zone. Pure functions: the window and the tests share them.
 */
import { localDay, localToUtc } from "./session/zone";
import { detectDateOrder, parseClock, parseCsv, parseStamp, type DateOrder } from "./trade-journal-csv";

export type ParsedBars = {
  /** time, open, high, low, close, volume per bar, time-ascending, one bar per time. */
  rows: number[];
  /** Bar size of the file, as an interval id ("1D", "5", "1S"…). */
  base: string;
  hasVolume: boolean;
  /** 10^decimals of the prices as written (at most 8). */
  pricescale: number;
  /** Lines that were not bars (bad time or price). */
  skipped: number;
};

/** Values per bar in `rows`. */
export const ROW = 6;

/** Ticker name of a series: A-Z, 0-9, '.', '_' or '-', at most 42 (also its file name). */
export const SERIES_NAME = /^[A-Z0-9._-]{1,42}$/;

/** A valid series name from a file name ("btc dev activity.csv" → "BTC_DEV_ACTIVITY"). */
export function seriesNameFromFile(fileName: string): string {
  const stem = fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "");
  const name = stem.toUpperCase().replace(/[^A-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 42);
  return name || "SERIES";
}

type Cell = string;

/** UNIX seconds of a time cell: UNIX seconds or ms, or a date with an
 *  optional time of day and offset (none = wall time in `timeZone`). */
export function parseTime(cell: string, timeZone: string, order: DateOrder = "mdy"): { sec: number; dateOnly: boolean } | null {
  const st = parseStamp(cell, order);
  if (!st) return null;
  if (st.kind === "utc") return { sec: st.sec, dateOnly: false };
  const day = Date.UTC(st.y, st.m, st.d) / 86400000;
  return { sec: localToUtc(timeZone, day, 0) + st.h * 3600 + st.mi * 60 + st.s, dateOnly: st.dateOnly };
}

/** Header cell → its column role. */
function roleOf(header: string): string | null {
  const h = header.toLowerCase().replace(/[<>"]/g, "").replace(/[\s_]+/g, " ").trim();
  if (["time", "date", "datetime", "date time", "timestamp", "gmt time", "local time", "date/time", "dt"].includes(h)) {
    return h === "time" ? "time" : h === "date" ? "date" : "datetime";
  }
  if (["open", "o"].includes(h)) return "open";
  if (["high", "h"].includes(h)) return "high";
  if (["low", "l"].includes(h)) return "low";
  if (["close", "c", "last", "price", "value"].includes(h)) return "close";
  if (["volume", "vol", "v"].includes(h)) return "volume";
  if (["tickvol", "tick volume", "tickvolume"].includes(h)) return "tickvolume";
  return null;
}

type Layout = { date: number; time: number; open: number; high: number; low: number; close: number; volume: number[] };

/** Columns of a file with a header, or null when the first line is not one. */
function headerLayout(cells: Cell[]): Layout | null {
  const roles = cells.map(roleOf);
  const find = (r: string) => roles.indexOf(r);
  // Our export's time column is "time"; a separate date and time column pair is the other layout.
  let date = find("datetime");
  let time = -1;
  if (date < 0) {
    const d = find("date");
    const t = find("time");
    if (d >= 0 && t >= 0) { date = d; time = t; }
    else date = d >= 0 ? d : t;
  }
  let close = find("close");
  // "DATE,UNRATE": a time and one value.
  if (close < 0 && date >= 0 && time < 0 && cells.length === 2) close = 1 - date;
  if (date < 0 || close < 0) return null;
  const vols = [find("volume"), find("tickvolume")].filter((i) => i >= 0);
  return { date, time, open: find("open"), high: find("high"), low: find("low"), close, volume: vols };
}

/** Columns of a file without a header, from its first line. */
function positionalLayout(cells: Cell[]): Layout | null {
  const timeCol = cells.length > 2 && parseClock(cells[1]) !== null ? 1 : -1;
  const at = timeCol >= 0 ? 2 : 1;
  const n = cells.length - at;
  if (n === 1) return { date: 0, time: timeCol, open: -1, high: -1, low: -1, close: at, volume: [] };
  if (n < 4) return null;
  return { date: 0, time: timeCol, open: at, high: at + 1, low: at + 2, close: at + 3, volume: n > 4 ? [at + 4] : [] };
}

function decimalsOf(cell: string): number {
  const i = cell.indexOf(".");
  if (i < 0 || /e/i.test(cell)) return 0;
  return Math.min(8, cell.length - i - 1);
}

function num(cell: string | undefined): number {
  if (cell === undefined || cell === "") return NaN;
  return Number(cell);
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** Bar size of time-ascending bar times: daily when every bar is a date or
 *  a day or more lies between any two bars, else the largest second count
 *  dividing every gap ("5" = 5 minutes, "30S"). */
export function detectBase(times: number[], dateOnly: boolean, timeZone: string): string {
  if (dateOnly) return "1D";
  let g = 0;
  let minGap = Infinity;
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1];
    if (g !== 1) g = gcd(g, gap);
    if (gap < minGap) minGap = gap;
  }
  if (g === 0) return localToUtc(timeZone, localDay(timeZone, times[0]), 0) === times[0] ? "1D" : "1";
  // 23 hours: a DST change shortens one day of daily bars stamped at a zone's midnight.
  if (minGap >= 82800) return "1D";
  if (g % 60 === 0) return String(Math.min(g / 60, 1440));
  return `${g}S`;
}

/** Bars of a CSV file. Throws with a message for the user when the file
 *  holds no bars. */
export function parseBarsCsv(text: string, timeZone: string): ParsedBars {
  const table = parseCsv(text).filter((r) => !r[0]?.startsWith("#"));
  if (table.length === 0) throw new Error("The file is empty.");
  const first = table[0];
  let layout = headerLayout(first);
  let start = 1;
  if (!layout) {
    if (!parseTime(first[0], timeZone)) throw new Error("No time column: the first line must be a header (time, open, high, low, close, volume) or a bar.");
    layout = positionalLayout(first);
    start = 0;
    if (!layout) throw new Error("A bar needs a time and either one value or open, high, low and close.");
  }
  const rowsCells = table.slice(start);
  const L = layout;
  const timeCell = (c: Cell[]) => (L.time >= 0 ? `${c[L.date] ?? ""} ${c[L.time] ?? ""}` : (c[L.date] ?? ""));
  // "a/b/yyyy" dates: day first when the file shows it, else month first.
  const order = detectDateOrder(rowsCells.map((c) => c[L.date] ?? "")) ?? "mdy";
  // Volume: the first volume column with a non-zero value (a "VOL" of zeros next to "TICKVOL").
  let volCol = -1;
  for (const v of L.volume) {
    if (rowsCells.some((c) => num(c[v]) > 0)) { volCol = v; break; }
  }

  const byTime = new Map<number, number[]>();
  let dateOnly = true;
  let skipped = 0;
  let decimals = 0;
  for (let i = 0; i < rowsCells.length; i++) {
    const c = rowsCells[i];
    const stamp = parseTime(timeCell(c), timeZone, order);
    const close = num(c[L.close]);
    const open = L.open >= 0 ? num(c[L.open]) : close;
    const high = L.high >= 0 ? num(c[L.high]) : close;
    const low = L.low >= 0 ? num(c[L.low]) : close;
    if (!stamp || ![open, high, low, close].every(Number.isFinite)) { skipped++; continue; }
    const vol = volCol >= 0 ? num(c[volCol]) : 0;
    dateOnly &&= stamp.dateOnly;
    // Prices as written set the grid; the first and last thousand bars are enough.
    if (i < 1000 || i >= rowsCells.length - 1000) {
      for (const k of [L.open, L.high, L.low, L.close]) if (k >= 0) decimals = Math.max(decimals, decimalsOf(c[k] ?? ""));
    }
    byTime.set(stamp.sec, [
      stamp.sec,
      open,
      Math.max(open, high, low, close),
      Math.min(open, high, low, close),
      close,
      Number.isFinite(vol) && vol > 0 ? vol : 0,
    ]);
  }
  if (byTime.size === 0) throw new Error("No bar could be read: check the time and price columns.");
  if (skipped > byTime.size) throw new Error(`Most lines are not bars (${skipped} of ${skipped + byTime.size}).`);
  let bars = [...byTime.values()].sort((a, b) => a[0] - b[0]);
  const base = detectBase(bars.map((b) => b[0]), dateOnly, timeZone);
  // Daily bars stamp the local midnight of their day (the app's daily-bar convention).
  if (base === "1D" && !dateOnly) {
    const byDay = new Map<number, number[]>();
    for (const b of bars) {
      const t = localToUtc(timeZone, localDay(timeZone, b[0]), 0);
      byDay.set(t, [t, ...b.slice(1)]);
    }
    bars = [...byDay.values()];
  }
  return { rows: bars.flat(), base, hasVolume: volCol >= 0, pricescale: 10 ** decimals, skipped };
}

/** Descriptions and price grids of a Pine Seeds `symbol_info/<repo>.json`:
 *  by symbol name. Each field is one value for every symbol or an array of
 *  one value per symbol. */
export function parseSeedSymbolInfo(text: string): Map<string, { description?: string; pricescale?: number }> {
  const out = new Map<string, { description?: string; pricescale?: number }>();
  const info = JSON.parse(text) as Record<string, unknown>;
  const symbols = Array.isArray(info.symbol) ? info.symbol : info.symbol != null ? [info.symbol] : [];
  const pick = (field: unknown, i: number) => (Array.isArray(field) ? field[i] : field);
  symbols.forEach((s, i) => {
    const description = pick(info.description, i);
    const pricescale = Number(pick(info.pricescale, i));
    out.set(String(s).toUpperCase(), {
      description: typeof description === "string" ? description : undefined,
      pricescale: Number.isFinite(pricescale) && pricescale >= 1 ? pricescale : undefined,
    });
  });
  return out;
}
