/*
 * Saved chart layouts — the data layer behind the header "Manage layouts"
 * dropdown (the `save-load-menu` HeaderMenu owner).
 *
 * A "layout" is a named snapshot of a chart workspace, persisted locally to
 * localStorage (not the cloud). A snapshot captures ONE tab's chart configuration
 * (the multi-pane template + every pane's symbol/interval/chart-type/
 * indicators). The active tab references the layout it was loaded from via
 * `savedLayoutId`; "dirty" = the tab's current config differs from that
 * saved snapshot.
 *
 * Deliberately out of scope (local-only limitations, see project memory):
 *   - Drawings stay symbol-keyed globally (loadDrawings/saveDrawings), not
 *     captured per-layout.
 *   - Share layout is a cloud feature and is not offered. "Download chart
 *     data…" opens the CSV export dialog (DownloadChartDataDialog).
 *
 * Module-level Solid signals + localStorage, mirroring layout-sync.ts /
 * interval-favorites.ts so any component can read/mutate without prop drilling.
 */
import { createSignal } from "solid-js";
import { renumberCharts, type LayoutId } from "../window/chart/layouts";
import type { LayoutSyncState } from "../window/chart/layout-sync";
import { revivePaneSettings, type LayoutSizes, type PaneChart } from "../window/shell/tabs";
import type { HeaderMenuDef } from "../window/header/header-menus/registry";
import type { Drawing } from "lightweight-charts-drawing/core/types";
import * as kv from "./kv";

/** The serialisable chart state a saved layout captures (one tab). */
export type LayoutSnapshot = {
  layout: LayoutId;
  activePane: number;
  panes: PaneChart[];
  /** Charts hidden by the template that the user edited (the ones a larger
   *  template shows again). Optional: absent = none. */
  hiddenPanes?: PaneChart[];
  /** Drawings present at save time, keyed by the symbol they belong to (the
   *  unique symbols across `panes`). Restored into the live per-symbol store on
   *  open. Optional — layouts saved before drawing-capture have no map. */
  drawings?: Record<string, Drawing[]>;
  /** "Sync in layout" toggles (saved in the layout content).
   *  Optional — layouts saved before per-tab sync have none. */
  sync?: LayoutSyncState;
  /** Chart sizes set with the splitters, per layout template. */
  layoutSizes?: LayoutSizes;
  /** Chart numbering revision `panes` is stored in (absent = 1). */
  numbering?: number;
};

export type SavedLayout = {
  id: string;
  name: string;
  snapshot: LayoutSnapshot;
  /** Epoch ms of the last save — drives the recent-first ordering. */
  updatedAt: number;
  /** Starred in the Manage layouts menu → a letter shortcut in the header
   *  (favorite layouts). */
  favorite?: boolean;
};

const LAYOUTS_KEY = "ot:layouts";
const AUTOSAVE_KEY = "ot:layout-autosave";

// ── Persistence ─────────────────────────────────────────────────────────────

function loadLayouts(): SavedLayout[] {
  try {
    const raw = kv.getItem(LAYOUTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (l): l is SavedLayout =>
          l && typeof l.id === "string" && typeof l.name === "string" && l.snapshot &&
          Array.isArray(l.snapshot.panes),
      )
      // Charts saved under an earlier numbering keep their place on screen.
      .map((l) => {
        const snapshot = renumberCharts(l.snapshot);
        return snapshot === l.snapshot ? l : { ...l, snapshot };
      });
  } catch {
    return [];
  }
}

function persist(list: SavedLayout[]): void {
  try {
    kv.setItem(LAYOUTS_KEY, JSON.stringify(list));
  } catch {
    /* best-effort (quota / unavailable) */
  }
}

const [layouts, setLayouts] = createSignal<SavedLayout[]>(loadLayouts());

// Live cross-window sync: re-seed the list when another window saves/renames/
// removes a layout (setLayouts is the raw signal setter — no re-persist).
kv.onExternalChange(LAYOUTS_KEY, () => setLayouts(loadLayouts()));

/** Live list of saved layouts, most-recently-updated first. */
export const savedLayouts = () => [...layouts()].sort((a, b) => b.updatedAt - a.updatedAt);

export function getLayout(id: string): SavedLayout | undefined {
  return layouts().find((l) => l.id === id);
}

