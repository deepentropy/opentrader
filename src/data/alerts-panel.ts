/*
 * AlertsPanel inventory.
 *
 * The component that consumes it (window/right-rail/AlertsPanel.tsx) is
 * hand-maintained.
 *
 */
import type { IconName } from '../components/Icon';

export type Tab = { id: 'alerts' | 'log'; label: string };
export type ToolbarItem = { dataName: string; label: string | null; iconName: IconName | null };

export const TABS: Tab[] = [
  {
    "id": "alerts",
    "label": "Alerts"
  },
  {
    "id": "log",
    "label": "Log"
  }
];

export const TOOLBAR: ToolbarItem[] = [
  {
    "dataName": "clear-log-button",
    "label": "Clear log",
    "iconName": "al-clear-log"
  },
  {
    "dataName": "alerts-log-actions-button",
    "label": "Options",
    "iconName": "al-alerts-log-actions"
  },
  {
    "dataName": "alerts-dropdown-filters-count",
    "label": null,
    "iconName": null
  }
];
