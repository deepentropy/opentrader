/*
 * Data-window store — a narrow global bridge that publishes the focused chart
 * pane's bar values (under the crosshair, or the latest bar when none) so the
 * right-rail "Data window" view can render them.
 *
 * ChartView owns the crosshair subscription and writes a snapshot here whenever
 * it re-resolves its legend; the owning pane is the hovered one (crosshair) or,
 * with no crosshair anywhere, the focused pane. The panel just reads `dataWindow`.
 */
import { createSignal } from "solid-js";

export type DataWindowPlot = { color: string; value: number };
export type DataWindowIndicator = { id: string; title: string; plots: DataWindowPlot[] };

export type DataWindowState = {
  /** Bare ticker ("INTC") + exchange ("NASDAQ"), shown in the section header. */
  ticker: string;
  exchange: string;
  interval: string;
  /** Chart-type icon name (candles/bars/line/…) shown in the section header. */
  chartTypeIcon: string;
  /** Resolved bar time (epoch seconds) and whether to show a time-of-day row. */
  time: number;
  intraday: boolean;
  /** IANA timezone for the date/time rows (matches the chart's time axis). */
  timeZone?: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** close − previous bar's close, and the same as a percentage. */
  changeAbs: number;
  changePct: number;
  /** Bar direction (close ≥ open) — colours the O/H/L/C numbers. */
  dir: "up" | "down";
  volume: number | null;
  indicators: DataWindowIndicator[];
};

const [dataWindow, setDataWindow] = createSignal<DataWindowState | null>(null);
export { dataWindow };

/** Publish (or clear with `null`) the focused pane's data-window snapshot. */
export function publishDataWindow(s: DataWindowState | null): void {
  setDataWindow(s);
}

// ── UI request (Alt+D) ────────────────────────────────────────────────────────
// TV "Show a data window widget" opens the Object tree page with its Data
// window view selected. The panel only mounts while that rail tab is open, so
// App sets a consume-once flag and the panel's effect reads it on mount.
const [dataWindowPending, setDataWindowPending] = createSignal(false);
/** Ask the (mounted-or-about-to-mount) object tree panel to show Data window. */
export const requestDataWindow = (): void => {
  setDataWindowPending(true);
};
/** Reactively true exactly once per request; clears the flag as it reads it. */
export const consumeDataWindowRequest = (): boolean => {
  if (!dataWindowPending()) return false;
  setDataWindowPending(false);
  return true;
};
