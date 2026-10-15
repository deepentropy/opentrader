/*
 * Per-kind tables of the drawing Settings dialog: which pages a tool has,
 * its Style rows in display order, its Text / Coordinates families, and the
 * option lists of the selects.
 */
import type { DrawingStyle, LevelDef } from "lightweight-charts-drawing/core/types";
import { FIB_CIRCLE_LEVEL_DEFAULTS, FIB_LEVEL_DEFAULTS, FIB_TIMEZONE_LEVEL_DEFAULTS, FIB_WEDGE_LEVEL_DEFAULTS, GANN_BOX_LEVEL_DEFAULTS, GANN_FAN_LEVEL_DEFAULTS, PARALLEL_CHANNEL_LEVEL_DEFAULTS, PITCHFAN_LEVEL_DEFAULTS, PITCHFORK_LEVEL_DEFAULTS, SPEED_ARC_LEVEL_DEFAULTS, SPEED_FAN_LEVEL_DEFAULTS, TREND_FIB_TIME_LEVEL_DEFAULTS, VWAP_BAND_DEFAULTS } from "lightweight-charts-drawing/core/specs";
import { HIGHLIGHTER_WIDTHS } from "../DrawingStylePopovers";

export const TABS = ["Style", "Text", "Coordinates", "Visibility"] as const;
/** Page order: Inputs (tools with study-like inputs), Style, Text,
 *  Coordinates, Visibility. */
export type Tab = (typeof TABS)[number] | "Inputs";
export const INPUTS_KINDS = new Set<string>(["ghost-feed", "regression-trend", "long-position", "short-position", "anchored-vwap", "fixed-range-volume-profile", "anchored-volume-profile"]);
/** Tools whose dialog has no Style page (Text is their first page). */
export const NO_STYLE_KINDS = new Set<string>(["text", "callout", "comment"]);
/** Tools whose dialog has no Coordinates page (no editable coordinates): path
 *  and polyline (tabs Style + Visibility), bars pattern. */
export const NO_COORDINATES_KINDS = new Set<string>([
  "path", "polyline", "bar-pattern",
  // Dialog tabs per tool
  "fib-wedge", "brush", "highlighter", "rotated-rectangle", "ellipse", "arc", "font-icon",
  "flat-top-bottom", "disjoint-channel", "long-position", "short-position", "anchored-vwap", "text",
  "sector",
  // Table / image: Style + Visibility.
  "table", "image",
]);

/** Font size list of the reference drawing dialogs. */
export const FONT_SIZES = ["10", "11", "12", "14", "16", "20", "24", "28", "32", "40"];
/** A size list with the current value added when the list lacks it (the
 *  floating toolbar offers other sizes, e.g. 8 or 22). */
export function sizeOptions(list: readonly string[], value: string): string[] {
  return list.includes(value) ? [...list] : [...list, value].sort((a, b) => parseFloat(a) - parseFloat(b));
}
/** Style page rows per tool, in display order. Row ids are rendered by
 *  SettingsDialog `styleRow`; "id:Title" ids carry the row title. */
