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
  /** Order preset to apply when the ticket opens (chart Buy / Sell buttons
   *  with an active preset). */
  applyPreset?: string;
};

/** What the open order ticket offers the chart's project order line. */
export type TicketActions = {
  /** The draft as the order uses it (offsets, risk, exits resolved). */
  resolved: () => TicketDraft;
  /** Place the order (the ticket's main button). */
  submit: () => void;
  /** An order price dragged on the chart. */
  setPrice: (field: "limitPrice" | "stopPrice", price: number) => void;
  /** A take profit / stop loss dragged (null = off). */
  setExit: (kind: "tp" | "sl", price: number | null) => void;
  setType: (t: OrderType) => void;
  setQty: (qty: number) => void;
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
  /** Starred: a tag at the top of the order ticket. */
  favorite?: boolean;
};

/** Most order presets kept (reference app). */
export const MAX_PRESETS = 10;

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
  tab: "ot:order-ticket:tab",
  mode: "ot:order-ticket:mode",
  domPrices: "ot:order-ticket:dom-prices",
};

/** DOM panel settings (⋯ menu of the DOM tab). */
export type DomPrices = { zeroVolume: boolean; spread: boolean };

function readDomPrices(): DomPrices {
  try {
    const v = JSON.parse(kv.getItem(K.domPrices) ?? "null") as Partial<DomPrices> | null;
    return { zeroVolume: v?.zeroVolume !== false, spread: v?.spread !== false };
  } catch {
    return { zeroVolume: true, spread: true };
  }
}

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

const [prefs, setPrefs] = createRoot(() => createSignal<TicketPrefs>(readPrefs()));

/** Quantity the next order starts with (the ticket's last one): the chart's
 *  one-click Buy / Sell buttons use it (reactive). */
export function ticketQty(): number {
  const q = Number(prefs().qty);
  return Number.isFinite(q) && q > 0 ? q : 1;
}

/** The quantity of the next orders (chart Buy / Sell quantity calculator). */
export function setTicketQty(qty: number) {
  const next = { ...prefs(), qty: String(qty) };
  setPrefs(next);
  kv.setItem(K.ticketPrefs, JSON.stringify(next));
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

  /** The order preset of the chart Buy / Sell buttons (presets menu). */
  const [activePreset, setActivePreset] = createSignal<string | null>(null);
  /** The open ticket's actions (project order line). */
  const [ticketActions, setTicketActionsRaw] = createSignal<TicketActions | null>(null);

  // DOM tab: the Order / DOM switch, the price the pointer is on (a dashed
  // line on the chart) and the DOM panel settings.
  const [ticketTab, setTicketTabRaw] = createSignal<"order" | "dom">(kv.getItem(K.tab) === "dom" ? "dom" : "order");
  const [domHover, setDomHover] = createSignal<{ price: number; buy: boolean } | null>(null);
  const [domPrices, setDomPricesRaw] = createSignal<DomPrices>(readDomPrices());
  /** Docked at the right ("panel") or a floating dialog ("popup": "Undock
   *  order ticket"). */
  const [ticketMode, setTicketModeRaw] = createSignal<"panel" | "popup">(kv.getItem(K.mode) === "popup" ? "popup" : "panel");
  /** An order of the docked DOM tab in the floating dialog (one-click
   *  trading off). */
  const [orderDialog, setOrderDialog] = createSignal(false);
  /** Top-left of the floating ticket (null = centred). */
  const [floatPos, setFloatPos] = createSignal<{ x: number; y: number } | null>(null);

  const newDraft = (symbol: string, side: Side, price?: number, last?: number | null): TicketDraft => {
    const p = prefs();
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
      const next = { qty: d.qty, orderType: d.orderType };
      setPrefs(next);
      kv.setItem(K.ticketPrefs, JSON.stringify(next));
    },
    /** A new order's draft (the ticket's starting values). */
    newDraft,
    /** Open the ticket for a new order (`presetId`: applied once open). */
    openOrderTicket(opts: { symbol?: string; side?: Side; price?: number; last?: number | null; presetId?: string } = {}) {
      const symbol = opts.symbol || replayBroker.symbol() || activeSymbol();
      setDraft({ ...newDraft(symbol, opts.side ?? "buy", opts.price, opts.last), ...(opts.presetId ? { applyPreset: opts.presetId } : {}) });
      setSent(false);
      // An order to make (a side or a price given): the Order tab.
      if (opts.side || opts.price != null) {
        setTicketTabRaw("order");
        setOrderDialog(false);
      }
      setTicketOpen(true);
    },
    /** Open the ticket on a working order (chart order line). */
    editOrder(o: TradingOrder, paneId: number | null, keepTab = false) {
      if (!keepTab) {
        setTicketTabRaw("order");
        setOrderDialog(false);
      }
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
      setTicketTabRaw("order");
      setOrderDialog(false);
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
      setOrderDialog(false);
      setDomHover(null);
      setDraft(null);
      setSent(false);
    },

    presets,
    addPreset(p: Omit<OrderPreset, "id">) {
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      setPresets([...presets(), { ...p, id }]);
    },
    /** Star / unstar a preset (favourites: tags at the top of the ticket). */
    togglePresetFavorite(id: string) {
      setPresets(presets().map((p) => (p.id === id ? { ...p, favorite: p.favorite ? undefined : true } : p)));
    },
    removePreset(id: string) {
      setPresets(presets().filter((p) => p.id !== id));
      if (activePreset() === id) setActivePreset(null);
    },
    /** The preset of the chart Buy / Sell buttons (null = none). */
    activePreset: () => presets().find((p) => p.id === activePreset()) ?? null,
    setActivePreset,
    ticketActions,
    setTicketActions: (a: TicketActions | null) => setTicketActionsRaw(() => a),
    /** Order / DOM switch of the ticket. */
    ticketTab,
    setTicketTab(t: "order" | "dom") {
      setTicketTabRaw(t);
      kv.setItem(K.tab, t);
      if (t === "order" && orderDialog()) setOrderDialog(false);
      if (t === "dom" && !orderDialog() && draft()?.editing) setDraft(null);
    },
    ticketMode,
    /** "Undock order ticket" / "Dock to right". */
    setTicketMode(m: "panel" | "popup") {
      setTicketModeRaw(m);
      kv.setItem(K.mode, m);
      setOrderDialog(false);
      if (m === "popup" && !draft()) setDraft(newDraft(replayBroker.symbol() || activeSymbol(), "buy"));
    },
    orderDialog,
    /** An order from the DOM tab in the floating dialog: `patch` on a new
     *  draft (side, type, prices), or a working order to modify. */
    openOrderDialog(p: { side: Side; patch?: Partial<TicketDraft>; order?: TradingOrder; paneId?: number | null }) {
      const symbol = replayBroker.symbol() || activeSymbol();
      if (p.order) this.editOrder(p.order, p.paneId ?? null, true);
      else {
        setDraft({ ...newDraft(symbol, p.side), ...p.patch });
        setSent(false);
      }
      setOrderDialog(ticketMode() === "panel");
      setTicketOpen(true);
    },
    closeOrderDialog() {
      setOrderDialog(false);
      setDraft(null);
      setSent(false);
    },
    floatPos,
    setFloatPos,
    domHover,
    setDomHover,
    domPrices,
    setDomPrices(p: DomPrices) {
      setDomPricesRaw(p);
      kv.setItem(K.domPrices, JSON.stringify(p));
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
