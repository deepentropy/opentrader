/*
 * Chart templates (saved Chart Settings), shared by the Settings dialog's
 * Template menu and the chart menu's "Chart template" submenu. One kv blob:
 * [{ name, fingerprint, rev, draft }]. `fingerprint` / `rev` are the draft
 * format stamp; reviveDraft converts older formats and refuses unknown ones,
 * so only templates that revive under this build are listed.
 */
import { createSignal } from "solid-js";
import * as kv from "../../data/kv";
import { cloneDraft, reviveDraft, SETTINGS_FINGERPRINT, SETTINGS_REV, type Draft } from "./chart-settings";

const TEMPLATES_KEY = "ot:chart-settings-templates";
export type SettingsTemplate = { name: string; fingerprint: string; rev?: number; draft: unknown };

function readAll(): SettingsTemplate[] {
  try {
    const raw = kv.getItem(TEMPLATES_KEY);
    const arr: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (t): t is SettingsTemplate =>
        !!t && typeof t === "object" && typeof (t as SettingsTemplate).name === "string",
    );
  } catch {
    return [];
  }
}

const byName = (a: SettingsTemplate, b: SettingsTemplate) => a.name.localeCompare(b.name, undefined, { numeric: true });
const usable = () => readAll().filter((t) => reviveDraft(t.draft, t.fingerprint, t.rev) !== undefined).sort(byName);

const [templates, setTemplates] = createSignal<SettingsTemplate[]>(usable());
kv.onExternalChange(TEMPLATES_KEY, () => setTemplates(usable()));

/** Saved templates that revive under this build, by name. Reactive. */
export function chartTemplates(): SettingsTemplate[] {
  return templates();
}

/** Save (or replace) a template from a settings draft. */
export function saveChartTemplate(name: string, draft: Draft): void {
  const entry: SettingsTemplate = { name, fingerprint: SETTINGS_FINGERPRINT, rev: SETTINGS_REV, draft: cloneDraft(draft) };
  kv.setItem(TEMPLATES_KEY, JSON.stringify([...readAll().filter((t) => t.name !== name), entry]));
  setTemplates(usable());
}

export function removeChartTemplate(name: string): void {
  kv.setItem(TEMPLATES_KEY, JSON.stringify(readAll().filter((t) => t.name !== name)));
  setTemplates(usable());
}

/** The template's settings draft, or undefined when it cannot be revived. */
export function chartTemplateDraft(t: SettingsTemplate): Draft | undefined {
  return reviveDraft(t.draft, t.fingerprint, t.rev);
}
