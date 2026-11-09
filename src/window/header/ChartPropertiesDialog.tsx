/*
 * ChartPropertiesDialog — the chart "Settings" (series-properties) modal opened
 * from the header gear (`header-toolbar-properties`) and the chart right-click →
 * Settings… (via the `chart-open-settings` window event).
 *
 * Layout + controls: 750-wide shell, 68 px header, 226 px rail
 * (20 px inset, 206 px tabs), a `auto 1fr` property grid (16/20 padding, 8 px
 * cell padding → 50 px rows, 42 px for grouped rows, 16 px group gaps), 67 px
 * footer. The controls are the shared form kit (components/form).
 *
 * The Symbol tab shows the style rows of the pane's chart type above "Data
 * modification".
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { chartTemplateDraft, chartTemplates, removeChartTemplate, saveChartTemplate, type SettingsTemplate } from "./chart-templates";
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
  keyOf,
  type Draft,
  type CtrlValue,
  type RowState,
} from "./chart-settings";
import type { ChartTypeId } from "../chart/chart-types";
import { LineGlyphSelect } from "../drawings/LineEndSelect";
import { TransparencySlider } from "../drawings/ImageDialog";
import { marketSession } from "../../data/market-session";
import { showConfirm, showRename } from "../../components/Dialogs";
import { isEconomicSymbol, isLocalSymbol } from "../../data/datafeed";
import { symbolDetails } from "../chart/indicators/script-chart";
import { tradingPrefs } from "../../data/trading/trading-prefs";
import { FeatureCardIcon } from "./FeatureCard";
import { CheckBox, ColorControl, MultiCheckSelect, NumberField, SelectControl } from "../../components/form";
import { Chevron } from "../../components/form/glyphs";
import { createPopover } from "../../components/popover";

/** Symbol events (dividends, splits, earnings) exist on stocks, funds and depositary receipts; shown while the
 *  type is not known yet. */
const EVENT_SYMBOL_TYPES = new Set(["stock", "fund", "dr"]);
function hasSymbolEvents(symbol: string): boolean {
  if (isEconomicSymbol(symbol) || isLocalSymbol(symbol)) return false;
  const t = symbol ? symbolDetails(symbol)?.symbolType : undefined;
  return !t || EVENT_SYMBOL_TYPES.has(t);
}

type Props = {
  onClose: () => void;
  /** The focused pane's committed settings to seed the draft from (undefined →
   *  factory defaults). */
  seed?: Draft;
  /** The focused pane's chart type — selects the Symbol tab's style rows. */
  chartType?: ChartTypeId;
  /** Intraday interval: the pre/post background row shows only then. */
  intraday?: boolean;
  /** The focused pane's symbol: "Open market status" shows only while its
   *  market is open. */
  symbol?: string;
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
const HelpIcon = (p: { tip?: string }) => (
  <span class="cp3-help" title={p.tip} aria-hidden="true">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18"><path fill="currentColor" fill-rule="evenodd" d="M9 17A8 8 0 1 0 9 1a8 8 0 0 0 0 16Zm-1-4a1 1 0 1 0 2 0 1 1 0 0 0-2 0Zm2.83-3.52c-.49.43-.97.85-1.06 1.52H8.26c.08-1.18.74-1.69 1.32-2.13.49-.38.92-.71.92-1.37C10.5 6.67 9.82 6 9 6s-1.5.67-1.5 1.5V8H6v-.5a3 3 0 1 1 6 0c0 .96-.6 1.48-1.17 1.98Z" /></svg>
  </span>
);

/** (i) info icon (the reference app's Trading rows). */
const InfoIcon = (p: { tip?: string }) => (
  <span class="cp3-help is-info" title={p.tip} aria-hidden="true">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18"><path fill="currentColor" d="M9 17A8 8 0 1 0 9 1a8 8 0 0 0 0 16Zm1-12a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM8.5 9.5H7V8h3v6H8.5V9.5Z" /></svg>
  </span>
);

// Position of the footer "Template" menu, taken from its button.
type Anchor = { left: number; top: number; bottom: number; width: number };
const anchorOf = (el: HTMLElement): Anchor => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, bottom: r.bottom, width: r.width };
};

// Default control widths.
const SELECT_W: Record<string, number> = {
  "Currency and Unit": 180, "Scale modes (A and L)": 180, "Symbol value mode": 180,
  Navigation: 180, Pane: 180, "Time hours format": 100, Text: 100, Ideas: 100,
  Positions: 100, Brackets: 100, "Order and position alignment": 100,
};
const selectWidth = (rowId: string, c: Control) =>
  c.c === "multicheck" ? 180 : SELECT_W[rowId] ?? 150;

