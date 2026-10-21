/*
 * Trading lines of a chart in Bar Replay (paper trading, replay broker): the
 * position line (reverse, TP / SL, quantity with the P&L, close), the working
 * order lines and the take profit / stop loss lines with their price labels on
 * the axis, and the execution arrows ("1 @ 651.42").
 *
 * DOM over the plot, re-projected on every view change (the chart's coord
 * epoch: scroll, zoom, price scale) and every broker change. The chips sit at
 * the right of the plot; a line runs from its chips to the price axis. As in
 * the reference app, lines a few ticks apart keep their chips on their own
 * line (the last placed on top) while the axis labels are stacked so none
 * hides another (the position label goes over the last price label). Orders
 * and the position without a take profit / stop loss carry dotted TP / SL
 * chips that add one at the ticket's default distance.
 * × asks first (Cancel order / Close position), a chip of an order or a
 * bracket drags the price (snapped to the tick), a click on an order chip opens
 * it in the order ticket.
 */
import { For, Show, createMemo, createSignal, type JSX } from "solid-js";
import type { Time } from "lightweight-charts";
import { Icon } from "../../../components/Icon";
import { Tooltip } from "../../../components/Tooltip";
import { isPaneInReplay } from "../../../data/replay";
import { replayBroker } from "../../../data/trading/replay-broker";
import { tradingUi } from "../../../data/trading/trading-ui";
import type { TradingOrder, TradingPosition } from "../../../data/trading/types";
import { cachedSymbolSessions } from "../../../data/session";
import { confirmCancelOrder, confirmClosePosition } from "../../trading/confirm";
import { lastAtOrBefore } from "../replay-feed";
import {
  defaultBracket,
  defaultOrderBracket,
  executionLabel,
  fmtPl,
  fmtPrice,
  fmtQty,
  orderChipText,
  orderLinePrice,
  requestWithPrice,
  snapToTick,
  stackLabels,
} from "../trading-lines-model";
import { type ChartCx } from "./context";

/** Distance of the chips from the price axis (px). */
const RIGHT_OFFSET = 64;
/** Height of an axis label (px). */
const LABEL_H = 20;
const BLUE = "#2962ff";
const TP_COLOR = "#089981";
const SL_COLOR = "#ff9800";
const SELL_COLOR = "#f23645";

export interface TradingLinesApi {
  /** `epoch`: the chart's coord epoch (view changes re-project the lines). */
  TradingLinesLayer: (props: { epoch: number }) => JSX.Element;
}

type Geom = {
  plotLeft: number;
  plotRight: number;
  hostW: number;
  top: number;
  height: number;
  axisLeft: boolean;
  axisW: number;
};

const ReverseIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
    <path fill="none" stroke="currentColor" stroke-width="1.4" d="M4.5 12V2.5M2 5l2.5-2.5L7 5M9.5 2v9.5M7 9l2.5 2.5L12 9" />
  </svg>
);
const CloseIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
    <path fill="none" stroke="currentColor" stroke-width="1.3" d="m2 2 8 8m0-8-8 8" />
  </svg>
);
const ArrowIcon = (props: { down: boolean }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 14" width="12" height="14" aria-hidden="true" style={{ transform: props.down ? "rotate(180deg)" : undefined }}>
    <path fill="none" stroke="currentColor" stroke-width="2" d="M6 13V2M1.5 6.5 6 2l4.5 4.5" />
  </svg>
);

