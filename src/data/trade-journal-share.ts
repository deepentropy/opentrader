import { translatePlural, translateWith } from "../i18n/translator";
/*
 * Trade journal to Community (#248): what a shared trade, or a shared list of
 * trades, carries into the new post. Figures only: the member writes the text.
 * Moves are in percent; quantity, P&L and fees appear only with "Include
 * amounts". The journal's notes never travel. The post is labelled "From
 * journal, self-reported" (imported trades can be edited before import).
 */
import { tickerCommunityId, GENERAL } from "./community/api";
import type { ShareSeed } from "./community/share";
import type { JournalTrade } from "./trade-journal";
import { durationText, tradeDateText } from "./trade-journal-calc";

/** A shared list keeps this many rows; its summary counts every trade. */
export const MAX_SHARED_ROWS = 50;

const MINUS = "−";
const num = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const qtyFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });
const price = (v: number | undefined) => (v === undefined ? "—" : Math.abs(v) < 1 ? v.toFixed(4) : num.format(v));
const signedPct = (v: number) => `${v > 0 ? "+" : v < 0 ? MINUS : ""}${(Math.abs(v) * 100).toFixed(2)}%`;
const plainPct = (v: number) => `${(Math.abs(v) * 100).toFixed(2)}%`;
const money = (v: number) => `${v > 0 ? "+" : v < 0 ? MINUS : ""}${num.format(Math.abs(v))}`;
const tradesText = (n: number) => translatePlural(n, { one: "{0} trade", other: "{0} trades" });
const sideText = (t: JournalTrade) => (t.side === "long" ? "Long" : "Short");

/** Dates are read in the chart's zone, a date-only trade in its exchange's (as in the journal). */
const zoneOf = (t: JournalTrade, timeZone: string) => (t.dateOnly ? t.zone : timeZone);

type TableOpts = { timeZone: string; amounts: boolean; symbol: boolean };

/** The trades as a Markdown table, one row each. */
export function tradeTable(trades: JournalTrade[], o: TableOpts): string {
  const head = [
    ...(o.symbol ? ["Symbol"] : []),
    "Side", "Entry", "Entry price", "Exit", "Exit price", "Move", "Run-up", "Drawdown", "Duration",
    ...(o.amounts ? ["Qty", "P&L", "Fees"] : []),
  ];
  const rows = trades.map((t) => {
    const c = t.calc;
    const zone = zoneOf(t, o.timeZone);
    return [
      ...(o.symbol ? [t.symbol] : []),
      sideText(t),
      tradeDateText(t.entryTime, zone, t.dateOnly),
      price(c?.entryPrice ?? t.entryPrice),
      tradeDateText(t.exitTime, zone, t.dateOnly),
      price(c?.exitPrice ?? t.exitPrice),
      c ? signedPct(c.pnlPct) : "—",
      c ? plainPct(c.runUpPct) : "—",
      c ? plainPct(c.drawdownPct) : "—",
      durationText(t),
      ...(o.amounts ? [t.qty === undefined ? "—" : qtyFmt.format(t.qty), c ? money(c.pnl) : "—", t.fees === undefined ? "—" : num.format(t.fees)] : []),
    ];
  });
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [line(head), line(head.map(() => "---")), ...rows.map(line)].join("\n");
}

/** The list's figures in a line: trades, % winners, profit factor and average move (in percent, each trade weighing
 *  the same), and the net P&L with the amounts. Trades whose values could not be read are counted apart. */
export function tradeSummary(trades: JournalTrade[], amounts: boolean): string {
  const done = trades.filter((t) => t.calc);
  const missing = trades.length - done.length;
  const parts = [`**${tradesText(trades.length)}**${missing ? ` (${missing} without values)` : ""}`];
  if (done.length > 0) {
    const moves = done.map((t) => t.calc!.pnlPct);
    const gains = moves.filter((m) => m > 0).reduce((s, m) => s + m, 0);
    const losses = -moves.filter((m) => m < 0).reduce((s, m) => s + m, 0);
    // Winners as in the journal: net of fees.
    const wins = done.filter((t) => t.calc!.pnl > 0).length;
    parts.push(`${((wins / done.length) * 100).toFixed(1)}% winners`);
    parts.push(`profit factor ${losses > 0 ? (gains / losses).toFixed(2) : "—"}`);
    parts.push(`average ${signedPct(moves.reduce((s, m) => s + m, 0) / moves.length)}`);
    if (amounts) parts.push(`net P&L ${money(done.reduce((s, t) => s + t.calc!.pnl, 0))}`);
  }
  return parts.join(" · ");
}

function listBody(trades: JournalTrade[], timeZone: string, amounts: boolean): string {
  const shown = trades.slice(0, MAX_SHARED_ROWS);
  return [
    tradeSummary(trades, amounts),
    "",
    tradeTable(shown, { timeZone, amounts, symbol: true }),
    ...(trades.length > shown.length ? ["", `*First ${shown.length} of ${trades.length} trades.*`] : []),
  ].join("\n");
}

/** One trade: a post-mortem in its ticker's community, with the chart (framed on the trade by the caller). */
export function shareTradeSeed(t: JournalTrade, timeZone: string): Omit<ShareSeed, "at"> {
  const zone = zoneOf(t, timeZone);
  const from = tradeDateText(t.entryTime, zone, true);
  const to = tradeDateText(t.exitTime, zone, true);
  return {
    type: "postmortem",
    to: tickerCommunityId(t.symbol) ?? GENERAL,
    attach: !!t.fullSymbol,
    title: `${t.symbol} ${t.side}, ${from === to ? from : `${from} to ${to}`}`,
    journal: {
      table: tradeTable([t], { timeZone, amounts: false, symbol: false }),
      withAmounts: tradeTable([t], { timeZone, amounts: true, symbol: false }),
    },
  };
}

/** A list of trades (a selection, a group of the journal): an analysis in General. `label`: the group's ("March 2026"). */
export function shareListSeed(trades: JournalTrade[], timeZone: string, label?: string): Omit<ShareSeed, "at"> {
  return {
    type: "analysis",
    to: GENERAL,
    title: label ? translateWith("Journal, {0}: {1}", label, tradesText(trades.length)) : translateWith("Journal: {0}", tradesText(trades.length)),
    journal: { table: listBody(trades, timeZone, false), withAmounts: listBody(trades, timeZone, true) },
  };
}
