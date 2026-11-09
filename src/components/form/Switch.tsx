/*
 * On / off switches. Each family keeps its own track and knob:
 *   ticket  — the order ticket's take-profit / stop-loss switch, a control of its own (role=switch)
 *   menu    — drawn inside a watchlist settings row (the row is the control)
 *   toolbar — drawn inside a drawing toolbar submenu row
 *   header  — drawn inside a header menu row (one element, the knob is a pseudo-element)
 *   replay  — drawn inside a replay toolbar menu row
 */
import { Show, type JSX } from "solid-js";

type DrawnVariant = "menu" | "toolbar" | "header" | "replay";

const DRAWN: Record<DrawnVariant, { box: string; on: string; track?: string; knob?: string }> = {
  menu: { box: "wl-settings-switch", on: "on", track: "wl-settings-switch-track", knob: "wl-settings-switch-thumb" },
  toolbar: { box: "ind3-switch", on: "is-on", knob: "ind3-switch-thumb" },
  header: { box: "header-menu-switch", on: "is-on" },
  replay: { box: "ot-replay-switch", on: "is-on", knob: "ot-replay-switch__knob" },
};

/** A switch drawn inside a row that is itself the control, or around the native input given as `children` (the
 *  row is then a label). */
export function SwitchMark(props: { on: boolean; variant: DrawnVariant; children?: JSX.Element }) {
  const v = () => DRAWN[props.variant];
  return (
    <span class={`${v().box}${props.on ? ` ${v().on}` : ""}`} aria-hidden={props.children ? undefined : "true"}>
      {props.children}
      <Show when={v().track}><span class={v().track} /></Show>
      <Show when={v().knob}><span class={v().knob} /></Show>
    </span>
  );
}

/** A switch button (the order ticket's look). */
export function Switch(props: { on: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.on}
      aria-label={props.label}
      class="trd-switch"
      classList={{ "is-on": props.on }}
      onClick={() => props.onChange(!props.on)}
    >
      <span class="trd-switch-knob" />
    </button>
  );
}
