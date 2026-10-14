/*
 * Saved chart layouts on the shell side ("Manage layouts" header dropdown):
 * a saved layout snapshots the active tab's chart config (template + every
 * pane + their drawings). The tab tracks which saved layout it shows
 * (savedLayoutId) so the header badge can name it and flag unsaved edits.
 * Holds the naming / "Open layout" / "Download chart data" / unsaved-changes
 * dialog state, the save / open / create / rename operations and the
 * autosave effect. The store itself is data/layout-store.ts. Created once by
 * App.
 */
import { createEffect, createSignal } from "solid-js";
import type { Drawing } from "lightweight-charts-drawing/core/types";
import * as kv from "../../data/kv";
import {
  createLayout,
  getLayout,
  isUnnamedLayout,
  layoutAutosave,
  OPEN_LAYOUT_PREFIX,
  removeLayout,
  renameLayout,
  setLayoutAutosave,
  snapshotsEqual,
  updateLayoutSnapshot,
  type LayoutSnapshot,
  type SavedLayout,
} from "../../data/layout-store";
import { LAYOUT_NUMBERING } from "../chart/layouts";
import { defaultLayoutSync, reviveLayoutSync } from "../chart/layout-sync";
import { makeTab, newPaneId, reviveCompare, reviveLayoutSizes, revivePaneSettings, reviveStudies, savedHiddenPanes, type PaneChart } from "./tabs";
import { scopeKeys, viewKeyOf } from "../drawings/drawing-store";
import type { AppTabs } from "./app-tabs";

export type LayoutNameDialogState = { mode: "save" | "rename" | "copy" | "create"; initial: string; persist?: boolean };

/** Drawing store access: read a scope / view key's drawings, write a scope
 *  key's (no undo record). */
type LayoutDrawings = {
  drawingsFor: (key: string) => Drawing[];
  setSlice: (key: string, next: Drawing[], meta: null) => void;
};

