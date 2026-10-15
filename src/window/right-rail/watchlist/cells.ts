/*
 * Watchlist cell values: the live quote overlay on the stored rows (last,
 * change, change %, volume, Ext), the company names, the row label and the
 * market-status dot.
 */
import { createEffect, createSignal, onCleanup, untrack } from "solid-js";
import { type Row, type WlColumnKey } from "../../../data/watchlist";
import { quoteFor as liveQuoteFor, type LiveQuote } from "../../../data/quotes";
import { getTickerInfo } from "../../../data/datafeed";
import { fmtChange, fmtPercent, fmtVolume, formatLast, isNegative, marketState } from "./format";
import { type WatchlistCx } from "./context";

/** What createCells adds to the watchlist context. */
export interface CellsApi {
  cellFor: (r: Row, key: WlColumnKey) => { text: string; tint?: "up" | "down" };
  dotClass: (r: Row) => string;
  lastForRow: (row: { ticker: string; last: string }) => string;
  nameFor: (r: Row) => string;
  primaryLabel: (r: Row) => string;
  quoteFor: (symbol: string) => LiveQuote | undefined;
}

export function createCells(cx: WatchlistCx): CellsApi {
  const { allRows, settings } = cx;
  // ── Feature 9: live quote overlay (last + Chg/Chg%/Vol) on the static rows. ──
  // Quotes live in the process-singleton store (data/quotes.ts), which owns the
  // subscription and the trade-tick feed for the app's lifetime. The panel just
  // reads them, so closing/reopening keeps prices and never refetches.
  const quoteFor = (symbol: string): LiveQuote | undefined => liveQuoteFor(symbol);

  // (List-alert evaluation runs in the module-level singleton of
  // list-alerts.ts — it must keep firing while this panel is unmounted.)

  function lastForRow(row: { ticker: string; last: string }): string {
    const q = quoteFor(row.ticker);
    if (q?.last != null) return formatLast(q.last);
    return row.last;
  }

  // ── Company names (the "Name" symbol-display + tile sub-line) ──
  // Resolved lazily from the ticker details (get_ticker_info) and cached; falls
  // back to the ticker while loading or when the provider has no name. Fetched
  // only when needed: tile view, or table view with the "Name" radio selected.
  const [names, setNames] = createSignal<Record<string, string>>({});
  const needNames = () => !settings().tableView || settings().symbolDisplay === "description";
  const nameFor = (r: Row) => names()[r.ticker] || "";
  createEffect(() => {
    if (!needNames()) return; // tracks settings + the active list's rows
    const rows = allRows();
    const cached = untrack(names);
    const pending = rows.filter((r) => cached[r.ticker] === undefined);
    if (pending.length === 0) return;
    let cancelled = false;
    Promise.all(
      pending.map((r) =>
        getTickerInfo(r.ticker)
          .then((info) => ({ symbol: r.ticker, name: info?.name ?? "" }))
          .catch(() => ({ symbol: r.ticker, name: "" })),
      ),
    ).then((results) => {
      if (cancelled) return;
      setNames((prev) => {
        const next = { ...prev };
        for (const { symbol, name } of results) next[symbol] = name;
        return next;
      });
    });
    onCleanup(() => {
      cancelled = true;
    });
  });

  /** Primary row label — company name when the "Name" radio is on and a name
   *  has resolved, otherwise the ticker. */
  const primaryLabel = (r: Row) =>
    settings().symbolDisplay === "description" && nameFor(r) ? nameFor(r) : r.short;

  /** The "Ext" column — pre/post-market move. Has a value only during the
   *  extended-hours sessions; blank during the regular session and while the
   *  market is fully closed (overnight / weekend). Prefers the live ext move,
   *  falling back to the stored static value. */
  function extForRow(r: Row): { text: string; tint?: "up" | "down" } {
    const q = quoteFor(r.ticker);
    const text = marketState(r.ticker) !== "extended"
      ? ""
      : q?.extChangePercent != null
        ? fmtPercent(q.extChangePercent)
        : r.prePostChange;
    return { text, tint: text ? (isNegative(text) ? "down" : "up") : undefined };
  }

  /** Market-status dot beside the ticker: grey while the row's market is fully
   *  closed, amber on a row carrying an extended-hours quote, none during
   *  the regular session. Returns the modifier class, or "" for no dot. */
  function dotClass(r: Row): string {
    if (marketState(r.ticker) === "closed") return "watchlist-status-dot closed";
    return extForRow(r).text !== "" ? "watchlist-status-dot" : "";
  }

  /** Map a column key to its display value + tint for a row, preferring the live
   *  quote and falling back to the stored static value. */
  function cellFor(r: Row, key: WlColumnKey): { text: string; tint?: "up" | "down" } {
    const q = quoteFor(r.ticker);
    switch (key) {
      case "last": return { text: lastForRow(r) };
      case "change": {
        // No static fallback in the sectioned capture → "—" (untinted) until a
        // live snapshot lands.
        const text = q?.change != null ? fmtChange(q.change) : r.change ?? "—";
        return { text, tint: text === "—" ? undefined : isNegative(text) ? "down" : "up" };
      }
      case "change_percent": {
        // No live quote yet (e.g. at the open) → blank, not a misleading 0.00%.
        if (q?.changePercent == null) return { text: "" };
        const text = fmtPercent(q.changePercent);
        return { text, tint: isNegative(text) ? "down" : "up" };
      }
      case "volume": {
        return { text: q?.volume != null ? fmtVolume(q.volume) : r.volume ?? "—" };
      }
      case "rchp": return extForRow(r);
    }
  }

  return { cellFor, dotClass, lastForRow, nameFor, primaryLabel, quoteFor };
}
