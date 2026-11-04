/*
 * AlertsPanel inventory.
 *
 * The component that consumes it (window/right-rail/AlertsPanel.tsx) is
 * hand-maintained.
 *
 */
export type Tab = { id: 'alerts' | 'log'; label: string };

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
