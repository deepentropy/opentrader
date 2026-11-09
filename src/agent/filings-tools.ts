/*
 * Company tools of Settings > Coding agents and the in-app assistant: a company's financial statements and earnings
 * (get_fundamentals), its filings (list_filings) and a filing's text by section (read_filing). The assistant's model
 * runs with an 8192-token context, so each answer is a selection: about ten items of one statement over a few
 * periods, ten filings, one page of one section.
 */
import { commands, type FilingList, type FilingQuery, type FilingText, type Fundamentals, type FundamentalPeriods } from "../bindings";
import { hasFundamentals } from "../data/fundamentals";
import { AgentError, type AgentTool } from "./mcp";

/** The items of each statement, in the order a statement lists them. `freeCashFlow` is derived. */
export const STATEMENT_ITEMS = {
  summary: ["revenue", "grossProfit", "operatingIncome", "netIncome", "epsDiluted", "cashFromOperations", "capex", "cash", "totalAssets", "totalLiabilities", "shareholdersEquity", "sharesOutstanding"],
  income: ["revenue", "cogs", "grossProfit", "rnd", "sga", "operatingIncome", "interestExpense", "pretaxIncome", "incomeTax", "netIncome", "epsDiluted", "sharesDiluted"],
  balance: ["cash", "shortTermInvestments", "receivables", "inventory", "currentAssets", "totalAssets", "currentLiabilities", "longTermDebt", "totalLiabilities", "shareholdersEquity", "sharesOutstanding"],
  cash_flow: ["cashFromOperations", "depreciationAmortization", "shareBasedCompensation", "capex", "freeCashFlow", "acquisitions", "cashFromInvesting", "repurchaseOfStock", "dividendsPaid", "cashFromFinancing"],
} as const;
type Statement = keyof typeof STATEMENT_ITEMS;
const STATEMENTS = Object.keys(STATEMENT_ITEMS) as Statement[];

/** The event types of a filing (the fundamentals `events`). */
export const EVENT_TYPES = [
  "activist_stake", "agreement", "agreement_end", "amended_report", "auditor_change", "bankruptcy", "control_change", "cyber_incident",
  "deal_completed", "debt_acceleration", "delisting_notice", "deregistration", "executive_change", "going_private", "impairment",
  "issuer_tender", "late_filing", "merger_vote", "new_debt", "offering", "passive_stake", "registration", "restatement",
  "restructuring", "rights_change", "shelf", "tender_offer", "unregistered_sale",
];

const ID_RE = /^\d{10}-\d{2}-\d{6}$/;
const SECTION_RE = /^[A-Za-z0-9.\-]{1,20}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ITEMS = 20;

/** The symbol asked, or the focused chart's; one that has no company behind it is refused. */
function companySymbol(raw: unknown, focused: () => string): string {
  if (raw !== undefined && (typeof raw !== "string" || !raw.trim())) throw new AgentError('"symbol": a symbol ("AAPL" or "NASDAQ:AAPL").');
  const s = (typeof raw === "string" ? raw : focused()).trim().toUpperCase();
  if (!hasFundamentals(s)) throw new AgentError(`${s} is not a company: economic series and imported series have no fundamentals or filings.`);
  return s;
}

/** A gateway error as the agent reads it: "no such section…" rather than the transport's wording. */
function failure(symbol: string, error: string, what: string): AgentError {
  if (/NOT_FOUND|404/.test(error)) {
    if (/no such filing/.test(error)) return new AgentError(`Not a filing of ${symbol}: take ids from list_filings of the same symbol.`);
    const why = /no section/.test(error) ? error.replace(/^[^:]*:\s*/, "").replace(/\s*\([^)]*\)\s*$/, "") : null;
    return new AgentError(why ? `${why}.` : `No ${what} for ${symbol}: funds, ETFs, indices and foreign companies filing 20-F / 40-F reports have none.`);
  }
  if (/RATE_LIMITED|429/.test(error)) return new AgentError(`Too many new filings read in a minute: try again in a minute.`);
  return new AgentError(`Could not read the ${what} of ${symbol}: ${error}`);
}

