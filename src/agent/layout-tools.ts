/*
 * Layout tools of Settings > Coding agents: the saved chart layouts ("Manage layouts") and the window's tabs: list
 * them, open, save and delete a layout, switch tab. Opening a layout over unsaved changes asks the user first, as the
 * menu does.
 */
import { savedLayouts } from "../data/layout-store";
import type { AppTabs } from "../window/shell/app-tabs";
import type { SavedLayouts } from "../window/shell/saved-layouts";
import { tabTitle } from "../window/shell/tabs";
import { AgentError, type AgentTool } from "./mcp";

export type LayoutHost = {
  tabs: Pick<AppTabs, "tabs" | "activeTab" | "activateTab">;
  layouts: Pick<SavedLayouts, "layoutDirty" | "layoutName" | "summaryOfLayout" | "saveActiveLayout" | "saveActiveLayoutAs" | "requestOpenLayout" | "deleteSavedLayout" | "pendingOpenId">;
};

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function layoutNamed(name: unknown) {
  const n = typeof name === "string" ? name.trim().toLowerCase() : "";
  const l = savedLayouts().find((x) => x.name.toLowerCase() === n);
  if (!l) throw new AgentError(`No saved layout named "${String(name)}". Layouts: ${savedLayouts().map((x) => x.name).join(", ") || "none"}.`);
  return l;
}

export function createLayoutTools(host: LayoutHost): AgentTool[] {
  const { tabs, layouts } = host;
  return [
    {
      name: "list_layouts",
      title: "List layouts",
      description:
        "The saved chart layouts (name, focused symbol and interval, last saved, favourite) and the window's tabs (index, title, the layout each shows, unsaved changes of the active one).",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      run: async () => {
        const active = tabs.activeTab();
        return {
          layouts: savedLayouts().map((l) => ({ name: l.name, chart: layouts.summaryOfLayout(l), saved: day(l.updatedAt), ...(l.favorite ? { favorite: true } : {}) })),
          tabs: tabs.tabs().filter((t) => t.isChart).map((t, index) => ({
            index,
            title: tabTitle(t),
            layout: t.savedLayoutName ?? null,
            ...(t.id === active.id ? { active: true, unsaved: layouts.layoutDirty() } : {}),
          })),
        };
      },
    },
    {
      name: "open_layout",
      title: "Open layout",
      description: "Open a saved layout in the active tab. With unsaved changes the app asks the user whether to save them first (the answer is theirs).",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      run: async (args) => {
        const l = layoutNamed(args.name);
        layouts.requestOpenLayout(l.id);
        return layouts.pendingOpenId() === l.id ? { asked: true, note: "The user is asked whether to save the current changes first." } : { opened: l.name };
      },
    },
    {
      name: "save_layout",
      title: "Save layout",
      description: "Save the active tab's charts: into the layout it shows, or under name as a new saved layout (a copy when the tab already shows one).",
      inputSchema: { type: "object", properties: { name: { type: "string" } } },
      run: async (args) => {
        const name = typeof args.name === "string" ? args.name.trim() : "";
        const shown = tabs.activeTab().savedLayoutName;
        if (name && name.toLowerCase() !== shown?.toLowerCase()) {
          if (savedLayouts().some((l) => l.name.toLowerCase() === name.toLowerCase())) throw new AgentError(`A layout is already named "${name}": open it, or pick another name.`);
          layouts.saveActiveLayoutAs(name);
          return { saved: name, created: true };
        }
        if (!shown) throw new AgentError('This tab shows no saved layout yet: give a "name".');
        if (!layouts.saveActiveLayout()) throw new AgentError(`"${shown}" has no name yet: give a "name".`);
        return { saved: shown };
      },
    },
    {
      name: "delete_layout",
      title: "Delete layout",
      description: "Delete a saved layout (the charts of the tabs stay). Ask the user first: it cannot be undone.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      annotations: { destructiveHint: true },
      run: async (args) => {
        const l = layoutNamed(args.name);
        layouts.deleteSavedLayout(l.id);
        return { deleted: l.name };
      },
    },
    {
      name: "switch_tab",
      title: "Switch tab",
      description: "Make another chart tab of the window the active one (index from list_layouts). The chart tools then act on it.",
      inputSchema: { type: "object", properties: { index: { type: "integer" } }, required: ["index"] },
      run: async (args) => {
        const charts = tabs.tabs().filter((t) => t.isChart);
        const i = typeof args.index === "number" ? Math.floor(args.index) : -1;
        const t = charts[i];
        if (!t) throw new AgentError(`"index": 0 to ${charts.length - 1}.`);
        tabs.activateTab(t.id);
        return { active: i, title: tabTitle(t) };
      },
    },
  ];
}
