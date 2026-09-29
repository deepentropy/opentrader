/*
 * ChartPropertiesDialog — the chart "Settings" (series-properties) modal opened
 * from the header gear (`header-toolbar-properties`) and the chart right-click →
 * Settings… (via the `chart-open-settings` window event).
 *
 * Layout + controls: 750-wide shell, 68 px header, 226 px rail
 * (20 px inset, 206 px tabs), a `auto 1fr` property grid (16/20 padding, 8 px
 * cell padding → 50 px rows, 42 px for grouped rows, 16 px group gaps), 67 px
 * footer. Controls: white check boxes, transparent r8
 * selects with the 18 px chevron and a r10 option menu, 34 px colour boxes
 * (24 px swatch on the dark opacity pattern) or the 75 px colour + line
 * button, the shared colour panel (palette, custom colours, Opacity,
 * Thickness, Line style), 100 px number fields with spin buttons.
 *
 * The Symbol tab shows the style rows of the pane's chart type above "Data
 * modification".
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import {
  SETTINGS_TABS,
  DEFAULT_SETTINGS_TAB,
  STYLE_TITLES,
  TAB_FORMS,
  rowIdOf,
  styleGroupOf,
  styleTab,
  type SettingsTabIcon,
  type Control,
  type FormItem,
  type FormRow,
} from "../../data/chart-properties";
import {
  makeDefaultDraft,
  cloneDraft,
  reviveDraft,
  keyOf,
  SETTINGS_FINGERPRINT,
  SETTINGS_REV,
  type Draft,
  type CtrlValue,
} from "./chart-settings";
import type { ChartTypeId } from "../chart/chart-types";
import { ColorPanel } from "../drawings/ColorPanel";
import { LineGlyphSelect } from "../drawings/LineEndSelect";
import { TransparencySlider } from "../drawings/ImageDialog";
import type { LineStyle } from "lightweight-charts-drawing/tv/types";
import * as kv from "../../data/kv";
import { usMarketSession } from "../../data/market-session";
import { showConfirm, showRename } from "../../components/Dialogs";

type Props = {
  onClose: () => void;
  /** The focused pane's committed settings to seed the draft from (undefined →
   *  factory defaults). */
  seed?: Draft;
  /** The focused pane's chart type — selects the Symbol tab's style rows. */
  chartType?: ChartTypeId;
  /** Intraday interval: the pre/post background row shows only then. */
  intraday?: boolean;
  /** Commit the edited draft to the focused pane ("active") or every pane in the
   *  layout ("all", from the "Apply to all" button). */
  onCommit: (draft: Draft, scope: "active" | "all") => void;
  /** Tab to open on (the axis menus'
   *  "More settings…" opens "scales"). Default: the Symbol tab. */
  initialTab?: string;
};

// ── Glyphs ──
function TabGlyph(props: { icon: SettingsTabIcon }) {
  return (
    <svg class="settings-tab-icon" width="28" height="28" viewBox={props.icon.viewBox} fill={props.icon.fill} aria-hidden="true" innerHTML={props.icon.inner} />
  );
}
/** Check box mark (11×9). */
const CheckMark = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 11 9" width="11" height="9" fill="none" aria-hidden="true"><path stroke="currentColor" stroke-width="2" d="M0.999878 4L3.99988 7L9.99988 1" /></svg>
);
/** Select caret / spin arrow (18×18). */
const Chevron = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3.92 7.83 9 12.29l5.08-4.46-1-1.13L9 10.29l-4.09-3.6-.99 1.14Z" /></svg>
);
const HelpIcon = (p: { tip?: string }) => (
  <span class="cp3-help" title={p.tip} aria-hidden="true">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18"><path fill="currentColor" fill-rule="evenodd" d="M9 17A8 8 0 1 0 9 1a8 8 0 0 0 0 16Zm-1-4a1 1 0 1 0 2 0 1 1 0 0 0-2 0Zm2.83-3.52c-.49.43-.97.85-1.06 1.52H8.26c.08-1.18.74-1.69 1.32-2.13.49-.38.92-.71.92-1.37C10.5 6.67 9.82 6 9 6s-1.5.67-1.5 1.5V8H6v-.5a3 3 0 1 1 6 0c0 .96-.6 1.48-1.17 1.98Z" /></svg>
  </span>
);

