/*
 * Chart display timezone (bottom-bar TimezoneMenu, Settings → Symbol →
 * Timezone, time-axis menu), persisted. Default to the "Exchange" zone: each
 * chart shows its symbol's exchange zone (see displayTimeZone); the stored
 * IANA name is the fallback until the symbol's session resolves. One value
 * for the whole app, followed live across windows.
 */
import { createEffect, createRoot, createSignal } from "solid-js";
import * as kv from "./kv";

export type ChartTimezone = { label: string; iana: string };

const TZ_KEY = "ot:timezone";

const loadTz = (): ChartTimezone => {
  try {
    const raw = kv.getItem(TZ_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { label: "Exchange", iana: "America/New_York" };
};

const [timezone, setTimezone] = createSignal(loadTz());
export { timezone, setTimezone };

createRoot(() => {
  createEffect(() => {
    kv.setItem(TZ_KEY, JSON.stringify(timezone()));
  });
});
// Live cross-window sync (the persist effect above re-writes the same value,
// which kv.setItem dedups to a no-op).
kv.onExternalChange(TZ_KEY, () => setTimezone(loadTz()));
