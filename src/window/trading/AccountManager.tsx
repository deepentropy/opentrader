/*
 * Account manager (#315): the connected broker plugin's account under the charts, a tab of the bottom panel. The
 * account header (account selector, balance, equity, P&L, margin), the pages (Positions, Orders, Trade history,
 * Account summary, Notifications log) and their tables. A row click shows its symbol on the chart.
 */
import { For, Show, createMemo, createSignal, type JSX } from "solid-js";
import type { BrokerNotice } from "../../bindings";
import { showConfirm } from "../../components/Dialogs";
import { Tooltip } from "../../components/Tooltip";
import { pluginBroker, type BrokerFill, type BrokerOrder, type BrokerPosition } from "../../data/trading/plugin-broker";
import { tradingUi } from "../../data/trading/trading-ui";
import { translate } from "../../i18n/translator";
import { Popover, PopItem, PopSectionTitle } from "../screener/Popover";
import { cachedSymbolSessions } from "../../data/session";
import { fmtMoney, fmtPct, fmtPnl, fmtPrice as fmtAnyPrice, fmtQty, fmtTime, pnlClass } from "./format";
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

/** Ask, then close the position. */
function closePosition(p: BrokerPosition) {
  showConfirm({
    title: translate("Close position"),
    text: `${p.side === "buy" ? translate("Long") : translate("Short")} ${fmtQty(p.qty)} ${p.ticker} @ ${fmtPrice(p.avgPrice, p.ticker)}`,
    mainText: translate("Close position"),
    cancelText: translate("Cancel"),
    intent: "danger",
    onConfirm: () => pluginBroker.closePositionById(p.id),
  });
}