// ── One control (controlled by the draft) ──
export function ControlView(props: {
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
              <MultiCheckSelect
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

/** One form row (label cell + controls cell) over its draft state. Shared
 *  with the compared-symbol Style tab. */
export function FormRowView(p: {
  r: FormRow;
  state: RowState | undefined;
  /** Controls greyed out (row unchecked…). */
  disabled: boolean;
  onToggle: () => void;
  onControl: (idx: number, nv: CtrlValue) => void;
  /** Controls not shown (Canvas background: the gradient's 2nd colour). */
  hideControl?: (idx: number) => boolean;
}) {
  const controls = p.r.controls ?? [];
  const full = controls.length === 0;
  // Inert rows (no backing feature) are shown disabled.
  const inert = !!p.r.inert;
  return (
    <>
      <div class={`cp3-cell cp3-label${full ? " is-full" : ""}${p.r.indent ? " is-offset" : ""}${p.r.grouped ? " is-grouped" : ""}${p.r.child ? " is-child" : ""}${inert ? " is-inert" : ""}`}>
        <div class="cp3-label-inner">
          <Show when={p.r.cb}>
            <CheckBox checked={!!p.state?.checked} disabled={inert} onToggle={p.onToggle} />
          </Show>
          <Show when={p.r.label != null}>
            <span class="cp3-title" onClick={() => p.r.cb && !inert && p.onToggle()}>{p.r.label}</span>
          </Show>
          <Show when={p.r.help}><HelpIcon tip={typeof p.r.help === "string" ? p.r.help : undefined} /></Show>
          <Show when={p.r.info}>
            <Show when={p.r.card} fallback={<InfoIcon tip={typeof p.r.info === "string" ? p.r.info : undefined} />}>
              {(c) => <FeatureCardIcon card={c()} />}
            </Show>
          </Show>
        </div>
        <Show when={p.r.desc}><div class="cp3-desc">{p.r.desc}</div></Show>
      </div>
      <Show when={!full}>
        <div class={`cp3-cell cp3-controls${p.r.grouped ? " is-grouped" : ""}${p.r.child ? " is-child" : ""}`}>
          <For each={controls}>
            {(c, j) => (
              <Show when={!p.hideControl?.(j()) && p.state?.controls[j()]}>
                <ControlView
                  rowId={rowIdOf(p.r)}
                  c={c}
                  v={p.state!.controls[j()]}
                  disabled={inert || (p.disabled && c.c !== "multicheck")}
                  onChange={(nv) => p.onControl(j(), nv)}
                />
              </Show>
            )}
          </For>
        </div>
      </Show>
    </>
  );
}

/** One entry of the rendered form: the item plus the draft tab it belongs to
 *  (the Symbol tab mixes the chart-type form with its own rows). */
type Entry = { tab: string; item: FormItem };

export function ChartPropertiesDialog(props: Props) {
  const [active, setActive] = createSignal(props.initialTab ?? DEFAULT_SETTINGS_TAB);
  // Working copy, seeded from the committed snapshot when the dialog opens.
  // The app-wide Trading rows (one-click, sound, notifications, snapshots)
  // come from the app's trading settings, not from the chart.
  const [draft, setDraft] = createStore<Draft>(cloneDraft({ ...(props.seed ?? makeDefaultDraft()), ...tradingPrefs.rows() } as Draft));

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

  /** Status line → Buy/sell buttons and Trading → Buy/sell buttons are one
   *  setting (reference app): toggling one sets the other. */
  const LINKED: Record<string, string> = { "legend:Buy/sell buttons": "trading:Buy/sell buttons", "trading:Buy/sell buttons": "legend:Buy/sell buttons" };
  const toggle = (key: string) => {
    const next = !draft[key]?.checked;
    setDraft(key, "checked", next);
    const other = LINKED[key];
    if (other && draft[other]) setDraft(other, "checked", next);
  };
  const setControl = (key: string, idx: number, nv: CtrlValue) => setDraft(key, "controls", idx, nv);

  /** Row visibility: `visibleWhen` select value + the intraday-only rule
   *  for the pre/post background row. */
  const visible = (tab: string, r: FormRow): boolean => {
    if (r.hidden) return false;
    if (tab === "symbol" && r.label === "Pre/post market hours background" && props.intraday === false) return false;
    // "Open market status" only while the symbol's market is open.
    if (tab === "legend" && r.label === "Open market status" && marketSession(props.symbol ?? "") !== "open") return false;
    if (r.symbolEvents && !hasSymbolEvents(props.symbol ?? "")) return false;
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

  const applyAll = () => { tradingPrefs.setRows(draft); props.onCommit(draft, "all"); props.onClose(); };
  const ok = () => { tradingPrefs.setRows(draft); props.onCommit(draft, "active"); props.onClose(); };
  const reset = () => setDraft(reconcile(makeDefaultDraft()));

  // Template menu — the saved chart templates (chart-templates.ts, shared
  // with the chart menu's "Chart template" submenu).
  const templates = chartTemplates;
  const [tplAnchor, setTplAnchor] = createSignal<Anchor | null>(null);
  let tplBtn: HTMLButtonElement | undefined;
  const saveTemplate = (name: string) => saveChartTemplate(name, draft);
  const applyTemplate = (t: SettingsTemplate) => {
    const revived = chartTemplateDraft(t);
    if (revived) setDraft(reconcile(revived));
  };
  const removeTemplate = (name: string) => removeChartTemplate(name);

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
    return (
      <Show when={visible(p.tab, p.r)}>
        <FormRowView
          r={p.r.parent && draft[keyOf(p.tab, p.r.parent)]?.checked === false ? { ...p.r, inert: true } : p.r}
          state={draft[key]}
          disabled={controlsDisabled(p.r, key)}
          onToggle={() => toggle(key)}
          onControl={(j, nv) => setControl(key, j, nv)}
          hideControl={(j) => p.tab === "canvas" && p.r.label === "Background" && j === 2 && draft[key]?.controls?.[0]?.kind === "select" && (draft[key].controls[0] as { value: string }).value !== "Gradient"}
        />
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
  const popover = createPopover(props.trigger, { onClose: props.onClose, placement: false });
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
      ref={popover}
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
