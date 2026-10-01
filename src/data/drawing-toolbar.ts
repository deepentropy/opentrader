/*
 * Drawing-toolbar inventory — the tool groups.
 *
 * Group assignments are deliberate (e.g. Arrow lives in Geometric Shapes, not
 * Annotation; Pitchforks live in Trend, not Gann). Each tool's `iconName` is
 * `draw-<slug>` matching the SVG filename under `src/assets/icons/`.
 */
import type { IconName } from "../components/Icon";

export type Tool = {
  id: string;
  title: string;
  /** Per-tool icon; falls back to the group's defaultIcon when missing. */
  iconName?: IconName;
  /** Optional keyboard hint shown right-aligned in the submenu row. */
  hotkey?: string;
};

/** Submenus are divided into named subcategories ("Lines / Channels /
 *  Pitchforks", "Fibonacci / Gann", …). A null header means the group has
 *  no internal sections (e.g. Cursors). */
export type Section = {
  header: string | null;
  tools: Tool[];
};

export type Group = {
  id: string;
  title: string;
  /** Icon shown on the toolbar button when no per-tool icon has been promoted. */
  defaultIcon: IconName;
  sections: Section[];
};

export const GROUPS: Group[] = [
  {
    id: "cursor",
    title: "Cursors",
    defaultIcon: "draw-cursor",
    sections: [
      {
        header: null,
        tools: [
          { id: "cross", title: "Cross", iconName: "draw-cursor" },
          { id: "dot", title: "Dot", iconName: "draw-dot" },
          { id: "arrow-cursor", title: "Arrow", iconName: "draw-arrow" },
          { id: "demonstration", title: "Demonstration", iconName: "draw-demonstration" },
          { id: "eraser", title: "Eraser", iconName: "draw-eraser" },
        ],
      },
    ],
  },
  {
    id: "trend",
    title: "Trend tools",
    defaultIcon: "draw-trend-line",
    sections: [
      {
        header: "Lines",
        tools: [
          { id: "trend-line", title: "Trendline", iconName: "draw-trend-line", hotkey: "Alt + T" },
          { id: "ray", title: "Ray", iconName: "draw-ray" },
          { id: "info-line", title: "Info line", iconName: "draw-info-line" },
          { id: "extended-line", title: "Extended line", iconName: "draw-extended-line" },
          { id: "trend-angle", title: "Trend angle", iconName: "draw-trend-angle" },
          { id: "horizontal-line", title: "Horizontal line", iconName: "draw-horizontal-line", hotkey: "Alt + H" },
          { id: "horizontal-ray", title: "Horizontal ray", iconName: "draw-horizontal-ray", hotkey: "Alt + J" },
          { id: "vertical-line", title: "Vertical line", iconName: "draw-vertical-line", hotkey: "Alt + V" },
          { id: "cross-line", title: "Crossline", iconName: "draw-cross-line", hotkey: "Alt + C" },
        ],
      },
      {
        header: "Channels",
        tools: [
          { id: "parallel-channel", title: "Parallel channel", iconName: "draw-parallel-channel" },
          { id: "regression-trend", title: "Regression trend", iconName: "draw-regression-trend" },
          { id: "flat-top-bottom", title: "Flat top/bottom", iconName: "draw-flat-top-bottom" },
          { id: "disjoint-channel", title: "Disjoint channel", iconName: "draw-disjoint-channel" },
        ],
      },
      {
        header: "Pitchforks",
        tools: [
          { id: "pitchfork", title: "Pitchfork", iconName: "draw-pitchfork" },
          { id: "schiff-pitchfork", title: "Schiff pitchfork", iconName: "draw-schiff-pitchfork" },
          { id: "modified-schiff-pitchfork", title: "Modified Schiff pitchfork", iconName: "draw-modified-schiff-pitchfork" },
          { id: "inside-pitchfork", title: "Inside pitchfork", iconName: "draw-inside-pitchfork" },
        ],
      },
    ],
  },
  {
    id: "gann-fib",
    title: "Gann and Fibonacci tools",
    defaultIcon: "draw-fib",
    sections: [
      {
        header: "Fibonacci",
        tools: [
          { id: "fib-retracement", title: "Fib retracement", iconName: "draw-fib", hotkey: "Alt + F" },
          { id: "trend-based-fib-extension", title: "Trend-based fib extension", iconName: "draw-trend-based-fib-extension" },
          { id: "fib-channel", title: "Fib channel", iconName: "draw-fib-channel" },
          { id: "fib-time-zone", title: "Fib time zone", iconName: "draw-fib-time-zone" },
          { id: "fib-speed-resistance-fan", title: "Fib speed resistance fan", iconName: "draw-fib-speed-resistance-fan" },
          { id: "trend-based-fib-time", title: "Trend-based fib time", iconName: "draw-trend-based-fib-time" },
          { id: "fib-circles", title: "Fib circles", iconName: "draw-fib-circles" },
          { id: "fib-spiral", title: "Fib spiral", iconName: "draw-fib-spiral" },
          { id: "fib-speed-resistance-arcs", title: "Fib speed resistance arcs", iconName: "draw-fib-speed-resistance-arcs" },
          { id: "fib-wedge", title: "Fib wedge", iconName: "draw-fib-wedge" },
          { id: "pitchfan", title: "Pitchfan", iconName: "draw-pitchfan" },
        ],
      },
      {
        header: "Gann",
        tools: [
          { id: "gann-box", title: "Gann box", iconName: "draw-gann-box" },
          { id: "gann-square-fixed", title: "Gann square fixed", iconName: "draw-gann-square-fixed" },
          { id: "gann-square", title: "Gann square", iconName: "draw-gann-square" },
          { id: "gann-fan", title: "Gann fan", iconName: "draw-gann-fan" },
        ],
      },
    ],
  },
  {
    id: "patterns",
    title: "Patterns",
    defaultIcon: "draw-pattern",
    sections: [
      {
        header: "Chart patterns",
        tools: [
          { id: "xabcd-pattern", title: "XABCD pattern", iconName: "draw-pattern" },
          { id: "cypher-pattern", title: "Cypher pattern", iconName: "draw-cypher-pattern" },
          { id: "head-and-shoulders", title: "Head and shoulders", iconName: "draw-head-and-shoulders" },
          { id: "abcd-pattern", title: "ABCD pattern", iconName: "draw-abcd-pattern" },
          { id: "triangle-pattern", title: "Triangle pattern", iconName: "draw-triangle-pattern" },
          { id: "three-drives-pattern", title: "Three drives pattern", iconName: "draw-three-drives-pattern" },
        ],
      },
      {
        header: "Elliott waves",
        tools: [
          { id: "elliott-impulse", title: "Elliott impulse wave (1·2·3·4·5)", iconName: "draw-elliott-impulse-wave-1-2-3-4-5" },
          { id: "elliott-correction", title: "Elliott correction wave (A·B·C)", iconName: "draw-elliott-correction-wave-a-b-c" },
          { id: "elliott-triangle", title: "Elliott triangle wave (A·B·C·D·E)", iconName: "draw-elliott-triangle-wave-a-b-c-d-e" },
          { id: "elliott-double-combo", title: "Elliott double combo wave (W·X·Y)", iconName: "draw-elliott-double-combo-wave-w-x-y" },
          { id: "elliott-triple-combo", title: "Elliott triple combo wave (W·X·Y·X·Z)", iconName: "draw-elliott-triple-combo-wave-w-x-y-x-z" },
        ],
      },
      {
        header: "Cycles",
        tools: [
          { id: "cyclic-lines", title: "Cyclic lines", iconName: "draw-cyclic-lines" },
          { id: "time-cycles", title: "Time cycles", iconName: "draw-time-cycles" },
          { id: "sine-line", title: "Sine line", iconName: "draw-sine-line" },
        ],
      },
    ],
  },
  {
    id: "forecasting",
    title: "Forecasting and measurement tools",
    defaultIcon: "draw-position",
    sections: [
      {
        header: "Forecasting",
        tools: [
          { id: "long-position", title: "Long position", iconName: "draw-position" },
          { id: "short-position", title: "Short position", iconName: "draw-short-position" },
          { id: "position-forecast", title: "Position forecast", iconName: "draw-position-forecast" },
          { id: "bar-pattern", title: "Bars pattern", iconName: "draw-bar-pattern" },
          { id: "ghost-feed", title: "Ghost feed", iconName: "draw-ghost-feed" },
          { id: "sector", title: "Sector", iconName: "draw-sector" },
        ],
      },
      {
        header: "Volume-based",
        tools: [
          { id: "anchored-vwap", title: "Anchored VWAP", iconName: "draw-anchored-vwap" },
          { id: "fixed-range-volume-profile", title: "Fixed range volume profile", iconName: "draw-fixed-range-volume-profile" },
          { id: "anchored-volume-profile", title: "Anchored volume profile", iconName: "draw-anchored-volume-profile" },
        ],
      },
      {
        header: "Measurers",
        tools: [
          { id: "price-range", title: "Price range", iconName: "draw-price-range" },
          { id: "date-range", title: "Date range", iconName: "draw-date-range" },
          { id: "date-and-price-range", title: "Date and price range", iconName: "draw-date-and-price-range" },
        ],
      },
    ],
  },
  {
    id: "shapes",
    title: "Geometric shapes",
    defaultIcon: "draw-brush",
    sections: [
      {
        header: "Brushes",
        tools: [
          { id: "brush", title: "Brush", iconName: "draw-brush" },
          { id: "highlighter", title: "Highlighter", iconName: "draw-highlighter" },
        ],
      },
      {
        header: "Arrows",
        tools: [
          { id: "arrow-marker", title: "Arrow marker", iconName: "draw-arrow-marker" },
          { id: "arrow", title: "Arrow", iconName: "draw-arrow" },
          { id: "arrow-mark-up", title: "Arrow mark up", iconName: "draw-arrow-mark-up" },
          { id: "arrow-mark-down", title: "Arrow mark down", iconName: "draw-arrow-mark-down" },
        ],
      },
      {
        header: "Shapes",
        tools: [
          { id: "rectangle", title: "Rectangle", iconName: "draw-rectangle", hotkey: "Alt + Shift + R" },
          { id: "rotated-rectangle", title: "Rotated rectangle", iconName: "draw-rotated-rectangle" },
          { id: "path", title: "Path", iconName: "draw-path" },
          { id: "circle", title: "Circle", iconName: "draw-circle" },
          { id: "ellipse", title: "Ellipse", iconName: "draw-ellipse" },
          { id: "polyline", title: "Polyline", iconName: "draw-polyline" },
          { id: "triangle", title: "Triangle", iconName: "draw-triangle" },
          { id: "arc", title: "Arc", iconName: "draw-arc" },
          { id: "curve", title: "Curve", iconName: "draw-curve" },
          { id: "double-curve", title: "Double curve", iconName: "draw-double-curve" },
        ],
      },
    ],
  },
  {
    id: "annotation",
    title: "Annotation tools",
    defaultIcon: "draw-text",
    sections: [
      {
        header: "Text and notes",
        tools: [
          { id: "text", title: "Text", iconName: "draw-text" },
          { id: "note", title: "Note", iconName: "draw-note" },
          { id: "price-note", title: "Price note", iconName: "draw-price-note" },
          { id: "pin", title: "Pin", iconName: "draw-pin" },
          { id: "table", title: "Table", iconName: "draw-table" },
          { id: "callout", title: "Callout", iconName: "draw-callout" },
          { id: "comment", title: "Comment", iconName: "draw-comment" },
          { id: "price-label", title: "Price label", iconName: "draw-price-label" },
          { id: "signpost", title: "Signpost", iconName: "draw-signpost" },
          { id: "flag-mark", title: "Flag mark", iconName: "draw-flag-mark" },
        ],
      },
      {
        header: "Content",
        tools: [
          // Image only: the Post and Idea tools publish to an online
          // community, which this app does not have.
          { id: "image", title: "Image", iconName: "draw-image" },
        ],
      },
    ],
  },
  {
    id: "font-icons",
    title: "Icons",
    defaultIcon: "draw-font-icon",
    sections: [
      {
        header: null,
        tools: [
          { id: "icon", title: "Icon", iconName: "draw-font-icon" },
          { id: "emoji", title: "Emoji" },
          { id: "sticker", title: "Sticker" },
        ],
      },
    ],
  },
];

