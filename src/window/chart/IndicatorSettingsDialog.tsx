/*
 * IndicatorSettingsDialog — the study "Settings" modal opened from the studies
 * legend gear (IndicatorLegend -> onSettings). Generic over the indicator
 * registry: every field is derived from the entry's `inputConfig` (Inputs tab)
 * and `plotConfig` (Style tab), so each indicator gets a working dialog with
 * no per-indicator code.
 *
 * Look: TV Desktop 3.4.1 study dialog (measured 26/09/2026):
 * width fits the content,
 * header 68 px (title 20/600), underlined tabs 16/600 with a 4 px #F2F2F2 bar
 * on a 4 px #4A4A4A track, rows of 34 px TV controls (white check boxes,
 * outlined selects / number fields, boxed colour swatches), footer "Defaults"
 * menu + Cancel / Ok. The controls are the chart Settings dialog's (same TV
 * ui-lib components). Edits a local draft; Cancel discards, Ok commits.
 */
import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { createStore } from "solid-js/store";
import type { InputConfig, PlotConfig } from "lightweight-charts-indicators";
import type { IndicatorStyleOverrides } from "./indicators/indicator-layer";
import { CheckBox, ColorControl, NumberField, SelectControl } from "../header/ChartPropertiesDialog";
import { RangeSlider } from "../drawings/SettingsDialog";
import type { IntervalVisibility, UnitVisibility } from "lightweight-charts-drawing/tv/types";
import {
  cloneIndicatorOptions,
  defaultIndicatorOptions,
  PRECISION_OPTIONS,
  type IndicatorOptions,
} from "./indicators/indicator-options";

type Next = { inputs: Record<string, unknown>; styles: IndicatorStyleOverrides; options: IndicatorOptions };

/** Materialised per-plot style row in the draft (always fully populated). */
type StyleRow = { color: string; lineWidth: number; visible: boolean; plotType: string; priceLine: boolean };

type Props = {
  /** Study display name, shown in the header. */
  title: string;
  /** The indicator's input schema (registry entry's inputConfig). */
  inputConfig: InputConfig[];
  /** The indicator's plot schema (registry entry's plotConfig) — Style tab. */
  plotConfig: PlotConfig[];
  /** Current inputs (registry defaults merged with the study's overrides). */
  inputs: Record<string, unknown>;
  /** Current per-plot style overrides (empty = registry defaults). */
  styles: IndicatorStyleOverrides;
  /** Commit the edited inputs + plot styles (Ok). */
  onApply: (next: Next) => void;
  /** Current Style-tab output / input options + Visibility tab. */
  options: IndicatorOptions;
  /** "Defaults" -> "Save as default": the current values become what a newly
   *  added instance of this indicator starts with. */
  onSaveAsDefault: (next: Next) => void;
  onClose: () => void;
};

// TV price-source choices and their labels (TV 3.4.1 source select, read
// 26/09/2026). Values stay the PineScript names.
const SOURCE_OPTIONS = ["open", "high", "low", "close", "hl2", "hlc3", "ohlc4", "hlcc4"];
const SOURCE_LABELS: Record<string, string> = {
  open: "Open", high: "High", low: "Low", close: "Close",
  hl2: "(H + L)/2", hlc3: "(H + L + C)/3", ohlc4: "(O + H + L + C)/4", hlcc4: "(H + L + C + C)/4",
};

const Chevron = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3.92 7.83 9 12.29l5.08-4.46-1-1.13L9 10.29l-4.09-3.6-.99 1.14Z" /></svg>
);

/** TV select width: the SHOWN value + button padding (content 7 left, 6
 *  before the 20 px caret, 2 right), 100 px minimum. TV's "Close" source
 *  select is 100 px although its list holds "(H + L + C + C)/4", so the
 *  width follows the value, not the longest option. */