export function createTradingLines(cx: ChartCx): TradingLinesApi {
  const paneId = cx.paneId;
  const on = () => isPaneInReplay(paneId);
  const tick = () => cachedSymbolSessions(cx.props.symbol ?? "")?.mintick ?? replayBroker.quote()?.minTick ?? 0.01;
  const position = () => (on() ? replayBroker.position(paneId) : null);
  const orders = () => (on() ? replayBroker.orders(paneId) : []);
  const executions = () => (on() ? replayBroker.executions(paneId) : []);
  /** A line being dragged: its order id and price. */
  const [drag, setDrag] = createSignal<{ id: string; price: number } | null>(null);

  function TradingLinesLayer(props: { epoch: number }) {
    const geom = createMemo<Geom | null>(() => {
      void props.epoch;
      replayBroker.version();
      cx.paneBoxes();
      cx.mainPaneEpoch();
      if (!on() || !cx.chart || !cx.series) return null;
      let plotW = 0;
      try { plotW = cx.chart.timeScale().width(); } catch { return null; }
      const plotLeft = cx.leftAxisWidth();
      const m = cx.mainPane();
      const box = cx.paneBoxes().find((b) => b.index === m);
      const axisLeft = cx.mainSide() === "left";
      return {
        plotLeft,
        plotRight: plotLeft + plotW,
        hostW: cx.host.clientWidth,
        top: box?.top ?? 0,
        height: box?.height ?? cx.chart.paneSize(m).height,
        axisLeft,
        axisW: cx.firstAxisWidthOf(axisLeft ? "left" : "right"),
      };
    });

    /** y of a price in the layer, null outside the price pane. */
    const yOf = (price: number | null, g: Geom): number | null => {
      if (price === null || !cx.series) return null;
      const y = cx.series.priceToCoordinate(price);
      if (y === null || y < 0 || y > g.height) return null;
      return g.top + y;
    };

    const byId = createMemo(() => new Map(orders().map((o) => [o.id, o])));
    /** Drawing order (reference app: the last placed on top): the position's
     *  brackets, then each order followed by its own brackets. */
    const ids = createMemo(() => {
      const list = orders();
      const seq = (o: TradingOrder) => Number(o.kind === "order" ? o.id : o.parentId) || 0;
      const rank = (o: TradingOrder) => (o.parentId === "position" ? -1 : seq(o));
      return list
        .map((o, i) => ({ o, i }))
        .sort((a, b) => rank(a.o) - rank(b.o) || (a.o.kind === "order" ? -1 : 0) - (b.o.kind === "order" ? -1 : 0) || a.i - b.i)
        .map(({ o }) => o.id);
    });

    /** The line price of an order (the dragged price while it is dragged). */
    const linePrice = (o: TradingOrder): number | null => {
      const d = drag();
      return d && d.id === o.id ? d.price : orderLinePrice(o);
    };

    /** Price of the dragged line from a pointer y (client). */
    const priceAt = (clientY: number, g: Geom): number | null => {
      if (!cx.series) return null;
      const y = clientY - cx.host.getBoundingClientRect().top - g.top;
      const p = cx.series.coordinateToPrice(y);
      return p === null ? null : snapToTick(p, tick());
    };

    const commit = (o: TradingOrder, price: number) => {
      if (o.kind === "order") {
        replayBroker.modify(o.id, requestWithPrice(o, price), paneId);
        return;
      }
      const pos = position();
      if (o.parentId === "position" && pos) {
        replayBroker.setPositionBrackets(o.kind === "tp" ? price : pos.takeProfit, o.kind === "sl" ? price : pos.stopLoss, paneId);
        return;
      }
      const parent = o.parentId ? byId().get(o.parentId) : undefined;
      if (parent) replayBroker.modify(parent.id, requestWithPrice(parent, null, o.kind === "tp" ? { takeProfit: price } : { stopLoss: price }), paneId);
    };

    /** Press on an order / bracket chip: a drag moves the price, a click
     *  opens the order in the ticket. */
    const onChipDown = (e: PointerEvent, o: TradingOrder) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const g = geom();
      const start = orderLinePrice(o);
      if (!g || start === null) return;
      const el = e.currentTarget as HTMLElement;
      el.setPointerCapture(e.pointerId);
      const y0 = e.clientY;
      let moved = false;
      const move = (ev: PointerEvent) => {
        if (!moved && Math.abs(ev.clientY - y0) < 3) return;
        moved = true;
        const p = priceAt(ev.clientY, g);
        if (p !== null) setDrag({ id: o.id, price: p });
      };
      const up = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
        const d = drag();
        setDrag(null);
        if (moved) {
          if (d && d.price !== start) commit(o, d.price);
        } else if (o.kind === "order") {
          tradingUi.editOrder(o, paneId);
        }
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
    };

    const stop = (e: Event) => e.stopPropagation();

    const colorOf = (o: TradingOrder) => (o.kind === "tp" ? TP_COLOR : o.kind === "sl" ? SL_COLOR : BLUE);

    function AxisLabel(p: { y: number; g: Geom; color: string; filled: boolean; text: string }) {
      return (
        <div
          class="ot-trd-axis"
          classList={{ "is-filled": p.filled }}
          style={{
            "--c": p.color,
            top: `${p.y}px`,
            left: `${p.g.axisLeft ? p.g.plotLeft - p.g.axisW : p.g.plotRight}px`,
            width: `${p.g.axisW}px`,
          }}
        >
          {p.text}
        </div>
      );
    }

    function OrderRow(p: { id: string; g: Geom }) {
      const o = () => byId().get(p.id);
      const price = () => {
        const x = o();
        return x ? linePrice(x) : null;
      };
      const y = () => yOf(price(), p.g);
      /** Dotted TP / SL of a working order without them. */
      const addBracket = (kind: "tp" | "sl") => {
        const x = o();
        if (!x) return;
        const v = defaultOrderBracket(x, kind, tick());
        if (v === null) return;
        replayBroker.modify(x.id, requestWithPrice(x, null, kind === "tp" ? { takeProfit: v } : { stopLoss: v }), paneId);
      };
      const canAdd = (kind: "tp" | "sl") => {
        const x = o();
        return !!x && x.kind === "order" && x.type !== "market" && (kind === "tp" ? x.takeProfit === null : x.stopLoss === null);
      };
      return (
        <Show when={o() && y() !== null}>
          <div
            class="ot-trd-row"
            classList={{ "is-dragging": drag()?.id === p.id }}
            style={{ "--c": colorOf(o()!), top: `${y()}px`, right: `${p.g.hostW - p.g.plotRight}px` }}
          >
            <Show when={canAdd("tp")}>
              <Tooltip text="Add take profit" side="top">
                <button type="button" class="ot-trd-chip is-dotted is-tp" style={{ "--c": TP_COLOR }} onPointerDown={stop} onMouseDown={stop} onClick={() => addBracket("tp")}>
                  TP
                </button>
              </Tooltip>
            </Show>
            <Show when={canAdd("sl")}>
              <Tooltip text="Add stop loss" side="top">
                <button type="button" class="ot-trd-chip is-dotted is-sl" style={{ "--c": SL_COLOR }} onPointerDown={stop} onMouseDown={stop} onClick={() => addBracket("sl")}>
                  SL
                </button>
              </Tooltip>
            </Show>
            <Show when={canAdd("tp") || canAdd("sl")}>
              <span class="ot-trd-seg" />
            </Show>
            <div class="ot-trd-chip" onPointerDown={(e) => onChipDown(e, o()!)} onMouseDown={stop}>
              <span class="ot-trd-chip__part is-qty">
                <Icon name="replay-status" size={14} />
                {fmtQty(o()!.qty)}
              </span>
              <span class="ot-trd-chip__part is-text">{orderChipText(o()!)}</span>
              <Tooltip text={o()!.kind === "tp" ? "Cancel take profit" : o()!.kind === "sl" ? "Cancel stop loss" : "Cancel order"} side="top">
                <button
                  type="button"
                  class="ot-trd-chip__part is-close"
                  aria-label="Cancel order"
                  onPointerDown={stop}
                  onMouseDown={stop}
                  onClick={() => {
                    const x = o();
                    if (x) confirmCancelOrder(x, () => replayBroker.cancel(x.id, paneId));
                  }}
                >
                  <CloseIcon />
                </button>
              </Tooltip>
            </div>
            <span class="ot-trd-seg is-tail" style={{ width: `${RIGHT_OFFSET}px` }} />
          </div>
        </Show>
      );
    }

    function PositionRow(p: { pos: TradingPosition; g: Geom }) {
      const y = () => yOf(p.pos.avgPrice, p.g);
      const addBracket = (kind: "tp" | "sl") => {
        const pos = p.pos;
        const v = defaultBracket(pos, kind, tick());
        replayBroker.setPositionBrackets(kind === "tp" ? v : pos.takeProfit, kind === "sl" ? v : pos.stopLoss, paneId);
      };
      return (
        <Show when={y() !== null}>
          <div class="ot-trd-row is-position" style={{ "--c": BLUE, top: `${y()}px`, right: `${p.g.hostW - p.g.plotRight}px` }}>
            <Tooltip text="Reverse position" side="top">
              <button type="button" class="ot-trd-chip is-button" aria-label="Reverse position" onPointerDown={stop} onMouseDown={stop} onClick={() => replayBroker.reverse(paneId)}>
                <ReverseIcon />
              </button>
            </Tooltip>
            <span class="ot-trd-seg" />
            <Show when={p.pos.takeProfit === null}>
              <Tooltip text="Add take profit" side="top">
                <button type="button" class="ot-trd-chip is-dotted is-tp" style={{ "--c": TP_COLOR }} onPointerDown={stop} onMouseDown={stop} onClick={() => addBracket("tp")}>
                  TP
                </button>
              </Tooltip>
            </Show>
            <Show when={p.pos.stopLoss === null}>
              <Tooltip text="Add stop loss" side="top">
                <button type="button" class="ot-trd-chip is-dotted is-sl" style={{ "--c": SL_COLOR }} onPointerDown={stop} onMouseDown={stop} onClick={() => addBracket("sl")}>
                  SL
                </button>
              </Tooltip>
            </Show>
            <Show when={p.pos.takeProfit === null || p.pos.stopLoss === null}>
              <span class="ot-trd-seg" />
            </Show>
            <div class="ot-trd-chip is-position-chip" onPointerDown={stop} onMouseDown={stop}>
              <Tooltip text={fmtPl(p.pos.pl, replayBroker.currency(paneId))} side="top">
                <span class="ot-trd-chip__part is-qty is-filled">
                  <Icon name="replay-status" size={14} />
                  {fmtQty(p.pos.qty)}
                </span>
              </Tooltip>
              <Tooltip text="Close position" side="top">
                <button
                  type="button"
                  class="ot-trd-chip__part is-close"
                  aria-label="Close position"
                  onClick={() => confirmClosePosition(p.pos, () => replayBroker.closePosition(null, paneId))}
                >
                  <CloseIcon />
                </button>
              </Tooltip>
            </div>
            <span class="ot-trd-seg is-tail" style={{ width: `${RIGHT_OFFSET}px` }} />
          </div>
        </Show>
      );
    }

    /** Axis labels of every line, stacked without overlap around the series'
     *  last price label (which keeps its place). */
    const labels = createMemo(() => {
      const g = geom();
      if (!g) return [];
      const out: { key: string; y: number; color: string; filled: boolean; text: string }[] = [];
      const pos = position();
      if (pos) {
        const y = yOf(pos.avgPrice, g);
        if (y !== null) out.push({ key: "position", y, color: BLUE, filled: true, text: fmtPrice(pos.avgPrice, tick()) });
      }
      for (const o of orders()) {
        const price = linePrice(o);
        const y = yOf(price, g);
        if (y !== null && price !== null) out.push({ key: o.id, y, color: colorOf(o), filled: false, text: fmtPrice(price, tick()) });
      }
      const items: { y: number; fixed?: boolean }[] = out.map((l) => ({ y: l.y }));
      const last = cx.raw[cx.raw.length - 1];
      const lastY = last && cx.series?.options().lastValueVisible ? yOf(last.close, g) : null;
      if (lastY !== null) items.push({ y: lastY, fixed: true });
      const ys = stackLabels(items, LABEL_H);
      return out.map((l, i) => ({ ...l, y: ys[i] }));
    });

    /** Execution arrows under (buy) / over (sell) the bar they filled on. */
    const marks = createMemo(() => {
      const g = geom();
      if (!g || !cx.chart || !cx.series) return [];
      const ts = cx.chart.timeScale();
      const out: { key: string; x: number; y: number; sell: boolean; text: string }[] = [];
      const stack = new Map<number, number>();
      for (const e of executions()) {
        const i = lastAtOrBefore(cx.raw, e.time);
        if (i < 0) continue;
        const b = cx.raw[i];
        const x = ts.timeToCoordinate(b.time as Time);
        if (x === null || x < 0 || x > g.plotRight - g.plotLeft) continue;
        const sell = e.side === "sell";
        const yy = cx.series.priceToCoordinate(sell ? b.high : b.low);
        if (yy === null) continue;
        const k = (b.time as number) * 2 + (sell ? 1 : 0);
        const n = stack.get(k) ?? 0;
        stack.set(k, n + 1);
        const off = n * 30;
        out.push({ key: e.id, x: g.plotLeft + x, y: g.top + (sell ? yy - 4 - off : yy + 4 + off), sell, text: executionLabel(e, tick()) });
      }
      return out;
    });

    return (
      <Show when={geom()}>
        {(g) => (
          <div class="ot-trd-lines" data-name="trading-lines">
            <For each={marks()}>
              {(m) => (
                <div class="ot-trd-exec" classList={{ "is-sell": m.sell }} style={{ left: `${m.x}px`, top: `${m.y}px`, "--c": m.sell ? SELL_COLOR : BLUE }}>
                  <ArrowIcon down={m.sell} />
                  <span class="ot-trd-exec__text">{m.text}</span>
                </div>
              )}
            </For>
            <Show when={position()}>{(pos) => <PositionRow pos={pos()} g={g()} />}</Show>
            <For each={ids()}>{(id) => <OrderRow id={id} g={g()} />}</For>
            <For each={labels()}>{(l) => <AxisLabel y={l.y} g={g()} color={l.color} filled={l.filled} text={l.text} />}</For>
          </div>
        )}
      </Show>
    );
  }

  return { TradingLinesLayer };
}
