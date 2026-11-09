/*
 * The order ticket's state and actions: the draft as the order uses it, the exits, the quantity, the order
 * prices, presets and the place / confirm action. Set up once per ticket; its fields and layout read it.
 */
import { createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js";
import { replayBroker } from "../../data/trading/replay-broker";
import { POSITION_EDIT, tradingUi, type OrderPreset, type TicketDraft } from "../../data/trading/trading-ui";
import type { OrderType } from "../../data/trading/types";
import { replayActivePane, replayStartSeq } from "../../data/replay";
import { parsePositive, tickDecimals } from "./format";
import {
  buildTicket,
  entryPrice,
  exitPrice,
  exitTypeDisabled,
  exitValueIn,
  fieldTypes,
  fmtTypeValue,
  parseSigned,
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
import { TIPS, takeTip } from "./ticket-labels";

export type TicketModel = ReturnType<typeof createTicketModel>;

export function createTicketModel() {
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
  /** One-time tips under the quantity / stop loss fields. */
  const [qtyTip, setQtyTip] = createSignal<string | null>(null);
  const [slTip, setSlTip] = createSignal<string | null>(null);
  /** The quantity and stop loss boxes the tips sit under. */
  const boxes: { qty?: HTMLElement; sl?: HTMLElement } = {};

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
      setSlTip(null);
      if (t.qtyType !== "units" && takeTip("unitsQty")) setQtyTip(TIPS.unitsQty);
      return;
    }
    const sl = slOnFields();
    // "SL enables quantity in risk": the order is sized by its risk.
    if (tradingUi.slEnablesRisk() && t.qtyType === "units") {
      const rt: QtyType = t.qtyEquiv === "units" ? "riskUsd" : t.qtyEquiv;
      patch({ ...toRiskQty(rt, sl), qtyEquiv: "units" });
      if (takeTip("riskQty")) {
        setQtyTip(TIPS.riskQty);
        setSlTip(null);
      }
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
    else {
      // A risk needs the stop loss: turned on, with its tip.
      const wasOff = !d().slOn;
      patch({ ...toRiskQty(type, slOnFields()), qtyEquiv: eq });
      setQtyTip(null);
      if (wasOff && takeTip("stopLoss")) setSlTip(TIPS.stopLoss);
    }
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
    setQtyTip(null);
    setSlTip(null);
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
      if (tradingUi.orderDialog()) return tradingUi.closeOrderDialog();
      tradingUi.setDraft({ ...x, editing: null, paneId: null });
      tradingUi.setSent(true);
      return;
    }
    if (replayBroker.place(t) === null && !state().ok) return;
    tradingUi.savePrefs(r());
    // The order dialog of the DOM closes once the order is sent.
    if (tradingUi.orderDialog()) return tradingUi.closeOrderDialog();
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
  /** The ticket's order is what preset `p` sets (its favourite tag lit). */
  const presetApplied = (p: OrderPreset): boolean => {
    const cur = currentPreset();
    if (!cur) return false;
    const keys = ["orderType", "buyPrice", "sellPrice", "stopBuyLimitPrice", "stopSellLimitPrice", "tpPrice", "tpPriceType", "slPrice", "slPriceType"] as const;
    return keys.every((k) => (cur[k] ?? null) === (p[k] ?? null) || (k.endsWith("Price") && (cur[k] ?? 0) === (p[k] ?? 0)));
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

  onCleanup(() => (document.body.style.cursor = ""));

  return {
    d, q, tick, dec, ccy, state, r, types, isPos, editing, editingPos, errorText, qtyTip, setQtyTip, slTip, setSlTip, boxes,
    patch, spread, setType,
    exitOn, exitType, exitEquiv, qtyNum, exitValueText, exitInputValue, setExit, setExitType, setExitEquiv, swapExit, exitStep,
    setQtyType, qtyValueText, priceMode, swapPrice, stepKey,
    submit, changed, rr, currentPreset, applyPreset, presetApplied,
  };
}
