/*
 * Account manager (#315): the connected broker plugin's account under the charts, a tab of the bottom panel. The
 * account header (account selector, balance, equity, P&L, margin), the pages (Positions, Orders, Trade history,
 * Account summary, Notifications log) and their tables. A row click shows its symbol on the chart.
 */
import { For, Show, createMemo, createSignal } from "solid-js";
import type { BrokerNotice } from "../../bindings";
import { showConfirm } from "../../components/Dialogs";
import { CheckField, NumberField } from "../../components/form";
import { Tooltip } from "../../components/Tooltip";
import { pluginBroker, type BrokerFill, type BrokerOrder, type BrokerPosition } from "../../data/trading/plugin-broker";
import { tradingUi } from "../../data/trading/trading-ui";
import { emitAppEvent } from "../../data/app-events";
import * as kv from "../../data/kv";
import { translate } from "../../i18n/translator";
import { Popover, PopItem, PopSectionTitle } from "../screener/Popover";
import { cachedSymbolSessions } from "../../data/session";
import { fmtMoney, fmtPct, fmtPnl, fmtPrice as fmtAnyPrice, fmtQty, fmtTime, pnlClass } from "./format";
import { AccountTable, tableCsv, type Column, type RowMenuItem } from "./AccountTable";
import { DownloadTradingDataDialog } from "./DownloadTradingDataDialog";
import { CloseIcon, PencilIcon } from "./icons";

/** A price of `ticker` on its symbol's tick (once the chart symbol's sessions are known). */
const fmtPrice = (v: number | null | undefined, ticker?: string) => {
  const sym = ticker ? pluginBroker.chartSymbolFor(ticker) : null;
  return fmtAnyPrice(v, sym ? cachedSymbolSessions(sym)?.mintick : null);
};

type Page = "positions" | "orders" | "history" | "summary" | "notifications";
type Filter = "all" | "working" | "inactive" | "filled" | "cancelled" | "rejected";

const isActiveOrder = (o: BrokerOrder) => o.status === "placing" || o.status === "working" || o.status === "inactive" || !o.status;

function matches(o: BrokerOrder, f: Filter): boolean {
  if (f === "all") return true;
  if (f === "working") return o.status === "working" || o.status === "placing" || !o.status;
  return o.status === f;
}

const typeTitle = (t: BrokerOrder["type"]) =>
  t === "market" ? translate("Market") : t === "limit" ? translate("Limit") : t === "stop" ? translate("Stop") : translate("Stop Limit");
const statusTitle = (s: BrokerOrder["status"]) => {
  switch (s ?? "working") {
    case "placing":
      return translate("Placing");
    case "inactive":
      return translate("Inactive");
    case "filled":
      return translate("Filled");
    case "cancelled":
      return translate("Cancelled");
    case "rejected":
      return translate("Rejected");
    default:
      return translate("Working");
  }
};

/** Ask, then cancel the order. */
function cancelOrder(o: BrokerOrder) {
  const price = o.type === "stop" || o.type === "stopLimit" ? o.stopPrice : o.limitPrice;
  showConfirm({
    title: translate("Cancel order"),
    text: `${o.side === "buy" ? translate("Buy") : translate("Sell")} ${typeTitle(o.type)} ${fmtQty(o.qty)} ${o.ticker}${price != null ? ` @ ${fmtPrice(price, o.ticker)}` : ""}`,
    mainText: translate("Cancel order"),
    cancelText: translate("Keep order"),
    intent: "danger",
    onConfirm: () => pluginBroker.cancelOrder(o.id),
  });
}

