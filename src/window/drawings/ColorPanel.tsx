/*
 * ColorPanel — the color-picker panel (menuWrap 248-250px wide):
 *   • palette mode — the 8 swatch rows (17×17 swatches on a 23px
 *     pitch), then a persisted CUSTOM-colors row whose last tile is the
 *     17×17 "+ Add custom color" button, then "Opacity" (gradient track
 *     169×10 + drag pointer + 47×26 numeric input + "%"), then — for the
 *     in-dialog `color-with-thickness-select` variant — "Thickness" (4 radio
 *     bars 31×1..4) and "Line style" (3 radio line previews) sections, all in
 *     this ONE panel.
 *   • custom mode (248×246) — header row [preview 26×26 | #hex input | Add
 *     40×28] over a 200×184 saturation square and a vertical 17×184 hue strip
 *     (pointer 21×9). "Add" appends to the custom row, applies, and returns
 *     to the palette.
 */
import { createSignal, For, Show } from "solid-js";
import type { LineStyle } from "lightweight-charts-drawing/tv/types";
import { COLOR_ROWS } from "./palette";
import * as kv from "../../data/kv";
import { applyOpacity, hexToRgb, parseColor } from "lightweight-charts-drawing/tv/color";

// Color helpers (hex or rgba() values) live in the drawing core.
export { applyOpacity, hexToRgb, parseColor };
const sameColor = (a: string, b: string) => parseColor(a).hex === parseColor(b).hex;

// HSV <-> hex for the custom picker (h 0-360, s/v 0-1).
function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const [r8, g8, b8] = hexToRgb(hex);
  const r = r8 / 255, g = g8 / 255, b = b8 / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : d / max, v: max };
}
function hsvToHex(h: number, s: number, v: number): string {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] :
    h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const to = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, "0");
  return ("#" + to(r) + to(g) + to(b)).toUpperCase();
}

