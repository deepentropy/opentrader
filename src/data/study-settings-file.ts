/*
 * Settings file of an indicator or strategy (the settings dialog's Defaults menu "Export settings…" /
 * "Import settings…", beyond the reference app, whose Defaults menu has only Reset settings and Save as default).
 *
 * The file is JSON: the study's name, its inputs, plot styles and Style / Visibility options as the dialog commits
 * them, and for a strategy its properties in full (not as the difference from the script values, so a file still
 * applies after the script changes them). Importing fills the dialog; Ok applies it as any edit. An input the script
 * no longer has, or whose value has another type, is left out (`skipped`).
 */
import type { StrategyProperties } from "../backtester/types";

export const SETTINGS_FORMAT = "opentrader-study-settings";
export const SETTINGS_VERSION = 1;

export type SettingsFile = {
  format: typeof SETTINGS_FORMAT;
  version: number;
  /** The study's name when it was exported. */
  study: string;
  /** ISO date-time of the export. */
  exported: string;
  inputs: Record<string, unknown>;
  styles: Record<string, unknown>;
  options: unknown;
  /** Strategy properties in full (strategies only). */
  properties?: Partial<StrategyProperties>;
};

export function settingsFile(study: string, next: { inputs: Record<string, unknown>; styles: object; options: unknown }, properties?: StrategyProperties): SettingsFile {
  const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  return {
    format: SETTINGS_FORMAT,
    version: SETTINGS_VERSION,
    study,
    exported: new Date().toISOString(),
    inputs: copy(next.inputs),
    styles: copy(next.styles) as Record<string, unknown>,
    options: copy(next.options),
    ...(properties ? { properties: copy(properties) } : {}),
  };
}

/** "<study> settings.json", the characters a file name cannot hold replaced. */
export function settingsFileName(study: string): string {
  return `${study.replace(/[\\/:*?"<>|]/g, "_")} settings.json`;
}

/** Read a settings file; throws a message for the user when it is not one. */
export function parseSettingsFile(text: string): SettingsFile {
  let v: Partial<SettingsFile>;
  try {
    v = JSON.parse(text) as Partial<SettingsFile>;
  } catch {
    throw new Error("This file is not a settings file.");
  }
  if (!v || v.format !== SETTINGS_FORMAT || typeof v.inputs !== "object" || v.inputs === null) throw new Error("This file is not a settings file.");
  if ((v.version ?? 0) > SETTINGS_VERSION) throw new Error("This settings file comes from a newer version of OpenTrader.");
  return { styles: {}, options: undefined, study: "", exported: "", ...v } as SettingsFile;
}

/** The file's inputs the script still has with a value of the same type (by its default); the others are skipped. */
export function matchInputs(config: { id: string; title?: string; defval: unknown }[], inputs: Record<string, unknown>): { inputs: Record<string, unknown>; skipped: string[] } {
  const out: Record<string, unknown> = {};
  const skipped: string[] = [];
  const ids = new Set(config.map((c) => c.id));
  for (const c of config) {
    if (!(c.id in inputs)) continue;
    const v = inputs[c.id];
    const same = c.defval === null || c.defval === undefined || typeof v === typeof c.defval;
    if (same) out[c.id] = v;
    else skipped.push(c.title ?? c.id);
  }
  // Inputs of the file the script does not have (dialog-internal keys start with "__").
  for (const k of Object.keys(inputs)) if (!ids.has(k) && !k.startsWith("__")) skipped.push(k);
  return { inputs: out, skipped };
}