export function AccountManager(props: { onSymbol: (symbol: string) => void; height: number }) {
  const [page, setPage] = createSignal<Page>("positions");
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
        </div>
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

function AccountHeader() {
  let anchor: HTMLButtonElement | undefined;
  const [open, setOpen] = createSignal(false);
  const s = () => pluginBroker.account();
  const acc = () => s()?.account ?? null;
  const many = () => (s()?.accounts?.length ?? 0) > 1;
  const fields = (): { title: string; value: string; cls?: string }[] => [
    { title: translate("Balance"), value: fmtMoney(acc()?.balance) },
    { title: translate("Equity"), value: fmtMoney(acc()?.equity) },
    { title: translate("Unrealized PnL"), value: fmtPnl(acc()?.unrealizedPnl), cls: pnlClass(acc()?.unrealizedPnl) },
    { title: translate("Margin"), value: fmtMoney(acc()?.marginUsed) },
    { title: translate("Free margin"), value: fmtMoney(acc()?.marginFree) },
  ];
  return (
    <div class="trd-am-header">
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
        <span class="trd-account-ccy" data-no-translate>
          {acc()?.currency ?? ""}
        </span>
        <span class="trd-account-kind" classList={{ "is-live": acc()?.isDemo === false }}>
          {acc()?.isDemo === false ? translate("LIVE") : translate("DEMO")}
        </span>
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
        <For each={fields()}>
          {(f) => (
            <div class="trd-am-field">
              <div class="trd-am-field-title">{f.title}</div>
              <div class={`trd-am-field-value ot-value ${f.cls ?? ""}`}>{f.value}</div>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

/** A table: header row and rows, the last column holding the row's actions. */
function Table<T>(props: {
  columns: { title: string; num?: boolean; cell: (row: T) => JSX.Element }[];
  rows: T[];
  rowKey: (row: T) => string;
  empty: string;
  onRow?: (row: T) => void;
  actions?: (row: T) => JSX.Element;
  muted?: (row: T) => boolean;
}) {
  return (
    <Show when={props.rows.length > 0} fallback={<div class="trd-empty"><div class="trd-empty-text">{props.empty}</div></div>}>
      <table class="trd-table">
        <thead>
          <tr>
            <For each={props.columns}>{(c) => <th classList={{ "is-num": c.num }}>{c.title}</th>}</For>
            <Show when={props.actions}>
              <th class="trd-actions-col" />
            </Show>
          </tr>
        </thead>
        <tbody>
          <For each={props.rows}>
            {(row) => (
              <tr classList={{ "is-muted": props.muted?.(row) ?? false }} onClick={() => props.onRow?.(row)} data-key={props.rowKey(row)}>
                <For each={props.columns}>{(c) => <td classList={{ "is-num": c.num }}>{c.cell(row)}</td>}</For>
                <Show when={props.actions}>
                  <td class="trd-actions-col" onClick={(e) => e.stopPropagation()}>
                    <div class="trd-row-actions">{props.actions!(row)}</div>
                  </td>
                </Show>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </Show>
  );
}

const SymbolPill = (p: { ticker: string }) => (
  <span class="trd-symbol-pill" data-no-translate>
    {p.ticker}
  </span>
);

const SideCell = (p: { side: "buy" | "sell"; position?: boolean }) => (
  <span class={p.side === "buy" ? "trd-buy" : "trd-sell"}>
    {p.position ? (p.side === "buy" ? translate("Long") : translate("Short")) : p.side === "buy" ? translate("Buy") : translate("Sell")}
  </span>
);

const Num = (p: { text: string; cls?: string }) => <span class={`ot-value ${p.cls ?? ""}`}>{p.text}</span>;

function PositionsTable(props: { onRow: (ticker: string) => void }) {
  const rows = () => (pluginBroker.account()?.positions ?? []);
  const pct = (p: BrokerPosition) => {
    const cost = p.avgPrice * p.qty;
    return p.unrealizedPnl != null && cost > 0 ? (p.unrealizedPnl / cost) * 100 : null;
  };
  return (
    <Table<BrokerPosition>
      rows={rows()}
      rowKey={(p) => p.id}
      empty={translate("There are no open positions in your trading account yet")}
      onRow={(p) => props.onRow(p.ticker)}
      columns={[
        { title: translate("Symbol"), cell: (p) => <SymbolPill ticker={p.ticker} /> },
        { title: translate("Side"), cell: (p) => <SideCell side={p.side} position /> },
        { title: translate("Quantity"), num: true, cell: (p) => <Num text={fmtQty(p.qty)} /> },
        { title: translate("Avg price"), num: true, cell: (p) => <Num text={fmtPrice(p.avgPrice, p.ticker)} /> },
        { title: translate("Last price"), num: true, cell: (p) => <Num text={fmtPrice(p.last, p.ticker)} /> },
        { title: translate("Take profit"), num: true, cell: (p) => <Num text={fmtPrice(p.takeProfit, p.ticker)} /> },
        { title: translate("Stop loss"), num: true, cell: (p) => <Num text={fmtPrice(p.stopLoss, p.ticker)} /> },
        { title: translate("Unrealized PnL"), num: true, cell: (p) => <Num text={fmtPnl(p.unrealizedPnl)} cls={pnlClass(p.unrealizedPnl)} /> },
        { title: translate("Unrealized PnL %"), num: true, cell: (p) => <Num text={fmtPct(pct(p))} cls={pnlClass(pct(p))} /> },
      ]}
      actions={(p) => (
        <Tooltip text="Close" side="top">
          <button type="button" class="trd-row-btn" aria-label={translate("Close position")} onClick={() => closePosition(p)}>
            <CloseIcon size={16} />
          </button>
        </Tooltip>
      )}
    />
  );
}

function OrdersTable(props: { filter: Filter; onRow: (ticker: string) => void }) {
  const rows = () => ((pluginBroker.account()?.orders ?? [])).filter((o) => matches(o, props.filter));
  const price = (v: number | null | undefined, ticker: string) => <Num text={v != null ? fmtPrice(v, ticker) : "—"} />;
  return (
    <Table<BrokerOrder>
      rows={rows()}
      rowKey={(o) => o.id}
      empty={translate("There is no trading data here yet")}
      onRow={(o) => props.onRow(o.ticker)}
      muted={(o) => props.filter === "all" && !isActiveOrder(o)}
      columns={[
        { title: translate("Symbol"), cell: (o) => <SymbolPill ticker={o.ticker} /> },
        { title: translate("Side"), cell: (o) => <SideCell side={o.side} /> },
        { title: translate("Type"), cell: (o) => typeTitle(o.type) },
        { title: translate("Quantity"), num: true, cell: (o) => <Num text={fmtQty(o.qty)} /> },
        { title: translate("Filled"), num: true, cell: (o) => <Num text={fmtQty(o.filledQty)} /> },
        { title: translate("Avg fill price"), num: true, cell: (o) => price(o.avgFillPrice, o.ticker) },
        { title: translate("Limit price"), num: true, cell: (o) => price(o.limitPrice, o.ticker) },
        { title: translate("Stop price"), num: true, cell: (o) => price(o.stopPrice, o.ticker) },
        { title: translate("Take profit"), num: true, cell: (o) => price(o.takeProfit, o.ticker) },
        { title: translate("Stop loss"), num: true, cell: (o) => price(o.stopLoss, o.ticker) },
        {
          title: translate("Status"),
          cell: (o) => (
            <span class={`trd-status trd-status-${o.status ?? "working"}`} title={o.message ?? undefined}>
              {statusTitle(o.status)}
            </span>
          ),
        },
        { title: translate("Last update time"), cell: (o) => <Num text={fmtTime(o.updatedMs)} /> },
        { title: translate("Order ID"), num: true, cell: (o) => <span data-no-translate>{o.id}</span> },
      ]}
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
  const rows = () => [...((pluginBroker.account()?.executions ?? []))].sort((a, b) => b.timeMs - a.timeMs);
  return (
    <Table<BrokerFill>
      rows={rows()}
      rowKey={(e) => e.id}
      empty={translate("There is no trading data here yet")}
      onRow={(e) => props.onRow(e.ticker)}
      columns={[
        { title: translate("Symbol"), cell: (e) => <SymbolPill ticker={e.ticker} /> },
        { title: translate("Side"), cell: (e) => <SideCell side={e.side} /> },
        { title: translate("Quantity"), num: true, cell: (e) => <Num text={fmtQty(e.qty)} /> },
        { title: translate("Fill price"), num: true, cell: (e) => <Num text={fmtPrice(e.price, e.ticker)} /> },
        { title: translate("Time"), cell: (e) => <Num text={fmtTime(e.timeMs)} /> },
        { title: translate("Commission"), num: true, cell: (e) => <Num text={fmtMoney(e.commission)} /> },
        { title: translate("Realized PnL"), num: true, cell: (e) => <Num text={fmtPnl(e.realizedPnl)} cls={pnlClass(e.realizedPnl)} /> },
      ]}
    />
  );
}

function SummaryTable() {
  const rows = createMemo(() => {
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
    return [...own.map(([label, value]) => ({ label, value, own: true })), ...(a.values ?? []).map((v) => ({ label: v.label ?? "", value: `${v.value ?? ""}${v.currency ? ` ${v.currency}` : ""}`, own: false }))];
  });
  return (
    <Table
      rows={rows()}
      rowKey={(r) => r.label}
      empty={translate("There is no trading data here yet")}
      columns={[
        { title: translate("Account summary"), cell: (r) => (r.own ? r.label : <span data-no-translate>{r.label}</span>) },
        { title: translate("Value"), num: true, cell: (r) => <span class="ot-value" data-no-translate>{r.value}</span> },
      ]}
    />
  );
}

function NotificationsTable() {
  const rows = () => pluginBroker.status()?.notices ?? [];
  const title = (n: BrokerNotice) => (n.level === "error" ? translate("Error") : n.level === "warn" ? translate("Warning") : translate("Info"));
  return (
    <Table<BrokerNotice>
      rows={rows()}
      rowKey={(n) => `${n.timeMs}:${n.message}`}
      empty={translate("There is no trading data here yet")}
      columns={[
        { title: translate("Time"), cell: (n) => <Num text={fmtTime(n.timeMs ?? 0)} /> },
        { title: translate("Title"), cell: (n) => <span class={`trd-notice-${n.level}`}>{title(n)}</span> },
        { title: translate("Text"), cell: (n) => <span class="trd-notice-text" data-no-translate>{n.message}</span> },
      ]}
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
