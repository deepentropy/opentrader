/*
 * AlertsPanel inventory.
 *
 * The component that consumes it (window/right-rail/AlertsPanel.tsx) is
 * hand-maintained.
 *
 * The Log entries are static sample data.  The Alerts (configured) view is
 * empty.
 */
import type { IconName } from '../components/Icon';

export type Tab = { id: 'alerts' | 'log'; label: string };
export type ToolbarItem = { dataName: string; label: string | null; iconName: IconName | null };
export type LogEntry = { message: string | null; ticker: string | null; logoUrl: string | null; time: string | null };

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

export const LOG: LogEntry[] = [
  {
    "message": "BW, 1D Crossing horizontal ray",
    "ticker": "BW, 1D",
    "logoUrl": null,
    "time": "16:27:59"
  },
  {
    "message": "Moving Average Ribbon (EMA, 9, EMA, 21, EMA, 50, EMA, 200) Crossing Price on INTC, 1",
    "ticker": "INTC, 1m",
    "logoUrl": null,
    "time": "16:01:28"
  },
  {
    "message": "Moving Average Ribbon (EMA, 9, EMA, 21, EMA, 50, EMA, 200) Crossing Price on AXTI, 1D",
    "ticker": "AXTI, 1D",
    "logoUrl": null,
    "time": "16:34:26"
  },
  {
    "message": "Moving Average Ribbon (EMA, 9, EMA, 21, EMA, 50, EMA, 200) Crossing Price on INTC, 1D",
    "ticker": "INTC, 1D",
    "logoUrl": null,
    "time": "15:40:47"
  },
  {
    "message": "ARM, 1h Crossing ray",
    "ticker": "ARM, 1h",
    "logoUrl": null,
    "time": "19:16:09"
  },
  {
    "message": "Moving Average Ribbon (EMA, 9, EMA, 21, EMA, 50, EMA, 200) Crossing Price on IREN, 1D",
    "ticker": "IREN, 1D",
    "logoUrl": null,
    "time": "15:31:00"
  },
  {
    "message": "Moving Average Ribbon (EMA, 9, EMA, 21, EMA, 50, EMA, 200) Crossing Price on AAOI, 4h",
    "ticker": "AAOI, 4h",
    "logoUrl": null,
    "time": "15:31:02"
  }
];
