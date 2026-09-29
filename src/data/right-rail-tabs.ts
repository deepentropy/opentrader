/*
 * Right-rail tab inventory.
 *
 * The component that consumes it (window/right-rail/RightRailTabs.tsx) is
 * hand-maintained.
 */
import type { IconName } from '../components/Icon';

export type Tab = {
  id: string;
  label: string;
  iconName: IconName | null;
};

export const TOP_TABS: Tab[] = [
  {
    "id": "base",
    "label": "Watchlist, details, and news",
    "iconName": "rr-base"
  },
  {
    "id": "alerts",
    "label": "Alerts",
    "iconName": "rr-alerts"
  },
  {
    "id": "object_tree",
    "label": "Object tree and data window",
    "iconName": "rr-object_tree"
  },
  // NOTE: a "screener-dialog-button" (Screeners) tab belongs here, but
  // its icon asset (rr-screener-dialog-button.svg) hasn't been synced into
  // src/assets/icons yet and the rail renders icon-only buttons — add the tab
  // back once the icon lands.
  {
    // Script editor button — runs oakscriptjs (App.tsx intercepts this id to
    // toggle the bottom editor drawer instead of a rail panel).
    "id": "pine-dialog-button",
    "label": "OakScript Editor",
    "iconName": "rr-pine-dialog-button"
  },
  {
    "id": "calendar-dialog-button",
    "label": "Calendars",
    "iconName": "rr-calendar-dialog-button"
  }
];

export const BOTTOM_TABS: Tab[] = [
  {
    "id": "help-button",
    "label": "Help Center",
    "iconName": "rr-help-button"
  }
];

/** Tabs kept in the inventory above but not surfaced in this build.
 *  Their panels still exist — delete an id here to bring its button back. */
const HIDDEN_TABS = new Set(["calendar-dialog-button", "help-button"]);

export const VISIBLE_TOP_TABS: Tab[] = TOP_TABS.filter((t) => !HIDDEN_TABS.has(t.id));
export const VISIBLE_BOTTOM_TABS: Tab[] = BOTTOM_TABS.filter((t) => !HIDDEN_TABS.has(t.id));

export const INITIAL_RIGHT_RAIL_ACTIVE = "base";

/** Look up a tab by its id (data-name).  Returns undefined for unknown ids. */
export function findRightRailTab(id: string | null | undefined): Tab | undefined {
  if (!id) return undefined;
  return TOP_TABS.find((t) => t.id === id) || BOTTOM_TABS.find((t) => t.id === id);
}
