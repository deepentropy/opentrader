/*
 * IndicatorLegend: the studies legend drawn under the main-series legend
 * row, one row per active indicator. Ported to SolidJS from the reference
 * mock.
 *
 * Each row (h:24) is:
 *   <title>   <v1> <v2> …        [eye settings delete more]
 * Action buttons revealed on hover. Eye, settings (gear), delete and more
 * (the study menu, opened by ChartView) are wired.
 *
 * A click on the title selects the study (a compared symbol's title also
 * changes the symbol), a double click opens its settings. The selected row
 * keeps its buttons shown, framed in blue (reference legend `selected`).
 *
 * A study that failed shows a status pill after its title (cross for a symbol
 * that cannot be loaded, "!" for another error) and no values; the pill's
 * tooltip is the error title, a click opens a panel with the message under it.
 * A study whose source is open in the OakScript editor shows the green
 * "Opened in OakScript Editor" pill; its panel's "Go there now" shows the
 * editor (reference legend status for a script open in its editor).
 */
import { Icon } from "../../components/Icon";
import { For, Show, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import type { IndicatorLegendRow } from "./indicators/indicator-controller";
import type { StudyError } from "./indicators/indicator-layer";
import { formatStudyValue } from "../../data/study-format";

type Props = {
  rows: IndicatorLegendRow[];
  /** The symbol's price format, for the studies without a format of their own. */
  formatPrice?: (v: number) => string;
  /** Toggle a study's plot visibility (eye). */
  onToggleHide: (id: string) => void;
  /** Open the study's settings dialog (gear). */
  onSettings: (id: string) => void;
  /** Remove a study from the chart (trash). */
  onRemove: (id: string) => void;
  /** More button: the study menu under the button (gets the button rect). */
  onMore?: (id: string, anchor: DOMRect) => void;
  /** Source code button: shown for a study with a script source (it returns
   *  true); opens it in the editor. */
  hasSource?: (id: string) => boolean;
  onSource?: (id: string) => void;
  /** The study's source is open in the OakScript editor: "Opened in OakScript Editor" status pill, whose panel's
   *  "Go there now" calls onSource. */
  openedInEditor?: (id: string) => boolean;
  /** Show interval settings button (study hidden on the chart's interval):
   *  the settings on the Visibility tab. */
  onIntervalSettings?: (id: string) => void;
  /** Title clicked (compared symbol rows: "Change symbol"). */
  onTitleClick?: (id: string) => void;
  /** The chart's indicators legend is collapsed: rows hidden, the toggler
   *  shows their count. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /** The price pane's legend: its toggler shows with a single study too. */
  mainPane?: boolean;
  /** Selected study (null = none) and the title click that selects one. */
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  // Status line → Indicators (Settings). Undefined = shown / no background.
  showTitles?: boolean;
  showInputs?: boolean;
  showValues?: boolean;
  /** Chart background colour, for the legend's readability fill. */
  bgColor?: string;
  /** Legend background fill opacity, 0..100 (0 / undefined = none). */
  bgOpacity?: number;
};

/** Split a study title into its name and trailing "(inputs)" portion. */
export function splitTitle(title: string): { name: string; inputs: string } {
  const m = /^(.*?)\s*(\([^)]*\))\s*$/.exec(title);
  return m ? { name: m[1], inputs: m[2] } : { name: title, inputs: "" };
}