/** Chart interaction mode set by the Cursor group. These five tools don't
 *  place a drawing — they change the pointer / enable erase + laser-demo
 *  behaviour in the overlay. `cross` is the default. */
export type CursorMode = "cross" | "dot" | "arrow" | "eraser" | "demonstration";

/** Cursor-group tool id → interaction mode. Picking one of these sets the
 *  chart's cursor mode and arms NO drawing tool. */
export const CURSOR_TOOL_MODES: Record<string, CursorMode> = {
  cross: "cross",
  dot: "dot",
  "arrow-cursor": "arrow",
  eraser: "eraser",
  demonstration: "demonstration",
};

/** Reverse of CURSOR_TOOL_MODES — interaction mode → its toolbar tool id, so
 *  the Cursor group can show the active mode's row as selected even though no
 *  drawing tool is armed. */
export const CURSOR_MODE_TOOL: Record<CursorMode, string> = {
  cross: "cross",
  dot: "dot",
  arrow: "arrow-cursor",
  eraser: "eraser",
  demonstration: "demonstration",
};

/** Flatten sections into a single tools list — used for groupDefault init
 *  and for hotkey scans. Defensive against malformed groups (HMR can leave
 *  the renderer and data temporarily out of sync). */
export function groupTools(group: Group): Tool[] {
  if (!group || !Array.isArray(group.sections)) return [];
  return group.sections.flatMap((s) =>
    s && Array.isArray(s.tools) ? s.tools : [],
  );
}
