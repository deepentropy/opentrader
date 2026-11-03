/*
 * Trade journal import: a CSV of trades read into wall-clock trades. Pure (no
 * time zone, no symbol lookup): the store turns the stamps into UTC once the
 * symbols and their exchange zones are known.
 *
 * Two shapes are read:
 * - one row per trade, its columns mapped to the fields below (guessed from
 *   the header, changed in the import dialog);
 * - the Strategy Tester "List of trades" export (2 rows per trade, exit row
 *   then entry row, no symbol column).
 */

export type Field =
  | "symbol"
  | "entry"
  | "entryClock"
  | "exit"
  | "exitClock"
  | "side"
  | "qty"
  | "entryPrice"
  | "exitPrice"
  | "fees"
  | "notes";

/** Import dialog order and labels; the first three are required. */
export const FIELDS: { id: Field; label: string; required?: boolean }[] = [
  { id: "symbol", label: "Symbol", required: true },
  { id: "entry", label: "Entry date/time", required: true },
  { id: "exit", label: "Exit date/time", required: true },
  { id: "entryClock", label: "Entry time (separate column)" },
  { id: "exitClock", label: "Exit time (separate column)" },
  { id: "side", label: "Side" },
  { id: "qty", label: "Quantity" },
  { id: "entryPrice", label: "Entry price" },
  { id: "exitPrice", label: "Exit price" },
  { id: "fees", label: "Fees" },
  { id: "notes", label: "Notes" },
];

/** Column index per field. */
export type Mapping = Partial<Record<Field, number>>;

/** Order of the day, month and year in a numeric date ("05/01/2024"). */
export type DateOrder = "ymd" | "mdy" | "dmy";

/** A time read from the file: a wall-clock time (month 0-based), read later in
 *  the chosen time zone, or an instant when the file says so (epoch, ISO with
 *  an offset). `dateOnly`: the file gave no time of day. */
export type Stamp =
  | { kind: "wall"; y: number; m: number; d: number; h: number; mi: number; s: number; dateOnly: boolean }
  | { kind: "utc"; sec: number; dateOnly: false };

export type ParsedTrade = {
  symbol: string;
  side: "long" | "short";
  entry: Stamp;
  exit: Stamp;
  qty?: number;
  entryPrice?: number;
  exitPrice?: number;
  fees?: number;
  notes?: string;
};

export type ParseResult = { trades: ParsedTrade[]; errors: { row: number; message: string }[] };

// ── CSV ──────────────────────────────────────────────────────────────────────

/** The delimiter of the first line: the most frequent of , ; tab outside quotes. */
export function detectDelimiter(text: string): string {
  const line = text.replace(/^﻿/, "").split(/\r?\n/, 1)[0] ?? "";
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch in counts) counts[ch]++;
  }
  const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return n > 0 ? best : ",";
}

/** Rows of a CSV text (RFC 4180 quotes, CRLF or LF, BOM dropped); blank lines skipped. */
export function parseCsv(text: string, delimiter = detectDelimiter(text)): string[][] {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows.map((r) => r.map((c) => c.trim()));
}

// ── Header guess ─────────────────────────────────────────────────────────────

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Header names per field: exact names first, then words a name may contain. */
const NAMES: Record<Field, { exact: string[]; contains: string[] }> = {
  symbol: { exact: ["symbol", "ticker", "instrument", "underlying", "stock", "security", "contract", "asset", "market"], contains: ["symbol", "ticker"] },
  entry: {
    exact: ["entry", "entrytime", "entrydate", "entrydatetime", "opentime", "opendate", "opendatetime", "opened", "dateopened", "timeopened", "buydate", "timein", "datein", "start", "starttime", "startdate"],
    contains: ["entrydate", "entrytime", "opendate", "opentime", "opened"],
  },
  exit: {
    exact: ["exit", "exittime", "exitdate", "exitdatetime", "closetime", "closedate", "closedatetime", "closed", "dateclosed", "timeclosed", "selldate", "timeout", "dateout", "end", "endtime", "enddate"],
    contains: ["exitdate", "exittime", "closedate", "closetime", "closed"],
  },
  entryClock: { exact: ["entryclock", "entryhour", "opentimeofday"], contains: [] },
  exitClock: { exact: ["exitclock", "exithour", "closetimeofday"], contains: [] },
  side: { exact: ["side", "direction", "type", "position", "longshort", "action", "buysell", "dir"], contains: ["direction", "side"] },
  qty: { exact: ["qty", "quantity", "shares", "size", "positionsize", "contracts", "units", "sizeqty", "volume", "lots"], contains: ["quantity", "qty", "shares"] },
  entryPrice: {
    exact: ["entryprice", "openprice", "buyprice", "avgentry", "avgentryprice", "pricein", "entryavg", "avgbuyprice", "costbasis", "avgprice"],
    contains: ["entryprice", "openprice", "pricein"],
  },
  exitPrice: { exact: ["exitprice", "closeprice", "sellprice", "avgexit", "avgexitprice", "priceout", "exitavg", "avgsellprice"], contains: ["exitprice", "closeprice", "priceout"] },
  fees: { exact: ["fees", "fee", "commission", "commissions", "comm", "costs"], contains: ["commission", "fee"] },
  notes: { exact: ["notes", "note", "comment", "comments", "setup", "tags", "tag", "strategy", "remarks"], contains: ["note", "comment"] },
};

