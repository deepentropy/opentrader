/*
 * Number fields. Both are text inputs written with a dot whatever the system locale (a type="number" input would
 * show "25,00"); a value that does not parse reverts on commit.
 *
 * `NumberField`: the Settings dialogs' field — 100×34, r8, up / down spin buttons, arrow keys step, clamped to its
 * range, optional unit after it, end slot inside it and thousands separators. `DecimalInput`: the drawing Settings
 * value field with fixed decimals.
 */
import { Show } from "solid-js";
import { Chevron } from "./glyphs";

export function NumberField(props: {
  value: string;
  unit?: string;
  /** End slot inside the field (Slippage "ticks"). */
  suffix?: string;
  /** No up / down buttons. */
  noSpin?: boolean;
  /** Thousands separators in the shown value ("100,000"). */
  grouping?: boolean;
  disabled?: boolean;
  width?: number;
  num?: { min: number; max: number; step: number; int?: boolean };
  onChange: (v: string) => void;
}) {
  const clamp = (n: number) => {
    const r = props.num;
    if (!r) return n;
    let v = Math.max(r.min, Math.min(r.max, n));
    if (r.int) v = Math.round(v);
    return v;
  };
  const shown = () => (props.grouping && Number.isFinite(parseFloat(props.value)) ? Number(props.value).toLocaleString("en-US", { maximumFractionDigits: 8 }) : props.value);
  const commit = (text: string, el?: HTMLInputElement) => {
    const n = parseFloat(props.grouping ? text.replace(/,/g, "") : text);
    if (!Number.isFinite(n)) { if (el) el.value = shown(); return; }
    const v = String(Number(clamp(n).toFixed(8)));
    props.onChange(v);
    if (el) el.value = props.grouping ? Number(v).toLocaleString("en-US", { maximumFractionDigits: 8 }) : v;
  };
  const step = (dir: 1 | -1) => {
    const n = parseFloat(props.value);
    const s = props.num?.step ?? 1;
    commit(String((Number.isFinite(n) ? n : 0) + dir * s));
  };
  return (
    <span class="cp3-number-wrap">
      <span class={`cp3-number${props.disabled ? " is-disabled" : ""}`} style={props.width ? { width: `${props.width}px` } : undefined}>
        <input
          type="text"
          inputmode="decimal"
          value={shown()}
          disabled={props.disabled}
          onChange={(e) => commit(e.currentTarget.value, e.currentTarget)}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") { e.preventDefault(); step(1); }
            else if (e.key === "ArrowDown") { e.preventDefault(); step(-1); }
            else if (e.key === "Enter") commit(e.currentTarget.value, e.currentTarget);
          }}
        />
        <Show when={props.suffix}><span class="cp3-suffix">{props.suffix}</span></Show>
        <Show when={props.num && !props.disabled && !props.noSpin}>
          <span class="cp3-spin">
            <button type="button" tabIndex={-1} aria-label="Increase" class="cp3-spin-btn cp3-spin-up" onClick={() => step(1)}><Chevron /></button>
            <button type="button" tabIndex={-1} aria-label="Decrease" class="cp3-spin-btn" onClick={() => step(-1)}><Chevron /></button>
          </span>
        </Show>
      </span>
      <Show when={props.unit}><span class="cp3-unit">{props.unit}</span></Show>
    </span>
  );
}

/** Drawing Settings value field: `digits` fixed decimals, unset = the plain number ("0.382"). Every value field is
 *  100 x 34 (`narrow` kept for callers). */
export function DecimalInput(props: { value: number; digits?: number; narrow?: boolean; onCommit: (v: number) => void }) {
  const text = () => (props.digits == null ? String(props.value) : props.value.toFixed(props.digits));
  return (
    <input
      type="text"
      inputmode="decimal"
      class={"drawing-settings-level-coeff" + (props.narrow ? "" : " is-wide")}
      value={text()}
      onChange={(e) => {
        const v = parseFloat(e.currentTarget.value);
        if (Number.isFinite(v)) props.onCommit(v);
        else e.currentTarget.value = text();
      }}
    />
  );
}
