/*
 * Colour buttons and the shared colour panel they open (palette, custom colours, Opacity, and with a line width
 * the Thickness and Line style sections). The panel is fixed under its button, kept in the window, and scrolls
 * inside when it does not fit; a press outside or Escape closes it.
 *
 * Two looks: "dialog" (Settings dialogs: a 34 px box, or the 75 px colour + line button; `color === ""` is
 * automatic) and "drawing" (drawing Settings: the swatch button and the colour-with-thickness button).
 */
import { Show, createSignal, type JSX } from "solid-js";
import type { LineStyle } from "lightweight-charts-drawing/core/types";
import { ColorPanel } from "../../window/drawings/ColorPanel";
import { createPopover } from "../popover";

/** Fixed host of the colour panel under its trigger. */
function ColorPanelHost(props: { anchor: () => HTMLElement | undefined; class: string; onDismiss: () => void; children: JSX.Element }) {
  const popover = createPopover(props.anchor, { onClose: props.onDismiss, placement: false });
  const r = props.anchor()?.getBoundingClientRect();
  const left = Math.max(8, Math.min(r?.left ?? 0, window.innerWidth - 258));
  const top = Math.min((r?.bottom ?? 0) + 4, window.innerHeight - 120);
  return (
    <div ref={popover} class={props.class} style={{ position: "fixed", left: `${left}px`, top: `${top}px`, "max-height": `${window.innerHeight - top - 8}px` }}>
      {props.children}
    </div>
  );
}

const borderStyle = (s: LineStyle | undefined) => (s === "dashed" ? "dashed" : s === "dotted" ? "dotted" : "solid");

export function ColorButton(props: {
  variant: "dialog" | "drawing";
  color: string;
  /** With a width (or a line style in the dialog look): the colour + line button and the Thickness section. */
  width?: number;
  lineStyle?: LineStyle;
  noOpacity?: boolean;
  disabled?: boolean;
  /** Mixed colours (a multi-selection): the drawing swatch is split red / teal. */
  mixed?: boolean;
  onColor: (c: string) => void;
  onWidth?: (w: number) => void;
  /** Omitted → no "Line style" section. */
  onLineStyle?: (s: LineStyle) => void;
}) {
  let btn: HTMLButtonElement | undefined;
  const [open, setOpen] = createSignal(false);
  const dialog = () => props.variant === "dialog";
  const combined = () => props.width !== undefined || (dialog() && props.lineStyle !== undefined);

  const panel = () => (
    <Show when={open()}>
      <ColorPanelHost anchor={() => btn} class={dialog() ? "dt-popover dlg-color-panel cp3-color-panel" : "dt-popover dlg-color-panel"} onDismiss={() => setOpen(false)}>
        <ColorPanel
          value={dialog() ? props.color || "#000000" : props.color}
          noOpacity={props.noOpacity}
          onChange={props.onColor}
          onPicked={() => setOpen(false)}
          thickness={props.width}
          onThickness={props.width !== undefined && props.onWidth ? (w) => { props.onWidth!(w); setOpen(false); } : undefined}
          lineStyle={props.lineStyle}
          onLineStyle={props.onLineStyle ? (s) => { props.onLineStyle!(s); setOpen(false); } : undefined}
        />
      </ColorPanelHost>
    </Show>
  );

  if (dialog())
    return (
      <>
        <button
          ref={btn}
          type="button"
          class={`cp3-color${combined() ? " is-combined" : ""}${open() ? " is-open" : ""}${props.disabled ? " is-disabled" : ""}`}
          data-name={combined() ? "color-with-thickness-select" : "color-select"}
          aria-haspopup="dialog"
          aria-expanded={open()}
          disabled={props.disabled}
          onClick={() => setOpen((o) => !o)}
        >
          <Show when={props.color} fallback={<span class="cp3-swatch cp3-swatch-auto" />}>
            <span class="cp3-swatch" style={{ "--swatch-color": props.color }} />
          </Show>
          <Show when={combined()}>
            <span class="cp3-line" style={{ "border-top": `${Math.max(1, props.width ?? 1)}px ${borderStyle(props.lineStyle)}` }} />
          </Show>
        </button>
        {panel()}
      </>
    );

  if (combined())
    return (
      <span class="drawing-settings-color-thickness">
        <button
          type="button"
          class="dlg-color-thickness-btn"
          data-name="color-with-thickness-select"
          aria-haspopup="dialog"
          aria-expanded={open()}
          ref={btn}
          onClick={() => setOpen((o) => !o)}
        >
          <span class="dlg-ct-swatch" style={{ "--swatch-color": props.color }} />
          <span class="dlg-ct-line" style={{ "border-top": `${Math.max(props.width ?? 1, 1)}px ${borderStyle(props.lineStyle)} ${props.color}` }} />
        </button>
        {panel()}
      </span>
    );

  return (
    <>
      <button
        type="button"
        class="drawing-settings-color-swatch"
        aria-label="Color"
        aria-haspopup="dialog"
        aria-expanded={open()}
        ref={btn}
        onClick={() => setOpen((o) => !o)}
      >
        <span
          class="drawing-settings-color-swatch-fill"
          // Mixed-colour placeholder: red / teal split along the diagonal.
          style={props.mixed ? { background: "linear-gradient(to top right, #f7525f 50%, #22ab94 50%)" } : { "--swatch-color": props.color }}
        />
      </button>
      {panel()}
    </>
  );
}

const STYLE_IDS: LineStyle[] = ["solid", "dashed", "dotted"];

/** The dialog look with the chart settings' value shape: line style as an index (0 solid, 1 dashed, 2 dotted)
 *  and one `onChange` patch. */
export function ColorControl(props: {
  color: string;
  width?: number;
  style?: number;
  noOpacity?: boolean;
  disabled?: boolean;
  onChange: (patch: { color?: string; width?: number; style?: number }) => void;
}) {
  return (
    <ColorButton
      variant="dialog"
      color={props.color}
      width={props.width}
      lineStyle={props.style !== undefined ? STYLE_IDS[props.style] : undefined}
      noOpacity={props.noOpacity}
      disabled={props.disabled}
      onColor={(c) => props.onChange({ color: c })}
      onWidth={(w) => props.onChange({ width: w })}
      onLineStyle={props.style !== undefined ? (s) => props.onChange({ style: STYLE_IDS.indexOf(s) }) : undefined}
    />
  );
}