let seq = 1;
function newLayoutId(): string {
  return `layout-${Date.now().toString(36)}-${(seq++).toString(36)}`;
}

function commit(list: SavedLayout[]): void {
  setLayouts(list);
  persist(list);
}

/** Detach a snapshot from the live chart state (drawings/panes are arrays of
 *  objects shared with the store) so later edits can't mutate what we saved. */
function cloneSnapshot(s: LayoutSnapshot): LayoutSnapshot {
  return JSON.parse(JSON.stringify(s)) as LayoutSnapshot;
}

/** True for a layout still carrying its default auto-name ("Unnamed",
 *  "Unnamed1", …) — i.e. the user hasn't named it yet. */
export function isUnnamedLayout(name: string): boolean {
  return /^Unnamed\d*$/.test(name);
}

/** Default name for a layout created without one: "Unnamed", then "Unnamed1",
 *  "Unnamed2", … picking the lowest free suffix. */
export function nextUnnamedName(): string {
  const taken = new Set(layouts().map((l) => l.name));
  if (!taken.has("Unnamed")) return "Unnamed";
  for (let n = 1; ; n++) {
    const name = `Unnamed${n}`;
    if (!taken.has(name)) return name;
  }
}

/** Create a new saved layout from a snapshot; returns the created record. */
export function createLayout(name: string, snapshot: LayoutSnapshot): SavedLayout {
  const layout: SavedLayout = { id: newLayoutId(), name, snapshot: cloneSnapshot(snapshot), updatedAt: Date.now() };
  commit([...layouts(), layout]);
  return layout;
}

/** Overwrite an existing layout's snapshot (the "Save layout" action). */
export function updateLayoutSnapshot(id: string, snapshot: LayoutSnapshot): void {
  const snap = cloneSnapshot(snapshot);
  commit(layouts().map((l) => (l.id === id ? { ...l, snapshot: snap, updatedAt: Date.now() } : l)));
}

export function renameLayout(id: string, name: string): void {
  commit(layouts().map((l) => (l.id === id ? { ...l, name, updatedAt: Date.now() } : l)));
}

/** Star / unstar a layout. Leaves `updatedAt` alone: favoriting is not an
 *  edit, so the recent-first order must not move. */
export function toggleFavoriteLayout(id: string): void {
  commit(layouts().map((l) => (l.id === id ? { ...l, favorite: !l.favorite } : l)));
}

/** Favorite layouts in header order: by name (localeCompare). */
export const favoriteLayouts = () =>
  layouts().filter((l) => l.favorite).sort((a, b) => a.name.localeCompare(b.name));

export function removeLayout(id: string): void {
  commit(layouts().filter((l) => l.id !== id));
}

/** Value-equality of two snapshots (used for the dirty check). The chart
 *  geometry (template + panes) is always compared; drawings are compared only
 *  when BOTH snapshots carry a map, so a pre-drawing-capture layout isn't
 *  flagged dirty the instant it's opened.
 *
 *  View-only and format fields are left out (only undoable actions, drawings
 *  and a rename count as changes; scroll/zoom never mark a layout changed,
 *  nor does selecting another chart of the layout): the snapshot's
 *  activePane, a pane's visibleLogicalRange, and the settings stamps
 *  settingsFp / settingsRev. All of them are still saved. Both sides' settings go through the same revive
 *  + migration, so a layout saved before a SETTINGS_REV bump compares equal
 *  to itself once opened. */
function comparablePanes(panes: PaneChart[]): unknown[] {
  return panes.map((p) => {
    const { visibleLogicalRange: _v, settingsFp: _f, settingsRev: _r, ...rest } = { ...p, ...revivePaneSettings(p) };
    return rest;
  });
}

export function snapshotsEqual(a: LayoutSnapshot, b: LayoutSnapshot): boolean {
  const core = (s: LayoutSnapshot) =>
    JSON.stringify({ layout: s.layout, panes: comparablePanes(s.panes), hidden: comparablePanes(s.hiddenPanes ?? []) });
  if (core(a) !== core(b)) return false;
  // Chart sizes set with the splitters are part of the layout.
  if (JSON.stringify(a.layoutSizes ?? {}) !== JSON.stringify(b.layoutSizes ?? {})) return false;
  if (a.sync && b.sync && JSON.stringify(a.sync) !== JSON.stringify(b.sync)) return false;
  if (a.drawings && b.drawings) return JSON.stringify(a.drawings) === JSON.stringify(b.drawings);
  return true;
}