// ── Settings templates (footer "Template" menu) ──
// One kv blob: [{ name, fingerprint, draft }]. `fingerprint` is the draft
// format stamp; reviveDraft converts older formats and refuses unknown ones.
const TEMPLATES_KEY = "ot:chart-settings-templates";
type SettingsTemplate = { name: string; fingerprint: string; rev?: number; draft: unknown };

function loadTemplates(): SettingsTemplate[] {
  try {
    const raw = kv.getItem(TEMPLATES_KEY);
    const arr: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (t): t is SettingsTemplate =>
        !!t && typeof t === "object" && typeof (t as SettingsTemplate).name === "string",
    );
  } catch {
    return [];
  }
}
const persistTemplates = (list: SettingsTemplate[]) =>
  kv.setItem(TEMPLATES_KEY, JSON.stringify(list));

// ── Popover plumbing ──
type Anchor = { left: number; top: number; bottom: number; width: number };
const anchorOf = (el: HTMLElement): Anchor => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, bottom: r.bottom, width: r.width };
};

/** Outside-press + Escape dismissal for a popover (the trigger itself toggles). */
function createDismiss(getRefs: () => (HTMLElement | undefined)[], onClose: () => void) {
  const onDown = (e: PointerEvent) => {
    const t = e.target as Node;
    if (getRefs().some((el) => el?.contains(t))) return;
    onClose();
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
  onMount(() => {
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
  });
  onCleanup(() => {
    document.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("keydown", onKey, true);
  });
}

// ── Check box (18 px, #f2f2f2 box / #2e2e2e mark) ──
export function CheckBox(props: { checked: boolean; disabled?: boolean; onToggle: () => void }) {
  return (
    <span
      class={`cp3-checkbox${props.checked ? " is-checked" : ""}${props.disabled ? " is-disabled" : ""}`}
      role="checkbox"
      aria-checked={props.checked}
      tabIndex={0}
      onClick={() => !props.disabled && props.onToggle()}
      onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); if (!props.disabled) props.onToggle(); } }}
    >
      <Show when={props.checked}><CheckMark /></Show>
    </span>
  );
}

// ── Select (34 px, r8, transparent, chevron; menu r10 under it) ──
function OptionsMenu(props: {
  anchor: Anchor;
  trigger: () => HTMLElement | undefined;
  children: JSX.Element;
  onClose: () => void;
  role?: "listbox" | "menu";
}) {
  let ref: HTMLDivElement | undefined;
  createDismiss(() => [ref, props.trigger()], props.onClose);
  // The menu opens flush under the trigger, trigger-wide; flip above when
  // there is no room below.
  const [top, setTop] = createSignal(props.anchor.bottom);
  onMount(() => {
    if (!ref) return;
    const h = ref.offsetHeight;
    if (props.anchor.bottom + h > window.innerHeight - 4) setTop(Math.max(4, props.anchor.top - h));
  });
  return (
    <div
      ref={ref}
      class="cp3-menu"
      role={props.role ?? "listbox"}
      style={{ left: `${props.anchor.left}px`, top: `${top()}px`, "min-width": `${props.anchor.width}px` }}
    >
      {props.children}
    </div>
  );
}