/** Parse an "rgb()/#hex" colour + 0..100 opacity into an rgba() fill. */
function rgbaFill(color: string | undefined, opacity: number | undefined): string | undefined {
  if (!color || !opacity) return undefined;
  const a = Math.max(0, Math.min(1, opacity / 100));
  const m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(color.trim());
  if (m) return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${a})`;
  const h = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (h) {
    const n = parseInt(h[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  return undefined;
}

// Action-button icons of the study legend, 18-viewBox. Factories: a JSX
// constant is ONE DOM node, which every row would take from the previous one.
const ICON_EYE = () => (
  <svg viewBox="0 0 18 18" width="18" height="18">
    <path fill="currentColor" fill-rule="evenodd" d="M12 9a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm-1 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z" />
    <path fill="currentColor" d="M16.91 8.8C15.31 4.99 12.18 3 9 3 5.82 3 2.7 4.98 1.08 8.8L1 9l.08.2C2.7 13.02 5.82 15 9 15c3.18 0 6.3-1.97 7.91-5.8L17 9l-.09-.2ZM9 14c-2.69 0-5.42-1.63-6.91-5 1.49-3.37 4.22-5 6.9-5 2.7 0 5.43 1.63 6.92 5-1.5 3.37-4.23 5-6.91 5Z" />
  </svg>
);
const ICON_EYE_CROSSED = () => (
  <svg viewBox="0 0 18 18" width="18" height="18">
    <path fill="currentColor" d="M3.7 15 15 3.7l-.7-.7L3 14.3l.7.7ZM9 3c1.09 0 2.17.23 3.19.7l-.77.76C10.64 4.16 9.82 4 9 4 6.31 4 3.58 5.63 2.08 9a9.35 9.35 0 0 0 1.93 2.87l-.7.7A10.44 10.44 0 0 1 1.08 9.2L1 9l.08-.2C2.69 4.99 5.82 3 9 3Z" />
    <path fill="currentColor" d="M9 6a3 3 0 0 1 .78.1l-.9.9A2 2 0 0 0 7 8.87l-.9.9A3 3 0 0 1 9 6ZM11.9 8.22l-.9.9A2 2 0 0 1 9.13 11l-.9.9a3 3 0 0 0 3.67-3.68Z" />
    <path fill="currentColor" d="M9 14c-.82 0-1.64-.15-2.43-.45l-.76.76c1.02.46 2.1.7 3.19.7 3.18 0 6.31-1.98 7.92-5.81L17 9l-.08-.2a10.44 10.44 0 0 0-2.23-3.37l-.7.7c.75.76 1.41 1.71 1.93 2.87-1.5 3.37-4.23 5-6.92 5Z" />
  </svg>
);
// Loading eye: the outline of the eye with a turning arc in place of the pupil.
const ICON_EYE_LOADING = () => (
  <svg viewBox="0 0 18 18" width="18" height="18">
    <path fill="none" stroke="currentColor" d="M1.6 9C3.4 5.4 6 3.5 9 3.5s5.6 1.9 7.4 5.5c-1.8 3.6-4.4 5.5-7.4 5.5S3.4 12.6 1.6 9Z" />
    <path class="ot-eye-loading-arc" fill="none" stroke="currentColor" d="M11.5 9A2.5 2.5 0 1 0 9 11.5" />
  </svg>
);
const ICON_SETTINGS = () => (
  <svg viewBox="0 0 18 18" width="18" height="18">
    <path fill="currentColor" fill-rule="evenodd" d="m3.1 9 2.28-5h7.24l2.28 5-2.28 5H5.38L3.1 9Zm1.63-6h8.54L16 9l-2.73 6H4.73L2 9l2.73-6Zm5.77 6a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm1 0a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z" />
  </svg>
);
const ICON_DELETE = () => (
  <svg viewBox="0 0 18 18" width="18" height="18">
    <path fill="currentColor" d="M7.5 4a.5.5 0 0 0-.5.5V5h4v-.5a.5.5 0 0 0-.5-.5h-3ZM12 5h3v1h-1.05l-.85 7.67A1.5 1.5 0 0 1 11.6 15H6.4a1.5 1.5 0 0 1-1.5-1.33L4.05 6H3V5h3v-.5C6 3.67 6.67 3 7.5 3h3c.83 0 1.5.67 1.5 1.5V5ZM5.06 6l.84 7.56a.5.5 0 0 0 .5.44h5.2a.5.5 0 0 0 .5-.44L12.94 6H5.06Z" />
  </svg>
);
// Source code: braces glyph.
const ICON_SOURCE = () => (
  <svg viewBox="0 0 18 18" width="18" height="18">
    <path fill="currentColor" d="M7 14H5.5A1.5 1.5 0 0 1 4 12.5v-1A2.9 2.9 0 0 0 2.66 9l.18-.13A2.9 2.9 0 0 0 4 6.5V5.5C4 4.67 4.67 4 5.5 4H7V3H5.5A2.5 2.5 0 0 0 3 5.5V6.5a1.9 1.9 0 0 1-.77 1.58c-.42.32-.84.43-.85.44C1.3 8.54 1 8.65 1 9s.3.46.38.48c0 0 .43.12.85.44.4.3.77.8.77 1.58v1A2.5 2.5 0 0 0 5.5 15H7v-1Zm4-10h1.5c.83 0 1.5.67 1.5 1.5v1A2.9 2.9 0 0 0 15.34 9l-.18.13A2.9 2.9 0 0 0 14 11.5V12.5c0 .83-.67 1.5-1.5 1.5H11v1h1.5a2.5 2.5 0 0 0 2.5-2.5V11.5c0-.79.38-1.27.77-1.58.42-.32.84-.43.85-.44.08-.02.38-.13.38-.48s-.3-.46-.38-.48c0 0-.43-.12-.85-.44-.4-.3-.77-.8-.77-1.58v-1A2.5 2.5 0 0 0 12.5 3H11v1Z" />
  </svg>
);
const ICON_MORE = () => (
  <svg viewBox="0 0 18 18" width="18" height="18">
    <path fill="currentColor" fill-rule="evenodd" d="M3 10a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm0 1a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm6-1a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm0 1a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm7-2a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm1 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z" />
  </svg>
);

// Study error glyphs (18-viewBox): a cross for a symbol that cannot be loaded, an exclamation mark otherwise.
const ICON_ERROR_CROSS = () => (
  <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
    <path fill="none" stroke="currentColor" stroke-width="1.5" d="M5 5l8 8M13 5l-8 8" />
  </svg>
);
const ICON_ERROR_MARK = () => (
  <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
    <path fill="currentColor" d="M8.1 4.5h1.8l-.35 6.2h-1.1z" />
    <circle fill="currentColor" cx="9" cy="12.9" r="1" />
  </svg>
);
/** A legend value that is not available (reference: drawn in the legend text colour). */
const NA = "\u2205";

const errorIcon = (e: StudyError) => (e.kind === "invalidSymbol" ? ICON_ERROR_CROSS() : ICON_ERROR_MARK());

/** Status of a study whose source is open in the editor (reference wording, our editor's name). */
const OPENED_TITLE = "Opened in OakScript Editor";
const OPENED_TEXT = "The source code is currently open in OakScript Editor.";

/** Status panel under a study's status pill (reference: left = pill - 15 px so the icons line up, top = pill + 7 px;
 *  344 px wide at most): icon, title, text and an optional action button. Closes on a click outside it or Escape. */
function StudyStatusPanel(props: {
  anchor: DOMRect;
  onClose: () => void;
  kind: string;
  icon: JSX.Element;
  title: string;
  text: string;
  action?: { label: string; onClick: () => void };
}) {
  let el: HTMLDivElement | undefined;
  const left = () => Math.max(4, Math.min(props.anchor.left - 15, window.innerWidth - 348));
  onMount(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Element;
      if (el?.contains(t) || t.closest?.("[data-qa-id=legend-source-item-status]")) return;
      props.onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    document.addEventListener("mousedown", down, true);
    document.addEventListener("keydown", key, true);
    onCleanup(() => {
      document.removeEventListener("mousedown", down, true);
      document.removeEventListener("keydown", key, true);
    });
  });
  return (
    <Portal>
      <div ref={el} class="ot-study-error-panel" data-qa-id="chart-statuses-popup" style={{ left: `${left()}px`, top: `${props.anchor.bottom + 7}px` }}>
        <div class="ot-study-error-panel-body" data-qa-id={props.kind === "opened" ? "opened-in-editor-status" : "data-source-error-status"}>
          <span class={`ot-study-error-icon is-${props.kind}`}>{props.icon}</span>
          <div class="ot-study-error-desc">
            <span class={`ot-study-error-title is-${props.kind}`}>{props.title}</span>
            <p class="ot-study-error-text">{props.text}</p>
            <Show when={props.action}>
              {(a) => (
                <div class="ot-study-status-actions">
                  <button type="button" class="ot-study-status-action" onClick={() => { a().onClick(); props.onClose(); }}>{a().label}</button>
                </div>
              )}
            </Show>
          </div>
        </div>
      </div>
    </Portal>
  );
}

/** A study value in the legend: the Precision setting, else the study's own format, else the symbol's price format
 *  (reference); without that, the compact form. */
function valueText(row: IndicatorLegendRow, v: number, formatPrice?: (v: number) => string): string {
  if (row.precision !== null) return v.toFixed(row.precision);
  if (row.format) return formatStudyValue(v, row.format);
  return formatPrice ? formatPrice(v) : fmtVal(v);
}

/** Compact study legend value format ("773.19 M", "82.50"); a value that is not available is "∅". */
function fmtVal(v: number): string {
  if (!Number.isFinite(v)) return NA;
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)} B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)} M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(2)} K`;
  return v.toFixed(2);
}

