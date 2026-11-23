/*
 * The broker's own tabs of the account manager (#384), as the reference app's custom pages: a plugin sends `pages` in
 * its state (holdings, funds…), each with one or more tables whose columns and rows it defines. They show after Trade
 * history, with the same tables as the app's own tabs (sort, column setup, CSV). A row with a symbol shows it on the
 * chart. Titles, labels and texts are the broker's: not translated.
 */
import { Index, Show } from "solid-js";
import type { AccountPage, AccountPageColumn, AccountPageTable, PageCell } from "../../bindings";
import { cachedSymbolSessions } from "../../data/session";
import { pluginBroker } from "../../data/trading/plugin-broker";
import { localNumber } from "../../i18n/format";
import { translate } from "../../i18n/translator";
import { AccountTable, tableCsv, type Column } from "./AccountTable";
import { setInitialSort } from "./account-table-model";
import { fmtMoney, fmtPct, fmtPnl, fmtPrice as fmtAnyPrice, fmtQty, fmtTime, pnlClass } from "./format";

export type PageRow = Partial<Record<string, PageCell>>;

/** A price of `ticker` on its symbol's tick (once the chart symbol's sessions are known). */
export const tickerPrice = (v: number | null | undefined, ticker?: string | null) => {
  const sym = ticker ? pluginBroker.chartSymbolFor(ticker) : null;
  return fmtAnyPrice(v, sym ? cachedSymbolSessions(sym)?.mintick : null);
};

const NUMERIC = new Set<AccountPageColumn["format"]>(["qty", "price", "money", "pnl", "percent", "pnlPercent", "number", "time"]);
const num = (v: PageCell | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const plainPct = (v: number | null) => (v == null ? "—" : localNumber(`${v.toFixed(2)}%`));
const sideOf = (v: PageCell | undefined) => {
  const s = typeof v === "string" ? v.toLowerCase() : "";
  return s === "buy" || s === "sell" ? s : null;
};
const sideText = (side: "buy" | "sell") => (side === "buy" ? translate("Buy") : translate("Sell"));

/** The table's symbol column: a row click shows its value on the chart, prices take its tick. */
const symbolColumn = (t: AccountPageTable) => t.columns.find((c) => c.format === "symbol")?.id ?? null;

/** The text a cell shows; a number column given a text shows the text. */
function shown(c: AccountPageColumn, v: PageCell | undefined, ticker: string | null): { text: string; cls?: string; data: boolean } {
  if (v == null || v === "") return { text: "", data: true };
  const side = c.format === "side" ? sideOf(v) : null;
  if (side) return { text: sideText(side), cls: side === "buy" ? "trd-buy" : "trd-sell", data: false };
  if (typeof v === "string") return { text: v, data: true };
  switch (c.format) {
    case "qty":
    case "number":
      return { text: fmtQty(v), data: false };
    case "price":
      return { text: tickerPrice(v, ticker), data: false };
    case "money":
      return { text: fmtMoney(v), data: false };
    case "pnl":
      return { text: fmtPnl(v), cls: pnlClass(v), data: false };
    case "percent":
      return { text: plainPct(v), data: false };
    case "pnlPercent":
      return { text: fmtPct(v), cls: pnlClass(v), data: false };
    case "time":
      return { text: fmtTime(v), data: false };
    default:
      return { text: localNumber(String(v)), data: true };
  }
}

/** The app's columns of a broker table: the first symbol column stays first and in view, as Symbol does. */
export function pageColumns(t: AccountPageTable): Column<PageRow>[] {
  const symbol = symbolColumn(t);
  const tickerOf = (r: PageRow) => (symbol && typeof r[symbol] === "string" ? (r[symbol] as string) : null);
  return t.columns.map((c) => ({
    id: c.id,
    title: () => c.label,
    brokerText: true,
    num: NUMERIC.has(c.format),
    hidden: c.hidden,
    fixed: c.id === symbol,
    cell: (r: PageRow) => {
      const s = () => shown(c, r[c.id], tickerOf(r));
      return (
        <Show when={c.format !== "symbol" || !s().text} fallback={<span class="trd-symbol-pill" data-no-translate>{s().text}</span>}>
          <span
            class={`${NUMERIC.has(c.format) ? "ot-value " : ""}${s().cls ?? ""}`}
            data-no-translate={s().data || undefined}
          >
            {s().text}
          </span>
        </Show>
      );
    },
    value: (r: PageRow) => {
      const v = r[c.id];
      const side = c.format === "side" ? sideOf(v) : null;
      if (side) return sideText(side);
      return num(v) ?? (v == null ? null : String(v));
    },
  }));
}

/** Where a table keeps its column order, shown columns and sort (per broker, page and table); the broker's sort
 *  applies until the user picks one. */
export function pageTableId(broker: string, page: AccountPage, t: AccountPageTable): string {
  const id = `plugin:${broker}:${page.id}:${t.id}`;
  setInitialSort(id, t.sort ? { id: t.sort.column, dir: t.sort.asc ? "asc" : "desc" } : null);
  return id;
}

/** The number a counter page shows on its tab: its rows. */
export const pageCount = (page: AccountPage) => (page.counter ? page.tables.reduce((n, t) => n + (t.rows?.length ?? 0), 0) : 0);

/** The CSV of a page: its table, or each table after its title and a blank line. */
export function brokerPageCsv(broker: string, page: AccountPage): string {
  return page.tables
    .map((t) => {
      const csv = tableCsv(pageTableId(broker, page, t), pageColumns(t), (t.rows ?? []) as PageRow[]);
      return page.tables.length > 1 && t.title ? `${t.title}\n${csv}` : csv;
    })
    .join("\n\n");
}

/** A broker page: its tables, each titled when it has several. Kept by place, so a new state from the plugin updates
 *  the tables in place (an open Column setup stays open). */
export function BrokerPageView(props: { broker: string; page: AccountPage; onRow: (ticker: string) => void }) {
  return (
    <Index each={props.page.tables}>
      {(t) => {
        const symbol = () => symbolColumn(t());
        return (
          <section class="trd-am-section">
            <Show when={props.page.tables.length > 1 && t().title}>
              <h3 class="trd-am-table-title" data-no-translate>
                {t().title}
              </h3>
            </Show>
            <AccountTable<PageRow>
              id={pageTableId(props.broker, props.page, t())}
              columns={pageColumns(t())}
              rows={(t().rows ?? []) as PageRow[]}
              rowKey={(r) => (r.id != null ? String(r.id) : "")}
              empty={translate("There is no trading data here yet")}
              onRow={(r) => {
                const s = symbol();
                if (s && typeof r[s] === "string") props.onRow(r[s] as string);
              }}
            />
          </section>
        );
      }}
    </Index>
  );
}
