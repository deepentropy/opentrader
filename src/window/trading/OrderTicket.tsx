/*
 * Order ticket: the order panel docked at the right of the charts, trading
 * through the replay broker (paper trading in Bar Replay).
 *
 * Header (broker mark, ticker, close), Sell (bid) | Buy (ask) with the spread
 * between, Market | Limit | Stop | Stop Limit, prices (distance to the market
 * in ticks), units (money at risk), tick value, Exits (take profit / stop
 * loss, 75 / 25 ticks from the entry by default, risk / reward), and the place
 * button ("Buy" over "1 QQQ MARKET"). Each field is typed in the type of its
 * label menu (a price or an offset in ticks; units or the money / % balance
 * at risk to the stop loss; exits as a price, ticks, % price, money or %
 * balance), its equivalent on the right (a drop-down picks its type) and ⇄
 * swaps the two. Header: order presets, ⋯ (Trading settings…, "SL enables
 * quantity in risk": turning the stop loss on sizes the order by risk). Once an order is sent the button reads
 * "Start creating order" until the form is used again. On a working order
 * (reference app): "QQQ, order 3" over "Buy Limit 1 @ 690.00", no side or type
 * choice, Confirm (grey until something changed, then the side colour) over
 * Discard. "Protect position" (position line menu) opens it on the position:
 * "Long 1 @ 644.33", its take profit / stop loss, the trade and tick values,
 * Confirm / Discard. ArrowUp / ArrowDown step a price by the symbol's tick.
 * Off replay (or before a start point) the form gives way to "Launch replay
 * to start".
 */
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, untrack, type JSX } from "solid-js";
import { emitAppEvent } from "../../data/app-events";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { replayBroker } from "../../data/trading/replay-broker";
import { tradingUi, type OrderPreset, type TicketDraft } from "../../data/trading/trading-ui";
import type { OrderType } from "../../data/trading/types";
import { replayActivePane, replayStartSeq } from "../../data/replay";
import { fmtPrice, parsePositive, tickDecimals, tickerOf } from "./format";
import {
  EXIT_TYPES,
  QTY_TYPES,
  buildTicket,
  describeTicket,
  entryPrice,
  exitPrice,
  exitTypeDisabled,
  exitValueIn,
  fieldTypes,
  fmtTypeValue,
  marketHint,
  parseSigned,
  priceBase,
  priceOffset,
  presetFields,
  qtyValueIn,
  quotePrice as quoteOf,
  resolveDraft,
  riskReward,
  type ExitKind,
  type ExitType,
  type PriceField,
  type QtyType,
} from "./ticket";
import { ChevronIcon, CloseIcon } from "./icons";
import { EquivButton, LabelMenu, Popup, SwapButton, type MenuRow } from "./TicketMenus";
import { OrderPresetsButton } from "./OrderPresets";
import { orderSummary, positionSummary } from "../chart/trading-lines-model";
import { POSITION_EDIT } from "../../data/trading/trading-ui";

/** Exit type titles: menu rows, and lower case after "Take profit" /
 *  "Stop loss" in the label. */
const exitTitle = (kind: ExitKind, t: ExitType, ccy: string): string =>
  ({
    price: "Price",
    ticks: "Ticks",
    pricePct: "% price",
    cash: kind === "tp" ? `Reward ${ccy}` : `Risk ${ccy}`,
    balancePct: kind === "tp" ? "Reward % balance" : "Risk % balance",
  })[t];
const exitLabel = (kind: ExitKind, t: ExitType, ccy: string): string => {
  const title = exitTitle(kind, t, ccy);
  return `${kind === "tp" ? "Take profit" : "Stop loss"} ${title.charAt(0).toLowerCase()}${title.slice(1)}`;
};
/** Short unit after an equivalent value ("75 ticks", "717.87 price"). */
const exitUnit = (t: ExitType, ccy: string): string =>
  ({ price: "price", ticks: "ticks", pricePct: "% price", cash: ccy, balancePct: "% balance" })[t];
const exitInfo = (kind: ExitKind, t: ExitType): string | undefined =>
  ({
    price: undefined,
    ticks: "Exit price is equal to the number of ticks from the main order price",
    pricePct: "Exit price is calculated as a percentage of the main order price",
    cash: kind === "tp" ? "Cash amount you will gain if the take profit is executed" : "Cash amount you will lose if the stop loss is executed",
    balancePct:
      kind === "tp" ? "Percentage of equity you will gain if the take profit is executed" : "Percentage of equity you will lose if the stop loss is executed",
  })[t];
