/*
 * Trade journal tools of Settings > Coding agents: import a list of trades into a journal, read the trades with the
 * values read on the bars, sum them up, and show one on the active chart (the same store as the Trade journal tab).
 */
import { tradeJournal, type Journal, type JournalTrade } from "../data/trade-journal";
import {
  FIELDS,
  buildStrategyTesterTrades,
  buildTrades,
  detectDelimiter,
  effectiveOrder,
  guessMapping,
  isStrategyTesterExport,
  parseCsv,
  parseNumber,
  parseSide,
  parseStamp,
  type DateOrder,
  type Field,
  type Mapping,
  type ParsedTrade,
} from "../data/trade-journal-csv";
import { attachment } from "../data/assistant/attachments";
import { AgentError, type AgentTool } from "./mcp";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function journalNamed(name: unknown): Journal {
  const n = typeof name === "string" ? name.trim().toLowerCase() : "";
  const j = n ? tradeJournal.journals().find((x) => x.name.toLowerCase() === n) : tradeJournal.active();
  if (!j) throw new AgentError(n ? `No journal named "${name}": see list_journal_trades without a name.` : "No trade journal yet: import_trades first.");
  return j;
}

/** A value given as a number or a numeric string. */
const numberOf = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" ? (parseNumber(v) ?? undefined) : undefined;

/** A trade of import_trades' input. */
function parseTrade(raw: unknown, i: number): ParsedTrade {
  const r = (raw ?? {}) as Record<string, unknown>;
  const at = (v: unknown, what: string) => {
    const st = typeof v === "number" ? parseStamp(String(Math.floor(v))) : typeof v === "string" ? parseStamp(v, "ymd") : null;
    if (!st) throw new AgentError(`trades[${i}].${what}: a date "YYYY-MM-DD", a time "YYYY-MM-DD HH:MM[:SS]", an ISO time with an offset, or UNIX seconds.`);
    return st;
  };
  const symbol = typeof r.symbol === "string" ? r.symbol.trim().toUpperCase() : "";
  if (!symbol) throw new AgentError(`trades[${i}].symbol is required.`);
  const side = typeof r.side === "string" ? parseSide(r.side) : null;
  return {
    symbol,
    side: side ?? "long",
    entry: at(r.entry, "entry"),
    exit: at(r.exit, "exit"),
    qty: numberOf(r.qty),
    entryPrice: numberOf(r.entryPrice),
    exitPrice: numberOf(r.exitPrice),
    fees: numberOf(r.fees),
    notes: typeof r.notes === "string" && r.notes.trim() ? r.notes.trim() : undefined,
  };
}

// ── A trade file (attached to the chat, or its text) ──

const FIELD_IDS = FIELDS.map((f) => f.id);
const ORDERS: DateOrder[] = ["ymd", "mdy", "dmy"];
const SHOWN_ROWS = 5;

type TradeFile = { name: string; delimiter: string; headers: string[]; body: string[][] };

/** The file of `file` (an attachment id) or `csv` (its text). */
function tradeFile(args: Record<string, unknown>): TradeFile {
  let name = "pasted text";
  let text: string;
  if (typeof args.file === "string" && args.file.trim()) {
    const a = attachment(args.file);
    if (!a) throw new AgentError(`No attached file "${args.file}": the user attaches it again (files are kept until the app closes).`);
    ({ name, text } = a);
  } else if (typeof args.csv === "string" && args.csv.trim()) text = args.csv;
  else throw new AgentError('"file" (the id of an attached file) or "csv" (the text of the file) is required.');
  const delimiter = detectDelimiter(text);
  const [headers = [], ...body] = parseCsv(text, delimiter);
  if (!headers.length || !body.length) throw new AgentError(`${name}: no rows under a header line.`);
  return { name, delimiter, headers: headers.map((h) => h.trim()), body };
}

/** Field -> column name, as the agent reads and writes a mapping. */
function namedMapping(m: Mapping, headers: string[]): Partial<Record<Field, string>> {
  const out: Partial<Record<Field, string>> = {};
  for (const f of FIELD_IDS) if (m[f] !== undefined) out[f] = headers[m[f]!];
  return out;
}

