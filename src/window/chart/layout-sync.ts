/*
 * Layout sync — the "SYNC IN LAYOUT" toggles in the header layout dropdown.
 * When a key is on, that aspect is mirrored across every pane of the tab's
 * multi-chart layout. Symbol / interval
 * sync happen in App (broadcast the change to all panes); crosshair / time /
 * date-range sync happen in ChartView via a window-event bus.
 *
 * The toggles belong to each tab (saved per layout, in the layout
 * content: symbolLock / intervalLock / crosshairLock / trackTimeLock /
 * dateRangeLock). A new tab starts
 * with everything off except Crosshair, which takes the global crosshair
 * setting (`chart.syncCrosshair`, default on, written on every Crosshair
 * toggle).
 *
 * App owns the tabs, so it registers the active tab's state and toggle here;
 * the header menu and the panes read `layoutSync()` without prop-threading.
 * Only the shown tab's panes react to sync events, so the active tab's state
 * is the one that applies.
 */
import { createSignal } from "solid-js";
import * as kv from "../../data/kv";

export type LayoutSyncKey = "symbol" | "interval" | "crosshair" | "time" | "dateRange";

export type LayoutSyncState = Record<LayoutSyncKey, boolean>;

/** Display order + labels + info-icon tooltips of the toggles. */
export const LAYOUT_SYNC_ITEMS: { key: LayoutSyncKey; label: string; tip: string }[] = [
  { key: "symbol", label: "Symbol", tip: "Symbol changes on all charts within the layout" },
  { key: "interval", label: "Interval", tip: "Interval changes on all charts within the layout" },
  { key: "crosshair", label: "Crosshair", tip: "Crosshair is synced across all charts within the layout" },
  { key: "time", label: "Time", tip: "When a chart is clicked, all charts within the layout display the same point of time" },
  { key: "dateRange", label: "Date range", tip: "Date range changes on all charts within the layout" },
];

/** Global crosshair default for new layouts (chart.syncCrosshair). */
const CROSSHAIR_KEY = "ot:sync-crosshair";
/** The one global state used before the toggles moved into the tabs. */
const LEGACY_KEY = "ot:layout-sync";

function readLegacy(): Partial<LayoutSyncState> | null {
  try {
    const raw = kv.getItem(LEGACY_KEY);
    if (raw) return JSON.parse(raw) as Partial<LayoutSyncState>;
  } catch {
    /* malformed: ignore */
  }
  return null;
}

function globalCrosshair(): boolean {
  const raw = kv.getItem(CROSSHAIR_KEY);
  if (raw === "1") return true;
  if (raw === "0") return false;
  return readLegacy()?.crosshair ?? true;
}

/** Toggles of a new tab / layout. */
export function defaultLayoutSync(): LayoutSyncState {
  return { symbol: false, interval: false, crosshair: globalCrosshair(), time: false, dateRange: false };
}

/** Normalise stored toggles. Tabs saved before the toggles moved into the tab
 *  take the old global state once, so the user's choice is kept. */
export function reviveLayoutSync(raw: unknown): LayoutSyncState {
  const base = defaultLayoutSync();
  const src = raw && typeof raw === "object" ? (raw as Partial<LayoutSyncState>) : readLegacy();
  if (!src) return base;
  const out = { ...base };
  for (const { key } of LAYOUT_SYNC_ITEMS) if (typeof src[key] === "boolean") out[key] = src[key]!;
  return out;
}

/** Every Crosshair toggle also sets the global default (chart.syncCrosshair
 *  is written on each change). */
export function rememberCrosshair(on: boolean): void {
  kv.setItem(CROSSHAIR_KEY, on ? "1" : "0");
}

// The active tab's toggles and its toggle action, registered by App.
const [source, setSource] = createSignal<{
  state: () => LayoutSyncState;
  toggle: (key: LayoutSyncKey) => void;
} | null>(null);

export function bindLayoutSync(state: () => LayoutSyncState, toggle: (key: LayoutSyncKey) => void): void {
  setSource({ state, toggle });
}

/** The active tab's toggles (defaults before App registers). Reactive. */
export function layoutSync(): LayoutSyncState {
  return source()?.state() ?? defaultLayoutSync();
}

export function toggleLayoutSync(key: LayoutSyncKey): void {
  source()?.toggle(key);
}
