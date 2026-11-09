/*
 * Check boxes. One box drawn per family of panels, each keeping its own size, colours and mark:
 *   dialog   — 18 px, white when checked (Settings dialogs, prompts, lists)
 *   drawing  — 18 px with the filled tick (drawing Settings)
 *   settings — 16 px, accent fill (app Settings)
 *   menu     — 18 px decorative box inside a menu row (watchlist settings)
 *   ticket   — 18 px decorative box inside an order ticket menu row
 *   screener — decorative box inside a screener popover row
 *
 * `CheckBox` is the focusable box alone; `CheckField` is a label row around a native check box (the label is
 * clickable); `CheckMarkBox` is only the drawn box, for a row that is itself the control (role=menuitemcheckbox).
 */
import { Show, type JSX } from "solid-js";
import { Icon } from "../Icon";
import { CheckMark, RoundTick, StrokeTick, TickMark } from "./glyphs";

export type CheckVariant = "dialog" | "drawing" | "settings" | "menu" | "ticket" | "screener";

const BOX: Record<CheckVariant, { box: string; on: string; mark: () => JSX.Element }> = {
  dialog: { box: "cp3-checkbox", on: "is-checked", mark: CheckMark },
  drawing: { box: "drawing-settings-checkbox-box", on: "checked", mark: TickMark },
  settings: { box: "app-settings-checkbox", on: "is-checked", mark: StrokeTick },
  menu: { box: "wl-settings-check", on: "checked", mark: CheckMark },
  ticket: { box: "trd-menu-check", on: "is-on", mark: RoundTick },
  screener: { box: "scr-checkbox", on: "is-checked", mark: () => <Icon name="scr-check" size={18} /> },
};

/** Label rows of the families that have one. */
const ROW: Record<"drawing" | "settings", { row: string; disabled: string; label: string }> = {
  drawing: { row: "drawing-settings-checkbox-row", disabled: "disabled", label: "drawing-settings-checkbox-label" },
  settings: { row: "app-settings-check", disabled: "is-disabled", label: "app-settings-check-label" },
};

const boxClass = (v: CheckVariant, checked: boolean) => `${BOX[v].box}${checked ? ` ${BOX[v].on}` : ""}`;

/** The drawn box with its mark, no behaviour of its own. */
export function CheckMarkBox(props: { checked: boolean; variant: CheckVariant; children?: JSX.Element }) {
  return (
    <span class={boxClass(props.variant, props.checked)} aria-hidden={props.children ? undefined : "true"}>
      <Show when={props.checked}>{BOX[props.variant].mark()}</Show>
      {props.children}
    </span>
  );
}

/** Focusable check box (Space / Enter toggle), the Settings dialogs' look. */
export function CheckBox(props: { checked: boolean; disabled?: boolean; onToggle: () => void; tabIndex?: number }) {
  return (
    <span
      class={`${boxClass("dialog", props.checked)}${props.disabled ? " is-disabled" : ""}`}
      role="checkbox"
      aria-checked={props.checked}
      tabIndex={props.tabIndex ?? 0}
      onClick={() => !props.disabled && props.onToggle()}
      onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); if (!props.disabled) props.onToggle(); } }}
    >
      <Show when={props.checked}><CheckMark /></Show>
    </span>
  );
}

/** A label row around a native check box drawn as the family's box; without `label`, the box alone. */
export function CheckField(props: {
  checked: boolean;
  onChange: (v: boolean) => void;
  variant: "drawing" | "settings";
  label?: string;
  disabled?: boolean;
  /** More classes on the row. */
  class?: string;
}) {
  const row = () => ROW[props.variant];
  return (
    <label class={`${row().row}${props.class ? ` ${props.class}` : ""}${props.disabled ? ` ${row().disabled}` : ""}`}>
      <CheckMarkBox checked={props.checked} variant={props.variant}>
        <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.currentTarget.checked)} />
      </CheckMarkBox>
      <Show when={props.label != null}>
        <span class={row().label}>{props.label}</span>
      </Show>
    </label>
  );
}