/** Ask, then close the position, all of it or, with "Partial close", the quantity typed. */
function closePosition(p: BrokerPosition) {
  const [partial, setPartial] = createSignal(false);
  const [qty, setQty] = createSignal(String(p.qty));
  const part = () => {
    const n = parseFloat(qty());
    return Number.isFinite(n) && n > 0 && n < p.qty ? n : null;
  };
  showConfirm({
    title: translate("Close position"),
    text: `${p.side === "buy" ? translate("Long") : translate("Short")} ${fmtQty(p.qty)} ${p.ticker} @ ${fmtPrice(p.avgPrice, p.ticker)}`,
    mainText: translate("Close position"),
    cancelText: translate("Cancel"),
    intent: "danger",
    body: () => (
      <div class="trd-partial-close">
        <CheckField variant="settings" label={translate("Partial close")} checked={partial()} onChange={setPartial} />
        <Show when={partial()}>
          <NumberField value={qty()} width={160} num={{ min: 0, max: p.qty, step: 1 }} onChange={setQty} />
        </Show>
      </div>
    ),
    onConfirm: () => pluginBroker.closePositionById(p.id, partial() ? part() : null),
  });
}

/** Reverse a position: a market order of twice its quantity the other way (from the chart that trades it). */
function reversePosition(p: BrokerPosition) {
  const at = pluginBroker.positionPane(p);
  if (at) pluginBroker.reverse(at.paneId);
}

/** Right click on a position, as the reference app's: protect, close, reverse, a new order, the settings. */
function positionMenu(p: BrokerPosition): RowMenuItem[] {
  const at = pluginBroker.positionPane(p);
  return [
    { title: translate("Protect position…"), disabled: !at, onClick: () => at && tradingUi.editPosition(at.position, at.paneId) },
    { title: translate("Close position"), onClick: () => closePosition(p) },
    { title: translate("Reverse position"), disabled: !at, onClick: () => reversePosition(p) },
    "divider",
    { title: translate("Create new order…"), onClick: () => tradingUi.openOrderTicket({ symbol: pluginBroker.chartSymbolFor(p.ticker) ?? undefined }) },
    { title: translate("Trading settings…"), onClick: () => emitAppEvent("chart-open-settings", { tab: "trading" }) },
  ];
}

/** Right click on a working order: modify, cancel. */
function orderMenu(o: BrokerOrder): RowMenuItem[] {
  if (!isActiveOrder(o)) return [];
  const edit = pluginBroker.editable(o);
  return [
    { title: translate("Modify order…"), disabled: !edit, onClick: () => edit && tradingUi.editOrder(edit.order, edit.paneId) },
    { title: translate("Cancel order"), onClick: () => cancelOrder(o) },
  ];
}

const DownloadIcon = () => (
  <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
    <path fill="currentColor" d="M10 8.91V2H9v6.91L6.33 6.62l-.66.76 3.5 3 .33.28.33-.28 3.5-3-.66-.76L10 8.92zM4 14v-3H3v3a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-3h-1v3H4z" />
  </svg>
);

