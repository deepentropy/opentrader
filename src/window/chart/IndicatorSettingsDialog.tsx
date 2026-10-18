/*
 * IndicatorSettingsDialog — the study "Settings" modal opened from the studies
 * legend gear (IndicatorLegend -> onSettings). Generic over the indicator
 * registry: every field is derived from the entry's `inputConfig` (Inputs tab)
 * and `plotConfig` (Style tab), so each indicator gets a working dialog with
 * no per-indicator code.
 *
 * Look: width fits the content, header 68 px (title 20/600), underlined tabs
 * 16/600 with a 4 px #F2F2F2 bar on a 4 px #4A4A4A track, rows of 34 px
 * controls (white check boxes, outlined selects / number fields, boxed colour
 * swatches), footer "Defaults" menu + Cancel / Ok. The controls are the chart
 * Settings dialog's. Edits a local draft; Cancel discards, Ok commits.
 */
import { For, Show, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { InputConfig, PlotConfig } from "lightweight-charts-indicators";
import type { PlotDefaultVisible, PlotPalette } from "./indicators/volume";
import type { IndicatorStyleOverrides } from "./indicators/indicator-layer";
import { CheckBox, ColorControl, NumberField, SelectControl } from "../header/ChartPropertiesDialog";
import { RangeSlider } from "../drawings/SettingsDialog";
import type { IntervalVisibility, UnitVisibility } from "lightweight-charts-drawing/core/types";
import {
  cloneIndicatorOptions,
  defaultIndicatorOptions,
  PRECISION_OPTIONS,
  type IndicatorOptions,
} from "./indicators/indicator-options";
import type { StrategyProperties } from "../../backtester/types";
import { DEFAULT_STRATEGY_STYLE, PROPERTIES_INPUT, STYLE_INPUT, type StrategyStyle } from "./indicators/strategy-entries";
import { StrategyPropertiesTab } from "./StrategyPropertiesTab";
import { DateTimeInput } from "./DateTimeInput";
import { TimeInput } from "../bottom-bar/TimeInput";
import { defaultVbpStyle, vbpStyleEdits, vbpStyleOf, type VbpLine, type VbpStyle } from "./profiles/vbp-style";
import { defaultTpoStyle, tpoStyleEdits, tpoStyleOf, type TpoStyle } from "./profiles/tpo-style";
import { TransparencySlider } from "../drawings/ImageDialog";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import * as kv from "../../data/kv";
import { OutputRows } from "./StyleOutputRows";
import type { StyleItem } from "./indicators/style-outputs";
import type { PlotStyleOverride } from "./indicators/indicator-layer";

/** Input schema entry; strategies add Pine's `time` type, groups, inline rows and tooltips; the profile studies a
 *  session range ("HHMM-HHMM") and inputs enabled only for one value of another input. */
export type DialogInput = Omit<InputConfig, "type"> & {
  type: InputConfig["type"] | "time" | "session";
  group?: string;
  inline?: string;
  tooltip?: string;
  enabledWhen?: { id: string; value: string };
  /** Set from another tab (TPO level extensions): no row in the Inputs tab. */
  hidden?: boolean;
};

/** Volume profile studies: their Style tab (placement default, histogram box row). */
export type ProfileDialogConfig = { placement: "Left" | "Right"; histogramBox: boolean };

export type DialogTab = "inputs" | "properties" | "style" | "volume" | "visibility";

/** Strategy studies: Properties tab and the trade-marks Style tab. */
export type StrategyDialogConfig = {
  /** Effective strategy() properties (script values + the study overrides). */
  properties: StrategyProperties;
  /** Script values (Defaults > Reset settings; overrides are stored as the difference). */
  defaults: StrategyProperties;
  style: StrategyStyle;
  chartCurrency: string;
  interval: string;
  /** Chart type id (Heikin Ashi mode row, synthetic types disable High detalization). */
  chartStyle: string;
  timeZone: string;
};

/** Last tab clicked in a strategy's settings (the reference app setting
 *  properties_dialog.active_tab.study): the dialog opens on it unless the
 *  caller asks for a tab (report toolbar gear = Properties). */
const TAB_KEY = "ot:strategy-settings:tab";

type Next = { inputs: Record<string, unknown>; styles: IndicatorStyleOverrides; options: IndicatorOptions };

/** Materialised per-plot style row in the draft (always fully populated). */
type StyleRow = { color: string; lineWidth: number; visible: boolean; plotType: string; priceLine: boolean; palette?: string[] };
/** Palette entries of a plot coloured per point (PlotPalette): named entries, or a plain colour list named
 *  "Color 0", "Color 1", ... as the reference names them. */
const paletteOf = (p: PlotConfig): { name: string; color: string }[] | undefined => {
  const pal = (p as PlotConfig & PlotPalette).palette;
  return pal?.map((c, i) => (typeof c === "string" ? { name: `Color ${i}`, color: c } : c));
};

type Props = {
  /** Source inputs: the other sources' outputs offered after the price sources (study on study). */
  sourceChoices?: { value: string; label: string }[];
  /** Study display name, shown in the header. */
  title: string;
  /** The indicator's input schema (registry entry's inputConfig). */
  inputConfig: DialogInput[];
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
  /** Strategy study: Properties tab + strategy Style tab. */
  strategy?: StrategyDialogConfig;
  /** Exchange time zone of the charted symbol: time inputs of indicators. */
  timeZone?: string;
  /** Tab to open on (otherwise: strategies the last clicked tab, else Inputs). */
  initialTab?: DialogTab;
  /** Volume profile study: the profile Style tab. */
  profile?: ProfileDialogConfig;
  /** Time price opportunity study: its Style and Volume profile tabs; `autoTicksPerRow`: the Auto row size shown. */
  tpo?: { autoTicksPerRow: number };
  /** The outputs listed in the Style tab (style-outputs.ts styleItems); unset: the line plots of `plotConfig`. */
  styleItems?: StyleItem[];
  /** Which "Output values" / "Input values" rows the Style tab has (style-outputs.ts outputValueRows). */
  valueRows?: { precision: boolean; values: boolean; inputs: boolean };
  /** Every change of the draft, applied to the chart while the dialog is open; null: back to the study's settings
   *  (Cancel). */
  onPreview?: (next: Next | null) => void;
};

// Price-source choices and their labels (reference order, volume after close). Values stay the PineScript names.
const SOURCE_OPTIONS = ["open", "high", "low", "close", "volume", "hl2", "hlc3", "ohlc4", "hlcc4"];
const SOURCE_LABELS: Record<string, string> = {
  open: "Open", high: "High", low: "Low", close: "Close", volume: "Volume",
  hl2: "(H + L)/2", hlc3: "(H + L + C)/3", ohlc4: "(O + H + L + C)/4", hlcc4: "(H + L + C + C)/4",
};

const Chevron = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3.92 7.83 9 12.29l5.08-4.46-1-1.13L9 10.29l-4.09-3.6-.99 1.14Z" /></svg>
);

