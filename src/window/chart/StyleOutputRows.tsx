/*
 * Style tab rows of the outputs other than line plots (style-outputs.ts): shapes, characters, arrows, background /
 * bar colours, candles, hlines, fills and drawing groups. Reference layout (its study property page, measured):
 * rows of 34 px controls with 8 px between them; a shape = colour 34 px + shape button 34 px + location select
 * 100 px; a character = colour + 34 px character field + location select; an hline = colour-and-line button 75 px +
 * value field 100 px; a gradient fill = two 34 px colours; palette colours, arrow colours and candle parts are rows
 * under the output's check row, 26 px in ("Color 0", "Up", "Body"), with an 8 px gap after the group.
 */
import { For, Show, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { CheckBox, ColorControl, NumberField, SelectControl } from "../header/ChartPropertiesDialog";
import type { PlotStyleOverride } from "./indicators/indicator-layer";
import type { ShapeLocation, ShapeStyle, StyleItem } from "./indicators/style-outputs";

/** Shapes in the reference menu order, with their names. */
export const SHAPES: { id: ShapeStyle; label: string }[] = [
  { id: "arrowdown", label: "Arrow Down" },
  { id: "arrowup", label: "Arrow Up" },
  { id: "circle", label: "Circle" },
  { id: "cross", label: "Cross" },
  { id: "diamond", label: "Diamond" },
  { id: "flag", label: "Flag" },
  { id: "labeldown", label: "Label Down" },
  { id: "labelup", label: "Label Up" },
  { id: "square", label: "Square" },
  { id: "triangledown", label: "Triangle Down" },
  { id: "triangleup", label: "Triangle Up" },
  { id: "xcross", label: "X Cross" },
];

/** Locations in the reference order, with their names. */
const LOCATIONS: { id: ShapeLocation; label: string }[] = [
  { id: "abovebar", label: "Above bar" },
  { id: "belowbar", label: "Below bar" },
  { id: "top", label: "Top" },
  { id: "bottom", label: "Bottom" },
  { id: "absolute", label: "Absolute" },
];
const LINE_STYLES = ["solid", "dashed", "dotted"] as const;

/** Our own 18 px outline glyph of each shape. */
function ShapeGlyph(props: { shape: ShapeStyle }) {
  const paths: Record<ShapeStyle, JSX.Element> = {
    arrowdown: <path d="M9 15 4 9.5h3V3h4v6.5h3L9 15Z" />,
    arrowup: <path d="M9 3 4 8.5h3V15h4V8.5h3L9 3Z" />,
    circle: <circle cx="9" cy="9" r="5.5" />,
    cross: <path d="M9 3.5v11M3.5 9h11" />,
    diamond: <path d="M9 3 15 9l-6 6-6-6 6-6Z" />,
    flag: <path d="M5 15.5V3m0 .5h8l-2 3 2 3H5" />,
    labeldown: <path d="M4 3.5h10v8h-3L9 14.5 7 11.5H4v-8Z" />,
    labelup: <path d="M4 14.5h10v-8h-3L9 3.5 7 6.5H4v8Z" />,
    square: <path d="M4 4h10v10H4z" />,
    triangledown: <path d="M3.5 5h11L9 14 3.5 5Z" />,
    triangleup: <path d="M3.5 13h11L9 4l-5.5 9Z" />,
    xcross: <path d="m4.5 4.5 9 9m0-9-9 9" />,
  };
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1" stroke-linejoin="round" aria-hidden="true">
      {paths[props.shape]}
    </svg>
  );
}

