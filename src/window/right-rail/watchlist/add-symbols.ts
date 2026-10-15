/*
 * Watchlist "Add symbol": the search dialog's add / add many / remove / go to
 * symbol at the current anchor, and the short highlight of the added or found
 * rows.
 */
import { createSignal, onCleanup } from "solid-js";
import { type Row } from "../../../data/watchlist";
import { watchlistStore } from "../../../data/watchlist-store";
import { resolveSymbol } from "../../../data/datafeed";
import { type WatchlistCx } from "./context";
import type { Accessor } from "solid-js";

/** What createAddSymbols adds to the watchlist context. */
export interface AddSymbolsApi {
  addMany: (names: string[]) => void;
  addSymbol: (name: string) => void;
  goToSymbol: (name: string) => void;
  highlightRows: (ids: string[]) => void;
  highlighted: Accessor<Set<string>>;
  isHighlighted: (r: Row) => boolean;
  removeSymbolFromDialog: (name: string) => void;
}

export function createAddSymbols(cx: WatchlistCx): AddSymbolsApi {
  const { addAnchor, groups, isCollapsed, scrollToItem, setAddAnchor, setCollapse } = cx;
  // ── Added / found rows: highlighted for 500 ms, and the last one scrolls
  // into view.
  const [highlighted, setHighlighted] = createSignal<Set<string>>(new Set());
  let highlightTimer: number | undefined;
  onCleanup(() => window.clearTimeout(highlightTimer));
  const highlightRows = (ids: string[]) => {
    setHighlighted(new Set(ids));
    window.clearTimeout(highlightTimer);
    highlightTimer = window.setTimeout(() => setHighlighted(new Set<string>()), 500);
    const last = ids[ids.length - 1];
    if (last) scrollToItem(last);
  };
  const isHighlighted = (r: Row) => highlighted().has(r.ticker);

  // Add a symbol from the search dialog at the current anchor (deduped). The
  // chart symbol and the dialog stay as they are.
  const addSymbol = (name: string) => {
    const short = name.split(":").pop() || name;
    const added = watchlistStore.addSymbols(
      [{ ticker: name, short, last: "—", changePercent: "0.00%", prePostChange: "0.00%", flag: null }],
      addAnchor(),
    );
    if (added.length) highlightRows(added);
  };
  // Comma mode: resolve each bare name to "EXCHANGE:TICKER" (a name that
  // does not resolve is kept as typed), then insert them all, in order, at
  // the anchor.
  const addMany = (names: string[]) => {
    const anchor = addAnchor();
    void Promise.all(
      names.map((n) => (n.includes(":") ? Promise.resolve(n) : resolveSymbol(n).then((i) => i.fullName).catch(() => n))),
    ).then((full) => {
      const added = watchlistStore.addSymbols(
        full.map((name) => ({
          ticker: name, short: name.split(":").pop() || name, last: "—", changePercent: "0.00%", prePostChange: "0.00%", flag: null,
        })),
        anchor,
      );
      if (added.length) highlightRows(added);
    });
  };
  // Remove from the dialog. Removing the anchor row sends later adds to the
  // end of the list.
  const removeSymbolFromDialog = (name: string) => {
    watchlistStore.removeSymbol(name);
    const a = addAnchor();
    if (a && a.after === name) setAddAnchor(null);
  };
  // "Go to symbol": open its section if collapsed,
  // then highlight and scroll to it.
  const goToSymbol = (name: string) => {
    const g = groups().find((g) => g.rows.some((r) => r.ticker === name));
    if (g && isCollapsed(g.name)) setCollapse([g.name], false);
    highlightRows([name]);
  };

  return { addMany, addSymbol, goToSymbol, highlightRows, highlighted, isHighlighted, removeSymbolFromDialog };
}
