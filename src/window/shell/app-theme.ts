/*
 * App theme and chart theme. The app theme is the <html> class the
 * stylesheets key on, seeded from the App-Settings theme picker's kv key; the
 * picker swaps the class live, so changes are observed off that class
 * (`observeTheme`) rather than via a second channel.
 *
 * The chart colours are chart settings. A chart that still uses a standard
 * theme's values follows the app theme; one with custom colours keeps them
 * unless the user agrees to switch it too.
 */
import { createEffect, createMemo, createSignal, onCleanup, untrack, type Accessor } from "solid-js";
import * as kv from "../../data/kv";
import { showConfirm } from "../../components/Dialogs";
import { SETTINGS_FINGERPRINT, SETTINGS_REV, stdThemeOf, withStdTheme, type StdTheme } from "../header/chart-settings";
import type { PaneChart, TabChart } from "./tabs";
import type { AppTabs } from "./app-tabs";

const loadTheme = (): "dark" | "light" => {
  try { return kv.getItem("ot:theme") === "light" ? "light" : "dark"; } catch { return "dark"; }
};

function setThemeClass(t: "dark" | "light") {
  document.documentElement.classList.remove("theme-dark", "theme-light");
  document.documentElement.classList.add(`theme-${t}`);
}

/** The app theme signal. Sets the <html> class at once: call it before the
 *  charts are created (a pane with no stored settings reads its default
 *  colours from this class). */
export function createAppTheme() {
  const [theme, setThemeSignal] = createSignal<"dark" | "light">(loadTheme());
  setThemeClass(theme());

  /** Follow the class (the picker re-themes by swapping it) so the chart
   *  canvases (props.theme → token re-read) update too, and other windows'
   *  picks. Call from onMount. */
  function observeTheme() {
    const themeObserver = new MutationObserver(() => {
      const t = document.documentElement.classList.contains("theme-light") ? "light" : "dark";
      if (t !== theme()) setThemeSignal(t);
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    onCleanup(() => themeObserver.disconnect());
    // Cross-window live theme sync: another window's picker writes ot:theme;
    // apply the class here (the observer above then updates the signal).
    onCleanup(kv.onExternalChange("ot:theme", () => setThemeClass(loadTheme())));
  }

  return { theme, observeTheme };
}

/** Chart theme of the tabs: the App Settings theme picker (`switchTheme`)
 *  and the effect re-colouring a shown layout that uses a standard theme. */
export function createChartThemeSync(theme: Accessor<StdTheme>, t: Pick<AppTabs, "tabs" | "activeTab" | "activeTabId" | "patchTab">) {
  const { tabs, activeTab, activeTabId, patchTab } = t;

  function applyUiTheme(next: StdTheme) {
    setThemeClass(next);
    kv.setItem("ot:theme", next);
  }
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
  /** App Settings theme picker. Charts of the shown layout that use a
   *  standard theme switch with it (effect below); custom colours ask first. */
  function switchTheme(next: StdTheme) {
    if (usesStdTheme(activeTab())) { applyUiTheme(next); return; }
    const tabId = activeTabId();
    showConfirm({
      title: "Theme",
      text: `The interface is switching to the ${next === "light" ? "Light" : "Dark"} theme. Switch the chart theme too?`,
      onConfirm: () => { applyUiTheme(next); applyChartTheme(tabId, next); },
      onCancel: () => applyUiTheme(next),
    });
  }
  // A shown layout whose charts all use a standard theme takes the app theme
  // (app start, tab switch, theme switch, new panes).
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

  return { switchTheme };
}