/** Columns guessed from the header row: each field takes the first column of
 *  its exact names, else of its contained words; a column serves one field. */
export function guessMapping(headers: string[]): Mapping {
  const keys = headers.map(norm);
  const used = new Set<number>();
  const out: Mapping = {};
  const fields = Object.keys(NAMES) as Field[];
  for (const pass of ["exact", "contains"] as const) {
    for (const f of fields) {
      if (out[f] !== undefined) continue;
      const names = NAMES[f][pass];
      const i = keys.findIndex((k, j) => !used.has(j) && (pass === "exact" ? names.includes(k) : names.some((n) => k.includes(n))));
      if (i >= 0) {
        out[f] = i;
        used.add(i);
      }
    }
  }
  return out;
}

/** The Strategy Tester "List of trades" export (trades-csv.ts). */
export function isStrategyTesterExport(headers: string[]): boolean {
  const k = headers.map(norm);
  return k.includes("tradenumber") && k.includes("type") && k.includes("dateandtime");
}

// ── Values ───────────────────────────────────────────────────────────────────

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Day / month order of the numeric dates of a column: day first when a first
 *  part is above 12, month first when a second part is; null when every date
 *  reads both ways. */
export function detectDateOrder(values: string[]): DateOrder | null {
  let dmy = false;
  let mdy = false;
  for (const v of values) {
    const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/.exec(v.trim());
    if (!m) continue;
    if (Number(m[1]) > 12) dmy = true;
    if (Number(m[2]) > 12) mdy = true;
  }
  if (dmy && !mdy) return "dmy";
  if (mdy && !dmy) return "mdy";
  return null;
}

/** A clock "9:35", "09:35:10", "9:35 PM", "0935" → seconds of the day; null when unreadable. */
export function parseClock(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?\s*([ap]\.?m\.?)?$/i.exec(t);
  if (!m) return null;
  let h = Number(m[1]);
  const mi = Number(m[2]);
  const sec = Number(m[3] ?? 0);
  const ap = m[4]?.toLowerCase().replace(/\./g, "");
  if (ap) {
    if (h < 1 || h > 12) return null;
    if (ap === "pm" && h !== 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
  }
  if (h > 23 || mi > 59 || sec > 59) return null;
  return h * 3600 + mi * 60 + sec;
}

const validDate = (y: number, m: number, d: number) => {
  if (m < 0 || m > 11 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m, d));
  return dt.getUTCMonth() === m && dt.getUTCDate() === d;
};
const fullYear = (y: number) => (y < 100 ? 2000 + y : y);

/** A date or date-time cell. Read: epoch seconds / milliseconds, ISO with
 *  "T" and an offset or "Z" (an instant), "2024-01-05[ 09:35[:00]]",
 *  "2024/01/05", "20240105", "05/01/2024 9:35 PM" (in `order`),
 *  "5 Jan 2024", "Jan 5, 2024". Null when unreadable. */