export function SelectControl(props: { value: string; options: string[]; width: number; disabled?: boolean; onPick: (v: string) => void }) {
  let btn: HTMLButtonElement | undefined;
  const [anchor, setAnchor] = createSignal<Anchor | null>(null);
  return (
    <>
      <button
        ref={btn}
        type="button"
        class={`cp3-select${props.disabled ? " is-disabled" : ""}${anchor() ? " is-open" : ""}`}
        style={{ width: `${props.width}px` }}
        aria-haspopup="listbox"
        aria-expanded={!!anchor()}
        disabled={props.disabled}
        onClick={() => (anchor() ? setAnchor(null) : setAnchor(anchorOf(btn!)))}
      >
        <span class="cp3-select-value">{props.value}</span>
        <span class="cp3-select-caret"><Chevron /></span>
      </button>
      <Show when={anchor()} keyed>
        {(a) => (
          <OptionsMenu anchor={a} trigger={() => btn} onClose={() => setAnchor(null)}>
            <For each={props.options}>
              {(o) => (
                <div
                  role="option"
                  aria-checked={o === props.value}
                  class={`cp3-menu-item${o === props.value ? " is-selected" : ""}`}
                  onClick={() => { props.onPick(o); setAnchor(null); }}
                >
                  <span class="cp3-menu-title">{o}</span>
                </div>
              )}
            </For>
          </OptionsMenu>
        )}
      </Show>
    </>
  );
}

/** Closed-control text for a check list: checked options in catalog order,
 *  the first as is and the rest lower-cased ("Value, line"); none checked
 *  reads "Hidden". */
function multiSummary(options: string[], on: string[]): string {
  const picked = options.filter((o) => on.includes(o));
  if (picked.length === 0) return "Hidden";
  return picked.map((o, i) => (i === 0 ? o : o.toLowerCase())).join(", ");
}

/** Check-list select: toggling an option keeps the menu open. */
function MultiCheckControl(props: { options: string[]; on: string[]; width: number; onChange: (on: string[]) => void }) {
  let btn: HTMLButtonElement | undefined;
  const [anchor, setAnchor] = createSignal<Anchor | null>(null);
  const toggle = (o: string) =>
    props.onChange(props.on.includes(o) ? props.on.filter((x) => x !== o) : [...props.on, o]);
  return (
    <>
      <button
        ref={btn}
        type="button"
        class={`cp3-select${anchor() ? " is-open" : ""}`}
        style={{ width: `${props.width}px` }}
        aria-haspopup="menu"
        aria-expanded={!!anchor()}
        onClick={() => (anchor() ? setAnchor(null) : setAnchor(anchorOf(btn!)))}
      >
        <span class="cp3-select-value">{multiSummary(props.options, props.on)}</span>
        <span class="cp3-select-caret"><Chevron /></span>
      </button>
      <Show when={anchor()} keyed>
        {(a) => (
          <OptionsMenu anchor={a} trigger={() => btn} onClose={() => setAnchor(null)} role="menu">
            <For each={props.options}>
              {(o) => (
                <div role="menuitemcheckbox" aria-checked={props.on.includes(o)} class="cp3-menu-item cp3-menu-check" onClick={() => toggle(o)}>
                  <CheckBox checked={props.on.includes(o)} onToggle={() => {}} />
                  <span class="cp3-menu-title">{o}</span>
                </div>
              )}
            </For>
          </OptionsMenu>
        )}
      </Show>
    </>
  );
}

// ── Colour controls ──
const STYLE_IDS: LineStyle[] = ["solid", "dashed", "dotted"];
const lineCss = (width: number, style: number | undefined) =>
  `${Math.max(1, width)}px ${style === 1 ? "dashed" : style === 2 ? "dotted" : "solid"}`;

/** Fixed-position host for the shared colour panel, under its trigger. */
function ColorPanelHost(props: { anchor: () => HTMLElement | undefined; onDismiss: () => void; children: JSX.Element }) {
  let ref: HTMLDivElement | undefined;
  createDismiss(() => [ref, props.anchor()], props.onDismiss);
  const r = props.anchor()?.getBoundingClientRect();
  const left = Math.max(8, Math.min(r?.left ?? 0, window.innerWidth - 258));
  const top = Math.min((r?.bottom ?? 0) + 4, window.innerHeight - 120);
  return (
    <div ref={ref} class="dt-popover dlg-color-panel cp3-color-panel" style={{ position: "fixed", left: `${left}px`, top: `${top}px`, "max-height": `${window.innerHeight - top - 8}px` }}>
      {props.children}
    </div>
  );
}

