/*
 * Trading panel: the account manager under the charts while a broker
 * session exists (.tmp/trading-panel/DESIGN.md §3, §7).
 *
 * Footer bar: the broker tab (mark, "Interactive Brokers Live|Paper", status
 * dot, broker menu) and Collapse / Maximize. Above it: the account header
 * (account selector + summary), the page pills (Positions, Orders, Trade
 * history, Balances, Account summary, Notifications log) and the page table.
 * A row click shows its symbol on the chart.
 */
import { For, Show, createEffect, createMemo, createSignal, on, type JSX } from "solid-js";
import type { BrokerNotice, Execution, Order, OrderStatus, Position } from "../../bindings";
import { showConfirm } from "../../components/Dialogs";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { broker } from "../../data/broker-store";
import { tradingUi, type OrdersFilter, type PanelTab } from "../../data/trading-ui";
import { Popover, PopDivider, PopItem, PopSectionTitle } from "../screener/Popover";
import { fmtMoney, fmtPct, fmtPnl, fmtPrice, fmtQty, fmtTime, pnlClass } from "./format";
import { CaretIcon, CloseIcon, IbkrMark, LogOutIcon, PencilIcon, PlugIcon } from "./icons";

const DEFAULT_HEIGHT = 300;
const MIN_HEIGHT = 120;
const CHART_MIN = 150;
const FOOTER = 38;

type Props = {
  /** Show a symbol on the active chart (row click). */
  onSymbol: (symbol: string) => void;
};

const TAB_TITLES: [PanelTab, string][] = [
  ["positions", "Positions"],
  ["orders", "Orders"],
  ["history", "Trade history"],
  ["balances", "Balances"],
  ["summary", "Account summary"],
  ["notifications", "Notifications log"],
];

const FILTER_TITLES: [OrdersFilter, string][] = [
  ["all", "All"],
  ["working", "Working"],
  ["inactive", "Inactive"],
  ["filled", "Filled"],
  ["cancelled", "Cancelled"],
  ["rejected", "Rejected"],
];

const STATUS_TITLE: Record<OrderStatus, string> = {
  placing: "Placing",
  working: "Working",
  inactive: "Inactive",
  filled: "Filled",
  cancelled: "Cancelled",
  rejected: "Rejected",
};

const TYPE_TITLE = { market: "Market", limit: "Limit", stop: "Stop", stopLimit: "Stop Limit" } as const;

export const isActiveOrder = (o: Order) => o.status === "placing" || o.status === "working" || o.status === "inactive";

function matchesFilter(o: Order, f: OrdersFilter): boolean {
  switch (f) {
    case "all":
      return true;
    case "working":
      return o.status === "working" || o.status === "placing";
    default:
      return o.status === f;
  }
}

/** Bracket legs of a parent order. */
function legsOf(o: Order, all: Order[]): { tp: Order | undefined; sl: Order | undefined } {
  const kids = all.filter((c) => c.parentId === o.orderId && c.clientId === o.clientId && isActiveOrder(c));
  return {
    tp: kids.find((c) => c.orderType === "limit"),
    sl: kids.find((c) => c.orderType === "stop" || c.orderType === "stopLimit"),
  };
}

/** Type cell: bracket children read Take Profit / Stop Loss. */
function typeTitle(o: Order, all: Order[]): string {
  if (o.parentId != null && all.some((p) => p.orderId === o.parentId && p.clientId === o.clientId)) {
    if (o.orderType === "limit") return "Take Profit";
    if (o.orderType === "stop" || o.orderType === "stopLimit") return "Stop Loss";
  }
  return TYPE_TITLE[o.orderType] ?? o.rawType;
}

export function confirmCancelOrder(o: Order) {
  const price = o.orderType === "stop" || o.orderType === "stopLimit" ? o.stopPrice : o.limitPrice;
  showConfirm({
    title: "Cancel order",
    text: `${o.side === "buy" ? "Buy" : "Sell"} ${TYPE_TITLE[o.orderType] ?? o.rawType} ${fmtQty(o.qty)} ${o.ticker}${price != null ? ` @ ${fmtPrice(price)}` : ""}`,
    mainText: "Cancel order",
    cancelText: "Keep order",
    intent: "danger",
    onConfirm: () => void broker.cancelOrder(o.id).catch((e) => tradingNotice(String(e?.message ?? e))),
  });
}