let measureCtx: CanvasRenderingContext2D | null = null;
function selectWidth(labels: string[]): number {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return 100;
  measureCtx.font = `14px ${getComputedStyle(document.body).fontFamily}`;
  const text = Math.max(0, ...labels.map((l) => measureCtx!.measureText(l).width));
  return Math.max(100, Math.ceil(text + 7 + 6 + 20 + 2 + 2));
}

/** TV plot types (Settings -> Style plot-type menu, read 26/09/2026, with
 *  their 28 px icons) -> the Pine style ids the renderer draws. */
const PLOT_TYPES: ReadonlyArray<{ id: string; label: string; icon: string }> = [
  { id: "line", label: "Line", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" fill="none"><path stroke="currentColor" d="M5.5 16.5l4.586-4.586a2 2 0 0 1 2.828 0l3.172 3.172a2 2 0 0 0 2.828 0L23.5 10.5"/></svg>' },
  { id: "linebr", label: "Line with breaks", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" fill="none"><path stroke="currentColor" d="M5.5 16.5l5-5a1.414 1.414 0 0 1 2 0m11-1l-5 5a1.414 1.414 0 0 1-2 0"/><path fill="currentColor" d="M14 5h1v2h-1zM14 10h1v2h-1zM14 15h1v2h-1zM14 20h1v2h-1z"/></svg>' },
  { id: "stepline", label: "Step line", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" fill="none"><path stroke="currentColor" d="M5.5 17v5.5h4v-18h4v12h4v-9h4V21"/></svg>' },
  { id: "steplinebr", label: "Step line with breaks", icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28"><path fill="currentColor" d="M14 3h1v2h-1V3Zm1 5h-1v2h1V8Zm-1 5h1v2h-1v-2Zm0 5h1v2h-1v-2Zm0 5h1v2h-1v-2ZM10 5h2V4H9v18H6v-5H5v6h5V5Zm11 16h1V7h-5v10h1V8h3v13Z"/></svg>' },
  { id: "steplinediamond", label: "Step line with diamonds", icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28" fill="none"><path fill="currentColor" fill-rule="evenodd" d="M9.8 2.7l.7-.7.7.7 2.1 2.1.2.2H18v9.5l.2.2 2.1 2.1.2.2H24v1h-3.5l-.2.2-2.1 2.1-.7.7-.7-.7-2.1-2.1-.7-.7.7-.7 2.1-2.1.2-.2V6h-3.5l-.2.2-2.1 2.1-.2.2V24H5.5v-1H10V8.5l-.2-.2-2.1-2.1-.7-.7.7-.7 2.1-2.1zM8.4 5.5l2.09 2.09 2.09-2.09-2.09-2.09L8.41 5.5zm9.09 14.09l-2.09-2.09 2.09-2.09 2.09 2.09-2.09 2.09z"/></svg>' },
  { id: "histogram", label: "Histogram", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28"><path stroke="currentColor" d="M4.5 20v-7m3 7V10m3 10V8m3 12V10m3 10v-8m3 8V10m3 10V8"/></svg>' },
  { id: "cross", label: "Cross", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28"><path stroke="currentColor" d="M17 8.5h7M20.5 12V5M10 19.5h7M13.5 23v-7M3 12.5h7M6.5 16V9"/></svg>' },
  { id: "area", label: "Area", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" fill="none"><path stroke="currentColor" d="M5.5 13.52v4.98a1 1 0 0 0 1 1h15a1 1 0 0 0 1-1V8.914c0-.89-1.077-1.337-1.707-.707l-4.66 4.66a1 1 0 0 1-1.332.074l-3.716-2.973a1 1 0 0 0-1.198-.039l-3.96 2.772a1 1 0 0 0-.427.82z"/></svg>' },
  { id: "areabr", label: "Area with breaks", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" fill="none"><path stroke="currentColor" d="M13 11.5l-1.915-1.532a1 1 0 0 0-1.198-.039l-3.96 2.772a1 1 0 0 0-.427.82V18.5a1 1 0 0 0 1 1H13m3.5-7l4.293-4.293c.63-.63 1.707-.184 1.707.707V18.5a1 1 0 0 1-1 1H16"/><path fill="currentColor" d="M14 6h1v2h-1zM14 11h1v2h-1zM14 16h1v2h-1zM14 21h1v2h-1z"/></svg>' },
  { id: "columns", label: "Columns", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" fill="none"><path stroke="currentColor" d="M6.5 12.5v8h3v-8h-3zM12.5 7.5v13h3v-13h-3zM18.5 15.5v5h3v-5h-3z"/></svg>' },
  { id: "circles", label: "Circles", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" fill="none"><path stroke="currentColor" d="M10.5 13a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM16.5 19a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM22.5 8a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z"/></svg>' },
];
const plotTypeOf = (id: string) => PLOT_TYPES.find((t) => t.id === id) ?? PLOT_TYPES[0];

/** TV plot-type button (34 x 34 box, the current type's 28 px icon) and its
 *  menu: "Price line" switch row, separator, the plot types (selected row
 *  #F2F2F2 / black). Menu under the button, kept inside the window. */
function PlotTypeControl(props: { value: string; priceLine: boolean; onPick: (t: string) => void; onPriceLine: (v: boolean) => void }) {
  let btn: HTMLButtonElement | undefined;
  let menu: HTMLDivElement | undefined;
  const [pos, setPos] = createSignal<{ left: number; top: number } | null>(null);
  const open = () => {
    const r = btn!.getBoundingClientRect();
    setPos({ left: r.left, top: r.bottom + 4 });
    requestAnimationFrame(() => {
      if (!menu) return;
      const m = menu.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      setPos({ left: Math.max(0, Math.min(r.left, vw - m.width)), top: Math.max(0, Math.min(r.bottom + 4, vh - m.height)) });
    });
  };
  const close = () => setPos(null);
  onMount(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menu?.contains(t) || btn?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && pos()) { e.stopPropagation(); close(); } };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => { window.removeEventListener("mousedown", onDown, true); window.removeEventListener("keydown", onKey, true); });
  });
  return (
    <>
      <button
        ref={btn}
        type="button"
        class={`ind3-plottype${pos() ? " is-open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={!!pos()}
        aria-label={plotTypeOf(props.value).label}
        title={plotTypeOf(props.value).label}
        onClick={() => (pos() ? close() : open())}
      >
        <span class="ind3-plottype-icon" innerHTML={plotTypeOf(props.value).icon} />
      </button>
      <Show when={pos()}>
        {(p) => (
          <div ref={menu} class="ind3-plottype-menu" role="listbox" style={{ left: `${p().left}px`, top: `${p().top}px` }}>
            <label class="ind3-plottype-switch-row">
              <span class="ind3-plottype-switch-label">Price line</span>
              <span class={`ind3-switch${props.priceLine ? " is-on" : ""}`}>
                <input type="checkbox" role="switch" checked={props.priceLine} onChange={(e) => props.onPriceLine(e.currentTarget.checked)} />
                <span class="ind3-switch-thumb" />
              </span>
            </label>
            <div class="ind3-plottype-sep" role="separator" />
            <For each={PLOT_TYPES}>
              {(t) => (
                <div
                  role="option"
                  aria-selected={t.id === props.value}
                  class={`ind3-plottype-item${t.id === props.value ? " is-selected" : ""}`}
                  onClick={() => { props.onPick(t.id); close(); }}
                >
                  <span class="ind3-plottype-icon" innerHTML={t.icon} />
                  <span class="ind3-plottype-label">{t.label}</span>
                </div>
              )}
            </For>
          </div>
        )}
      </Show>
    </>
  );
}

/** Visibility rows with a range (TV units and maxima). */
const VIS_UNITS: ReadonlyArray<readonly [keyof IntervalVisibility, string, number]> = [
  ["seconds", "Seconds", 59],
  ["minutes", "Minutes", 59],
  ["hours", "Hours", 24],
  ["days", "Days", 366],
  ["weeks", "Weeks", 52],
  ["months", "Months", 12],
];

/** Full-width 34 px check row (TV Style-tab output / input options). */
function checkRow(label: string, checked: () => boolean, toggle: () => void) {
  return (
    <div class="cp3-cell cp3-label is-full ind3-check-row">
      <div class="cp3-label-inner">
        <CheckBox checked={checked()} onToggle={toggle} />
        <span class="cp3-title" onClick={toggle}>{label}</span>
      </div>
    </div>
  );
}

/** One Visibility row: check + from / slider / to (TV 50 px row, fields
 *  100 x 34, slider 109 px, 8 px before "to"). The slider moves the fields
 *  while dragging and commits on release. */
function UnitRow(props: { label: string; max: number; unit: UnitVisibility; onChange: (u: UnitVisibility) => void }) {
  const [live, setLive] = createSignal<{ from: number; to: number } | null>(null);
  const clamp = (n: number) => Math.max(1, Math.min(props.max, Math.round(n)));
  const setField = (field: "from" | "to", v: string) => {
    const n = parseFloat(v);
    if (!Number.isFinite(n)) return;
    let from = field === "from" ? clamp(n) : props.unit.from;
    let to = field === "to" ? clamp(n) : props.unit.to;
    if (from > to) { if (field === "from") to = from; else from = to; }
    props.onChange({ ...props.unit, from, to });
  };
  const num = () => ({ min: 1, max: props.max, step: 1, int: true });
  return (
    <>
      <div class="cp3-cell cp3-label">
        <div class="cp3-label-inner">
          <CheckBox checked={props.unit.on} onToggle={() => props.onChange({ ...props.unit, on: !props.unit.on })} />
          <span class="cp3-title" onClick={() => props.onChange({ ...props.unit, on: !props.unit.on })}>{props.label}</span>
        </div>
      </div>
      <div class="cp3-cell cp3-controls ind3-vis-controls">
        <NumberField value={String(live()?.from ?? props.unit.from)} disabled={!props.unit.on} num={num()} onChange={(v) => setField("from", v)} />
        <span class="ind3-vis-slider">
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
        </span>
        <NumberField value={String(live()?.to ?? props.unit.to)} disabled={!props.unit.on} num={num()} onChange={(v) => setField("to", v)} />
      </div>
    </>
  );
}

/** Clamp a registry line width into the 1-4 range the renderer draws. */
function seedWidth(w: number | undefined): number {
  return w && w >= 1 && w <= 4 ? w : 1;
}

export function IndicatorSettingsDialog(props: Props) {
  // Plots shown in the Style tab — every plot except the registry's explicitly
  // hidden helpers (display:'none'), which aren't user-facing.
  const stylePlots = props.plotConfig.filter((p) => p.display !== "none");

  const [tab, setTab] = createSignal<"inputs" | "style" | "visibility">("inputs");

  // Working copies, seeded from the study's current inputs + plot styles.
  const [inputDraft, setInputDraft] = createStore<Record<string, unknown>>({ ...props.inputs });
  const [styleDraft, setStyleDraft] = createStore<Record<string, StyleRow>>(
    Object.fromEntries(
      stylePlots.map((p) => {
        const ov = props.styles[p.id];
        return [p.id, {
          color: ov?.color ?? p.color,
          lineWidth: ov?.lineWidth ?? seedWidth(p.lineWidth),
          visible: ov?.visible ?? true,
          plotType: ov?.plotType ?? p.style ?? "line",
          priceLine: ov?.priceLine ?? false,
        } as StyleRow];
      }),
    ),
  );

  // Style-tab output / input options + the Visibility matrix.
  const [optDraft, setOptDraft] = createStore<IndicatorOptions>(cloneIndicatorOptions(props.options));
  const setUnit = (key: keyof IntervalVisibility, u: UnitVisibility) => setOptDraft("visibility", key, u as never);

  const current = (): Next => {
    const styles: IndicatorStyleOverrides = {};
    for (const id of Object.keys(styleDraft)) styles[id] = { ...styleDraft[id] };
    return { inputs: { ...inputDraft }, styles, options: cloneIndicatorOptions(optDraft) };
  };
  const ok = () => {
    props.onApply(current());
    props.onClose();
  };
  // TV "Defaults" menu (PropertyActions, module 653097): Reset settings /
  // Save as default. Opens upward from the footer button.
  const [defaultsOpen, setDefaultsOpen] = createSignal(false);
  let defaultsBtn: HTMLButtonElement | undefined;
  let defaultsMenu: HTMLDivElement | undefined;
  onMount(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (defaultsMenu?.contains(t) || defaultsBtn?.contains(t)) return;
      setDefaultsOpen(false);
    };
    window.addEventListener("mousedown", onDown, true);
    onCleanup(() => window.removeEventListener("mousedown", onDown, true));
  });
  const reset = () => {
    const inputs: Record<string, unknown> = {};
    for (const cfg of props.inputConfig) inputs[cfg.id] = cfg.defval;
    setInputDraft(inputs);
    for (const p of stylePlots) setStyleDraft(p.id, { color: p.color, lineWidth: seedWidth(p.lineWidth), visible: true, plotType: p.style ?? "line", priceLine: false });
    setOptDraft(defaultIndicatorOptions());
  };

  // Escape / Enter on the dialog; popovers (menus, colour panel) take their
  // own Escape first (they stop it in the capture phase).
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); props.onClose(); }
      else if (e.key === "Enter" && !(e.target instanceof HTMLInputElement)) { e.stopPropagation(); ok(); }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  const istr = (id: string) => String(inputDraft[id] ?? "");
  const toggleInput = (id: string) => setInputDraft(id, (v: unknown) => !v);

  const inputControl = (cfg: InputConfig) => {
    if (cfg.type === "int" || cfg.type === "float") {
      return (
        <NumberField
          value={istr(cfg.id)}
          num={{ min: cfg.min ?? -1e12, max: cfg.max ?? 1e12, step: cfg.step ?? 1, int: cfg.type === "int" }}
          onChange={(v) => {
            const n = parseFloat(v);
            if (Number.isFinite(n)) setInputDraft(cfg.id, cfg.type === "int" ? Math.round(n) : n);
          }}
        />
      );
    }
    if (cfg.type === "source") {
      const labels = SOURCE_OPTIONS.map((o) => SOURCE_LABELS[o]);
      return (
        <SelectControl
          value={SOURCE_LABELS[istr(cfg.id)] ?? istr(cfg.id)}
          options={labels}
          width={selectWidth([SOURCE_LABELS[istr(cfg.id)] ?? istr(cfg.id)])}
          onPick={(label) => setInputDraft(cfg.id, SOURCE_OPTIONS[labels.indexOf(label)] ?? label)}
        />
      );
    }
    if (cfg.type === "string" && cfg.options?.length) {
      const options = cfg.options.map(String);
      return <SelectControl value={istr(cfg.id)} options={options} width={selectWidth([istr(cfg.id)])} onPick={(o) => setInputDraft(cfg.id, o)} />;
    }
    if (cfg.type === "color") {
      return <ColorControl color={istr(cfg.id)} onChange={(p) => { if (p.color) setInputDraft(cfg.id, p.color); }} />;
    }
    return (
      <span class="cp3-number ind3-text">
        <input type="text" value={istr(cfg.id)} spellcheck={false} onInput={(e) => setInputDraft(cfg.id, e.currentTarget.value)} />
      </span>
    );
  };

  return (
    <div class="settings-backdrop" role="presentation" onMouseDown={() => props.onClose()}>
      <div class="settings-dialog ind3-dialog" data-qa-id="indicator-properties-dialog" role="dialog" aria-label={`${props.title} settings`} onMouseDown={(e) => e.stopPropagation()}>
        <header class="cp3-header">
          <div class="cp3-header-title ind3-title">{props.title}</div>
          <button type="button" data-qa-id="close" aria-label="Close menu" class="cp3-close" onClick={() => props.onClose()}>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18"><path stroke="currentColor" stroke-width="1.2" fill="none" d="m1.5 1.5 15 15m0-15-15 15" /></svg>
          </button>
        </header>

        {/* TV underline tabs (study dialog: a top bar, not the left rail). */}
        <div class="ind3-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab() === "inputs"} class={`ind3-tab${tab() === "inputs" ? " is-active" : ""}`} onClick={() => setTab("inputs")}>Inputs</button>
          <button type="button" role="tab" aria-selected={tab() === "style"} class={`ind3-tab${tab() === "style" ? " is-active" : ""}`} onClick={() => setTab("style")}>Style</button>
          <button type="button" role="tab" aria-selected={tab() === "visibility"} class={`ind3-tab${tab() === "visibility" ? " is-active" : ""}`} onClick={() => setTab("visibility")}>Visibility</button>
        </div>

        <div class="ind3-content">
          {/* ── Inputs ── */}
          <Show when={tab() === "inputs"}>
            <Show
              when={props.inputConfig.length > 0}
              fallback={<div class="tv-empty-state ind3-empty">This indicator has no inputs.</div>}
            >
              <div class="ind3-grid">
                <For each={props.inputConfig}>
                  {(cfg) => {
                    const label = cfg.title ?? cfg.id;
                    if (cfg.type === "bool") {
                      return (
                        <div class="cp3-cell cp3-label is-full">
                          <div class="cp3-label-inner">
                            <CheckBox checked={!!inputDraft[cfg.id]} onToggle={() => toggleInput(cfg.id)} />
                            <span class="cp3-title" onClick={() => toggleInput(cfg.id)}>{label}</span>
                          </div>
                        </div>
                      );
                    }
                    return (
                      <>
                        <div class="cp3-cell cp3-label"><div class="cp3-label-inner"><span class="cp3-title">{label}</span></div></div>
                        <div class="cp3-cell cp3-controls">{inputControl(cfg)}</div>
                      </>
                    );
                  }}
                </For>
              </div>
            </Show>
          </Show>

          {/* ── Style ── one row per plot: visible check box + colour and
              thickness (TV color-with-thickness button; thickness is in its
              colour panel). */}
          <Show when={tab() === "style"}>
            <div class="ind3-grid">
              <For each={stylePlots}>
                {(p) => (
                  <>
                    <div class="cp3-cell cp3-label">
                      <div class="cp3-label-inner">
                        <CheckBox checked={styleDraft[p.id].visible} onToggle={() => setStyleDraft(p.id, "visible", (v) => !v)} />
                        <span class="cp3-title" onClick={() => setStyleDraft(p.id, "visible", (v) => !v)}>{p.title}</span>
                      </div>
                    </div>
                    <div class="cp3-cell cp3-controls">
                      <ColorControl
                        color={styleDraft[p.id].color}
                        width={styleDraft[p.id].lineWidth}
                        onChange={(patch) => {
                          if (patch.color) setStyleDraft(p.id, "color", patch.color);
                          if (patch.width !== undefined) setStyleDraft(p.id, "lineWidth", Math.max(1, Math.min(4, Math.round(patch.width))));
                        }}
                      />
                      <PlotTypeControl
                        value={styleDraft[p.id].plotType}
                        priceLine={styleDraft[p.id].priceLine}
                        onPick={(t) => setStyleDraft(p.id, "plotType", t)}
                        onPriceLine={(v) => setStyleDraft(p.id, "priceLine", v)}
                      />
                    </div>
                  </>
                )}
              </For>
              {/* TV Style sections (26/09/2026): OUTPUT VALUES — Precision,
                  Labels on price scale, Values in status line; INPUT VALUES —
                  Inputs in status line. Check rows 34 px. */}
              <div class={`cp3-section ind3-section${stylePlots.length === 0 ? " is-first" : " ind3-after-plots"}`}>Output values</div>
              <div class="cp3-cell cp3-label"><div class="cp3-label-inner"><span class="cp3-title">Precision</span></div></div>
              <div class="cp3-cell cp3-controls">
                <SelectControl value={optDraft.precision} options={PRECISION_OPTIONS} width={100} onPick={(v) => setOptDraft("precision", v)} />
              </div>
              {checkRow("Labels on price scale", () => optDraft.labelsOnScale, () => setOptDraft("labelsOnScale", (v) => !v))}
              {checkRow("Values in status line", () => optDraft.valuesInStatusLine, () => setOptDraft("valuesInStatusLine", (v) => !v))}
              <div class="cp3-section ind3-section">Input values</div>
              {checkRow("Inputs in status line", () => optDraft.inputsInStatusLine, () => setOptDraft("inputsInStatusLine", (v) => !v))}
            </div>
          </Show>

          {/* ── Visibility ── TV intervalsVisibilities matrix (same as the
              drawing Visibility tab): Ticks / Ranges check only; Seconds ..
              Months check + from (100 px) + range slider + to (100 px). */}
          <Show when={tab() === "visibility"}>
            <div class="ind3-grid">
              <div class="cp3-cell cp3-label is-full">
                <div class="cp3-label-inner">
                  <CheckBox checked={optDraft.visibility.ticks} onToggle={() => setOptDraft("visibility", "ticks", (v) => !v)} />
                  <span class="cp3-title" onClick={() => setOptDraft("visibility", "ticks", (v) => !v)}>Ticks</span>
                </div>
              </div>
              <For each={VIS_UNITS}>
                {([key, label, max]) => (
                  <UnitRow label={label} max={max} unit={optDraft.visibility[key] as UnitVisibility} onChange={(u) => setUnit(key, u)} />
                )}
              </For>
              <div class="cp3-cell cp3-label is-full">
                <div class="cp3-label-inner">
                  <CheckBox checked={optDraft.visibility.ranges} onToggle={() => setOptDraft("visibility", "ranges", (v) => !v)} />
                  <span class="cp3-title" onClick={() => setOptDraft("visibility", "ranges", (v) => !v)}>Ranges</span>
                </div>
              </div>
            </div>
          </Show>
        </div>

        <footer class="cp3-footer">
          <div class="settings-defaults">
            <button
              ref={defaultsBtn}
              type="button"
              class="cp3-template"
              aria-haspopup="menu"
              aria-expanded={defaultsOpen()}
              onClick={() => setDefaultsOpen(!defaultsOpen())}
            >
              Defaults <span class="cp3-select-caret"><Chevron /></span>
            </button>
            <Show when={defaultsOpen()}>
              <div ref={defaultsMenu} class="cp3-menu settings-template-menu settings-defaults-menu" role="menu">
                <div role="menuitem" class="cp3-menu-item" onClick={() => { reset(); setDefaultsOpen(false); }}>
                  <span class="cp3-menu-title">Reset settings</span>
                </div>
                <div role="menuitem" class="cp3-menu-item" onClick={() => { props.onSaveAsDefault(current()); setDefaultsOpen(false); }}>
                  <span class="cp3-menu-title">Save as default</span>
                </div>
              </div>
            </Show>
          </div>
          <div class="cp3-footer-actions">
            <button type="button" class="cp3-btn" onClick={() => props.onClose()}>Cancel</button>
            <button type="button" class="cp3-btn is-primary" data-qa-id="submit-button" onClick={ok}>Ok</button>
          </div>
        </footer>
      </div>
    </div>
  );
}
