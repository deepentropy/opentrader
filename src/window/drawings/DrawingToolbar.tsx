/*
 * DrawingToolbar — vertical strip on the left edge of the chart pane.
 *
 * Feature 5 scope: visual rail + submenus + tool-arm signal only. Actual
 * drawing creation, hit-testing, persistence, the bottom toggles
 * (Magnet / Stay-mode / Lock / Hide), Measure button, and Trash button all
 * land in Feature 5a/5b.
 *
 * Click model (per the live app):
 *   • Click the icon button → activate the group's current default tool.
 *   • Click the chevron arrow → open/close the submenu.
 * Click a submenu row → close the submenu, activate that tool, and promote
 * it to be the group's displayed default (TV's per-group MRU behaviour).
 */
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { TvIcon } from "../../components/TvIcon";
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
  toggleFavoriteTool,
} from "./favorite-tools";
import { FontIconPicker, type FontIconTab } from "./FontIconPicker";
import { findOverlaySpec } from "lightweight-charts-drawing/tv/specs";
import { PLACE_AT_CURSOR_EVENT, type PlaceAtCursorDetail } from "./DrawingsOverlay";
import type { DrawingKind } from "lightweight-charts-drawing/tv/types";

/** Hotkey tools that TV creates at once at the cursor (Alt+H/J/V/C), measured
 *  24/09/2026. */
const PLACE_NOW = new Set(["horizontal-line", "horizontal-ray", "vertical-line", "cross-line"]);

/** Main-button tooltip hotkey hints — TV `lineToolsInfo` `hotKey` (module
 *  771377, read 27/09/2026). NOT the tool-select hotkeys (Alt+T, Alt+F…):
 *  those show on the flyout rows only. The Shift gestures themselves live in
 *  lightweight-charts-drawing interact/shift. TV's LineToolGannSquare is the
 *  "Gann box" (OT gann-box). */
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
 *  region gesture. Several tools are listed for TradingView parity but have no
 *  implementation yet — those render disabled (greyed) in the submenu and arm
 *  nothing if reached by any other path. */
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
  /** Persistent Lock-all / Hide-all toggle modes (App-owned) — drive the
   *  buttons' active visual and stay on with zero drawings. `indicatorsHidden`
   *  backs the Hide-all dropdown's "Hide indicators" checkmark. */
  lockAllActive: boolean;
  hideAllActive: boolean;
  indicatorsHidden: boolean;
  onToggleLockAll: () => void;
  /** Hide-all dropdown actions: drawings only, indicators only, or both. The
   *  icon click defaults to "hide drawings" (`onToggleHideAll`). */
  onToggleHideAll: () => void;
  onToggleHideIndicators: () => void;
  onToggleHideBoth: () => void;
  /** Remove-objects dropdown actions: drawings only, indicators only, or both.
   *  Mirrors TV's `removeAllDrawingTools` split control. The icon click defaults
   *  to "remove drawings" (`onRemoveAll`). */
  onRemoveAll: () => void;
  onRemoveIndicators: () => void;
  onRemoveAllObjects: () => void;
  /** Counts in the Remove rows (TV "Remove 112 drawings & 8 indicators"):
   *  the active drawings and the active pane's indicators, the sets the
   *  rows remove. */
  drawingCount: number;
  indicatorCount: number;
  /** Drawing-sync scope (App-owned, persisted). Drives how the drawing store
   *  keys panes: none = per pane, layout = per tab/layout, global = by symbol. */
  syncMode: SyncMode;
  setSyncMode: (m: SyncMode) => void;
};

/** Drawing-sync scope — TV's `drawingSyncMode-button`. Controls how drawings are
 *  shared across the layout's panes: per pane / per layout / globally by symbol. */
export type SyncMode = "none" | "layout" | "global";
const SYNC_LABELS: Record<SyncMode, string> = {
  none: "No sync",
  layout: "New drawings sync in layout",
  global: "New drawings sync globally",
};
/** Sync button tooltip per mode — TV `drawingSyncMode-button` buttonTitle
 *  (module 871866, strings 173108 / 355519 / 734472). */