export function parseStamp(cell: string, order: DateOrder = "mdy"): Stamp | null {
  const s = cell.trim();
  if (s === "") return null;
  if (/^\d{9,13}(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return { kind: "utc", sec: Math.floor(n >= 1e12 ? n / 1000 : n), dateOnly: false };
  }
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? null : { kind: "utc", sec: Math.floor(ms / 1000), dateOnly: false };
  }
  let y: number, m: number, d: number;
  let rest: string;
  let r: RegExpExecArray | null;
  if ((r = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s]+(.*))?$/.exec(s))) {
    [y, m, d, rest] = [Number(r[1]), Number(r[2]) - 1, Number(r[3]), r[4] ?? ""];
  } else if ((r = /^(\d{4})(\d{2})(\d{2})(?:[T\s]+(.*))?$/.exec(s))) {
    [y, m, d, rest] = [Number(r[1]), Number(r[2]) - 1, Number(r[3]), r[4] ?? ""];
  } else if ((r = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[T\s,]+(.*))?$/.exec(s))) {
    const a = Number(r[1]);
    const b = Number(r[2]);
    y = fullYear(Number(r[3]));
    [m, d] = order === "dmy" ? [b - 1, a] : [a - 1, b];
    rest = r[4] ?? "";
  } else if ((r = /^(\d{1,2})[\s-]([a-z]{3})[a-z]*\.?[\s-],?\s*(\d{2,4})(?:[T\s,]+(.*))?$/i.exec(s))) {
    [y, m, d, rest] = [fullYear(Number(r[3])), MONTHS.indexOf(r[2].toLowerCase()), Number(r[1]), r[4] ?? ""];
  } else if ((r = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})(?:[T\s,]+(.*))?$/i.exec(s))) {
    [y, m, d, rest] = [Number(r[3]), MONTHS.indexOf(r[1].toLowerCase()), Number(r[2]), r[4] ?? ""];
  } else return null;
  if (!validDate(y, m, d)) return null;
  const clock = rest.trim() === "" ? 0 : parseClock(rest.replace(/\s*(UTC|GMT)$/i, ""));
  if (clock === null) return null;
  return {
    kind: "wall",
    y,
    m,
    d,
    h: Math.floor(clock / 3600),
    mi: Math.floor((clock % 3600) / 60),
    s: clock % 60,
    dateOnly: rest.trim() === "",
  };
}

/** A number cell: "$1,234.50", "-12", "(12.30)", "1 234,5" (decimal comma
 *  when `decimalComma`). Null when empty or unreadable. */
