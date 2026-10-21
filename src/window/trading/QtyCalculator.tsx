/*
 * Quantity pill of the chart's Buy / Sell buttons (one-click trading on):
 * the quantity of the next orders, abbreviated ("1K"); a click opens the
 * quantity calculator under it (reference app): a "Quantity" field, then
 * − / + by the step, +1 +5 +25 +100 +500 +1000, Clear and Default (the
 * minimum). Enter or Escape closes it.
 */
import { For, Show, createSignal, onMount } from "solid-js";
import { Tooltip } from "../../components/Tooltip";
import { setTicketQty, ticketQty } from "../../data/trading/trading-ui";
import { Popup } from "./TicketMenus";

const STEP = 1;
const MIN = 1;
const ADDS = [1, 5, 25, 100, 500, 1000];

/** 1234 → "1.23K", 2000000 → "2M". */
export function abbreviatedQty(n: number): string {
  const units: [number, string][] = [[1e9, "B"], [1e6, "M"], [1e3, "K"]];
  for (const [v, s] of units) if (Math.abs(n) >= v) return `${Number((n / v).toFixed(2))}${s}`;
  return String(Number(n.toFixed(8)));
}

const MinusIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path stroke="currentColor" stroke-width="1.4" d="M4 9h10" /></svg>
);
const PlusIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path stroke="currentColor" stroke-width="1.4" d="M4 9h10M9 4v10" /></svg>
);
const ClearIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
    <path d="M6.5 4.5h8v9h-8L3 9l3.5-4.5Z" stroke-linejoin="round" />
    <path d="m8.5 7 4 4m0-4-4 4" stroke-linecap="round" />
  </svg>
);
const DefaultIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
    <path d="M4.5 9a4.5 4.5 0 1 0 1.3-3.2" stroke-linecap="round" />
    <path d="M5.5 3v3h3" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
);

export function QtyPill() {
  const [open, setOpen] = createSignal(false);
  let pill!: HTMLButtonElement;
  return (
    <>
      <Tooltip text="Amount" side="bottom">
        <button type="button" ref={pill} class="ot-trd-buysell__qty" classList={{ "is-active": open() }} data-name="qtyEl" onClick={() => setOpen(!open())}>
          {open() ? String(ticketQty()) : abbreviatedQty(ticketQty())}
        </button>
      </Tooltip>
      <Show when={open()}>
        <QtyCalculator anchor={pill} value={ticketQty} onChange={setTicketQty} onClose={() => setOpen(false)} />
      </Show>
    </>
  );
}

/** The calculator popup under `anchor`, editing `value`. */
export function QtyCalculator(props: { anchor: HTMLElement; value: () => number; onChange: (n: number) => void; onClose: () => void }) {
  const [text, setText] = createSignal(String(props.value()));
  let input!: HTMLInputElement;
  onMount(() => {
    input.focus();
    input.selectionStart = input.value.length;
  });
  const set = (n: number) => {
    const v = Math.max(MIN, Math.round(n / STEP) * STEP);
    setText(String(v));
    props.onChange(v);
  };
  const add = (n: number) => set(props.value() + n);
  return (
    <Popup anchor={props.anchor} onClose={props.onClose} class="trd-qty-calc" label="Quantity">
      <div
        class="trd-qty-calc__body"
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            props.onClose();
          }
        }}
      >
        <label class="trd-tk-label" for="calculator-input">Quantity</label>
        <input
          ref={input}
          id="calculator-input"
          class="trd-tk-input trd-qty-calc__input"
          inputmode="decimal"
          value={text()}
          onInput={(e) => {
            setText(e.currentTarget.value);
            const n = Number(e.currentTarget.value);
            if (Number.isFinite(n) && n >= MIN) props.onChange(n);
          }}
        />
        <div class="trd-qty-calc__grid">
          <button type="button" class="trd-qty-calc__btn is-op" data-name="qtyButtonCalculator--1" aria-label="Decrease" onClick={() => add(-STEP)}><MinusIcon /></button>
          <button type="button" class="trd-qty-calc__btn is-op" data-name="qtyButtonCalculator-1" aria-label="Increase" onClick={() => add(STEP)}><PlusIcon /></button>
          <For each={ADDS}>
            {(n) => (
              <button type="button" class="trd-qty-calc__btn" data-name={`qtyButtonCalculator-${n}`} onClick={() => add(n)}>
                {n}
              </button>
            )}
          </For>
          <button type="button" class="trd-qty-calc__btn" data-name="qtyButtonCalculator-clear" aria-label="Clear" onClick={() => { setText(""); input.focus(); }}><ClearIcon /></button>
          <button type="button" class="trd-qty-calc__btn" data-name="qtyButtonCalculator-default" aria-label="Default" onClick={() => set(MIN)}><DefaultIcon /></button>
        </div>
      </div>
    </Popup>
  );
}
