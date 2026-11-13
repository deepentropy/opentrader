/*
 * Plugin broker (#315): the account of the broker plugin the user connected (src-tauri/src/plugins/broker.rs), read
 * the way the order ticket, the chart trading lines, the DOM and the toasts read the replay broker.
 *
 * The plugin speaks its broker's tickers; each chart's symbol is mapped to one (`broker_resolve_symbol`), and a
 * chart shows the position and orders of its ticker. In a hedging account several positions of a ticker show as
 * one net position on the chart; the account manager lists them all. Commands go to the plugin and answer later: a
 * refusal comes back as a rejected-order toast.
 */
import { createEffect, createRoot, createSignal } from "solid-js";
import { commands, events, type BrokerState, type BrokerStatus, type Execution, type Order, type OrderTicket, type Position as WirePosition } from "../../bindings";
import type { Finite } from "../datafeed-rest";
import { getTickerInfo } from "../datafeed";
import { onTradeTick } from "../datafeed-live";
import { cachedSymbolSessions } from "../session";
import { strategyTester } from "../strategy-tester-store";
import { translate } from "../../i18n/translator";
import { capabilitiesOf, type TradingCapabilities } from "./capabilities";
import type { Tradability } from "./replay-broker";
import { ORDER_LABEL, type OrderRequest, type Side, type TradingEvent, type TradingExecution, type TradingOrder, type TradingPosition, type TradingQuote } from "./types";

const POSITION_ID = "position";

// The plugin's numbers come as JSON numbers: never null (see `Finite`).
type Position = Finite<WirePosition, "qty" | "avgPrice">;
type Fill = Finite<Execution, "qty" | "price" | "timeMs">;
type Working = Finite<Order, "qty" | "filledQty">;
export type { Position as BrokerPosition, Working as BrokerOrder, Fill as BrokerFill };
type State = Omit<BrokerState, "positions" | "orders" | "executions"> & { positions: Position[]; orders: Working[]; executions: Fill[] };
const HAS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const exitSide = (s: Side): Side => (s === "buy" ? "sell" : "buy");