export function parseNumber(cell: string, decimalComma = false): number | null {
  let s = cell.trim();
  if (s === "" || s === "—" || s === "-") return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[\s '$€£¥]|USD|EUR|GBP/gi, "");
  if (decimalComma) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

/** "Long" / "Buy" / "B" → long, "Short" / "Sell" / "SS" → short; null otherwise. */
export function parseSide(cell: string): "long" | "short" | null {
  const s = cell.trim().toLowerCase();
  if (/(short|sell|sld|^s$|^ss$)/.test(s)) return "short";
  if (/(long|buy|bot|^b$|^l$)/.test(s)) return "long";
  return null;
}

/** Order of a file's dates: the detected one, else `fallback`. */
function orderFor(values: string[], fallback: DateOrder): DateOrder {
  return detectDateOrder(values) ?? fallback;
}

/** A separate clock column added to a date stamp. */
function withClock(st: Stamp, clock: string | undefined): Stamp | null {
  if (clock === undefined || clock.trim() === "" || st.kind !== "wall" || !st.dateOnly) return st;
  const c = parseClock(clock);
  if (c === null) return null;
  return { ...st, h: Math.floor(c / 3600), mi: Math.floor((c % 3600) / 60), s: c % 60, dateOnly: false };
}

export type BuildOptions = {
  /** Date order of numeric dates (null: detected from the file, else month first). */
  order?: DateOrder | null;
  /** Symbol of every row when no column holds one. */
  symbol?: string;
  decimalComma?: boolean;
};

/** Order used for a file: the option, else detected on the mapped date columns. */
export function effectiveOrder(rows: string[][], mapping: Mapping, opt: DateOrder | null | undefined): DateOrder {
  if (opt) return opt;
  const vals: string[] = [];
  for (const r of rows) for (const f of ["entry", "exit"] as const) if (mapping[f] !== undefined) vals.push(r[mapping[f]!] ?? "");
  return orderFor(vals, "mdy");
}

/** Trades of a one-row-per-trade file (`rows` without the header). Rows that
 *  cannot be read are reported, not dropped silently. */
export function buildTrades(rows: string[][], mapping: Mapping, opts: BuildOptions = {}): ParseResult {
  const order = effectiveOrder(rows, mapping, opts.order);
  const trades: ParsedTrade[] = [];
  const errors: ParseResult["errors"] = [];
  const cell = (r: string[], f: Field) => (mapping[f] === undefined ? undefined : (r[mapping[f]!] ?? ""));
  const num = (r: string[], f: Field) => {
    const c = cell(r, f);
    return c === undefined ? null : parseNumber(c, opts.decimalComma);
  };
  rows.forEach((r, i) => {
    const row = i + 2; // 1-based, after the header
    const symbol = (cell(r, "symbol") ?? opts.symbol ?? "").trim().toUpperCase();
    if (!symbol) return errors.push({ row, message: "no symbol" });
    const entryRaw = parseStamp(cell(r, "entry") ?? "", order);
    const exitRaw = parseStamp(cell(r, "exit") ?? "", order);
    const entry = entryRaw && withClock(entryRaw, cell(r, "entryClock"));
    const exit = exitRaw && withClock(exitRaw, cell(r, "exitClock"));
    if (!entry) return errors.push({ row, message: `unreadable entry date "${cell(r, "entry") ?? ""}"` });
    if (!exit) return errors.push({ row, message: `unreadable exit date "${cell(r, "exit") ?? ""}"` });
    let qty = num(r, "qty") ?? undefined;
    const sideCell = cell(r, "side");
    let side = sideCell !== undefined ? parseSide(sideCell) : null;
    if (side === null && qty !== undefined && qty < 0) side = "short";
    if (qty !== undefined) qty = Math.abs(qty);
    const notes = cell(r, "notes")?.trim();
    trades.push({
      symbol,
      side: side ?? "long",
      entry,
      exit,
      qty: qty || undefined,
      entryPrice: num(r, "entryPrice") ?? undefined,
      exitPrice: num(r, "exitPrice") ?? undefined,
      fees: num(r, "fees") !== null ? Math.abs(num(r, "fees")!) : undefined,
      notes: notes || undefined,
    });
  });
  return { trades, errors };
}

/** Trades of a Strategy Tester "List of trades" export: rows paired by trade
 *  number (an open trade, with no exit, is reported and left out). The file
 *  has no symbol: `symbol` is every trade's. */
export function buildStrategyTesterTrades(headers: string[], rows: string[][], symbol: string): ParseResult {
  const k = headers.map(norm);
  const col = (pred: (h: string) => boolean) => k.findIndex(pred);
  const cNum = col((h) => h === "tradenumber");
  const cType = col((h) => h === "type");
  const cDate = col((h) => h === "dateandtime");
  const cSignal = col((h) => h === "signal");
  const cPrice = col((h) => h.startsWith("price"));
  const cQty = col((h) => h === "sizeqty");
  const cComm = col((h) => h.startsWith("commission"));
  const byNum = new Map<string, { entry?: string[]; exit?: string[] }>();
  for (const r of rows) {
    const n = r[cNum];
    const t = (r[cType] ?? "").toLowerCase();
    const slot = byNum.get(n) ?? {};
    if (t.startsWith("entry")) slot.entry = r;
    else if (t.startsWith("exit")) slot.exit = r;
    byNum.set(n, slot);
  }
  const trades: ParsedTrade[] = [];
  const errors: ParseResult["errors"] = [];
  for (const [n, { entry, exit }] of byNum) {
    if (!entry) {
      errors.push({ row: 0, message: `trade ${n}: no entry row` });
      continue;
    }
    const entryAt = parseStamp(entry[cDate] ?? "", "ymd");
    const exitAt = exit ? parseStamp(exit[cDate] ?? "", "ymd") : null;
    if (!entryAt) {
      errors.push({ row: 0, message: `trade ${n}: unreadable entry date` });
      continue;
    }
    if (!exitAt) {
      errors.push({ row: 0, message: `trade ${n}: open trade (no exit)` });
      continue;
    }
    const signals = [entry[cSignal], exit?.[cSignal]].filter((s) => s && s !== "Open").join(" → ");
    trades.push({
      symbol: symbol.trim().toUpperCase(),
      side: (entry[cType] ?? "").toLowerCase().includes("short") ? "short" : "long",
      entry: entryAt,
      exit: exitAt,
      qty: (cQty >= 0 ? parseNumber(entry[cQty] ?? "") : null) ?? undefined,
      entryPrice: (cPrice >= 0 ? parseNumber(entry[cPrice] ?? "") : null) ?? undefined,
      exitPrice: (cPrice >= 0 && exit ? parseNumber(exit[cPrice] ?? "") : null) ?? undefined,
      fees: (cComm >= 0 && exit ? parseNumber(exit[cComm] ?? "") : null) ?? undefined,
      notes: signals || undefined,
    });
  }
  return { trades, errors };
}
