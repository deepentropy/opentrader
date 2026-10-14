/*
 * Shell requests from the charts and the panels (app events): open the Chart
 * settings / Indicators / alert dialog or a right-rail page, chart templates
 * (save as, apply, remove), clear the indicators, the price-scale menu's
 * settings rows, the session and the time zone. Installed by App on mount.
 */
import { onAppEvent } from "../../data/app-events";
import type { SessionId } from "../../data/datafeed";
import { TIMEZONES } from "../../data/timezones";
import { setTimezone } from "../../data/chart-timezone";
import { showConfirm, showRename } from "../../components/Dialogs";
import { chartTemplateDraft, chartTemplates, removeChartTemplate, saveChartTemplate } from "../header/chart-templates";
import { patchDraftScales, saveChartSettingsDefaults, SETTINGS_FINGERPRINT, SETTINGS_REV, type Draft } from "../header/chart-settings";
import type { AppTabs } from "./app-tabs";
import { setActiveRailTab, setAlertDialog, setIndicatorsDialogOpen, setSettingsDialogOpen, setSettingsDialogTab } from "./app-dialogs";

export type RequestActions = {
  tabs: Pick<AppTabs, "activePaneState" | "patchActivePane">;
  /** The active chart's Chart Settings as a draft. */
  activeSettingsDraft: () => Draft;
  commitChartSettings: (draft: Draft, scope: "active" | "all") => void;
  removeAllIndicators: () => void;
  setSession: (id: SessionId) => void;
};

/** Listen to the requests. Returns the disposer. */
export function installAppRequests(a: RequestActions): () => void {
  const { activePaneState, patchActivePane } = a.tabs;
  const offs = [
    // Window events from the chart right-click menu (ChartContextMenu).
    onAppEvent("chart-open-settings", (d) => {
      setSettingsDialogTab(d?.tab);
      setSettingsDialogOpen(true);
    }),
    // Chart menu "Chart template": "Save as…" saves the active chart's
    // settings as a chart template ("Save template as" name dialog, the
    // Settings dialog Template menu's); a template row applies it to the
    // active chart; its trash removes it (confirmation).
    onAppEvent("chart-save-template", () =>
      showRename({
        title: "Save template as",
        label: "Template name:",
        maxLength: 128,
        names: chartTemplates().map((t) => t.name),
        replaceText: (n) => `Template '${n}' already exists. Do you really want to replace it?`,
        onSave: (name) => saveChartTemplate(name, a.activeSettingsDraft()),
      }),
    ),
    onAppEvent("chart-apply-template", (d) => {
      const name = d?.name;
      const t = chartTemplates().find((x) => x.name === name);
      const draft = t ? chartTemplateDraft(t) : undefined;
      if (draft) a.commitChartSettings(draft, "active");
    }),
    onAppEvent("chart-remove-template", (d) => {
      const name = d?.name;
      if (!name) return;
      showConfirm({ text: `Do you really want to delete Chart Template '${name}' ?`, onConfirm: () => removeChartTemplate(name) });
    }),
    onAppEvent("chart-clear-indicators", () => a.removeAllIndicators()),
    onAppEvent("chart-open-panel", (d) => {
      const id = d?.id;
      if (id) setActiveRailTab(id);
    }),
    // Chart context-menu "Add alert", AlertsPanel "edit", header "Create alert".
    onAppEvent("chart-open-alert-dialog", (detail) => {
      const d = detail ?? {};
      setAlertDialog({ editId: d.editId, symbol: d.symbol, price: d.price, indicatorId: d.indicatorId, drawingId: d.drawingId });
    }),
    // Price-scale context menu (right-click on the price axis): checkable
    // Labels/Lines rows + "Move scale" fold into the focused pane's Settings
    // draft (same rows the dialog edits); Session radios reuse setSession.
    onAppEvent("chart-patch-scale-settings", (d) => {
      const patch = d?.patch;
      if (!patch) return;
      const settings = patchDraftScales(activePaneState().settings, patch);
      patchActivePane({ settings, settingsFp: SETTINGS_FINGERPRINT, settingsRev: SETTINGS_REV });
      // Price-scale menu edits are chart setting edits too (saved as the
      // defaults of new charts).
      saveChartSettingsDefaults(settings);
    }),
    onAppEvent("chart-set-session", (d) => {
      const id = d?.id;
      if (id === "RTH" || id === "ETH") a.setSession(id);
    }),
    // Time-axis menu → "Time zone" row: the app-wide display timezone (same
    // signal as the bottom-bar timezone menu).
    onAppEvent("chart-set-timezone", (d) => {
      const label = d?.label;
      const tz = TIMEZONES.find((z) => z.label === label);
      if (tz) setTimezone({ label: tz.label, iana: tz.iana });
    }),
    // Legend series More → "Add indicator/strategy on …".
    onAppEvent("chart-open-indicators", () => setIndicatorsDialogOpen(true)),
  ];
  return () => offs.forEach((off) => off());
}