/** `color-select` (34 px box) or, with width / style, the 75 px colour +
 *  line button (`color-with-thickness-select`). `color === ""` = automatic. */
export function ColorControl(props: {
  color: string;
  width?: number;
  style?: number;
  noOpacity?: boolean;
  disabled?: boolean;
  onChange: (patch: { color?: string; width?: number; style?: number }) => void;
}) {
  let btn: HTMLButtonElement | undefined;
  const [open, setOpen] = createSignal(false);
  const combined = () => props.width !== undefined || props.style !== undefined;
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
          <span class="cp3-line" style={{ "border-top": lineCss(props.width ?? 1, props.style) }} />
        </Show>
      </button>
      <Show when={open()}>
        <ColorPanelHost anchor={() => btn} onDismiss={() => setOpen(false)}>
          <ColorPanel
            value={props.color || "#000000"}
            noOpacity={props.noOpacity}
            onChange={(c) => props.onChange({ color: c })}
            onPicked={() => setOpen(false)}
            thickness={props.width}
            onThickness={props.width !== undefined ? (w) => { props.onChange({ width: w }); setOpen(false); } : undefined}
            lineStyle={props.style !== undefined ? STYLE_IDS[props.style] : undefined}
            onLineStyle={props.style !== undefined ? (s) => { props.onChange({ style: STYLE_IDS.indexOf(s) }); setOpen(false); } : undefined}
          />
        </ColorPanelHost>
      </Show>
    </>
  );
}