function ActionButton(props: { qa: string; title: string; onClick?: (e: MouseEvent) => void; children: JSX.Element }) {
  return (
    <button
      type="button"
      class="ot-ind-legend-action"
      data-qa-id={props.qa}
      title={props.title}
      aria-label={props.title}
      tabIndex={-1}
      onClick={(e) => props.onClick?.(e)}
    >
      {props.children}
    </button>
  );
}

export function IndicatorLegend(props: Props) {
  // Status panel of a study (its id, which pill and the pill's rect); closed when the status goes.
  const [panel, setPanel] = createSignal<{ id: string; kind: "error" | "opened"; anchor: DOMRect } | null>(null);
  const panelError = () => {
    const p = panel();
    return p?.kind === "error" ? (props.rows.find((r) => r.id === p.id)?.error ?? null) : null;
  };
  const panelOpened = () => {
    const p = panel();
    return p?.kind === "opened" && props.rows.some((r) => r.id === p.id) && props.openedInEditor?.(p.id) ? p.id : null;
  };
  const togglePanel = (id: string, kind: "error" | "opened", e: MouseEvent) => {
    const anchor = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPanel((p) => (p?.id === id && p.kind === kind ? null : { id, kind, anchor }));
  };
  return (<>
    <Show when={props.rows.length > 0}>
      <div class="ot-ind-legend" classList={{ "is-collapsed": !!props.collapsed }} data-name="legend-sources">
        <For each={props.collapsed ? [] : props.rows}>
          {(row) => (
            <div
              class={`ot-ind-legend-row${row.hidden ? " is-hidden" : ""}${row.eyeHidden ? " is-eye-hidden" : ""}${row.offInterval ? " is-off-interval" : ""}${props.selectedId === row.id ? " is-selected" : ""}${row.loading ? " is-loading" : ""}`}
              data-status={row.loading ? "loading" : undefined}
              data-qa-id="legend-source-item"
              data-entity-id={row.id}
              role="toolbar"
              style={{ "background-color": rgbaFill(props.bgColor, props.bgOpacity) }}
            >
              <Show when={row.compare}>
                <span
                  class="ot-ind-legend-title is-clickable"
                  data-qa-id="legend-source-title"
                  title="Change symbol"
                  onClick={() => { props.onSelect?.(row.id); props.onTitleClick?.(row.id); }}
                >
                  {row.title}
                </span>
              </Show>
              <Show when={!row.compare && (props.showTitles ?? true)}>
                <span
                  class="ot-ind-legend-title"
                  data-qa-id="legend-source-title"
                  onClick={() => props.onSelect?.(row.id)}
                  onDblClick={() => props.onSettings(row.id)}
                >
                  {splitTitle(row.title).name}
                  {/* Status line: title, then the input values separated by
                      spaces (Status line -> Inputs AND the study's "Inputs in
                      status line"). */}
                  <Show when={(props.showInputs ?? true) && row.showInputs && (splitTitle(row.title).inputs || row.inputs)}>
                    {" "}{splitTitle(row.title).inputs || row.inputs}
                  </Show>
                </span>
              </Show>
              {/* A study that failed: its status pill, tooltip = the error title, click = the error panel. */}
              <Show when={!row.compare && row.error}>
                {(err) => (
                  <span class="ot-ind-legend-status" data-qa-id="legend-statuses-wrapper">
                    <button
                      type="button"
                      class={`ot-ind-legend-error-pill is-${err().kind}`}
                      data-role="statuses-pill"
                      data-qa-id="legend-source-item-status"
                      title={err().title}
                      onClick={(e) => togglePanel(row.id, "error", e)}
                    >
                      {errorIcon(err())}
                    </button>
                  </span>
                )}
              </Show>
              {/* The study's source is the script open in the OakScript editor (reference: green braces pill). */}
              <Show when={!row.compare && props.openedInEditor?.(row.id)}>
                <span class="ot-ind-legend-status" data-qa-id="legend-statuses-wrapper">
                  <button
                    type="button"
                    class="ot-ind-legend-opened-pill"
                    data-role="statuses-pill"
                    data-qa-id="legend-source-item-status"
                    title={OPENED_TITLE}
                    aria-label={OPENED_TITLE}
                    onClick={(e) => togglePanel(row.id, "opened", e)}
                  >
                    {ICON_SOURCE()}
                  </button>
                </span>
              </Show>
              {/* Strategies: the reference app's "Active strategy" status pill (18 px, #82b1ff). */}
              <Show when={row.id.startsWith("strategy:")}>
                <span class="ot-ind-legend-status" data-qa-id="legend-statuses-wrapper">
                  <span class="ot-ind-legend-status-pill" title="Active strategy" aria-label="Active strategy" data-role="statuses-pill">
                    <Icon name="st-legend-active-strategy-status" size={18} />
                  </span>
                </span>
              </Show>
              {/* Values + the hover toolbar share a relative box so the toolbar
                  can float over the values (the rounded action pill OVERLAYS
                  the metrics, anchored right after the title — it doesn't push
                  them right). */}
              <div class="ot-ind-legend-rest">
                <Show when={!row.hidden && row.compare}>
                  {(c) => (
                    <span class="ot-ind-legend-values">
                      <For each={c().texts}>
                        {(t) => <span class="ot-ind-legend-val" style={{ color: t.color }}>{t.text}</span>}
                      </For>
                    </span>
                  )}
                </Show>
                <Show when={!row.compare && !row.hidden && !row.error && (props.showValues ?? true) && row.showValues}>
                  <span class="ot-ind-legend-values">
                    <For each={row.plots}>
                      {(p) => (
                        <span class="ot-ind-legend-val" style={{ color: Number.isFinite(p.value) ? p.color : undefined }}>
                          {!Number.isFinite(p.value) ? NA : valueText(row, p.value, props.formatPrice)}
                        </span>
                      )}
                    </For>
                  </span>
                </Show>
                {/* Rounded pill filled with the chart background so it cleanly
                    covers the metric values underneath (theme-aware). */}
                <span class="ot-ind-legend-actions" data-name="actions" style={{ "background-color": props.bgColor }}>
                  <ActionButton qa="legend-show-hide-action" title={row.eyeHidden ? "Show" : "Hide"} onClick={() => props.onToggleHide(row.id)}>
                    {row.loading ? ICON_EYE_LOADING() : row.eyeHidden ? ICON_EYE_CROSSED() : ICON_EYE()}
                  </ActionButton>
                  {/* Study hidden on the chart's interval: orange crossed eye. */}
                  <Show when={!row.compare && row.offInterval}>
                    <ActionButton qa="legend-interval-show-hide-action" title="Show interval settings" onClick={() => props.onIntervalSettings?.(row.id)}>{ICON_EYE_CROSSED()}</ActionButton>
                  </Show>
                  <ActionButton qa="legend-settings-action" title="Settings" onClick={() => props.onSettings(row.id)}>{ICON_SETTINGS()}</ActionButton>
                  <Show when={!row.compare && props.hasSource?.(row.id)}>
                    <ActionButton qa="legend-pine-action" title="Source code" onClick={() => props.onSource?.(row.id)}>{ICON_SOURCE()}</ActionButton>
                  </Show>
                  <ActionButton qa="legend-delete-action" title="Remove" onClick={() => props.onRemove(row.id)}>{ICON_DELETE()}</ActionButton>
                  <ActionButton qa="legend-more-action" title="More"
                    onClick={(e) => props.onMore?.(row.id, (e.currentTarget as HTMLElement).getBoundingClientRect())}>
                    {ICON_MORE()}
                  </ActionButton>
                </span>
              </div>
            </div>
          )}
        </For>
        <Show when={props.onToggleCollapsed && (props.rows.length > 1 || props.mainPane)}>
          <LegendToggler count={props.rows.length} collapsed={!!props.collapsed} bgColor={props.bgColor} onToggle={() => props.onToggleCollapsed?.()} />
        </Show>
      </div>
    </Show>
    <Show when={panel() && panelError()}>
      {(err) => (
        <StudyStatusPanel kind={err().kind} icon={errorIcon(err())} title={err().title} text={err().message}
          anchor={panel()!.anchor} onClose={() => setPanel(null)} />
      )}
    </Show>
    <Show when={panel() && panelOpened()}>
      {(id) => (
        <StudyStatusPanel kind="opened" icon={ICON_SOURCE()} title={OPENED_TITLE} text={OPENED_TEXT}
          action={{ label: "Go there now", onClick: () => props.onSource?.(id()) }}
          anchor={panel()!.anchor} onClose={() => setPanel(null)} />
      )}
    </Show>
  </>);
}