export function AccountManager(props: { onSymbol: (symbol: string) => void; height: number }) {
  const [page, setPage] = createSignal<Page>("positions");
  const [exporting, setExporting] = createSignal(false);
  const [filter, setFilter] = createSignal<Filter>("all");
  const st = () => pluginBroker.account();
  const show = (ticker: string) => {
    const s = pluginBroker.chartSymbolFor(ticker);
    if (s) props.onSymbol(s);
  };
  const counts = createMemo(() => ({ positions: st()?.positions.length ?? 0, orders: (st()?.orders ?? []).filter(isActiveOrder).length }));
  const pages: [Page, () => string][] = [
    ["positions", () => translate("Positions")],
    ["orders", () => translate("Orders")],
    ["history", () => translate("Trade history")],
    ["summary", () => translate("Account summary")],
    ["notifications", () => translate("Notifications log")],
  ];
  const filters: [Filter, () => string][] = [
    ["all", () => translate("All")],
    ["working", () => translate("Working")],
    ["inactive", () => translate("Inactive")],
    ["filled", () => translate("Filled")],
    ["cancelled", () => translate("Cancelled")],
    ["rejected", () => translate("Rejected")],
  ];
  return (
    <div class="trd-am" style={{ height: Number.isFinite(props.height) ? `${props.height}px` : "100%" }} data-name="account-manager">
      <Show
        when={pluginBroker.connected()}
        fallback={
          <div class="trd-empty">
            <div class="trd-empty-title">{pluginBroker.status()?.activeName ?? translate("Broker")}</div>
            <div class="trd-empty-text">
              {pluginBroker.status()?.pluginConnected
                ? translate("The plugin is not connected to its broker.")
                : translate("The broker plugin is not connected. Check it in Settings > Plugins.")}
            </div>
          </div>
        }
      >
        <AccountHeader />
        <div class="trd-am-tabs" role="tablist">
          <For each={pages}>
            {([id, title]) => {
              const count = () => (id === "positions" ? counts().positions : id === "orders" ? counts().orders : 0);
              return (
                <button type="button" role="tab" class="trd-pill" classList={{ "is-selected": page() === id }} aria-selected={page() === id} onClick={() => setPage(id)}>
                  {title()}
                  <Show when={count() > 0}>
                    <span class="trd-pill-count ot-value"> {count()}</span>
                  </Show>
                </button>
              );
            }}
          </For>
          <Tooltip text="Download data" side="top">
            <button type="button" class="trd-row-btn trd-am-download" aria-label={translate("Download data")} data-name="download-data" onClick={() => setExporting(true)}>
              <DownloadIcon />
            </button>
          </Tooltip>
        </div>
        <Show when={exporting()}>
          <DownloadTradingDataDialog
            broker={pluginBroker.status()?.activeName ?? translate("Broker")}
            tabs={pages.map(([id, title]) => ({ id, title, csv: () => pageCsv(id) }))}
            onClose={() => setExporting(false)}
          />
        </Show>
        <Show when={page() === "orders"}>
          <div class="trd-am-filters" role="tablist">
            <For each={filters}>
              {([id, title]) => {
                const n = () => (st()?.orders ?? []).filter((o) => matches(o, id)).length;
                return (
                  <button type="button" role="tab" class="trd-filter" classList={{ "is-selected": filter() === id }} aria-selected={filter() === id} onClick={() => setFilter(id)}>
                    {title()}
                    <Show when={n() > 0}>
                      <span class="trd-pill-count ot-value"> {n()}</span>
                    </Show>
                  </button>
                );
              }}
            </For>
          </div>
        </Show>
        <div class="trd-am-content">
          <Show when={page() === "positions"}>
            <PositionsTable onRow={show} />
          </Show>
          <Show when={page() === "orders"}>
            <OrdersTable filter={filter()} onRow={show} />
          </Show>
          <Show when={page() === "history"}>
            <HistoryTable onRow={show} />
          </Show>
          <Show when={page() === "summary"}>
            <SummaryTable />
          </Show>
          <Show when={page() === "notifications"}>
            <NotificationsTable />
          </Show>
        </div>
      </Show>
    </div>
  );
}

/** "Hide values" of the account bar, kept across sessions. */
const HIDE_KEY = "ot:trading:hide-account-values";
const [valuesHidden, setValuesHidden] = createSignal(kv.getItem(HIDE_KEY) === "true");
const toggleValues = () => {
  const next = !valuesHidden();
  setValuesHidden(next);
  kv.setItem(HIDE_KEY, String(next));
};

