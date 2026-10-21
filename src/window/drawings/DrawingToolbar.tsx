/*
 * DrawingToolbar — vertical strip on the left edge of the chart pane: the
 * tool groups with their submenus (arming a tool), Measure / Zoom, the
 * magnet, keep drawing, lock, hide, remove and sync toggles. Drawing
 * creation and hit-testing live in DrawingsOverlay; the toggles' state in App.
 *
 * Click model:
 *   • Click the icon button → activate the group's current default tool.
 *   • Click the chevron arrow → open/close the submenu.
 * Click a submenu row → close the submenu, activate that tool, and promote
 * it to be the group's displayed default (per-group MRU behaviour).
 */
import { track } from "../../data/analytics";
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import {
  CURSOR_MODE_TOOL,
  CURSOR_TOOL_MODES,
  GROUPS,
  groupTools,
  type CursorMode,
  type Group,
  type Tool,
} from "../../data/drawing-toolbar";
import {
  favoritesToolbarVisible,
  isFavoriteTool,
  setFavoritesToolbarVisible,
  setRailSelectedTool,
  toggleFavoriteTool,
} from "./favorite-tools";
import { FontIconPicker, type FontIconTab } from "./FontIconPicker";
import { findOverlaySpec } from "lightweight-charts-drawing/core/specs";
import { PLACE_AT_CURSOR_EVENT, type PlaceAtCursorDetail } from "./DrawingsOverlay";
import { emitAppEvent, onAppEvent } from "../../data/app-events";
import type { DrawingKind } from "lightweight-charts-drawing/core/types";
import * as kv from "../../data/kv";

/** Hotkey tools created at once at the cursor (Alt+H/J/V/C). */
const PLACE_NOW = new Set(["horizontal-line", "horizontal-ray", "vertical-line", "cross-line"]);

/** Main-button tooltip hotkey hints. NOT the tool-select hotkeys (Alt+T,
 *  Alt+F…): those show on the flyout rows only. The Shift gestures themselves
 *  live in lightweight-charts-drawing interact/shift. The "Gann box" is OT
 *  gann-box. */
const SHIFT_45 = { hotkey: "Shift", hotkeyText: "{0} — drawing a straight line at angles of 45" };
const SHIFT_CIRCLE = { hotkey: "Shift", hotkeyText: "{0} — circle" };
const SHIFT_SQUARE = { hotkey: "Shift", hotkeyText: "{0} — square" };
const TOOL_HINTS: Record<string, { hotkey: string; hotkeyText?: string }> = {
  "trend-line": SHIFT_45,
  "trend-angle": SHIFT_45,
  "parallel-channel": SHIFT_45,
  "flat-top-bottom": SHIFT_45,
  "disjoint-channel": SHIFT_45,
  "price-note": SHIFT_45,
  "rotated-rectangle": SHIFT_45,
  ellipse: SHIFT_CIRCLE,
  "fib-circles": SHIFT_CIRCLE,
  rectangle: SHIFT_SQUARE,
  "fib-speed-resistance-fan": SHIFT_SQUARE,
  "gann-box": { hotkey: "Shift", hotkeyText: "{0} — fixed increments" },
  "horizontal-line": { hotkey: "Alt + H" },
  "vertical-line": { hotkey: "Alt + V" },
  demonstration: { hotkey: "Alt", hotkeyText: "Hold {0} for temporary drawing" },
};

/** The three Font-Icons tools open the picker on their tab instead of arming a
 *  drawing kind directly; the picker stages a glyph then arms the `font-icon`
 *  tool. */
const FONT_ICON_TOOLS: Record<string, FontIconTab> = { icon: "icon", emoji: "emoji", sticker: "sticker" };

/** The two region tools (transient press-drag gestures, not placed drawings)
 *  the overlay handles outside the drawing-spec path. */
const REGION_TOOLS = new Set<string>(["measure", "zoom"]);

/** Whether picking a tool actually does anything: it places a drawing (has an
 *  overlay spec), sets a cursor mode, opens the font-icon picker, or runs a
 *  region gesture. Several tools are listed but have no implementation yet —
 *  those render disabled (greyed) in the submenu and arm nothing if reached
 *  by any other path. */
function isToolImplemented(toolId: string): boolean {
  return (
    !!findOverlaySpec(toolId) ||
    toolId in CURSOR_TOOL_MODES ||
    toolId in FONT_ICON_TOOLS ||
    REGION_TOOLS.has(toolId)
  );
}