const SYNC_TOOLTIPS: Record<SyncMode, string> = {
  none: "New drawings will not be synced",
  layout: "New drawings are replicated to all charts in the layout and shown when the same ticker is selected",
  global: "New drawings are replicated to all charts in all layouts and shown when the same ticker is selected",
};

/** "1 drawing" / "112 drawings" (same rule as the chart menu Remove rows). */
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function DrawingToolbar(props: Props) {
  // Which tool each group displays on its toolbar button — TV's per-group
  // MRU behaviour. Pure UI state, stays local.
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
  const [syncMenuOpen, setSyncMenuOpen] = createSignal(false);
  // Hide-all dropdown (Hide drawings / indicators / both).
  const [hideMenuOpen, setHideMenuOpen] = createSignal(false);
  // Remove-objects dropdown (the trash split control).
  const [removeMenuOpen, setRemoveMenuOpen] = createSignal(false);
  // FontIconPicker — open on this tab when an Icon/Emoji/Sticker tool is picked.
  const [pickerTab, setPickerTab] = createSignal<FontIconTab | null>(null);
  // Magnet strength dropdown (Weak / Strong + Snap to indicator). TV's magnet
  // button is a split control: the icon toggles magnet, the caret opens this.
  const [magnetMenuOpen, setMagnetMenuOpen] = createSignal(false);
  // Right-click context menu on the toolbar background — its single item is the
  // "Show / Hide Favorite Drawing Tools Toolbar" toggle (inverse of the
  // favorites bar's own "Hide …" menu). Null when closed; else the {x,y} anchor.
  const [toolbarMenu, setToolbarMenu] = createSignal<{ x: number; y: number } | null>(null);
  let root!: HTMLElement;
  let toolbarMenuEl: HTMLDivElement | undefined;

  function pickTool(toolId: string) {
    // Tools listed for TV parity but not yet implemented arm nothing — bail
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
    } else if (armed !== selectedTool()) {
      setSelectedTool(armed);
    }
  });

  /** Promote a tool to its group's button (MRU), then arm it. Shared by the
   *  submenu picks and the favorites toolbar's `select-drawing-tool` event. */
  function selectTool(toolId: string) {
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

    // The favorites toolbar drives tool selection through the SAME path via a
    // window CustomEvent, so MRU-promotion + arming stays in one place.
    const onSelectTool = (e: Event) => {
      const id = (e as CustomEvent<{ toolId: string }>).detail?.toolId;
      if (id) selectTool(id);
    };
    window.addEventListener("select-drawing-tool", onSelectTool as EventListener);

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
      // TV: Alt+H / J / V / C create the line at once at the cursor (the pane
      // under the pointer handles it); Alt+T / F / Shift+R only arm the tool.
      // With the pointer outside every chart, the tool is armed instead.
      if (PLACE_NOW.has(toolId)) {
        const detail: PlaceAtCursorDetail = { kind: toolId as DrawingKind, handled: false };
        window.dispatchEvent(new CustomEvent(PLACE_AT_CURSOR_EVENT, { detail }));
        if (detail.handled) return;
      }
      pickTool(toolId);
    };
    document.addEventListener("keydown", onHotkey);

    // Ctrl+Alt+H toggles Hide-all-drawings, mirroring TV's hotkey.
    const onHideAllHotkey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.altKey && e.ctrlKey && !e.metaKey && e.code === "KeyH") {
        e.preventDefault();
        props.onToggleHideAll();
      }
    };
    document.addEventListener("keydown", onHideAllHotkey);

    onCleanup(() => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("mousedown", onMenuDown);
      document.removeEventListener("keydown", onEsc);
      document.removeEventListener("keydown", onHotkey);
      document.removeEventListener("keydown", onHideAllHotkey);
      window.removeEventListener("select-drawing-tool", onSelectTool as EventListener);
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
                        "tv-toolbar-button drawing-tool-btn" +
                        (isSelected() ? " selected" : "")
                      }
                      aria-label={defaultTool()!.title}
                      onClick={() => pickTool(defaultTool()!.id)}
                    >
                      <span class="drawing-tool-icon">
                        <TvIcon
                          name={defaultTool()!.iconName ?? group.defaultIcon}
                          size={28}
                        />
                      </span>
                    </button>
                  </Tooltip>
                  <Tooltip text={group.title} side="right">
                    <button
                      type="button"
                      class="tv-toolbar-button drawing-tool-arrow"
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
                      class="tv-popover drawing-tool-submenu"
                      role="menu"
                      aria-label={group.title}
                    >
                      <For each={group.sections}>
                        {(section) => (
                          <>
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
                                // Tools listed for TV parity but not yet wired up
                                // render disabled (greyed) and can't be picked or
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
                                        <TvIcon
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
                                    {/* Favorite star — TV's
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
                                      {/* 5-point star, captured viewBox 0 0 18 18 — rendered
                                       * at its native 18×18 to match TV Desktop's
                                       * preset-menu-favorite-button. */}
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

      {/* Measure + Zoom in (one section, matching TV's grouping) */}
      <div class="drawing-toolbar-section">
        <Tooltip text="Measure" hotkey="Shift" hotkeyText="{0} + Click on the chart" side="right">
          <button
            type="button"
            class={
              "tv-toolbar-button drawing-tool-btn" +
              (props.armedTool === "measure" ? " selected" : "")
            }
            aria-label="Measure"
            onClick={() => pickTool("measure")}
          >
            <span class="drawing-tool-icon">
              <TvIcon name="draw-measure" size={28} />
            </span>
          </button>
        </Tooltip>
        <Tooltip text="Zoom in" side="right">
          <button
            type="button"
            class={
              "tv-toolbar-button drawing-tool-btn" +
              (props.armedTool === "zoom" ? " selected" : "")
            }
            aria-label="Zoom in"
            onClick={() => pickTool("zoom")}
          >
            <span class="drawing-tool-icon">
              <TvIcon name="draw-zoom" size={28} />
            </span>
          </button>
        </Tooltip>
      </div>

      {/* Toggles — Magnet / Keep drawing / Lock all / Hide all */}
      <div class="drawing-toolbar-section">
        {/* Magnet — split control: the icon toggles magnet on/off, the caret
         *  opens a Weak/Strong strength menu + a "Snap to indicator" checkbox
         *  (mirrors TV's magnet button). */}
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
                "tv-toolbar-button drawing-tool-btn" +
                (props.magnet ? " active" : "")
              }
              aria-label="Magnet mode"
              aria-pressed={props.magnet}
              onClick={() => props.setMagnet(!props.magnet)}
            >
              <span class="drawing-tool-icon">
                <TvIcon name="draw-magnet" size={28} />
              </span>
            </button>
          </Tooltip>
          <Tooltip text="Magnets" side="right">
            <button
              type="button"
              class="tv-toolbar-button drawing-tool-arrow"
              aria-label="Magnets"
              aria-haspopup="menu"
              aria-expanded={magnetMenuOpen()}
              onClick={() => {
                setOpenGroup(null);
                setSyncMenuOpen(false);
                setHideMenuOpen(false);
                setRemoveMenuOpen(false);
                setMagnetMenuOpen(!magnetMenuOpen());
              }}
            >
              <svg viewBox="0 0 10 16" width="4" height="7" aria-hidden="true">
                <path d="M.6 1.4l1.4-1.4 8 8-8 8-1.4-1.4 6.389-6.532-6.389-6.668z" />
              </svg>
            </button>
          </Tooltip>
          <Show when={magnetMenuOpen()}>
            <div class="tv-popover drawing-tool-submenu" role="menu" aria-label="Magnets">
              <For each={[["weak", "Weak magnet"], ["strong", "Strong magnet"]] as const}>
                {([id, label]) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={props.magnetMode === id}
                    class={
                      "drawing-tool-submenu-item" +
                      (props.magnetMode === id ? " current" : "")
                    }
                    onClick={() => {
                      props.setMagnetMode(id);
                      // Picking a strength enables magnet (matches TV).
                      if (!props.magnet) props.setMagnet(true);
                      setMagnetMenuOpen(false);
                    }}
                  >
                    <span class="drawing-tool-submenu-icon">
                      <TvIcon name="draw-magnet" size={20} />
                    </span>
                    <span class="drawing-tool-submenu-label apply-overflow-tooltip">{label}</span>
                  </button>
                )}
              </For>
              {/* "Snap to indicators" — independent checkbox below the radios. */}
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={props.magnetSnapsToIndicators}
                class={
                  "drawing-tool-submenu-item" +
                  (props.magnetSnapsToIndicators ? " current" : "")
                }
                onClick={() => props.setMagnetSnapsToIndicators(!props.magnetSnapsToIndicators)}
              >
                <span class="drawing-tool-submenu-icon">
                  <TvIcon name="draw-magnet" size={20} />
                </span>
                <span class="drawing-tool-submenu-label apply-overflow-tooltip">Snap to indicators</span>
              </button>
            </div>
          </Show>
        </div>
        <Tooltip text="Keep drawing" side="right">
          <button
            type="button"
            class={
              "tv-toolbar-button drawing-tool-btn" +
              (props.stayMode ? " active" : "")
            }
            aria-label="Keep drawing"
            aria-pressed={props.stayMode}
            onClick={() => props.setStayMode(!props.stayMode)}
          >
            <span class="drawing-tool-icon">
              <TvIcon name="draw-stay-mode" size={28} />
            </span>
          </button>
        </Tooltip>
        <Tooltip text="Lock all drawings" side="right">
          <button
            type="button"
            class={
              "tv-toolbar-button drawing-tool-btn" +
              (props.lockAllActive ? " active" : "")
            }
            aria-label="Lock all drawings"
            aria-pressed={props.lockAllActive}
            onClick={props.onToggleLockAll}
          >
            <span class="drawing-tool-icon">
              <TvIcon name="draw-lock" size={28} />
            </span>
          </button>
        </Tooltip>
        {/* Hide all — split control (TV's `hide-all` dropdown): the icon toggles
         *  Hide-all-drawings (Ctrl+Alt+H), the caret opens a scope menu mirroring
         *  the Remove control (drawings / indicators / both). All three are
         *  persistent toggles, so they stay meaningful with zero drawings. */}
        <div class={"drawing-tool-group" + (hideMenuOpen() ? " open" : "")}>
          <Tooltip text="Hide all drawings" hotkey="Ctrl + Alt + H" side="right">
            <button
              type="button"
              class={
                "tv-toolbar-button drawing-tool-btn" +
                (props.hideAllActive ? " active" : "")
              }
              aria-label="Hide all drawings"
              aria-pressed={props.hideAllActive}
              onClick={props.onToggleHideAll}
            >
              <span class="drawing-tool-icon">
                <TvIcon name="draw-hide" size={28} />
              </span>
            </button>
          </Tooltip>
          <Tooltip text="Hide options" side="right">
            <button
              type="button"
              class="tv-toolbar-button drawing-tool-arrow"
              aria-label="Hide options"
              aria-haspopup="menu"
              aria-expanded={hideMenuOpen()}
              onClick={() => {
                setOpenGroup(null);
                setMagnetMenuOpen(false);
                setSyncMenuOpen(false);
                setRemoveMenuOpen(false);
                setHideMenuOpen(!hideMenuOpen());
              }}
            >
              <svg viewBox="0 0 10 16" width="4" height="7" aria-hidden="true">
                <path d="M.6 1.4l1.4-1.4 8 8-8 8-1.4-1.4 6.389-6.532-6.389-6.668z" />
              </svg>
            </button>
          </Tooltip>
          <Show when={hideMenuOpen()}>
            <div class="tv-popover drawing-tool-submenu" role="menu" aria-label="Hide options">
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={props.hideAllActive}
                class={"drawing-tool-submenu-item" + (props.hideAllActive ? " current" : "")}
                onClick={() => { setHideMenuOpen(false); props.onToggleHideAll(); }}
              >
                <span class="drawing-tool-submenu-icon">
                  <TvIcon name="draw-hide" size={20} />
                </span>
                <span class="drawing-tool-submenu-label apply-overflow-tooltip">Hide drawings</span>
              </button>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={props.indicatorsHidden}
                class={"drawing-tool-submenu-item" + (props.indicatorsHidden ? " current" : "")}
                onClick={() => { setHideMenuOpen(false); props.onToggleHideIndicators(); }}
              >
                <span class="drawing-tool-submenu-icon">
                  <TvIcon name="draw-hide" size={20} />
                </span>
                <span class="drawing-tool-submenu-label apply-overflow-tooltip">Hide indicators</span>
              </button>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={props.hideAllActive && props.indicatorsHidden}
                class={"drawing-tool-submenu-item" + (props.hideAllActive && props.indicatorsHidden ? " current" : "")}
                onClick={() => { setHideMenuOpen(false); props.onToggleHideBoth(); }}
              >
                <span class="drawing-tool-submenu-icon">
                  <TvIcon name="draw-hide" size={20} />
                </span>
                <span class="drawing-tool-submenu-label apply-overflow-tooltip">Hide all</span>
              </button>
            </div>
          </Show>
        </div>
        {/* Sync drawings — TV's `drawingSyncMode-button`. A pure dropdown: both
         *  the icon and the caret open the No-sync / Sync-in-layout / Sync-
         *  globally menu. Single-chart app, so the choice is persisted for
         *  parity but has no cross-chart effect yet. */}
        <div class={"drawing-tool-group" + (syncMenuOpen() ? " open" : "")}>
          <Tooltip text={SYNC_TOOLTIPS[syncMode()]} side="right">
            <button
              type="button"
              class="tv-toolbar-button drawing-tool-btn"
              aria-label={SYNC_TOOLTIPS[syncMode()]}
              aria-haspopup="menu"
              aria-expanded={syncMenuOpen()}
              onClick={() => {
                setOpenGroup(null);
                setMagnetMenuOpen(false);
                setHideMenuOpen(false);
                setRemoveMenuOpen(false);
                setSyncMenuOpen(!syncMenuOpen());
              }}
            >
              <span class="drawing-tool-icon">
                <TvIcon name="draw-drawingSyncMode-button" size={28} />
              </span>
            </button>
          </Tooltip>
          <Tooltip text="Sync drawings options" side="right">
            <button
              type="button"
              class="tv-toolbar-button drawing-tool-arrow"
              aria-label="Sync drawings options"
              aria-haspopup="menu"
              aria-expanded={syncMenuOpen()}
              onClick={() => {
                setOpenGroup(null);
                setMagnetMenuOpen(false);
                setHideMenuOpen(false);
                setRemoveMenuOpen(false);
                setSyncMenuOpen(!syncMenuOpen());
              }}
            >
              <svg viewBox="0 0 10 16" width="4" height="7" aria-hidden="true">
                <path d="M.6 1.4l1.4-1.4 8 8-8 8-1.4-1.4 6.389-6.532-6.389-6.668z" />
              </svg>
            </button>
          </Tooltip>
          <Show when={syncMenuOpen()}>
            <div class="tv-popover drawing-tool-submenu" role="menu" aria-label="Sync drawings options">
              <For each={["none", "layout", "global"] as const}>
                {(id) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={syncMode() === id}
                    class={"drawing-tool-submenu-item" + (syncMode() === id ? " current" : "")}
                    onClick={() => {
                      setSyncMode(id);
                      setSyncMenuOpen(false);
                    }}
                  >
                    {/* No leading glyph (TV shows none); the selected row carries
                     *  a checkmark in the icon slot, the rest leave it empty. */}
                    <span class="drawing-tool-submenu-icon">
                      <Show when={syncMode() === id}>
                        <TvIcon name="dt-cm-sync-globally" size={16} />
                      </Show>
                    </span>
                    <span class="drawing-tool-submenu-label apply-overflow-tooltip">{SYNC_LABELS[id]}</span>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>

      {/* Remove objects (standalone section) — TV's `removeAllDrawingTools`
       *  split control: the icon clears drawings; the caret opens a menu to
       *  scope the removal (drawings / indicators / both). */}
      <div class="drawing-toolbar-section">
        <div class={"drawing-tool-group" + (removeMenuOpen() ? " open" : "")}>
          <Tooltip text="Remove objects" side="right">
            <button
              type="button"
              class="tv-toolbar-button drawing-tool-btn"
              aria-label="Remove objects"
              onClick={() => {
                setRemoveMenuOpen(false);
                props.onRemoveAll();
              }}
            >
              <span class="drawing-tool-icon">
                <TvIcon name="draw-trash" size={28} />
              </span>
            </button>
          </Tooltip>
          <Tooltip text="Remove options" side="right">
            <button
              type="button"
              class="tv-toolbar-button drawing-tool-arrow"
              aria-label="Remove options"
              aria-haspopup="menu"
              aria-expanded={removeMenuOpen()}
              onClick={() => {
                setOpenGroup(null);
                setMagnetMenuOpen(false);
                setSyncMenuOpen(false);
                setHideMenuOpen(false);
                setRemoveMenuOpen(!removeMenuOpen());
              }}
            >
              <svg viewBox="0 0 10 16" width="4" height="7" aria-hidden="true">
                <path d="M.6 1.4l1.4-1.4 8 8-8 8-1.4-1.4 6.389-6.532-6.389-6.668z" />
              </svg>
            </button>
          </Tooltip>
          <Show when={removeMenuOpen()}>
            <div class="tv-popover drawing-tool-submenu" role="menu" aria-label="Remove options">
              <button
                type="button"
                role="menuitem"
                class="drawing-tool-submenu-item"
                onClick={() => { setRemoveMenuOpen(false); props.onRemoveAll(); }}
              >
                <span class="drawing-tool-submenu-icon">
                  <TvIcon name="draw-trash" size={20} />
                </span>
                <span class="drawing-tool-submenu-label apply-overflow-tooltip">Remove {plural(props.drawingCount, "drawing")}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                class="drawing-tool-submenu-item"
                onClick={() => { setRemoveMenuOpen(false); props.onRemoveIndicators(); }}
              >
                <span class="drawing-tool-submenu-icon">
                  <TvIcon name="draw-trash" size={20} />
                </span>
                <span class="drawing-tool-submenu-label apply-overflow-tooltip">Remove {plural(props.indicatorCount, "indicator")}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                class="drawing-tool-submenu-item"
                onClick={() => { setRemoveMenuOpen(false); props.onRemoveAllObjects(); }}
              >
                <span class="drawing-tool-submenu-icon">
                  <TvIcon name="draw-trash" size={20} />
                </span>
                <span class="drawing-tool-submenu-label apply-overflow-tooltip">
                  Remove {plural(props.drawingCount, "drawing")} &amp; {plural(props.indicatorCount, "indicator")}
                </span>
              </button>
            </div>
          </Show>
        </div>
      </div>

      {/* Flex spacer — pushes the favorites toggle to the very bottom of the
       *  rail (TV's `fill-BfVZxb4b`); the toggle sits below Remove with a gap,
       *  not a separator. */}
      <div style={{ flex: "1 1 auto" }} />

      {/* Show / hide the floating favorite-drawing-tools toolbar (bottom of the
       *  rail — TV's `lastGroup`). Mirrors the same `favoritesToolbarVisible`
       *  signal as the right-click menu and the bar's own "Hide …" item, so all
       *  three stay in sync. Active (blue) while the bar is shown. */}
      <div class="drawing-toolbar-section">
        {/* TV: static title (871866 `bt`), whatever the bar's state; the
         *  button's active state shows whether the bar is visible. */}
        <Tooltip text="Show Favorite Drawing Tools Toolbar" side="right">
          <button
            type="button"
            class={
              "tv-toolbar-button drawing-tool-btn drawing-fav-toggle" +
              (favoritesToolbarVisible() ? " active" : "")
            }
            aria-label="Show Favorite Drawing Tools Toolbar"
            aria-pressed={favoritesToolbarVisible()}
            onClick={() => setFavoritesToolbarVisible(!favoritesToolbarVisible())}
          >
            <span class="drawing-tool-icon">
              <TvIcon name="draw-show-favorite-drawing-tools-toolbar" size={28} />
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
            class="tv-popover drawing-toolbar-context-menu"
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
