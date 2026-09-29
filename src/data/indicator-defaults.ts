/*
 * Indicator defaults — indicator Settings "Defaults" menu → "Save as
 * default". The saved inputs + styles of an indicator are what a NEWLY added
 * instance of it starts with; studies already on a chart keep their own
 * settings.
 * "Reset settings" in the same menu restores the study factory defaults, not
 * these.
 *
 * Keyed by registry id, persisted in the app key-value store.
 */
import * as kv from "./kv";
import type { PaneIndicatorSettings } from "../window/shell/tabs";

const KEY = "tv:indicator-defaults";

function loadAll(): Record<string, PaneIndicatorSettings> {
  try {
    const raw = kv.getItem(KEY);
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, PaneIndicatorSettings>) : {};
  } catch {
    return {};
  }
}

/** The saved default of an indicator (deep copy), or undefined. */
export function loadIndicatorDefault(id: string): PaneIndicatorSettings | undefined {
  const d = loadAll()[id];
  return d ? (JSON.parse(JSON.stringify(d)) as PaneIndicatorSettings) : undefined;
}

export function saveIndicatorDefault(id: string, settings: PaneIndicatorSettings): void {
  const all = loadAll();
  all[id] = JSON.parse(JSON.stringify(settings)) as PaneIndicatorSettings;
  kv.setItem(KEY, JSON.stringify(all));
}