type Props = {
  /** Currently-armed tool id; `null` when nothing is armed. App owns this. */
  armedTool: string | null;
  setArmedTool: (id: string | null) => void;
  /** Stage the glyph chosen in the FontIconPicker (emoji char or `<svg>`
   *  markup) before arming the `font-icon` tool. */
  setArmedGlyph: (glyph: string) => void;
  /** Chart interaction mode set by the Cursor group (cross / dot / arrow /
   *  eraser / demonstration). App owns it so the overlay + chart host read the
   *  same source of truth. */
  cursorMode: CursorMode;
  setCursorMode: (m: CursorMode) => void;
  /** Bottom-rail toggles + bulk actions, owned by App so the overlay and
   *  the drawings array stay the single source of truth. */
  magnet: boolean;
  setMagnet: (v: boolean) => void;
  /** Magnet strength (Weak/Strong) + "snap to indicator" — the split-control
   *  sub-options behind the magnet button's caret. */
  magnetMode: "weak" | "strong";
  setMagnetMode: (m: "weak" | "strong") => void;
  magnetSnapsToIndicators: boolean;
  setMagnetSnapsToIndicators: (v: boolean) => void;
  stayMode: boolean;
  setStayMode: (v: boolean) => void;
  /** Hide and Lock buttons (App-owned): the saved mode of each button, the
   *  hidden / locked parts, and the toggle (no mode = the button, a mode = a
   *  menu row). */
  hideMode: ObjectsMode;
  hidden: { drawings: boolean; indicators: boolean };
  onToggleHide: (mode?: ObjectsMode) => void;
  lockMode: ObjectsMode;
  locked: { drawings: boolean; indicators: boolean };
  onToggleLock: (mode?: ObjectsMode) => void;
  /** Remove-objects dropdown actions: drawings only, indicators only, or both.
   *  Split control: the icon click defaults to "remove drawings"
   *  (`onRemoveAll`). */
  onRemoveAll: () => void;
  onRemoveIndicators: () => void;
  onRemoveAllObjects: () => void;
  /** Counts in the Remove rows ("Remove 112 drawings & 8 indicators"):
   *  the active drawings and the active pane's indicators, the sets the
   *  rows remove. */
  drawingCount: number;
  indicatorCount: number;
  /** Remove options switch "Always remove locked drawings" (App-owned). */
  alwaysRemoveLocked: boolean;
  onToggleAlwaysRemoveLocked: () => void;
  /** Drawing-sync scope (App-owned, persisted). Drives how the drawing store
   *  keys panes: none = per pane, layout = per tab/layout, global = by symbol. */
  syncMode: SyncMode;
  setSyncMode: (m: SyncMode) => void;
};

/** Drawing-sync scope — the `drawingSyncMode-button`. Controls how drawings
 *  are shared across the layout's panes: per pane / per layout / globally by
 *  symbol. */
export type SyncMode = "none" | "layout" | "global";
/** Mode of the Hide and Lock buttons. */
export type ObjectsMode = "drawings" | "indicators" | "all";
/** Hide / Lock buttons: per mode the menu row, the button icon (off / on)
 *  and tooltip (off / on), as in the reference. */
const OBJECTS_MODES: Record<"hide" | "lock", Record<ObjectsMode, { label: string; icon: [string, string]; tooltip: [string, string] }>> = {
  hide: {
    drawings: { label: "Hide drawings", icon: ["draw-hide-drawings", "draw-hide-drawings-active"], tooltip: ["Hide all drawings", "Show all drawings"] },
    indicators: { label: "Hide indicators", icon: ["draw-hide-indicators", "draw-hide-indicators-active"], tooltip: ["Hide all indicators", "Show all indicators"] },
    all: { label: "Hide all", icon: ["draw-hide-all-mode", "draw-hide-all-mode-active"], tooltip: ["Hide all drawings and indicators", "Show all drawings and indicators"] },
  },
  lock: {
    drawings: { label: "Lock drawings", icon: ["draw-lock-drawings", "draw-lock-drawings-active"], tooltip: ["Lock drawings", "Unlock drawings"] },
    indicators: { label: "Lock indicators", icon: ["draw-lock-indicators", "draw-lock-indicators-active"], tooltip: ["Lock indicators", "Unlock indicators"] },
    all: { label: "Lock all", icon: ["draw-lock-all", "draw-lock-all-active"], tooltip: ["Lock drawings and indicators", "Unlock drawings and indicators"] },
  },
};
/** A mode is on: its part, or both parts for "all". */
const modeOn = (m: ObjectsMode, st: { drawings: boolean; indicators: boolean }) =>
  m === "all" ? st.drawings && st.indicators : st[m];
const SYNC_LABELS: Record<SyncMode, string> = {
  none: "No sync",
  layout: "New drawings sync in layout",
  global: "New drawings sync globally",
};
/** Sync button tooltip per mode (`drawingSyncMode-button` title). */
const SYNC_TOOLTIPS: Record<SyncMode, string> = {
  none: "New drawings will not be synced",
  layout: "New drawings are replicated to all charts in the layout and shown when the same ticker is selected",
  global: "New drawings are replicated to all charts in all layouts and shown when the same ticker is selected",
};