// ── Persisted custom colors (kept as an extra swatch row). ──────────────────
const CUSTOM_KEY = "ot:custom-colors";
const MAX_CUSTOM = 20;
function loadCustom(): string[] {
  try {
    const raw = kv.getItem(CUSTOM_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter((c): c is string => typeof c === "string").slice(0, MAX_CUSTOM) : [];
  } catch {
    return [];
  }
}
const [customColors, setCustomColors] = createSignal<string[]>(loadCustom());
kv.onExternalChange(CUSTOM_KEY, () => setCustomColors(loadCustom()));
function addCustomColor(hex: string): void {
  const up = hex.toUpperCase();
  const next = [...customColors().filter((c) => c !== up), up].slice(-MAX_CUSTOM);
  setCustomColors(next);
  kv.setItem(CUSTOM_KEY, JSON.stringify(next));
}

const THICKNESSES = [1, 2, 3, 4] as const;
const LINE_STYLES: ReadonlyArray<readonly [LineStyle, string | undefined]> = [
  ["solid", undefined], ["dashed", "6 4"], ["dotted", "2 3"],
];

type Props = {
  value: string;
  onChange: (c: string) => void;
  /** Fired after a swatch pick or custom Add — the host popover may close. */
  onPicked?: () => void;
  /** Hide the Opacity section (shown by default). */
  noOpacity?: boolean;
  /** Show the in-dialog Thickness section. */
  thickness?: number;
  onThickness?: (w: number) => void;
  /** Show the in-dialog Line style section. */
  lineStyle?: LineStyle;
  onLineStyle?: (s: LineStyle) => void;
};

export function ColorPanel(props: Props) {
  const [mode, setMode] = createSignal<"palette" | "custom">("palette");
  const [opacity, setOpacity] = createSignal(parseColor(props.value).opacity);
  const hex = () => parseColor(props.value).hex;

  const pick = (c: string) => {
    props.onChange(applyOpacity(parseColor(c).hex, opacity()));
    props.onPicked?.();
  };
  const setOpacityBoth = (o: number) => {
    const v = Math.max(0, Math.min(100, Math.round(o)));
    setOpacity(v);
    props.onChange(applyOpacity(hex(), v));
  };

  // Opacity track drag (gradient track + 12px pointer).
  let trackEl: HTMLDivElement | undefined;
  const trackFromEvent = (e: PointerEvent) => {
    if (!trackEl) return;
    const r = trackEl.getBoundingClientRect();
    setOpacityBoth(((e.clientX - r.left) / r.width) * 100);
  };
  const onTrackDown = (e: PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    trackFromEvent(e);
  };
  const onTrackMove = (e: PointerEvent) => {
    if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) trackFromEvent(e);
  };

  return (
    <Show when={mode() === "palette"} fallback={
      <CustomPicker
        initial={hex()}
        onAdd={(c) => {
          addCustomColor(c);
          props.onChange(applyOpacity(c, opacity()));
          setMode("palette");
          props.onPicked?.();
        }}
      />
    }>
      <div class="cp-grid" role="group" aria-label="Color swatches">
        <For each={COLOR_ROWS}>
          {(row, i) => (
            <div class={"cp-row" + (i() === 1 ? " cp-row-gap" : "")}>
              <For each={row}>
                {(c) => (
                  <button
                    type="button"
                    aria-label={c}
                    class={"cp-swatch" + (sameColor(c, props.value) ? " selected" : "")}
                    style={{ "background-color": c }}
                    onClick={() => pick(c)}
                  />
                )}
              </For>
            </div>
          )}
        </For>
        {/* Custom colors + the inline "+" tile, both in one row. */}
        <div class="cp-row cp-row-custom">
          <For each={customColors()}>
            {(c) => (
              <button
                type="button"
                aria-label={c}
                class={"cp-swatch" + (sameColor(c, props.value) ? " selected" : "")}
                style={{ "background-color": c }}
                onClick={() => pick(c)}
              />
            )}
          </For>
          <button
            type="button"
            class="cp-swatch cp-add"
            title="Add custom color"
            aria-label="Add custom color"
            onClick={() => setMode("custom")}
          >
            +
          </button>
        </div>
      </div>

      <Show when={!props.noOpacity}>
        <div class="cp-section-title">Opacity</div>
        <div class="cp-opacity">
          <div
            ref={trackEl}
            class="cp-opacity-track"
            role="slider"
            aria-label="Opacity"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={opacity()}
            onPointerDown={onTrackDown}
            onPointerMove={onTrackMove}
          >
            <div
              class="cp-opacity-gradient"
              style={{ "background-image": `linear-gradient(90deg, transparent, ${hex()})` }}
            />
            <div class="cp-opacity-pointer" style={{ left: `${opacity()}%` }} />
          </div>
          <div class="cp-opacity-input-wrap">
            <input
              class="cp-opacity-input"
              type="text"
              value={String(opacity())}
              aria-label="Opacity percent"
              onChange={(e) => {
                const n = parseInt(e.currentTarget.value, 10);
                if (Number.isFinite(n)) setOpacityBoth(n);
                // Always resync the field to the committed value. A clamp that
                // lands on the current opacity (e.g. "150"→100 while already 100,
                // "-5"→0 while already 0) leaves the signal unchanged, so the
                // `value` binding never re-runs to overwrite the stale text.
                e.currentTarget.value = String(opacity());
              }}
            />
            <span class="cp-opacity-pct">%</span>
          </div>
        </div>
      </Show>

      <Show when={props.onThickness}>
        <div class="cp-section-title">Thickness</div>
        <div class="cp-items">
          <For each={THICKNESSES}>
            {(w) => (
              <button
                type="button"
                role="radio"
                aria-checked={props.thickness === w}
                class={"cp-item" + (props.thickness === w ? " selected" : "")}
                onClick={() => props.onThickness?.(w)}
              >
                <span class="cp-bar" style={{ "border-top-width": `${w}px` }} />
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show when={props.onLineStyle}>
        <div class="cp-section-title">Line style</div>
        <div class="cp-items">
          <For each={LINE_STYLES}>
            {([id, dash]) => (
              <button
                type="button"
                role="radio"
                aria-checked={props.lineStyle === id}
                class={"cp-item cp-item-style" + (props.lineStyle === id ? " selected" : "")}
                aria-label={id}
                onClick={() => props.onLineStyle?.(id)}
              >
                <svg width="30" height="12" fill="none" aria-hidden="true">
                  <path d="M1 6h28" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray={dash} />
                </svg>
              </button>
            )}
          </For>
        </div>
      </Show>
    </Show>
  );
}

/** Custom-color picker: saturation square + vertical hue strip + hex + Add. */
function CustomPicker(props: { initial: string; onAdd: (hex: string) => void }) {
  const init = hexToHsv(props.initial);
  const [h, setH] = createSignal(init.h);
  const [s, setS] = createSignal(init.s);
  const [v, setV] = createSignal(init.v);
  // The hex input tracks HSV edits but accepts free typing until commit.
  const [hexText, setHexText] = createSignal(props.initial.replace("#", "").toLowerCase());

  const currentHex = () => hsvToHex(h(), s(), v());
  const syncHexText = () => setHexText(currentHex().replace("#", "").toLowerCase());

  let satEl: HTMLDivElement | undefined;
  let hueEl: HTMLDivElement | undefined;
  const satFromEvent = (e: PointerEvent) => {
    if (!satEl) return;
    const r = satEl.getBoundingClientRect();
    setS(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
    setV(Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height)));
    syncHexText();
  };
  const hueFromEvent = (e: PointerEvent) => {
    if (!hueEl) return;
    const r = hueEl.getBoundingClientRect();
    setH(Math.max(0, Math.min(359.9, ((e.clientY - r.top) / r.height) * 360)));
    syncHexText();
  };
  const drag = (handler: (e: PointerEvent) => void) => ({
    onPointerDown: (e: PointerEvent) => {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      handler(e);
    },
    onPointerMove: (e: PointerEvent) => {
      if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) handler(e);
    },
  });

  const commitHexText = (raw: string) => {
    const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(raw.trim());
    if (!m) { syncHexText(); return; }
    const next = hexToHsv("#" + m[1]);
    setH(next.h); setS(next.s); setV(next.v);
    syncHexText();
  };

  return (
    <div class="cp-custom">
      <div class="cp-custom-form">
        <div class="cp-custom-preview" style={{ "background-color": currentHex() }} />
        <div class="cp-custom-hex">
          <span class="cp-custom-hash">#</span>
          <input
            type="text"
            value={hexText()}
            aria-label="Hex color"
            onInput={(e) => setHexText(e.currentTarget.value)}
            onChange={(e) => commitHexText(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter") commitHexText((e.currentTarget as HTMLInputElement).value); }}
          />
        </div>
        <button type="button" class="cp-custom-add" onClick={() => props.onAdd(currentHex())}>
          Add
        </button>
      </div>
      <div class="cp-custom-area">
        <div
          ref={satEl}
          class="cp-custom-sat"
          style={{ "background-color": hsvToHex(h(), 1, 1) }}
          {...drag(satFromEvent)}
        >
          <div
            class="cp-custom-sat-pointer"
            style={{ left: `${s() * 100}%`, top: `${(1 - v()) * 100}%` }}
          />
        </div>
        <div ref={hueEl} class="cp-custom-hue" {...drag(hueFromEvent)}>
          <div class="cp-custom-hue-pointer" style={{ top: `${(h() / 360) * 100}%` }} />
        </div>
      </div>
    </div>
  );
}
