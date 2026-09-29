/*
 * Favourite intervals — a global, persisted store (ported from the reference
 * mock's interval-favorites.ts, adapted to a SolidJS module-level signal).
 *
 * In TradingView the favourited-interval set drives BOTH the quick-access
 * buttons on the header strip and the filled stars in the chart-interval
 * dropdown. It's a single global preference shared across charts and persisted
 * to localStorage. Keyed by canonical TV interval id ("10S", "60", "1D") — the
 * same ids the chart-interval dropdown rows + ChartView's `interval` prop use.
 */
import { createSignal } from "solid-js";
import * as kv from "../../data/kv";

const STORAGE_KEY = "tv:favorite-intervals";

/** Live default-favourite ids — match the original static header strip. */
export const DEFAULT_FAVORITE_INTERVALS = ["10S", "1", "5", "15", "60", "240", "1D", "1W"];

/** Canonical ascending order (shortest → longest) for the header strip. */
const ORDER = [
  "1T", "10T", "100T", "1000T",
  "1S", "5S", "10S", "15S", "30S", "45S",
  "1", "2", "3", "4", "5", "10", "15", "30", "45",
  "60", "120", "180", "240",
  "1D", "1W", "1M",
];
const rank = (id: string) => {
  const i = ORDER.indexOf(id);
  return i < 0 ? ORDER.length : i;
};
function sortIntervals(ids: string[]): string[] {
  return [...new Set(ids)].sort((a, b) => rank(a) - rank(b));
}

function load(): string[] {
  try {
    const raw = kv.getItem(STORAGE_KEY);
    if (raw) return sortIntervals(JSON.parse(raw) as string[]);
  } catch {
    /* malformed / unavailable — fall back to defaults */
  }
  return [...DEFAULT_FAVORITE_INTERVALS];
}

const [favorites, setFavorites] = createSignal<string[]>(load());

// Live cross-window sync: re-seed from storage on another window's change.
kv.onExternalChange(STORAGE_KEY, () => setFavorites(load()));

/** Live, ordered list of favourited interval ids (global + persisted). */
export const favoriteIntervals = favorites;

/** Toggle an interval's favourited state; persists + notifies all readers. */
export function toggleFavoriteInterval(id: string): void {
  const cur = favorites();
  const next = cur.includes(id) ? cur.filter((x) => x !== id) : sortIntervals([...cur, id]);
  setFavorites(next);
  try {
    kv.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* best-effort */
  }
}

/** Short header-strip label for an interval id ("10S"→"10s", "60"→"1h", "1D"→"D"). */
export function shortIntervalLabel(id: string): string {
  if (/^\d+T$/.test(id)) return id; // tick counts
  if (/^\d+S$/i.test(id)) return id.toLowerCase(); // seconds → "10s"
  const dwm = /^(\d+)([DWM])$/i.exec(id);
  if (dwm) {
    const [, n, unit] = dwm;
    return n === "1" ? unit.toUpperCase() : `${n}${unit.toUpperCase()}`; // "1D"→"D", "3D"→"3D"
  }
  const n = Number(id);
  if (!Number.isNaN(n)) {
    if (n >= 60 && n % 60 === 0) return `${n / 60}h`; // 60→"1h", 240→"4h"
    return `${n}m`; // 1→"1m", 15→"15m"
  }
  return id;
}

/** Long interval name — TV's header-strip tooltip ("10S"→"10 seconds",
 *  "60"→"1 hour", "1D"→"1 day"); same wording as the interval menu rows. */
export function longIntervalLabel(id: string): string {
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  const m = /^(\d+)([TSRDWM])$/i.exec(id);
  if (m) {
    const n = Number(m[1]);
    const unit = { T: "tick", S: "second", R: "range", D: "day", W: "week", M: "month" }[m[2].toUpperCase()]!;
    return plural(n, unit);
  }
  const n = Number(id);
  if (!Number.isNaN(n)) return n >= 60 && n % 60 === 0 ? plural(n / 60, "hour") : plural(n, "minute");
  return id;
}