export const LINE_TOOL_ROWS = ["line+ends:Line", "extend", "middlePoint", "priceLabel:Price labels", "stats"];
export const PITCHFORK_ROWS = ["pitchforkExtend", "line:Median", "levels", "pitchforkStyle"];
export const STYLE_ROWS: Record<string, string[]> = {
  "trend-line": LINE_TOOL_ROWS,
  ray: LINE_TOOL_ROWS,
  "info-line": LINE_TOOL_ROWS,
  "extended-line": LINE_TOOL_ROWS,
  arrow: LINE_TOOL_ROWS,
  "trend-angle": ["line:Line", "extend", "middlePoint", "priceLabel:Price labels", "stats"],
  "horizontal-line": ["line:Line", "priceLabel:Price label"],
  "horizontal-ray": ["line:Line", "priceLabel:Price label"],
  "vertical-line": ["line:Line", "vlineExtend", "timeLabel"],
  "cross-line": ["line:Line", "priceLabel:Price label", "timeLabel"],
  "parallel-channel": ["levels", "extend", "background"],
  "regression-trend": ["regressionLines", "regressionExtend", "pearsons"],
  "flat-top-bottom": ["line+ends:Line", "extend", "channelPrices", "background"],
  "disjoint-channel": ["line+ends:Line", "extend", "channelPrices", "background"],
  pitchfork: PITCHFORK_ROWS,
  "schiff-pitchfork": PITCHFORK_ROWS,
  "modified-schiff-pitchfork": PITCHFORK_ROWS,
  "inside-pitchfork": PITCHFORK_ROWS,
  "fib-retracement": ["fibTrendLine", "levels", "reverse", "fibLabels", "fibLog"],
  "trend-based-fib-extension": ["fibTrendLine", "levels", "reverse", "fibLabels", "fibLog"],
  "fib-channel": ["levels", "fibChannelLabels"],
  "fib-time-zone": ["levels", "ftzLabels"],
  "fib-speed-resistance-fan": ["speedFan"],
  "trend-based-fib-time": ["fibTrendLine", "levels", "ftzLabels"],
  "fib-circles": ["fibTrendLine", "levels", "showCoeffs", "coeffsAsPercents"],
  "fib-spiral": ["line:Line", "counterclockwise"],
  "fib-speed-resistance-arcs": ["fibTrendLine", "levels", "showCoeffs", "fullCircles"],
  "fib-wedge": ["fibTrendLine", "levels", "showCoeffs"],
  pitchfan: ["line:Median", "levels"],
  "gann-box": ["gannBox"],
  "gann-square-fixed": ["gannSquare"],
  "gann-square": ["gannSquare"],
  "gann-fan": ["levels", "labels"],
  "xabcd-pattern": ["patternLabel", "lineNoStyle:Border", "background"],
  "cypher-pattern": ["patternLabel", "lineNoStyle:Border", "background"],
  "head-and-shoulders": ["patternLabel", "lineNoStyle:Border", "background"],
  "abcd-pattern": ["patternLabel", "lineNoStyle:Border"],
  "triangle-pattern": ["patternLabel", "lineNoStyle:Border", "background"],
  "three-drives-pattern": ["patternLabel", "lineNoStyle:Border"],
  "elliott-impulse": ["color:Color", "wave", "degree"],
  "elliott-correction": ["color:Color", "wave", "degree"],
  "elliott-triangle": ["color:Color", "wave", "degree"],
  "elliott-double-combo": ["color:Color", "wave", "degree"],
  "elliott-triple-combo": ["color:Color", "wave", "degree"],
  "cyclic-lines": ["line:Lines"],
  "time-cycles": ["line:Line", "background"],
  "sine-line": ["line:Lines"],
  "long-position": ["position"],
  "short-position": ["position"],
  "position-forecast": ["lineNoStyle:Line", "forecastColors"],
  "bar-pattern": ["color:Color", "barPattern"],
  "ghost-feed": ["ghostFeed"],
  sector: ["sector"],
  "anchored-vwap": ["lineNoStyle:VWAP", "vwapBands"],
  // Volume profiles: the reference VbP study Style tab (Inputs page below).
  "fixed-range-volume-profile": ["vpStyle"],
  "anchored-volume-profile": ["vpStyle"],
  // Range tools "Line": colour + width (no line style; the lines are solid).
  "price-range": ["lineNoStyle:Line", "background", "rangeExtend", "rangeStats", "rangeLabel"],
  "date-range": ["lineNoStyle:Line", "background", "rangeExtend", "rangeStats", "rangeLabel"],
  "date-and-price-range": ["lineNoStyle:Line", "rangeBorder", "background", "rangeStats", "rangeLabel"],
  // Brush: no line style (the reference brush has none; drawn solid).
  brush: ["line+endsNoStyle:Line", "background"],
  highlighter: ["color:Line", "thickness"],
  "arrow-marker": ["color:Color"],
  "arrow-mark-up": ["color:Arrow"],
  "arrow-mark-down": ["color:Arrow"],
  rectangle: ["extend", "line:Border", "rectMiddleLine", "background"],
  "rotated-rectangle": ["line:Border", "background"],
  path: ["line+ends:Line"],
  circle: ["line:Border", "background"],
  ellipse: ["line:Border", "background"],
  polyline: ["lineNoStyle:Border", "background"],
  triangle: ["line:Border", "background"],
  arc: ["line:Border", "background"],
  curve: ["line+ends:Line", "extend", "background"],
  "double-curve": ["line+ends:Line", "extend", "background"],
  note: ["noteLabel"],
  "price-note": ["priceNote"],
  pin: ["color:Label"],
  table: ["table"],
  "price-label": ["priceLabelTool"],
  signpost: ["emojiPin"],
  "flag-mark": ["color:Flag"],
  image: ["image"],
  "font-icon": ["color:Color"],
};
export const styleRowsFor = (kind: string): string[] => STYLE_ROWS[kind] ?? ["line:Line"];
/** Extend list titles per tool. */
export const EXTEND_TITLES: Record<string, [string, string]> = {
  rectangle: ["Extend left", "Extend right"],
  "fib-channel": ["Extend left", "Extend right"],
  "fib-retracement": ["Extend lines left", "Extend lines right"],
  "trend-based-fib-extension": ["Extend lines left", "Extend lines right"],
};
/** Pitchfork styles and the OpenTrader kind of each. */
export const PITCHFORK_STYLES: [string, string][] = [["pitchfork", "Original"], ["schiff-pitchfork", "Schiff"], ["modified-schiff-pitchfork", "Modified Schiff"], ["inside-pitchfork", "Inside"]];
/** Text tools with Background / Border rows on the Text page. */
export const TEXT_BOX_KINDS = new Set<string>(["text", "callout", "comment", "pin"]);
/** Factory background transparency when a drawing has none stored (text
 *  rgba(41,98,255,0.25), callout 50, comment / pin 0). */