const qtyTitle = (t: QtyType, ccy: string): string => ({ units: "Units", riskUsd: `Risk ${ccy}`, riskPct: "Risk % balance" })[t];
const qtyUnit = (t: QtyType, ccy: string): string => ({ units: "unit", riskUsd: `${ccy} risk`, riskPct: "% risk" })[t];
const qtyInfo = (t: QtyType): string | undefined =>
  ({
    units: undefined,
    riskUsd:
      "Order size equivalent to the risk amount in cash, based on the set stop loss price. Changing the risk amount or stop loss price changes the quantity.",
    riskPct:
      "Order size equivalent to the equity percentage based on the set stop loss price. Changing the risk percentage or stop loss price changes the quantity.",
  })[t];
const NO_MONEY_SL = "Not available when Risk USD or Risk % balance are selected as the quantity type";

const TYPES: [OrderType, string][] = [
  ["market", "Market"],
  ["limit", "Limit"],
  ["stop", "Stop"],
  ["stopLimit", "Stop Limit"],
];

export function OrderTicket() {
  return (
    <Show when={tradingUi.ticketOpen() && tradingUi.draft()}>
      <TicketBody />
    </Show>
  );
}

function TicketBody() {
  const d = () => tradingUi.draft()!;
  const q = replayBroker.quote;
  const tick = () => q()?.minTick ?? 0.01;
  const dec = () => Math.max(2, tickDecimals(tick()) ?? 2);
  const ccy = () => replayBroker.currency();
  const state = replayBroker.tradability;
  /** Balance the "% balance" types are measured on: the initial capital
   *  plus the closed trades. */
  const balance = createMemo(() => replayBroker.settings().initialCapital + (replayBroker.report()?.performance.all.netProfit ?? 0));
  const ctx = () => ({ tick: tick(), decimals: dec(), balance: balance(), pointValue: 1 });
  const types = () => fieldTypes(d());
  /** The draft as the order uses it (offsets, risk and exit types resolved). */
  const r = createMemo(() => resolveDraft(d(), q(), ctx()));
  /** The ticket edits the brackets of the position (Protect position). */
  const isPos = () => tradingUi.draft()?.editing === POSITION_EDIT;
  const editing = createMemo(() => {
    const x = tradingUi.draft();
    if (!x?.editing || x.paneId === null || isPos()) return null;
    return replayBroker.orders(x.paneId).find((o) => o.id === x.editing) ?? null;
  });
  const editingPos = createMemo(() => {
    const x = tradingUi.draft();
    return x && isPos() && x.paneId !== null ? replayBroker.position(x.paneId) : null;
  });
  const [errorText, setErrorText] = createSignal<string | null>(null);

  // The ticket follows the focused chart; a new chart or start point starts
  // a new order (the button waits for the user: "Start creating order").
  createEffect(
    on([replayActivePane, replayStartSeq, () => replayBroker.symbol()], () => {
      const x = tradingUi.draft();
      const sym = replayBroker.symbol();
      if (!x || x.editing || !sym || sym === x.symbol) return;
      const units = x.qtyType && x.qtyType !== "units" ? { qtyType: "units" as const, qtyEquiv: x.qtyType } : {};
      tradingUi.setDraft({ ...x, ...units, symbol: sym, limitPrice: "", stopPrice: "", takeProfit: "", stopLoss: "", tpOn: false, slOn: false });
      tradingUi.setSent(true);
    }, { defer: false }),
  );

  // The modified order ended (filled / cancelled): back to a new order.
  createEffect(() => {
    const x = tradingUi.draft();
    if (x?.editing && !(isPos() ? editingPos() : editing())) tradingUi.setDraft({ ...x, editing: null, paneId: null });
  });

  const patch = (p: Partial<TicketDraft>) => {
    tradingUi.patchDraft(p);
    setErrorText(null);
  };
  const fx = (v: number | null | undefined) => (v != null && Number.isFinite(v) ? v.toFixed(dec()) : "");

  const quotePrice = (side: "buy" | "sell") => quoteOf(q(), side);
  const spread = () => {
    const b = q()?.bid;
    const a = q()?.ask;
    return b != null && a != null ? (a - b).toFixed(dec()) : null;
  };

  const setType = (t: OrderType) => {
    const x = d();
    const ref = quotePrice(x.side);
    const px = ref != null ? ref.toFixed(dec()) : "";
    patch({
      orderType: t,
      limitPrice: (t === "limit" || t === "stopLimit") && !x.limitPrice ? px : x.limitPrice,
      stopPrice: (t === "stop" || t === "stopLimit") && !x.stopPrice ? px : x.stopPrice,
    });
  };

  // ── Exits ────────────────────────────────────────────────────────────
  const exitOn = (kind: ExitKind) => (kind === "tp" ? d().tpOn : d().slOn);
  const exitType = (kind: ExitKind) => (kind === "tp" ? types().tpType : types().slType);
  const exitEquiv = (kind: ExitKind) => (kind === "tp" ? types().tpEquiv : types().slEquiv);
  const qtyNum = () => parsePositive(r().qty);
  const entry = () => entryPrice(r(), q());
  /** The exit price in effect: the one set, or the default while off. */
  const exitPx = (kind: ExitKind): number | null => {
    if (exitOn(kind)) return parsePositive(kind === "tp" ? r().takeProfit : r().stopLoss);
    return parsePositive(exitPrice(r(), q(), kind, tick(), dec()));
  };
  const exitValueText = (kind: ExitKind, type: ExitType): string => {
    const p = exitPx(kind);
    const e = entry();
    if (p == null || e == null) return "";
    const v = exitValueIn(type, p, e, qtyNum(), ctx());
    return v == null ? "" : fmtTypeValue(type, v, dec());
  };
  /** What the exit field shows: the value typed, or the default while off. */
  const exitInputValue = (kind: ExitKind): string => {
    const type = exitType(kind);
    if (exitOn(kind)) {
      if (type === "price") return kind === "tp" ? d().takeProfit : d().stopLoss;
      return (kind === "tp" ? d().tpValue : d().slValue) ?? "";
    }
    return exitValueText(kind, type);
  };
  /** The exit fields for a price `p` typed as `type`. */
  const exitFields = (kind: ExitKind, type: ExitType, p: number | null): Partial<TicketDraft> => {
    const e = entry();
    const v = p != null && e != null ? exitValueIn(type, p, e, qtyNum(), ctx()) : null;
    const text = v == null ? "" : fmtTypeValue(type, v, dec());
    if (kind === "tp") return type === "price" ? { takeProfit: fx(p) } : { tpValue: text, takeProfit: fx(p) };
    return type === "price" ? { stopLoss: fx(p) } : { slValue: text, stopLoss: fx(p) };
  };
  /** The stop loss on (its default while off), in a type a risk quantity
   *  can be measured to (no money / % balance). */
  const slOnFields = (): Partial<TicketDraft> => {
    const t = types();
    const p = exitPx("sl");
    const type: ExitType = t.slType === "cash" || t.slType === "balancePct" ? "price" : t.slType;
    const keep = d().slOn && type === t.slType;
    return {
      slOn: true,
      slType: type,
      slEquiv: t.slEquiv === type ? "ticks" : t.slEquiv,
      ...(keep ? {} : exitFields("sl", type, p)),
    };
  };
  /** The quantity typed as a risk (money / % balance) of the order now. */
  const toRiskQty = (type: QtyType, base: Partial<TicketDraft>): Partial<TicketDraft> => {
    const next: TicketDraft = { ...d(), ...base, qtyType: "units", qty: r().qty || d().qty };
    const v = qtyValueIn(type, resolveDraft(next, q(), ctx()), q(), ctx());
    return { ...base, qtyType: type, risk: v != null ? fmtTypeValue(type, v, dec()) : "" };
  };
  const setExit = (kind: ExitKind, on: boolean) => {
    const t = types();
    if (kind === "tp") {
      patch(on ? { tpOn: true, ...exitFields("tp", t.tpType, exitPx("tp")) } : { tpOn: false, takeProfit: "", tpValue: "" });
      return;
    }
    if (!on) {
      // The quantity is in units again (reference app).
      patch({ slOn: false, stopLoss: "", slValue: "", ...(t.qtyType !== "units" ? { qtyType: "units", qtyEquiv: t.qtyType, qty: r().qty || d().qty } : {}) });
      return;
    }
    const sl = slOnFields();
    // "SL enables quantity in risk": the order is sized by its risk.
    if (tradingUi.slEnablesRisk() && t.qtyType === "units") {
      const rt: QtyType = t.qtyEquiv === "units" ? "riskUsd" : t.qtyEquiv;
      patch({ ...toRiskQty(rt, sl), qtyEquiv: "units" });
    } else patch(sl);
  };
  const setExitType = (kind: ExitKind, type: ExitType) => {
    const old = exitType(kind);
    if (type === old) return;
    const eq = exitEquiv(kind) === type ? old : exitEquiv(kind);
    const f = exitOn(kind) ? exitFields(kind, type, exitPx(kind)) : {};
    patch(kind === "tp" ? { ...f, tpType: type, tpEquiv: eq } : { ...f, slType: type, slEquiv: eq });
  };
  const setExitEquiv = (kind: ExitKind, type: ExitType) => patch(kind === "tp" ? { tpEquiv: type } : { slEquiv: type });
  const swapExit = (kind: ExitKind) => {
    const a = exitType(kind);
    const b = exitEquiv(kind);
    if (exitTypeDisabled(kind, b, types().qtyType)) return;
    const f = exitOn(kind) ? exitFields(kind, b, exitPx(kind)) : {};
    patch(kind === "tp" ? { ...f, tpType: b, tpEquiv: a } : { ...f, slType: b, slEquiv: a });
  };

  // ── Quantity ─────────────────────────────────────────────────────────
  const setQtyType = (type: QtyType, equiv?: QtyType) => {
    const t = types();
    if (type === t.qtyType) return;
    const eq = equiv ?? (t.qtyEquiv === type ? t.qtyType : t.qtyEquiv);
    if (type === "units") patch({ qtyType: "units", qtyEquiv: eq, qty: r().qty || d().qty });
    else patch({ ...toRiskQty(type, slOnFields()), qtyEquiv: eq });
  };
  const qtyValueText = (type: QtyType): string => {
    const v = qtyValueIn(type, r(), q(), ctx());
    return v == null ? "⌀" : fmtTypeValue(type, v, dec());
  };

  // ── Order prices ─────────────────────────────────────────────────────
  const priceMode = (f: PriceField) => (f === "limitPrice" ? types().limitMode : types().stopMode);
  const swapPrice = (f: PriceField) => {
    if (priceMode(f) === "price") {
      const n = priceOffset(r(), q(), f, tick());
      patch(f === "limitPrice" ? { limitMode: "offset", limitOffset: n ? String(n) : "" } : { stopMode: "offset", stopOffset: n ? String(n) : "" });
    } else {
      patch(f === "limitPrice" ? { limitMode: "price", limitPrice: r().limitPrice } : { stopMode: "price", stopPrice: r().stopPrice });
    }
  };

  /** ArrowUp / ArrowDown: a price by the tick, ticks / units by 1, the rest
   *  by 0.01; an offset may go below zero. */
  const stepKey = (e: KeyboardEvent, key: keyof TicketDraft, step: number, signed = false) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const raw = String(d()[key] ?? "");
    const delta = e.key === "ArrowUp" ? step : -step;
    if (signed) {
      const n = Math.round((parseSigned(raw) ?? 0) + delta);
      patch({ [key]: n ? String(n) : "" } as Partial<TicketDraft>);
      return;
    }
    const isPrice = key === "limitPrice" || key === "stopPrice" || key === "takeProfit" || key === "stopLoss";
    const cur = parsePositive(raw) ?? (isPrice ? quotePrice(d().side) : null) ?? 0;
    const next = Math.max(step, cur + delta);
    patch({ [key]: next.toFixed(isPrice ? dec() : step >= 1 ? 0 : 2) } as Partial<TicketDraft>);
  };
  const exitStep = (type: ExitType) => (type === "price" ? tick() : type === "ticks" ? 1 : 0.01);

  function submit() {
    if (tradingUi.sent()) {
      tradingUi.setSent(false);
      return;
    }
    const t = buildTicket(r(), q());
    if (typeof t === "string") {
      setErrorText(t);
      return;
    }
    const x = d();
    if (isPos()) {
      replayBroker.setPositionBrackets(t.takeProfit, t.stopLoss, x.paneId ?? undefined);
      tradingUi.setDraft({ ...x, editing: null, paneId: null });
      tradingUi.setSent(true);
      return;
    }
    if (x.editing) {
      replayBroker.modify(x.editing, t, x.paneId ?? undefined);
      tradingUi.setDraft({ ...x, editing: null, paneId: null });
      tradingUi.setSent(true);
      return;
    }
    if (replayBroker.place(t) === null && !state().ok) return;
    tradingUi.savePrefs(r());
    tradingUi.setSent(true);
  }

  /** The modified order differs from the working one. */
  const changed = createMemo(() => {
    const o = editing();
    const t = buildTicket(r(), q());
    const pos = editingPos();
    if (pos && typeof t !== "string") return t.takeProfit !== pos.takeProfit || t.stopLoss !== pos.stopLoss;
    if (!o || typeof t === "string") return false;
    return t.qty !== o.qty || t.limitPrice !== o.limitPrice || t.stopPrice !== o.stopPrice || t.takeProfit !== o.takeProfit || t.stopLoss !== o.stopLoss;
  });

  const rr = () => riskReward(r(), q());

  // ── Order presets ────────────────────────────────────────────────────
  /** What "Save order preset…" saves: the type, the offsets (mirrored for
   *  the other side) and the exits in ticks / % price / % balance. */
  const currentPreset = (): Omit<OrderPreset, "id" | "title"> | null => {
    if (!state().ok || d().editing) return null;
    const x = r();
    const sgn = x.side === "buy" ? 1 : -1;
    const p: Omit<OrderPreset, "id" | "title"> = { orderType: x.orderType };
    const main: PriceField | null = x.orderType === "limit" ? "limitPrice" : x.orderType === "market" ? null : "stopPrice";
    if (main) {
      const n = priceOffset(x, q(), main, tick()) * sgn;
      p.buyPrice = n;
      p.sellPrice = -n;
    }
    if (x.orderType === "stopLimit") {
      const n = priceOffset(x, q(), "limitPrice", tick()) * sgn;
      p.stopBuyLimitPrice = n;
      p.stopSellLimitPrice = -n;
    }
    const saved = (kind: ExitKind): { v: number; type: "ticks" | "pricePct" | "balancePct" } | null => {
      if (!exitOn(kind)) return null;
      const t = exitType(kind);
      const type = t === "pricePct" || t === "balancePct" ? t : "ticks";
      const v = Number(exitValueText(kind, type));
      return v ? { v, type } : null;
    };
    const tp = saved("tp");
    const sl = saved("sl");
    if (tp) Object.assign(p, { tpPrice: tp.v, tpPriceType: tp.type });
    if (sl) Object.assign(p, { slPrice: sl.v, slPriceType: sl.type });
    return p;
  };
  /** A preset applied: its order type, its offsets for this side (in the
   *  price fields, whichever way they are typed) and its exits. */
  const applyPreset = (p: OrderPreset) => {
    const f = presetFields(p, d(), q(), tick(), dec());
    // No stop loss: the quantity in units again.
    if (f.qtyType === "units") f.qty = r().qty || d().qty;
    patch(f);
  };
  // Opened from the chart Buy / Sell buttons with an active preset.
  createEffect(() => {
    const id = tradingUi.draft()?.applyPreset;
    if (!id) return;
    const p = tradingUi.presets().find((x) => x.id === id);
    untrack(() => {
      tradingUi.setDraft({ ...d(), applyPreset: undefined });
      if (p) applyPreset(p);
    });
  });

  // The chart's project order line reads and edits the ticket.
  tradingUi.setTicketActions({
    resolved: () => r(),
    submit,
    setPrice: (f, price) => patch(f === "limitPrice" ? { limitMode: "price", limitPrice: fx(price) } : { stopMode: "price", stopPrice: fx(price) }),
    setExit: (kind, price) => {
      if (price === null) return setExit(kind, false);
      patch({ ...(kind === "tp" ? { tpOn: true } : { slOn: true }), ...exitFields(kind, exitType(kind), price) });
    },
    setType,
    setQty: (n) => patch({ qtyType: "units", qty: String(n) }),
  });
  onCleanup(() => tradingUi.setTicketActions(null));

  // Resize from the left edge.
  function beginResize(e: MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = tradingUi.ticketWidth();
    const next = (ev: MouseEvent) => startW + (startX - ev.clientX);
    const onMove = (ev: MouseEvent) => tradingUi.setTicketWidth(next(ev), false);
    const onUp = (ev: MouseEvent) => {
      tradingUi.setTicketWidth(next(ev), true);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "ew-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }
  onCleanup(() => (document.body.style.cursor = ""));

  /** Order price field: a price (its distance to the base on the right) or
   *  an offset in ticks (placeholder "Ask"; the price on the right). */
  const priceInput = (f: PriceField) => {
    const offset = () => priceMode(f) === "offset";
    const offKey = f === "limitPrice" ? "limitOffset" : "stopOffset";
    const label = () => {
      const base = d().orderType === "stopLimit" ? (f === "stopPrice" ? "Stop price" : "Limit price") : "Price";
      return offset() ? `${base} offset` : base;
    };
    return (
      <div class="trd-tk-field">
        <span class="trd-tk-label">{label()}</span>
        <span class="trd-tk-box">
          <input
            class="trd-tk-input"
            inputmode="decimal"
            placeholder={offset() ? priceBase(r(), q(), f).name : ""}
            value={offset() ? (d()[offKey] ?? "") : String(d()[f])}
            onInput={(e) => patch({ [offset() ? offKey : f]: e.currentTarget.value } as Partial<TicketDraft>)}
            onKeyDown={(e) => {
              if (offset()) stepKey(e, offKey, 1, true);
              else stepKey(e, f, tick());
              if (e.key === "Enter") submit();
            }}
          />
          <SwapButton onClick={() => swapPrice(f)} />
          <span class="trd-tk-hint">{offset() ? r()[f] : marketHint(r(), q(), r()[f], tick(), f)}</span>
        </span>
      </div>
    );
  };

  const exitInput = (kind: ExitKind) => {
    const on = () => exitOn(kind);
    const type = () => exitType(kind);
    const eq = () => exitEquiv(kind);
    const key = (): keyof TicketDraft => (type() === "price" ? (kind === "tp" ? "takeProfit" : "stopLoss") : kind === "tp" ? "tpValue" : "slValue");
    const rows = (pick: (t: ExitType) => void, without: ExitType | null, values: boolean): MenuRow[] =>
      EXIT_TYPES.filter((t) => t !== without).map((t) => ({
        title: exitTitle(kind, t, ccy()),
        info: values ? undefined : exitInfo(kind, t),
        value: values ? exitValueText(kind, t) || "⌀" : undefined,
        selected: t === (values ? eq() : type()),
        disabled: exitTypeDisabled(kind, t, types().qtyType) ? NO_MONEY_SL : false,
        onSelect: () => pick(t),
      }));
    return (
      <div class="trd-tk-exit" classList={{ "is-disabled": !on() }}>
        <div class="trd-tk-exit-head">
          <LabelMenu label={exitLabel(kind, type(), ccy())} rows={rows((t) => setExitType(kind, t), null, false)} />
          <ToggleSwitch on={on()} label={kind === "tp" ? "Take profit" : "Stop loss"} onChange={(v) => setExit(kind, v)} />
        </div>
        <span
          class="trd-tk-box"
          ref={(el) =>
            // A click in the field of an exit that is off turns it on
            // (reference app); the click does nothing else.
            el.addEventListener(
              "pointerdown",
              (e) => {
                if (on()) return;
                e.preventDefault();
                e.stopPropagation();
                setExit(kind, true);
                queueMicrotask(() => el.querySelector("input")?.focus());
              },
              true,
            )
          }
        >
          <input
            class="trd-tk-input"
            inputmode="decimal"
            readOnly={!on()}
            value={exitInputValue(kind)}
            onInput={(e) => patch({ [key()]: e.currentTarget.value } as Partial<TicketDraft>)}
            onKeyDown={(e) => {
              stepKey(e, key(), exitStep(type()));
              if (e.key === "Enter") submit();
            }}
          />
          <SwapButton onClick={() => swapExit(kind)} />
          <EquivButton
            value={exitValueText(kind, eq()) || "⌀"}
            unit={exitUnit(eq(), ccy())}
            rows={rows((t) => setExitEquiv(kind, t), type(), true)}
          />
        </span>
      </div>
    );
  };

  const qtyInput = () => {
    const type = () => types().qtyType;
    const eq = () => types().qtyEquiv;
    const risk = () => type() !== "units";
    return (
      <div class="trd-tk-field">
        <LabelMenu
          label={qtyTitle(type(), ccy())}
          rows={QTY_TYPES.map((t) => ({ title: qtyTitle(t, ccy()), info: qtyInfo(t), selected: t === type(), onSelect: () => setQtyType(t) }))}
        />
        <span class="trd-tk-box">
          <input
            class="trd-tk-input"
            inputmode="decimal"
            value={risk() ? (d().risk ?? "") : d().qty}
            onInput={(e) => patch(risk() ? { risk: e.currentTarget.value } : { qty: e.currentTarget.value })}
            onKeyDown={(e) => {
              if (risk()) stepKey(e, "risk", 0.01);
              else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                e.preventDefault();
                const v = parsePositive(d().qty) ?? 0;
                patch({ qty: String(Math.max(1, Math.round(v) + (e.key === "ArrowUp" ? 1 : -1))) });
              }
              if (e.key === "Enter") submit();
            }}
          />
          <SwapButton onClick={() => setQtyType(eq(), type())} />
          <EquivButton
            value={qtyValueText(eq())}
            unit={qtyUnit(eq(), ccy())}
            rows={QTY_TYPES.filter((t) => t !== type()).map((t) => ({
              title: qtyTitle(t, ccy()),
              info: qtyInfo(t),
              value: qtyValueText(t),
              selected: t === eq(),
              onSelect: () => patch({ qtyEquiv: t }),
            }))}
          />
        </span>
      </div>
    );
  };

  return (
    <aside class="trd-ticket" style={{ width: `${tradingUi.ticketWidth()}px` }} aria-label="Order panel" data-name="order-panel">
      <div class="trd-ticket-resize" onMouseDown={beginResize} />
      <div class="trd-tk-header">
        <Tooltip text="Replay Broker" side="bottom">
          <span class="trd-tk-mark">
            <Icon name="replay-status" size={18} />
          </span>
        </Tooltip>
        <span class="trd-tk-title">
          {tickerOf(d().symbol)}
          {d().editing && !isPos() ? `, order ${d().editing}` : ""}
        </span>
        <span class="trd-tk-spacer" />
        <span class="trd-tk-head-btns">
          <Show when={state().ok && !d().editing}>
            <OrderPresetsButton current={currentPreset} apply={applyPreset} />
          </Show>
          <TicketSettingsMenu />
          <Tooltip text="Close" side="bottom">
            <button type="button" class="trd-icon-btn" aria-label="Close" onClick={() => tradingUi.closeTicket()}>
              <CloseIcon />
            </button>
          </Tooltip>
        </span>
      </div>
      <Show when={editing()}>{(o) => <div class="trd-tk-sub">{orderSummary(o(), tick())}</div>}</Show>
      <Show when={editingPos()}>{(pos) => <div class="trd-tk-sub">{positionSummary(pos(), tick())}</div>}</Show>

      <Show
        when={state().ok || state().reason === "loading"}
        fallback={
          <div class="trd-tk-empty">
            <Show when={state().title}>
              <div class="trd-tk-empty-title">{state().title}</div>
            </Show>
            <div class="trd-tk-empty-text">{state().text}</div>
          </div>
        }
      >
        <div class="trd-tk-scroll">
          <Show when={!d().editing}>
          <div class="trd-tk-sides">
            <button
              type="button"
              class="trd-tk-side is-sell"
              classList={{ "is-selected": d().side === "sell" }}
              disabled={!!d().editing}
              onClick={() => patch({ side: "sell" })}
            >
              <span class="trd-tk-side-title">Sell</span>
              <span class="trd-tk-side-price">{q()?.bid != null ? fmtPrice(q()!.bid, tick()) : "No Data"}</span>
            </button>
            <button
              type="button"
              class="trd-tk-side is-buy"
              classList={{ "is-selected": d().side === "buy" }}
              disabled={!!d().editing}
              onClick={() => patch({ side: "buy" })}
            >
              <span class="trd-tk-side-title">Buy</span>
              <span class="trd-tk-side-price">{q()?.ask != null ? fmtPrice(q()!.ask, tick()) : "No Data"}</span>
            </button>
            <Show when={spread()}>
              <span class="trd-tk-spread">{spread()}</span>
            </Show>
          </div>

          <div class="trd-tk-types" role="tablist">
            <For each={TYPES}>
              {([t, title]) => (
                <button
                  type="button"
                  role="tab"
                  class="trd-tk-type"
                  classList={{ "is-selected": d().orderType === t }}
                  aria-selected={d().orderType === t}
                  disabled={!!d().editing && d().orderType !== t}
                  onClick={() => setType(t)}
                >
                  {title}
                </button>
              )}
            </For>
          </div>
          </Show>

          <Show when={!isPos()}>
          <div class="trd-tk-inputs" classList={{ "is-editing": !!d().editing }}>
            <Show when={d().orderType === "limit"}>{priceInput("limitPrice")}</Show>
            <Show when={d().orderType === "stop"}>{priceInput("stopPrice")}</Show>
            <Show when={d().orderType === "stopLimit"}>
              {priceInput("stopPrice")}
              {priceInput("limitPrice")}
            </Show>
            {qtyInput()}
            <div class="trd-tk-row">
              <span>Tick value</span>
              <span class="trd-tk-row-value">
                {((qtyNum() ?? 0) * tick()).toFixed(dec())}
                <small> {ccy()}</small>
              </span>
            </div>
          </div>

          </Show>

          <ExitsSection>
            {exitInput("tp")}
            {exitInput("sl")}
            <Show when={rr()}>
              {(v) => (
                <div class="trd-tk-row">
                  <span>Risk / Reward</span>
                  <span class="trd-tk-row-value">{Number(v().toFixed(2))}</span>
                </div>
              )}
            </Show>
          </ExitsSection>
          <Show when={editingPos()}>
            {(pos) => (
              <div class="trd-tk-values">
                <div class="trd-tk-row">
                  <span>Trade value</span>
                  <span class="trd-tk-row-value">
                    {(pos().qty * pos().avgPrice).toFixed(dec())}
                    <small> {ccy()}</small>
                  </span>
                </div>
                <div class="trd-tk-row">
                  <span>Tick value</span>
                  <span class="trd-tk-row-value">
                    {(pos().qty * tick()).toFixed(dec())}
                    <small> {ccy()}</small>
                  </span>
                </div>
              </div>
            )}
          </Show>
        </div>

        <div class="trd-tk-footer">
          <Show when={errorText()}>
            <div class="trd-tk-error" role="alert">{errorText()}</div>
          </Show>
          <Show
            when={d().editing}
            fallback={
              <button
                type="button"
                class="trd-tk-place"
                classList={{ "is-buy": !tradingUi.sent() && d().side === "buy", "is-sell": !tradingUi.sent() && d().side === "sell", "is-idle": tradingUi.sent() }}
                disabled={!state().ok}
                onClick={submit}
              >
                <Show when={!tradingUi.sent()} fallback={<span class="trd-tk-place-title">Start creating order</span>}>
                  <span class="trd-tk-place-title">{d().side === "buy" ? "Buy" : "Sell"}</span>
                  <span class="trd-tk-place-sub">{describeTicket(r(), dec())}</span>
                </Show>
              </button>
            }
          >
            <div class="trd-tk-edit-btns">
              <button
                type="button"
                class="trd-tk-place"
                classList={{ "is-buy": changed() && d().side === "buy", "is-sell": changed() && d().side === "sell", "is-idle": !changed() }}
                disabled={!state().ok}
                onClick={() => changed() && submit()}
              >
                <span class="trd-tk-place-title">Confirm</span>
              </button>
              <button type="button" class="trd-tk-discard" onClick={() => tradingUi.setDraft({ ...d(), editing: null, paneId: null })}>
                Discard
              </button>
            </div>
          </Show>
        </div>
      </Show>
    </aside>
  );
}

const DotsIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
    <circle cx="4" cy="9" r="1.5" />
    <circle cx="9" cy="9" r="1.5" />
    <circle cx="14" cy="9" r="1.5" />
  </svg>
);
const SettingsIcon = () => (
  <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
    <path d="M14 6.5l6.5 3.75v7.5L14 21.5l-6.5-3.75v-7.5z" stroke-linejoin="round" />
    <circle cx="14" cy="14" r="2.5" />
  </svg>
);

/** ⋯ (tooltip "Settings"): Trading settings… (the chart Settings dialog on
 *  its Trading tab) and "SL enables quantity in risk". */
function TicketSettingsMenu() {
  const [open, setOpen] = createSignal(false);
  let btn!: HTMLButtonElement;
  const button = (
    <button type="button" ref={btn} class="trd-icon-btn" classList={{ "is-active": open() }} aria-label="Settings" aria-haspopup="menu" aria-expanded={open()} onClick={() => setOpen(!open())}>
      <DotsIcon />
    </button>
  );
  return (
    <>
      <Tooltip text="Settings" side="bottom">
        {button}
      </Tooltip>
      <Show when={open()}>
        <Popup anchor={btn} alignEnd onClose={() => setOpen(false)} class="trd-menu-settings" label="Settings">
          <button
            type="button"
            class="trd-menu-row"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              emitAppEvent("chart-open-settings", { tab: "trading" });
            }}
          >
            <SettingsIcon />
            <span class="trd-menu-title">Trading settings…</span>
          </button>
          <div class="trd-menu-divider" />
          <button
            type="button"
            class="trd-menu-row"
            role="menuitemcheckbox"
            aria-checked={tradingUi.slEnablesRisk()}
            onClick={() => tradingUi.setSlEnablesRisk(!tradingUi.slEnablesRisk())}
          >
            <span class="trd-menu-check" classList={{ "is-on": tradingUi.slEnablesRisk() }}>
              <Show when={tradingUi.slEnablesRisk()}>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
                  <path d="M2.5 6.2l2.3 2.3 4.7-5" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </Show>
            </span>
            <span class="trd-menu-title">SL enables quantity in risk</span>
          </button>
        </Popup>
      </Show>
    </>
  );
}

function ExitsSection(props: { children: JSX.Element }) {
  const [open, setOpen] = createSignal(true);
  return (
    <div class="trd-tk-section">
      <button type="button" class="trd-tk-section-head" onClick={() => setOpen(!open())} aria-expanded={open()}>
        Exits <ChevronIcon open={open()} />
      </button>
      <Show when={open()}>{props.children}</Show>
    </div>
  );
}

function ToggleSwitch(p: { on: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={p.on}
      aria-label={p.label}
      class="trd-switch"
      classList={{ "is-on": p.on }}
      onClick={() => p.onChange(!p.on)}
    >
      <span class="trd-switch-knob" />
    </button>
  );
}