function int(v: unknown, name: string, min: number, max: number, dflt: number): number {
  if (v === undefined) return dflt;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new AgentError(`"${name}": an integer from ${min} to ${max}.`);
  return v;
}

function day(v: unknown, name: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !DAY_RE.test(v) || Number.isNaN(Date.parse(v))) throw new AgentError(`"${name}": a date YYYY-MM-DD.`);
  return v;
}

function strings(v: unknown, name: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.length || !v.every((x) => typeof x === "string" && x.trim())) throw new AgentError(`"${name}": a non-empty array of strings.`);
  return [...new Set(v.map((x: string) => x.trim()))];
}

/** Value of `key` at period `i` (`freeCashFlow`: operating cash flow less capital expenditure). */
function valueAt(p: FundamentalPeriods, key: string, i: number): number | null {
  const items = p.items ?? {};
  const v = (k: string) => items[k]?.[i] ?? null;
  if (key === "freeCashFlow") {
    const ops = v("cashFromOperations"), capex = v("capex");
    return ops === null || capex === null ? null : ops - capex;
  }
  if (key === "sharesOutstanding") return v("sharesOutstanding") ?? v("sharesOutstandingBalance");
  return v(key);
}

/** The answer of get_fundamentals: the selection of `f` (pure: the tests call it). */
export function selectFundamentals(f: Fundamentals, opts: { statement: Statement; period: "quarterly" | "annual"; items?: string[]; limit: number; today?: string }) {
  const p = (opts.period === "annual" ? f.annual : f.quarterly) ?? {};
  const end = p.end ?? [];
  if (!end.length) {
    const other = opts.period === "annual" ? "quarterly" : "annual";
    throw new AgentError(
      (other === "annual" ? f.annual : f.quarterly)?.end?.length
        ? `No ${opts.period} figures for ${f.ticker}: ask period: ${other}.`
        : `No financial statements for ${f.ticker}: foreign companies filing 20-F / 40-F reports have none.`,
    );
  }
  const known = new Set([...Object.keys(p.items ?? {}), "freeCashFlow", "sharesOutstanding"]);
  if (opts.items) {
    const unknown = opts.items.filter((k) => !known.has(k));
    if (unknown.length) {
      throw new AgentError(`Unknown item${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}. Items of ${f.ticker}: ${[...known].sort().join(", ")}.`);
    }
  }
  const keys = opts.items ?? [...STATEMENT_ITEMS[opts.statement]];
  // Newest first.
  const idx = end.map((_, i) => i).reverse().slice(0, opts.limit);
  const periods = idx.map((i) => {
    const items: Record<string, number> = {};
    for (const k of keys) {
      const v = valueAt(p, k, i);
      if (v !== null) items[k] = v;
    }
    return { end: end[i], ...(p.fp?.[i] ? { fp: p.fp[i] } : {}), ...(p.fy?.[i] != null ? { fy: p.fy[i] } : {}), ...(p.date?.[i] ? { released: p.date[i] } : {}), items };
  });
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const last = [...(f.earnings ?? [])].reverse().find((e) => e.released && e.date <= today);
  const next = f.nextEarnings;
  const fye = f.fiscalYearEnd && /^\d{4}$/.test(f.fiscalYearEnd) ? `${f.fiscalYearEnd.slice(0, 2)}-${f.fiscalYearEnd.slice(2)}` : null;
  return {
    symbol: f.ticker,
    ...(f.name ? { name: f.name } : {}),
    currency: f.currency ?? "USD",
    ...(fye ? { fiscalYearEnd: fye } : {}),
    ...(opts.statement === "summary" && !opts.items && (f.profile?.industry || f.profile?.sector)
      ? { industry: f.profile?.industry ?? null, sector: f.profile?.sector ?? null }
      : {}),
    period: opts.period,
    ...(opts.items ? {} : { statement: opts.statement }),
    // The first period served: some companies have a short history.
    coverage: end[0] ?? null,
    periods,
    latestEarnings: last ? { date: last.date, time: last.time ?? null, fy: last.fy ?? null, fp: last.fp ?? null, eps: last.eps ?? null, revenue: last.revenue ?? null } : null,
    nextEarnings: next ? { date: next.date, time: next.time ?? null, fy: next.fy ?? null, fp: next.fp ?? null, estimated: true } : null,
  };
}