/** Select width: the SHOWN value + button padding (content 7 left, 6
 *  before the 20 px caret, 2 right), 100 px minimum. The "Close" source
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

/** Plot types (Settings -> Style plot-type menu, with their 28 px icons)
 *  -> the Pine style ids the renderer draws. */
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

/** Plot-type button (34 x 34 box, the current type's 28 px icon) and its
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

/** Visibility rows with a range (units and maxima). */
export const VIS_UNITS: ReadonlyArray<readonly [keyof IntervalVisibility, string, number]> = [
  ["seconds", "Seconds", 59],
  ["minutes", "Minutes", 59],
  ["hours", "Hours", 24],
  ["days", "Days", 366],
  ["weeks", "Weeks", 52],
  ["months", "Months", 12],
];

/** Full-width 34 px check row (Style-tab output / input options). */
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

/** One Visibility row: check + from / slider / to (50 px row, fields
 *  100 x 34, slider 109 px, 8 px before "to"). The slider moves the fields
 *  while dragging and commits on release. */
export function UnitRow(props: { label: string; max: number; unit: UnitVisibility; onChange: (u: UnitVisibility) => void }) {
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

/** (i) icon after a control, with the input tooltip. */
function InfoIcon(props: { text: string }) {
  return (
    <Tooltip text={props.text} side="top">
      <span class="ind3-info" aria-label={props.text}>
        <Icon name="st-settings-info" size={18} />
      </span>
    </Tooltip>
  );
}

export function IndicatorSettingsDialog(props: Props) {
  // Plots shown in the Style tab — every plot except the registry's explicitly
  // hidden helpers (display:'none'), which aren't user-facing.
  // every plot listed in the Style tab, hidden-by-default ones too (they start unchecked)
  const stylePlots = props.plotConfig.filter((p) => (p as { editable?: boolean }).editable !== false);
  // Every output of the Style tab, in the reference order; the line plots are the ones above.
  const items = (): StyleItem[] => props.styleItems ?? stylePlots.map((def) => ({ kind: "plot", key: def.id, def }));
  const otherItems = () => items().filter((i): i is Exclude<StyleItem, { kind: "plot" }> => i.kind !== "plot");
  const valueRows = () => props.valueRows ?? { precision: true, values: true, inputs: true };

  // The Inputs tab only with inputs a user can edit (reference).
  const hasInputs = props.inputConfig.some((c) => !c.hidden);
  const tabs = (): DialogTab[] =>
    (props.strategy ? ["inputs", "properties", "style", "visibility"] as DialogTab[] : props.tpo ? ["inputs", "style", "volume", "visibility"] as DialogTab[] : ["inputs", "style", "visibility"] as DialogTab[])
      .filter((t) => t !== "inputs" || hasInputs);
  const TAB_TITLES: Record<DialogTab, string> = { inputs: "Inputs", properties: "Properties", style: "Style", volume: "Volume profile", visibility: "Visibility" };
  const stored = props.strategy ? (kv.getItem(TAB_KEY) as DialogTab | null) : null;
  const [tab, setTabRaw] = createSignal<DialogTab>(
    props.initialTab && tabs().includes(props.initialTab) ? props.initialTab : stored && tabs().includes(stored) ? stored : tabs()[0],
  );
  const setTab = (t: DialogTab) => {
    setTabRaw(t);
    if (props.strategy) kv.setItem(TAB_KEY, t);
  };
  // Strategy drafts: properties and trade-mark style.
  const [propDraft, setPropDraft] = createStore<StrategyProperties>({ ...(props.strategy?.properties ?? ({} as StrategyProperties)) });
  const [stratStyle, setStratStyle] = createStore<StrategyStyle>({ ...(props.strategy?.style ?? DEFAULT_STRATEGY_STYLE) });

  // Working copies, seeded from the study's current inputs + plot styles.
  const [inputDraft, setInputDraft] = createStore<Record<string, unknown>>({ ...props.inputs });
  const [styleDraft, setStyleDraft] = createStore<Record<string, StyleRow>>(
    Object.fromEntries(
      stylePlots.map((p) => {
        const ov = props.styles[p.id];
        return [p.id, {
          color: ov?.color ?? p.color,
          lineWidth: ov?.lineWidth ?? seedWidth(p.lineWidth),
          visible: ov?.visible ?? (p as PlotConfig & PlotDefaultVisible).defaultVisible ?? p.display !== "none",
          plotType: ov?.plotType ?? p.style ?? "line",
          priceLine: ov?.priceLine ?? false,
          ...(paletteOf(p) ? { palette: paletteOf(p)!.map((c, i) => ov?.palette?.[i] ?? c.color) } : {}),
        } as StyleRow];
      }),
    ),
  );

  // The other outputs' overrides (shapes, colours, candles, hlines, fills, drawings), by style key.
  const [outDraft, setOutDraft] = createStore<Record<string, PlotStyleOverride>>(
    Object.fromEntries(otherItems().map((i) => [i.key, { ...(props.styles[i.key] ?? {}) }])),
  );
  const setOut = (key: string, patch: Partial<PlotStyleOverride>) => setOutDraft(key, (o) => ({ ...o, ...patch }));
  const setOutPalette = (key: string, field: "palette" | "wickPalette" | "borderPalette", i: number, color: string, size: number) =>
    setOutDraft(key, (o) => {
      const list = [...(o[field] ?? new Array<string | undefined>(size).fill(undefined))] as string[];
      list[i] = color;
      return { ...o, [field]: list };
    });

  // Volume profile / TPO style (stored with the inputs).
  const [vbpDraft, setVbpDraft] = createStore<VbpStyle>(vbpStyleOf(props.inputs, props.profile?.placement ?? "Left"));
  const [tpoDraft, setTpoDraft] = createStore<TpoStyle>(tpoStyleOf(props.inputs));

  // Style-tab output / input options + the Visibility matrix.
  const [optDraft, setOptDraft] = createStore<IndicatorOptions>(cloneIndicatorOptions(props.options));
  const setUnit = (key: keyof IntervalVisibility, u: UnitVisibility) => setOptDraft("visibility", key, u as never);

  const current = (): Next => {
    const styles: IndicatorStyleOverrides = {};
    for (const id of Object.keys(styleDraft)) styles[id] = { ...styleDraft[id] };
    for (const key of Object.keys(outDraft)) {
      const ov = outDraft[key];
      if (Object.keys(ov).length) styles[key] = JSON.parse(JSON.stringify(ov));
    }
    const inputs: Record<string, unknown> = { ...inputDraft };
    if (props.strategy) {
      // Properties are stored as the difference from the script values.
      const diff: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(propDraft)) if ((props.strategy.defaults as unknown as Record<string, unknown>)[k] !== v) diff[k] = v;
      inputs[PROPERTIES_INPUT] = diff;
      inputs[STYLE_INPUT] = { ...stratStyle };
    }
    if (props.profile) {
      const developing = ["developingPoc", "developingVAHigh", "developingVALow"].some((id) => styleDraft[id]?.visible);
      inputs[STYLE_INPUT] = vbpStyleEdits({ ...JSON.parse(JSON.stringify(vbpDraft)), developing }, props.profile.placement);
    }
    if (props.tpo) inputs[STYLE_INPUT] = tpoStyleEdits(JSON.parse(JSON.stringify(tpoDraft)));
    return { inputs, styles, options: cloneIndicatorOptions(optDraft) };
  };
  // Reference: the draft is drawn on the chart while the dialog is open; Ok, the close button, Escape and a click
  // outside keep it (applied once, nothing when unchanged); Cancel puts the study back.
  const initial = JSON.stringify(current());
  let previewed = false;
  createEffect(
    on(
      () => JSON.stringify(current()),
      (now) => {
        if (now === initial && !previewed) return;
        previewed = true;
        props.onPreview?.(JSON.parse(now) as Next);
      },
      { defer: true },
    ),
  );
  const ok = () => {
    if (JSON.stringify(current()) !== initial) props.onApply(current());
    else if (previewed) props.onPreview?.(null);
    props.onClose();
  };
  const cancel = () => {
    if (previewed) props.onPreview?.(null);
    props.onClose();
  };
  /** A palette plot (Volume): its visible check row, then one colour row per
   *  palette entry (the first also holds the plot type button). */
  const paletteRows = (p: PlotConfig) => (
    <>
      <div class="cp3-cell cp3-label is-full">
        <div class="cp3-label-inner">
          <CheckBox checked={styleDraft[p.id].visible} onToggle={() => setStyleDraft(p.id, "visible", (v) => !v)} />
          <span class="cp3-title" onClick={() => setStyleDraft(p.id, "visible", (v) => !v)}>{p.title}</span>
        </div>
      </div>
      <For each={paletteOf(p) ?? []}>
        {(c, i) => (
          <>
            <div class="cp3-cell cp3-label is-offset">
              <div class="cp3-label-inner"><span class="cp3-title">{c.name}</span></div>
            </div>
            <div class="cp3-cell cp3-controls">
              <ColorControl
                color={styleDraft[p.id].palette?.[i()] ?? c.color}
                width={styleDraft[p.id].lineWidth}
                onChange={(patch) => {
                  if (patch.color) setStyleDraft(p.id, "palette", i(), patch.color);
                  if (patch.width !== undefined) setStyleDraft(p.id, "lineWidth", Math.max(1, Math.min(4, Math.round(patch.width))));
                }}
              />
              <Show when={i() === 0}>
                <PlotTypeControl
                  value={styleDraft[p.id].plotType}
                  priceLine={styleDraft[p.id].priceLine}
                  onPick={(t) => setStyleDraft(p.id, "plotType", t)}
                  onPriceLine={(v) => setStyleDraft(p.id, "priceLine", v)}
                />
              </Show>
            </div>
          </>
        )}
      </For>
    </>
  );
  // "Defaults" menu: Reset settings /
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
    if (props.strategy) {
      setPropDraft({ ...props.strategy.defaults });
      setStratStyle({ ...DEFAULT_STRATEGY_STYLE });
    }
    if (props.profile) setVbpDraft(defaultVbpStyle(props.profile.placement));
    if (props.tpo) setTpoDraft(defaultTpoStyle());
    setOutDraft(reconcile(Object.fromEntries(Object.keys(outDraft).map((key) => [key, {}]))));
    for (const p of stylePlots) {
      setStyleDraft(p.id, { color: p.color, lineWidth: seedWidth(p.lineWidth), visible: (p as PlotConfig & PlotDefaultVisible).defaultVisible ?? p.display !== "none", plotType: p.style ?? "line", priceLine: false, palette: paletteOf(p)?.map((c) => c.color) });
    }
    setOptDraft(defaultIndicatorOptions());
  };

  // Escape / Enter on the dialog; popovers (menus, colour panel) take their
  // own Escape first (they stop it in the capture phase).
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); ok(); }
      else if (e.key === "Enter" && !(e.target instanceof HTMLInputElement)) { e.stopPropagation(); ok(); }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  /** One line plot: visible check box, colour + thickness, plot type (palette plots: a row per palette colour). */
  const plotRow = (p: PlotConfig) => (
    <Show when={!paletteOf(p)} fallback={paletteRows(p)}>
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
    </Show>
  );
  /** The output rows of the Style tab: plots and other outputs, then the drawing groups under their title. */
  const outputRowsJsx = () => (
    <For each={items()}>
      {(item, i) => (
        <>
          <Show when={item.kind === "drawing" && items()[i() - 1]?.kind !== "drawing"}>
            <div class={`cp3-section ind3-section${i() === 0 ? " is-first" : " ind3-after-plots"}`}>Graphic objects</div>
          </Show>
          {item.kind === "plot" ? (
            plotRow(item.def)
          ) : (
            <OutputRows
              item={item}
              ov={outDraft[item.key] ?? {}}
              set={(patch) => setOut(item.key, patch)}
              setPalette={(field, k, color, size) => setOutPalette(item.key, field, k, color, size)}
            />
          )}
        </>
      )}
    </For>
  );
  /** "Output values" (Precision; labels on the price scale and values in the status line for outputs with values)
   *  and "Input values" (Inputs in status line), as the study has them. `first`: nothing above. */
  const valueRowsJsx = (first: boolean) => (
    <>
      <Show when={valueRows().precision}>
        <div class={`cp3-section ind3-section${first ? " is-first" : " ind3-after-plots"}`}>Output values</div>
        <div class="cp3-cell cp3-label"><div class="cp3-label-inner"><span class="cp3-title">Precision</span></div></div>
        <div class="cp3-cell cp3-controls">
          <SelectControl value={optDraft.precision} options={PRECISION_OPTIONS} width={100} onPick={(v) => setOptDraft("precision", v)} />
        </div>
        <Show when={valueRows().values}>
          {checkRow("Labels on price scale", () => optDraft.labelsOnScale, () => setOptDraft("labelsOnScale", (v) => !v))}
          {checkRow("Values in status line", () => optDraft.valuesInStatusLine, () => setOptDraft("valuesInStatusLine", (v) => !v))}
        </Show>
      </Show>
      <Show when={valueRows().inputs}>
        <div class={`cp3-section ind3-section${first && !valueRows().precision ? " is-first" : valueRows().precision ? "" : " ind3-after-plots"}`}>Input values</div>
        {checkRow("Inputs in status line", () => optDraft.inputsInStatusLine, () => setOptDraft("inputsInStatusLine", (v) => !v))}
      </Show>
    </>
  );

  const istr = (id: string) => String(inputDraft[id] ?? "");
  const toggleInput = (id: string) => setInputDraft(id, (v: unknown) => !v);

  // Inputs tab rows: Pine groups get a title row (11px uppercase) and a gap
  // after their last row; inputs sharing an `inline` id share one row.
  // A group collects every input with its name, adjacent or not, at the place
  // of its first input; an inline row collects every input with its id inside
  // the same group (ungrouped inputs have their own set of rows).
  type InputRow = { kind: "group"; title: string; first: boolean } | { kind: "gap" } | { kind: "row"; items: DialogInput[] };
  const inputRows = (): InputRow[] => {
    type Line = { items: DialogInput[] };
    type Section = { group?: string; lines: Line[]; inlines: Map<string, Line> };
    const sections: Section[] = [];
    const groups = new Map<string, Section>();
    const loose = new Map<string, Line>();
    for (const cfg of props.inputConfig) {
      if (cfg.hidden) continue;
      let section: Section;
      if (cfg.group !== undefined) {
        let g = groups.get(cfg.group);
        if (!g) {
          g = { group: cfg.group, lines: [], inlines: new Map() };
          groups.set(cfg.group, g);
          sections.push(g);
        }
        section = g;
      } else {
        section = { lines: [], inlines: loose };
        sections.push(section);
      }
      const line = cfg.inline !== undefined ? section.inlines.get(cfg.inline) : undefined;
      if (line) {
        line.items.push(cfg);
        // An ungrouped input that joined an earlier row adds no row of its own.
        if (section.group === undefined) sections.pop();
        continue;
      }
      const made: Line = { items: [cfg] };
      if (cfg.inline !== undefined) section.inlines.set(cfg.inline, made);
      section.lines.push(made);
    }
    const rows: InputRow[] = [];
    sections.forEach((s, i) => {
      if (i > 0 && sections[i - 1].group !== undefined) rows.push({ kind: "gap" });
      if (s.group !== undefined) rows.push({ kind: "group", title: s.group, first: i === 0 });
      for (const l of s.lines) rows.push({ kind: "row", items: l.items });
    });
    return rows;
  };

  /** An input enabled only while another input has one value (profile "Custom session"). */
  const enabled = (cfg: DialogInput) => !cfg.enabledWhen || String(inputDraft[cfg.enabledWhen.id]) === cfg.enabledWhen.value;
  const inputControl = (cfg: DialogInput) => {
    if (cfg.type === "session") {
      // "HHMM-HHMM": two time fields.
      const parts = () => {
        const m = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(istr(cfg.id));
        return m ? [`${m[1]}:${m[2]}`, `${m[3]}:${m[4]}`] : ["09:30", "16:00"];
      };
      const set = (i: 0 | 1, v: string) => {
        const p = parts();
        p[i] = v;
        setInputDraft(cfg.id, p.map((x) => x.replace(":", "")).join("-"));
      };
      return (
        <span class="ind3-session" classList={{ "is-disabled": !enabled(cfg) }}>
          <span class="ind3-time"><TimeInput value={parts()[0]} disabled={!enabled(cfg)} onChange={(v) => set(0, v)} /></span>
          <span class="ind3-session-dash">—</span>
          <span class="ind3-time"><TimeInput value={parts()[1]} disabled={!enabled(cfg)} onChange={(v) => set(1, v)} /></span>
        </span>
      );
    }
    if (cfg.type === "time") {
      return <DateTimeInput value={Number(inputDraft[cfg.id])} timeZone={props.strategy?.timeZone ?? props.timeZone ?? "UTC"} onChange={(ms) => setInputDraft(cfg.id, ms)} />;
    }
    if (cfg.type === "int" || cfg.type === "float") {
      // TPO "Ticks Per Row" with Auto rows: the computed size, disabled.
      const auto = props.tpo && cfg.id === "ticksPerRow" && !enabled(cfg);
      return (
        <NumberField
          value={auto ? String(props.tpo!.autoTicksPerRow) : istr(cfg.id)}
          disabled={!enabled(cfg)}
          num={{ min: cfg.min ?? -1e12, max: cfg.max ?? 1e12, step: cfg.step ?? 1, int: cfg.type === "int" }}
          onChange={(v) => {
            const n = parseFloat(v);
            if (Number.isFinite(n)) setInputDraft(cfg.id, cfg.type === "int" ? Math.round(n) : n);
          }}
        />
      );
    }
    if (cfg.type === "source") {
      // The price sources, then the other sources' outputs (study on study).
      const extra = props.sourceChoices ?? [];
      const values = [...SOURCE_OPTIONS, ...extra.map((c) => c.value)];
      const labels = [...SOURCE_OPTIONS.map((o) => SOURCE_LABELS[o]), ...extra.map((c) => c.label)];
      const shown = () => labels[values.indexOf(istr(cfg.id))] ?? SOURCE_LABELS[istr(cfg.id)] ?? istr(cfg.id);
      return (
        <SelectControl
          value={shown()}
          options={labels}
          width={selectWidth([shown()])}
          onPick={(label) => setInputDraft(cfg.id, values[labels.indexOf(label)] ?? label)}
        />
      );
    }
    if (cfg.type === "string" && cfg.options?.length) {
      const options = cfg.options.map(String);
      // Profile studies: the reference's 100 px select (long values cut).
      return <SelectControl value={istr(cfg.id)} options={options} width={props.profile ? 100 : selectWidth([istr(cfg.id)])} disabled={!enabled(cfg)} onPick={(o) => setInputDraft(cfg.id, o)} />;
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
    <div class="settings-backdrop" role="presentation" onMouseDown={() => ok()}>
      <div class="settings-dialog ind3-dialog" data-qa-id="indicator-properties-dialog" role="dialog" aria-label={`${props.title} settings`} onMouseDown={(e) => e.stopPropagation()}>
        <header class="cp3-header">
          <div class="cp3-header-title ind3-title">{props.title}</div>
          <button type="button" data-qa-id="close" aria-label="Close menu" class="cp3-close" onClick={() => ok()}>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18"><path stroke="currentColor" stroke-width="1.2" fill="none" d="m1.5 1.5 15 15m0-15-15 15" /></svg>
          </button>
        </header>

        {/* Underline tabs (study dialog: a top bar, not the left rail). */}
        <div class="ind3-tabs" role="tablist">
          <For each={tabs()}>
            {(t) => (
              <button type="button" role="tab" aria-selected={tab() === t} class={`ind3-tab${tab() === t ? " is-active" : ""}`} onClick={() => setTab(t)}>{TAB_TITLES[t]}</button>
            )}
          </For>
        </div>

        <div class="ind3-content">
          {/* ── Inputs ── */}
          <Show when={tab() === "inputs"}>
            <Show
              when={props.inputConfig.length > 0}
              fallback={<div class="ot-empty-state ind3-empty">This indicator has no inputs.</div>}
            >
              <div class="ind3-grid">
                <For each={inputRows()}>
                  {(row) => {
                    if (row.kind === "group") return <div class={`cp3-section ind3-group${row.first ? " is-first" : ""}`}>{row.title}</div>;
                    if (row.kind === "gap") return <div class="ind3-group-gap" />;
                    const [first, ...rest] = row.items;
                    const tip = [...row.items].reverse().find((c) => c.tooltip)?.tooltip;
                    const info = () => (tip ? <InfoIcon text={tip} /> : null);
                    const more = () => (
                      <For each={rest}>
                        {(cfg) => (
                          <>
                            {/* Reference inline cells: a title cell (empty or not) 8 px before each control. */}
                            <Show when={cfg.type !== "bool"}>
                              <span class="cp3-title">{cfg.title}</span>
                            </Show>
                            {cfg.type === "bool" ? <CheckBox checked={!!inputDraft[cfg.id]} onToggle={() => toggleInput(cfg.id)} /> : inputControl(cfg)}
                          </>
                        )}
                      </For>
                    );
                    if (first.type === "bool") {
                      // A check box alone is a 34 px row (reference "fill" cell); with inline controls a 50 px one.
                      return (
                        <div class={`cp3-cell cp3-label is-full${rest.length === 0 ? " ind3-check-row" : ""}`}>
                          <div class="cp3-label-inner">
                            <CheckBox checked={!!inputDraft[first.id]} onToggle={() => toggleInput(first.id)} />
                            <span class="cp3-title" onClick={() => toggleInput(first.id)}>{first.title ?? first.id}</span>
                            {more()}
                            {info()}
                          </div>
                        </div>
                      );
                    }
                    // Several inputs on one row: label and controls flow from the left (reference inline cells), not in
                    // the controls column.
                    if (rest.length > 0) {
                      return (
                        <div class="cp3-cell cp3-label is-full">
                          <div class="cp3-label-inner">
                            <span class="cp3-title">{first.title ?? first.id}</span>
                            {inputControl(first)}
                            {more()}
                            {info()}
                          </div>
                        </div>
                      );
                    }
                    return (
                      <>
                        <div class="cp3-cell cp3-label"><div class="cp3-label-inner"><span class="cp3-title">{first.title ?? first.id}</span></div></div>
                        <div class="cp3-cell cp3-controls">{inputControl(first)}{info()}</div>
                      </>
                    );
                  }}
                </For>
              </div>
            </Show>
          </Show>

          {/* ── Properties (strategies) ── */}
          <Show when={tab() === "properties" && props.strategy}>
            {(st) => (
              <StrategyPropertiesTab
                value={propDraft}
                chartCurrency={st().chartCurrency}
                interval={st().interval}
                chartStyle={st().chartStyle}
                onChange={(patch) => setPropDraft(patch)}
              />
            )}
          </Show>

          {/* ── Style (strategies) ── trade marks on the price pane, then
              INPUT VALUES / Inputs in status line. */}
          <Show when={tab() === "style" && props.strategy}>
            <div class="ind3-grid">
              {outputRowsJsx()}
              {checkRow("Trades on chart", () => stratStyle.tradesOnChart, () => setStratStyle("tradesOnChart", (v) => !v))}
              {checkRow("Signal labels", () => stratStyle.signalLabels, () => setStratStyle("signalLabels", (v) => !v))}
              {checkRow("Quantity", () => stratStyle.quantity, () => setStratStyle("quantity", (v) => !v))}
              {valueRowsJsx(false)}
            </div>
          </Show>

          {/* ── Style / Volume profile (time price opportunity) ── */}
          <Show when={(tab() === "style" || tab() === "volume") && props.tpo}>
            {(() => {
              const extendSelect = (inputId: string, disabled: () => boolean) => (
                <SelectControl
                  value={inputDraft[inputId] ? "Extend" : "Don't extend"}
                  options={["Don't extend", "Extend"]}
                  width={100}
                  disabled={disabled()}
                  onPick={(o) => setInputDraft(inputId, o === "Extend")}
                />
              );
              type LevelKey = "poc" | "poorHigh" | "poorLow" | "singlePrints" | "vah" | "val";
              const level = (label: string, key: LevelKey, inputId: string) => (
                <>
                  <div class="cp3-cell cp3-label">
                    <div class="cp3-label-inner">
                      <CheckBox checked={tpoDraft[key].visible} onToggle={() => setTpoDraft(key, "visible", (v) => !v)} />
                      <span class="cp3-title" onClick={() => setTpoDraft(key, "visible", (v) => !v)}>{label}</span>
                    </div>
                  </div>
                  <div class="cp3-cell cp3-controls">
                    {extendSelect(inputId, () => !tpoDraft[key].visible)}
                    <ColorControl color={tpoDraft[key].color} disabled={!tpoDraft[key].visible} onChange={(p) => { if (p.color) setTpoDraft(key, "color", p.color); }} />
                  </div>
                </>
              );
              const check = (label: string, key: "showBlocks" | "showLetters" | "midpoint" | "open" | "close") =>
                checkRow(label, () => tpoDraft[key], () => setTpoDraft(key, (v) => !v));
              type VolKey = "vah" | "val" | "poc";
              const volLine = (label: string, key: VolKey, inputId: string) => (
                <>
                  <div class="cp3-cell cp3-label">
                    <div class="cp3-label-inner">
                      <CheckBox checked={tpoDraft.volume[key].visible} onToggle={() => setTpoDraft("volume", key, "visible", (v) => !v)} />
                      <span class="cp3-title" onClick={() => setTpoDraft("volume", key, "visible", (v) => !v)}>{label}</span>
                    </div>
                  </div>
                  <div class="cp3-cell cp3-controls">
                    {extendSelect(inputId, () => !tpoDraft.volume[key].visible)}
                    <ColorControl
                      color={tpoDraft.volume[key].color}
                      width={tpoDraft.volume[key].width}
                      style={tpoDraft.volume[key].style}
                      disabled={!tpoDraft.volume[key].visible}
                      onChange={(p) => {
                        if (p.color) setTpoDraft("volume", key, "color", p.color);
                        if (p.width !== undefined) setTpoDraft("volume", key, "width", Math.max(1, Math.min(4, Math.round(p.width))));
                        if (p.style !== undefined) setTpoDraft("volume", key, "style", p.style);
                      }}
                    />
                  </div>
                </>
              );
              return (
                <Show
                  when={tab() === "style"}
                  fallback={
                    <div class="ind3-grid">
                      {checkRow("Show volume profile", () => tpoDraft.volume.visible, () => setTpoDraft("volume", "visible", (v) => !v))}
                      <div class="cp3-cell cp3-label">
                        <div class="cp3-label-inner">
                          <CheckBox checked={tpoDraft.volume.showValues} onToggle={() => setTpoDraft("volume", "showValues", (v) => !v)} />
                          <span class="cp3-title" onClick={() => setTpoDraft("volume", "showValues", (v) => !v)}>Values</span>
                        </div>
                      </div>
                      <div class="cp3-cell cp3-controls"><ColorControl color={tpoDraft.volume.valuesColor} onChange={(p) => { if (p.color) setTpoDraft("volume", "valuesColor", p.color); }} /></div>
                      {volLine("VAH", "vah", "extendVolumeVah")}
                      {volLine("VAL", "val", "extendVolumeVal")}
                      {volLine("POC", "poc", "extendVolumePoc")}
                      <div class="cp3-cell cp3-label"><div class="cp3-label-inner"><span class="cp3-title">Volume</span></div></div>
                      <div class="cp3-cell cp3-controls"><ColorControl color={tpoDraft.volume.nonVaColor} onChange={(p) => { if (p.color) setTpoDraft("volume", "nonVaColor", p.color); }} /></div>
                      <div class="cp3-cell cp3-label"><div class="cp3-label-inner"><span class="cp3-title">Value area</span></div></div>
                      <div class="cp3-cell cp3-controls"><ColorControl color={tpoDraft.volume.vaColor} onChange={(p) => { if (p.color) setTpoDraft("volume", "vaColor", p.color); }} /></div>
                      <div class="cp3-cell cp3-label"><div class="cp3-label-inner"><span class="cp3-title">Placement</span></div></div>
                      <div class="cp3-cell cp3-controls">
                        <SelectControl value={tpoDraft.volume.placement} options={["Left", "Right"]} width={100} onPick={(o) => setTpoDraft("volume", "placement", o as "Left" | "Right")} />
                      </div>
                    </div>
                  }
                >
                  <div class="ind3-grid">
                    <div class="cp3-section ind3-section is-first">Appearance</div>
                    <div class="cp3-cell cp3-label"><div class="cp3-label-inner"><span class="cp3-title">Gradient colors</span></div></div>
                    <div class="cp3-cell cp3-controls">
                      <For each={[0, 1, 2, 3] as const}>
                        {(i) => <ColorControl color={tpoDraft.colors[i]} onChange={(p) => { if (p.color) setTpoDraft("colors", i, p.color); }} />}
                      </For>
                    </div>
                    {check("Blocks", "showBlocks")}
                    {check("Letters", "showLetters")}
                    <div class="cp3-cell cp3-label"><div class="cp3-label-inner"><span class="cp3-title">Opacity outside VA</span></div></div>
                    <div class="cp3-cell cp3-controls"><TransparencySlider class="ind3-tpo-opacity" value={tpoDraft.nonVaOpacity} onChange={(t) => setTpoDraft("nonVaOpacity", t)} /></div>
                    <div class="cp3-cell cp3-label">
                      <div class="cp3-label-inner">
                        <CheckBox checked={tpoDraft.expand} onToggle={() => setTpoDraft("expand", (v) => !v)} />
                        <span class="cp3-title" onClick={() => setTpoDraft("expand", (v) => !v)}>Expand blocks</span>
                      </div>
                    </div>
                    <div class="cp3-cell cp3-controls">
                      <SelectControl value={tpoDraft.expandMode} options={["All", "Last profile"]} width={100} onPick={(o) => setTpoDraft("expandMode", o as "All" | "Last profile")} />
                    </div>
                    <div class="cp3-section ind3-section">Lines and labels</div>
                    {level("POC", "poc", "extendPOC")}
                    {level("Poor high", "poorHigh", "extendPoorHigh")}
                    {level("Poor low", "poorLow", "extendPoorLow")}
                    {level("Single prints", "singlePrints", "extendSingleprints")}
                    {level("VAH", "vah", "extendTpoVah")}
                    {level("VAL", "val", "extendTpoVal")}
                    {check("TPO Midpoint", "midpoint")}
                    {check("Open", "open")}
                    {check("Close", "close")}
                    <div class="cp3-cell cp3-label">
                      <div class="cp3-label-inner">
                        <CheckBox checked={tpoDraft.initialBalance} onToggle={() => setTpoDraft("initialBalance", (v) => !v)} />
                        <span class="cp3-title" onClick={() => setTpoDraft("initialBalance", (v) => !v)}>Initial Balance Range</span>
                      </div>
                    </div>
                    <div class="cp3-cell cp3-controls">
                      <NumberField
                        value={String(tpoDraft.ibBlocks)}
                        num={{ min: 1, max: 1000, step: 1, int: true }}
                        disabled={!tpoDraft.initialBalance}
                        onChange={(v) => { const n = parseFloat(v); if (Number.isFinite(n)) setTpoDraft("ibBlocks", Math.round(n)); }}
                      />
                    </div>
                    <div class="cp3-section ind3-section">Input values</div>
                    {checkRow("Inputs in status line", () => optDraft.inputsInStatusLine, () => setOptDraft("inputsInStatusLine", (v) => !v))}
                  </div>
                </Show>
              );
            })()}
          </Show>

          {/* ── Style (volume profiles): the profile rows, its lines, the
              developing POC / VA plots, the histogram box, then the study
              options (no Precision row). ── */}
          <Show when={tab() === "style" && props.profile}>
            {(pf) => {
              const color = (label: string, get: () => string, set: (c: string) => void) => (
                <>
                  <div class="cp3-cell cp3-label is-offset"><div class="cp3-label-inner"><span class="cp3-title">{label}</span></div></div>
                  <div class="cp3-cell cp3-controls"><ColorControl color={get()} onChange={(p) => { if (p.color) set(p.color); }} /></div>
                </>
              );
              const line = (label: string, key: "vah" | "val" | "poc") => (
                <>
                  <div class="cp3-cell cp3-label">
                    <div class="cp3-label-inner">
                      <CheckBox checked={vbpDraft[key].visible} onToggle={() => setVbpDraft(key, "visible", (v) => !v)} />
                      <span class="cp3-title" onClick={() => setVbpDraft(key, "visible", (v) => !v)}>{label}</span>
                    </div>
                  </div>
                  <div class="cp3-cell cp3-controls">
                    <ColorControl
                      color={vbpDraft[key].color}
                      width={vbpDraft[key].width}
                      style={vbpDraft[key].style}
                      onChange={(p) =>
                        setVbpDraft(key, (l: VbpLine) => ({
                          ...l,
                          ...(p.color ? { color: p.color } : {}),
                          ...(p.width !== undefined ? { width: Math.max(1, Math.min(4, Math.round(p.width))) } : {}),
                          ...(p.style !== undefined ? { style: p.style } : {}),
                        }))
                      }
                    />
                  </div>
                </>
              );
              /** Developing POC / VA: plot styles (VA = its high and low lines together). */
              const developing = (label: string, ids: string[]) => {
                const toggle = () => {
                  const v = !styleDraft[ids[0]].visible;
                  for (const id of ids) setStyleDraft(id, "visible", v);
                };
                return (
                  <Show when={ids.every((id) => styleDraft[id])}>
                    <div class="cp3-cell cp3-label">
                      <div class="cp3-label-inner">
                        <CheckBox checked={styleDraft[ids[0]].visible} onToggle={toggle} />
                        <span class="cp3-title" onClick={toggle}>{label}</span>
                      </div>
                    </div>
                    <div class="cp3-cell cp3-controls">
                      <ColorControl
                        color={styleDraft[ids[0]].color}
                        width={styleDraft[ids[0]].lineWidth}
                        onChange={(p) => {
                          for (const id of ids) {
                            if (p.color) setStyleDraft(id, "color", p.color);
                            if (p.width !== undefined) setStyleDraft(id, "lineWidth", Math.max(1, Math.min(4, Math.round(p.width))));
                          }
                        }}
                      />
                    </div>
                  </Show>
                );
              };
              return (
                <div class="ind3-grid">
                  {checkRow("Volume profile", () => vbpDraft.visible, () => setVbpDraft("visible", (v) => !v))}
                  <div class="cp3-cell cp3-label is-offset">
                    <div class="cp3-label-inner">
                      <CheckBox checked={vbpDraft.showValues} onToggle={() => setVbpDraft("showValues", (v) => !v)} />
                      <span class="cp3-title" onClick={() => setVbpDraft("showValues", (v) => !v)}>Values</span>
                    </div>
                  </div>
                  <div class="cp3-cell cp3-controls"><ColorControl color={vbpDraft.valuesColor} onChange={(p) => { if (p.color) setVbpDraft("valuesColor", p.color); }} /></div>
                  <div class="cp3-cell cp3-label is-offset"><div class="cp3-label-inner"><span class="cp3-title">Width (% of the box)</span></div></div>
                  <div class="cp3-cell cp3-controls">
                    <NumberField
                      value={String(vbpDraft.percentWidth)}
                      num={{ min: 1, max: 100, step: 1, int: true }}
                      onChange={(v) => { const n = parseFloat(v); if (Number.isFinite(n)) setVbpDraft("percentWidth", Math.round(n)); }}
                    />
                  </div>
                  <div class="cp3-cell cp3-label is-offset"><div class="cp3-label-inner"><span class="cp3-title">Placement</span></div></div>
                  <div class="cp3-cell cp3-controls">
                    <SelectControl value={vbpDraft.placement} options={["Left", "Right"]} width={selectWidth([vbpDraft.placement])} onPick={(o) => setVbpDraft("placement", o as "Left" | "Right")} />
                  </div>
                  {color("Up Volume", () => vbpDraft.upColor, (c) => setVbpDraft("upColor", c))}
                  {color("Down Volume", () => vbpDraft.downColor, (c) => setVbpDraft("downColor", c))}
                  {color("Value Area Up", () => vbpDraft.vaUpColor, (c) => setVbpDraft("vaUpColor", c))}
                  {color("Value Area Down", () => vbpDraft.vaDownColor, (c) => setVbpDraft("vaDownColor", c))}
                  {line("VAH", "vah")}
                  {line("VAL", "val")}
                  {line("POC", "poc")}
                  {developing("Developing POC", ["developingPoc"])}
                  {developing("Developing VA", ["developingVAHigh", "developingVALow"])}
                  <Show when={pf().histogramBox}>
                    <div class="cp3-cell cp3-label"><div class="cp3-label-inner"><span class="cp3-title">Histogram Box</span></div></div>
                    <div class="cp3-cell cp3-controls"><ColorControl color={vbpDraft.boxColor} onChange={(p) => { if (p.color) setVbpDraft("boxColor", p.color); }} /></div>
                  </Show>
                  {checkRow("Labels on price scale", () => optDraft.labelsOnScale, () => setOptDraft("labelsOnScale", (v) => !v))}
                  {checkRow("Values in status line", () => optDraft.valuesInStatusLine, () => setOptDraft("valuesInStatusLine", (v) => !v))}
                  <div class="cp3-section ind3-section">Input values</div>
                  {checkRow("Inputs in status line", () => optDraft.inputsInStatusLine, () => setOptDraft("inputsInStatusLine", (v) => !v))}
                </div>
              );
            }}
          </Show>

          {/* ── Style ── one row group per output (reference order, style-outputs.ts): a line plot = visible check
              box + colour and thickness (color-with-thickness button; thickness is in its colour panel) + plot type;
              the other outputs (StyleOutputRows); the drawing groups under "Graphic objects". */}
          <Show when={tab() === "style" && !props.strategy && !props.profile && !props.tpo}>
            <div class="ind3-grid">
              {outputRowsJsx()}
              {valueRowsJsx(otherItems().length + stylePlots.length === 0)}
            </div>
          </Show>

          {/* ── Visibility ── intervals visibility matrix (same as the
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
            <button type="button" class="cp3-btn" onClick={() => cancel()}>Cancel</button>
            <button type="button" class="cp3-btn is-primary" data-qa-id="submit-button" onClick={ok}>Ok</button>
          </div>
        </footer>
      </div>
    </div>
  );
}
