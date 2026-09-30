/*
 * IndicatorLegend: the studies legend drawn under the main-series legend
 * row, one row per active indicator. Ported to SolidJS from the reference
 * mock.
 *
 * Each row (h:24) is:
 *   <title>   <v1> <v2> …        [eye settings delete more]
 * Action buttons revealed on hover. Eye, settings (gear), delete and more
 * (the study menu, opened by ChartView) are wired.
 */
import { Icon } from "../../components/Icon";
import { For, Show, type JSX } from "solid-js";
import type { IndicatorLegendRow } from "./indicators/indicator-controller";

type Props = {
  rows: IndicatorLegendRow[];
  /** Toggle a study's plot visibility (eye). */
  onToggleHide: (id: string) => void;
  /** Open the study's settings dialog (gear). */
  onSettings: (id: string) => void;
  /** Remove a study from the chart (trash). */
  onRemove: (id: string) => void;
  /** More button: the study menu under the button (gets the button rect). */
  onMore?: (id: string, anchor: DOMRect) => void;
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
function splitTitle(title: string): { name: string; inputs: string } {
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

// Action-button icons of the study legend, 18-viewBox.
const ICON_EYE = (
  <svg viewBox="0 0 18 18" width="18" height="18">
    <path fill="currentColor" fill-rule="evenodd" d="M12 9a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm-1 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z" />
    <path fill="currentColor" d="M16.91 8.8C15.31 4.99 12.18 3 9 3 5.82 3 2.7 4.98 1.08 8.8L1 9l.08.2C2.7 13.02 5.82 15 9 15c3.18 0 6.3-1.97 7.91-5.8L17 9l-.09-.2ZM9 14c-2.69 0-5.42-1.63-6.91-5 1.49-3.37 4.22-5 6.9-5 2.7 0 5.43 1.63 6.92 5-1.5 3.37-4.23 5-6.91 5Z" />
  </svg>
);
const ICON_EYE_CROSSED = (
  <svg viewBox="0 0 18 18" width="18" height="18">
    <path fill="currentColor" d="M3.7 15 15 3.7l-.7-.7L3 14.3l.7.7ZM9 3c1.09 0 2.17.23 3.19.7l-.77.76C10.64 4.16 9.82 4 9 4 6.31 4 3.58 5.63 2.08 9a9.35 9.35 0 0 0 1.93 2.87l-.7.7A10.44 10.44 0 0 1 1.08 9.2L1 9l.08-.2C2.69 4.99 5.82 3 9 3Z" />
    <path fill="currentColor" d="M9 6a3 3 0 0 1 .78.1l-.9.9A2 2 0 0 0 7 8.87l-.9.9A3 3 0 0 1 9 6ZM11.9 8.22l-.9.9A2 2 0 0 1 9.13 11l-.9.9a3 3 0 0 0 3.67-3.68Z" />
    <path fill="currentColor" d="M9 14c-.82 0-1.64-.15-2.43-.45l-.76.76c1.02.46 2.1.7 3.19.7 3.18 0 6.31-1.98 7.92-5.81L17 9l-.08-.2a10.44 10.44 0 0 0-2.23-3.37l-.7.7c.75.76 1.41 1.71 1.93 2.87-1.5 3.37-4.23 5-6.92 5Z" />
  </svg>
);
const ICON_SETTINGS = (
  <svg viewBox="0 0 18 18" width="18" height="18">
    <path fill="currentColor" fill-rule="evenodd" d="m3.1 9 2.28-5h7.24l2.28 5-2.28 5H5.38L3.1 9Zm1.63-6h8.54L16 9l-2.73 6H4.73L2 9l2.73-6Zm5.77 6a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm1 0a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z" />
  </svg>
);
const ICON_DELETE = (
  <svg viewBox="0 0 18 18" width="18" height="18">
    <path fill="currentColor" d="M7.5 4a.5.5 0 0 0-.5.5V5h4v-.5a.5.5 0 0 0-.5-.5h-3ZM12 5h3v1h-1.05l-.85 7.67A1.5 1.5 0 0 1 11.6 15H6.4a1.5 1.5 0 0 1-1.5-1.33L4.05 6H3V5h3v-.5C6 3.67 6.67 3 7.5 3h3c.83 0 1.5.67 1.5 1.5V5ZM5.06 6l.84 7.56a.5.5 0 0 0 .5.44h5.2a.5.5 0 0 0 .5-.44L12.94 6H5.06Z" />
  </svg>
);
const ICON_MORE = (
  <svg viewBox="0 0 18 18" width="18" height="18">
    <path fill="currentColor" fill-rule="evenodd" d="M3 10a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm0 1a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm6-1a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm0 1a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm7-2a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm1 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z" />
  </svg>
);

/** Compact study legend value format ("773.19 M", "82.50"). */
function fmtVal(v: number): string {
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
  return (
    <Show when={props.rows.length > 0}>
      <div class="ot-ind-legend" data-name="legend-sources">
        <For each={props.rows}>
          {(row) => (
            <div
              class={`ot-ind-legend-row${row.hidden ? " is-hidden" : ""}`}
              data-qa-id="legend-source-item"
              data-entity-id={row.id}
              role="toolbar"
              style={{ "background-color": rgbaFill(props.bgColor, props.bgOpacity) }}
            >
              <Show when={props.showTitles ?? true}>
                <span class="ot-ind-legend-title" data-qa-id="legend-source-title">
                  {splitTitle(row.title).name}
                  {/* Status line: title, then the input values separated by
                      spaces (Status line -> Inputs AND the study's "Inputs in
                      status line"). */}
                  <Show when={(props.showInputs ?? true) && row.showInputs && (splitTitle(row.title).inputs || row.inputs)}>
                    {" "}{splitTitle(row.title).inputs || row.inputs}
                  </Show>
                </span>
              </Show>
              {/* Strategies: TradingView's "Active strategy" status pill (18 px, #82b1ff). */}
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
                <Show when={!row.hidden && (props.showValues ?? true) && row.showValues}>
                  <span class="ot-ind-legend-values">
                    <For each={row.plots}>
                      {(p) => <span class="ot-ind-legend-val" style={{ color: p.color }}>{row.precision !== null ? p.value.toFixed(row.precision) : fmtVal(p.value)}</span>}
                    </For>
                  </span>
                </Show>
                {/* Rounded pill filled with the chart background so it cleanly
                    covers the metric values underneath (theme-aware). */}
                <span class="ot-ind-legend-actions" data-name="actions" style={{ "background-color": props.bgColor }}>
                  <ActionButton qa="legend-show-hide-action" title={row.eyeHidden ? "Show" : "Hide"} onClick={() => props.onToggleHide(row.id)}>
                    {row.eyeHidden ? ICON_EYE_CROSSED : ICON_EYE}
                  </ActionButton>
                  <ActionButton qa="legend-settings-action" title="Settings" onClick={() => props.onSettings(row.id)}>{ICON_SETTINGS}</ActionButton>
                  <ActionButton qa="legend-delete-action" title="Remove" onClick={() => props.onRemove(row.id)}>{ICON_DELETE}</ActionButton>
                  <ActionButton qa="legend-more-action" title="More"
                    onClick={(e) => props.onMore?.(row.id, (e.currentTarget as HTMLElement).getBoundingClientRect())}>
                    {ICON_MORE}
                  </ActionButton>
                </span>
              </div>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