// ── Number field (number input: 100×34, r8, spin buttons) ──
export function NumberField(props: {
  value: string;
  unit?: string;
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
  const commit = (text: string, el?: HTMLInputElement) => {
    const n = parseFloat(text);
    if (!Number.isFinite(n)) { if (el) el.value = props.value; return; }
    const v = String(Number(clamp(n).toFixed(8)));
    props.onChange(v);
    if (el) el.value = v;
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
          value={props.value}
          disabled={props.disabled}
          onChange={(e) => commit(e.currentTarget.value, e.currentTarget)}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") { e.preventDefault(); step(1); }
            else if (e.key === "ArrowDown") { e.preventDefault(); step(-1); }
            else if (e.key === "Enter") commit(e.currentTarget.value, e.currentTarget);
          }}
        />
        <Show when={props.num && !props.disabled}>
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

// Default control widths.
const SELECT_W: Record<string, number> = {
  "Currency and Unit": 180, "Scale modes (A and L)": 180, "Symbol value mode": 180,
  Navigation: 180, Pane: 180, "Time hours format": 100, Text: 100, Ideas: 100,
  Positions: 100, Brackets: 100, "Order and position alignment": 100,
};
const selectWidth = (rowId: string, c: Control) =>
  c.c === "multicheck" ? 180 : SELECT_W[rowId] ?? 150;

// ── One control (controlled by the draft) ──
function ControlView(props: {
  rowId: string;
  c: Control;
  v: CtrlValue;
  disabled?: boolean;
  onChange: (nv: CtrlValue) => void;
}) {
  return (
    <Show when={props.v} keyed>
      {(v) => {
        const c = props.c;
        switch (v.kind) {
          case "select":
            return (
              <SelectControl
                value={v.value}
                options={c.c === "select" ? c.options : [v.value]}
                width={selectWidth(props.rowId, c)}
                disabled={props.disabled || (c.c === "select" && c.disabled)}
                onPick={(o) => props.onChange({ kind: "select", value: o })}
              />
            );
          case "multicheck":
            return (
              <MultiCheckControl
                options={c.c === "multicheck" ? c.options : []}
                on={v.on}
                width={selectWidth(props.rowId, c)}
                onChange={(on) => props.onChange({ kind: "multicheck", on })}
              />
            );
          case "color":
            return (
              <ColorControl
                color={v.color}
                width={v.width}
                style={v.style}
                noOpacity={c.c === "color" && c.noOpacity}
                disabled={props.disabled}
                onChange={(p) => props.onChange({ ...v, ...p })}
              />
            );
          case "colorPair":
            return (
              <>
                <ColorControl color={v.up} noOpacity={c.c === "colorPair" && c.noOpacity} disabled={props.disabled} onChange={(p) => p.color && props.onChange({ ...v, up: p.color })} />
                <ColorControl color={v.down} noOpacity={c.c === "colorPair" && c.noOpacity} disabled={props.disabled} onChange={(p) => p.color && props.onChange({ ...v, down: p.color })} />
              </>
            );
          case "lineColor":
            // Type select, then Solid → colour + thickness,
            // Gradient → start / end colours + line width select.
            return (
              <>
                <SelectControl value={v.type} options={["Solid", "Gradient"]} width={150} disabled={props.disabled} onPick={(o) => props.onChange({ ...v, type: o === "Gradient" ? "Gradient" : "Solid" })} />
                <Show
                  when={v.type === "Gradient"}
                  fallback={<ColorControl color={v.color} width={v.width} disabled={props.disabled} onChange={(p) => props.onChange({ ...v, ...(p.color ? { color: p.color } : {}), ...(p.width ? { width: p.width } : {}) })} />}
                >
                  <ColorControl color={v.start} disabled={props.disabled} onChange={(p) => p.color && props.onChange({ ...v, start: p.color })} />
                  <ColorControl color={v.end} disabled={props.disabled} onChange={(p) => p.color && props.onChange({ ...v, end: p.color })} />
                  <LineGlyphSelect kind="width" value={v.width} options={[1, 2, 3, 4]} onChange={(w) => props.onChange({ ...v, width: w })} />
                </Show>
              </>
            );
          case "input":
            return (
              <NumberField
                value={v.value}
                unit={c.c === "input" ? c.unit : undefined}
                num={c.c === "input" ? c.num : undefined}
                width={props.rowId === "Lock price to bar ratio" ? 150 : undefined}
                disabled={props.disabled}
                onChange={(t) => props.onChange({ kind: "input", value: t })}
              />
            );
          case "slider":
            return (
              <span class={`cp3-slider${props.disabled ? " is-disabled" : ""}`}>
                <TransparencySlider value={v.value} onChange={(t) => props.onChange({ kind: "slider", value: t })} />
              </span>
            );
        }
      }}
    </Show>
  );
}

/** One entry of the rendered form: the item plus the draft tab it belongs to
 *  (the Symbol tab mixes the chart-type form with its own rows). */
type Entry = { tab: string; item: FormItem };

export function ChartPropertiesDialog(props: Props) {
  const [active, setActive] = createSignal(props.initialTab ?? DEFAULT_SETTINGS_TAB);
  // Working copy, seeded from the committed snapshot when the dialog opens.
  const [draft, setDraft] = createStore<Draft>(cloneDraft(props.seed ?? makeDefaultDraft()));

  const group = () => styleGroupOf(props.chartType ?? "candle");
  const entries = createMemo<Entry[]>(() => {
    const tab = active();
    if (tab !== "symbol") return (TAB_FORMS[tab] ?? []).map((item) => ({ tab, item }));
    const g = group();
    const st = styleTab(g);
    const form = TAB_FORMS[st] ?? [];
    // The style group is titled with the chart-type name, except pages that
    // bring their own group titles (Session volume profile).
    const titled = form.length > 0 && form[0].kind !== "section";
    return [
      ...(titled ? [{ tab: st, item: { kind: "section", text: STYLE_TITLES[g] } as FormItem }] : []),
      ...form.map((item) => ({ tab: st, item })),
      ...(TAB_FORMS.symbol ?? []).map((item) => ({ tab: "symbol", item })),
    ];
  });

  const toggle = (key: string) => setDraft(key, "checked", (c) => !c);
  const setControl = (key: string, idx: number, nv: CtrlValue) => setDraft(key, "controls", idx, nv);

  /** Row visibility: `visibleWhen` select value + the intraday-only rule
   *  for the pre/post background row. */
  const visible = (tab: string, r: FormRow): boolean => {
    if (tab === "symbol" && r.label === "Pre/post market hours background" && props.intraday === false) return false;
    // "Open market status" only while the market is open.
    if (tab === "legend" && r.label === "Open market status" && usMarketSession() !== "open") return false;
    if (!r.visibleWhen) return true;
    const c = draft[keyOf(tab, r.visibleWhen.id)]?.controls?.[0];
    return !!c && c.kind === "select" && r.visibleWhen.values.includes(c.value);
  };
  /** Controls greyed out by their row's own state (a checkable row's
   *  controls follow its check box; the lock-ratio field is editable only
   *  while locked; check-list colours only while something is shown). */
  const controlsDisabled = (r: FormRow, key: string): boolean => {
    const row = draft[key];
    if (!row) return false;
    if (rowIdOf(r) === "Lock price to bar ratio") return !row.checked;
    if (r.cb && row.checked === false) return true;
    const mc = row.controls[0];
    if (mc?.kind === "multicheck" && mc.on.length === 0) return true;
    return false;
  };

  const applyAll = () => { props.onCommit(draft, "all"); props.onClose(); };
  const ok = () => { props.onCommit(draft, "active"); props.onClose(); };
  const reset = () => setDraft(reconcile(makeDefaultDraft()));

  // Template menu — entries whose draft revives under this build.
  const byName = (a: SettingsTemplate, b: SettingsTemplate) => a.name.localeCompare(b.name, undefined, { numeric: true });
  const [templates, setTemplates] = createSignal<SettingsTemplate[]>(
    loadTemplates().filter((t) => reviveDraft(t.draft, t.fingerprint, t.rev) !== undefined).sort(byName),
  );
  const [tplAnchor, setTplAnchor] = createSignal<Anchor | null>(null);
  let tplBtn: HTMLButtonElement | undefined;
  const saveTemplate = (name: string) => {
    const entry: SettingsTemplate = { name, fingerprint: SETTINGS_FINGERPRINT, rev: SETTINGS_REV, draft: cloneDraft(draft) };
    persistTemplates([...loadTemplates().filter((t) => t.name !== name), entry]);
    setTemplates((list) => [...list.filter((t) => t.name !== name), entry].sort(byName));
  };
  const applyTemplate = (t: SettingsTemplate) => {
    const revived = reviveDraft(t.draft, t.fingerprint, t.rev);
    if (revived) setDraft(reconcile(revived));
  };
  const removeTemplate = (name: string) => {
    persistTemplates(loadTemplates().filter((t) => t.name !== name));
    setTemplates((list) => list.filter((t) => t.name !== name));
  };

  // Dialog-level Escape: popovers stop propagation of their own Escape first.
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !tplAnchor()) { e.stopPropagation(); props.onClose(); }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  const RowView = (p: { tab: string; r: FormRow }) => {
    const key = keyOf(p.tab, rowIdOf(p.r));
    const controls = p.r.controls ?? [];
    const full = controls.length === 0;
    const dis = () => controlsDisabled(p.r, key);
    return (
      <Show when={visible(p.tab, p.r)}>
        <div class={`cp3-cell cp3-label${full ? " is-full" : ""}${p.r.indent ? " is-offset" : ""}${p.r.grouped ? " is-grouped" : ""}${p.r.child ? " is-child" : ""}`}>
          <div class="cp3-label-inner">
            <Show when={p.r.cb}>
              <CheckBox checked={!!draft[key]?.checked} onToggle={() => toggle(key)} />
            </Show>
            <Show when={p.r.label != null}>
              <span class="cp3-title" onClick={() => p.r.cb && toggle(key)}>{p.r.label}</span>
            </Show>
            <Show when={p.r.help}><HelpIcon tip={typeof p.r.help === "string" ? p.r.help : undefined} /></Show>
          </div>
          <Show when={p.r.desc}><div class="cp3-desc">{p.r.desc}</div></Show>
        </div>
        <Show when={!full}>
          <div class={`cp3-cell cp3-controls${p.r.grouped ? " is-grouped" : ""}${p.r.child ? " is-child" : ""}`}>
            <For each={controls}>
              {(c, j) => (
                <Show when={!(p.tab === "canvas" && p.r.label === "Background" && j() === 2 && draft[key]?.controls?.[0]?.kind === "select" && (draft[key].controls[0] as { value: string }).value !== "Gradient")}>
                  <ControlView
                    rowId={rowIdOf(p.r)}
                    c={c}
                    v={draft[key].controls[j()]}
                    disabled={dis() && c.c !== "multicheck"}
                    onChange={(nv) => setControl(key, j(), nv)}
                  />
                </Show>
              )}
            </For>
          </div>
        </Show>
      </Show>
    );
  };

  // Vertical position rule: the
  // dialog is centred once for the tab it opens on; on a later height change
  // (tab switch) its top stays, and it only moves up when the new height
  // would pass the window bottom (20 px margin, top never above 20 px). It
  // never moves back down. Max height = window height - 40 px.
  const EDGE = 20;
  let dialogEl: HTMLDivElement | undefined;
  const [top, setTop] = createSignal<number | null>(null);
  onMount(() => {
    if (!dialogEl) return;
    const place = (first: boolean) => {
      const h = dialogEl!.offsetHeight;
      const vh = window.innerHeight;
      if (first) { setTop(Math.max(EDGE, Math.round((vh - h) / 2))); return; }
      const t = top() ?? EDGE;
      if (t + h > vh - EDGE) setTop(Math.max(EDGE, vh - EDGE - h));
    };
    place(true);
    const ro = new ResizeObserver(() => place(false));
    ro.observe(dialogEl);
    const onResize = () => place(false);
    window.addEventListener("resize", onResize);
    onCleanup(() => { ro.disconnect(); window.removeEventListener("resize", onResize); });
  });

  return (
    <div class="settings-backdrop cp3-backdrop" role="presentation" onMouseDown={() => props.onClose()}>
      <div
        ref={dialogEl}
        class="settings-dialog cp3-dialog"
        style={{ top: top() === null ? undefined : `${top()}px`, visibility: top() === null ? "hidden" : undefined }}
        data-qa-id="series-properties-dialog"
        role="dialog"
        aria-label="Settings"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header class="cp3-header">
          <div class="cp3-header-title">Settings</div>
          <button type="button" data-qa-id="close" aria-label="Close menu" class="cp3-close" onClick={() => props.onClose()}>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18"><path stroke="currentColor" stroke-width="1.2" fill="none" d="m1.5 1.5 15 15m0-15-15 15" /></svg>
          </button>
        </header>

        <div class="cp3-body">
          <nav class="cp3-tabs" aria-label="Settings sections">
            <For each={SETTINGS_TABS}>
              {(tab) => (
                <button type="button" data-qa-id={tab.id} class={`settings-tab${active() === tab.id ? " is-active" : ""}`} aria-current={active() === tab.id} onClick={() => setActive(tab.id)}>
                  <TabGlyph icon={tab.icon} />
                  <span class="settings-tab-label">{tab.label}</span>
                </button>
              )}
            </For>
          </nav>

          <div class="cp3-content">
            <div class="cp3-grid">
              <For each={entries()}>
                {(e, i) => {
                  const it = e.item;
                  if (it.kind === "section")
                    return <div class={`cp3-section${i() === 0 ? " is-first" : ""}`}><span>{it.text}</span></div>;
                  if (it.kind === "gap") return <div class="cp3-group-gap" />;
                  return <RowView tab={e.tab} r={it} />;
                }}
              </For>
            </div>
          </div>
        </div>

        <footer class="cp3-footer">
          <button
            ref={tplBtn}
            type="button"
            class="cp3-template"
            aria-haspopup="menu"
            aria-expanded={!!tplAnchor()}
            onClick={() => (tplAnchor() ? setTplAnchor(null) : setTplAnchor(anchorOf(tplBtn!)))}
          >Template <span class="cp3-select-caret"><Chevron /></span></button>
          <div class="cp3-footer-actions">
            <button type="button" class="cp3-btn" onClick={applyAll}>Apply to all</button>
            <button type="button" class="cp3-btn" onClick={() => props.onClose()}>Cancel</button>
            <button type="button" class="cp3-btn is-primary" data-qa-id="submit-button" onClick={ok}>Ok</button>
          </div>
        </footer>

        <Show when={tplAnchor()} keyed>
          {(a) => (
            <TemplateMenu
              anchor={a}
              trigger={() => tplBtn}
              templates={templates()}
              onApplyDefault={reset}
              onSaveAs={saveTemplate}
              onApply={applyTemplate}
              onRemove={removeTemplate}
              onClose={() => setTplAnchor(null)}
            />
          )}
        </Show>
      </div>
    </div>
  );
}