/** The guessed mapping with the agent's columns (by name, any case) over it; null drops a guessed one. */
function mappingOf(raw: unknown, headers: string[]): Mapping {
  const m = guessMapping(headers);
  if (raw === undefined) return m;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AgentError('"mapping": an object field -> column name ({"symbol": "Ticker"}).');
  for (const [field, col] of Object.entries(raw as Record<string, unknown>)) {
    if (!FIELD_IDS.includes(field as Field)) throw new AgentError(`mapping: unknown field "${field}"; fields: ${FIELD_IDS.join(", ")}.`);
    if (col === null || col === "") {
      delete m[field as Field];
      continue;
    }
    const i = typeof col === "string" ? headers.findIndex((h) => h.toLowerCase() === col.trim().toLowerCase()) : -1;
    if (i < 0) throw new AgentError(`mapping.${field}: no column "${String(col)}"; columns: ${headers.join(", ")}.`);
    // A column serves one field.
    for (const f of FIELD_IDS) if (m[f] === i) delete m[f];
    m[field as Field] = i;
  }
  return m;
}

/** The trades of a file as mapped, or the reason they can't be read. */
function fileTrades(args: Record<string, unknown>): { name: string; parsed: ParsedTrade[]; unread: { row: number; message: string }[] } {
  const f = tradeFile(args);
  const symbol = typeof args.symbol === "string" && args.symbol.trim() ? args.symbol.trim().toUpperCase() : undefined;
  if (isStrategyTesterExport(f.headers)) {
    if (!symbol) throw new AgentError(`${f.name} is a Strategy Tester list of trades, which has no symbol column: give "symbol".`);
    const r = buildStrategyTesterTrades(f.headers, f.body, symbol);
    return { name: f.name, parsed: r.trades, unread: r.errors };
  }
  const m = mappingOf(args.mapping, f.headers);
  const missing: string[] = (["entry", "exit"] as const).filter((x) => m[x] === undefined);
  if (m.symbol === undefined && !symbol) missing.unshift("symbol");
  if (missing.length)
    throw new AgentError(
      `No column for ${missing.join(", ")}: give mapping (read_trade_file shows the columns)${m.symbol === undefined ? ', or "symbol" when every trade is of one symbol' : ""}.`,
    );
  const order = args.dateOrder === undefined ? null : (args.dateOrder as DateOrder);
  if (order !== null && !ORDERS.includes(order)) throw new AgentError(`dateOrder: one of ${ORDERS.join(", ")}.`);
  const decimalComma = typeof args.decimalComma === "boolean" ? args.decimalComma : f.delimiter === ";";
  const r = buildTrades(f.body, m, { order, symbol, decimalComma });
  return { name: f.name, parsed: r.trades, unread: r.errors };
}

/** The journal once no trade is pending (up to 60 s), else as it is then. */
async function settled(j: Journal): Promise<Journal> {
  const end = Date.now() + 60_000;
  while (j.trades.some((t) => t.status === "pending") && Date.now() < end) {
    await sleep(250);
    j = tradeJournal.journals().find((x) => x.id === j.id) ?? j;
  }
  return j;
}

const SUMMARY_BY = ["none", "symbol", "side", "day", "week", "month", "year"] as const;
type SummaryBy = (typeof SUMMARY_BY)[number];

/** "YYYY-MM-DD" of a trade's entry in its exchange's zone. */
function entryDay(t: JournalTrade): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: t.zone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t.entryTime * 1000));
}

