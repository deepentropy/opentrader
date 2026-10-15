/*
 * Visibility page of the drawing Settings dialog: the per-interval
 * visibility matrix (Ticks, one row per unit with a from / to range,
 * Ranges) and its range slider.
 */
import { createSignal, For, Show, type JSX } from "solid-js";
import { DEFAULT_VISIBILITY, type Drawing, type IntervalVisibility, type UnitVisibility } from "lightweight-charts-drawing/core/types";
import { CheckboxRow } from "./controls";
import { type SettingsCx } from "./context";

export function visibilityTab(cx: SettingsCx): JSX.Element {
  const { props } = cx;
  // Visibility tab (per-interval matrix). Reads fall back to the full
  // default matrix; the first edit materialises the field on the drawing.
  const vis = (): IntervalVisibility => props.drawing.visibility ?? DEFAULT_VISIBILITY;
  function patchVisibility(patch: Partial<IntervalVisibility>) {
    props.onUpdate({ ...props.drawing, visibility: { ...vis(), ...patch } } as Drawing);
  }
  return (
    <>
      {/* Matrix: checkbox + from/to inputs per unit row; Ticks and
          Ranges carry the checkbox only. 50px row pitch, 70×28 inputs.
          Lock/Hide moved out (toolbar + context menu). */}
      <CheckboxRow
        checked={vis().ticks}
        onChange={(v) => patchVisibility({ ticks: v })}
        label="Ticks"
      />
      <For
        each={[
          ["seconds", "Seconds", 59],
          ["minutes", "Minutes", 59],
          ["hours", "Hours", 24],
          ["days", "Days", 366],
          ["weeks", "Weeks", 52],
          ["months", "Months", 12],
        ] as ReadonlyArray<readonly [keyof IntervalVisibility, string, number]>}
      >
        {([key, label, max]) => (
          <UnitVisibilityRow
            label={label}
            max={max}
            unit={vis()[key] as UnitVisibility}
            onChange={(u) => patchVisibility({ [key]: u } as Partial<IntervalVisibility>)}
          />
        )}
      </For>
      <CheckboxRow
        checked={vis().ranges}
        onChange={(v) => patchVisibility({ ranges: v })}
        label="Ranges"
      />
    </>
  );
}

/** One Visibility-matrix row: enable checkbox + a from/to range inside the
 *  unit (clamped to 1..max, from ≤ to on commit). */
export function UnitVisibilityRow(props: {
  label: string;
  max: number;
  unit: UnitVisibility;
  onChange: (u: UnitVisibility) => void;
}) {
  const clamp = (n: number) => Math.max(1, Math.min(props.max, n));
  // Slider drag in progress: the fields follow it, the drawing is updated
  // on release.
  const [live, setLive] = createSignal<{ from: number; to: number } | null>(null);
  const commit = (field: "from" | "to", raw: string, el: HTMLInputElement) => {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) { el.value = String(props.unit[field]); return; }
    let from = field === "from" ? clamp(n) : props.unit.from;
    let to = field === "to" ? clamp(n) : props.unit.to;
    if (from > to) { if (field === "from") to = from; else from = to; }
    props.onChange({ ...props.unit, from, to });
  };
  return (
    <div class="drawing-settings-row drawing-settings-vis-row">
      <label class="drawing-settings-checkbox-row drawing-settings-vis-check">
        <span class={"drawing-settings-checkbox-box" + (props.unit.on ? " checked" : "")}>
          <Show when={props.unit.on}>
            <svg viewBox="0 0 16 16" width="12" height="12">
              <path fill="currentColor" d="M14.18 4.18 6 12.36l-4.18-4.18 1.4-1.41L6 9.54l6.77-6.78 1.41 1.42Z" />
            </svg>
          </Show>
          <input
            type="checkbox"
            checked={props.unit.on}
            onChange={(e) => props.onChange({ ...props.unit, on: e.currentTarget.checked })}
          />
        </span>
        <span class="drawing-settings-checkbox-label">{props.label}</span>
      </label>
      <div class="drawing-settings-row-inputs drawing-settings-vis-range">
        <input
          type="text"
          class="drawing-settings-input"
          aria-label={`${props.label} from`}
          disabled={!props.unit.on}
          value={String(live()?.from ?? props.unit.from)}
          onChange={(e) => commit("from", e.currentTarget.value, e.currentTarget)}
        />
        <RangeSlider
          min={1}
          max={props.max}
          from={live()?.from ?? props.unit.from}
          to={live()?.to ?? props.unit.to}
          disabled={!props.unit.on}
          onInput={(from, to) => setLive({ from, to })}
          onCommit={(from, to) => {
            setLive(null);
            if (from !== props.unit.from || to !== props.unit.to) props.onChange({ ...props.unit, from, to });
          }}
        />
        <input
          type="text"
          class="drawing-settings-input"
          aria-label={`${props.label} to`}
          disabled={!props.unit.on}
          value={String(live()?.to ?? props.unit.to)}
          onChange={(e) => commit("to", e.currentTarget.value, e.currentTarget)}
        />
      </div>
    </div>
  );
}