export function createSavedLayouts(t: Pick<AppTabs, "tabs" | "setTabs" | "activeTab" | "patchActive" | "activateTab">, d: LayoutDrawings) {
  const { tabs, setTabs, activeTab, patchActive, activateTab } = t;

  const snapshotActive = (): LayoutSnapshot => {
    const tab = activeTab();
    // Capture each unique pane scope key's drawings so the layout carries them.
    // Reading drawingsFor here keeps the dirty check reactive to drawing edits.
    const drawings: Record<string, Drawing[]> = {};
    // Hidden charts are saved once edited, with their drawings.
    const hiddenPanes = savedHiddenPanes(tab.hiddenPanes);
    for (const p of hiddenPanes ? [...tab.panes, ...hiddenPanes] : tab.panes) {
      for (const key of scopeKeys(viewKeyOf(p, activeTab().id))) {
        if (!(key in drawings)) drawings[key] = d.drawingsFor(key);
      }
    }
    return { layout: tab.layout, activePane: tab.activePane, panes: tab.panes, hiddenPanes, drawings, sync: tab.sync, layoutSizes: tab.layoutSizes, numbering: LAYOUT_NUMBERING };
  };
  const activeSaved = () => {
    const id = activeTab().savedLayoutId;
    return id ? getLayout(id) : undefined;
  };
  // Dirty = no saved layout yet, or the live snapshot differs from the saved one.
  const layoutDirty = () => {
    const saved = activeSaved();
    return saved ? !snapshotsEqual(snapshotActive(), saved.snapshot) : true;
  };
  const layoutName = () => activeTab().savedLayoutName ?? "Unnamed";
  // "SYMBOL, INTERVAL" of a saved layout's focused pane (the recent-list suffix).
  const summaryOfLayout = (l: SavedLayout) => {
    const p = l.snapshot.panes[l.snapshot.activePane] ?? l.snapshot.panes[0];
    return p ? `${p.symbol}, ${p.interval}` : "";
  };

  // Naming-dialog state: null = closed. `mode` selects the submit behaviour.
  const [layoutNameDialog, setLayoutNameDialog] = createSignal<null | LayoutNameDialogState>(null);
  // "Create layout" dialog: its "Open in new tab" box is remembered (default on).
  const CREATE_NEW_TAB_KEY = "ot:create-layout-new-tab";
  const [createInNewTab, setCreateInNewTab] = createSignal(kv.getItem(CREATE_NEW_TAB_KEY) !== "false");
  // "Open layout" browser modal (lists every saved layout; load / delete).
  const [layoutBrowserOpen, setLayoutBrowserOpen] = createSignal(false);
  // Manage layouts → "Download chart data…" (CSV export dialog).
  const [downloadDataOpen, setDownloadDataOpen] = createSignal(false);

  // Delete a saved layout; if it's the one the active tab shows, detach the tab
  // (the badge falls back to "Untitled").
  function deleteSavedLayout(id: string) {
    removeLayout(id);
    if (activeTab().savedLayoutId === id) {
      patchActive({ savedLayoutId: undefined, savedLayoutName: undefined });
    }
  }

  // Persist the active snapshot into its saved layout; untitled charts open the
  // name dialog first (Save As), otherwise overwrite in place. Returns true
  // when saved at once, false when a name dialog was opened.
  function saveActiveLayout(): boolean {
    const tab = activeTab();
    const saved = tab.savedLayoutId ? getLayout(tab.savedLayoutId) : undefined;
    // A named layout overwrites in place silently; a still-"Unnamed" (or unsaved)
    // one prompts for a real name first — an Unnamed is never saved silently.
    if (saved && !isUnnamedLayout(saved.name)) {
      updateLayoutSnapshot(saved.id, snapshotActive());
      return true;
    } else if (saved) {
      // Existing but still "Unnamed" → the rename popup (persist the snapshot on
      // submit), not the "Save new chart layout" dialog.
      setLayoutNameDialog({ mode: "rename", initial: "", persist: true });
    } else {
      setLayoutNameDialog({ mode: "save", initial: "" });
    }
    return false;
  }
  // Create a fresh saved layout from the current snapshot (Save As / Make a
  // copy) and point the active tab at it.
  function saveActiveLayoutAs(name: string) {
    const created = createLayout(name, snapshotActive());
    patchActive({ savedLayoutId: created.id, savedLayoutName: created.name });
  }
  // Switching layouts with unsaved changes asks first ("Save layout before
  // switching?"). `pendingOpenId` = the layout waiting on
  // that answer; `openAfterNaming` = the one to open once a Save that needed a
  // name dialog is submitted (cleared if that dialog is cancelled).
  const [pendingOpenId, setPendingOpenId] = createSignal<string | null>(null);
  let openAfterNaming: string | null = null;
  function requestOpenLayout(id: string) {
    if (!getLayout(id)) return;
    if (layoutDirty()) setPendingOpenId(id);
    else openSavedLayout(id);
  }
  function resolvePendingOpen(choice: "save" | "dontSave" | "cancel") {
    const id = pendingOpenId();
    setPendingOpenId(null);
    if (!id || choice === "cancel") return;
    if (choice === "dontSave") {
      openSavedLayout(id);
      return;
    }
    if (saveActiveLayout()) openSavedLayout(id);
    else openAfterNaming = id;
  }
  // Load a saved layout's snapshot into the active tab, restoring its captured
  // drawings into the live per-symbol store. NOTE: drawings are symbol-keyed
  // globally, so this overwrites those symbols' drawings everywhere (any other
  // tab/pane on the same symbol) — the cost of layout-scoped drawings on top of
  // the symbol-keyed model. See data/layout-store.ts.
  function openSavedLayout(id: string) {
    const l = getLayout(id);
    if (!l) return;
    const revive = (p: PaneChart): PaneChart =>
      ({ ...p, id: p.id ?? newPaneId(), ...reviveStudies(p), compare: reviveCompare(p.compare), ...revivePaneSettings(p) });
    patchActive({
      layout: l.snapshot.layout,
      panes: l.snapshot.panes.map(revive),
      hiddenPanes: savedHiddenPanes(l.snapshot.hiddenPanes?.map(revive)),
      activePane: Math.min(l.snapshot.activePane, l.snapshot.panes.length - 1),
      // Layouts saved before per-tab sync keep the tab's current toggles.
      sync: l.snapshot.sync ? reviveLayoutSync(l.snapshot.sync) : activeTab().sync,
      layoutSizes: reviveLayoutSizes(l.snapshot.layoutSizes),
      savedLayoutId: l.id,
      savedLayoutName: l.name,
    });
    const dmap = l.snapshot.drawings;
    if (dmap) {
      for (const [sym, list] of Object.entries(dmap)) {
        // Clone so later edits never mutate the stored snapshot's arrays.
        d.setSlice(sym, JSON.parse(JSON.stringify(list)) as Drawing[], null);
      }
    }
  }
  // "Create new layout…" (the "Create layout" dialog): a default single-pane
  // chart on the first chart's symbol and interval, saved under `name`, in a
  // new tab or in the active one.
  function createNewLayoutNamed(name: string, inNewTab: boolean) {
    const first = activeTab().panes[0];
    const fresh = makeTab({ symbol: first?.symbol, interval: first?.interval });
    if (inNewTab) {
      setTabs([...tabs(), fresh]);
      activateTab(fresh.id);
    }
    patchActive({
      layout: fresh.layout,
      panes: fresh.panes,
      hiddenPanes: undefined,
      activePane: 0,
      sync: defaultLayoutSync(),
      layoutSizes: undefined,
      savedLayoutId: undefined,
      savedLayoutName: undefined,
    });
    const created = createLayout(name, snapshotActive());
    patchActive({ savedLayoutId: created.id, savedLayoutName: created.name });
  }
  function submitLayoutName(name: string) {
    const dlg = layoutNameDialog();
    if (!dlg) return;
    if (dlg.mode === "create") {
      kv.setItem(CREATE_NEW_TAB_KEY, String(createInNewTab()));
      createNewLayoutNamed(name, createInNewTab());
      return;
    }
    if (dlg.mode === "rename") {
      const id = activeTab().savedLayoutId;
      if (id) {
        renameLayout(id, name);
        // Saving an Unnamed layout reuses this popup with `persist`, so also
        // commit the current snapshot (a plain rename leaves it untouched).
        if (dlg.persist) updateLayoutSnapshot(id, snapshotActive());
        patchActive({ savedLayoutName: name });
      } else {
        saveActiveLayoutAs(name);
      }
    } else {
      // "save" (Save As) and "copy" create a new named layout from the snapshot.
      saveActiveLayoutAs(name);
    }
    if (openAfterNaming) {
      const id = openAfterNaming;
      openAfterNaming = null;
      openSavedLayout(id);
    }
  }
  /** The naming dialog closed (submitted or cancelled). */
  function closeLayoutNameDialog() {
    openAfterNaming = null;
    setLayoutNameDialog(null);
  }
  // Autosave: when on, persist a NAMED layout whenever it goes dirty. Never
  // silently creates a layout for an untitled chart.
  createEffect(() => {
    if (!layoutAutosave()) return;
    const tab = activeTab();
    if (!tab.savedLayoutId) return;
    if (layoutDirty()) updateLayoutSnapshot(tab.savedLayoutId, snapshotActive());
  });

  /** Dispatch a "Manage layouts" row click. Saved-layout rows carry their id in
   *  the `open-layout:<id>` row id; the rest are fixed action ids. */
  function onManageLayoutsSelect(rowId: string) {
    if (rowId.startsWith(OPEN_LAYOUT_PREFIX)) {
      requestOpenLayout(rowId.slice(OPEN_LAYOUT_PREFIX.length));
      return;
    }
    switch (rowId) {
      case "save-load-menu-item-save":
        saveActiveLayout();
        break;
      case "save-load-menu-item-auto-save":
        setLayoutAutosave(!layoutAutosave());
        break;
      case "save-load-menu-item-clone":
        setLayoutNameDialog({ mode: "copy", initial: `${layoutName()} copy` });
        break;
      case "save-load-menu-item-rename":
        setLayoutNameDialog({
          mode: "rename",
          initial: activeTab().savedLayoutName ?? "",
        });
        break;
      case "save-load-menu-item-download":
        setDownloadDataOpen(true);
        break;
      case "save-load-menu-item-create":
        setLayoutNameDialog({ mode: "create", initial: "" });
        break;
      case "save-load-menu-item-load":
        setLayoutBrowserOpen(true);
        break;
      // The empty placeholder row: nothing to do.
      default:
        break;
    }
  }

  return {
    layoutDirty,
    layoutName,
    summaryOfLayout,
    layoutNameDialog,
    createInNewTab,
    setCreateInNewTab,
    layoutBrowserOpen,
    setLayoutBrowserOpen,
    downloadDataOpen,
    setDownloadDataOpen,
    pendingOpenId,
    deleteSavedLayout,
    saveActiveLayout,
    requestOpenLayout,
    resolvePendingOpen,
    submitLayoutName,
    closeLayoutNameDialog,
    onManageLayoutsSelect,
  };
}

export type SavedLayouts = ReturnType<typeof createSavedLayouts>;
