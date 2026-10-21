/*
 * DOM tab of the order ticket (reference app 3.4.1): a price ladder around
 * the market, one 20 px row per tick: Bid size | price | Ask size, the
 * working orders in the outer columns, then the controls (cancel all buy /
 * sell orders with their counters, the bid / ask totals around the dynamic
 * mode switch), the position and its P&L, Flatten / CXL All / Reverse and
 * Buy Mkt / quantity / Sell Mkt.
 *
 * A click on a size cell places a limit order at the row's price (a stop
 * with Ctrl / Cmd; the hover label shows which), right click lists stop /
 * limit / stop-limit / market. The order marks: qty click edits the order,
 * dragged it moves, x cancels. The price column drags to scroll, double
 * click centres; the wheel scrolls a row per 100 px. Off-centre, the ladder
 * re-centres on the market after 2 s (the pie on the switch); dynamic mode
 * keeps it centred. Hovering a size cell draws the price on the chart.
 */
import { For, Index, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, type JSX } from "solid-js";
import { Tooltip } from "../../components/Tooltip";
import { replayBroker } from "../../data/trading/replay-broker";
import { tradingPrefs } from "../../data/trading/trading-prefs";
import { setTicketQty, ticketQty, tradingUi } from "../../data/trading/trading-ui";
import type { OrderType, Side, TradingOrder } from "../../data/trading/types";
import { Popover, PopItem } from "../screener/Popover";
import { confirmCancelOrder, confirmClosePosition } from "./confirm";
import { fmtPrice, fmtQty, tickDecimals, tickerOf } from "./format";
import { moveOrder } from "./order-actions";
import {
  DOM_CENTER_DELAY,
  DOM_ROW_H,
  centeredTop,
  clickOrderType,
  contextItems,
  countText,
  indexPrice,
  labelActive,
  needsCenter,
  orderMarks,
  priceIndex,
  priceSide,
  sideCounts,
  wheelRows,
  type DomMarket,
  type DomOrderMark,
} from "./dom-ladder";

const CrossIcon = () => (
  <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true">
    <path stroke="currentColor" stroke-width="1.2" d="M1 1l7 7m0-7L1 8" />
  </svg>
);
const MarkCloseIcon = () => (
  <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true">
    <path fill="currentColor" d="M1.7 1 1 1.7l2.8 2.8L1 7.3l.7.7 2.8-2.8L7.3 8l.7-.7-2.8-2.8L8 1.7 7.3 1 4.5 3.8z" />
  </svg>
);
const LockIcon = (p: { open: boolean }) => (
  <svg width="16" height="17" viewBox="0 0 16 17" fill="none" stroke="currentColor" aria-hidden="true">
    <rect x=".5" y="7.5" width="15" height="9" rx="2.5" />
    <circle cx="8" cy="12" r=".5" />
    <path d={p.open ? "M3.5 7.5V5a4.5 4.5 0 0 1 8.9-1" : "M3.5 7.5V5a4.5 4.5 0 1 1 9 0v2.5"} />
  </svg>
);
const ArrowIcon = (p: { up: boolean }) => (
  <svg width="12" height="7" viewBox="0 0 12 7" aria-hidden="true">
    <path fill="currentColor" d={p.up ? "M0 6.2 6 .2l6 6-.8.8L6 1.8.8 7z" : "M0 .8 6 6.8l6-6-.8-.8L6 5.2.8 0z"} />
  </svg>
);

/** Pie of the auto-centre countdown (0..1), in a -1..1 box. */
function piePath(t: number): string {
  if (t <= 0) return "M 0 0";
  let d = t >= 1 ? "M 0 -1" : "M 0 0L 0 -1";
  if (t > 0.5) d += "A 1 1 0 0 1 0 1";
  return `${d}A 1 1 0 0 1 ${Math.sin(2 * t * Math.PI)} ${-Math.cos(2 * t * Math.PI)}Z`;
}

