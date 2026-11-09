import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ list: [] as unknown[][], read: [] as unknown[][], fundamentals: [] as string[] }));
const answers = vi.hoisted(() => ({ fundamentals: null as unknown, list: null as unknown, read: null as unknown }));
vi.mock("../../bindings", () => ({
  commands: {
    getFundamentals: (s: string) => (calls.fundamentals.push(s), Promise.resolve(answers.fundamentals)),
    getFilings: (...a: unknown[]) => (calls.list.push(a), Promise.resolve(answers.list)),
    readFiling: (...a: unknown[]) => (calls.read.push(a), Promise.resolve(answers.read)),
  },
}));
vi.mock("../../data/fundamentals", () => ({ hasFundamentals: (s: string) => !/^(ECONOMICS|LOCAL):/i.test(s) }));

import { createFilingsTools, selectFundamentals, STATEMENT_ITEMS } from "../filings-tools";
import { AgentError } from "../mcp";

const tools = createFilingsTools(() => "NASDAQ:AAPL");
const run = (name: string, args: Record<string, unknown> = {}) => tools.find((t) => t.name === name)!.run(args);

// Six quarters, ascending, with one item of every statement and the parts of free cash flow.
const N = 6;
const series = (base: number) => Array.from({ length: N }, (_, i) => base + i);
const FUNDAMENTALS = {
  ticker: "AAPL",
  name: "Apple Inc.",
  currency: "USD",
  fiscalYearEnd: "0927",
  quarterly: {
    end: ["2024-03-30", "2024-06-29", "2024-09-28", "2024-12-28", "2025-03-29", "2025-06-28"],
    fy: [2024, 2024, 2024, 2025, 2025, 2025],
    fp: ["Q2", "Q3", "Q4", "Q1", "Q2", "Q3"],
    date: ["2024-05-02", "2024-08-01", "2024-10-31", "2025-01-30", "2025-05-01", "2025-07-31"],
    items: {
      revenue: series(100), netIncome: series(20), cogs: series(50), totalAssets: series(1000), cash: series(30),
      cashFromOperations: series(40), capex: series(5), sharesOutstandingBalance: series(15), rnd: Array(N).fill(null),
    },
  },
  annual: { end: ["2024-09-28"], fy: [2024], fp: ["FY"], date: ["2024-11-01"], items: { revenue: [391] } },
  earnings: [
    { date: "2025-05-01", time: "amc", released: true, end: "2025-03-29", fy: 2025, fp: "Q2", eps: 1.65, revenue: 104 },
    { date: "2025-07-31", time: "amc", released: true, end: "2025-06-28", fy: 2025, fp: "Q3", eps: 1.57, revenue: 105 },
  ],
  profile: { industry: "Electronic Computers", sector: "Technology", listings: [], formerNames: [] },
  events: [],
  nextEarnings: { date: "2025-10-30", time: null, fy: 2025, fp: "Q4", estimated: true },
};

beforeEach(() => {
  calls.list.length = calls.read.length = calls.fundamentals.length = 0;
  answers.fundamentals = { status: "ok", data: FUNDAMENTALS };
});

