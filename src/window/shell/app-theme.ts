/*
 * App theme and chart theme. The theme setting (App Settings > General) is
 * System, Dark or Light, stored as kv ot:theme; no stored value = System, the
 * reference desktop default. System follows the OS colour scheme live. The
 * app theme is the <html> class the stylesheets key on; changes are observed
 * off that class (`observeTheme`) rather than via a second channel.
 *
 * The chart colours are chart settings. A layout whose charts all use a
 * standard theme follows the app theme; one with custom colours keeps them
 * (the reference never asks when the desktop theme changes).
 */
import { createEffect, createMemo, createSignal, onCleanup, untrack, type Accessor } from "solid-js";
import * as kv from "../../data/kv";
import { SETTINGS_FINGERPRINT, SETTINGS_REV, stdThemeOf, withStdTheme, type StdTheme } from "../header/chart-settings";
import type { PaneChart, TabChart } from "./tabs";
import type { AppTabs } from "./app-tabs";

export type ThemeSetting = "system" | StdTheme;

const SYSTEM_DARK = "(prefers-color-scheme: dark)";

const loadSetting = (): ThemeSetting => {
  try {
    const v = kv.getItem("ot:theme");
    return v === "dark" || v === "light" ? v : "system";
  } catch { return "system"; }
};

const systemTheme = (): StdTheme =>
  typeof matchMedia === "function" && !matchMedia(SYSTEM_DARK).matches ? "light" : "dark";

const resolveTheme = (s: ThemeSetting): StdTheme => (s === "system" ? systemTheme() : s);

function setThemeClass(t: StdTheme) {
  document.documentElement.classList.remove("theme-dark", "theme-light");
  document.documentElement.classList.add(`theme-${t}`);
}

/** The theme setting and the app theme it resolves to. Sets the <html> class
 *  at once: call it before the charts are created (a pane with no stored
 *  settings reads its default colours from this class). */
export function createAppTheme() {
  const [themeSetting, setSettingSignal] = createSignal<ThemeSetting>(loadSetting());
  const [theme, setThemeSignal] = createSignal<StdTheme>(resolveTheme(themeSetting()));
  setThemeClass(theme());

  /** App Settings theme picker. */
  function setThemeSetting(next: ThemeSetting) {
    setSettingSignal(next);
    if (next === "system") kv.removeItem("ot:theme");
    else kv.setItem("ot:theme", next);
    setThemeClass(resolveTheme(next));
  }

  /** Follow the class so the chart canvases (props.theme → token re-read)
   *  update too, the OS colour scheme while the setting is System, and other
   *  windows' picks. Call from onMount. */
  function observeTheme() {
    const themeObserver = new MutationObserver(() => {
      const t = document.documentElement.classList.contains("theme-light") ? "light" : "dark";
      if (t !== theme()) setThemeSignal(t);
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    onCleanup(() => themeObserver.disconnect());
    if (typeof matchMedia === "function") {
      const mq = matchMedia(SYSTEM_DARK);
      const onSystem = () => { if (themeSetting() === "system") setThemeClass(systemTheme()); };
      mq.addEventListener("change", onSystem);
      onCleanup(() => mq.removeEventListener("change", onSystem));
    }
    // Cross-window live theme sync: another window's picker writes ot:theme.
    onCleanup(kv.onExternalChange("ot:theme", () => {
      setSettingSignal(loadSetting());
      setThemeClass(resolveTheme(themeSetting()));
    }));
  }

  return { theme, themeSetting, setThemeSetting, observeTheme };
}

/** Chart theme of the tabs: the effect re-colouring a shown layout whose
 *  charts all use a standard theme. */
export function createChartThemeSync(theme: Accessor<StdTheme>, t: Pick<AppTabs, "tabs" | "activeTab" | "patchTab">) {
  const { tabs, activeTab, patchTab } = t;

  const usesStdTheme = (tab: TabChart) => tab.panes.every((p) => stdThemeOf(p.settings) !== null);
  /** Re-colour every pane of a tab with the standard theme `next`. */
  function applyChartTheme(tabId: string, next: StdTheme) {
    const tab = tabs().find((x) => x.id === tabId);
    if (!tab) return;
    const recolor = (p: PaneChart): PaneChart =>
      p.settings && stdThemeOf(p.settings) !== next
        ? { ...p, settings: withStdTheme(p.settings, next), settingsFp: SETTINGS_FINGERPRINT, settingsRev: SETTINGS_REV }
        : p;
    // The charts hidden by the template switch too.
    patchTab(tabId, { panes: tab.panes.map(recolor), hiddenPanes: tab.hiddenPanes?.map(recolor) });
  }
  // A shown layout whose charts all use a standard theme takes the app theme
  // (app start, tab switch, theme switch, OS colour scheme change, new panes).
  const activePaneSettings = createMemo(() => activeTab().panes.map((p) => p.settings), undefined, {
    equals: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]),
  });
  createEffect(() => {
    const th = theme();
    activePaneSettings();
    const tab = untrack(activeTab);
    if (!usesStdTheme(tab)) return;
    if (tab.panes.some((p) => p.settings && stdThemeOf(p.settings) !== th)) untrack(() => applyChartTheme(tab.id, th));
  });
}