export function confirmClosePosition(p: Position) {
  showConfirm({
    title: "Close position",
    text: `${p.side === "buy" ? "Long" : "Short"} ${fmtQty(p.qty)} ${p.ticker} @ ${fmtPrice(p.avgPrice)}`,
    mainText: "Close position",
    cancelText: "Cancel",
    intent: "danger",
    onConfirm: () => void broker.closePosition(p.id).catch((e) => tradingNotice(String(e?.message ?? e))),
  });
}

/** A failed command: the error toast (TradingToasts listens). */
export function tradingNotice(message: string) {
  window.dispatchEvent(new CustomEvent("ot-trading-error", { detail: message }));
}

export function brokerTitle(): string {
  const s = broker.state();
  const acct = s.account ?? "";
  if (!acct) return "Interactive Brokers";
  return `Interactive Brokers ${acct.startsWith("D") ? "Paper" : "Live"}`;
}

export function TradingPanel(props: Props) {
  let rootRef: HTMLElement | undefined;
  let tabRef: HTMLDivElement | undefined;
  const [menuOpen, setMenuOpen] = createSignal(false);
  const s = broker.state;
  const visible = () => s().broker != null || s().connection !== "disconnected";

  // A connection lost after it was up: back to the connect dialog with the
  // message, as the reference app reopens its login.
  createEffect(
    on(
      () => s().connection,
      (cur, prev) => {
        if (prev === "connected" || prev === "reconnecting") {
          if (cur === "disconnected" && s().error) tradingUi.openLogin();
        }
      },
    ),
  );

  const contentHeight = () => tradingUi.height() || DEFAULT_HEIGHT;
  const maxContent = () => Math.max(MIN_HEIGHT, (rootRef?.parentElement?.clientHeight ?? 0) - CHART_MIN - FOOTER);

  function beginResize(e: MouseEvent) {
    if (tradingUi.collapsed() || tradingUi.maximized()) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = contentHeight();
    const maxH = maxContent();
    const next = (ev: MouseEvent) => Math.min(maxH, Math.max(MIN_HEIGHT, startH + (startY - ev.clientY)));
    const onMove = (ev: MouseEvent) => tradingUi.setHeight(next(ev), false);
    const onUp = (ev: MouseEvent) => {
      tradingUi.setHeight(next(ev), true);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "ns-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  const style = () => {
    if (tradingUi.maximized()) return { height: "100%" };
    if (tradingUi.collapsed()) return { height: `${FOOTER}px` };
    return { height: `${FOOTER + contentHeight()}px` };
  };

  const dot = () => {
    const c = s().connection;
    if (c === "connected") return { cls: "is-ok", title: "Connected" };
    if (c === "connecting" || c === "reconnecting") return { cls: "is-wait", title: "Connecting" };
    if (s().error) return { cls: "is-failed", title: "Failed" };
    return { cls: "", title: "Disconnected" };
  };

  return (
    <Show when={visible()}>
      <section
        ref={rootRef}
        class="trd-panel"
        classList={{ "is-collapsed": tradingUi.collapsed(), "is-maximized": tradingUi.maximized() }}
        style={style()}
        data-name="trading-panel"
        aria-label="Trading panel"
      >
        <Show when={!tradingUi.collapsed() && !tradingUi.maximized()}>
          <div class="trd-resize-handle" onMouseDown={beginResize} />
        </Show>
        <div class="trd-footer">
          <div class="trd-footer-tabs">
            <div ref={tabRef} class="trd-footer-tab" classList={{ "is-active": !tradingUi.collapsed() }}>
              <Tooltip text={tradingUi.collapsed() ? "Open trading panel" : "Close trading panel"} side="top">
                <button
                  type="button"
                  class="trd-footer-tab-btn"
                  onClick={() => tradingUi.setCollapsed(!tradingUi.collapsed())}
                >
                  <IbkrMark size={24} radius={6} />
                  <span class="trd-footer-tab-title">{brokerTitle()}</span>
                  <Tooltip text={dot().title} side="top">
                    <span class={`trd-status-dot ${dot().cls}`} aria-label={dot().title} />
                  </Tooltip>
                </button>
              </Tooltip>
              <Tooltip text="Open broker menu" side="top">
                <button
                  type="button"
                  class="trd-footer-tab-caret"
                  classList={{ "is-open": menuOpen() }}
                  aria-label="Open broker menu"
                  onClick={() => setMenuOpen(!menuOpen())}
                >
                  <Icon name="st-footer-tab-caret" />
                </button>
              </Tooltip>
            </div>
          </div>
          <div class="trd-footer-buttons">
            <Tooltip text={tradingUi.collapsed() ? "Open panel" : "Collapse panel"} side="top">
              <button
                type="button"
                class="trd-footer-btn"
                aria-label={tradingUi.collapsed() ? "Open panel" : "Collapse panel"}
                onClick={() => tradingUi.setCollapsed(!tradingUi.collapsed())}
              >
                <Icon name={tradingUi.collapsed() ? "st-footer-collapsed-visibility" : "st-footer-normal-visibility"} size={28} />
              </button>
            </Tooltip>
            <Tooltip text={tradingUi.maximized() ? "Restore panel" : "Maximize panel"} side="top">
              <button
                type="button"
                class="trd-footer-btn"
                aria-label={tradingUi.maximized() ? "Restore panel" : "Maximize panel"}
                onClick={() => {
                  const m = !tradingUi.maximized();
                  tradingUi.setMaximized(m);
                  if (m) tradingUi.setCollapsed(false);
                }}
              >
                <Icon name={tradingUi.maximized() ? "st-footer-maximized-maximize" : "st-footer-normal-maximize"} size={28} />
              </button>
            </Tooltip>
          </div>
        </div>
        <Show when={!tradingUi.collapsed()}>
          <div class="trd-panel-body">
            <Show when={s().connection === "connected" || s().connection === "reconnecting"} fallback={<Disconnected />}>
              <AccountManager onSymbol={props.onSymbol} />
            </Show>
          </div>
        </Show>
        <Show when={menuOpen()}>
          <Popover anchor={tabRef} onClose={() => setMenuOpen(false)}>
            <MenuRow
              icon={<PlugIcon />}
              title="Connect another broker…"
              onClick={() => {
                setMenuOpen(false);
                tradingUi.openBrokerDialog();
              }}
            />
            <PopDivider />
            <MenuRow
              icon={<LogOutIcon />}
              title="Log out"
              danger
              onClick={() => {
                setMenuOpen(false);
                void broker.disconnect();
                tradingUi.closeTicket();
              }}
            />
          </Popover>
        </Show>
      </section>
    </Show>
  );
}

/** A broker-menu row with a line icon. */
function MenuRow(p: { icon: JSX.Element; title: string; danger?: boolean; onClick: () => void }) {
  return (
    <div role="menuitem" class="scr-item trd-menu-row" classList={{ "is-danger": !!p.danger }} onClick={() => p.onClick()}>
      <span class="trd-menu-icon">{p.icon}</span>
      <span class="scr-item-text">
        <span class="scr-item-title">{p.title}</span>
      </span>
    </div>
  );
}

function Disconnected() {
  const s = broker.state;
  return (
    <div class="trd-empty">
      <Show
        when={s().connection === "disconnected"}
        fallback={
          <>
            <div class="trd-spinner" aria-label="Connecting" />
            <div class="trd-empty-text">Connecting to the broker…</div>
          </>
        }
      >
        <div class="trd-empty-title">Disconnected</div>
        <div class="trd-empty-text">{s().error ?? "The broker connection is closed."}</div>
        <button type="button" class="trd-primary-btn trd-empty-btn" onClick={() => tradingUi.openLogin()}>
          Connect
        </button>
      </Show>
    </div>
  );
}

function AccountManager(props: Props) {
  const s = broker.state;
  const counts = createMemo(() => ({
    positions: s().positions.length,
    orders: s().orders.filter(isActiveOrder).length,
  }));

  return (
    <div class="trd-am">
      <AccountHeader />
      <div class="trd-am-tabs" role="tablist">
        <For each={TAB_TITLES}>
          {([id, title]) => {
            const count = () => (id === "positions" ? counts().positions : id === "orders" ? counts().orders : 0);
            return (
              <button
                type="button"
                role="tab"
                class="trd-pill"
                classList={{ "is-selected": tradingUi.tab() === id }}
                aria-selected={tradingUi.tab() === id}
                onClick={() => tradingUi.setTab(id)}
              >
                {title}
                <Show when={count() > 0}>
                  <span class="trd-pill-count"> {count()}</span>
                </Show>
              </button>
            );
          }}
        </For>
      </div>
      <Show when={tradingUi.tab() === "orders"}>
        <div class="trd-am-filters" role="tablist">
          <For each={FILTER_TITLES}>
            {([id, title]) => {
              const n = () => s().orders.filter((o) => matchesFilter(o, id)).length;
              return (
                <button
                  type="button"
                  role="tab"
                  class="trd-filter"
                  classList={{ "is-selected": tradingUi.filter() === id }}
                  aria-selected={tradingUi.filter() === id}
                  onClick={() => tradingUi.setFilter(id)}
                >
                  {title}
                  <Show when={n() > 0}>
                    <span class="trd-pill-count"> {n()}</span>
                  </Show>
                </button>
              );
            }}
          </For>
        </div>
      </Show>
      <div class="trd-am-content">
        <Show when={tradingUi.tab() === "positions"}>
          <PositionsTable onSymbol={props.onSymbol} />
        </Show>
        <Show when={tradingUi.tab() === "orders"}>
          <OrdersTable onSymbol={props.onSymbol} />
        </Show>
        <Show when={tradingUi.tab() === "history"}>
          <HistoryTable onSymbol={props.onSymbol} />
        </Show>
        <Show when={tradingUi.tab() === "balances"}>
          <BalancesTable />
        </Show>
        <Show when={tradingUi.tab() === "summary"}>
          <SummaryTables />
        </Show>
        <Show when={tradingUi.tab() === "notifications"}>
          <NotificationsTable />
        </Show>
      </div>
    </div>
  );
}

function AccountHeader() {
  const s = broker.state;
  let anchor: HTMLButtonElement | undefined;
  const [open, setOpen] = createSignal(false);
  const sum = () => s().summary;
  const fields = (): { title: string; value: string; cls?: string }[] => [
    { title: "Net liquidation value", value: fmtMoney(sum()?.equity) },
    { title: "Daily PnL", value: fmtPnl(sum()?.dailyPnl), cls: pnlClass(sum()?.dailyPnl) },
    { title: "Unrealized PnL", value: fmtPnl(sum()?.unrealizedPnl), cls: pnlClass(sum()?.unrealizedPnl) },
    { title: "Excess liquidity", value: fmtMoney(sum()?.excessLiquidity) },
  ];
  const many = () => s().accounts.length > 1;
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
        <span class="trd-account-name">{s().account ?? "—"}</span>
        <span class="trd-account-ccy">{sum()?.currency ?? ""}</span>
        <Show when={many()}>
          <CaretIcon />
        </Show>
      </button>
      <Show when={open()}>
        <Popover anchor={anchor} onClose={() => setOpen(false)} offset={{ x: 0, y: 4 }}>
          <PopSectionTitle title="ACCOUNTS" />
          <For each={s().accounts}>
            {(a) => (
              <PopItem
                title={a}
                selected={a === s().account}
                onClick={() => {
                  setOpen(false);
                  void broker.selectAccount(a).catch((e) => tradingNotice(String(e?.message ?? e)));
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
              <div class={`trd-am-field-value ${f.cls ?? ""}`}>{f.value}</div>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

/** A table: header row + rows, the last column holding the row actions. */
function Table<T>(props: {
  columns: { title: string; num?: boolean; cell: (row: T) => JSX.Element; help?: string }[];
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
            <For each={props.columns}>{(c) => <th classList={{ "is-num": c.num }} title={c.help}>{c.title}</th>}</For>
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

const SymbolPill = (p: { symbol: string; ticker: string }) => (
  <span class="trd-symbol-pill" classList={{ "is-chart": p.symbol === tradingUi.activeSymbol() }}>{p.ticker}</span>
);

const SideCell = (p: { side: "buy" | "sell"; position?: boolean }) => (
  <span class={p.side === "buy" ? "trd-buy" : "trd-sell"}>{p.position ? (p.side === "buy" ? "Long" : "Short") : p.side === "buy" ? "Buy" : "Sell"}</span>
);

function PositionsTable(props: Props) {
  const rows = () => broker.state().positions;
  const pct = (p: Position) => {
    const cost = (p.avgPrice ?? 0) * (p.qty ?? 0);
    return p.unrealizedPnl != null && cost > 0 ? (p.unrealizedPnl / cost) * 100 : null;
  };
  return (
    <Table<Position>
      rows={rows()}
      rowKey={(p) => p.id}
      empty="There are no open positions in your trading account yet"
      onRow={(p) => props.onSymbol(p.symbol)}
      columns={[
        { title: "Symbol", cell: (p) => <SymbolPill symbol={p.symbol} ticker={p.ticker} /> },
        { title: "Side", cell: (p) => <SideCell side={p.side} position /> },
        { title: "Quantity", num: true, cell: (p) => fmtQty(p.qty) },
        { title: "Avg price", num: true, cell: (p) => fmtPrice(p.avgPrice) },
        { title: "Last price", num: true, cell: (p) => fmtPrice(p.last) },
        { title: "Unrealized PnL", num: true, cell: (p) => <span class={pnlClass(p.unrealizedPnl)}>{fmtPnl(p.unrealizedPnl)}</span> },
        { title: "Unrealized PnL %", num: true, cell: (p) => <span class={pnlClass(pct(p))}>{fmtPct(pct(p))}</span> },
        { title: "Realized PnL", num: true, cell: (p) => <span class={pnlClass(p.realizedPnl)}>{fmtPnl(p.realizedPnl)}</span> },
        { title: "Daily PnL", num: true, cell: (p) => <span class={pnlClass(p.dailyPnl)}>{fmtPnl(p.dailyPnl)}</span> },
      ]}
      actions={(p) => (
        <Tooltip text="Close" side="top">
          <button type="button" class="trd-row-btn" aria-label="Close position" onClick={() => confirmClosePosition(p)}>
            <CloseIcon size={16} />
          </button>
        </Tooltip>
      )}
    />
  );
}

function OrdersTable(props: Props) {
  const all = () => broker.state().orders;
  const rows = () => all().filter((o) => matchesFilter(o, tradingUi.filter()));
  const price = (v: number | null) => (v != null ? fmtPrice(v) : "—");
  return (
    <Table<Order>
      rows={rows()}
      rowKey={(o) => o.id}
      empty="There is no trading data here yet"
      onRow={(o) => props.onSymbol(o.symbol)}
      muted={(o) => tradingUi.filter() === "all" && !isActiveOrder(o)}
      columns={[
        { title: "Symbol", cell: (o) => <SymbolPill symbol={o.symbol} ticker={o.ticker} /> },
        { title: "Side", cell: (o) => <SideCell side={o.side} /> },
        { title: "Type", cell: (o) => typeTitle(o, all()) },
        { title: "Quantity", num: true, cell: (o) => fmtQty(o.qty) },
        { title: "Avg fill price", num: true, cell: (o) => price(o.avgFillPrice) },
        { title: "Limit price", num: true, cell: (o) => price(o.limitPrice) },
        { title: "Stop price", num: true, cell: (o) => price(o.stopPrice) },
        { title: "Take profit", num: true, cell: (o) => price(legsOf(o, all()).tp?.limitPrice ?? null) },
        { title: "Stop loss", num: true, cell: (o) => price(legsOf(o, all()).sl?.stopPrice ?? null) },
        {
          title: "Status",
          cell: (o) => (
            <span class={`trd-status trd-status-${o.status}`} title={o.message ?? undefined}>
              {STATUS_TITLE[o.status]}
            </span>
          ),
        },
        { title: "Last update time", cell: (o) => fmtTime(o.updatedMs) },
        { title: "Instruction", cell: (o) => (o.outsideRth ? "Outside RTH" : "") },
        { title: "Duration", cell: (o) => (o.duration === "GTC" ? "Good Till Cancel" : o.duration === "DAY" ? "Day" : o.duration) },
        // Orders placed outside the API have no positive id: their permanent id.
        { title: "Order ID", num: true, cell: (o) => ((o.orderId ?? 0) > 0 ? String(o.orderId) : o.permId ? String(o.permId) : "—") },
      ]}
      actions={(o) => (
        <Show when={isActiveOrder(o) && o.modifiable}>
          <Tooltip text="Modify Order…" side="top">
            <button type="button" class="trd-row-btn" aria-label="Modify order" onClick={() => tradingUi.editOrder(o)}>
              <PencilIcon />
            </button>
          </Tooltip>
          <Tooltip text="Cancel" side="top">
            <button type="button" class="trd-row-btn" aria-label="Cancel order" onClick={() => confirmCancelOrder(o)}>
              <CloseIcon size={16} />
            </button>
          </Tooltip>
        </Show>
      )}
    />
  );
}

function HistoryTable(props: Props) {
  const rows = () => broker.state().executions.filter((e) => (e.qty ?? 0) > 0);
  return (
    <Table<Execution>
      rows={rows()}
      rowKey={(e) => e.id}
      empty="There is no trading data here yet"
      onRow={(e) => e.symbol && props.onSymbol(e.symbol)}
      columns={[
        { title: "Symbol", cell: (e) => <SymbolPill symbol={e.symbol} ticker={e.ticker} /> },
        { title: "Side", cell: (e) => <SideCell side={e.side} /> },
        { title: "Quantity", num: true, cell: (e) => fmtQty(e.qty) },
        { title: "Fill price", num: true, cell: (e) => fmtPrice(e.price) },
        { title: "Time", cell: (e) => fmtTime(e.timeMs) },
        { title: "Net amount", num: true, cell: (e) => fmtMoney((e.side === "buy" ? -1 : 1) * (e.qty ?? 0) * (e.price ?? 0) - (e.commission ?? 0)) },
        { title: "Commission", num: true, cell: (e) => fmtMoney(e.commission) },
      ]}
    />
  );
}

function BalancesTable() {
  const rows = createMemo(() => {
    const sum = broker.state().summary;
    if (!sum) return [];
    // The ledger's total cash per currency (older gateways: TotalCashBalance).
    const ledger = sum.values.some((v) => v.key === "$LEDGER-TotalCashBalance");
    const key = ledger ? "$LEDGER-TotalCashBalance" : "TotalCashBalance";
    return sum.values
      .filter((v) => v.key === key && v.currency && v.currency !== "BASE")
      .map((v) => ({ currency: v.currency === sum.currency ? `${v.currency} (base currency)` : v.currency, amount: Number(v.value) }));
  });
  return (
    <Table
      rows={rows()}
      rowKey={(r) => r.currency}
      empty="There is no trading data here yet"
      columns={[
        { title: "Currency", cell: (r) => r.currency },
        { title: "Amount", num: true, cell: (r) => fmtMoney(r.amount) },
      ]}
    />
  );
}

const SUMMARY_GROUPS: [string, [string, string][]][] = [
  ["Balances", [
    ["NetLiquidation", "Net liquidation"],
    ["EquityWithLoanValue", "Equity with loan (EWL)"],
    ["PreviousDayEquityWithLoanValue", "Previous day EWL"],
    ["RegTEquity", "Regulation T EWL"],
    ["SMA", "SMA"],
    ["BuyingPower", "Buying power"],
    ["TotalCashValue", "Cash"],
    ["GrossPositionValue", "Gross position value"],
    ["AccruedCash", "Accrued cash"],
  ]],
  ["Margin requirements", [
    ["InitMarginReq", "Initial margin"],
    ["MaintMarginReq", "Maintenance margin"],
    ["AvailableFunds", "Available funds"],
    ["ExcessLiquidity", "Excess liquidity"],
    ["Cushion", "Cushion"],
  ]],
  ["Overnight", [
    ["LookAheadInitMarginReq", "Initial margin"],
    ["LookAheadMaintMarginReq", "Maintenance margin"],
    ["LookAheadAvailableFunds", "Available funds"],
    ["LookAheadExcessLiquidity", "Excess liquidity"],
  ]],
  ["Trading limits", [
    ["DayTradesRemaining", "Day trades left"],
    ["Leverage-S", "Leverage"],
  ]],
];

function SummaryTables() {
  const value = (key: string): string => {
    const sum = broker.state().summary;
    if (!sum) return "—";
    const v = sum.values.find((x) => x.key === key && (x.currency === sum.currency || x.currency === "" || x.currency === "BASE"));
    if (!v) return "—";
    const n = Number(v.value);
    if (!Number.isFinite(n)) return v.value || "—";
    if (key === "DayTradesRemaining") return n < 0 ? "Unlimited" : String(n);
    if (key === "Cushion") return fmtPct(n * 100).replace("+", "");
    if (key === "Leverage-S") return n.toFixed(2);
    return fmtMoney(n);
  };
  const seg = (key: string, suffix: "S" | "C") => (key.endsWith("-S") ? "—" : value(`${key}-${suffix}`));
  // Per-segment columns only when the gateway reports segment values.
  const segments = () => {
    const sum = broker.state().summary;
    return !!sum && SUMMARY_GROUPS.some(([, keys]) => keys.some(([k]) => !k.endsWith("-S") && sum.values.some((v) => v.key === `${k}-S` || v.key === `${k}-C`)));
  };
  const rows = (keys: [string, string][]) => keys.filter(([k]) => value(k) !== "—");
  return (
    <div class="trd-summary-groups">
      <For each={SUMMARY_GROUPS.filter(([, keys]) => rows(keys).length > 0)}>
        {([title, keys]) => (
          <table class="trd-table trd-summary-table">
            <thead>
              <tr>
                <th>{title}</th>
                <Show when={segments()}>
                  <th class="is-num">US securities</th>
                  <th class="is-num">US commodities</th>
                </Show>
                <th class="is-num">Total</th>
              </tr>
            </thead>
            <tbody>
              <For each={rows(keys)}>
                {([key, label]) => (
                  <tr>
                    <td>{label}</td>
                    <Show when={segments()}>
                      <td class="is-num">{seg(key, "S")}</td>
                      <td class="is-num">{seg(key, "C")}</td>
                    </Show>
                    <td class="is-num">{value(key)}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        )}
      </For>
    </div>
  );
}

function NotificationsTable() {
  const rows = () => broker.state().notices;
  const title = (n: BrokerNotice) => (n.level === "error" ? "Error" : n.level === "warning" ? "Warning" : "Info");
  return (
    <Table<BrokerNotice>
      rows={rows()}
      rowKey={(n) => `${n.timeMs}:${n.code}:${n.message}`}
      empty="There is no trading data here yet"
      columns={[
        { title: "Time", cell: (n) => fmtTime(n.timeMs) },
        { title: "Title", cell: (n) => <span class={`trd-notice-${n.level}`}>{title(n)}{n.code > 0 ? ` ${n.code}` : ""}</span> },
        { title: "Text", cell: (n) => <span class="trd-notice-text">{n.message}{n.orderId != null && n.orderId > 0 ? ` (order ${n.orderId})` : ""}</span> },
      ]}
    />
  );
}