/** "1 drawing" / "112 drawings" (same rule as the chart menu Remove rows). */
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function DrawingToolbar(props: Props) {
  // Which tool each group displays on its toolbar button — per-group MRU
  // behaviour. Pure UI state, stays local.
  const [groupDefault, setGroupDefault] = createSignal<Record<string, string>>(
    Object.fromEntries(GROUPS.map((g) => [g.id, groupTools(g)[0]?.id ?? ""])),
  );
  const [openGroup, setOpenGroup] = createSignal<string | null>(null);
  // Which tool id reads as "selected" on the rail. Tracks the last pick so the
  // Cursor group (whose tools arm nothing) can still show its active row — the
  // armedTool signal alone can't, since cursor modes clear it. Initial: Cross.
  const [selectedTool, setSelectedTool] = createSignal<string>("cross");
  // Drawing-sync split control (No sync / Sync in layout / Sync globally).
  // App owns the value + persistence; the toolbar just reads/sets it.
  const syncMode = () => props.syncMode;
  const setSyncMode = (m: SyncMode) => props.setSyncMode(m);
  // The reference button turns sync on / off and keeps the mode (layout or
  // global) for the next time it is on: the last mode is kept here.
  const [lastSyncMode, setLastSyncMode] = createSignal<"layout" | "global">(
    props.syncMode === "layout" || (props.syncMode === "none" && kv.getItem("ot:drawing-sync-last") === "layout") ? "layout" : "global",
  );
  const syncOnMode = () => (syncMode() === "none" ? lastSyncMode() : (syncMode() as "layout" | "global"));
  const pickSyncMode = (m: "layout" | "global") => {
    setLastSyncMode(m);
    kv.setItem("ot:drawing-sync-last", m);
    setSyncMode(m);
  };
  const toggleSync = () => {
    if (syncMode() === "none") pickSyncMode(lastSyncMode());
    else {
      pickSyncMode(syncOnMode());
      setSyncMode("none");
    }
  };
  const [syncMenuOpen, setSyncMenuOpen] = createSignal(false);
  // Hide and Lock dropdowns (Hide / Lock drawings, indicators, all).
  const [hideMenuOpen, setHideMenuOpen] = createSignal(false);
  const [lockMenuOpen, setLockMenuOpen] = createSignal(false);
  // Remove-objects dropdown (the trash split control).
  const [removeMenuOpen, setRemoveMenuOpen] = createSignal(false);
  // FontIconPicker — open on this tab when an Icon/Emoji/Sticker tool is picked.
  const [pickerTab, setPickerTab] = createSignal<FontIconTab | null>(null);
  // Magnet strength dropdown (Weak / Strong + Snap to indicator). The magnet
  // button is a split control: the icon toggles magnet, the caret opens this.
  const [magnetMenuOpen, setMagnetMenuOpen] = createSignal(false);
  // Right-click context menu on the toolbar background — its single item is the
  // "Show / Hide Favorite Drawing Tools Toolbar" toggle (inverse of the
  // favorites bar's own "Hide …" menu). Null when closed; else the {x,y} anchor.
  const [toolbarMenu, setToolbarMenu] = createSignal<{ x: number; y: number } | null>(null);
  let root!: HTMLElement;
  let toolbarMenuEl: HTMLDivElement | undefined;

  /** Lock or Hide split control. */
  const objectsGroup = (kind: "lock" | "hide") => {
    const mode = () => (kind === "lock" ? props.lockMode : props.hideMode);
    const st = () => (kind === "lock" ? props.locked : props.hidden);
    const on = () => modeOn(mode(), st());
    const open = () => (kind === "lock" ? lockMenuOpen() : hideMenuOpen());
    const setOpen = (v: boolean) => (kind === "lock" ? setLockMenuOpen(v) : setHideMenuOpen(v));
    const toggle = (m?: ObjectsMode) => (kind === "lock" ? props.onToggleLock(m) : props.onToggleHide(m));
    const spec = () => OBJECTS_MODES[kind][mode()];
    const menuTitle = kind === "lock" ? "Lock options" : "Hide options";
    return (
      <div class={"drawing-tool-group" + (open() ? " open" : "")}>
        <Tooltip text={spec().tooltip[on() ? 1 : 0]} hotkey={kind === "hide" ? "Ctrl + Alt + H" : undefined} side="right">
          <button
            type="button"
            class={"ot-toolbar-button drawing-tool-btn" + (on() ? " active" : "")}
            aria-label={spec().tooltip[on() ? 1 : 0]}
            aria-pressed={on()}
            data-name={kind === "lock" ? "lock-all" : "hide-all"}
            onClick={() => toggle()}
          >
            <span class="drawing-tool-icon">
              <Icon name={spec().icon[on() ? 1 : 0]} size={28} />
            </span>
          </button>
        </Tooltip>
        <Tooltip text={menuTitle} side="right">
          <button
            type="button"
            class="ot-toolbar-button drawing-tool-arrow"
            aria-label={menuTitle}
            aria-haspopup="menu"
            aria-expanded={open()}
            onClick={() => {
              const next = !open();
              setOpenGroup(null);
              setMagnetMenuOpen(false);
              setSyncMenuOpen(false);
              setRemoveMenuOpen(false);
              setHideMenuOpen(false);
              setLockMenuOpen(false);
              setOpen(next);
            }}
          >
            <svg viewBox="0 0 10 16" width="4" height="7" aria-hidden="true">
              <path d="M.6 1.4l1.4-1.4 8 8-8 8-1.4-1.4 6.389-6.532-6.389-6.668z" />
            </svg>
          </button>
        </Tooltip>
        <Show when={open()}>
          {/* The row of the button's mode is selected while that mode is on. */}
          <div class="ot-popover drawing-tool-submenu" role="menu" aria-label={menuTitle}>
            <For each={["drawings", "indicators", "all"] as const}>
              {(m) => (
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={mode() === m && on()}
                  class={"drawing-tool-submenu-item" + (mode() === m && on() ? " current" : "")}
                  onClick={() => {
                    setOpen(false);
                    toggle(m);
                  }}
                >
                  <span class="drawing-tool-submenu-label apply-overflow-tooltip">{OBJECTS_MODES[kind][m].label}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    );
  };

  function pickTool(toolId: string) {
    // Tools listed but not yet implemented arm nothing — bail
    // before touching selection so a stray favorites/hotkey path can't strand
    // the user on an inert tool. (The submenu rows are disabled too.)
    if (!isToolImplemented(toolId)) return;
    setSelectedTool(toolId);
    const tab = FONT_ICON_TOOLS[toolId];
    if (tab) {
      setPickerTab(tab);
      setOpenGroup(null);
      return;
    }
    // Cursor group: set the chart's interaction mode and arm NO drawing tool
    // (these aren't drawings — they change the pointer / enable erase + laser).
    const mode = CURSOR_TOOL_MODES[toolId];
    if (mode) {
      props.setCursorMode(mode);
      props.setArmedTool(null);
      return;
    }
    props.setArmedTool(toolId);
  }

  // Keep the rail's selected row in step with external armed-tool changes:
  // when a drawing tool clears (Escape, or placement without keep-drawing),
  // fall back to the active cursor mode's row. Cursor picks (which keep
  // armedTool null) are left untouched.
  createEffect(() => {
    const armed = props.armedTool;
    if (armed === null) {
      if (!(selectedTool() in CURSOR_TOOL_MODES)) {
        setSelectedTool(CURSOR_MODE_TOOL[props.cursorMode]);
      }
    } else if (armed !== selectedTool() && !(armed === "font-icon" && selectedTool() in FONT_ICON_TOOLS)) {
      // A glyph picked in the icon / emoji / sticker picker arms font-icon:
      // the picker's tool stays the selected one.
      setSelectedTool(armed);
    }
  });
  createEffect(() => setRailSelectedTool(selectedTool()));

  /** Promote a tool to its group's button (MRU), then arm it. Shared by the
   *  submenu picks and the favorites toolbar's `select-drawing-tool` event. */
  function selectTool(toolId: string) {
    track("drawing_tool_selected", { tool: toolId });
    for (const g of GROUPS) {
      if (groupTools(g).some((t) => t.id === toolId)) {
        setGroupDefault({ ...groupDefault(), [g.id]: toolId });
        break;
      }
    }
    pickTool(toolId);
  }

  function pickFromSubmenu(group: Group, tool: Tool) {
    setGroupDefault({ ...groupDefault(), [group.id]: tool.id });
    pickTool(tool.id);
    setOpenGroup(null);
  }

  onMount(() => {
    // Outside-click + Escape close the open submenu.
    const onMouseDown = (e: MouseEvent) => {
      if (root.contains(e.target as Node)) return;
      if (openGroup() !== null) setOpenGroup(null);
      if (magnetMenuOpen()) setMagnetMenuOpen(false);
      if (syncMenuOpen()) setSyncMenuOpen(false);
      if (hideMenuOpen()) setHideMenuOpen(false);
      if (removeMenuOpen()) setRemoveMenuOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (openGroup() !== null) setOpenGroup(null);
      if (magnetMenuOpen()) setMagnetMenuOpen(false);
      if (syncMenuOpen()) setSyncMenuOpen(false);
      if (hideMenuOpen()) setHideMenuOpen(false);
      if (removeMenuOpen()) setRemoveMenuOpen(false);
      if (toolbarMenu() !== null) setToolbarMenu(null);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onEsc);

    // Outside-click closes the toolbar context menu.
    const onMenuDown = (e: MouseEvent) => {
      if (toolbarMenu() && toolbarMenuEl && !toolbarMenuEl.contains(e.target as Node)) {
        setToolbarMenu(null);
      }
    };
    document.addEventListener("mousedown", onMenuDown);

    // The favorites toolbar drives tool selection through the SAME path via an
    // app event, so MRU-promotion + arming stays in one place.
    const offSelectTool = onAppEvent("select-drawing-tool", (d) => {
      const id = d?.toolId;
      if (id) selectTool(id);
    });

    // Hotkeys: Alt+T trendline, Alt+H/J/V/C horizontal line / ray, vertical
    // line, crossline, Alt+F fib retracement, Alt+Shift+R rectangle.
    const onHotkey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      // Require Alt; allow Shift selectively (e.g. Alt+Shift+R for rectangle).
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      let groupId: string | null = null;
      let toolId: string | null = null;
      if (e.code === "KeyT") {
        groupId = "trend";
        toolId = "trend-line";
      } else if (e.code === "KeyH") {
        groupId = "trend";
        toolId = "horizontal-line";
      } else if (e.code === "KeyJ") {
        groupId = "trend";
        toolId = "horizontal-ray";
      } else if (e.code === "KeyV") {
        groupId = "trend";
        toolId = "vertical-line";
      } else if (e.code === "KeyC") {
        groupId = "trend";
        toolId = "cross-line";
      } else if (e.code === "KeyF") {
        groupId = "gann-fib";
        toolId = "fib-retracement";
      } else if (e.code === "KeyR" && e.shiftKey) {
        groupId = "shapes";
        toolId = "rectangle";
      }
      if (!groupId || !toolId) return;
      e.preventDefault();
      setGroupDefault({ ...groupDefault(), [groupId]: toolId });
      // Alt+H / J / V / C create the line at once at the cursor (the pane
      // under the pointer handles it); Alt+T / F / Shift+R only arm the tool.
      // With the pointer outside every chart, the tool is armed instead.
      if (PLACE_NOW.has(toolId)) {
        const detail: PlaceAtCursorDetail = { kind: toolId as DrawingKind, handled: false };
        emitAppEvent(PLACE_AT_CURSOR_EVENT, detail);
        if (detail.handled) return;
      }
      pickTool(toolId);
    };
    document.addEventListener("keydown", onHotkey);

    // Ctrl+Alt+H: the Hide button (its mode).
    const onHideAllHotkey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.altKey && e.ctrlKey && !e.metaKey && e.code === "KeyH") {
        e.preventDefault();
        props.onToggleHide();
      }
    };
    document.addEventListener("keydown", onHideAllHotkey);

    onCleanup(() => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("mousedown", onMenuDown);
      document.removeEventListener("keydown", onEsc);
      document.removeEventListener("keydown", onHotkey);
      document.removeEventListener("keydown", onHideAllHotkey);
      offSelectTool();
    });
  });

  return (
    <aside
      class="drawing-toolbar"
      aria-label="Drawing tools"
      ref={root as HTMLElement}
      onContextMenu={(e) => {
        e.preventDefault();
        setOpenGroup(null);
        setToolbarMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <div class="drawing-toolbar-section">
        <For each={GROUPS}>
          {(group) => {
            const flatTools = () => groupTools(group);
            const defaultTool = () => {
              const tools = flatTools();
              return tools.find((t) => t.id === groupDefault()[group.id]) ?? tools[0];
            };
            const isSelected = () => selectedTool() === defaultTool()?.id;
            const isOpen = () => openGroup() === group.id;

            return (
              <Show when={flatTools().length > 0}>
                <div class={"drawing-tool-group" + (isOpen() ? " open" : "")}>
                  <Tooltip
                    text={defaultTool()!.title}
                    hotkey={TOOL_HINTS[defaultTool()!.id]?.hotkey}
                    hotkeyText={TOOL_HINTS[defaultTool()!.id]?.hotkeyText}
                    side="right"
                  >
                    <button
                      type="button"
                      class={
                        "ot-toolbar-button drawing-tool-btn" +
                        (isSelected() ? " selected" : "")
                      }
                      aria-label={defaultTool()!.title}
                      onClick={() => pickTool(defaultTool()!.id)}
                    >
                      <span class="drawing-tool-icon">
                        <Icon
                          name={defaultTool()!.iconName ?? group.defaultIcon}
                          size={28}
                        />
                      </span>
                    </button>
                  </Tooltip>
                  <Tooltip text={group.title} side="right">
                    <button
                      type="button"
                      class="ot-toolbar-button drawing-tool-arrow"
                      aria-label={group.title}
                      aria-haspopup="menu"
                      aria-expanded={isOpen()}
                      onClick={() => {
                        setMagnetMenuOpen(false);
                        setSyncMenuOpen(false);
                        setHideMenuOpen(false);
                        setRemoveMenuOpen(false);
                        setOpenGroup(isOpen() ? null : group.id);
                      }}
                    >
                      <svg viewBox="0 0 10 16" width="4" height="7" aria-hidden="true">
                        <path d="M.6 1.4l1.4-1.4 8 8-8 8-1.4-1.4 6.389-6.532-6.389-6.668z" />
                      </svg>
                    </button>
                  </Tooltip>
                  <Show when={isOpen()}>
                    <div
                      class="ot-popover drawing-tool-submenu"
                      role="menu"
                      aria-label={group.title}
                    >
                      <For each={group.sections}>
                        {(section, si) => (
                          <>
                            <Show when={si() > 0}>
                              <div class="drawing-tool-submenu-divider" role="separator" />
                            </Show>
                            <Show when={section.header}>
                              <div
                                class="drawing-tool-submenu-section-header"
                                role="presentation"
                              >
                                {section.header}
                              </div>
                            </Show>
                            <For each={section.tools}>
                              {(tool) => {
                                const isCurrent = () =>
                                  tool.id === groupDefault()[group.id];
                                const fav = () => isFavoriteTool(tool.id);
                                // Tools listed but not yet wired up render
                                // disabled (greyed) and can't be picked or
                                // favorited.
                                const impl = isToolImplemented(tool.id);
                                return (
                                  <div class="drawing-tool-submenu-row">
                                    <button
                                      type="button"
                                      role="menuitem"
                                      disabled={!impl}
                                      aria-disabled={!impl}
                                      title={impl ? undefined : `${tool.title} — coming soon`}
                                      class={
                                        "drawing-tool-submenu-item" +
                                        (isCurrent() ? " current" : "") +
                                        (impl ? "" : " disabled")
                                      }
                                      onClick={() => pickFromSubmenu(group, tool)}
                                    >
                                      <span class="drawing-tool-submenu-icon">
                                        <Icon
                                          name={tool.iconName ?? group.defaultIcon}
                                          size={28}
                                        />
                                      </span>
                                      <span class="drawing-tool-submenu-label apply-overflow-tooltip">
                                        {tool.title}
                                      </span>
                                      <Show when={tool.hotkey}>
                                        <span class="drawing-tool-submenu-hotkey">
                                          {tool.hotkey}
                                        </span>
                                      </Show>
                                    </button>
                                    {/* Favorite star —
                                     * `preset-menu-favorite-button`. Revealed on
                                     * row hover; stays filled once favorited.
                                     * Toggles toolbar membership without arming. */}
                                    <button
                                      type="button"
                                      disabled={!impl}
                                      class={
                                        "drawing-tool-submenu-fav" +
                                        (fav() ? " favorited" : "")
                                      }
                                      data-name="preset-menu-favorite-button"
                                      aria-label={fav() ? "Remove from favorites" : "Add to favorites"}
                                      aria-pressed={fav()}
                                      title={fav() ? "Remove from favorites" : "Add to favorites"}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        toggleFavoriteTool(tool.id);
                                      }}
                                    >
                                      {/* 5-point star, viewBox 0 0 18 18 — rendered
                                       * at its native 18×18 (the
                                       * preset-menu-favorite-button size). */}
                                      <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
                                        <path
                                          fill={fav() ? "currentColor" : "none"}
                                          stroke="currentColor"
                                          stroke-width="1.2"
                                          stroke-linejoin="round"
                                          d="M9 2.2l1.96 3.97 4.38.64-3.17 3.09.75 4.36L9 12.16l-3.92 2.06.75-4.36L2.66 6.81l4.38-.64z"
                                        />
                                      </svg>
                                    </button>
                                  </div>
                                );
                              }}
                            </For>
                          </>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              </Show>
            );
          }}
        </For>
      </div>

      {/* Measure + Zoom in (one section) */}
      <div class="drawing-toolbar-section">
        <Tooltip text="Measure" hotkey="Shift" hotkeyText="{0} + Click on the chart" side="right">
          <button
            type="button"
            class={
              "ot-toolbar-button drawing-tool-btn" +
              (props.armedTool === "measure" ? " selected" : "")
            }
            aria-label="Measure"
            onClick={() => pickTool("measure")}
          >
            <span class="drawing-tool-icon">
              <Icon name="draw-measure" size={28} />
            </span>
          </button>
        </Tooltip>
        <Tooltip text="Zoom in" side="right">
          <button
            type="button"
            class={
              "ot-toolbar-button drawing-tool-btn" +
              (props.armedTool === "zoom" ? " selected" : "")
            }
            aria-label="Zoom in"
            onClick={() => pickTool("zoom")}
          >
            <span class="drawing-tool-icon">
              <Icon name="draw-zoom" size={28} />
            </span>
          </button>
        </Tooltip>
      </div>

      {/* Toggles — Magnet / Keep drawing / Lock all / Hide all */}
      <div class="drawing-toolbar-section">
        {/* Magnet — split control: the icon toggles magnet on/off, the caret
         *  opens a Weak/Strong strength menu + a "Snap to indicator" checkbox. */}
        <div class={"drawing-tool-group" + (magnetMenuOpen() ? " open" : "")}>
          <Tooltip
            text="Magnet mode snaps drawings placed near price bars to the closest OHLC value"
            hotkey="Ctrl"
            side="right"
            width="narrow"
          >
            <button
              type="button"
              class={
                "ot-toolbar-button drawing-tool-btn" +
                (props.magnet ? " active" : "")
              }
              aria-label="Magnet mode"
              aria-pressed={props.magnet}
              onClick={() => props.setMagnet(!props.magnet)}
            >
              <span class="drawing-tool-icon">
                <Icon name={props.magnetMode === "weak" ? "draw-magnet-weak" : "draw-magnet-strong"} size={28} />
              </span>
            </button>
          </Tooltip>
          <Tooltip text="Magnets" side="right">
            <button
              type="button"
              class="ot-toolbar-button drawing-tool-arrow"
              aria-label="Magnets"
              aria-haspopup="menu"
              aria-expanded={magnetMenuOpen()}
              onClick={() => {
                setOpenGroup(null);
                setSyncMenuOpen(false);
                setHideMenuOpen(false);
                setRemoveMenuOpen(false);
                setLockMenuOpen(false);
                setMagnetMenuOpen(!magnetMenuOpen());
              }}
            >
              <svg viewBox="0 0 10 16" width="4" height="7" aria-hidden="true">
                <path d="M.6 1.4l1.4-1.4 8 8-8 8-1.4-1.4 6.389-6.532-6.389-6.668z" />
              </svg>
            </button>
          </Tooltip>
          <Show when={magnetMenuOpen()}>
            <div class="ot-popover drawing-tool-submenu" role="menu" aria-label="Magnets">
              {/* Strength rows (40 px, with their icon): the one in use is
               *  selected while the magnet is on; picking one turns it on. */}
              <For each={[["weak", "Weak magnet", "draw-magnet-weak"], ["strong", "Strong magnet", "draw-magnet-strong"]] as const}>
                {([id, label, icon]) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={props.magnet && props.magnetMode === id}
                    class={
                      "drawing-tool-submenu-item is-large" +
                      (props.magnet && props.magnetMode === id ? " current" : "")
                    }
                    onClick={() => {
                      props.setMagnetMode(id);
                      if (!props.magnet) props.setMagnet(true);
                      setMagnetMenuOpen(false);
                    }}
                  >
                    <span class="drawing-tool-submenu-icon">
                      <Icon name={icon} size={28} />
                    </span>
                    <span class="drawing-tool-submenu-label apply-overflow-tooltip">{label}</span>
                  </button>
                )}
              </For>
              <div class="drawing-tool-submenu-divider" role="separator" />
              {/* "Snap to indicators": a switch, the menu stays open; off
               *  while the magnet is off. */}
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={props.magnetSnapsToIndicators}
                disabled={!props.magnet}
                class="drawing-tool-submenu-item has-switch"
                onClick={() => props.setMagnetSnapsToIndicators(!props.magnetSnapsToIndicators)}
              >
                <span class="drawing-tool-submenu-label apply-overflow-tooltip">Snap to indicators</span>
                <span class={"ind3-switch" + (props.magnetSnapsToIndicators ? " is-on" : "")} aria-hidden="true">
                  <span class="ind3-switch-thumb" />
                </span>
              </button>
            </div>
          </Show>
        </div>
        <Tooltip text="Keep drawing" side="right">
          <button
            type="button"
            class={
              "ot-toolbar-button drawing-tool-btn" +
              (props.stayMode ? " active" : "")
            }
            aria-label="Keep drawing"
            aria-pressed={props.stayMode}
            onClick={() => props.setStayMode(!props.stayMode)}
          >
            <span class="drawing-tool-icon">
              <Icon name="draw-stay-mode" size={28} />
            </span>
          </button>
        </Tooltip>
        {/* Lock and Hide — split controls: the icon toggles the button's mode
         *  (icon and tooltip of the mode, pressed while on; Ctrl + Alt + H for
         *  Hide), the caret opens the drawings / indicators / all menu, whose
         *  row makes its mode the button's mode and toggles it. */}
        {objectsGroup("lock")}
        {objectsGroup("hide")}
        {/* Sync drawings — `drawingSyncMode-button`. The icon turns sync on /
         *  off (icon of the mode, pressed while on); the caret opens the
         *  Sync-in-layout / Sync-globally menu. App keys the drawings store
         *  by the mode (drawingKeyFor). */}
        <div class={"drawing-tool-group" + (syncMenuOpen() ? " open" : "")}>
          <Tooltip text={SYNC_TOOLTIPS[syncMode()]} side="right">
            <button
              type="button"
              class={"ot-toolbar-button drawing-tool-btn" + (syncMode() !== "none" ? " active" : "")}
              aria-label={SYNC_TOOLTIPS[syncMode()]}
              aria-pressed={syncMode() !== "none"}
              onClick={() => {
                setSyncMenuOpen(false);
                toggleSync();
              }}
            >
              <span class="drawing-tool-icon">
                <Icon name={syncOnMode() === "layout" ? "draw-sync-layout" : "draw-sync-global"} size={28} />
              </span>
            </button>
          </Tooltip>
          <Tooltip text="Sync drawings options" side="right">
            <button
              type="button"
              class="ot-toolbar-button drawing-tool-arrow"
              aria-label="Sync drawings options"
              aria-haspopup="menu"
              aria-expanded={syncMenuOpen()}
              onClick={() => {
                setOpenGroup(null);
                setMagnetMenuOpen(false);
                setHideMenuOpen(false);
                setRemoveMenuOpen(false);
                setLockMenuOpen(false);
                setSyncMenuOpen(!syncMenuOpen());
              }}
            >
              <svg viewBox="0 0 10 16" width="4" height="7" aria-hidden="true">
                <path d="M.6 1.4l1.4-1.4 8 8-8 8-1.4-1.4 6.389-6.532-6.389-6.668z" />
              </svg>
            </button>
          </Tooltip>
          <Show when={syncMenuOpen()}>
            <div class="ot-popover drawing-tool-submenu" role="menu" aria-label="Sync drawings options">
              {/* The two modes, with their icon; the mode in use is selected
               *  while sync is on; picking one turns sync on. */}
              <For each={["layout", "global"] as const}>
                {(id) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={syncMode() === id}
                    class={"drawing-tool-submenu-item" + (syncMode() === id ? " current" : "")}
                    onClick={() => {
                      pickSyncMode(id);
                      setSyncMenuOpen(false);
                    }}
                  >
                    <span class="drawing-tool-submenu-icon">
                      <Icon name={id === "layout" ? "draw-sync-layout" : "draw-sync-global"} size={28} />
                    </span>
                    <span class="drawing-tool-submenu-label apply-overflow-tooltip">{SYNC_LABELS[id]}</span>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>

      {/* Remove objects (standalone section) — split control: the icon clears
       *  drawings; the caret opens a menu to scope the removal (drawings /
       *  indicators / both). */}
      <div class="drawing-toolbar-section">
        <div class={"drawing-tool-group" + (removeMenuOpen() ? " open" : "")}>
          <Tooltip text="Remove objects" side="right">
            <button
              type="button"
              class="ot-toolbar-button drawing-tool-btn"
              aria-label="Remove objects"
              onClick={() => {
                setRemoveMenuOpen(false);
                props.onRemoveAll();
              }}
            >
              <span class="drawing-tool-icon">
                <Icon name="draw-trash" size={28} />
              </span>
            </button>
          </Tooltip>
          <Tooltip text="Remove options" side="right">
            <button
              type="button"
              class="ot-toolbar-button drawing-tool-arrow"
              aria-label="Remove options"
              aria-haspopup="menu"
              aria-expanded={removeMenuOpen()}
              onClick={() => {
                setOpenGroup(null);
                setMagnetMenuOpen(false);
                setSyncMenuOpen(false);
                setHideMenuOpen(false);
                setLockMenuOpen(false);
                setRemoveMenuOpen(!removeMenuOpen());
              }}
            >
              <svg viewBox="0 0 10 16" width="4" height="7" aria-hidden="true">
                <path d="M.6 1.4l1.4-1.4 8 8-8 8-1.4-1.4 6.389-6.532-6.389-6.668z" />
              </svg>
            </button>
          </Tooltip>
          <Show when={removeMenuOpen()}>
            <div class="ot-popover drawing-tool-submenu" role="menu" aria-label="Remove options">
              <button
                type="button"
                role="menuitem"
                class="drawing-tool-submenu-item"
                onClick={() => { setRemoveMenuOpen(false); props.onRemoveAll(); }}
              >
                <span class="drawing-tool-submenu-label apply-overflow-tooltip">Remove {plural(props.drawingCount, "drawing")}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                class="drawing-tool-submenu-item"
                onClick={() => { setRemoveMenuOpen(false); props.onRemoveIndicators(); }}
              >
                <span class="drawing-tool-submenu-label apply-overflow-tooltip">Remove {plural(props.indicatorCount, "indicator")}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                class="drawing-tool-submenu-item"
                onClick={() => { setRemoveMenuOpen(false); props.onRemoveAllObjects(); }}
              >
                <span class="drawing-tool-submenu-label apply-overflow-tooltip">
                  Remove {plural(props.drawingCount, "drawing")} &amp; {plural(props.indicatorCount, "indicator")}
                </span>
              </button>
              <div class="drawing-tool-submenu-divider" role="separator" />
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={props.alwaysRemoveLocked}
                class="drawing-tool-submenu-item has-switch"
                onClick={() => { setRemoveMenuOpen(false); props.onToggleAlwaysRemoveLocked(); }}
              >
                <span class="drawing-tool-submenu-label apply-overflow-tooltip">Always remove locked drawings</span>
                <span class={"ind3-switch" + (props.alwaysRemoveLocked ? " is-on" : "")} aria-hidden="true">
                  <span class="ind3-switch-thumb" />
                </span>
              </button>
            </div>
          </Show>
        </div>
      </div>

      {/* Flex spacer — pushes the favorites toggle to the very bottom of the
       *  rail; the toggle sits below Remove with a gap, not a separator. */}
      <div style={{ flex: "1 1 auto" }} />

      {/* Show / hide the floating favorite-drawing-tools toolbar (bottom of the
       *  rail). Mirrors the same `favoritesToolbarVisible` signal as the
       *  right-click menu and the bar's own "Hide …" item, so all three stay in
       *  sync. Active (blue) while the bar is shown. */}
      <div class="drawing-toolbar-section">
        {/* Static title, whatever the bar's state; the
         *  button's active state shows whether the bar is visible. */}
        <Tooltip text="Show Favorite Drawing Tools Toolbar" side="right">
          <button
            type="button"
            class={
              "ot-toolbar-button drawing-tool-btn drawing-fav-toggle" +
              (favoritesToolbarVisible() ? " active" : "")
            }
            aria-label="Show Favorite Drawing Tools Toolbar"
            aria-pressed={favoritesToolbarVisible()}
            onClick={() => setFavoritesToolbarVisible(!favoritesToolbarVisible())}
          >
            <span class="drawing-tool-icon">
              <Icon name="draw-show-favorite-drawing-tools-toolbar" size={28} />
            </span>
          </button>
        </Tooltip>
      </div>

      {/* Right-click context menu — the "Show / Hide Favorite Drawing Tools
       * Toolbar" toggle (the favorites bar's own "Hide …" lives in
       * FavoritesToolbar). */}
      <Show when={toolbarMenu()}>
        {(m) => (
          <div
            ref={toolbarMenuEl}
            class="ot-popover drawing-toolbar-context-menu"
            role="menu"
            style={{ position: "fixed", left: `${m().x}px`, top: `${m().y}px` }}
          >
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={favoritesToolbarVisible()}
              class="drawing-tool-submenu-item"
              onClick={() => {
                setFavoritesToolbarVisible(!favoritesToolbarVisible());
                setToolbarMenu(null);
              }}
            >
              <span class="drawing-tool-submenu-label">
                {favoritesToolbarVisible() ? "Hide" : "Show"} Favorite Drawing Tools Toolbar
              </span>
            </button>
          </div>
        )}
      </Show>

      {/* Font-Icons picker — docks against the toolbar's right edge. Picking a
       *  glyph stages it then arms the `font-icon` tool for the next click. */}
      <Show when={pickerTab()}>
        {(tab) => (
          <FontIconPicker
            initialTab={tab()}
            onClose={() => setPickerTab(null)}
            onPick={(glyph) => {
              props.setArmedGlyph(glyph);
              props.setArmedTool("font-icon");
            }}
          />
        )}
      </Show>
    </aside>
  );
}
