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
    "label": "Watchlist and details",
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
  {
    // Stock screener: opens as a right split-view panel (App.tsx toggles it
    // instead of making it the active rail tab).
    "id": "screener-dialog-button",
    "label": "Screeners",
    "iconName": "rr-screener-dialog-button"
  },
  {
    // Script editor button — runs oakscriptjs (App.tsx intercepts this id to
    // toggle the bottom editor drawer instead of a rail panel).
    "id": "pine-dialog-button",
    "label": "OakScript Editor",
    "iconName": "rr-pine-dialog-button"
  }
];

export const INITIAL_RIGHT_RAIL_ACTIVE = "base";