const EyeIcon = () => (
  <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
    <path fill="currentColor" fill-rule="evenodd" d="M12 9a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm-1 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z" />
    <path fill="currentColor" d="M16.91 8.8C15.31 4.99 12.18 3 9 3 5.82 3 2.7 4.98 1.08 8.8L1 9l.08.2C2.7 13.02 5.82 15 9 15c3.18 0 6.3-1.97 7.91-5.8L17 9l-.09-.2ZM9 14c-2.69 0-5.42-1.63-6.91-5 1.49-3.37 4.22-5 6.9-5 2.7 0 5.43 1.63 6.92 5-1.5 3.37-4.23 5-6.91 5Z" />
  </svg>
);
const EyeOffIcon = () => (
  <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
    <path fill="currentColor" d="M3.7 15 15 3.7l-.7-.7L3 14.3l.7.7ZM9 3c1.09 0 2.17.23 3.19.7l-.77.76C10.63 4.16 9.82 4 9 4 6.31 4 3.58 5.63 2.08 9a9.35 9.35 0 0 0 1.93 2.87l-.7.7A10.44 10.44 0 0 1 1.08 9.2L1 9l.08-.2C2.69 4.99 5.82 3 9 3Z" />
    <path fill="currentColor" d="M9 6a3 3 0 0 1 .78.1l-.9.9A2 2 0 0 0 7 8.88l-.9.9A3 3 0 0 1 9 6ZM11.9 8.22l-.9.9A2 2 0 0 1 9.13 11l-.9.9a3 3 0 0 0 3.67-3.68Z" />
    <path fill="currentColor" d="M9 14c-.82 0-1.64-.15-2.43-.45l-.76.76c1.02.46 2.1.7 3.19.7 3.18 0 6.31-1.98 7.92-5.81L17 9l-.08-.2a10.44 10.44 0 0 0-2.23-3.37l-.7.7c.75.76 1.41 1.71 1.93 2.87-1.5 3.37-4.23 5-6.92 5Z" />
  </svg>
);
const CaretIcon = () => (
  <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
    <path fill="currentColor" d="m4.67 7.38.66-.76L9 9.84l3.67-3.22.66.76L9 11.16 4.67 7.38Z" />
  </svg>
);

/** The account bar: a rounded strip with the account (name, balance, DEMO / LIVE; a menu when the broker has several
 *  accounts), the account's values, and the eye that hides them (the balance then shows as dots). */
