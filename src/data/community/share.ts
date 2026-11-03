/*
 * "Share to Community" from anywhere in the app: the chart's menu, the
 * snapshot menu, the Strategy Tester report, the script editor. A request
 * opens the Community panel on a new post, already holding the chart and,
 * for a report or a script, the user's own figures or code. "Send snapshot
 * to Community" only sends the chart's picture to the account, to attach to
 * a post written on the website.
 */
import { createSignal } from "solid-js";

export type ShareSeed = {
  at: number;
  title?: string;
  body?: string;
  /** Attach the active chart (picture, symbol, interval, drawings). */
  attach?: boolean;
  /** The community to post in (default: the chart's ticker). */
  to?: string;
  /** Only send the chart's snapshot to the account (no post). */
  snapshotOnly?: boolean;
};

const [shareRequest, setShareRequest] = createSignal<ShareSeed | null>(null);
export { shareRequest };

export function requestShare(seed: Omit<ShareSeed, "at">): void {
  setShareRequest({ ...seed, at: Date.now() });
}

/** The waiting request, once (the composer takes it). */
export function takeShare(): ShareSeed | null {
  const s = shareRequest();
  setShareRequest(null);
  return s;
}

const money = (v: number, currency: string) =>
  `${v >= 0 ? "+" : "−"}${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 2 })} ${currency}`;
const pct = (v: number | null | undefined, digits = 1) => (v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(digits)}%`);

/** A backtest's headline figures as a table, for the post's text (the user's own numbers; they edit it). */
export function backtestTable(r: {
  strategy: string;
  symbol: string;
  interval: string;
  currency: string;
  netProfit: number;
  netProfitPercent: number;
  totalTrades: number;
  percentProfitable: number | null;
  profitFactor: number | null;
  maxDrawdownPercent: number;
}): string {
  return [
    `Backtest of ${r.strategy} on ${r.symbol}, ${r.interval}.`,
    "",
    "| Net profit | Trades | Profitable | Profit factor | Max drawdown |",
    "|---|---|---|---|---|",
    `| ${money(r.netProfit, r.currency)} (${pct(r.netProfitPercent)}) | ${r.totalTrades} | ${pct(r.percentProfitable, 0)} | ${r.profitFactor == null ? "—" : r.profitFactor.toFixed(2)} | ${pct(r.maxDrawdownPercent)} |`,
    "",
  ].join("\n");
}