export const pluginBroker = createRoot(() => {
  const [status, setStatus] = createSignal<BrokerStatus | null>(null);
  const [version, setVersion] = createSignal(0);
  const bump = () => setVersion((v) => v + 1);
  const listeners = new Set<(e: TradingEvent) => void>();
  /** Chart → its symbol (registered by each chart's trading lines). */
  const charts = new Map<number, () => string | undefined>();
  /** Chart symbol → the broker's ticker (null: not traded there); "pending" while asked. */
  const tickers = new Map<string, string | null | "pending">();
  const bidAsk = new Map<string, { bid: number | null; ask: number | null; last: number | null }>();
  const lastPrice = new Map<string, number>();
  const metas = new Map<string, { description: string; iconUrl: string | null; stock: boolean } | "loading">();

  const take = (s: BrokerStatus) => {
    const prev = status();
    if (prev && s.version < prev.version) return;
    // Another broker, or the same reconnected: its tickers are asked again, and the previous broker's bid / ask
    // (keyed by its own tickers, often the same names) must not show as the new one's.
    if (!prev || prev.active !== s.active || prev.pluginConnected !== s.pluginConnected) {
      tickers.clear();
      bidAsk.clear();
    }
    setStatus(s);
    bump();
  };
  if (HAS_TAURI) {
    void events.brokerStatus.listen((e) => take(e.payload));
    void commands.brokerStatus().then(take);
    void events.brokerOrderEvent.listen((e) => {
      const ev = e.payload.event;
      emit({
        kind: ev.kind as TradingEvent["kind"],
        label: ORDER_LABEL[ev.type],
        symbol: chartSymbolOf(ev.ticker),
        side: ev.side,
        qty: ev.qty ?? 0,
        price: ev.price ?? null,
        message: ev.message ?? undefined,
      });
    });
    void events.brokerQuote.listen((e) => {
      const q = e.payload;
      bidAsk.set(q.ticker, { bid: q.bid ?? null, ask: q.ask ?? null, last: q.last ?? null });
      bump();
    });
    void onTradeTick((t) => {
      lastPrice.set(t.symbol.toUpperCase(), t.price);
      if (t.symbol.toUpperCase() === (activeSymbol() ?? "").toUpperCase()) bump();
    });
  }

  /** Asks before an order goes to a live account (window/trading/confirm.tsx sets it). */
  let confirmLive: ((text: string, send: () => void) => void) | null = null;
  const isLive = () => account()?.account?.isDemo === false;
  /** Send at once on a demo account; on a live one, after the user confirmed. */
  const guarded = (text: string, send: () => void) => (isLive() && confirmLive ? confirmLive(text, send) : send());
  const summary = (req: OrderRequest, symbol: string) => {
    const price = req.type === "market" ? "" : ` @ ${req.limitPrice ?? req.stopPrice ?? ""}`;
    return `${req.side === "buy" ? translate("Buy") : translate("Sell")} ${ORDER_LABEL[req.type]} ${req.qty} ${symbol}${price}`;
  };

  const emit = (e: TradingEvent) => {
    for (const fn of listeners) fn(e);
  };

  const connected = () => {
    const s = status();
    return !!s && !!s.active && s.pluginConnected && !!s.state?.connected;
  };
  const account = () => (status()?.state ?? null) as State | null;

  /** The focused chart. */
  const activePane = (): number | null => {
    version();
    const id = Number(strategyTester.activeChartId());
    return Number.isFinite(id) && charts.has(id) ? id : null;
  };
  const symbolOf = (paneId: number | null): string | null => (paneId === null ? null : charts.get(paneId)?.() ?? null);
  const activeSymbol = () => symbolOf(activePane());

  /** The broker's ticker of a chart symbol: null when not traded, undefined while asked. */
  const tickerOf = (symbol: string | null): string | null | undefined => {
    version();
    if (!symbol || !connected()) return null;
    const key = symbol.toUpperCase();
    const known = tickers.get(key);
    if (known === "pending") return undefined;
    if (known !== undefined) return known;
    tickers.set(key, "pending");
    void commands.brokerResolveSymbol(symbol).then((r) => {
      tickers.set(key, r.status === "ok" ? r.data : null);
      bump();
    });
    return undefined;
  };
  /** The chart symbol of a broker ticker: a chart showing it, else the ticker. */
  const chartSymbolOf = (ticker: string): string => {
    for (const [key, t] of tickers) if (t === ticker) return key;
    return ticker;
  };

  const meta = (symbol: string) => {
    const m = metas.get(symbol);
    if (m && m !== "loading") return m;
    if (!m) {
      metas.set(symbol, "loading");
      void getTickerInfo(symbol)
        .then((i) => metas.set(symbol, { description: i.name ?? symbol, iconUrl: i.iconUrl ?? null, stock: i.symbolType === "stock" }))
        .catch(() => metas.set(symbol, { description: symbol, iconUrl: null, stock: false }))
        .finally(bump);
    }
    return null;
  };

  const tradabilityOf = (paneId: number | null): Tradability => {
    version();
    const s = status();
    if (!s?.active) return { ok: false, reason: "launch", title: translate("Connect a broker"), text: translate("Connect a broker plugin from the Trade menu to trade.") };
    if (!s.pluginConnected || !s.state?.connected)
      return { ok: false, reason: "launch", title: translate("Broker not connected"), text: translate("The broker plugin is not connected. Check it in Settings > Plugins.") };
    const sym = symbolOf(paneId);
    if (!sym) return { ok: false, reason: "launch", title: "", text: translate("Select a chart to trade its symbol.") };
    const t = tickerOf(sym);
    if (t === undefined) return { ok: false, reason: "loading", title: "", text: "" };
    if (t === null) return { ok: false, reason: "symbol", title: "", text: translate("This broker does not trade the chart's symbol. Map it in Settings > Plugins.") };
    if (!s.tradingEnabled) return { ok: false, reason: "symbol", title: translate("Trading is off"), text: translate("Turn trading on in the Trade menu to place orders.") };
    return { ok: true, reason: "ok", title: "", text: "" };
  };

  const positionsOf = (paneId: number): Position[] => {
    const t = tickerOf(symbolOf(paneId));
    return t ? (account()?.positions ?? []).filter((p) => p.ticker === t) : [];
  };

  /** The chart's position: the account's position on its ticker, netted in a hedging account. */
  const position = (paneId: number): TradingPosition | null => {
    version();
    const list = positionsOf(paneId);
    if (!list.length) return null;
    const symbol = symbolOf(paneId) ?? list[0].ticker;
    if (list.length === 1) {
      const p = list[0];
      return { id: p.id, symbol, side: p.side, qty: p.qty, avgPrice: p.avgPrice, pl: p.unrealizedPnl ?? 0, takeProfit: p.takeProfit ?? null, stopLoss: p.stopLoss ?? null };
    }
    const signed = list.reduce((a, p) => a + (p.side === "buy" ? p.qty : -p.qty), 0);
    if (signed === 0) return null;
    const same = list.filter((p) => (p.side === "buy") === signed > 0);
    const qty = same.reduce((a, p) => a + p.qty, 0);
    const avg = same.reduce((a, p) => a + p.avgPrice * p.qty, 0) / qty;
    const pl = list.reduce((a, p) => a + (p.unrealizedPnl ?? 0), 0);
    return { id: `net:${list[0].ticker}`, symbol, side: signed > 0 ? "buy" : "sell", qty: Math.abs(signed), avgPrice: avg, pl, takeProfit: null, stopLoss: null };
  };

  const toOrder = (o: Working, symbol: string): TradingOrder => ({
    id: o.id,
    symbol,
    side: o.side,
    type: o.type,
    qty: Math.max(0, o.qty - (o.filledQty ?? 0)),
    limitPrice: o.limitPrice ?? null,
    stopPrice: o.stopPrice ?? null,
    kind: "order",
    parentId: null,
    takeProfit: o.takeProfit ?? null,
    stopLoss: o.stopLoss ?? null,
  });
  const bracket = (id: string, symbol: string, side: Side, qty: number, kind: "tp" | "sl", price: number, parentId: string): TradingOrder => ({
    id,
    symbol,
    side,
    type: kind === "tp" ? "limit" : "stop",
    qty,
    limitPrice: kind === "tp" ? price : null,
    stopPrice: kind === "sl" ? price : null,
    kind,
    parentId,
    takeProfit: null,
    stopLoss: null,
  });

  /** The chart's working orders with their brackets, then the position's brackets (as the replay broker lists them). */
  const orders = (paneId: number): TradingOrder[] => {
    version();
    const t = tickerOf(symbolOf(paneId));
    if (!t) return [];
    const symbol = symbolOf(paneId) ?? t;
    const out: TradingOrder[] = [];
    for (const o of account()?.orders ?? []) {
      if (o.ticker !== t || !["working", "placing", "inactive"].includes(o.status ?? "working")) continue;
      const w = toOrder(o, symbol);
      out.push(w);
      if (w.takeProfit !== null) out.push(bracket(`${w.id}:tp`, symbol, exitSide(w.side), w.qty, "tp", w.takeProfit, w.id));
      if (w.stopLoss !== null) out.push(bracket(`${w.id}:sl`, symbol, exitSide(w.side), w.qty, "sl", w.stopLoss, w.id));
    }
    const p = position(paneId);
    if (p && !p.id.startsWith("net:")) {
      if (p.takeProfit !== null) out.push(bracket(`${POSITION_ID}:tp`, symbol, exitSide(p.side), p.qty, "tp", p.takeProfit, POSITION_ID));
      if (p.stopLoss !== null) out.push(bracket(`${POSITION_ID}:sl`, symbol, exitSide(p.side), p.qty, "sl", p.stopLoss, POSITION_ID));
    }
    return out;
  };

  const executions = (paneId: number): TradingExecution[] => {
    version();
    const t = tickerOf(symbolOf(paneId));
    if (!t) return [];
    const symbol = symbolOf(paneId) ?? t;
    return (account()?.executions ?? [])
      .filter((x) => x.ticker === t)
      .map((x) => ({ id: x.id, symbol, side: x.side, qty: x.qty, price: x.price, time: Math.floor(x.timeMs / 1000) }));
  };

  /** A command's refusal, as the toast of a rejected order. */
  const refused = (req: { symbol: string; side: Side; type: OrderRequest["type"]; qty: number; price?: number | null }, message: string) =>
    emit({ kind: "rejected", label: ORDER_LABEL[req.type], symbol: req.symbol, side: req.side, qty: req.qty, price: req.price ?? null, message });

  const ticketOf = (req: OrderRequest, ticker: string): OrderTicket => ({
    ticker,
    side: req.side,
    type: req.type,
    qty: req.qty,
    limitPrice: req.limitPrice,
    stopPrice: req.stopPrice,
    takeProfit: req.takeProfit,
    stopLoss: req.stopLoss,
  });

  const ready = (paneId: number | null): { ticker: string; symbol: string } | null => {
    if (!tradabilityOf(paneId).ok) return null;
    const symbol = symbolOf(paneId)!;
    return { ticker: tickerOf(symbol)!, symbol };
  };

  const report = (p: Promise<{ status: "ok" } | { status: "error"; error: string }>, req: Parameters<typeof refused>[0]) =>
    void p.then((r) => {
      if (r.status === "error") refused(req, r.error);
    });

  const findOrder = (id: string) => account()?.orders.find((o) => o.id === id) ?? null;

  // The bid / ask of the focused chart's ticker (`broker.quote`), asked again when it changes.
  let watched = "";
  createEffect(() => {
    const t = connected() ? tickerOf(activeSymbol()) : null;
    // A plugin that connected again is asked again.
    const next = `${status()?.active}|${status()?.pluginConnected}|${t ?? ""}`;
    if (next === watched) return;
    watched = next;
    if (HAS_TAURI && status()?.pluginConnected) void commands.brokerWatchQuotes(t ? [t] : []);
  });

  const api = {
    version,
    status,
    /** The connected broker's account state (positions, orders, executions). */
    account,
    connected,
    /** The window may trade on this chart through the plugin broker (connected, its symbol traded). */
    trades: (paneId: number): boolean => {
      version();
      return connected() && !!tickerOf(symbolOf(paneId));
    },
    /** A chart and its symbol (the trading lines of each chart register it). */
    registerChart(paneId: number, symbol: () => string | undefined): () => void {
      charts.set(paneId, symbol);
      bump();
      return () => {
        charts.delete(paneId);
        bump();
      };
    },

    activePane,
    tradability: () => tradabilityOf(activePane()),
    /** What the broker supports (`broker.state.capabilities`). */
    capabilities: (): TradingCapabilities => {
      version();
      return capabilitiesOf(account()?.capabilities);
    },
    symbol: activeSymbol,
    description: (symbol: string) => {
      version();
      return meta(symbol)?.description ?? symbol;
    },
    iconUrl: (symbol: string) => {
      version();
      return meta(symbol)?.iconUrl ?? null;
    },
    isStock: (symbol: string) => {
      version();
      return meta(symbol)?.stock ?? false;
    },
    quote: (): TradingQuote | null => {
      version();
      const sym = activeSymbol();
      if (!sym) return null;
      const t = tickerOf(sym);
      const q = t ? bidAsk.get(t) : undefined;
      const last = q?.last ?? lastPrice.get(sym.toUpperCase()) ?? q?.bid ?? null;
      if (last === null && !q) return null;
      return { symbol: sym, bid: q?.bid ?? last, ask: q?.ask ?? last, last: last ?? q?.bid ?? q?.ask ?? null, minTick: cachedSymbolSessions(sym)?.mintick ?? 0.01 };
    },
    currency: (_paneId?: number | null): string => {
      version();
      return account()?.account?.currency || "USD";
    },
    balance: (): number => {
      version();
      const a = account()?.account;
      return a?.balance ?? a?.equity ?? 0;
    },
    position,
    orders,
    executions,

    place(req: OrderRequest): string | null {
      const r = ready(activePane());
      if (!r) return null;
      guarded(summary(req, r.symbol), () => report(commands.brokerPlace(ticketOf(req, r.ticker)), { ...req, symbol: r.symbol, price: req.limitPrice ?? req.stopPrice }));
      return "sent";
    },
    modify(id: string, req: OrderRequest, paneId = activePane() ?? undefined): string | null {
      const r = ready(paneId ?? null);
      if (!r) return null;
      guarded(summary(req, r.symbol), () => report(commands.brokerModify(id, ticketOf(req, r.ticker)), { ...req, symbol: r.symbol, price: req.limitPrice ?? req.stopPrice }));
      return "sent";
    },
    cancel(id: string, paneId = activePane() ?? undefined): string | null {
      const pane = paneId ?? null;
      const symbol = symbolOf(pane) ?? "";
      // A bracket line: its order's or the position's take profit / stop loss goes.
      const [base, leg] = id.split(":");
      if (leg === "tp" || leg === "sl") {
        if (base === POSITION_ID) {
          const p = pane !== null ? position(pane) : null;
          if (p) api.setPositionBrackets(leg === "tp" ? null : p.takeProfit, leg === "sl" ? null : p.stopLoss, paneId);
          return "sent";
        }
        const o = findOrder(base);
        if (o && pane !== null) {
          const w = toOrder(o, symbol);
          api.modify(o.id, { symbol, side: w.side, type: w.type, qty: w.qty, limitPrice: w.limitPrice, stopPrice: w.stopPrice, takeProfit: leg === "tp" ? null : w.takeProfit, stopLoss: leg === "sl" ? null : w.stopLoss }, paneId);
        }
        return "sent";
      }
      const o = findOrder(id);
      report(commands.brokerCancel(id), { symbol, side: o?.side ?? "buy", type: o?.type ?? "limit", qty: o?.qty ?? 0 });
      return "sent";
    },
    /** Close the chart's position (`qty` null: all of it; every position of the ticker in a hedging account). */
    closePosition(qty: number | null = null, paneId = activePane() ?? undefined): string | null {
      if (paneId === undefined) return null;
      const list = positionsOf(paneId);
      const symbol = symbolOf(paneId) ?? "";
      for (const p of list) {
        report(commands.brokerClosePosition(p.id, list.length === 1 ? qty : null), { symbol, side: exitSide(p.side), type: "market", qty: p.qty });
      }
      return list.length ? "sent" : null;
    },
    /** Close and open the other way: a market order of twice the position. */
    reverse(paneId = activePane() ?? undefined): string | null {
      if (paneId === undefined) return null;
      const p = position(paneId);
      const r = ready(paneId);
      if (!p || !r) return null;
      const req: OrderRequest = { symbol: r.symbol, side: exitSide(p.side), type: "market", qty: p.qty * 2, limitPrice: null, stopPrice: null, takeProfit: null, stopLoss: null };
      guarded(summary(req, r.symbol), () => report(commands.brokerPlace(ticketOf(req, r.ticker)), { ...req, price: null }));
      return "sent";
    },
    setPositionBrackets(tp: number | null, sl: number | null, paneId = activePane() ?? undefined): string | null {
      if (paneId === undefined) return null;
      const list = positionsOf(paneId);
      if (list.length !== 1) return null;
      const p = list[0];
      report(commands.brokerSetPositionBrackets(p.id, tp, sl), { symbol: symbolOf(paneId) ?? p.ticker, side: exitSide(p.side), type: tp !== null ? "limit" : "stop", qty: p.qty, price: tp ?? sl });
      return "sent";
    },
    onEvent(fn: (e: TradingEvent) => void): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setLiveConfirm(fn: (text: string, send: () => void) => void) {
      confirmLive = fn;
    },

    // ── Account manager ─────────────────────────────────────────────────
    /** The chart symbol of a broker ticker: the plugin's own symbol, or a chart's that trades it. */
    chartSymbolFor(ticker: string): string | null {
      const st = status();
      if (st?.dataExchange) return `${st.dataExchange}:${ticker}`;
      // A plugin serving several exchanges names its own symbols whole ("NSE:RELIANCE").
      const ex = ticker.split(":")[0].toUpperCase();
      if (ticker.includes(":") && st?.dataExchanges.includes(ex)) return ticker;
      const s = chartSymbolOf(ticker);
      return s.includes(":") ? s : null;
    },
    cancelOrder(id: string) {
      const o = findOrder(id);
      report(commands.brokerCancel(id), { symbol: o ? chartSymbolOf(o.ticker) : "", side: o?.side ?? "buy", type: o?.type ?? "limit", qty: o?.qty ?? 0 });
    },
    /** Close a position of the account manager (`qty` null: all of it). */
    closePositionById(id: string, qty: number | null = null) {
      const p = account()?.positions.find((x) => x.id === id);
      report(commands.brokerClosePosition(id, qty), { symbol: p ? chartSymbolOf(p.ticker) : "", side: p ? exitSide(p.side) : "sell", type: "market", qty: qty ?? p?.qty ?? 0 });
    },
    /** The chart that can protect or reverse a position: one that shows its ticker, where it is the only position. */
    positionPane(p: Position): { position: TradingPosition; paneId: number } | null {
      version();
      for (const [paneId, sym] of charts) {
        const s = sym();
        if (!s || tickerOf(s) !== p.ticker || positionsOf(paneId).length !== 1) continue;
        const pos = position(paneId);
        if (pos) return { position: pos, paneId };
      }
      return null;
    },
    /** An order the ticket can modify: a chart shows its ticker. */
    editable(o: Working): { order: TradingOrder; paneId: number } | null {
      version();
      for (const [paneId, sym] of charts) {
        const s = sym();
        if (s && tickerOf(s) === o.ticker) return { order: toOrder(o, s), paneId };
      }
      return null;
    },

    // ── Connection (Trade menu) ──────────────────────────────────────────
    setActive: (id: string | null) => commands.brokerSetActive(id).then((r) => (r.status === "ok" ? take(r.data) : undefined)),
    setTradingEnabled: (on: boolean) => commands.brokerSetTradingEnabled(on).then((r) => (r.status === "ok" ? take(r.data) : undefined)),
    selectAccount: (account: string) => void commands.brokerSelectAccount(account),
  };
  return api;
});

export type PluginBroker = typeof pluginBroker;