function AccountHeader() {
  let anchor: HTMLButtonElement | undefined;
  const [open, setOpen] = createSignal(false);
  const s = () => pluginBroker.account();
  const acc = () => s()?.account ?? null;
  const many = () => (s()?.accounts?.length ?? 0) > 1;
  /** The values the broker reports (one that it leaves out is not shown). */
  const fields = (): { title: string; value: string; cls?: string; hint?: string }[] => {
    const a = acc();
    const rows: [string, number | null | undefined, boolean, string?][] = [
      [translate("Unrealized PnL"), a?.unrealizedPnl, true],
      [translate("Realized PnL"), a?.realizedPnl, true],
      [translate("Equity"), a?.equity, false],
      [translate("Account margin"), a?.marginUsed, false, "The margin your open positions hold"],
      [translate("Available funds"), a?.marginFree, false, "What is left for new orders"],
    ];
    return rows
      .filter(([, v]) => v != null)
      .map(([title, v, pnl, hint]) => (pnl ? { title, value: fmtPnl(v), cls: pnlClass(v), hint } : { title, value: fmtMoney(v), hint }));
  };
  return (
    <div class="trd-am-header" classList={{ "is-expanded": !valuesHidden() }} data-name="account-bar">
      <button
        ref={anchor}
        type="button"
        class="trd-account-btn"
        classList={{ "is-static": !many(), "is-open": open() }}
        aria-haspopup={many() ? "menu" : undefined}
        onClick={() => many() && setOpen(!open())}
      >
        <span class="trd-account-name" data-no-translate>
          {acc()?.name || acc()?.id || "—"}
        </span>
        <span class="trd-account-balance ot-value">{valuesHidden() ? "••••" : fmtMoney(acc()?.balance)}</span>
        <span class="trd-account-ccy" data-no-translate>
          {acc()?.currency ?? ""}
        </span>
        <span class="trd-account-kind" classList={{ "is-live": acc()?.isDemo === false }}>
          {acc()?.isDemo === false ? translate("LIVE") : translate("DEMO")}
        </span>
        <Show when={many()}>
          <span class="trd-account-caret"><CaretIcon /></span>
        </Show>
      </button>
      <Show when={open()}>
        <Popover anchor={anchor} onClose={() => setOpen(false)} offset={{ x: 0, y: 4 }}>
          <PopSectionTitle title={translate("ACCOUNTS")} />
          <For each={s()?.accounts ?? []}>
            {(a) => (
              <PopItem
                title={a.name || a.id || ""}
                selected={a.id === acc()?.id}
                onClick={() => {
                  setOpen(false);
                  pluginBroker.selectAccount(a.id ?? "");
                }}
              />
            )}
          </For>
        </Popover>
      </Show>
      <div class="trd-am-summary">
        <Show when={!valuesHidden()}>
          <div class="trd-am-fields">
            <For each={fields()}>
              {(f) => (
                <div class="trd-am-field">
                  <Show when={f.hint} fallback={<span class="trd-am-field-title">{f.title}</span>}>
                    <Tooltip text={f.hint!} side="top">
                      <span class="trd-am-field-title is-hint" tabIndex={0}>
                        {f.title}
                      </span>
                    </Tooltip>
                  </Show>
                  <span class={`trd-am-field-value ot-value ${f.cls ?? ""}`}>{f.value}</span>
                </div>
              )}
            </For>
          </div>
        </Show>
        <Tooltip text={valuesHidden() ? "Show values" : "Hide values"} side="bottom">
          <button
            type="button"
            class="trd-am-eye"
            aria-label={valuesHidden() ? translate("Show values") : translate("Hide values")}
            aria-pressed={valuesHidden()}
            onClick={toggleValues}
          >
            {valuesHidden() ? <EyeIcon /> : <EyeOffIcon />}
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

const SymbolPill = (p: { ticker: string }) => (
  <span class="trd-symbol-pill" data-no-translate>
    {p.ticker}
  </span>
);

const sideText = (side: "buy" | "sell", position?: boolean) =>
  position ? (side === "buy" ? translate("Long") : translate("Short")) : side === "buy" ? translate("Buy") : translate("Sell");
const SideCell = (p: { side: "buy" | "sell"; position?: boolean }) => <span class={p.side === "buy" ? "trd-buy" : "trd-sell"}>{sideText(p.side, p.position)}</span>;

const Num = (p: { text: string; cls?: string }) => <span class={`ot-value ${p.cls ?? ""}`}>{p.text}</span>;
const dash = (v: number | null | undefined, ticker: string) => (v != null ? fmtPrice(v, ticker) : "—");
/** A time in the CSV: ISO, UTC. */
const timeText = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);

const positionPct = (p: BrokerPosition) => {
  const cost = p.avgPrice * p.qty;
  return p.unrealizedPnl != null && cost > 0 ? (p.unrealizedPnl / cost) * 100 : null;
};
const marketValue = (p: BrokerPosition) => (p.last != null ? p.last * p.qty : null);

/** The pages' columns (`hidden`: shown once picked in Column setup), shared by the tables and their CSV. */
const POSITION_COLUMNS: Column<BrokerPosition>[] = [
  { id: "symbol", fixed: true, title: () => translate("Symbol"), cell: (p) => <SymbolPill ticker={p.ticker} />, value: (p) => p.ticker },
  { id: "side", title: () => translate("Side"), cell: (p) => <SideCell side={p.side} position />, value: (p) => sideText(p.side, true) },
  { id: "qty", num: true, title: () => translate("Quantity"), cell: (p) => <Num text={fmtQty(p.qty)} />, value: (p) => p.qty },
  { id: "avg", num: true, title: () => translate("Avg price"), cell: (p) => <Num text={fmtPrice(p.avgPrice, p.ticker)} />, value: (p) => p.avgPrice },
  { id: "last", num: true, title: () => translate("Last price"), cell: (p) => <Num text={fmtPrice(p.last, p.ticker)} />, value: (p) => p.last },
  { id: "tp", num: true, title: () => translate("Take profit"), cell: (p) => <Num text={fmtPrice(p.takeProfit, p.ticker)} />, value: (p) => p.takeProfit },
  { id: "sl", num: true, title: () => translate("Stop loss"), cell: (p) => <Num text={fmtPrice(p.stopLoss, p.ticker)} />, value: (p) => p.stopLoss },
  { id: "upl", num: true, title: () => translate("Unrealized PnL"), cell: (p) => <Num text={fmtPnl(p.unrealizedPnl)} cls={pnlClass(p.unrealizedPnl)} />, value: (p) => p.unrealizedPnl },
  { id: "uplPct", num: true, title: () => translate("Unrealized PnL %"), cell: (p) => <Num text={fmtPct(positionPct(p))} cls={pnlClass(positionPct(p))} />, value: (p) => positionPct(p) },
  { id: "rpl", num: true, title: () => translate("Realized PnL"), cell: (p) => <Num text={fmtPnl(p.realizedPnl)} cls={pnlClass(p.realizedPnl)} />, value: (p) => p.realizedPnl },
  { id: "value", num: true, hidden: true, title: () => translate("Market value"), cell: (p) => <Num text={fmtMoney(marketValue(p))} />, value: marketValue },
  { id: "cost", num: true, hidden: true, title: () => translate("Cost basis"), cell: (p) => <Num text={fmtMoney(p.avgPrice * p.qty)} />, value: (p) => p.avgPrice * p.qty },
  { id: "id", num: true, hidden: true, title: () => translate("Position ID"), cell: (p) => <span data-no-translate>{p.id}</span>, value: (p) => p.id },
];

const left = (o: BrokerOrder) => (o.qty != null ? Math.max(0, o.qty - (o.filledQty ?? 0)) : null);
const ORDER_COLUMNS: Column<BrokerOrder>[] = [
  { id: "symbol", fixed: true, title: () => translate("Symbol"), cell: (o) => <SymbolPill ticker={o.ticker} />, value: (o) => o.ticker },
  { id: "side", title: () => translate("Side"), cell: (o) => <SideCell side={o.side} />, value: (o) => sideText(o.side) },
  { id: "type", title: () => translate("Type"), cell: (o) => typeTitle(o.type), value: (o) => typeTitle(o.type) },
  { id: "qty", num: true, title: () => translate("Quantity"), cell: (o) => <Num text={fmtQty(o.qty)} />, value: (o) => o.qty },
  { id: "filled", num: true, hidden: true, title: () => translate("Filled quantity"), cell: (o) => <Num text={fmtQty(o.filledQty)} />, value: (o) => o.filledQty },
  { id: "left", num: true, hidden: true, title: () => translate("Quantity left"), cell: (o) => <Num text={fmtQty(left(o))} />, value: left },
  { id: "avgFill", num: true, title: () => translate("Avg fill price"), cell: (o) => <Num text={dash(o.avgFillPrice, o.ticker)} />, value: (o) => o.avgFillPrice },
  { id: "limit", num: true, title: () => translate("Limit price"), cell: (o) => <Num text={dash(o.limitPrice, o.ticker)} />, value: (o) => o.limitPrice },
  { id: "stop", num: true, title: () => translate("Stop price"), cell: (o) => <Num text={dash(o.stopPrice, o.ticker)} />, value: (o) => o.stopPrice },
  { id: "tp", num: true, title: () => translate("Take profit"), cell: (o) => <Num text={dash(o.takeProfit, o.ticker)} />, value: (o) => o.takeProfit },
  { id: "sl", num: true, title: () => translate("Stop loss"), cell: (o) => <Num text={dash(o.stopLoss, o.ticker)} />, value: (o) => o.stopLoss },
  {
    id: "status",
    title: () => translate("Status"),
    cell: (o) => (
      <span class={`trd-status trd-status-${o.status ?? "working"}`} title={o.message ?? undefined}>
        {statusTitle(o.status)}
      </span>
    ),
    value: (o) => statusTitle(o.status),
  },
  { id: "duration", hidden: true, title: () => translate("Duration"), cell: (o) => <span data-no-translate>{o.duration ?? ""}</span>, value: (o) => o.duration },
  { id: "updated", title: () => translate("Last update time"), cell: (o) => <Num text={fmtTime(o.updatedMs)} />, value: (o) => timeText(o.updatedMs) },
  { id: "id", num: true, title: () => translate("Order ID"), cell: (o) => <span data-no-translate>{o.id}</span>, value: (o) => o.id },
];

const FILL_COLUMNS: Column<BrokerFill>[] = [
  { id: "symbol", fixed: true, title: () => translate("Symbol"), cell: (e) => <SymbolPill ticker={e.ticker} />, value: (e) => e.ticker },
  { id: "side", title: () => translate("Side"), cell: (e) => <SideCell side={e.side} />, value: (e) => sideText(e.side) },
  { id: "qty", num: true, title: () => translate("Quantity"), cell: (e) => <Num text={fmtQty(e.qty)} />, value: (e) => e.qty },
  { id: "price", num: true, title: () => translate("Fill price"), cell: (e) => <Num text={fmtPrice(e.price, e.ticker)} />, value: (e) => e.price },
  { id: "time", title: () => translate("Time"), cell: (e) => <Num text={fmtTime(e.timeMs)} />, value: (e) => timeText(e.timeMs) },
  { id: "commission", num: true, title: () => translate("Commission"), cell: (e) => <Num text={fmtMoney(e.commission)} />, value: (e) => e.commission },
  { id: "rpl", num: true, title: () => translate("Realized PnL"), cell: (e) => <Num text={fmtPnl(e.realizedPnl)} cls={pnlClass(e.realizedPnl)} />, value: (e) => e.realizedPnl },
  { id: "order", num: true, hidden: true, title: () => translate("Order ID"), cell: (e) => <span data-no-translate>{e.orderId ?? ""}</span>, value: (e) => e.orderId },
];

type SummaryRow = { label: string; value: string; own: boolean };
const SUMMARY_COLUMNS: Column<SummaryRow>[] = [
  { id: "label", fixed: true, title: () => translate("Account summary"), cell: (r) => (r.own ? r.label : <span data-no-translate>{r.label}</span>), value: (r) => r.label },
  { id: "value", num: true, title: () => translate("Value"), cell: (r) => <span class="ot-value" data-no-translate>{r.value}</span>, value: (r) => r.value },
];

const noticeTitle = (n: BrokerNotice) => (n.level === "error" ? translate("Error") : n.level === "warn" ? translate("Warning") : translate("Info"));
const NOTICE_COLUMNS: Column<BrokerNotice>[] = [
  { id: "time", fixed: true, title: () => translate("Time"), cell: (n) => <Num text={fmtTime(n.timeMs ?? 0)} />, value: (n) => timeText(n.timeMs) },
  { id: "title", title: () => translate("Title"), cell: (n) => <span class={`trd-notice-${n.level}`}>{noticeTitle(n)}</span>, value: noticeTitle },
  { id: "text", title: () => translate("Text"), cell: (n) => <span class="trd-notice-text" data-no-translate>{n.message}</span>, value: (n) => n.message },
];

/** The rows of each page (trade history newest first). */
const positionRows = () => pluginBroker.account()?.positions ?? [];
const orderRows = (f: Filter) => (pluginBroker.account()?.orders ?? []).filter((o) => matches(o, f));
const fillRows = () => [...(pluginBroker.account()?.executions ?? [])].sort((a, b) => b.timeMs - a.timeMs);
const summaryRows = (): SummaryRow[] => {
  const a = pluginBroker.account()?.account;
  if (!a) return [];
  const own = [
    [translate("Balance"), fmtMoney(a.balance)],
    [translate("Equity"), fmtMoney(a.equity)],
    [translate("Unrealized PnL"), fmtPnl(a.unrealizedPnl)],
    [translate("Realized PnL"), fmtPnl(a.realizedPnl)],
    [translate("Margin"), fmtMoney(a.marginUsed)],
    [translate("Free margin"), fmtMoney(a.marginFree)],
  ].filter(([, v]) => v !== "—");
  return [
    ...own.map(([label, value]) => ({ label, value, own: true })),
    ...(a.values ?? []).map((v) => ({ label: v.label ?? "", value: `${v.value ?? ""}${v.currency ? ` ${v.currency}` : ""}`, own: false })),
  ];
};
const noticeRows = () => pluginBroker.status()?.notices ?? [];

/** The CSV of a page ("Download data"); Orders: all of them. */
export function pageCsv(page: Page): string {
  switch (page) {
    case "positions":
      return tableCsv("positions", POSITION_COLUMNS, positionRows());
    case "orders":
      return tableCsv("orders", ORDER_COLUMNS, orderRows("all"));
    case "history":
      return tableCsv("history", FILL_COLUMNS, fillRows());
    case "summary":
      return tableCsv("summary", SUMMARY_COLUMNS, summaryRows());
    default:
      return tableCsv("notifications", NOTICE_COLUMNS, noticeRows());
  }
}

function PositionsTable(props: { onRow: (ticker: string) => void }) {
  return (
    <AccountTable<BrokerPosition>
      id="positions"
      columns={POSITION_COLUMNS}
      rows={positionRows()}
      rowKey={(p) => p.id}
      empty={translate("There are no open positions in your trading account yet")}
      onRow={(p) => props.onRow(p.ticker)}
      menu={positionMenu}
      actions={(p) => (
        <>
          <Show when={pluginBroker.positionPane(p)}>
            {(at) => (
              <Tooltip text="Protect position…" side="top">
                <button type="button" class="trd-row-btn" aria-label={translate("Protect position…")} onClick={() => tradingUi.editPosition(at().position, at().paneId)}>
                  <PencilIcon />
                </button>
              </Tooltip>
            )}
          </Show>
          <Tooltip text="Close" side="top">
            <button type="button" class="trd-row-btn" aria-label={translate("Close position")} onClick={() => closePosition(p)}>
              <CloseIcon size={16} />
            </button>
          </Tooltip>
        </>
      )}
    />
  );
}

function OrdersTable(props: { filter: Filter; onRow: (ticker: string) => void }) {
  return (
    <AccountTable<BrokerOrder>
      id="orders"
      columns={ORDER_COLUMNS}
      rows={orderRows(props.filter)}
      rowKey={(o) => o.id}
      empty={translate("There is no trading data here yet")}
      onRow={(o) => props.onRow(o.ticker)}
      muted={(o) => props.filter === "all" && !isActiveOrder(o)}
      menu={orderMenu}
      actions={(o) => (
        <Show when={isActiveOrder(o)}>
          <Show when={pluginBroker.editable(o)}>
            {(edit) => (
              <Tooltip text="Modify order…" side="top">
                <button type="button" class="trd-row-btn" aria-label={translate("Modify order")} onClick={() => tradingUi.editOrder(edit().order, edit().paneId)}>
                  <PencilIcon />
                </button>
              </Tooltip>
            )}
          </Show>
          <Tooltip text="Cancel" side="top">
            <button type="button" class="trd-row-btn" aria-label={translate("Cancel order")} onClick={() => cancelOrder(o)}>
              <CloseIcon size={16} />
            </button>
          </Tooltip>
        </Show>
      )}
    />
  );
}

function HistoryTable(props: { onRow: (ticker: string) => void }) {
  return (
    <AccountTable<BrokerFill>
      id="history"
      columns={FILL_COLUMNS}
      rows={fillRows()}
      rowKey={(e) => e.id}
      empty={translate("There is no trading data here yet")}
      onRow={(e) => props.onRow(e.ticker)}
    />
  );
}

function SummaryTable() {
  const rows = createMemo(summaryRows);
  return <AccountTable id="summary" columns={SUMMARY_COLUMNS} rows={rows()} rowKey={(r) => r.label} empty={translate("There is no trading data here yet")} />;
}

function NotificationsTable() {
  return (
    <AccountTable<BrokerNotice>
      id="notifications"
      columns={NOTICE_COLUMNS}
      rows={noticeRows()}
      rowKey={(n) => `${n.timeMs}:${n.message}`}
      empty={translate("There is no trading data here yet")}
    />
  );
}

/** The bottom panel's tab: the broker's name, then DEMO or LIVE once the account is known. */
export function AccountTabTitle() {
  const s = () => pluginBroker.status();
  const a = () => s()?.state?.account ?? null;
  return (
    <>
      <span data-no-translate>{s()?.activeName ?? ""}</span>
      <Show when={a()}>
        {(acc) => (
          <span class="trd-account-kind" classList={{ "is-live": !acc().isDemo }}>
            {acc().isDemo ? translate("DEMO") : translate("LIVE")}
          </span>
        )}
      </Show>
    </>
  );
}
