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
 * × asks first (Cancel order / Close position; not with one-click trading),
 * a chip of an order or a bracket drags the price (snapped to the tick), a
 * click on an order chip opens it in the order ticket.
 *
 * Chart settings → Trading (per chart): Positions and orders (reverse button),
 * Profit and loss value of the position / brackets (money, ticks, %),
 * Execution marks (labels), Extended price lines, Order and position
 * alignment; and the Buy / Sell buttons under the series legend (bid / ask =
 * the last replayed price, the spread between). The focused chart's one-click
 * trading, execution sound and rejection-only toasts apply to the trading UI.
 */
import { For, Show, createEffect, createMemo, createSignal, type JSX } from "solid-js";
import type { Time } from "lightweight-charts";
import { Icon } from "../../../components/Icon";
import { Tooltip } from "../../../components/Tooltip";
import { isPaneInReplay, setReplayActivePane } from "../../../data/replay";
import { tradingPrefs } from "../../../data/trading/trading-prefs";
import { tradingAppearance, type TradingAppearance } from "../../header/chart-settings";
import { replayBroker } from "../../../data/trading/replay-broker";
import { ticketQty, tradingUi } from "../../../data/trading/trading-ui";
import type { TradingOrder, TradingPosition } from "../../../data/trading/types";
import { cachedSymbolSessions } from "../../../data/session";
import { confirmCancelOrder, confirmClosePosition } from "../../trading/confirm";
import { Popover, PopDivider, PopItem } from "../../screener/Popover";
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
  orderMenuTitle,
  plText,
  positionQtyText,
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
  /** Buy / Sell buttons of the chart (under the series legend). */
  TradingButtons: () => JSX.Element;
}