// ── Autosave preference ──────────────────────────────────────────────────────

function loadAutosave(): boolean {
  try {
    return kv.getItem(AUTOSAVE_KEY) === "1";
  } catch {
    return false;
  }
}

const [layoutAutosave, setLayoutAutosaveRaw] = createSignal<boolean>(loadAutosave());
export { layoutAutosave };

kv.onExternalChange(AUTOSAVE_KEY, () => setLayoutAutosaveRaw(loadAutosave()));

export function setLayoutAutosave(on: boolean): void {
  setLayoutAutosaveRaw(on);
  try {
    kv.setItem(AUTOSAVE_KEY, on ? "1" : "0");
  } catch {
    /* best-effort */
  }
}

// ── Menu builder ─────────────────────────────────────────────────────────────

/** Row-id prefix for a "open this saved layout" entry. App.onMenuSelect splits
 *  on it to recover the layout id. */
export const OPEN_LAYOUT_PREFIX = "open-layout:";

type BuildArgs = {
  /** Id of the layout the active tab is currently showing (checkmarked). */
  activeId?: string;
  autosave: boolean;
  /** TRUE when the active chart has unsaved changes — drives the enabled state
   *  of "Save layout" (greyed out when everything is already saved). */
  dirty: boolean;
  /** One-line "SYMBOL, INTERVAL" of each saved layout's focused pane. */
  summaryOf: (l: SavedLayout) => string;
};

/**
 * Build the live "Manage layouts" menu def ("manage-layouts"). Structure + row
 * icons/hotkeys are static; the Autosave checkmark, the Save-layout enabled
 * state, and the saved-layouts list reflect live state. Saved-layout rows get
 * a unique `open-layout:<id>` id so the click handler knows which one to load.
 *
 * Sections (separated by dividers):
 *   1. Save / Autosave / Share / Make a copy / Rename / Download
 *   2. Create new layout
 *   3. saved layouts ("RECENTLY USED")
 *   4. Open layout
 */
export function buildSaveLoadMenu(args: BuildArgs): HeaderMenuDef {
  const saved = savedLayouts();
  const recentItems = saved.length
    ? saved.map((l) => ({
        id: `${OPEN_LAYOUT_PREFIX}${l.id}`,
        label: `${l.name} ${args.summaryOf(l)}`.trim(),
        iconName: null,
        hotkey: null,
        checked: l.id === args.activeId,
        favorited: !!l.favorite,
      }))
    : [
        {
          id: "save-load-menu-empty",
          label: "No saved layouts yet",
          iconName: null,
          hotkey: null,
          checked: false,
          favorited: false,
          disabled: true,
        },
      ];

  return {
    width: 197,
    sections: [
      {
        header: null,
        items: [
          { id: "save-load-menu-item-save", label: "Save layout", iconName: null, hotkey: "Ctrl + S", checked: false, favorited: false, disabled: !args.dirty },
          { id: "save-load-menu-item-auto-save", label: "Autosave", iconName: null, hotkey: null, checked: args.autosave, favorited: false },
          { id: "save-load-menu-item-clone", label: "Make a copy…", iconName: "menu-manage-layouts-make-a-copy", hotkey: null, checked: false, favorited: false },
          { id: "save-load-menu-item-rename", label: "Rename…", iconName: "menu-manage-layouts-rename", hotkey: null, checked: false, favorited: false },
          { id: "save-load-menu-item-download", label: "Download chart data…", iconName: "menu-manage-layouts-download-chart-data", hotkey: null, checked: false, favorited: false },
        ],
      },
      {
        header: null,
        items: [
          { id: "save-load-menu-item-create", label: "Create new layout…", iconName: "menu-manage-layouts-create-new-layout", hotkey: null, checked: false, favorited: false },
        ],
      },
      // The saved-layout rows are titled "RECENTLY USED" (none on the empty hint).
      { header: saved.length ? "RECENTLY USED" : null, items: recentItems },
      {
        header: null,
        items: [
          { id: "save-load-menu-item-load", label: "Open layout…", iconName: "menu-manage-layouts-open-layout", hotkey: "Dot", checked: false, favorited: false },
        ],
      },
    ],
  };
}