/** A filing row as answered: empty fields left out. */
function filingRow(r: FilingList["filings"][number]) {
  return {
    id: r.accn,
    form: r.form,
    // "FORM 8-K" says the form again.
    ...(r.title && r.title.replace(/^form\s+/i, "").toUpperCase() !== r.form.toUpperCase() ? { title: r.title } : {}),
    date: r.date ?? null,
    ...(r.time ? { time: r.time } : {}),
    ...(r.report ? { period: r.report } : {}),
    ...(r.items?.length ? { items: r.items } : {}),
    ...(r.events?.length ? { events: r.events } : {}),
    ...(r.amended ? { amended: true } : {}),
    url: r.url,
  };
}

function textAnswer(t: FilingText) {
  if (t.sections) {
    return { id: t.accn, symbol: t.ticker, form: t.form ?? null, date: t.date ?? null, ...(t.time ? { time: t.time } : {}), sections: t.sections.map((s) => ({ id: s.id, title: s.title ?? null, chars: s.chars })) };
  }
  return { id: t.accn, section: t.section ?? null, title: t.title ?? null, offset: t.offset ?? 0, text: t.text ?? "", next: t.next ?? null };
}

export function createFilingsTools(focusedSymbol: () => string): AgentTool[] {
  const readOnly = { readOnlyHint: true, openWorldHint: true };
  return [
    {
      name: "get_fundamentals",
      title: "Get company fundamentals",
      description:
        "A company's financial statements per fiscal quarter or year (reported figures, in its currency), its latest earnings release (date, bmo / amc, EPS, revenue) and the projected next one (estimated: true, not an announced date). " +
        "statement: summary (default), income, balance or cash_flow, about ten items each; or items: item keys (revenue, netIncome, totalAssets, freeCashFlow…). " +
        "period: quarterly (default) or annual; limit: periods, newest first (default 4, at most 12). coverage is the first period served. Funds, ETFs and foreign 20-F filers have none.",
      inputSchema: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Default: the focused chart's symbol" },
          statement: { type: "string", enum: STATEMENTS },
          period: { type: "string", enum: ["quarterly", "annual"] },
          items: { type: "array", items: { type: "string" }, description: "Item keys, instead of a statement" },
          limit: { type: "integer", minimum: 1, maximum: 12 },
        },
      },
      annotations: readOnly,
      run: async (a) => {
        const symbol = companySymbol(a.symbol, focusedSymbol);
        const statement = (a.statement ?? "summary") as Statement;
        if (!STATEMENTS.includes(statement)) throw new AgentError(`"statement": one of ${STATEMENTS.join(", ")}.`);
        const period = a.period ?? "quarterly";
        if (period !== "quarterly" && period !== "annual") throw new AgentError('"period": quarterly or annual.');
        const items = strings(a.items, "items");
        if (items && items.length > MAX_ITEMS) throw new AgentError(`"items": at most ${MAX_ITEMS}.`);
        const limit = int(a.limit, "limit", 1, 12, 4);
        const r = await commands.getFundamentals(symbol);
        if (r.status === "error") throw failure(symbol, r.error, "fundamentals");
        return selectFundamentals(r.data, { statement, period, items, limit });
      },
    },
    {
      name: "list_filings",
      title: "List company filings",
      description:
        "A company's regulatory filings, newest first: id (for read_filing), form, date it became public (time: bmo / amc), period, 8-K items, event types, link. " +
        'forms: ["10-K", "10-Q", "8-K"…] (a form takes its amendments; insiders\' reports only when asked); events: event types (executive_change, restatement, activist_stake…); since / until: YYYY-MM-DD; ' +
        "limit: default 10, at most 25. more: true when older ones remain: ask again with before: next.",
      inputSchema: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Default: the focused chart's symbol" },
          forms: { type: "array", items: { type: "string" } },
          events: { type: "array", items: { type: "string", enum: EVENT_TYPES } },
          since: { type: "string", description: "YYYY-MM-DD" },
          until: { type: "string", description: "YYYY-MM-DD" },
          limit: { type: "integer", minimum: 1, maximum: 25 },
          before: { type: "string", description: "The next cursor of the previous answer" },
        },
      },
      annotations: readOnly,
      run: async (a) => {
        const symbol = companySymbol(a.symbol, focusedSymbol);
        const forms = strings(a.forms, "forms")?.map((f) => f.toUpperCase());
        const events = strings(a.events, "events")?.map((e) => e.toLowerCase());
        const unknown = events?.find((e) => !EVENT_TYPES.includes(e));
        if (unknown) throw new AgentError(`Unknown event type ${unknown}. Types: ${EVENT_TYPES.join(", ")}.`);
        const since = day(a.since, "since"), until = day(a.until, "until");
        if (since && until && since > until) throw new AgentError('"since" is after "until".');
        if (a.before !== undefined && (typeof a.before !== "string" || !a.before.trim())) throw new AgentError('"before": the next cursor of the previous answer.');
        const query: FilingQuery = { forms, events, since, until, limit: int(a.limit, "limit", 1, 25, 10), before: a.before as string | undefined };
        const r = await commands.getFilings(symbol, query);
        if (r.status === "error") throw failure(symbol, r.error, "filings");
        return {
          symbol: r.data.ticker,
          ...(r.data.name ? { name: r.data.name } : {}),
          filings: r.data.filings.map(filingRow),
          ...(r.data.more ? { more: true, next: r.data.next } : {}),
        };
      },
    },
    {
      name: "read_filing",
      title: "Read a filing",
      description:
        "The text of a filing from list_filings (id). Without section: its contents (items such as 1A risk factors, 7 MD&A; 10-Q items with their part, II-1A; 8-K items 2.02…; exhibits ex99.1). " +
        "With section: up to 6000 characters from offset (default 0) and next, the offset of the following page (null at the end). " +
        "For figures use get_fundamentals. symbol: the filing's company (default: the focused chart's).",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Accession id from list_filings" },
          symbol: { type: "string" },
          section: { type: "string" },
          offset: { type: "integer", minimum: 0 },
        },
        required: ["id"],
      },
      annotations: readOnly,
      run: async (a) => {
        if (typeof a.id !== "string" || !ID_RE.test(a.id.trim())) throw new AgentError('"id": a filing id from list_filings ("0000320193-25-000079").');
        const symbol = companySymbol(a.symbol, focusedSymbol);
        if (a.section !== undefined && (typeof a.section !== "string" || !SECTION_RE.test(a.section.trim()))) {
          throw new AgentError('"section": a section id from the filing\'s contents ("1A", "7", "II-1A", "2.02", "ex99.1").');
        }
        const section = typeof a.section === "string" ? a.section.trim() : null;
        if (section === null && a.offset !== undefined) throw new AgentError('"offset" needs a "section".');
        const offset = int(a.offset, "offset", 0, 100_000_000, 0);
        const r = await commands.readFiling(symbol, a.id.trim(), section, section === null ? null : offset);
        if (r.status === "error") throw failure(symbol, r.error, "filing");
        return textAnswer(r.data);
      },
    },
  ];
}