const DEFAULT_TRADING: TradingAppearance = tradingAppearance(undefined);

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
  /** This chart's Trading settings. */
  const ta = (): TradingAppearance => cx.appearance().trading ?? DEFAULT_TRADING;
  const tick = () => cachedSymbolSessions(cx.props.symbol ?? "")?.mintick ?? replayBroker.quote()?.minTick ?? 0.01;
  const position = () => (on() && ta().positions ? replayBroker.position(paneId) : null);
  const orders = () => (on() && ta().positions ? replayBroker.orders(paneId) : []);
  const executions = () => (on() && ta().executions ? replayBroker.executions(paneId) : []);
  // The focused chart's one-click trading, execution sound and notifications apply.
  createEffect(() => {
    if (cx.props.active && cx.props.shown !== false) tradingPrefs.setPrefs(ta());
  });
  /** Cancel / close: asked first, unless one-click trading is on. */
  const askCancel = (o: TradingOrder, run: () => void) => (ta().oneClick ? run() : confirmCancelOrder(o, run));
  const askClose = (p: TradingPosition, run: () => void) => (ta().oneClick ? run() : confirmClosePosition(p, run));
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

    /** A line of an order: its main line (the stop of a stop-limit until the
     *  stop is reached) or the limit line of a stop-limit. Key "<id>" or
     *  "<id>#limit". */
    type Line = { key: string; id: string; limit: boolean };

    /** Drawing order (reference app: the last placed on top): the position's
     *  brackets, then each order followed by its own brackets. */
    const lines = createMemo<Line[]>(() => {
      const list = orders();
      const seq = (o: TradingOrder) => Number(o.kind === "order" ? o.id : o.parentId) || 0;
      const rank = (o: TradingOrder) => (o.parentId === "position" ? -1 : seq(o));
      const out: Line[] = [];
      for (const { o } of list
        .map((o, i) => ({ o, i }))
        .sort((a, b) => rank(a.o) - rank(b.o) || (a.o.kind === "order" ? -1 : 0) - (b.o.kind === "order" ? -1 : 0) || a.i - b.i)) {
        out.push({ key: o.id, id: o.id, limit: false });
        if (hasLimitLine(o)) out.push({ key: `${o.id}#limit`, id: o.id, limit: true });
      }
      return out;
    });

    /** A stop-limit order waiting for its stop shows its limit price on a
     *  dotted line of its own (reference app). */
    const hasLimitLine = (o: TradingOrder) => o.kind === "order" && o.type === "stopLimit" && !o.stopTriggered && o.limitPrice !== null;

    /** The price of a line (the dragged price while it is dragged). */
    const linePrice = (o: TradingOrder, limit = false): number | null => {
      const d = drag();
      const key = limit ? `${o.id}#limit` : o.id;
      if (d && d.id === key) return d.price;
      return limit ? o.limitPrice : orderLinePrice(o);
    };

    /** Price of the dragged line from a pointer y (client). */
    const priceAt = (clientY: number, g: Geom): number | null => {
      if (!cx.series) return null;
      const y = clientY - cx.host.getBoundingClientRect().top - g.top;
      const p = cx.series.coordinateToPrice(y);
      return p === null ? null : snapToTick(p, tick());
    };

    const commit = (o: TradingOrder, price: number, limit: boolean) => {
      if (o.kind === "order") {
        // The limit line, or the line of a stop-limit whose stop was reached: the limit price.
        const asLimit = limit || (o.type === "stopLimit" && o.stopTriggered);
        replayBroker.modify(o.id, asLimit ? requestWithPrice(o, null, { limitPrice: price }) : requestWithPrice(o, price), paneId);
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

    /** Follow a press: `onMove` with the price under the pointer once it moved,
     *  `onUp(moved)` on release. */
    const track = (e: PointerEvent, g: Geom, onMove: (price: number) => void, onUp: (moved: boolean) => void) => {
      const el = e.currentTarget as HTMLElement;
      try { el.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
      const y0 = e.clientY;
      let moved = false;
      const move = (ev: PointerEvent) => {
        if (!moved && Math.abs(ev.clientY - y0) < 3) return;
        moved = true;
        const p = priceAt(ev.clientY, g);
        if (p !== null) onMove(p);
      };
      const up = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
        onUp(moved);
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
    };

    /** Press on an order / bracket chip: a drag moves the price, a click
     *  opens the order in the ticket. */
    const onChipDown = (e: PointerEvent, o: TradingOrder, limit: boolean) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const g = geom();
      const start = linePrice(o, limit);
      if (!g || start === null) return;
      const key = limit ? `${o.id}#limit` : o.id;
      track(e, g, (price) => setDrag({ id: key, price }), (moved) => {
        const d = drag();
        setDrag(null);
        if (moved) {
          if (d && d.price !== start) commit(o, d.price, limit);
        } else if (o.kind === "order") {
          tradingUi.editOrder(o, paneId);
        }
      });
    };

    /** A take profit / stop loss being dragged out of a dotted chip. */
    const [ghost, setGhost] = createSignal<{ kind: "tp" | "sl"; price: number } | null>(null);

    /** Press on a dotted TP / SL chip: dragged, the bracket goes where it is
     *  released; clicked, at the ticket's default distance. */
    const onBracketDown = (e: PointerEvent, kind: "tp" | "sl", set: (price: number | null) => void) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const g = geom();
      if (!g) return;
      track(e, g, (price) => setGhost({ kind, price }), (moved) => {
        const gh = ghost();
        setGhost(null);
        set(moved ? gh?.price ?? null : null);
      });
    };

    const stop = (e: Event) => e.stopPropagation();

    /** Right-click menu of a line (reference app): an order "<Side> <qty>
     *  @<price> <Type>" / Modify order / Cancel order; the position Protect
     *  position / Close position / Reverse position. */
    const [menu, setMenu] = createSignal<{ anchor: HTMLElement; order: TradingOrder | null } | null>(null);
    const openMenu = (e: MouseEvent, order: TradingOrder | null) => {
      e.preventDefault();
      e.stopPropagation();
      setMenu({ anchor: e.currentTarget as HTMLElement, order });
    };

    /** The row spans the plot: the chips sit right, centre or left (Order and
     *  position alignment); the line runs from them to the price axis, and
     *  across the whole width with Extended price lines. */
    const rowBox = (g: Geom) => ({ left: `${g.plotLeft}px`, right: `${g.hostW - g.plotRight}px` });
    const Lead = () => (
      <span
        class="ot-trd-seg is-lead"
        classList={{ "is-hidden": !ta().extendLines }}
        style={ta().align === "left" ? { width: `${RIGHT_OFFSET}px` } : { flex: "1 1 0" }}
      />
    );
    const Tail = () => <span class="ot-trd-seg is-tail" style={ta().align === "right" ? { width: `${RIGHT_OFFSET}px` } : { flex: "1 1 0" }} />;
    const ccy = () => replayBroker.currency(paneId);

    const sideColor = (side: "buy" | "sell") => (side === "buy" ? BLUE : SELL_COLOR);
    const colorOf = (o: TradingOrder) => (o.kind === "tp" ? TP_COLOR : o.kind === "sl" ? SL_COLOR : sideColor(o.side));

    function AxisLabel(p: { y: number; g: Geom; color: string; filled: boolean; dotted?: boolean; text: string }) {
      return (
        <div
          class="ot-trd-axis"
          classList={{ "is-filled": p.filled, "is-dotted": !!p.dotted }}
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

    /** The dotted TP / SL chips of a line without them. */
    function BracketChips(p: { tp: boolean; sl: boolean; set: (kind: "tp" | "sl", price: number | null) => void }) {
      return (
        <>
          <Show when={p.tp}>
            <Tooltip text="Drag to add take profit" side="top">
              <button type="button" class="ot-trd-chip is-dotted is-tp" style={{ "--c": TP_COLOR }} onPointerDown={(e) => onBracketDown(e, "tp", (v) => p.set("tp", v))} onMouseDown={stop}>
                TP
              </button>
            </Tooltip>
          </Show>
          <Show when={p.sl}>
            <Tooltip text="Drag to add stop loss" side="top">
              <button type="button" class="ot-trd-chip is-dotted is-sl" style={{ "--c": SL_COLOR }} onPointerDown={(e) => onBracketDown(e, "sl", (v) => p.set("sl", v))} onMouseDown={stop}>
                SL
              </button>
            </Tooltip>
          </Show>
          <Show when={p.tp || p.sl}>
            <span class="ot-trd-seg" />
          </Show>
        </>
      );
    }

    function OrderRow(p: { line: Line; g: Geom }) {
      const o = () => byId().get(p.line.id);
      const price = () => {
        const x = o();
        return x ? linePrice(x, p.line.limit) : null;
      };
      const y = () => yOf(price(), p.g);
      /** TP / SL of a working order without them: a stop-limit waiting for its
       *  stop carries them on its limit line. */
      const canAdd = (kind: "tp" | "sl") => {
        const x = o();
        if (!x || x.kind !== "order" || x.type === "market") return false;
        if (hasLimitLine(x) !== p.line.limit) return false;
        return kind === "tp" ? x.takeProfit === null : x.stopLoss === null;
      };
      const setBracket = (kind: "tp" | "sl", at: number | null) => {
        const x = o();
        if (!x) return;
        const v = at ?? defaultOrderBracket(x, kind, tick());
        if (v === null) return;
        replayBroker.modify(x.id, requestWithPrice(x, null, kind === "tp" ? { takeProfit: v } : { stopLoss: v }), paneId);
      };
      return (
        <Show when={o() && y() !== null}>
          <div
            class="ot-trd-row"
            classList={{ "is-dragging": drag()?.id === p.line.key, "is-limit-line": p.line.limit }}
            style={{ "--c": colorOf(o()!), top: `${y()}px`, ...rowBox(p.g) }}
          >
            <Lead />
            <BracketChips tp={canAdd("tp")} sl={canAdd("sl")} set={setBracket} />
            <div
              class="ot-trd-chip"
              classList={{ "is-dotted-chip": p.line.limit }}
              onPointerDown={(e) => onChipDown(e, o()!, p.line.limit)}
              onMouseDown={stop}
              onContextMenu={(e) => openMenu(e, o()!)}
            >
              <span class="ot-trd-chip__part is-qty">
                <Icon name="replay-status" size={14} />
                {fmtQty(o()!.qty)}
              </span>
              <Tooltip text="Modify order" side="top">
                <span class="ot-trd-chip__part is-text">{bracketPl(o()!) ?? orderChipText(o()!)}</span>
              </Tooltip>
              <Show when={!p.line.limit}>
                <Tooltip text={o()!.kind === "tp" ? "Cancel take profit" : o()!.kind === "sl" ? "Cancel stop loss" : "Cancel order"} side="top">
                  <button
                    type="button"
                    class="ot-trd-chip__part is-close"
                    aria-label="Cancel order"
                    onPointerDown={stop}
                    onMouseDown={stop}
                    onClick={() => {
                      const x = o();
                      if (x) askCancel(x, () => replayBroker.cancel(x.id, paneId));
                    }}
                  >
                    <CloseIcon />
                  </button>
                </Tooltip>
              </Show>
            </div>
            <Tail />
          </div>
        </Show>
      );
    }

    function PositionRow(p: { pos: TradingPosition; g: Geom }) {
      const y = () => yOf(p.pos.avgPrice, p.g);
      const setBracket = (kind: "tp" | "sl", at: number | null) => {
        const pos = p.pos;
        const v = at ?? defaultBracket(pos, kind, tick());
        replayBroker.setPositionBrackets(kind === "tp" ? v : pos.takeProfit, kind === "sl" ? v : pos.stopLoss, paneId);
      };
      return (
        <Show when={y() !== null}>
          <div class="ot-trd-row is-position" style={{ "--c": sideColor(p.pos.side), top: `${y()}px`, ...rowBox(p.g) }}>
            <Lead />
            <Show when={ta().reverseButton}>
              <Tooltip text="Reverse Position" side="top">
                <button type="button" class="ot-trd-chip is-button" aria-label="Reverse position" onPointerDown={stop} onMouseDown={stop} onClick={() => replayBroker.reverse(paneId)}>
                  <ReverseIcon />
                </button>
              </Tooltip>
              <span class="ot-trd-seg" />
            </Show>
            <BracketChips tp={p.pos.takeProfit === null} sl={p.pos.stopLoss === null} set={setBracket} />
            <div class="ot-trd-chip is-position-chip" onPointerDown={stop} onMouseDown={stop} onContextMenu={(e) => openMenu(e, null)}>
              <Tooltip text={fmtPl(p.pos.pl, replayBroker.currency(paneId))} side="top">
                <span class="ot-trd-chip__part is-qty is-filled">
                  <Icon name="replay-status" size={14} />
                  {positionQtyText(p.pos)}
                </span>
              </Tooltip>
              <Show when={ta().plPositions}>
                {(kind) => (
                  <span class="ot-trd-chip__part is-text is-pl">
                    {plText(p.pos.qty > 0 ? p.pos.pl / p.pos.qty : 0, p.pos.qty, p.pos.avgPrice, kind(), tick(), ccy())}
                  </span>
                )}
              </Show>
              <Tooltip text="Close Position" side="top">
                <button
                  type="button"
                  class="ot-trd-chip__part is-close"
                  aria-label="Close position"
                  onClick={() => askClose(p.pos, () => replayBroker.closePosition(null, paneId))}
                >
                  <CloseIcon />
                </button>
              </Tooltip>
            </div>
            <Tail />
          </div>
        </Show>
      );
    }

    /** P&L of a bracket if it fills (Profit and loss value → Brackets), from the
     *  position's average price or its order's price; null = the plain text. */
    const bracketPl = (o: TradingOrder): string | null => {
      const kind = ta().plBrackets;
      if (!kind || o.kind === "order") return null;
      const at = orderLinePrice(o);
      let base: number | null = null;
      let long = true;
      if (o.parentId === "position") {
        const pos = position();
        if (!pos) return null;
        base = pos.avgPrice;
        long = pos.side === "buy";
      } else {
        const parent = o.parentId ? byId().get(o.parentId) : undefined;
        if (!parent) return null;
        base = orderLinePrice(parent);
        long = parent.side === "buy";
      }
      if (at === null || base === null) return null;
      return plText((at - base) * (long ? 1 : -1), o.qty, base, kind, tick(), ccy());
    };

    /** A take profit / stop loss dragged out of its dotted chip. */
    function GhostRow(p: { g: Geom }) {
      const y = () => {
        const gh = ghost();
        return gh ? yOf(gh.price, p.g) : null;
      };
      return (
        <Show when={ghost() && y() !== null}>
          <div class="ot-trd-row is-dragging" style={{ "--c": ghost()!.kind === "tp" ? TP_COLOR : SL_COLOR, top: `${y()}px`, ...rowBox(p.g) }}>
            <Lead />
            <div class="ot-trd-chip">
              <span class="ot-trd-chip__part is-text">{ghost()!.kind === "tp" ? "Take profit" : "Stop loss"}</span>
            </div>
            <Tail />
          </div>
        </Show>
      );
    }

    /** Axis labels of every line, stacked without overlap around the series'
     *  last price label (which keeps its place). */
    const labels = createMemo(() => {
      const g = geom();
      if (!g) return [];
      const out: { key: string; y: number; color: string; filled: boolean; dotted?: boolean; text: string }[] = [];
      const pos = position();
      if (pos) {
        const y = yOf(pos.avgPrice, g);
        if (y !== null) out.push({ key: "position", y, color: sideColor(pos.side), filled: true, text: fmtPrice(pos.avgPrice, tick()) });
      }
      for (const l of lines()) {
        const o = byId().get(l.id);
        if (!o) continue;
        const price = linePrice(o, l.limit);
        const y = yOf(price, g);
        if (y !== null && price !== null) out.push({ key: l.key, y, color: colorOf(o), filled: false, dotted: l.limit, text: fmtPrice(price, tick()) });
      }
      const gh = ghost();
      const gy = gh ? yOf(gh.price, g) : null;
      if (gh && gy !== null) out.push({ key: "ghost", y: gy, color: gh.kind === "tp" ? TP_COLOR : SL_COLOR, filled: false, text: fmtPrice(gh.price, tick()) });
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
                  <Show when={ta().executionLabels}>
                    <span class="ot-trd-exec__text">{m.text}</span>
                  </Show>
                </div>
              )}
            </For>
            <Show when={position()}>{(pos) => <PositionRow pos={pos()} g={g()} />}</Show>
            <For each={lines()}>{(l) => <OrderRow line={l} g={g()} />}</For>
            <GhostRow g={g()} />
            <Show when={menu()}>
              {(m) => (
                <Popover anchor={m().anchor} onClose={() => setMenu(null)} class="ot-trd-menu" offset={{ x: 0, y: 4 }}>
                  <Show
                    when={m().order}
                    fallback={
                      <>
                        <PopItem
                          title="Protect position"
                          onClick={() => {
                            setMenu(null);
                            const pos = position();
                            if (pos) tradingUi.editPosition(pos, paneId);
                          }}
                        />
                        <PopItem
                          title="Close position"
                          onClick={() => {
                            setMenu(null);
                            const pos = position();
                            if (pos) askClose(pos, () => replayBroker.closePosition(null, paneId));
                          }}
                        />
                        <PopItem
                          title="Reverse position"
                          onClick={() => {
                            setMenu(null);
                            replayBroker.reverse(paneId);
                          }}
                        />
                      </>
                    }
                  >
                    {(o) => (
                      <>
                        <PopItem title={orderMenuTitle(o(), tick())} disabled />
                        <PopDivider />
                        <Show when={o().kind === "order"}>
                          <PopItem
                            title="Modify order"
                            onClick={() => {
                              const x = o();
                              setMenu(null);
                              tradingUi.editOrder(x, paneId);
                            }}
                          />
                        </Show>
                        <PopItem
                          title="Cancel order"
                          onClick={() => {
                            const x = o();
                            setMenu(null);
                            askCancel(x, () => replayBroker.cancel(x.id, paneId));
                          }}
                        />
                      </>
                    )}
                  </Show>
                </Popover>
              )}
            </Show>
            <For each={labels()}>{(l) => <AxisLabel y={l.y} g={g()} color={l.color} filled={l.filled} dotted={l.dotted} text={l.text} />}</For>
          </div>
        )}
      </Show>
    );
  }

  /** Buy / Sell buttons (Chart settings → Trading → Buy/sell buttons) while
   *  the chart is in replay: Sell (bid) | spread | Buy (ask) at the last
   *  replayed price. A click opens the order ticket on that side, or with
   *  one-click trading sends a market order at once (the ticket's quantity). */
  function TradingButtons() {
    const price = createMemo(() => {
      replayBroker.version();
      const last = cx.raw[cx.raw.length - 1];
      return last ? snapToTick(last.close, tick()) : null;
    });
    const go = (side: "buy" | "sell") => {
      setReplayActivePane(paneId);
      if (!ta().oneClick) {
        tradingUi.openOrderTicket({ side });
        return;
      }
      const symbol = replayBroker.symbol() ?? cx.props.symbol ?? "";
      replayBroker.place({ symbol, side, type: "market", qty: ticketQty(), limitPrice: null, stopPrice: null, takeProfit: null, stopLoss: null });
    };
    return (
      <Show when={on() && ta().buySellButtons && price() !== null}>
        <div class="ot-trd-buysell" data-name="buy-sell-buttons" onMouseDown={stop} onPointerDown={stop}>
          <Tooltip text="Sell" side="bottom">
            <button type="button" class="ot-trd-buysell__btn is-sell" data-name="sell-order-button" onClick={() => go("sell")}>
              <span class="ot-trd-buysell__price">{fmtPrice(price()!, tick())}</span>
              <span class="ot-trd-buysell__title">SELL</span>
            </button>
          </Tooltip>
          <span class="ot-trd-buysell__spread">{(0).toFixed(Math.max(2, String(tick()).split(".")[1]?.length ?? 2))}</span>
          <Tooltip text="Buy" side="bottom">
            <button type="button" class="ot-trd-buysell__btn is-buy" data-name="buy-order-button" onClick={() => go("buy")}>
              <span class="ot-trd-buysell__price">{fmtPrice(price()!, tick())}</span>
              <span class="ot-trd-buysell__title">BUY</span>
            </button>
          </Tooltip>
        </div>
      </Show>
    );
  }

  const stop = (e: Event) => e.stopPropagation();

  return { TradingLinesLayer, TradingButtons };
}