/** Shape button (34 px, the shape's glyph, no arrow) and its menu of shapes (glyph + name). */
function ShapeControl(props: { value: ShapeStyle; disabled?: boolean; onPick: (s: ShapeStyle) => void }) {
  let btn: HTMLButtonElement | undefined;
  let menu: HTMLDivElement | undefined;
  const [pos, setPos] = createSignal<{ left: number; top: number } | null>(null);
  const open = () => {
    if (!btn || props.disabled) return;
    const r = btn.getBoundingClientRect();
    setPos({ left: r.left, top: r.bottom + 1 });
  };
  const close = () => setPos(null);
  onMount(() => {
    const onDown = (e: MouseEvent) => {
      if (!pos()) return;
      const t = e.target as Node;
      if (menu?.contains(t) || btn?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && pos()) { e.stopPropagation(); close(); } };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    });
  });
  // The menu opens under the button, above it when there is no room below.
  const place = (el: HTMLDivElement) => {
    menu = el;
    queueMicrotask(() => {
      const p = pos();
      if (!p || !btn) return;
      const h = el.offsetHeight;
      if (p.top + h > window.innerHeight - 4) setPos({ left: p.left, top: Math.max(4, btn.getBoundingClientRect().top - h - 1) });
    });
  };
  return (
    <>
      <button
        ref={btn}
        type="button"
        class={`ind3-plottype ind3-shape-btn${props.disabled ? " is-disabled" : ""}`}
        data-name="shape-style-select"
        aria-haspopup="listbox"
        aria-expanded={!!pos()}
        aria-label={SHAPES.find((s) => s.id === props.value)?.label}
        disabled={props.disabled}
        onClick={() => (pos() ? close() : open())}
      >
        <ShapeGlyph shape={props.value} />
      </button>
      <Show when={pos()}>
        {(p) => (
          <div ref={place} class="ind3-plottype-menu ind3-shape-menu" role="listbox" style={{ left: `${p().left}px`, top: `${p().top}px` }}>
            <For each={SHAPES}>
              {(s) => (
                <div
                  role="option"
                  aria-selected={s.id === props.value}
                  class={`ind3-plottype-item${s.id === props.value ? " is-selected" : ""}`}
                  onClick={() => { props.onPick(s.id); close(); }}
                >
                  <span class="ind3-shape-icon"><ShapeGlyph shape={s.id} /></span>
                  <span class="ind3-plottype-label">{s.label}</span>
                </div>
              )}
            </For>
          </div>
        )}
      </Show>
    </>
  );
}

/** Location select (100 px). */
function LocationControl(props: { value: ShapeLocation; disabled?: boolean; onPick: (l: ShapeLocation) => void }) {
  return (
    <SelectControl
      value={props.value}
      options={LOCATIONS.map((l) => l.id)}
      labelOf={(o) => LOCATIONS.find((l) => l.id === o)?.label ?? o}
      width={100}
      disabled={props.disabled}
      onPick={(o) => props.onPick(o as ShapeLocation)}
    />
  );
}

/** One-character field (34 px): the last character typed is kept (reference). */
function CharControl(props: { value: string; disabled?: boolean; onChange: (c: string) => void }) {
  return (
    <span class={`cp3-number ind3-char${props.disabled ? " is-disabled" : ""}`}>
      <input
        type="text"
        value={props.value}
        disabled={props.disabled}
        aria-label="Character"
        onInput={(e) => {
          const chars = Array.from(e.currentTarget.value.trim());
          const c = chars.length ? chars[chars.length - 1] : "";
          e.currentTarget.value = c;
          props.onChange(c);
        }}
      />
    </span>
  );
}

export type OutputRowsProps = {
  item: Exclude<StyleItem, { kind: "plot" }>;
  /** The output's override in the draft (empty = defaults). */
  ov: PlotStyleOverride;
  set: (patch: Partial<PlotStyleOverride>) => void;
  /** Colour `i` of a palette (`field`: palette / wickPalette / borderPalette). */
  setPalette: (field: "palette" | "wickPalette" | "borderPalette", i: number, color: string, size: number) => void;
};

/** Check box + title (the output's visibility). `full`: alone on its row. */
function CheckLabel(props: { title: string; checked: boolean; toggle: () => void; full?: boolean }) {
  return (
    <div class={`cp3-cell cp3-label${props.full ? " is-full ind3-check-row" : ""}`}>
      <div class="cp3-label-inner">
        <CheckBox checked={props.checked} onToggle={props.toggle} />
        <span class="cp3-title" onClick={props.toggle}>{props.title}</span>
      </div>
    </div>
  );
}

