import { translate, translateWith } from "../../i18n/translator";
/*
 * The order ticket's fields: an order price, the quantity, a take profit / stop loss. Each is typed in the type of
 * its label menu, shows its equivalent on the right (a drop-down picks its type) and ⇄ swaps the two.
 */
import { broker } from "../../data/trading/broker";
import type { TicketDraft } from "../../data/trading/trading-ui";
import { Switch } from "../../components/form";
import { parsePositive } from "./format";
import { localNumber } from "../../i18n/format";
import { priceFieldProps } from "../../i18n/price-field";
import { EXIT_TYPES, QTY_TYPES, exitTypeDisabled, marketHint, priceBase, type ExitKind, type ExitType, type PriceField } from "./ticket";
import { NO_MONEY_SL, exitInfo, exitLabel, exitTitle, exitUnit, qtyInfo, qtyTitle, qtyUnit } from "./ticket-labels";
import type { TicketModel } from "./ticket-model";
import { EquivButton, LabelMenu, SwapButton, type MenuRow } from "./TicketMenus";

/** Order price field: a price (its distance to the base on the right) or
 *  an offset in ticks (placeholder "Ask"; the price on the right). */
export function PriceInput(props: { m: TicketModel; f: PriceField }) {
  const { d, q, r, tick, patch, priceMode, stepKey, submit, swapPrice } = props.m;
  const f = props.f;
  const offset = () => priceMode(f) === "offset";
  const offKey = f === "limitPrice" ? "limitOffset" : "stopOffset";
  const label = () => {
    const base = d().orderType === "stopLimit" ? (f === "stopPrice" ? "Stop price" : "Limit price") : "Price";
    return offset() ? translateWith("{0} offset", translate(base)) : base;
  };
  const price = priceFieldProps(() => String(d()[f]), (v) => patch({ [f]: v } as Partial<TicketDraft>));
  return (
    <div class="trd-tk-field">
      <span class="trd-tk-label">{label()}</span>
      <span class="trd-tk-box">
        <input
          class="trd-tk-input"
          inputmode="decimal"
          placeholder={offset() ? priceBase(r(), q(), f).name : ""}
          value={offset() ? (d()[offKey] ?? "") : price.value}
          onFocus={price.onFocus}
          onBlur={price.onBlur}
          onInput={(e) => patch({ [offset() ? offKey : f]: e.currentTarget.value } as Partial<TicketDraft>)}
          onKeyDown={(e) => {
            if (offset()) stepKey(e, offKey, 1, true);
            else stepKey(e, f, tick());
            if (e.key === "Enter") submit();
          }}
        />
        <SwapButton onClick={() => swapPrice(f)} />
        <span class="trd-tk-hint">{localNumber(offset() ? r()[f] : marketHint(r(), q(), r()[f], tick(), f))}</span>
      </span>
    </div>
  );
}

export function ExitInput(props: { m: TicketModel; kind: ExitKind }) {
  const { ccy, types, exitOn, exitType, exitEquiv, exitValueText, exitInputValue, setExit, setExitType, setExitEquiv, swapExit, exitStep, patch, stepKey, submit, boxes } = props.m;
  const kind = props.kind;
  const on = () => exitOn(kind);
  const type = () => exitType(kind);
  const eq = () => exitEquiv(kind);
  const key = (): keyof TicketDraft => (type() === "price" ? (kind === "tp" ? "takeProfit" : "stopLoss") : kind === "tp" ? "tpValue" : "slValue");
  const value = priceFieldProps(() => exitInputValue(kind), (v) => patch({ [key()]: v } as Partial<TicketDraft>));
  const rows = (pick: (t: ExitType) => void, without: ExitType | null, values: boolean): MenuRow[] =>
    EXIT_TYPES.filter((t) => t !== without).map((t) => ({
      title: exitTitle(kind, t, ccy()),
      info: values ? undefined : exitInfo(kind, t),
      value: values ? localNumber(exitValueText(kind, t)) || "⌀" : undefined,
      selected: t === (values ? eq() : type()),
      disabled: exitTypeDisabled(kind, t, types().qtyType) ? NO_MONEY_SL : false,
      onSelect: () => pick(t),
    }));
  return (
    <div class="trd-tk-exit" classList={{ "is-disabled": !on() }}>
      <div class="trd-tk-exit-head">
        <LabelMenu label={exitLabel(kind, type(), ccy())} rows={rows((t) => setExitType(kind, t), null, false)} />
        <Switch on={on()} label={kind === "tp" ? "Take profit" : "Stop loss"} onChange={(v) => setExit(kind, v)} />
      </div>
      <span
        class="trd-tk-box"
        ref={(el) => {
          if (kind === "sl") boxes.sl = el;
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
          );
        }}
      >
        <input
          class="trd-tk-input"
          inputmode="decimal"
          readOnly={!on()}
          value={value.value}
          onFocus={value.onFocus}
          onBlur={value.onBlur}
          onInput={(e) => patch({ [key()]: e.currentTarget.value } as Partial<TicketDraft>)}
          onKeyDown={(e) => {
            stepKey(e, key(), exitStep(type()));
            if (e.key === "Enter") submit();
          }}
        />
        <SwapButton onClick={() => swapExit(kind)} />
        <EquivButton
          value={localNumber(exitValueText(kind, eq())) || "⌀"}
          unit={exitUnit(eq(), ccy())}
          rows={rows((t) => setExitEquiv(kind, t), type(), true)}
        />
      </span>
    </div>
  );
}

export function QtyInput(props: { m: TicketModel }) {
  const { d, ccy, types, setQtyType, qtyValueText, patch, stepKey, submit, boxes } = props.m;
  const stock = () => broker.isStock(d().symbol);
  const type = () => types().qtyType;
  const eq = () => types().qtyEquiv;
  const risk = () => type() !== "units";
  return (
    <div class="trd-tk-field">
      <LabelMenu
        label={qtyTitle(type(), ccy(), stock())}
        rows={QTY_TYPES.map((t) => ({ title: qtyTitle(t, ccy(), stock()), info: qtyInfo(t), selected: t === type(), onSelect: () => setQtyType(t) }))}
      />
      <span class="trd-tk-box" ref={(el) => (boxes.qty = el)}>
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
          value={localNumber(qtyValueText(eq()))}
          unit={qtyUnit(eq(), ccy(), stock())}
          rows={QTY_TYPES.filter((t) => t !== type()).map((t) => ({
            title: qtyTitle(t, ccy(), stock()),
            info: qtyInfo(t),
            value: localNumber(qtyValueText(t)),
            selected: t === eq(),
            onSelect: () => patch({ qtyEquiv: t }),
          }))}
        />
      </span>
    </div>
  );
}

