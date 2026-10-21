/*
 * Which dialogs, menus and panels of the window are open: the header
 * dropdown, the symbol search (plain, seeded by a typed key, compare mode),
 * the Change interval / Indicators / Chart settings / App settings / alert
 * dialogs, the indicator template name dialog, the right rail's page and the
 * OakScript drawer. Module-level signals (one App per window), so the shell,
 * its keyboard shortcuts and its window-event handlers open them the same way.
 */
import type { ChildStudyParent } from "../../data/app-events";
import { createSignal } from "solid-js";
import * as kv from "../../data/kv";
import type { OpenAlertDialogDetail } from "../../data/app-events";
import { screenerPanel } from "../../data/screener-store";
import type { AppSettingsTabId } from "../header/AppSettingsDialog";

// ── Header dropdown ──────────────────────────────────────────────────────
const [openMenu, setOpenMenu] = createSignal<string | null>(null);
const [anchorRect, setAnchorRect] = createSignal<DOMRect | null>(null);
export { openMenu, anchorRect };

export function openMenuAt(id: string, anchor: DOMRect): void {
  // Toggle: clicking the same opener twice closes it.
  if (openMenu() === id) {
    setOpenMenu(null);
    setAnchorRect(null);
  } else {
    setOpenMenu(id);
    setAnchorRect(anchor);
  }
}

export function closeMenu(): void {
  setOpenMenu(null);
  setAnchorRect(null);
}

// ── Symbol search ────────────────────────────────────────────────────────
const [symbolDialogOpen, setSymbolDialogOpen] = createSignal(false);
// When the dialog is opened by typing a character (rather than clicking the
// symbol pill), the query is seeded with that character. `null` = clicked open.
const [symbolSearchSeed, setSymbolSearchSeed] = createSignal<string | null>(null);
export { symbolDialogOpen, setSymbolDialogOpen, symbolSearchSeed, setSymbolSearchSeed };

/** Open the symbol search, seeded with a typed character or not (`null`). */
export function openSymbolSearch(seed: string | null): void {
  setSymbolSearchSeed(seed);
  setSymbolDialogOpen(true);
}

// Header "Compare symbols": the symbol search in its compare mode.
const [compareDialogOpen, setCompareDialogOpen] = createSignal(false);
// Legend title of a compared symbol ("Change symbol"): the symbol search
// replaces that entry's symbol.
const [compareTarget, setCompareTarget] = createSignal<{ tabId: string; paneIndex: number; id: string } | null>(null);
export { compareDialogOpen, setCompareDialogOpen, compareTarget, setCompareTarget };

// ── Dialogs ──────────────────────────────────────────────────────────────
// "Change interval" dialog (digit keys, legend interval click).
const [intervalDialog, setIntervalDialog] = createSignal<{ initVal: string; selectOnInit: boolean } | null>(null);
const [indicatorsDialogOpen, setIndicatorsDialogOpen] = createSignal(false);
/** The source the studies picked in the Indicators dialog are calculated on ("Add indicator/strategy on …"). */
const [indicatorsParent, setIndicatorsParent] = createSignal<ChildStudyParent | null>(null);
const [settingsDialogOpen, setSettingsDialogOpen] = createSignal(false);
// Tab the Settings dialog opens on (axis menus → "More settings…" = Scales).
const [settingsDialogTab, setSettingsDialogTab] = createSignal<string | undefined>();
// Create/Edit-alert modal: null = closed; object carries the prefill (symbol +
// clicked price for new, or editId to edit an existing rule).
const [alertDialog, setAlertDialog] = createSignal<null | OpenAlertDialogDetail>(null);
// App Settings modal. `null` = closed; otherwise the tab to open on.
const [appSettingsTab, setAppSettingsTab] = createSignal<AppSettingsTabId | null>(null);
// Indicator templates "Save indicator template…" name dialog.
const [templateNameDialogOpen, setTemplateNameDialogOpen] = createSignal(false);
export {
  intervalDialog,
  setIntervalDialog,
  indicatorsDialogOpen,
  indicatorsParent,
  setIndicatorsParent,
  setIndicatorsDialogOpen,
  settingsDialogOpen,
  setSettingsDialogOpen,
  settingsDialogTab,
  setSettingsDialogTab,
  alertDialog,
  setAlertDialog,
  appSettingsTab,
  setAppSettingsTab,
  templateNameDialogOpen,
  setTemplateNameDialogOpen,
};

// App onboarding (AppOnboarding.tsx): open once on the desktop app's first
// start, in the main window (kv ot:app-onboarding), then from the main menu.
const ONBOARDING_KEY = "ot:app-onboarding";
const [onboardingOpen, setOnboardingOpen] = createSignal(false);
export { onboardingOpen, setOnboardingOpen };

/** First start: open the onboarding and remember it was shown. */
export function openFirstStartOnboarding(): void {
  if (kv.getItem(ONBOARDING_KEY)) return;
  kv.setItem(ONBOARDING_KEY, "shown");
  setOnboardingOpen(true);
}

// ── Panels ───────────────────────────────────────────────────────────────
const [activeRailTab, setActiveRailTab] = createSignal<string | null>("base");
export { activeRailTab, setActiveRailTab };
// OakScript editor drawer (bottom of the chart pane). The right-rail script
// button toggles it — it never becomes the active rail tab (the button
// opens the drawer rather than a rail panel).
const [oakPanelOpen, setOakPanelOpenRaw] = createSignal(kv.getItem("ot:oakscript:panelOpen") === "1");
export { oakPanelOpen };
export const setOakPanelOpen = (open: boolean): void => {
  setOakPanelOpenRaw(open);
  kv.setItem("ot:oakscript:panelOpen", open ? "1" : "0");
};
/** A right-rail button: a page of the rail, or a toggle of the OakScript
 *  drawer / the screener split view. */
export const onRailTabSelect = (id: string | null): void => {
  if (id === "pine-dialog-button") {
    setOakPanelOpen(!oakPanelOpen());
    return;
  }
  // Screeners: toggles the stock screener split view (right of the layout).
  if (id === "screener-dialog-button") {
    screenerPanel.toggle();
    return;
  }
  setActiveRailTab(id);
};
