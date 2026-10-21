/*
 * Trading UI state: the order ticket docked at the right of the charts (its
 * draft, width, last choices) and the Replay Trading panel / settings dialog
 * entry points, so the header Trade button, the chart menu, the hotkeys, the
 * chart trading lines and the end-of-session dialog reach the same state.
 */
import { createRoot, createSignal } from "solid-js";
import * as kv from "../kv";
import { replayBroker } from "./replay-broker";
import type { OrderType, Side, TradingOrder, TradingPosition } from "./types";

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
  /** Id of the order being modified, null for a new order. */
  editing: string | null;
  /** Chart of the order being modified. */
  paneId: number | null;
  // Field types (order ticket menus; absent = price / units):
  /** Limit / stop price typed as a price or as ticks from its base. */
  limitMode?: "price" | "offset";
  stopMode?: "price" | "offset";
  /** Offsets typed, in ticks ("" = at the base). */
  limitOffset?: string;
  stopOffset?: string;
  /** Quantity typed in units or as a risk (money / % balance). */
  qtyType?: "units" | "riskUsd" | "riskPct";
  qtyEquiv?: "units" | "riskUsd" | "riskPct";
  /** The risk typed (qtyType riskUsd / riskPct). */
  risk?: string;
  /** Exits typed as a price, ticks, % price, money or % balance. */
  tpType?: ExitFieldType;
  tpEquiv?: ExitFieldType;
  slType?: ExitFieldType;
  slEquiv?: ExitFieldType;
  /** The exit values typed when not a price. */
  tpValue?: string;
  slValue?: string;
};

export type ExitFieldType = "price" | "ticks" | "pricePct" | "cash" | "balancePct";

/** A saved order preset (order ticket presets menu): the order type, the
 *  price offsets in ticks (buy from the ask, sell from the bid; the limit of
 *  a stop limit from its stop) and the exits. */
export type OrderPreset = {
  id: string;
  title: string;
  orderType: OrderType;
  buyPrice?: number;
  sellPrice?: number;
  stopBuyLimitPrice?: number;
  stopSellLimitPrice?: number;
  tpPrice?: number;
  tpPriceType?: "ticks" | "pricePct" | "balancePct";
  slPrice?: number;
  slPriceType?: "ticks" | "pricePct" | "balancePct";
};

/** `TicketDraft.editing` while the ticket edits the position's brackets. */
export const POSITION_EDIT = "position";

/** Replay Trading panel views (icon tabs). */
export type ReplayReportView = "report" | "trades";

const K = {
  ticketWidth: "ot:order-ticket:width",
  ticketPrefs: "ot:order-ticket:prefs",
  reportView: "ot:replay-trading:view",
  presets: "ot:order-ticket:presets",
  slRisk: "ot:order-ticket:sl-enables-risk",
};

