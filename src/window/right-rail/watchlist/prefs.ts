/*
 * Watchlist view prefs saved on this machine: the settings menu's choices
 * (view, columns, logo, symbol display) and the column widths.
 */
import { WL_SETTINGS_DEFAULTS, type WlSettings } from "../../../data/watchlist";
import * as kv from "../../../data/kv";

export const SETTINGS_KEY = "ot:watchlist:settings";

// Resizable column widths (px), persisted. The Symbol column flexes to fill the
// slack but has a resizable minimum (keyed SYMBOL_COL_KEY); data columns are
// fixed px. All draggable from the column dividers.
export const COL_WIDTHS_KEY = "ot:watchlist:col-widths";
export const SYMBOL_COL_KEY = "__symbol";
export const DEFAULT_COL_W = 64;
export const DEFAULT_SYMBOL_W = 110;
export const MIN_COL_W = 40;
export const MAX_COL_W = 280;
export function loadColWidths(): Record<string, number> {
  try {
    const raw = kv.getItem(COL_WIDTHS_KEY);
    if (raw) return JSON.parse(raw) as Record<string, number>;
  } catch {
    /* malformed / unavailable — fall back to defaults */
  }
  return {};
}

export function loadSettings(): WlSettings {
  try {
    const raw = kv.getItem(SETTINGS_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<WlSettings>;
      return {
        ...WL_SETTINGS_DEFAULTS,
        ...s,
        columns: { ...WL_SETTINGS_DEFAULTS.columns, ...(s.columns ?? {}) },
      };
    }
  } catch {
    /* malformed / unavailable — fall back to defaults */
  }
  return { ...WL_SETTINGS_DEFAULTS, columns: { ...WL_SETTINGS_DEFAULTS.columns } };
}