describe("get_fundamentals", () => {
  it("answers the focused chart's company, newest period first, four by default", async () => {
    const r = (await run("get_fundamentals")) as ReturnType<typeof selectFundamentals>;
    expect(calls.fundamentals).toEqual(["NASDAQ:AAPL"]);
    expect(r.periods.map((p) => p.end)).toEqual(["2025-06-28", "2025-03-29", "2024-12-28", "2024-09-28"]);
    expect(r.periods[0]).toMatchObject({ fp: "Q3", fy: 2025, released: "2025-07-31" });
    expect(r).toMatchObject({ name: "Apple Inc.", currency: "USD", fiscalYearEnd: "09-27", coverage: "2024-03-30", statement: "summary", industry: "Electronic Computers" });
    expect(r.latestEarnings).toMatchObject({ date: "2025-07-31", time: "amc", eps: 1.57 });
    expect(r.nextEarnings).toMatchObject({ date: "2025-10-30", estimated: true });
  });

  it("selects the items of each statement only, and leaves out the ones not reported", () => {
    for (const statement of ["summary", "income", "balance", "cash_flow"] as const) {
      const r = selectFundamentals(FUNDAMENTALS as never, { statement, period: "quarterly", limit: 2 });
      for (const p of r.periods) for (const k of Object.keys(p.items)) expect(STATEMENT_ITEMS[statement]).toContain(k);
      expect(STATEMENT_ITEMS[statement].length).toBeLessThanOrEqual(12);
    }
    const income = selectFundamentals(FUNDAMENTALS as never, { statement: "income", period: "quarterly", limit: 1 });
    expect(income.periods[0].items).toEqual({ revenue: 105, cogs: 55, netIncome: 25 });
    // Free cash flow derived; shares outstanding from the balance sheet figure.
    const cf = selectFundamentals(FUNDAMENTALS as never, { statement: "cash_flow", period: "quarterly", limit: 1 });
    expect(cf.periods[0].items).toMatchObject({ cashFromOperations: 45, capex: 10, freeCashFlow: 35 });
    const bal = selectFundamentals(FUNDAMENTALS as never, { statement: "balance", period: "quarterly", limit: 1 });
    expect(bal.periods[0].items).toMatchObject({ cash: 35, totalAssets: 1005, sharesOutstanding: 20 });
  });

  it("takes items instead of a statement, annual periods and a limit", async () => {
    const r = (await run("get_fundamentals", { symbol: "aapl", items: ["revenue"], period: "annual", limit: 12 })) as ReturnType<typeof selectFundamentals>;
    expect(calls.fundamentals).toEqual(["AAPL"]);
    expect(r.periods).toEqual([{ end: "2024-09-28", fp: "FY", fy: 2024, released: "2024-11-01", items: { revenue: 391 } }]);
    expect(r).not.toHaveProperty("statement");
  });

  it("checks its arguments", async () => {
    await expect(run("get_fundamentals", { statement: "ratios" })).rejects.toThrow(/statement/);
    await expect(run("get_fundamentals", { period: "monthly" })).rejects.toThrow(/period/);
    await expect(run("get_fundamentals", { limit: 13 })).rejects.toThrow(/limit/);
    await expect(run("get_fundamentals", { items: [] })).rejects.toThrow(/items/);
    await expect(run("get_fundamentals", { items: ["ebitdaMargin"] })).rejects.toThrow(/Unknown item ebitdaMargin\. Items of AAPL: .*revenue/);
    await expect(run("get_fundamentals", { symbol: "ECONOMICS:GDP" })).rejects.toThrow(/not a company/);
    expect(calls.fundamentals).toEqual(["NASDAQ:AAPL"]);
  });

  it("says when a company has no statements of the period asked", async () => {
    answers.fundamentals = { status: "ok", data: { ...FUNDAMENTALS, ticker: "TSM", quarterly: {}, annual: {} } };
    await expect(run("get_fundamentals", { symbol: "TSM" })).rejects.toThrow(/No financial statements for TSM: foreign companies filing 20-F/);
    answers.fundamentals = { status: "ok", data: { ...FUNDAMENTALS, quarterly: {} } };
    await expect(run("get_fundamentals")).rejects.toThrow(/No quarterly figures for AAPL: ask period: annual/);
  });

  it("says when a symbol has no fundamentals, apart from a failed read", async () => {
    answers.fundamentals = { status: "error", error: "fundamentals: no fundamentals for this ticker (NOT_FOUND)" };
    await expect(run("get_fundamentals", { symbol: "SPY" })).rejects.toThrow(/No fundamentals for SPY: funds, ETFs/);
    answers.fundamentals = { status: "error", error: "fundamentals: request failed (NETWORK)" };
    await expect(run("get_fundamentals", { symbol: "SPY" })).rejects.toThrow(AgentError);
    await expect(run("get_fundamentals", { symbol: "SPY" })).rejects.toThrow(/Could not read the fundamentals of SPY/);
  });
});