// Series-theme-manager menu: "Apply defaults", "Save as…", then the saved
// chart templates sorted by name with a remove trash on hover. "Save as…"
// opens the "Save template as" name dialog
// (128 chars, list of the names, replace confirmation); remove asks "Do you
// really want to delete Chart Template 'X' ?" (Yes / No). Opens upward — the
// button sits in the dialog footer.
function TemplateMenu(props: {
  anchor: Anchor;
  trigger: () => HTMLElement | undefined;
  templates: SettingsTemplate[];
  onApplyDefault: () => void;
  onSaveAs: (name: string) => void;
  onApply: (t: SettingsTemplate) => void;
  onRemove: (name: string) => void;
  onClose: () => void;
}) {
  let ref: HTMLDivElement | undefined;
  createDismiss(() => [ref, props.trigger()], props.onClose);
  const saveAs = () => {
    const names = props.templates.map((t) => t.name);
    const onSaveAs = props.onSaveAs;
    props.onClose();
    showRename({
      title: "Save template as",
      label: "Template name:",
      maxLength: 128,
      names,
      replaceText: (n) => `Template '${n}' already exists. Do you really want to replace it?`,
      onSave: onSaveAs,
    });
  };
  const remove = (name: string) => {
    const onRemove = props.onRemove;
    showConfirm({ text: `Do you really want to delete Chart Template '${name}' ?`, onConfirm: () => onRemove(name) });
  };
  return (
    <div
      ref={ref}
      class="cp3-menu settings-template-menu"
      style={{ left: `${props.anchor.left}px`, bottom: `${window.innerHeight - props.anchor.top + 4}px` }}
      role="menu"
    >
      <div role="menuitem" class="cp3-menu-item" data-qa-id="series-theme-manager-apply-defaults" onClick={() => { props.onApplyDefault(); props.onClose(); }}>
        <span class="cp3-menu-title">Apply defaults</span>
      </div>
      <div role="menuitem" class="cp3-menu-item" data-qa-id="series-theme-manager-save-as" onClick={saveAs}>
        <span class="cp3-menu-title">Save as…</span>
      </div>
      <Show when={props.templates.length > 0}>
        <div class="settings-popup-sep" role="separator" />
        <For each={props.templates}>
          {(t) => (
            <div role="menuitem" class="cp3-menu-item settings-template-item" data-series-theme-item-theme-name={t.name} onClick={() => { props.onApply(t); props.onClose(); }}>
              <span class="cp3-menu-title settings-template-item-name">{t.name}</span>
              <button
                type="button"
                class="settings-template-remove"
                aria-label="Remove"
                title="Remove"
                onClick={(e) => { e.stopPropagation(); remove(t.name); }}
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 4h3v1h-1.04l-.88 9.64a1.5 1.5 0 0 1-1.5 1.36H6.42a1.5 1.5 0 0 1-1.5-1.36L4.05 5H3V4h3v-.5C6 2.67 6.67 2 7.5 2h3c.83 0 1.5.67 1.5 1.5V4ZM7.5 3a.5.5 0 0 0-.5.5V4h4v-.5a.5.5 0 0 0-.5-.5h-3ZM5.05 5l.87 9.55a.5.5 0 0 0 .5.45h5.17a.5.5 0 0 0 .5-.45L12.94 5h-7.9Z" /></svg>
              </button>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}