/** An offset row: title + one colour. */
function ColorRow(props: { title: string; color: string; disabled?: boolean; onColor: (c: string) => void }) {
  return (
    <>
      <div class="cp3-cell cp3-label is-offset is-grouped"><div class="cp3-label-inner"><span class="cp3-title">{props.title}</span></div></div>
      <div class="cp3-cell cp3-controls is-grouped">
        <ColorControl color={props.color} disabled={props.disabled} onChange={(p) => { if (p.color) props.onColor(p.color); }} />
      </div>
    </>
  );
}

/** "Color 0", "Color 1", ... rows of a palette. */
function PaletteRows(props: { colors: string[]; override?: string[]; disabled?: boolean; onColor: (i: number, c: string) => void }) {
  return (
    <For each={props.colors}>
      {(c, i) => <ColorRow title={`Color ${i()}`} color={props.override?.[i()] ?? c} disabled={props.disabled} onColor={(x) => props.onColor(i(), x)} />}
    </For>
  );
}

const GroupGap = () => <div class="ind3-group-sep" />;

/** The rows of one output. */
export function OutputRows(props: OutputRowsProps): JSX.Element {
  // a shape hidden by default (display none) starts unchecked
  const visible = () => props.ov.visible ?? !(props.item.kind === "shape" && props.item.decl.display === "none");
  const toggle = () => props.set({ visible: !visible() });
  const off = () => !visible();
  // The output's kind does not change: the rows are built once (their controls follow the draft).
  const item = props.item;
  {
    switch (item.kind) {
      case "shape": {
        const d = item.decl;
        // untitled: the reference names ("Shapes" / "Chars")
        const title = d.title ?? (d.kind === "char" ? "Chars" : "Shapes");
        return (
          <>
            <CheckLabel title={title} checked={visible()} toggle={toggle} />
            <div class="cp3-cell cp3-controls">
              <Show when={d.color !== undefined && !d.palette}>
                <ColorControl color={props.ov.color ?? d.color!} disabled={off()} onChange={(p) => { if (p.color) props.set({ color: p.color }); }} />
              </Show>
              <Show when={d.kind === "shape"} fallback={<CharControl value={props.ov.char ?? d.char ?? ""} disabled={off()} onChange={(c) => props.set({ char: c })} />}>
                <ShapeControl value={(props.ov.shape as ShapeStyle | undefined) ?? d.style ?? "xcross"} disabled={off()} onPick={(s) => props.set({ shape: s })} />
              </Show>
              <LocationControl value={(props.ov.location as ShapeLocation | undefined) ?? d.location} disabled={off()} onPick={(l) => props.set({ location: l })} />
            </div>
            <Show when={d.palette}>
              {(pal) => (
                <>
                  <PaletteRows colors={pal()} override={props.ov.palette} disabled={off()} onColor={(i, c) => props.setPalette("palette", i, c, pal().length)} />
                  <GroupGap />
                </>
              )}
            </Show>
          </>
        );
      }
      case "arrow": {
        const d = item.decl;
        return (
          <>
            <CheckLabel title={d.title ?? "Arrows"} checked={visible()} toggle={toggle} full />
            <ColorRow title="Up" color={props.ov.colorUp ?? d.colorup} disabled={off()} onColor={(c) => props.set({ colorUp: c })} />
            <ColorRow title="Down" color={props.ov.colorDown ?? d.colordown} disabled={off()} onColor={(c) => props.set({ colorDown: c })} />
            <GroupGap />
          </>
        );
      }
      case "colors": {
        const d = item.decl;
        return (
          <>
            <CheckLabel title={d.title ?? (d.kind === "bgcolor" ? "Background Color" : "Bar Color")} checked={visible()} toggle={toggle} full />
            <Show when={d.palette}>
              {(pal) => (
                <>
                  <PaletteRows colors={pal()} override={props.ov.palette} disabled={off()} onColor={(i, c) => props.setPalette("palette", i, c, pal().length)} />
                  <GroupGap />
                </>
              )}
            </Show>
          </>
        );
      }
      case "candle": {
        const d = item.decl;
        // Body / Wick / Border: a colour, or a palette under the part's title.
        const part = (title: string, field: "color" | "wickColor" | "borderColor", palField: "palette" | "wickPalette" | "borderPalette") => {
          const pal = d.palettes?.[field];
          if (pal) {
            return (
              <>
                <div class="cp3-cell cp3-label is-full is-offset ind3-part-title"><div class="cp3-label-inner"><span class="cp3-title">{title}</span></div></div>
                <PaletteRows colors={pal} override={props.ov[palField]} disabled={off()} onColor={(i, c) => props.setPalette(palField, i, c, pal.length)} />
              </>
            );
          }
          const def = d[field];
          if (def === undefined) return null;
          return <ColorRow title={title} color={(props.ov[field] as string | undefined) ?? def} disabled={off()} onColor={(c) => props.set({ [field]: c })} />;
        };
        return (
          <>
            <CheckLabel title={d.title ?? (d.kind === "bar" ? "PlotBar" : "PlotCandle")} checked={visible()} toggle={toggle} full />
            {part("Body", "color", "palette")}
            <Show when={d.kind !== "bar"}>
              {part("Wick", "wickColor", "wickPalette")}
              {part("Border", "borderColor", "borderPalette")}
            </Show>
            <GroupGap />
          </>
        );
      }
      case "hline": {
        const d = item.decl;
        const style = () => LINE_STYLES.indexOf((props.ov.lineStyle ?? d.linestyle ?? "solid") as (typeof LINE_STYLES)[number]);
        return (
          <>
            <CheckLabel title={d.title ?? "Level"} checked={visible()} toggle={toggle} />
            <div class="cp3-cell cp3-controls">
              <ColorControl
                color={props.ov.color ?? d.color ?? "#787B86"}
                width={props.ov.lineWidth ?? d.linewidth ?? 1}
                style={style()}
                disabled={off()}
                onChange={(p) => {
                  if (p.color) props.set({ color: p.color });
                  if (p.width !== undefined) props.set({ lineWidth: Math.max(1, Math.min(4, Math.round(p.width))) });
                  if (p.style !== undefined) props.set({ lineStyle: LINE_STYLES[p.style] });
                }}
              />
              <NumberField
                value={String(props.ov.price ?? d.price)}
                width={100}
                disabled={off()}
                num={{ min: -1e15, max: 1e15, step: 1 }}
                onChange={(v) => { const n = parseFloat(v); if (Number.isFinite(n)) props.set({ price: n }); }}
              />
            </div>
          </>
        );
      }
      case "fill": {
        const d = item.decl;
        const title = d.title ?? "Background";
        if (d.palette) {
          return (
            <>
              <CheckLabel title={title} checked={visible()} toggle={toggle} full />
              <PaletteRows colors={d.palette} override={props.ov.palette} disabled={off()} onColor={(i, c) => props.setPalette("palette", i, c, d.palette!.length)} />
              <GroupGap />
            </>
          );
        }
        return (
          <>
            <CheckLabel title={title} checked={visible()} toggle={toggle} />
            <div class="cp3-cell cp3-controls">
              <Show when={d.color !== undefined}>
                <ColorControl color={props.ov.color ?? d.color!} disabled={off()} onChange={(p) => { if (p.color) props.set({ color: p.color }); }} />
              </Show>
              <Show when={d.topColor !== undefined}>
                <ColorControl color={props.ov.topColor ?? d.topColor!} disabled={off()} onChange={(p) => { if (p.color) props.set({ topColor: p.color }); }} />
              </Show>
              <Show when={d.bottomColor !== undefined}>
                <ColorControl color={props.ov.bottomColor ?? d.bottomColor!} disabled={off()} onChange={(p) => { if (p.color) props.set({ bottomColor: p.color }); }} />
              </Show>
            </div>
          </>
        );
      }
      case "drawing":
        return <CheckLabel title={item.title} checked={visible()} toggle={toggle} full />;
    }
  }
}