/** Visibility range slider: 10 px track
 *  (#3d3d3d, radius 5, at least 100 px), the #dbdbdb band between two 12 px
 *  thumbs (black, 2 px white border, shadow), thumb centres 6 px in from the
 *  ends. Value = min + round((x - 6) / (width - 12) * (max - min)); a thumb
 *  stops at the other one; a press (on the track or a thumb) moves the
 *  nearest thumb to the press point and drags it; the fields follow while dragging, the value is saved on
 *  release. Off (row unchecked): 50 % and inert. */
export function RangeSlider(props: {
  min: number;
  max: number;
  from: number;
  to: number;
  disabled?: boolean;
  onInput: (from: number, to: number) => void;
  onCommit: (from: number, to: number) => void;
}) {
  let track: HTMLDivElement | undefined;
  const [dragging, setDragging] = createSignal(false);
  const span = () => Math.max(1, props.max - props.min);
  const frac = (v: number) => Math.max(0, Math.min(1, (v - props.min) / span()));
  const valueAt = (clientX: number) => {
    if (!track) return props.min;
    const r = track.getBoundingClientRect();
    const f = (clientX - r.left - 6) / Math.max(1, r.width - 12);
    return Math.max(props.min, Math.min(props.max, props.min + Math.round(f * span())));
  };
  const onDown = (e: PointerEvent, thumb?: "from" | "to") => {
    if (props.disabled || e.button !== 0 || !track) return;
    e.preventDefault();
    e.stopPropagation();
    let which = thumb;
    if (!which) {
      // Track press: the nearest thumb.
      const r = track.getBoundingClientRect();
      const px = (v: number) => r.left + 6 + frac(v) * (r.width - 12);
      which = Math.abs(e.clientX - px(props.from)) <= Math.abs(e.clientX - px(props.to)) ? "from" : "to";
    }
    let from = props.from;
    let to = props.to;
    const apply = (clientX: number) => {
      const v = valueAt(clientX);
      if (which === "from") from = Math.min(v, to);
      else to = Math.max(v, from);
      props.onInput(from, to);
    };
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    setDragging(true);
    // The press itself sets the value (on a thumb too).
    apply(e.clientX);
    const move = (ev: PointerEvent) => apply(ev.clientX);
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      setDragging(false);
      props.onCommit(from, to);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  return (
    <div class={"ot-range" + (props.disabled ? " disabled" : "") + (dragging() ? " dragged" : "")}>
      <div class="ot-range-track" ref={track} onPointerDown={(e) => onDown(e)}>
        <div class="ot-range-middle-wrap">
          <div class="ot-range-middle" style={{ left: `${frac(props.from) * 100}%`, width: `${(frac(props.to) - frac(props.from)) * 100}%` }} />
        </div>
        <div class="ot-range-pointer-wrap">
          <div class="ot-range-pointer" style={{ left: `${frac(props.from) * 100}%` }} onPointerDown={(e) => onDown(e, "from")} />
        </div>
        <div class="ot-range-pointer-wrap">
          <div class="ot-range-pointer" style={{ left: `${frac(props.to) * 100}%` }} onPointerDown={(e) => onDown(e, "to")} />
        </div>
      </div>
    </div>
  );
}
