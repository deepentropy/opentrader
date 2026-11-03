/*
 * Trade journal tools of Settings > Coding agents: import a list of trades into a journal, read the trades with the
 * values read on the bars, and show one on the active chart (the same store as the Trade journal tab).
 */
import { tradeJournal, type Journal } from "../data/trade-journal";
import { parseNumber, parseSide, parseStamp, type ParsedTrade } from "../data/trade-journal-csv";
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

export function createJournalTools(): AgentTool[] {
  return [
    {
      name: "import_trades",
      title: "Import trades",
      description:
        "Add a list of trades to the trade journal (a new journal, or `into` an existing one by name) and open the Trade journal tab. " +
        "Each trade needs symbol, entry and exit; side (long/short), qty, entryPrice, exitPrice, fees and notes are optional. " +
        "Missing prices are read on the bars; P&L, run-up and drawdown are computed in the background (see list_journal_trades).",
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
        },
        required: ["trades"],
      },
      run: async (args) => {
        if (!Array.isArray(args.trades) || args.trades.length === 0) throw new AgentError("trades: a non-empty array.");
        const parsed = args.trades.map(parseTrade);
        const into = typeof args.into === "string" ? journalNamed(args.into).id : undefined;
        const zone = typeof args.timeZone === "string" && args.timeZone.trim() ? args.timeZone.trim() : "exchange";
        if (zone !== "exchange") {
          try {
            new Intl.DateTimeFormat("en-US", { timeZone: zone });
          } catch {
            throw new AgentError(`timeZone: unknown zone "${zone}".`);
          }
        }
        const name = typeof args.name === "string" && args.name.trim() ? args.name.trim() : "Imported trades";
        const r = await tradeJournal.importTrades(parsed, { name, zone, into });
        tradeJournal.setOpen(true);
        const j = tradeJournal.journals().find((x) => x.id === r.id);
        return { journal: j?.name, added: r.added, unknownSymbols: r.unknown, leftOut: r.dropped };
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
        if (args.wait === true) {
          const end = Date.now() + 60_000;
          while (j.trades.some((t) => t.status === "pending") && Date.now() < end) {
            await sleep(250);
            j = tradeJournal.journals().find((x) => x.id === j.id) ?? j;
          }
        }
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