describe("list_filings", () => {
  const row = { accn: "0000320193-25-000071", form: "8-K", title: null, date: "2025-07-31", time: "amc", report: "2025-07-31", items: ["2.02", "9.01"], events: [], amended: false, url: "https://example.test/index.htm" };

  it("passes the query and answers compact rows with the cursor", async () => {
    answers.list = { status: "ok", data: { ticker: "AAPL", name: "Apple Inc.", filings: [row, { ...row, accn: "0000320193-25-000072", title: "FORM 8-K" }, { ...row, accn: "0000320193-25-000073", title: "Press release" }], more: true, next: "abc" } };
    const r = await run("list_filings", { forms: ["8-k"], events: ["Executive_Change"], since: "2025-01-01" });
    expect(calls.list).toEqual([["NASDAQ:AAPL", { forms: ["8-K"], events: ["executive_change"], since: "2025-01-01", until: undefined, limit: 10, before: undefined }]]);
    expect(r).toEqual({
      symbol: "AAPL",
      name: "Apple Inc.",
      filings: [
        { id: row.accn, form: "8-K", date: "2025-07-31", time: "amc", period: "2025-07-31", items: ["2.02", "9.01"], url: row.url },
        { id: "0000320193-25-000072", form: "8-K", date: "2025-07-31", time: "amc", period: "2025-07-31", items: ["2.02", "9.01"], url: row.url },
        { id: "0000320193-25-000073", form: "8-K", title: "Press release", date: "2025-07-31", time: "amc", period: "2025-07-31", items: ["2.02", "9.01"], url: row.url },
      ],
      more: true,
      next: "abc",
    });
  });

  it("checks its arguments", async () => {
    await expect(run("list_filings", { events: ["ceo_change"] })).rejects.toThrow(/Unknown event type ceo_change\. Types: activist_stake/);
    await expect(run("list_filings", { since: "2025-13-01" })).rejects.toThrow(/since/);
    await expect(run("list_filings", { since: "2025-02-01", until: "2025-01-01" })).rejects.toThrow(/after/);
    await expect(run("list_filings", { limit: 26 })).rejects.toThrow(/limit/);
    await expect(run("list_filings", { forms: "10-K" })).rejects.toThrow(/forms/);
    expect(calls.list).toEqual([]);
  });
});

describe("read_filing", () => {
  const id = "0000320193-25-000079";

  it("answers the contents without a section", async () => {
    answers.read = { status: "ok", data: { ticker: "AAPL", accn: id, form: "10-K", date: "2025-10-31", time: "bmo", sections: [{ id: "1A", title: "Risk Factors", chars: 61234 }] } };
    expect(await run("read_filing", { id })).toEqual({ id, symbol: "AAPL", form: "10-K", date: "2025-10-31", time: "bmo", sections: [{ id: "1A", title: "Risk Factors", chars: 61234 }] });
    expect(calls.read).toEqual([["NASDAQ:AAPL", id, null, null]]);
  });

  it("pages a section with offset and next", async () => {
    answers.read = { status: "ok", data: { ticker: "AAPL", accn: id, section: "1A", title: "Risk Factors", text: "Second page", offset: 5987, next: null } };
    expect(await run("read_filing", { id, section: "1A", offset: 5987 })).toEqual({ id, section: "1A", title: "Risk Factors", offset: 5987, text: "Second page", next: null });
    expect(calls.read).toEqual([["NASDAQ:AAPL", id, "1A", 5987]]);
  });

  it("checks its arguments and names the sections of an unknown one", async () => {
    await expect(run("read_filing", {})).rejects.toThrow(/id/);
    await expect(run("read_filing", { id: "AAPL-10K" })).rejects.toThrow(/id/);
    await expect(run("read_filing", { id, section: "../x" })).rejects.toThrow(/section/);
    await expect(run("read_filing", { id, offset: 10 })).rejects.toThrow(/needs a "section"/);
    expect(calls.read).toEqual([]);
    answers.read = { status: "error", error: "filing: no section 9; sections: 1, 1A, 7 (NOT_FOUND)" };
    await expect(run("read_filing", { id, section: "9" })).rejects.toThrow(/^no section 9; sections: 1, 1A, 7\.$/);
    answers.read = { status: "error", error: "filing: no such filing for this ticker (NOT_FOUND)" };
    await expect(run("read_filing", { id, symbol: "MSFT" })).rejects.toThrow(/^Not a filing of MSFT: take ids from list_filings/);
  });
});