export const TEXT_BOX_TRANSPARENCY: Record<string, number> = { text: 75, callout: 50, comment: 0, pin: 0 };
/** Factory border colours (text #707070, comment ot-blue-500, pin
 *  cold-gray-700). */
export const TEXT_BORDER_DEFAULT: Record<string, string> = { text: "#707070", comment: "#2962ff", pin: "#4a4a4a" };
/** Coordinates row titles: "#N (price)", "#N (bar)", else price and bar. */
export const COORD_MODES: Record<string, "price" | "bar" | "price, bar" | "vertical position %, bar"> = {
  signpost: "vertical position %, bar",
  "horizontal-line": "price",
  "vertical-line": "bar",
  "regression-trend": "bar",
  // Volume profiles are built from the points' bars only ("#N (bar)").
  "fixed-range-volume-profile": "bar",
  "anchored-volume-profile": "bar",
};
/** Highlighter thickness options (px), the floating toolbar's list. */
export const HIGHLIGHTER_PX = HIGHLIGHTER_WIDTHS.map((w) => `${w}px`);


// Which line-family kinds expose each toggle group (different fields per
// tool). Gated so a rectangle/fib/etc. doesn't sprout line-only options.
// NOTE: the trendline Style tab has no arrowhead checkboxes — the
// leftEnd/rightEnd style fields stay render-supported and reachable via
// templates, but the rows are gone.
export const EXTEND_KINDS = new Set<string>([
  "trend-line", "ray", "extended-line", "info-line",
  // Fib level tools: the extend flags stretch the level span to the pane edges
  // (default off).
  "fib-retracement", "trend-based-fib-extension", "fib-channel",
  // Bézier curves: the extend flags continue the curve parametrically.
  "curve", "double-curve",
]);

// Kinds with a per-level model (Settings → Levels grid) and their factory sets.
export const LEVEL_KIND_DEFAULTS: Record<string, LevelDef[]> = {
  "fib-retracement": FIB_LEVEL_DEFAULTS,
  "trend-based-fib-extension": FIB_LEVEL_DEFAULTS,
  "fib-channel": FIB_LEVEL_DEFAULTS,
  "fib-time-zone": FIB_TIMEZONE_LEVEL_DEFAULTS,
  "trend-based-fib-time": TREND_FIB_TIME_LEVEL_DEFAULTS,
  "gann-fan": GANN_FAN_LEVEL_DEFAULTS,
  pitchfork: PITCHFORK_LEVEL_DEFAULTS,
  "schiff-pitchfork": PITCHFORK_LEVEL_DEFAULTS,
  "modified-schiff-pitchfork": PITCHFORK_LEVEL_DEFAULTS,
  "inside-pitchfork": PITCHFORK_LEVEL_DEFAULTS,
  pitchfan: PITCHFAN_LEVEL_DEFAULTS,
  "gann-box": GANN_BOX_LEVEL_DEFAULTS,
  "parallel-channel": PARALLEL_CHANNEL_LEVEL_DEFAULTS,
  "fib-circles": FIB_CIRCLE_LEVEL_DEFAULTS,
  "fib-wedge": FIB_WEDGE_LEVEL_DEFAULTS,
  "fib-speed-resistance-fan": SPEED_FAN_LEVEL_DEFAULTS,
  "fib-speed-resistance-arcs": SPEED_ARC_LEVEL_DEFAULTS,
  // Anchored VWAP: the ±σ band ladder (coeff = multiplier) rides the same
  // grid — "Upper/Lower Band #1..#3" line rows with a checkbox,
  // colour + width per band.
  "anchored-vwap": VWAP_BAND_DEFAULTS,
};

/** Anchored VWAP source select (available price sources). */
export const VWAP_SOURCES = ["open", "high", "low", "close", "hl2", "hlc3", "ohlc4", "hlcc4"] as const;
/** Price source option texts of the selects (regression trend, anchored
 *  VWAP). */
export const PRICE_SOURCE_LABELS: Record<(typeof VWAP_SOURCES)[number], string> = {
  open: "Open",
  high: "High",
  low: "Low",
  close: "Close",
  hl2: "(H + L)/2",
  hlc3: "(H + L + C)/3",
  ohlc4: "(O + H + L + C)/4",
  hlcc4: "(H + L + C + C)/4",
};
/** Position QTY precision select: values and texts. */
export const QTY_PRECISION_OPTIONS: { value: string; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "0", label: "Integer" },
  ...Array.from({ length: 10 }, (_, k) => ({ value: String(k + 1), label: k === 0 ? "1 decimal" : `${k + 1} decimals` })),
];
/** Level grid with value + colour, two per line, and a "Levels line"
 *  row (width + style of every level). */