function readPresets(): OrderPreset[] {
  try {
    const v = JSON.parse(kv.getItem(K.presets) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((p): p is OrderPreset => !!p && typeof p.id === "string" && typeof p.title === "string" && typeof p.orderType === "string") : [];
  } catch {
    return [];
  }
}

type TicketPrefs = { qty: string; orderType: OrderType };

function readPrefs(): TicketPrefs {
  const d: TicketPrefs = { qty: "1", orderType: "market" };
  try {
    const v = JSON.parse(kv.getItem(K.ticketPrefs) ?? "null") as Partial<TicketPrefs> | null;
    return { ...d, ...(v ?? {}) };
  } catch {
    return d;
  }
}

/** Decimals of a price step (0.01 → 2). */
function decimalsOf(tick: number): number {
  const t = String(tick);
  if (t.includes("e-")) return Number(t.split("e-")[1]);
  return t.includes(".") ? t.split(".")[1].length : 0;
}

/** Quantity the next order starts with (the ticket's last one): the chart's
 *  one-click Buy / Sell buttons use it. */
export function ticketQty(): number {
  const q = Number(readPrefs().qty);
  return Number.isFinite(q) && q > 0 ? q : 1;
}

/** Ticket width bounds (px). */
export const TICKET_MIN = 300;
export const TICKET_MAX = 400;

export const tradingUi = createRoot(() => {
  const [ticketOpen, setTicketOpen] = createSignal(false);
  const savedWidth = Number(kv.getItem(K.ticketWidth));
  const [ticketWidth, setTicketWidthRaw] = createSignal(savedWidth >= TICKET_MIN && savedWidth <= TICKET_MAX ? savedWidth : TICKET_MIN);
  const [draft, setDraft] = createSignal<TicketDraft | null>(null);
  /** The ticket sent an order: its button reads "Start creating order"
   *  until the form is touched again. */
  const [sent, setSent] = createSignal(false);
  /** Symbol of the focused chart (the ticket's default symbol). */
  const [activeSymbol, setActiveSymbol] = createSignal("");

  // Replay Trading panel / settings dialog.
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  /** Bumped to bring the Replay Trading tab forward (open, selected). */
  const [reportRequest, setReportRequest] = createSignal(0);
  const savedView = kv.getItem(K.reportView);
  const [reportView, setReportViewRaw] = createSignal<ReplayReportView>(savedView === "trades" ? "trades" : "report");

  // Order presets and the ticket's ⋯ menu setting.
  const [presets, setPresetsRaw] = createSignal<OrderPreset[]>(readPresets());
  const setPresets = (list: OrderPreset[]) => {
    setPresetsRaw(list);
    kv.setItem(K.presets, JSON.stringify(list));
  };
  const [slEnablesRisk, setSlEnablesRiskRaw] = createSignal(kv.getItem(K.slRisk) === "true");

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
    // No chart price: limit and stop prices start at the market price.
    const q = replayBroker.quote();
    const mkt = q?.last != null ? q.last.toFixed(Math.max(2, decimalsOf(q.minTick))) : "";
    const base = px || mkt;
    return {
      symbol,
      side,
      orderType,
      qty: p.qty,
      limitPrice: orderType === "limit" || orderType === "stopLimit" ? base : "",
      stopPrice: orderType === "stop" || orderType === "stopLimit" ? base : "",
      tpOn: false,
      takeProfit: "",
      slOn: false,
      stopLoss: "",
      editing: null,
      paneId: null,
    };
  };

  return {
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
      setSent(false);
    },
    sent,
    setSent,
    /** Remember the ticket choices the next order starts from. */
    savePrefs(d: TicketDraft) {
      kv.setItem(K.ticketPrefs, JSON.stringify({ qty: d.qty, orderType: d.orderType }));
    },
    /** Open the ticket for a new order. */
    openOrderTicket(opts: { symbol?: string; side?: Side; price?: number; last?: number | null } = {}) {
      const symbol = opts.symbol || replayBroker.symbol() || activeSymbol();
      setDraft(newDraft(symbol, opts.side ?? "buy", opts.price, opts.last));
      setSent(false);
      setTicketOpen(true);
    },
    /** Open the ticket on a working order (chart order line). */
    editOrder(o: TradingOrder, paneId: number | null) {
      setDraft({
        symbol: o.symbol,
        side: o.side,
        orderType: o.type,
        qty: String(o.qty),
        limitPrice: o.limitPrice != null ? String(o.limitPrice) : "",
        stopPrice: o.stopPrice != null ? String(o.stopPrice) : "",
        tpOn: o.takeProfit != null,
        takeProfit: o.takeProfit != null ? String(o.takeProfit) : "",
        slOn: o.stopLoss != null,
        stopLoss: o.stopLoss != null ? String(o.stopLoss) : "",
        editing: o.id,
        paneId,
      });
      setSent(false);
      setTicketOpen(true);
    },
    /** Protect position: the ticket on the position's take profit / stop loss. */
    editPosition(pos: TradingPosition, paneId: number) {
      setDraft({
        symbol: pos.symbol,
        side: pos.side,
        orderType: "limit",
        qty: String(pos.qty),
        limitPrice: String(pos.avgPrice),
        stopPrice: "",
        tpOn: pos.takeProfit != null,
        takeProfit: pos.takeProfit != null ? String(pos.takeProfit) : "",
        slOn: pos.stopLoss != null,
        stopLoss: pos.stopLoss != null ? String(pos.stopLoss) : "",
        editing: POSITION_EDIT,
        paneId,
      });
      setSent(false);
      setTicketOpen(true);
    },
    toggleTicket() {
      if (ticketOpen()) this.closeTicket();
      else this.openOrderTicket();
    },
    closeTicket() {
      setTicketOpen(false);
      setDraft(null);
      setSent(false);
    },

    presets,
    addPreset(p: Omit<OrderPreset, "id">) {
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      setPresets([...presets(), { ...p, id }]);
    },
    removePreset(id: string) {
      setPresets(presets().filter((p) => p.id !== id));
    },
    /** "SL enables quantity in risk" (ticket ⋯ menu). */
    slEnablesRisk,
    setSlEnablesRisk(v: boolean) {
      setSlEnablesRiskRaw(v);
      kv.setItem(K.slRisk, v ? "true" : "false");
    },

    settingsOpen,
    openReplaySettings: () => setSettingsOpen(true),
    closeReplaySettings: () => setSettingsOpen(false),
    reportRequest,
    /** "Open full report": the Replay Trading tab, open. */
    showReplayReport(view?: ReplayReportView) {
      if (view) this.setReportView(view);
      setReportRequest((n) => n + 1);
    },
    reportView,
    setReportView(v: ReplayReportView) {
      setReportViewRaw(v);
      kv.setItem(K.reportView, v);
    },
  };
});
