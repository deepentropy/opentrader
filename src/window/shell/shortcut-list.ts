/*
 * The Keyboard shortcuts panel's list (#335): every shortcut the app answers,
 * by section. Keep it in step with the handlers: keyboard-shortcuts.ts (most of
 * them), DrawingToolbar.tsx (drawing tools), BottomBar.tsx (Alt + G, Alt + Enter),
 * the watchlist rows and the script editor.
 */

/** One way to type it: the keys pressed together ("Ctrl", "T"), or a text
 *  such as "Any letter key". */
export type Combo = { keys: string[] } | { text: string };

export type Shortcut = {
  label: string;
  /** Ways to type it, shown with "or" between them. */
  combos: Combo[];
  /** Shown in the row's info tooltip. */
  note?: string;
  /** Desktop app only (windows, app zoom, Exit). */
  desktop?: boolean;
};

export type ShortcutSection = { id: string; title: string; icon: string; items: Shortcut[] };

const k = (...keys: string[]): Combo => ({ keys });

export const SHORTCUT_SECTIONS: ShortcutSection[] = [
  {
    id: "chart",
    title: "Chart",
    icon: "header-candles",
    items: [
      { label: "Change symbol", combos: [{ text: "Any letter key" }], note: "Type a symbol to open the symbol search with it." },
      { label: "Change interval", combos: [{ text: "Any number key" }, k(",")], note: "Type a number of minutes, or open the interval menu." },
      { label: "Load chart layout", combos: [k(".")] },
      { label: "Save chart layout", combos: [k("Ctrl", "S")] },
      { label: "Switch between sessions", combos: [k("Alt", "Shift", "E")], note: "Intraday charts: regular and extended hours." },
      { label: "Move chart 1 bar to the left", combos: [k("←")] },
      { label: "Move chart 1 bar to the right", combos: [k("→")] },
      { label: "Move chart further to the left", combos: [k("Ctrl", "←")] },
      { label: "Move chart further to the right", combos: [k("Ctrl", "→")] },
      { label: "Zoom in", combos: [k("Ctrl", "↑")] },
      { label: "Zoom out", combos: [k("Ctrl", "↓")] },
      { label: "Scroll to the most recent bar", combos: [k("Alt", "Shift", "→")] },
      { label: "Scroll to the first bar", combos: [k("Alt", "Shift", "←")] },
      { label: "Reset chart view", combos: [k("Alt", "R")] },
      { label: "Reset time scale", combos: [k("Ctrl", "Alt", "Q")] },
      { label: "Invert scale", combos: [k("Alt", "I")] },
      { label: "Logarithmic scale", combos: [k("Alt", "L")] },
      { label: "Percent scale", combos: [k("Alt", "P")] },
      { label: "Go to date", combos: [k("Alt", "G")] },
      { label: "Maximize chart", combos: [k("Alt", "Enter")] },
      { label: "Next chart", combos: [k("Tab"), k("Shift", "→")], note: "Layouts of several charts." },
      { label: "Previous chart", combos: [k("Shift", "Tab"), k("Shift", "←")], note: "Layouts of several charts." },
      { label: "Fullscreen mode", combos: [k("Shift", "F")] },
      { label: "Open data window", combos: [k("Alt", "D")] },
      { label: "Download chart image", combos: [k("Ctrl", "Alt", "S")] },
      { label: "Copy chart image", combos: [k("Ctrl", "Shift", "S")] },
      { label: "Undo", combos: [k("Ctrl", "Z")] },
      { label: "Redo", combos: [k("Ctrl", "Y"), k("Ctrl", "Shift", "Z")] },
    ],
  },
  {
    id: "indicators-drawings",
    title: "Indicators and drawings",
    icon: "header-indicators-metrics-and-strategies",
    items: [
      { label: "Open indicators", combos: [k("/")] },
      { label: "Trend line", combos: [k("Alt", "T")] },
      { label: "Horizontal line", combos: [k("Alt", "H")] },
      { label: "Horizontal ray", combos: [k("Alt", "J")] },
      { label: "Vertical line", combos: [k("Alt", "V")] },
      { label: "Cross line", combos: [k("Alt", "C")] },
      { label: "Fib retracement", combos: [k("Alt", "F")] },
      { label: "Rectangle", combos: [k("Alt", "Shift", "R")] },
      { label: "Hide all drawings", combos: [k("Ctrl", "Alt", "H")] },
      { label: "Move the selected drawing", combos: [k("←"), k("↑"), k("→"), k("↓")] },
      { label: "Delete the selected drawing", combos: [k("Delete"), k("Backspace")] },
      { label: "Draw at angles of 45°", combos: [k("Shift")], note: "Hold it while drawing a line." },
    ],
  },
  {
    id: "watchlist",
    title: "Watchlist",
    icon: "wl-watchlists",
    items: [
      { label: "Next symbol", combos: [k("Space")] },
      { label: "Previous symbol", combos: [k("Shift", "Space")] },
      { label: "Add symbol to watchlist", combos: [k("Alt", "W")] },
      { label: "Open list", combos: [k("Shift", "W")] },
    ],
  },
  {
    id: "trading",
    title: "Trading",
    icon: "trade-connect-broker",
    items: [
      { label: "Buy", combos: [k("Shift", "B"), k("Alt", "Shift", "B")], note: "In Bar Replay: opens the order ticket." },
      { label: "Sell", combos: [k("Shift", "S"), k("Alt", "Shift", "S")], note: "In Bar Replay: opens the order ticket." },
      { label: "Order ticket", combos: [k("Shift", "T")], note: "In Bar Replay." },
      { label: "Depth of market", combos: [k("Shift", "D")], note: "In Bar Replay." },
    ],
  },
  {
    id: "alerts",
    title: "Alerts",
    icon: "header-create-alert",
    items: [{ label: "Add alert", combos: [k("Alt", "A")] }],
  },
  {
    id: "script-editor",
    title: "Script editor",
    icon: "oak-editor-logo",
    items: [{ label: "Save script", combos: [k("Ctrl", "S")] }],
  },
  {
    id: "app",
    title: "Tabs and windows",
    icon: "tab-new-window",
    items: [
      { label: "New tab", combos: [k("Ctrl", "T")] },
      { label: "New window", combos: [k("Ctrl", "N")], desktop: true },
      { label: "Reopen closed tab", combos: [k("Ctrl", "Shift", "T")] },
      { label: "Close tab", combos: [k("Ctrl", "W"), k("Ctrl", "F4")] },
      { label: "Duplicate tab", combos: [k("Ctrl", "U")] },
      { label: "Reload tab", combos: [k("Ctrl", "R"), k("F5")] },
      { label: "Next tab", combos: [k("Ctrl", "Tab"), k("Ctrl", "Page Down")] },
      { label: "Previous tab", combos: [k("Ctrl", "Shift", "Tab"), k("Ctrl", "Page Up")] },
      { label: "Go to tab 1 to 8", combos: [k("Ctrl", "1…8")] },
      { label: "Go to the last tab", combos: [k("Ctrl", "9")] },
      { label: "Settings", combos: [k("Ctrl", ",")] },
      { label: "Keyboard shortcuts", combos: [k("Ctrl", "/")] },
      { label: "Zoom in the app", combos: [k("Ctrl", "=")], desktop: true },
      { label: "Zoom out the app", combos: [k("Ctrl", "-")], desktop: true },
      { label: "Reset the app zoom", combos: [k("Ctrl", "0")], desktop: true },
      { label: "Exit OpenTrader", combos: [k("Ctrl", "Shift", "Q")], desktop: true },
    ],
  },
];