export const LEVEL_FRAGMENT_KINDS = new Set<string>(["fib-retracement", "trend-based-fib-extension", "fib-channel", "gann-box"]);
export const LEVELS_LINE_KINDS = new Set<string>(["fib-retracement", "trend-based-fib-extension", "fib-channel"]);
// Position tools: risk inputs driving the Qty readout (accountSize/risk).
export const POSITION_KINDS = new Set<string>(["long-position", "short-position"]);
/** Bars pattern modes, in option order (labels: HL bars, OC bars,
 *  Line - close / open / high / low / HL/2). */
export const BAR_PATTERN_MODE_VALUES = ["bars", "oc", "line", "line-open", "line-high", "line-low", "line-hl2"] as const;
export const BAR_PATTERN_MODE_LABELS = ["HL bars", "OC bars", "Line - close", "Line - open", "Line - high", "Line - low", "Line - HL/2"] as const;
/** Stats position options (value = index). */
export const STATS_POSITIONS = ["Left", "Center", "Right", "Auto"] as const;
// Line-family kinds that carry an on-line label (text stored on `style.text`).
// Includes the axis-line family + arrow-marker (all expose a Text tab whose
// string renders on/next to the line).
/** Vertical text alignment each renderer uses when the style has none
 *  (factory): horizontal line / vertical line middle, horizontal ray top,
 *  trend lines and channels bottom. */
/** The vertical alignment is named by where the text sits: the stored
 *  `bottom` (box above the point) shows as "Top", `top` as "Bottom" (trend
 *  line, price note, rectangle, horizontal / vertical line). */
export const VERT_ALIGN_TITLE: Record<string, string> = { top: "Bottom", middle: "Middle", bottom: "Top" };
export function vertAlignFromTitle(t: string): "top" | "middle" | "bottom" {
  return t === "Top" ? "bottom" : t === "Bottom" ? "top" : "middle";
}
/** The rectangle calls the middle "Inside" (rectangle alignment items). */
export function vertTitle(v: string, kind: string): string {
  return v === "middle" && kind === "rectangle" ? "Inside" : VERT_ALIGN_TITLE[v];
}

export function labelVertDefault(kind: string): string {
  return kind === "horizontal-line" || kind === "vertical-line" || kind === "rectangle" ? "middle" : kind === "horizontal-ray" ? "top" : "bottom";
}

export const LINE_LABEL_KINDS = new Set<string>([
  "trend-line", "ray", "extended-line", "info-line",
  "horizontal-line", "horizontal-ray", "vertical-line", "arrow-marker",
  // Channel labels (labelText + alignment): parallel channel, flat
  // top/bottom, disjoint channel; the arrow shares the trend-line label.
  "parallel-channel", "flat-top-bottom", "disjoint-channel", "arrow",
]);
// Range tools: a `customText` (own colour / size / bold / italic, no
// alignment), centred in the box.
export const RANGE_TEXT_KINDS = new Set<string>(["price-range", "date-range", "date-and-price-range"]);
// Text-annotation kinds — the editable string lives at the drawing's top-level
// `text` and the colour is the drawing's main `style.color`.
export const TEXT_ANNOTATION_KINDS = new Set<string>(["text", "note", "pin", "comment", "price-note", "signpost", "callout"]);
// Shapes with in-shape text: the string lives at the drawing's top-level
// `text` (like annotations) but the colour is the separate `textColor`.
// Arrow marks: text + colour / size / bold / italic, no alignment.
export const SHAPE_TEXT_KINDS = new Set<string>(["rectangle", "circle", "ellipse", "arrow-mark-up", "arrow-mark-down"]);
// Any kind that exposes the Text tab.
export const TEXT_KINDS = new Set<string>([...LINE_LABEL_KINDS, ...TEXT_ANNOTATION_KINDS, ...SHAPE_TEXT_KINDS, ...RANGE_TEXT_KINDS]);


// Stats options for the multi-select (the summary reads "Price range,
// Percent change, Bars range"; the rest keep their existing names).
export const STAT_FIELDS: ReadonlyArray<readonly [keyof DrawingStyle, string]> = [
  ["showPriceRange", "Price range"],
  ["showPercentPriceRange", "Percent change"],
  ["showPipsPriceRange", "Pips range"],
  ["showBarsRange", "Bars range"],
  ["showDateTimeRange", "Date/time range"],
  ["showDistance", "Distance"],
  ["showAngle", "Angle"],
];

export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
