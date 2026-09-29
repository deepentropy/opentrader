/*
 * HeaderToolbar inventory: section layout + per-item icon names / hotkeys /
 * labels.
 */
import type { IconName } from "../components/Icon";

export type Item = {
  id: string;
  label: string;
  text?: string;
  iconName?: IconName;
  hotkey?: string;
  /** Hotkey text template (see Tooltip `hotkeyText`). */
  hotkeyText?: string;
  /** Narrow button whose only content is a 16×8 dropdown-arrow icon. */
  chevron?: boolean;
  /** Wide non-icon item rendered as a placeholder (Symbol search). */
  widget?: boolean;
  /** Disabled (Redo, when there's nothing to redo). */
  disabled?: boolean;
  /** Indicator-template favorite — 20×20 round badge with the template's first letter. */
  template?: boolean;
};

export type Section = {
  sectionIndex: number;
  items: Item[];
};

/** Mapping from interval-shortcut slug ids to interval ids. */
export const SLUG_TO_INTERVAL: Record<string, string> = {
  "10-seconds": "10S",
  "1-minute": "1",
  "5-minutes": "5",
  "15-minutes": "15",
  "1-hour": "60",
  "4-hours": "240",
  "1-day": "1D",
  "1-week": "1W",
};

export const SECTIONS: Section[] = [
  {
    sectionIndex: 0,
    items: [
      { id: "symbol-search", label: "Symbol search", text: "INTC", widget: true },
      { id: "compare-symbols", label: "Compare symbols", iconName: "header-compare-symbols" },
    ],
  },
  {
    sectionIndex: 1,
    items: [
      { id: "10-seconds", label: "10 seconds", text: "10s" },
      { id: "1-minute", label: "1 minute", text: "1m" },
      { id: "5-minutes", label: "5 minutes", text: "5m" },
      { id: "15-minutes", label: "15 minutes", text: "15m" },
      { id: "1-hour", label: "1 hour", text: "1h" },
      { id: "4-hours", label: "4 hours", text: "4h" },
      { id: "1-day", label: "1 day", text: "D" },
      { id: "1-week", label: "1 week", text: "W" },
      { id: "chart-interval", label: "Chart interval", iconName: "header-chart-interval", hotkey: ",", hotkeyText: "Number or {0}", chevron: true },
    ],
  },
  {
    sectionIndex: 2,
    items: [{ id: "candles", label: "Candles", iconName: "header-candles" }],
  },
  {
    sectionIndex: 3,
    items: [
      { id: "open-indicators-dialog", label: "Indicators, metrics, and strategies", text: "Indicators", iconName: "header-indicators-metrics-and-strategies", hotkey: "/" },
      { id: "show-favorite-indicators", label: "Favorite indicators", iconName: "header-favorite-indicators", chevron: true },
      { id: "indicator-templates", label: "Indicator templates", iconName: "header-indicator-templates" },
      // Favourited indicator templates render here as live letter badges
      // (HeaderToolbar appends them after the indicator-templates button).
    ],
  },
  {
    sectionIndex: 4,
    items: [
      { id: "create-alert", label: "Create alert", text: "Alert", iconName: "header-create-alert", hotkey: "Alt+A" },
    ],
  },
  {
    sectionIndex: 5,
    items: [
      // Undo/Redo: live labels + enabled state come from the App (drawing
      // undo stack); these entries only carry the icons + hotkey hints.
      { id: "undo-toggle-maximized-pane-state", label: "Undo", iconName: "header-undo-toggle-maximized-pane-state", hotkey: "Ctrl+Z" },
      { id: "redo-toggle-maximized-pane-state", label: "Redo", iconName: "header-redo-toggle-maximized-pane-state", hotkey: "Ctrl+Y" },
      { id: "layout-setup", label: "Layout setup", iconName: "header-layout-setup" },
      { id: "all-changes-saved", label: "All changes saved", text: "DailySave" },
      { id: "save-load-menu", label: "Manage layouts", iconName: "header-manage-layouts", chevron: true },
    ],
  },
  {
    sectionIndex: 6,
    items: [
      { id: "header-toolbar-properties", label: "Settings", iconName: "header-settings" },
      { id: "header-toolbar-fullscreen", label: "Fullscreen mode", iconName: "header-fullscreen-mode", hotkey: "Shift+F" },
      { id: "take-a-snapshot", label: "Take a snapshot", iconName: "header-take-a-snapshot" },
    ],
  },
];