function groupKey(t: JournalTrade, by: SummaryBy): string {
  switch (by) {
    case "symbol":
      return t.fullSymbol ?? t.symbol;
    case "side":
      return t.side;
    case "day":
      return entryDay(t);
    case "week": {
      // The Monday of the entry's week.
      const d = new Date(`${entryDay(t)}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      return `week of ${d.toISOString().slice(0, 10)}`;
    }
    case "month":
      return entryDay(t).slice(0, 7);
    case "year":
      return entryDay(t).slice(0, 4);
    default:
      return "";
  }
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

/** The totals of some trades: counts, winners (net of fees), P&L and moves (fractions), the best and the worst. */
function stats(trades: { t: JournalTrade; number: number }[]) {
  const done = trades.filter((x) => x.t.calc);
  const pct = done.map((x) => x.t.calc!.pnlPct);
  const wins = done.filter((x) => x.t.calc!.pnl > 0);
  const losses = done.filter((x) => x.t.calc!.pnl < 0);
  const gains = pct.filter((m) => m > 0).reduce((a, m) => a + m, 0);
  const lost = -pct.filter((m) => m < 0).reduce((a, m) => a + m, 0);
  const mean = (l: number[]) => (l.length ? round(l.reduce((a, v) => a + v, 0) / l.length, 4) : null);
  const by = (sign: 1 | -1) => (done.length ? done.reduce((b, x) => (sign * x.t.calc!.pnlPct > sign * b.t.calc!.pnlPct ? x : b)) : null);
  const brief = (x: { t: JournalTrade; number: number } | null) =>
    x ? { number: x.number, symbol: x.t.fullSymbol ?? x.t.symbol, pnl: round(x.t.calc!.pnl, 2), pnlPct: round(x.t.calc!.pnlPct, 4) } : null;
  return {
    trades: trades.length,
    computed: done.length,
    winners: wins.length,
    losers: losses.length,
    winRate: done.length ? round(wins.length / done.length, 4) : null,
    netPnl: round(done.reduce((a, x) => a + x.t.calc!.pnl, 0), 2),
    averagePnlPct: mean(pct),
    averageWinPct: mean(wins.map((x) => x.t.calc!.pnlPct)),
    averageLossPct: mean(losses.map((x) => x.t.calc!.pnlPct)),
    profitFactor: lost > 0 ? round(gains / lost, 2) : null,
    averageRunUpPct: mean(done.map((x) => x.t.calc!.runUpPct)),
    averageDrawdownPct: mean(done.map((x) => x.t.calc!.drawdownPct)),
    best: brief(by(1)),
    worst: brief(by(-1)),
  };
}

export function createJournalTools(): AgentTool[] {
  return [
    {
      name: "import_trades",
      title: "Import trades",
      description:
        "Add a list of trades to the trade journal (a new journal, or `into` an existing one by name) and open the Trade journal tab. " +
        "Each trade needs symbol, entry and exit; side (long/short), qty, entryPrice, exitPrice, fees and notes are optional. " +
        "Missing prices are read on the bars; P&L, run-up and drawdown are computed in the background (see list_journal_trades). " +
        "A file of trades: file (an attached file's id) or csv (its text) instead of trades, read by the app with mapping " +
        "(field -> column name, over the columns it guessed: read_trade_file first), and dateOrder / decimalComma / symbol when needed.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name of a new journal." },
          into: { type: "string", description: "Name of an existing journal to add to." },
          timeZone: { type: "string", description: '"exchange" (default: each symbol\'s exchange zone), "UTC" or an IANA zone the times are in.' },
          trades: {
            type: "array",
            items: {
              type: "object",
              properties: {
                symbol: { type: "string" },
                entry: { type: ["string", "number"], description: '"YYYY-MM-DD", "YYYY-MM-DD HH:MM[:SS]", ISO with offset, or UNIX seconds.' },
                exit: { type: ["string", "number"] },
                side: { type: "string", enum: ["long", "short"] },
                qty: { type: "number" },
                entryPrice: { type: "number" },
                exitPrice: { type: "number" },
                fees: { type: "number" },
                notes: { type: "string" },
              },
              required: ["symbol", "entry", "exit"],
            },
          },
          file: { type: "string", description: "Id of a file attached to the chat (instead of trades)." },
          csv: { type: "string", description: "The text of a CSV file of trades (instead of trades)." },
          mapping: {
            type: "object",
            description: `Field -> column name of the file, over the guessed ones (null leaves a field out). Fields: ${FIELD_IDS.join(", ")} (entryClock / exitClock: a separate time column).`,
          },
          dateOrder: { type: "string", enum: ORDERS, description: 'Order of numeric dates ("05/01/2026"); default: detected, else month first.' },
          decimalComma: { type: "boolean", description: "Numbers written 1 234,50 (default: when the file's delimiter is ;)." },
          symbol: { type: "string", description: "Every trade's symbol, when the file has no symbol column." },
        },
      },
      run: async (args) => {
        const fromFile = args.file !== undefined || args.csv !== undefined;
        if (fromFile && args.trades !== undefined) throw new AgentError("Give trades, or a file (file / csv), not both.");
        if (!fromFile && (!Array.isArray(args.trades) || args.trades.length === 0)) throw new AgentError("trades: a non-empty array (or file / csv).");
        const read = fromFile ? fileTrades(args) : null;
        const parsed = read ? read.parsed : (args.trades as unknown[]).map(parseTrade);
        if (read && parsed.length === 0)
          throw new AgentError(`No trade read in ${read.name}: ${read.unread.slice(0, 5).map((e) => `row ${e.row}: ${e.message}`).join("; ")}.`);
        const into = typeof args.into === "string" ? journalNamed(args.into).id : undefined;
        const zone = typeof args.timeZone === "string" && args.timeZone.trim() ? args.timeZone.trim() : "exchange";
        if (zone !== "exchange") {
          try {
            new Intl.DateTimeFormat("en-US", { timeZone: zone });
          } catch {
            throw new AgentError(`timeZone: unknown zone "${zone}".`);
          }
        }
        const fileName = read && read.name !== "pasted text" ? read.name.replace(/\.[^.]+$/, "") : "";
        const name = typeof args.name === "string" && args.name.trim() ? args.name.trim() : fileName || "Imported trades";
        const r = await tradeJournal.importTrades(parsed, { name, zone, into });
        tradeJournal.setOpen(true);
        const j = tradeJournal.journals().find((x) => x.id === r.id);
        return {
          journal: j?.name,
          added: r.added,
          unknownSymbols: r.unknown,
          leftOut: r.dropped,
          ...(read?.unread.length ? { unreadRows: read.unread.length, unread: read.unread.slice(0, 5) } : {}),
        };
      },
    },
    {
      name: "read_trade_file",
      title: "Read trade file",
      description:
        "The columns of a file of trades (file: an attached file's id, or csv: its text), its first rows, its row count, and the columns the app " +
        "guessed for each field (mapping: field -> column; missing: required fields without one). Then import_trades with the file and the " +
        "mapping the guess lacks or gets wrong.",
      inputSchema: {
        type: "object",
        properties: {
          file: { type: "string", description: "Id of a file attached to the chat." },
          csv: { type: "string", description: "The text of a CSV file." },
        },
      },
      annotations: { readOnlyHint: true },
      run: async (args) => {
        const f = tradeFile(args);
        const firstRows = f.body.slice(0, SHOWN_ROWS).map((r) => Object.fromEntries(f.headers.map((h, i) => [h, r[i] ?? ""])));
        if (isStrategyTesterExport(f.headers))
          return {
            name: f.name,
            rows: f.body.length,
            columns: f.headers,
            firstRows,
            strategyTesterExport: true,
            note: 'A Strategy Tester list of trades: import_trades reads it as is, with "symbol" (it has none).',
          };
        const m = guessMapping(f.headers);
        const dates = f.body.flatMap((r) => (["entry", "exit"] as const).map((x) => (m[x] === undefined ? "" : (r[m[x]!] ?? "").trim())));
        const numericDates = dates.some((d) => /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}/.test(d));
        return {
          name: f.name,
          rows: f.body.length,
          columns: f.headers,
          firstRows,
          mapping: namedMapping(m, f.headers),
          missing: (["symbol", "entry", "exit"] as const).filter((x) => m[x] === undefined),
          ...(numericDates ? { dateOrder: effectiveOrder(f.body, m, null) } : {}),
          ...(f.delimiter === ";" ? { decimalComma: true } : {}),
        };
      },
    },
    {
      name: "list_journal_trades",
      title: "List journal trades",
      description:
        "The journals (names, trade counts) and the trades of one (default: the one shown), with the values read on the bars: " +
        "entry/exit price (estimated when not imported), pnl, pnlPct, runUpPct, drawdownPct (fractions). status: ok, pending (still reading), unknown (symbol), nodata.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Journal name (default: the one shown)." },
          wait: { type: "boolean", description: "Wait (up to 60 s) until no trade is pending." },
        },
      },
      annotations: { readOnlyHint: true },
      run: async (args) => {
        if (tradeJournal.journals().length === 0) return { journals: [], trades: [] };
        let j = journalNamed(args.name);
        if (args.wait === true) j = await settled(j);
        return {
          journals: tradeJournal.journals().map((x) => ({ name: x.name, trades: x.trades.length })),
          journal: j.name,
          trades: j.trades.map((t, i) => ({
            number: i + 1,
            symbol: t.fullSymbol ?? t.symbol,
            side: t.side,
            entryTime: t.entryTime,
            exitTime: t.exitTime,
            dateOnly: t.dateOnly,
            qty: t.qty,
            status: t.status,
            ...(t.calc
              ? {
                  entryPrice: t.calc.entryPrice,
                  exitPrice: t.calc.exitPrice,
                  pricesEstimated: t.calc.entryEstimated || t.calc.exitEstimated,
                  pnl: t.calc.pnl,
                  pnlPct: t.calc.pnlPct,
                  runUpPct: t.calc.runUpPct,
                  drawdownPct: t.calc.drawdownPct,
                }
              : {}),
            notes: t.notes,
          })),
        };
      },
    },
    {
      name: "journal_summary",
      title: "Journal summary",
      description:
        "The totals of a journal (default: the one shown), computed by the app: trades, winners and losers (net of fees), winRate, netPnl, " +
        "averagePnlPct, averageWinPct, averageLossPct, profitFactor, average run-up and drawdown, the best and worst trade (*Pct and winRate are fractions). " +
        "by: also the same totals per symbol, side, day, week, month or year of entry (exchange time). Waits until the trades are computed. " +
        "Quote these figures; don't add up list_journal_trades yourself.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Journal name (default: the one shown)." },
          by: { type: "string", enum: [...SUMMARY_BY], description: 'Totals per group too (default "none").' },
        },
      },
      annotations: { readOnlyHint: true },
      run: async (args) => {
        const by = (args.by ?? "none") as SummaryBy;
        if (!SUMMARY_BY.includes(by)) throw new AgentError(`by: one of ${SUMMARY_BY.join(", ")}.`);
        const j = await settled(journalNamed(args.name));
        const rows = j.trades.map((t, i) => ({ t, number: i + 1 }));
        const pending = j.trades.filter((t) => t.status === "pending").length;
        const unread = j.trades.filter((t) => t.status === "unknown" || t.status === "nodata").length;
        const out: Record<string, unknown> = { journal: j.name, ...stats(rows) };
        if (pending) out.pending = pending;
        if (unread) out.withoutValues = unread;
        if (by !== "none") {
          const groups = new Map<string, typeof rows>();
          for (const r of rows) {
            const k = groupKey(r.t, by);
            groups.set(k, [...(groups.get(k) ?? []), r]);
          }
          const keys = [...groups.keys()].sort();
          // Dates newest first; symbols and sides by net P&L.
          const ordered = by === "symbol" || by === "side" ? keys.sort((a, b) => stats(groups.get(b)!).netPnl - stats(groups.get(a)!).netPnl) : keys.reverse();
          out.groups = ordered.map((k) => {
            const { best: _b, worst: _w, ...g } = stats(groups.get(k)!);
            return { [by]: k, ...g };
          });
        }
        return out;
      },
    },
    {
      name: "show_journal_trade",
      title: "Show a journal trade",
      description: "Show a trade of a journal on the active chart (its symbol, an interval that fits it, framed from entry to exit), optionally starting Bar Replay at its entry.",
      inputSchema: {
        type: "object",
        properties: {
          number: { type: "integer", description: "Trade number (list_journal_trades)." },
          name: { type: "string", description: "Journal name (default: the one shown)." },
          replay: { type: "boolean", description: "Start Bar Replay at the entry." },
        },
        required: ["number"],
      },
      run: async (args) => {
        const j = journalNamed(args.name);
        const n = typeof args.number === "number" ? Math.floor(args.number) : NaN;
        const t = j.trades[n - 1];
        if (!t) throw new AgentError(`number: 1 to ${j.trades.length}.`);
        if (!t.fullSymbol) throw new AgentError(`Trade ${n}: unknown symbol "${t.symbol}".`);
        tradeJournal.setActiveId(j.id);
        tradeJournal.setOpen(true);
        tradeJournal.show(t, args.replay === true);
        return { shown: n, symbol: t.fullSymbol };
      },
    },
  ];
}