export function DomPanel() {
  const pane = () => replayBroker.activePane();
  const q = replayBroker.quote;
  const tick = () => q()?.minTick ?? 0.01;
  const dec = () => Math.max(2, tickDecimals(tick()) ?? 2);
  const ix = (p: number | null | undefined) => (p == null || !Number.isFinite(p) ? NaN : priceIndex(p, tick()));
  const market = createMemo<DomMarket>(() => ({ bid: ix(q()?.bid), ask: ix(q()?.ask), last: ix(q()?.last) }), { bid: NaN, ask: NaN, last: NaN }, {
    equals: (a, b) => Object.is(a.bid, b.bid) && Object.is(a.ask, b.ask) && Object.is(a.last, b.last),
  });
  const orders = (): TradingOrder[] => {
    const id = pane();
    return id === null ? [] : replayBroker.orders(id);
  };
  const position = () => {
    const id = pane();
    return id === null ? null : replayBroker.position(id);
  };
  const marks = createMemo(() => orderMarks(orders(), tick()));
  const posIndex = () => {
    const p = position();
    return p ? ix(p.avgPrice) : NaN;
  };
  const ticker = () => tickerOf(replayBroker.symbol() ?? "");

  // ── Geometry: rows that fit, the top row's index ─────────────────────
  const [height, setHeight] = createSignal(0);
  const [top, setTop] = createSignal(NaN);
  let main!: HTMLDivElement;
  onMount(() => {
    const ro = new ResizeObserver(() => setHeight(Math.ceil(main.clientHeight / DOM_ROW_H)));
    ro.observe(main);
    onCleanup(() => ro.disconnect());
  });
  const center = () => {
    const t = centeredTop(market(), height());
    if (Number.isFinite(t)) setTop(t);
  };
  const rows = createMemo(() => Array.from({ length: height() }, (_, k) => k));

  // ── Auto-centre (2 s countdown) and dynamic mode ─────────────────────
  const [dynamic, setDynamic] = createSignal(false);
  const [progress, setProgress] = createSignal(0);
  const [held, setHeld] = createSignal(false); // scrolling / dragging
  let timer: number | undefined;
  let raf = 0;
  let due = 0;
  const abort = () => {
    clearTimeout(timer);
    cancelAnimationFrame(raf);
    timer = undefined;
    setProgress(0);
  };
  const run = () => {
    if (timer !== undefined) return;
    due = Date.now() + DOM_CENTER_DELAY;
    timer = window.setTimeout(() => {
      abort();
      center();
    }, DOM_CENTER_DELAY);
    const step = () => {
      if (timer === undefined) return;
      setProgress(Math.min(1, Math.max(0, 1 - (due - Date.now()) / DOM_CENTER_DELAY)));
      raf = requestAnimationFrame(step);
    };
    step();
  };
  onCleanup(abort);
  createEffect(() => {
    const h = height();
    if (!h) return;
    if (!Number.isFinite(top())) center();
  });
  createEffect(
    on(market, () => {
      if (dynamic()) center();
    }),
  );
  createEffect(() => {
    const required = height() > 0 && needsCenter(top(), height(), market());
    if (required && !held() && !dynamic()) run();
    else abort();
  });
  const scrollBy = (n: number) => {
    if (dynamic() || !n) return;
    setTop((t) => t + n);
    if (timer !== undefined) {
      abort();
      run();
    }
  };

  // ── Ctrl / Cmd: stop orders ──────────────────────────────────────────
  const [stopMode, setStopMode] = createSignal(false);
  const onKey = (e: KeyboardEvent) => setStopMode(e.ctrlKey || e.metaKey);
  document.addEventListener("keydown", onKey);
  document.addEventListener("keyup", onKey);
  onCleanup(() => {
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("keyup", onKey);
    tradingUi.setDomHover(null);
  });

  // ── Orders ───────────────────────────────────────────────────────────
  /** Place an order: at once with one-click trading, else in the order
   *  dialog, filled in (reference app). */
  const place = (side: Side, type: OrderType, price: number | null, limit: number | null = null) => {
    const sym = replayBroker.symbol();
    if (!sym || !replayBroker.tradability().ok) return;
    if (!tradingPrefs.prefs().oneClick) {
      const f = (v: number | null) => (v == null ? "" : v.toFixed(dec()));
      tradingUi.openOrderDialog({
        side,
        patch: {
          orderType: type,
          limitMode: "price",
          stopMode: "price",
          limitPrice: f(type === "limit" ? price : type === "stopLimit" ? limit : null),
          stopPrice: f(type === "stop" || type === "stopLimit" ? price : null),
        },
      });
      return;
    }
    replayBroker.place({
      symbol: sym,
      side,
      type,
      qty: ticketQty(),
      limitPrice: type === "limit" ? price : type === "stopLimit" ? limit : null,
      stopPrice: type === "stop" || type === "stopLimit" ? price : null,
      takeProfit: null,
      stopLoss: null,
    });
  };
  const oneClick = () => tradingPrefs.prefs().oneClick;
  const cancel = (o: TradingOrder) => {
    const id = pane();
    if (id === null) return;
    const run = () => replayBroker.cancel(o.id, id);
    if (oneClick()) run();
    else confirmCancelOrder(o, run);
  };
  const cancelAll = (side?: Side) => {
    const id = pane();
    if (id === null) return;
    // Cancelling an order takes its brackets along: skip the ones gone.
    for (const o of orders()) {
      if (side && o.side !== side) continue;
      if (replayBroker.orders(id).some((x) => x.id === o.id)) replayBroker.cancel(o.id, id);
    }
  };
  const flatten = () => {
    const p = position();
    const id = pane();
    if (!p || id === null) return;
    const run = () => replayBroker.closePosition(null, id);
    if (oneClick()) run();
    else confirmClosePosition(p, run);
  };

  /** A size cell clicked: the row's limit (stop with Ctrl / Cmd). */
  const onCell = (e: MouseEvent, side: Side, i: number) => {
    if (e.shiftKey || e.altKey) return;
    e.preventDefault();
    flash(side, i);
    place(side, clickOrderType(e.ctrlKey || e.metaKey), indexPrice(i, tick(), dec()));
  };
  /** The meter of a clicked cell lights up for 0.5 s. */
  const [flashed, setFlashed] = createSignal<string | null>(null);
  let flashTimer: number | undefined;
  const flash = (side: Side, i: number) => {
    clearTimeout(flashTimer);
    setFlashed(`${side}${i}`);
    flashTimer = window.setTimeout(() => setFlashed(null), 500);
  };

  const [menu, setMenu] = createSignal<{ anchor: HTMLElement; side: Side; price: number } | null>(null);

  // Drag of an order mark (ghost row) and of the price column (scroll).
  const [ghost, setGhost] = createSignal<{ mark: DomOrderMark; index: number } | null>(null);
  const rowAt = (clientY: number) => top() - Math.floor((clientY - main.getBoundingClientRect().top) / DOM_ROW_H);
  const onMarkDown = (e: MouseEvent, mk: DomOrderMark) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const from = ix(mk.order[mk.field]);
    const y0 = e.clientY;
    let moved = false;
    const move = (ev: MouseEvent) => {
      if (!moved && Math.abs(ev.clientY - y0) < 3) return;
      moved = true;
      setHeld(true);
      setGhost({ mark: mk, index: rowAt(ev.clientY) });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      const g = ghost();
      setGhost(null);
      setHeld(false);
      const id = pane();
      if (!moved) {
        tradingUi.openOrderDialog({ side: mk.order.side, order: mk.order, paneId: id });
        return;
      }
      if (g && g.index !== from && id !== null) moveOrder(mk.order, indexPrice(g.index, tick(), dec()), mk.field === "limitPrice" && mk.order.type === "stopLimit", id);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const onPriceDown = (e: MouseEvent) => {
    if (e.button !== 0 || dynamic()) return;
    e.preventDefault();
    const y0 = e.clientY;
    const t0 = top();
    const move = (ev: MouseEvent) => {
      const n = Math.round((ev.clientY - y0) / DOM_ROW_H);
      if (n) setHeld(true);
      setTop(t0 + n);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setHeld(false);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  let wheelAcc = 0;
  const onWheel = (e: WheelEvent) => {
    if (dynamic()) return;
    e.preventDefault();
    const px = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? Math.sign(e.deltaY) * 100 : e.deltaY;
    const { rows: n, rest } = wheelRows(wheelAcc, px);
    wheelAcc = rest;
    scrollBy(n);
  };

  // ── Totals and counters ──────────────────────────────────────────────
  const buyCount = createMemo(() => countText(sideCounts(orders(), "buy")));
  const sellCount = createMemo(() => countText(sideCounts(orders(), "sell")));
  const hasOrders = () => orders().length > 0;
  /** The replay broker quotes no size: the totals read "-". */
  const TOTAL = "-";

  const [plMode, setPlMode] = createSignal<"money" | "ticks" | "percent">("money");
  const plText = () => {
    const p = position();
    const last = q()?.last;
    if (!p || last == null) return null;
    const diff = (last - p.avgPrice) * (p.side === "buy" ? 1 : -1);
    if (plMode() === "percent") return `${((diff / p.avgPrice) * 100).toFixed(2)}%`;
    if (plMode() === "ticks") {
      const n = Math.round(diff / tick());
      return `${n} tick${Math.abs(n) === 1 ? "" : "s"}`;
    }
    return `${p.pl.toFixed(2)} ${replayBroker.currency()}`;
  };
  const plTip = () =>
    !position() ? "Profit/Loss" : plMode() === "money" ? "Show PL in ticks" : plMode() === "ticks" ? "Show PL in percent" : `Show PL in ${replayBroker.currency()}`;
  const plUp = () => (position()?.pl ?? 0) > 0;
  const nextPl = () => setPlMode(plMode() === "money" ? "ticks" : plMode() === "ticks" ? "percent" : "money");

  const offscreen = () => {
    const l = market().last;
    if (!Number.isFinite(l) || !Number.isFinite(top())) return null;
    if (l > top()) return "higher";
    if (l < top() - height() + 1) return "lower";
    return null;
  };

  function Row(p: { k: number }) {
    const [hover, setHover] = createSignal<Side | null>(null);
    const i = () => top() - p.k;
    const price = () => indexPrice(i(), tick(), dec());
    const side = () => priceSide(i(), market());
    const full = (s: "buy" | "sell") => (s === "buy" ? i() === market().bid : i() === market().ask);
    const rowMarks = () => {
      const list = [...(marks().get(i()) ?? [])];
      const g = ghost();
      if (g && g.index === i() && ix(g.mark.order[g.mark.field]) !== i()) list.push({ ...g.mark, inactive: true });
      return list;
    };
    const ghostFrom = () => {
      const g = ghost();
      return g && ix(g.mark.order[g.mark.field]) === i() && g.index !== i() ? g.mark : null;
    };
    const cell = (s: Side) => (
      <span
        class="trd-dom-cell"
        classList={{ "is-buy": s === "buy", "is-sell": s === "sell" }}
        onClick={(e) => onCell(e, s, i())}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ anchor: e.currentTarget, side: s, price: price() });
        }}
        onMouseEnter={() => {
          setHover(s);
          tradingUi.setDomHover({ price: price(), buy: s === "buy" });
        }}
        onMouseLeave={() => {
          setHover(null);
          tradingUi.setDomHover(null);
        }}
      >
        <span class="trd-dom-meter" classList={{ "is-full": full(s), "is-active": flashed() === `${s}${i()}` }} />
      </span>
    );
    /** Hover label of a size cell, at the outer edge ("Limit" / "Stop"). */
    const label = (s: Side) => (
      <span class="trd-dom-label" classList={{ "is-shown": hover() === s, "is-active": labelActive(s, i(), market(), stopMode()) }}>
        {stopMode() ? "Stop" : "Limit"}
      </span>
    );
    const markView = (mk: DomOrderMark, collapsed: boolean) => (
      <div
        class="trd-dom-order"
        classList={{
          "is-buy": mk.side === "buy",
          [`is-${mk.type}`]: true,
          "is-inactive": mk.inactive,
          "is-collapsed": collapsed,
          "is-highlighted": ghostFrom()?.order.id === mk.order.id && ghostFrom()?.field === mk.field,
        }}
      >
        <button type="button" class="trd-dom-order-close" aria-label="Cancel order" onClick={() => cancel(mk.order)}>
          <MarkCloseIcon />
        </button>
        <span class="trd-dom-order-qty" onMouseDown={(e) => onMarkDown(e, mk)}>
          {fmtQty(mk.qty)}
        </span>
        <span class="trd-dom-order-type">{mk.typeText}</span>
      </div>
    );
    const sideMarks = (s: Side) => {
      const list = rowMarks().filter((m) => m.side === s);
      return list.map((mk, n) => markView(mk, n < list.length - 1));
    };
    return (
      <div class="trd-dom-row" classList={{ "is-ask": side() === "ask", "is-bid": side() === "bid" }} style={{ top: `${p.k * DOM_ROW_H}px` }}>
        {cell("buy")}
        <span
          class="trd-dom-cell is-price"
          classList={{
            "is-ask": side() === "ask",
            "is-bid": side() === "bid",
            "is-last": i() === market().last,
            "is-long": i() === posIndex() && position()?.side === "buy",
            "is-short": i() === posIndex() && position()?.side === "sell",
          }}
          onMouseDown={onPriceDown}
          onDblClick={center}
        >
          {fmtPrice(price(), tick())}
        </span>
        {cell("sell")}
        <span class="trd-dom-orders is-buy">
          {label("buy")}
          {sideMarks("buy")}
        </span>
        <span class="trd-dom-orders is-sell">
          {label("sell")}
          {sideMarks("sell")}
        </span>
      </div>
    );
  }

  return (
    <div class="trd-dom" data-name="dom-panel" onContextMenu={(e) => e.preventDefault()}>
      <div class="trd-dom-head">
        <div class="trd-dom-anchor">
          <Tooltip text="Bid size" side="bottom">
            <span class="trd-dom-cell is-buy is-header">Bid size</span>
          </Tooltip>
          <Tooltip text="Ask size" side="bottom">
            <span class="trd-dom-cell is-sell is-header">Ask size</span>
          </Tooltip>
        </div>
      </div>
      <div class="trd-dom-upper" ref={main}>
        <div class="trd-dom-main" onWheel={onWheel}>
          <div class="trd-dom-anchor">
            <Index each={rows()}>{(k) => <Row k={k()} />}</Index>
          </div>
        </div>
        <Show when={offscreen()}>
          {(o) => (
            <span class="trd-dom-offscreen" classList={{ "is-higher": o() === "higher", "is-lower": o() === "lower" }}>
              <ArrowIcon up={o() === "higher"} />
            </span>
          )}
        </Show>
      </div>

      <div class="trd-dom-bottom">
        <div class="trd-dom-controls">
          <div class="trd-dom-cancel">
            <Tooltip text="Cancel all buy orders" side="top">
              <button type="button" class="trd-dom-icon-btn" aria-label="Cancel all buy orders" disabled={!sideCounts(orders(), "buy").active && !sideCounts(orders(), "buy").inactive} onClick={() => cancelAll("buy")}>
                <CrossIcon />
              </button>
            </Tooltip>
            <Show when={buyCount().text}>
              <span class="trd-dom-count" title={buyCount().title}>{buyCount().text}</span>
            </Show>
          </div>
          <div class="trd-dom-centering">
            <span class="trd-dom-total is-bid" title="Total buy quantity">{TOTAL}</span>
            <span class="trd-dom-switch">
              <svg class="trd-dom-timer" viewBox="-1 -1 2 2" width="2" height="2" aria-hidden="true">
                <path d={piePath(progress())} />
              </svg>
              <Tooltip text={dynamic() ? "Enable dynamic mode" : "Disable dynamic mode"} side="top">
                <button
                  type="button"
                  class="trd-dom-icon-btn"
                  aria-label={dynamic() ? "Enable dynamic mode" : "Disable dynamic mode"}
                  onClick={() => {
                    setDynamic(!dynamic());
                    center();
                  }}
                >
                  <LockIcon open={!dynamic()} />
                </button>
              </Tooltip>
            </span>
            <span class="trd-dom-total is-ask" title="Total sell quantity">{TOTAL}</span>
          </div>
          <div class="trd-dom-cancel is-sell">
            <Tooltip text="Cancel all sell orders" side="top">
              <button type="button" class="trd-dom-icon-btn" aria-label="Cancel all sell orders" disabled={!sideCounts(orders(), "sell").active && !sideCounts(orders(), "sell").inactive} onClick={() => cancelAll("sell")}>
                <CrossIcon />
              </button>
            </Tooltip>
            <Show when={sellCount().text}>
              <span class="trd-dom-count" title={sellCount().title}>{sellCount().text}</span>
            </Show>
          </div>
        </div>

        <div class="trd-dom-btns is-position">
          <Tooltip text="Position" side="top">
            <button
              type="button"
              class="trd-dom-btn"
              classList={{ "is-buy": position()?.side === "buy", "is-sell": position()?.side === "sell" }}
              aria-disabled={!position()}
              onClick={() => position() && setTicketQty(position()!.qty)}
            >
              {position() ? `${fmtQty(position()!.qty)} @ ${fmtPrice(position()!.avgPrice, tick())}` : "—"}
            </button>
          </Tooltip>
          <Tooltip text={plTip()} side="top">
            <button
              type="button"
              class="trd-dom-btn"
              classList={{ "is-profit": !!position() && plUp(), "is-loss": !!position() && !plUp() }}
              aria-disabled={!position()}
              onClick={() => position() && nextPl()}
            >
              {plText() ?? "—"}
            </button>
          </Tooltip>
        </div>
        <div class="trd-dom-btns is-actions">
          <Tooltip text="Close the position" side="top">
            <button type="button" class="trd-dom-btn" aria-disabled={!position()} onClick={() => position() && flatten()}>
              Flatten
            </button>
          </Tooltip>
          <Tooltip text="Cancel all orders for the current symbol" side="top">
            <button type="button" class="trd-dom-btn" aria-disabled={!hasOrders()} onClick={() => hasOrders() && cancelAll()}>
              CXL All
            </button>
          </Tooltip>
          <Tooltip text="Reverse the position" side="top">
            <button
              type="button"
              class="trd-dom-btn"
              aria-disabled={!position()}
              onClick={() => {
                const id = pane();
                if (position() && id !== null) replayBroker.reverse(id);
              }}
            >
              Reverse
            </button>
          </Tooltip>
        </div>
        <div class="trd-dom-btns is-market">
          <Tooltip text="Buy market" side="top">
            <button type="button" class="trd-dom-btn is-primary is-buy" onClick={() => place("buy", "market", null)}>
              Buy Mkt
            </button>
          </Tooltip>
          <DomQty />
          <Tooltip text="Sell market" side="top">
            <button type="button" class="trd-dom-btn is-primary is-sell" onClick={() => place("sell", "market", null)}>
              Sell Mkt
            </button>
          </Tooltip>
        </div>
      </div>

      <Show when={menu()}>
        {(m) => (
          <Popover anchor={m().anchor} onClose={() => setMenu(null)} class="trd-dom-menu" offset={{ x: 0, y: 4 }}>
            <For each={contextItems(m().side, m().price, fmtQty(ticketQty()), ticker(), tick(), (p) => fmtPrice(p, tick()))}>
              {(it) => (
                <PopItem
                  title={it.label}
                  onClick={() => {
                    setMenu(null);
                    place(m().side, it.type, it.price, it.limit);
                  }}
                />
              )}
            </For>
          </Popover>
        )}
      </Show>
    </div>
  );
}

/** Quantity of the DOM orders (the ticket's next-order quantity). */
function DomQty(): JSX.Element {
  const [text, setText] = createSignal(String(ticketQty()));
  createEffect(on(ticketQty, (n) => setText(String(n)), { defer: true }));
  return (
    <input
      class="trd-dom-qty"
      inputmode="decimal"
      data-qa-id="qty-dom"
      value={text()}
      onInput={(e) => {
        setText(e.currentTarget.value);
        const n = Number(e.currentTarget.value);
        if (Number.isFinite(n) && n > 0) setTicketQty(n);
      }}
      onKeyDown={(e) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault();
        setTicketQty(Math.max(1, Math.round(ticketQty()) + (e.key === "ArrowUp" ? 1 : -1)));
      }}
    />
  );
}
