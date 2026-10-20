/*
 * Trading UI state: the broker dialogs, the bottom trading panel (account
 * manager) and the order ticket docked at the right of the charts.
 *
 * Imperative entry points (openOrderTicket, openBrokerDialog) so the chart
 * menu, the hotkeys and the header button reach the same state. Panel sizes,
 * the selected tab and the ticket's last choices persist in kv.
 */
import { createRoot, createSignal } from "solid-js";
import type { Duration, Order, OrderType, Side } from "../bindings";
import { broker, BROKER_AVAILABLE } from "./broker-store";
import * as kv from "./kv";

export type PanelTab = "positions" | "orders" | "history" | "balances" | "summary" | "notifications";
export type OrdersFilter = "all" | "working" | "inactive" | "filled" | "cancelled" | "rejected";

/** What the order ticket edits. Prices are strings while typed. */
export type TicketDraft = {
  symbol: string;
  side: Side;
  orderType: OrderType;
  qty: string;
  limitPrice: string;
  stopPrice: string;
  tpOn: boolean;
  takeProfit: string;
  slOn: boolean;
  stopLoss: string;
  duration: Duration;
  outsideRth: boolean;
  /** Row id of the order being modified, null for a new order. */
  editing: string | null;
};

const K = {
  height: "ot:trading-panel:height",
  collapsed: "ot:trading-panel:collapsed",
  tab: "ot:trading-panel:tab",
  filter: "ot:trading-panel:orders-filter",
  ticketWidth: "ot:order-ticket:width",
  ticketPrefs: "ot:order-ticket:prefs",
};

const TABS: PanelTab[] = ["positions", "orders", "history", "balances", "summary", "notifications"];
const FILTERS: OrdersFilter[] = ["all", "working", "inactive", "filled", "cancelled", "rejected"];

type TicketPrefs = { qty: string; orderType: OrderType; duration: Duration; outsideRth: boolean };

function readPrefs(): TicketPrefs {
  const d: TicketPrefs = { qty: "1", orderType: "limit", duration: "day", outsideRth: false };
  try {
    const v = JSON.parse(kv.getItem(K.ticketPrefs) ?? "null") as Partial<TicketPrefs> | null;
    return { ...d, ...(v ?? {}) };
  } catch {
    return d;
  }
}

/** Ticket width bounds (px). */
export const TICKET_MIN = 315;
export const TICKET_MAX = 400;

export const tradingUi = createRoot(() => {
  const [dialog, setDialog] = createSignal<"select" | "login" | null>(null);
  const [height, setHeightRaw] = createSignal(Number(kv.getItem(K.height)) || 0);
  const [collapsed, setCollapsedRaw] = createSignal(kv.getItem(K.collapsed) === "1");
  const [maximized, setMaximized] = createSignal(false);
  const savedTab = kv.getItem(K.tab) as PanelTab | null;
  const [tab, setTabRaw] = createSignal<PanelTab>(savedTab && TABS.includes(savedTab) ? savedTab : "positions");
  const savedFilter = kv.getItem(K.filter) as OrdersFilter | null;
  const [filter, setFilterRaw] = createSignal<OrdersFilter>(savedFilter && FILTERS.includes(savedFilter) ? savedFilter : "all");
  const [ticketOpen, setTicketOpen] = createSignal(false);
  const savedWidth = Number(kv.getItem(K.ticketWidth));
  const [ticketWidth, setTicketWidthRaw] = createSignal(savedWidth >= TICKET_MIN && savedWidth <= TICKET_MAX ? savedWidth : TICKET_MIN);
  const [draft, setDraft] = createSignal<TicketDraft | null>(null);
  /** Symbol of the active chart (the ticket's default symbol). */
  const [activeSymbol, setActiveSymbol] = createSignal("");

  const newDraft = (symbol: string, side: Side, price?: number, last?: number | null): TicketDraft => {
    const p = readPrefs();
    let orderType = p.orderType;
    const px = price != null && Number.isFinite(price) ? String(price) : "";
    // A price from the chart: limit on the favourable side of the market,
    // stop beyond it.
    if (price != null && last != null) {
      const better = side === "buy" ? price <= last : price >= last;
      orderType = better ? "limit" : "stop";
    }
    return {
      symbol,
      side,
      orderType,
      qty: p.qty,
      limitPrice: orderType === "stop" ? "" : px,
      stopPrice: orderType === "stop" ? px : "",
      tpOn: false,
      takeProfit: "",
      slOn: false,
      stopLoss: "",
      duration: p.duration,
      outsideRth: p.outsideRth,
      editing: null,
    };
  };

  return {
    dialog,
    openBrokerDialog: () => setDialog("select"),
    openLogin: () => setDialog("login"),
    closeDialog: () => setDialog(null),

    height,
    setHeight(px: number, commit: boolean) {
      setHeightRaw(px);
      if (commit) kv.setItem(K.height, String(Math.round(px)));
    },
    collapsed,
    setCollapsed(v: boolean) {
      setCollapsedRaw(v);
      kv.setItem(K.collapsed, v ? "1" : "0");
      if (v) setMaximized(false);
    },
    maximized,
    setMaximized,
    tab,
    setTab(t: PanelTab) {
      setTabRaw(t);
      kv.setItem(K.tab, t);
    },
    filter,
    setFilter(f: OrdersFilter) {
      setFilterRaw(f);
      kv.setItem(K.filter, f);
    },

    activeSymbol,
    setActiveSymbol,

    ticketOpen,
    ticketWidth,
    setTicketWidth(px: number, commit: boolean) {
      const w = Math.min(TICKET_MAX, Math.max(TICKET_MIN, px));
      setTicketWidthRaw(w);
      if (commit) kv.setItem(K.ticketWidth, String(Math.round(w)));
    },
    draft,
    setDraft,
    patchDraft(patch: Partial<TicketDraft>) {
      const d = draft();
      if (d) setDraft({ ...d, ...patch });
    },
    /** Remember the ticket choices the next order starts from. */
    savePrefs(d: TicketDraft) {
      kv.setItem(K.ticketPrefs, JSON.stringify({ qty: d.qty, orderType: d.orderType, duration: d.duration, outsideRth: d.outsideRth }));
    },
    /** Open the ticket for a new order (no broker: the broker dialog). */
    openOrderTicket(opts: { symbol?: string; side?: Side; price?: number; last?: number | null } = {}) {
      if (!BROKER_AVAILABLE) return;
      if (!broker.connected()) {
        setDialog("select");
        return;
      }
      const symbol = opts.symbol || activeSymbol();
      if (!symbol) return;
      setDraft(newDraft(symbol, opts.side ?? "buy", opts.price, opts.last));
      setTicketOpen(true);
    },
    /** Open the ticket on a working order. */
    editOrder(o: Order) {
      setDraft({
        symbol: o.symbol,
        side: o.side,
        orderType: o.orderType,
        qty: String(o.qty),
        limitPrice: o.limitPrice != null ? String(o.limitPrice) : "",
        stopPrice: o.stopPrice != null ? String(o.stopPrice) : "",
        tpOn: false,
        takeProfit: "",
        slOn: false,
        stopLoss: "",
        duration: o.duration === "GTC" ? "gtc" : "day",
        outsideRth: o.outsideRth,
        editing: o.id,
      });
      setTicketOpen(true);
    },
    closeTicket() {
      setTicketOpen(false);
      setDraft(null);
    },
  };
});