/** Indicators legend toggler (reference app): under the studies, a button on
 *  the chart background at 80 % with the arrow (up while open) and, collapsed,
 *  the number of studies (from two). Shown on the price pane from one study,
 *  on the other panes from two. */
function LegendToggler(p: { count: number; collapsed: boolean; bgColor?: string; onToggle: () => void }) {
  const title = () => `${p.collapsed ? "Show" : "Hide"} ${p.count === 1 ? "indicator" : "indicators"} legend`;
  return (
    <div class="ot-ind-legend-toggler-wrap" data-qa-id="legend-toggler-wrapper">
      <button
        type="button"
        class="ot-ind-legend-toggler"
        classList={{ "is-closed": p.collapsed, "is-single": p.count <= 1 }}
        style={{ "background-color": withAlpha(p.bgColor, 0.8) }}
        title={title()}
        aria-label={title()}
        data-qa-id="legend-toggler"
        onClick={(e) => {
          e.stopPropagation();
          p.onToggle();
        }}
      >
        <span class="ot-ind-legend-toggler-arrow">
          <svg viewBox="0 0 15 15" width="15" height="15" aria-hidden="true">
            <path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" d="m4 6 3.5 3 3.5-3" />
          </svg>
        </span>
        <Show when={p.collapsed && p.count > 1}>
          <span class="ot-ind-legend-toggler-count" data-qa-id="legend-collapsed-sources-counter">{p.count}</span>
        </Show>
      </button>
    </div>
  );
}

/** `#rrggbb` (or rgb()) at `alpha`; undefined when not parseable. */
function withAlpha(color: string | undefined, alpha: number): string | undefined {
  if (!color) return undefined;
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    const n = parseInt(hex[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(color.trim());
  if (rgb) {
    const [r, g, b] = rgb[1].split(",").map((x) => x.trim());
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return undefined;
}
