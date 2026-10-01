/*
 * SettingsDialog — modal opened from the SelectedToolbar Settings button or
 * the context menu's Settings… row.
 *
 * 4 tabs (`source-properties-editor`):
 *   • Style       — color/width/lineStyle, plus the line-family toggles
 *                   (extend, middle point, end arrows, stats group), each
 *                   gated to the kinds that support it.
 *   • Text        — on-line label + font/bold/italic/alignment (line family);
 *                   placeholder for kinds without text.
 *   • Coordinates — read-only price + time per point
 *   • Visibility  — Lock + Hide checkboxes
 *
 * Field coverage is intentionally narrow — toggles are
 * added as the matching DrawingStyle fields + renderers land.
 */
import { createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { DEFAULT_VISIBILITY, type DataPoint, type Drawing, type DrawingStyle, type GannLine, type GannRatioLine, type PositionStatKey, type GhostCandleStyle, type IntervalVisibility, type LevelDef, type LineStyle, type RegressionLine, type UnitVisibility } from "lightweight-charts-drawing/core/types";
import { labelForKind } from "./labels";
import { factoryStyleFor, FIB_TREND_LINE_DEFAULT, FIB_WEDGE_TREND_LINE_DEFAULT } from "lightweight-charts-drawing/core/specs";
import { vwapBandLine } from "lightweight-charts-drawing/core/kinds/data-series";
import { defaultStyleFor, GHOST_CANDLE_DEFAULTS, ELLIOTT_DEFAULT_DEGREE, ELLIOTT_DEGREE_NAMES, FIB_CIRCLE_LEVEL_DEFAULTS, FIB_LEVEL_DEFAULTS, FIB_TIMEZONE_LEVEL_DEFAULTS, FIB_WEDGE_LEVEL_DEFAULTS, GANN_BOX_LEVEL_DEFAULTS, GANN_FAN_LEVEL_DEFAULTS, PARALLEL_CHANNEL_LEVEL_DEFAULTS, PITCHFAN_LEVEL_DEFAULTS, PITCHFORK_LEVEL_DEFAULTS, REGRESSION_LINE_DEFAULTS, SPEED_ARC_LEVEL_DEFAULTS, SPEED_FAN_GRID_DEFAULT, SPEED_FAN_LEVEL_DEFAULTS, VWAP_BAND_DEFAULTS, TREND_FIB_TIME_LEVEL_DEFAULTS, TREND_FIB_TIME_TREND_DEFAULT, GANN_LEVEL_DEFAULTS, GANN_FAN_DEFAULTS, GANN_ARC_DEFAULTS } from "lightweight-charts-drawing/core/specs";
import { clearKindDefault, saveKindDefault } from "./templates";
import { TemplatesMenu } from "./DrawingStylePopovers";
import { ColorPanel, applyOpacity, parseColor } from "./ColorPanel";
import { LineEndSelect, LineGlyphSelect } from "./LineEndSelect";
import type { Time } from "lightweight-charts";
import { getTickerInfo } from "../../data/datafeed";
import { levelFromPrice, positionLevels, positionRiskSize, positionStatOn, POSITION_DEFAULTS, POSITION_STATS } from "lightweight-charts-drawing/core/kinds/position";
import { ImageDialog, TransparencySlider } from "./ImageDialog";
import { drawingImage, imageInitialSize } from "lightweight-charts-drawing/core/kinds/images";
import { imagesVersion } from "./image-store";

const TABS = ["Style", "Text", "Coordinates", "Visibility"] as const;
/** Page order: Inputs (tools with study-like inputs), Style, Text,
 *  Coordinates, Visibility. */
type Tab = (typeof TABS)[number] | "Inputs";
const INPUTS_KINDS = new Set<string>(["ghost-feed", "regression-trend", "long-position", "short-position", "anchored-vwap"]);
/** Tools whose dialog has no Style page (Text is their first page). */
const NO_STYLE_KINDS = new Set<string>(["text", "callout", "comment"]);
/** Tools whose dialog has no Coordinates page (no editable coordinates): path
 *  and polyline (tabs Style + Visibility), bars pattern. */
const NO_COORDINATES_KINDS = new Set<string>([
  "path", "polyline", "bar-pattern",
  // Dialog tabs per tool
  "fib-wedge", "brush", "highlighter", "rotated-rectangle", "ellipse", "arc", "font-icon",
  "flat-top-bottom", "disjoint-channel", "long-position", "short-position", "anchored-vwap", "text",
  "sector",
  // Table / image: Style + Visibility.
  "table", "image",
]);

const FONT_SIZES = ["10", "11", "12", "13", "14", "16", "18", "20", "24"];
/** Style page rows per tool, in display order. Row ids are rendered by
 *  SettingsDialog `styleRow`; "id:Title" ids carry the row title. */
const LINE_TOOL_ROWS = ["line+ends:Line", "extend", "middlePoint", "priceLabel:Price labels", "stats"];
const PITCHFORK_ROWS = ["pitchforkExtend", "line:Median", "levels", "pitchforkStyle"];
const STYLE_ROWS: Record<string, string[]> = {
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
  "fixed-range-volume-profile": ["line:Line"],
  "anchored-volume-profile": ["line:Line"],
  // Range tools "Line": colour + width (no line style; the lines are solid).
  "price-range": ["lineNoStyle:Line", "background", "rangeExtend", "rangeStats", "rangeLabel"],
  "date-range": ["lineNoStyle:Line", "background", "rangeExtend", "rangeStats", "rangeLabel"],
  "date-and-price-range": ["lineNoStyle:Line", "rangeBorder", "background", "rangeStats", "rangeLabel"],
  brush: ["line+ends:Line", "background"],
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
const styleRowsFor = (kind: string): string[] => STYLE_ROWS[kind] ?? ["line:Line"];
/** Extend list titles per tool. */
const EXTEND_TITLES: Record<string, [string, string]> = {
  rectangle: ["Extend left", "Extend right"],
  "fib-channel": ["Extend left", "Extend right"],
  "fib-retracement": ["Extend lines left", "Extend lines right"],
  "trend-based-fib-extension": ["Extend lines left", "Extend lines right"],
};
/** Pitchfork styles and the OpenTrader kind of each. */
const PITCHFORK_STYLES: [string, string][] = [["pitchfork", "Original"], ["schiff-pitchfork", "Schiff"], ["modified-schiff-pitchfork", "Modified Schiff"], ["inside-pitchfork", "Inside"]];
/** Text tools with Background / Border rows on the Text page. */
const TEXT_BOX_KINDS = new Set<string>(["text", "callout", "comment", "pin"]);
/** Factory background transparency when a drawing has none stored (text
 *  rgba(41,98,255,0.25), callout 50, comment / pin 0). */
const TEXT_BOX_TRANSPARENCY: Record<string, number> = { text: 75, callout: 50, comment: 0, pin: 0 };
/** Factory border colours (text #707070, comment ot-blue-500, pin
 *  cold-gray-700). */
const TEXT_BORDER_DEFAULT: Record<string, string> = { text: "#707070", comment: "#2962ff", pin: "#4a4a4a" };
/** Coordinates row titles: "#N (price)", "#N (bar)", else price and bar. */
const COORD_MODES: Record<string, "price" | "bar" | "price, bar" | "vertical position %, bar"> = {
  signpost: "vertical position %, bar",
  "horizontal-line": "price",
  "vertical-line": "bar",
  "regression-trend": "bar",
};
/** Highlighter thickness options (px). */
const HIGHLIGHTER_WIDTHS = [10, 20, 30, 40];


// Which line-family kinds expose each toggle group (different fields per
// tool). Gated so a rectangle/fib/etc. doesn't sprout line-only options.
// NOTE: the trendline Style tab has no arrowhead checkboxes — the
// leftEnd/rightEnd style fields stay render-supported and reachable via
// templates, but the rows are gone.
const EXTEND_KINDS = new Set<string>([
  "trend-line", "ray", "extended-line", "info-line",
  // Fib level tools: the extend flags stretch the level span to the pane edges
  // (default off).
  "fib-retracement", "trend-based-fib-extension", "fib-channel",
  // Bézier curves: the extend flags continue the curve parametrically.
  "curve", "double-curve",
]);

// Kinds with a per-level model (Settings → Levels grid) and their factory sets.
const LEVEL_KIND_DEFAULTS: Record<string, LevelDef[]> = {
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
const VWAP_SOURCES = ["open", "high", "low", "close", "hl2", "hlc3", "ohlc4", "hlcc4"] as const;
/** Price source option texts of the selects (regression trend, anchored
 *  VWAP). */
const PRICE_SOURCE_LABELS: Record<(typeof VWAP_SOURCES)[number], string> = {
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
const QTY_PRECISION_OPTIONS: { value: string; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "0", label: "Integer" },
  ...Array.from({ length: 10 }, (_, k) => ({ value: String(k + 1), label: k === 0 ? "1 decimal" : `${k + 1} decimals` })),
];
/** Level grid with value + colour, two per line, and a "Levels line"
 *  row (width + style of every level). */
const LEVEL_FRAGMENT_KINDS = new Set<string>(["fib-retracement", "trend-based-fib-extension", "fib-channel", "gann-box"]);
const LEVELS_LINE_KINDS = new Set<string>(["fib-retracement", "trend-based-fib-extension", "fib-channel"]);
// Position tools: risk inputs driving the Qty readout (accountSize/risk).
const POSITION_KINDS = new Set<string>(["long-position", "short-position"]);
/** Bars pattern modes, in option order (labels: HL bars, OC bars,
 *  Line - close / open / high / low / HL/2). */
const BAR_PATTERN_MODE_VALUES = ["bars", "oc", "line", "line-open", "line-high", "line-low", "line-hl2"] as const;
const BAR_PATTERN_MODE_LABELS = ["HL bars", "OC bars", "Line - close", "Line - open", "Line - high", "Line - low", "Line - HL/2"] as const;
/** Stats position options (value = index). */
const STATS_POSITIONS = ["Left", "Center", "Right", "Auto"] as const;
// Line-family kinds that carry an on-line label (text stored on `style.text`).
// Includes the axis-line family + arrow-marker (all expose a Text tab whose
// string renders on/next to the line).
/** Vertical text alignment each renderer uses when the style has none
 *  (factory): horizontal line / vertical line middle, horizontal ray top,
 *  trend lines and channels bottom. */
/** The vertical alignment is named by where the text sits: the stored
 *  `bottom` (box above the point) shows as "Top", `top` as "Bottom" (trend
 *  line, price note, rectangle, horizontal / vertical line). */
const VERT_ALIGN_TITLE: Record<string, string> = { top: "Bottom", middle: "Middle", bottom: "Top" };
function vertAlignFromTitle(t: string): "top" | "middle" | "bottom" {
  return t === "Top" ? "bottom" : t === "Bottom" ? "top" : "middle";
}
/** The rectangle calls the middle "Inside" (rectangle alignment items). */
function vertTitle(v: string, kind: string): string {
  return v === "middle" && kind === "rectangle" ? "Inside" : VERT_ALIGN_TITLE[v];
}

function labelVertDefault(kind: string): string {
  return kind === "horizontal-line" || kind === "vertical-line" || kind === "rectangle" ? "middle" : kind === "horizontal-ray" ? "top" : "bottom";
}

const LINE_LABEL_KINDS = new Set<string>([
  "trend-line", "ray", "extended-line", "info-line",
  "horizontal-line", "horizontal-ray", "vertical-line", "arrow-marker",
  // Channel labels (labelText + alignment): parallel channel, flat
  // top/bottom, disjoint channel; the arrow shares the trend-line label.
  "parallel-channel", "flat-top-bottom", "disjoint-channel", "arrow",
]);
// Range tools: a `customText` (own colour / size / bold / italic, no
// alignment), centred in the box.
const RANGE_TEXT_KINDS = new Set<string>(["price-range", "date-range", "date-and-price-range"]);
// Text-annotation kinds — the editable string lives at the drawing's top-level
// `text` and the colour is the drawing's main `style.color`.
const TEXT_ANNOTATION_KINDS = new Set<string>(["text", "note", "pin", "comment", "price-note", "signpost", "callout"]);
// Shapes with in-shape text: the string lives at the drawing's top-level
// `text` (like annotations) but the colour is the separate `textColor`.
// Arrow marks: text + colour / size / bold / italic, no alignment.
const SHAPE_TEXT_KINDS = new Set<string>(["rectangle", "circle", "ellipse", "arrow-mark-up", "arrow-mark-down"]);
// Any kind that exposes the Text tab.
const TEXT_KINDS = new Set<string>([...LINE_LABEL_KINDS, ...TEXT_ANNOTATION_KINDS, ...SHAPE_TEXT_KINDS, ...RANGE_TEXT_KINDS]);


// Stats options for the multi-select (the summary reads "Price range,
// Percent change, Bars range"; the rest keep their existing names).
const STAT_FIELDS: ReadonlyArray<readonly [keyof DrawingStyle, string]> = [
  ["showPriceRange", "Price range"],
  ["showPercentPriceRange", "Percent change"],
  ["showPipsPriceRange", "Pips range"],
  ["showBarsRange", "Bars range"],
  ["showDateTimeRange", "Date/time range"],
  ["showDistance", "Distance"],
  ["showAngle", "Angle"],
];

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

type Props = {
  drawing: Drawing;
  onClose: () => void;
  onUpdate: (d: Drawing) => void;
  /** Tab to open on (context menu's "Visibility on intervals…" routes here). */
  initialTab?: Tab;
  /** Pixel↔data bridge — used by the Coordinates tab to show/edit each point's
   *  bar index. Null before the chart lays out. */
  coords?: import("./coords").Coords | null;
  /** Bare ticker of the pane (position Risk unit: the symbol currency). */
  symbol?: string;
};

export function SettingsDialog(props: Props) {
  /** Page order Inputs / Style / Text / Coordinates / Visibility; a page is
   *  added only when the tool has content for it: Text only for tools with text,
   *  Coordinates only for tools with editable coordinates. */
  const dialogTabs = (): Tab[] => {
    const k = props.drawing.kind;
    const out: Tab[] = [];
    if (INPUTS_KINDS.has(k)) out.push("Inputs");
    if (!NO_STYLE_KINDS.has(k)) out.push("Style");
    if (TEXT_KINDS.has(k)) out.push("Text");
    if (!NO_COORDINATES_KINDS.has(k)) out.push("Coordinates");
    out.push("Visibility");
    return out;
  };
  const [activeTab, setActiveTab] = createSignal<Tab>(
    props.initialTab && dialogTabs().includes(props.initialTab)
      ? props.initialTab
      : dialogTabs().includes("Style") ? "Style" : dialogTabs()[0],
  );
  // Footer "Template" dropdown (save/apply named styles + reset to defaults).
  const [templatesOpen, setTemplatesOpen] = createSignal(false);
  let footerTemplateEl: HTMLDivElement | undefined;

  function patchStyle(patch: Partial<DrawingStyle>) {
    const style = { ...props.drawing.style, ...patch };
    // The tool's defaults are saved on every UI property edit.
    saveKindDefault(props.drawing.kind, style);
    props.onUpdate({ ...props.drawing, style } as Drawing);
  }
  // Visibility tab (per-interval matrix). Reads fall back to the full
  // default matrix; the first edit materialises the field on the drawing.
  const vis = (): IntervalVisibility => props.drawing.visibility ?? DEFAULT_VISIBILITY;
  function patchVisibility(patch: Partial<IntervalVisibility>) {
    props.onUpdate({ ...props.drawing, visibility: { ...vis(), ...patch } } as Drawing);
  }
  /** Replace one point in the drawing (Coordinates tab edits). Preserves the
   *  discriminated-union tuple arity via the `as Drawing` cast. */
  function updatePoint(i: number, patch: Partial<DataPoint>) {
    const next = props.drawing.points.map((p, idx) => (idx === i ? { ...p, ...patch } : p));
    props.onUpdate({ ...props.drawing, points: next } as Drawing);
  }

  const kind = () => props.drawing.kind as string;
  // Risk unit options: "%" and the symbol currency ("Cash" when unknown).
  const [tickerInfo] = createResource(
    () => (POSITION_KINDS.has(props.drawing.kind) && props.symbol ? props.symbol : null),
    (sym) => getTickerInfo(sym).catch(() => null),
  );
  const moneyUnit = () => tickerInfo()?.currency || "Cash";
  const pip = () => props.coords?.pipSize() ?? 0.01;
  const priceDigits = () => Math.max(0, Math.min(8, Math.round(-Math.log10(pip()))));
  const posSide = (): 1 | -1 => (props.drawing.kind === "long-position" ? 1 : -1);
  const posLevels = () => positionLevels(props.drawing, pip());
  const setRiskMode = (mode: "percents" | "money") => {
    const st = props.drawing.style;
    if ((st.riskDisplayMode ?? "percents") === mode) return;
    const account = st.accountSize ?? POSITION_DEFAULTS.accountSize;
    // Recalculate risk: convert the value to the new unit (2 decimals).
    const round2 = (v: number) => parseFloat(v.toFixed(2));
    if (mode === "money") patchStyle({ riskDisplayMode: mode, riskAmount: round2((account / 100) * (st.riskPercent ?? POSITION_DEFAULTS.risk)) });
    else patchStyle({ riskDisplayMode: mode, riskPercent: account > 0 ? round2((positionRiskSize(st) / account) * 100) : 0 });
  };
  const setEntryPrice = (v: number) => {
    const [p0, p1] = props.drawing.points;
    if (!p0 || !p1) return;
    props.onUpdate({ ...props.drawing, points: [{ ...p0, price: v }, { ...p1, price: v }] } as Drawing);
  };
  const extendValue = (): "none" | "left" | "right" | "both" => {
    const s = props.drawing.style;
    if (s.extendLeft && s.extendRight) return "both";
    if (s.extendLeft) return "left";
    if (s.extendRight) return "right";
    return "none";
  };

  // Text-tab plumbing — annotations + shapes keep their string at the top
  // level; line labels keep it on the style. Annotations colour via the main
  // `color`, everything else via `textColor`.
  const isAnnotation = () => TEXT_ANNOTATION_KINDS.has(kind());
  const isTopLevelText = () => isAnnotation() || SHAPE_TEXT_KINDS.has(kind());
  const textValue = () => (isTopLevelText() ? props.drawing.text : props.drawing.style.text) ?? "";
  const setText = (v: string) =>
    isTopLevelText()
      ? props.onUpdate({ ...props.drawing, text: v } as Drawing)
      : patchStyle({ text: v });
  // Text colour: annotation kinds colour their text with `color`, except the
  // callout (its bubble is `color`, the text `textColor`); range tools use
  // their own custom-text fields (`customText`).
  const isRangeText = () => RANGE_TEXT_KINDS.has(kind());
  // Text tool: the text colour is its `color`; the other annotation
  // tools keep a separate text colour.
  const textInColor = () => kind() === "text";
  const textColorValue = () =>
    (isRangeText()
      ? props.drawing.style.customTextColor ?? "#2962ff"
      : textInColor() ? props.drawing.style.color : props.drawing.style.textColor ?? props.drawing.style.color) ?? "#ffffff";
  const setTextColor = (c: string) =>
    isRangeText() ? patchStyle({ customTextColor: c }) : textInColor() ? patchStyle({ color: c }) : patchStyle({ textColor: c });
  const textSize = () => (isRangeText() ? props.drawing.style.customTextSize ?? 12 : props.drawing.style.fontSize ?? 14);
  const setTextSize = (v: number) => (isRangeText() ? patchStyle({ customTextSize: v }) : patchStyle({ fontSize: v }));
  const textBold = () => !!(isRangeText() ? props.drawing.style.customTextBold : props.drawing.style.bold);
  const toggleBold = () => (isRangeText() ? patchStyle({ customTextBold: !textBold() }) : patchStyle({ bold: !textBold() }));
  const textItalic = () => !!(isRangeText() ? props.drawing.style.customTextItalic : props.drawing.style.italic);
  const toggleItalic = () => (isRangeText() ? patchStyle({ customTextItalic: !textItalic() }) : patchStyle({ italic: !textItalic() }));

  /** Coordinates rows: parallel channel and trend angle show fewer points
   *  (Price offset / Angle rows stand for the rest). */
  const coordPoints = () => {
    const k = kind();
    return k === "parallel-channel" || k === "trend-angle" ? props.drawing.points.slice(0, k === "trend-angle" ? 1 : 2) : props.drawing.points;
  };
  const trendAngleValue = () => {
    const st = props.drawing.style;
    if (st.angle != null) return st.angle;
    const c = props.coords;
    const [p0, p1] = props.drawing.points;
    if (!c || !p0 || !p1) return 0;
    const x0 = c.timeToX(p0.time), y0 = c.priceToY(p0.price), x1 = c.timeToX(p1.time), y1 = c.priceToY(p1.price);
    return x0 == null || y0 == null || x1 == null || y1 == null ? 0 : (Math.atan2(-(y1 - y0), x1 - x0) * 180) / Math.PI;
  };
  const setTrendAngle = (deg: number) => {
    const c = props.coords;
    const [p0, p1] = props.drawing.points;
    if (!c || !p0 || !p1) return;
    const x0 = c.timeToX(p0.time), y0 = c.priceToY(p0.price), x1 = c.timeToX(p1.time), y1 = c.priceToY(p1.price);
    if (x0 == null || y0 == null || x1 == null || y1 == null) return;
    const len = Math.hypot(x1 - x0, y1 - y0);
    const th = (deg * Math.PI) / 180;
    const t = c.xToTime(x0 + len * Math.cos(th));
    const pr = c.yToPrice(y0 - len * Math.sin(th));
    if (t == null || pr == null) return;
    props.onUpdate({ ...props.drawing, points: [p0, { time: t, price: pr }], style: { ...props.drawing.style, angle: deg } } as Drawing);
  };

  /** Display string for a point's bar index (empty when coords aren't ready). */
  const barIndexOf = (t: Time): string => {
    const idx = props.coords?.timeToBarIndex(t);
    return idx == null ? "" : String(idx);
  };

  const lineRow = (label: string, ends: boolean) => (
    <DialogRow label={label}>
      <ColorThicknessPicker
        color={props.drawing.style.color}
        width={props.drawing.style.width}
        lineStyle={props.drawing.style.lineStyle}
        onColor={(c) => patchStyle({ color: c })}
        onWidth={(w) => patchStyle({ width: w })}
        onLineStyle={(st) => patchStyle({ lineStyle: st })}
      />
      <Show when={ends}>
        <LineEndSelect side="left" value={props.drawing.style.leftEnd === 1 ? 1 : 0} onChange={(v) => patchStyle({ leftEnd: v })} />
        <LineEndSelect side="right" value={(props.drawing.style.rightEnd ?? defaultStyleFor(props.drawing.kind).rightEnd ?? 0) === 1 ? 1 : 0} onChange={(v) => patchStyle({ rightEnd: v })} />
      </Show>
    </DialogRow>
  );
  // Extend: a list of two checks (per-tool titles), "Don't extend" when
  // none is on.
  const extendRow = () => {
    const [l, r] = EXTEND_TITLES[kind()] ?? ["Extend left line", "Extend right line"];
    return (
      <DialogRow label="Extend">
        <StatsMultiSelect
          fields={[["extendLeft", l], ["extendRight", r]]}
          emptyLabel="Don't extend"
          isOn={(k) => (k === "extendLeft" ? extendValue() === "left" || extendValue() === "both" : extendValue() === "right" || extendValue() === "both")}
          onToggle={(k, v) => patchStyle({ [k]: v } as Partial<DrawingStyle>)}
        />
      </DialogRow>
    );
  };
  /** One Style row (ids in STYLE_ROWS). `kind:Label` ids carry the row title. */
  function styleRow(id: string): import("solid-js").JSX.Element {
    const [key, label = ""] = id.split(":");
    const st = () => props.drawing.style;
    switch (key) {
      case "line":
        return lineRow(label, false);
      case "line+ends":
        return lineRow(label, true);
      // Position forecast: ten colour rows. The source background swatch
      // carries the drawing's transparency (its opacity sets `transparency`).
      case "forecastColors": {
        type K = "sourceTextColor" | "sourceBackColor" | "sourceStrokeColor" | "targetTextColor" | "targetBackColor" | "targetStrokeColor" | "successTextColor" | "successBackground" | "failureTextColor" | "failureBackground";
        const rows: [K, string, string][] = [
          ["sourceTextColor", "Source text", "#ffffff"],
          ["sourceBackColor", "Source background", "#2962FF"],
          ["sourceStrokeColor", "Source border", "#2962FF"],
          ["targetTextColor", "Target text", "#ffffff"],
          ["targetBackColor", "Target background", "#2962FF"],
          ["targetStrokeColor", "Target border", "#2962FF"],
          ["successTextColor", "Success text", "#ffffff"],
          ["successBackground", "Success background", "#4caf50"],
          ["failureTextColor", "Failure text", "#ffffff"],
          ["failureBackground", "Failure background", "#F23645"],
        ];
        return (
          <For each={rows}>
            {([k, title, def]) => (
              <DialogRow label={title}>
                <Show
                  when={k === "sourceBackColor"}
                  fallback={<DialogColorButton color={st()[k] ?? def} onColor={(c) => patchStyle({ [k]: c } as Partial<DrawingStyle>)} />}
                >
                  <DialogColorButton
                    color={applyOpacity(parseColor(st()[k] ?? def).hex, 100 - (st().transparency ?? 10))}
                    onColor={(c) => {
                      const pc = parseColor(c);
                      patchStyle({ sourceBackColor: pc.hex, transparency: 100 - pc.opacity });
                    }}
                  />
                </Show>
              </DialogRow>
            )}
          </For>
        );
      }
      // Chart patterns "Label": text colour, font size, bold, italic.
      case "patternLabel":
        return (
          <DialogRow label="Label">
            <div class="drawing-settings-text-format">
              <DialogColorButton color={st().textColor ?? "#ffffff"} onColor={(c) => patchStyle({ textColor: c })} />
              <Dropdown value={String(st().fontSize ?? 12)} options={FONT_SIZES} onChange={(v) => patchStyle({ fontSize: Number(v) })} />
              <FontStyleToggles bold={!!st().bold} italic={!!st().italic} onBold={(v) => patchStyle({ bold: v })} onItalic={(v) => patchStyle({ italic: v })} />
            </div>
          </DialogRow>
        );
      // Polyline "Border": colour + thickness (no line style).
      case "lineNoStyle":
        return (
          <DialogRow label={label}>
            <ColorThicknessPicker color={st().color} width={st().width} onColor={(c) => patchStyle({ color: c })} onWidth={(w) => patchStyle({ width: w })} />
          </DialogRow>
        );
      // Colour-only rows (arrow marks "Arrow", flag "Flag", arrow marker /
      // bars pattern / Elliott / icon "Color", pin "Label", highlighter
      // "Line": the colour panel opacity is part of the colour).
      case "color":
        return (
          <DialogRow label={label}>
            <DialogColorButton color={st().color} onColor={(c) => patchStyle({ color: c })} />
          </DialogRow>
        );
      // Highlighter "Thickness" (factory 20px).
      case "thickness":
        return (
          <DialogRow label="Thickness">
            <Dropdown value={`${st().width}px`} options={HIGHLIGHTER_WIDTHS.map((w) => `${w}px`)} onChange={(v) => patchStyle({ width: parseInt(v, 10) })} />
          </DialogRow>
        );
      case "extend":
        return extendRow();
      case "middlePoint":
        return <CheckboxRow checked={!!st().showMiddlePoint} onChange={(v) => patchStyle({ showMiddlePoint: v })} label="Middle point" />;
      case "priceLabel":
        return <CheckboxRow checked={!!st().showPriceLabels} onChange={(v) => patchStyle({ showPriceLabels: v })} label={label} />;
      case "timeLabel":
        return <CheckboxRow checked={!!st().showTime} onChange={(v) => patchStyle({ showTime: v })} label="Time label" />;
      // Vertical line "Extend" (extendLine, factory on): draws the line
      // through every pane of the chart.
      case "vlineExtend":
        return <CheckboxRow checked={st().extendLine !== false} onChange={(v) => patchStyle({ extendLine: v })} label="Extend" />;
      // Elliott "Wave" (showWave, factory on): the wave lines; off = the
      // labels only.
      // Elliott "Wave": [x] showWave + the wave line width select
      // (line-width-select, 76 x 34; linewidth factory 2).
      case "wave":
        return (
          <div class="drawing-settings-row">
            <CheckboxRow checked={st().showWave !== false} onChange={(v) => patchStyle({ showWave: v })} label="Wave" />
            <div class="drawing-settings-row-inputs">
              <LineGlyphSelect kind="width" value={st().width} options={[1, 2, 3, 4]} onChange={(v) => patchStyle({ width: v })} />
            </div>
          </div>
        );
      case "stats":
        return (
          <>
            <div class="drawing-settings-section-title">Info</div>
            <DialogRow label="Stats">
              <StatsMultiSelect
                // Trend angle: price and bars stats only.
                fields={kind() === "trend-angle" ? STAT_FIELDS.slice(0, 4) : STAT_FIELDS}
                isOn={(k) => !!st()[k as keyof DrawingStyle]}
                onToggle={(k, v) => patchStyle({ [k]: v } as Partial<DrawingStyle>)}
              />
            </DialogRow>
            <DialogRow label="Stats position">
              <Dropdown
                wide
                value={STATS_POSITIONS[st().statsPosition ?? (kind() === "info-line" ? 1 : 2)]}
                options={[...STATS_POSITIONS]}
                onChange={(v) => {
                  const i = STATS_POSITIONS.indexOf(v as (typeof STATS_POSITIONS)[number]);
                  if (i >= 0) patchStyle({ statsPosition: i as 0 | 1 | 2 | 3 });
                }}
              />
            </DialogRow>
            <CheckboxRow checked={!!st().showStats} onChange={(v) => patchStyle({ showStats: v })} label="Always show stats" />
            <div class="drawing-settings-group-sep" />
          </>
        );
      case "background":
        return <BackgroundColorRow style={st()} patchStyle={patchStyle} />;
      case "rectMiddleLine": {
        const ml = () => st().rectMiddleLine ?? { visible: false, color: st().color, width: 1, style: "dashed" as LineStyle };
        const patchMl = (patch: Partial<RegressionLine>) => patchStyle({ rectMiddleLine: { ...ml(), ...patch } });
        return (
          <div class="drawing-settings-row">
            <CheckboxRow checked={ml().visible} onChange={(v) => patchMl({ visible: v })} label="Middle line" />
            <div class="drawing-settings-row-inputs">
              <ColorThicknessPicker color={ml().color} width={ml().width} lineStyle={ml().style} onColor={(c) => patchMl({ color: c })} onWidth={(w) => patchMl({ width: w })} onLineStyle={(x) => patchMl({ style: x })} />
            </div>
          </div>
        );
      }
      case "degree":
        return (
          <DialogRow label="Degree">
            <Dropdown
              mid
              value={ELLIOTT_DEGREE_NAMES[st().elliottDegree ?? ELLIOTT_DEFAULT_DEGREE]}
              options={[...ELLIOTT_DEGREE_NAMES]}
              onChange={(v) => {
                const i = ELLIOTT_DEGREE_NAMES.indexOf(v as (typeof ELLIOTT_DEGREE_NAMES)[number]);
                if (i >= 0) patchStyle({ elliottDegree: i });
              }}
            />
          </DialogRow>
        );
      // Anchored VWAP Style: Lower / Upper band #1,
      // Background #1, Lower / Upper band #2, #3 (visible + colour + width),
      // Price label.
      case "vwapBands": {
        const bandRow = (i: number, side: "upper" | "lower") => {
          const key = side === "upper" ? "vwapUpper" : "vwapLower";
          const ln = () => vwapBandLine(st(), i, side);
          const patchLn = (x: Partial<RegressionLine>) => {
            const cur = [0, 1, 2].map((k) => ({ ...vwapBandLine(st(), k, side) }));
            cur[i] = { ...cur[i], ...x };
            patchStyle({ [key]: cur } as Partial<DrawingStyle>);
          };
          return (
            <div class="drawing-settings-row">
              <CheckboxRow checked={ln().visible} onChange={(v) => patchLn({ visible: v })} label={`${side === "upper" ? "Upper" : "Lower"} band #${i + 1}`} />
              <div class="drawing-settings-row-inputs">
                <ColorThicknessPicker color={ln().color} width={ln().width} onColor={(c) => patchLn({ color: c })} onWidth={(w) => patchLn({ width: w })} />
              </div>
            </div>
          );
        };
        return (
          <>
            {bandRow(0, "lower")}
            {bandRow(0, "upper")}
            <div class="drawing-settings-row">
              <CheckboxRow checked={st().fillBackground !== false} onChange={(v) => patchStyle({ fillBackground: v })} label="Background #1" />
              <div class="drawing-settings-row-inputs">
                <DialogColorButton
                  color={applyOpacity(parseColor(st().backgroundColor ?? "#4caf50").hex, 100 - (st().transparency ?? 95))}
                  onColor={(c) => {
                    const pc = parseColor(c);
                    patchStyle({ backgroundColor: pc.hex, transparency: 100 - pc.opacity });
                  }}
                />
              </div>
            </div>
            {bandRow(1, "lower")}
            {bandRow(1, "upper")}
            {bandRow(2, "lower")}
            {bandRow(2, "upper")}
            <CheckboxRow checked={st().vwapPriceLabel !== false} onChange={(v) => patchStyle({ vwapPriceLabel: v })} label="Price label" />
          </>
        );
      }
      case "speedFan":
        return <SpeedFanStyleRows style={st()} patchStyle={patchStyle} />;
      case "gannBox":
        return <GannBoxStyleRows style={st()} patchStyle={patchStyle} />;
      case "fibTrendLine": {
        const tl = () => st().fibTrendLine ?? (kind() === "trend-based-fib-time" ? TREND_FIB_TIME_TREND_DEFAULT : kind() === "fib-wedge" ? FIB_WEDGE_TREND_LINE_DEFAULT : FIB_TREND_LINE_DEFAULT);
        const patchTl = (x: Partial<RegressionLine>) => patchStyle({ fibTrendLine: { ...tl(), ...x } });
        return (
          <div class="drawing-settings-row">
            <CheckboxRow checked={tl().visible} onChange={(v) => patchTl({ visible: v })} label="Trend line" />
            <div class="drawing-settings-row-inputs">
              <ColorThicknessPicker color={tl().color} width={tl().width} lineStyle={tl().style} onColor={(c) => patchTl({ color: c })} onWidth={(w) => patchTl({ width: w })} onLineStyle={(x) => patchTl({ style: x })} />
            </div>
          </div>
        );
      }
      case "gannSquare":
        return <GannStyleRows drawing={props.drawing} coords={props.coords} patchStyle={patchStyle} onUpdate={props.onUpdate} />;
      // Table Style: Background, Border, Text
      // (colour + size), Text alignment (factory Left).
      case "table":
        return (
          <>
            <DialogRow label="Background">
              <DialogColorButton color={st().backgroundColor ?? "#0f0f0f"} onColor={(c) => patchStyle({ backgroundColor: c })} />
            </DialogRow>
            <DialogRow label="Border">
              <DialogColorButton color={st().color} onColor={(c) => patchStyle({ color: c })} />
            </DialogRow>
            <DialogRow label="Text">
              <DialogColorButton color={st().textColor ?? "#dbdbdb"} onColor={(c) => patchStyle({ textColor: c })} />
              <Dropdown value={String(st().fontSize ?? 14)} options={FONT_SIZES} onChange={(v) => patchStyle({ fontSize: Number(v) })} />
            </DialogRow>
            <DialogRow label="Text alignment">
              <Dropdown value={capitalize(st().horzLabelsAlign ?? "left")} options={["Left", "Center", "Right"]} onChange={(v) => patchStyle({ horzLabelsAlign: v.toLowerCase() as "left" | "center" | "right" })} />
            </DialogRow>
          </>
        );
      case "image":
        return <ImageStyleRows drawing={props.drawing} coords={props.coords} onUpdate={props.onUpdate} patchStyle={patchStyle} />;
      // Sector (projection): Background = the two gradient colours
      // (shared transparency), Border = colour + width.
      case "sector":
        return (
          <>
            <DialogRow label="Background">
              <For each={[["sectorColor1", "#2962ff"], ["sectorColor2", "#9c27b0"]] as const}>
                {([k, dflt]) => (
                  <DialogColorButton
                    color={applyOpacity(parseColor(st()[k] ?? dflt).hex, 100 - (st().transparency ?? 80))}
                    onColor={(c) => {
                      const pc = parseColor(c);
                      patchStyle({ [k]: pc.hex, transparency: 100 - pc.opacity } as Partial<DrawingStyle>);
                    }}
                  />
                )}
              </For>
            </DialogRow>
            <DialogRow label="Border">
              <ColorThicknessPicker color={st().color} width={st().width} onColor={(c) => patchStyle({ color: c })} onWidth={(w) => patchStyle({ width: w })} />
            </DialogRow>
          </>
        );
      case "levels":
        return (
          <LevelGridRows
            kind={kind()}
            style={st()}
            defaults={LEVEL_KIND_DEFAULTS[kind()]}
            patchStyle={patchStyle}
            extendRow={LEVELS_LINE_KINDS.has(kind()) && EXTEND_KINDS.has(kind()) ? extendRow() : undefined}
          />
        );
      case "reverse":
        return <CheckboxRow checked={!!st().reverse} onChange={(v) => patchStyle({ reverse: v })} label="Reverse" />;
      // Fib channel label rows: Prices, Levels (Values / Percents),
      // Labels (horizontal + vertical), Font size (8 ... 24).
      case "fibChannelLabels":
        return (
          <>
            <CheckboxRow checked={st().showPrices !== false} onChange={(v) => patchStyle({ showPrices: v })} label="Prices" />
            <div class="drawing-settings-row">
              <CheckboxRow checked={st().showCoeffs !== false} onChange={(v) => patchStyle({ showCoeffs: v })} label="Levels" />
              <div class="drawing-settings-row-inputs">
                <Dropdown value={st().fibLevelsAsPercents ? "Percents" : "Values"} options={["Values", "Percents"]} onChange={(v) => patchStyle({ fibLevelsAsPercents: v === "Percents" })} />
              </div>
            </div>
            <DialogRow label="Labels">
              <Dropdown value={capitalize(st().horzLabelsAlign ?? "left")} options={["Left", "Center", "Right"]} onChange={(v) => patchStyle({ horzLabelsAlign: v.toLowerCase() as "left" | "center" | "right" })} />
              <Dropdown value={VERT_ALIGN_TITLE[st().vertLabelsAlign ?? "middle"]} options={["Top", "Middle", "Bottom"]} onChange={(v) => patchStyle({ vertLabelsAlign: vertAlignFromTitle(v) })} />
            </DialogRow>
            <DialogRow label="Font size">
              <Dropdown value={String(st().labelFontSize ?? 12)} options={["8", "10", "11", "12", "14", "16", "18", "20", "22", "24"]} onChange={(v) => patchStyle({ labelFontSize: Number(v) })} />
            </DialogRow>
          </>
        );
      // Fib retracement / extension labels: [x] Prices, [x] Levels
      // (Values / Percents), Labels (horizontal + vertical), [x] Text
      // (level texts, horizontal + vertical), Font size.
      case "fibLabels":
        return (
          <>
            <CheckboxRow checked={st().showPrices !== false} onChange={(v) => patchStyle({ showPrices: v })} label="Prices" />
            <div class="drawing-settings-row">
              <CheckboxRow checked={st().showCoeffs !== false} onChange={(v) => patchStyle({ showCoeffs: v })} label="Levels" />
              <div class="drawing-settings-row-inputs">
                <Dropdown value={st().fibLevelsAsPercents ? "Percents" : "Values"} options={["Values", "Percents"]} onChange={(v) => patchStyle({ fibLevelsAsPercents: v === "Percents" })} />
              </div>
            </div>
            <DialogRow label="Labels">
              <Dropdown value={capitalize(st().horzLabelsAlign ?? "left")} options={["Left", "Center", "Right"]} onChange={(v) => patchStyle({ horzLabelsAlign: v.toLowerCase() as "left" | "center" | "right" })} />
              <Dropdown value={VERT_ALIGN_TITLE[st().vertLabelsAlign ?? "middle"]} options={["Top", "Middle", "Bottom"]} onChange={(v) => patchStyle({ vertLabelsAlign: vertAlignFromTitle(v) })} />
            </DialogRow>
            <div class="drawing-settings-row">
              <CheckboxRow checked={st().showText !== false} onChange={(v) => patchStyle({ showText: v })} label="Text" />
              <div class="drawing-settings-row-inputs">
                <Dropdown value={capitalize(st().horzTextAlign ?? "center")} options={["Left", "Center", "Right"]} onChange={(v) => patchStyle({ horzTextAlign: v.toLowerCase() as "left" | "center" | "right" })} />
                <Dropdown value={VERT_ALIGN_TITLE[st().vertTextAlign ?? "middle"]} options={["Top", "Middle", "Bottom"]} onChange={(v) => patchStyle({ vertTextAlign: vertAlignFromTitle(v) })} />
              </div>
            </div>
            <DialogRow label="Font size">
              <Dropdown value={String(st().labelFontSize ?? 12)} options={["8", "10", "11", "12", "14", "16", "18", "20", "22", "24"]} onChange={(v) => patchStyle({ labelFontSize: Number(v) })} />
            </DialogRow>
          </>
        );
      // Fib circles / speed arcs / wedge "Levels" (showCoeffs, factory on).
      case "showCoeffs":
        return <CheckboxRow checked={st().showCoeffs !== false} onChange={(v) => patchStyle({ showCoeffs: v })} label="Levels" />;
      case "coeffsAsPercents":
        return <CheckboxRow checked={!!st().fibLevelsAsPercents} onChange={(v) => patchStyle({ fibLevelsAsPercents: v })} label="Coeffs as percents" />;
      case "fullCircles":
        return <CheckboxRow checked={!!st().fullCircles} onChange={(v) => patchStyle({ fullCircles: v })} label="Full circles" />;
      case "counterclockwise":
        return <CheckboxRow checked={!!st().counterclockwise} onChange={(v) => patchStyle({ counterclockwise: v })} label="Counterclockwise" />;
      // Gann fan "Labels" (showLabels, factory on).
      case "labels":
        return <CheckboxRow checked={st().showLabels !== false} onChange={(v) => patchStyle({ showLabels: v })} label="Labels" />;
      // Pitchfork "Extend lines" (extendLines: the lines also run back).
      case "pitchforkExtend":
        return <CheckboxRow checked={!!st().extendLines} onChange={(v) => patchStyle({ extendLines: v })} label="Extend lines" />;
      // Pitchfork "Style": Original / Schiff / Modified Schiff / Inside
      // (one tool in the UI; OpenTrader switches between its four pitchfork
      // kinds).
      case "pitchforkStyle":
        return (
          <DialogRow label="Style">
            <Dropdown
              value={PITCHFORK_STYLES.find(([k]) => k === kind())?.[1] ?? "Original"}
              options={PITCHFORK_STYLES.map(([, t]) => t)}
              onChange={(v) => {
                const k = PITCHFORK_STYLES.find(([, t]) => t === v)?.[0];
                if (k && k !== kind()) props.onUpdate({ ...props.drawing, kind: k } as Drawing);
              }}
            />
          </DialogRow>
        );
      // fibLevelsBasedOnLogScale: level prices in ln(price) space, only
      // on a logarithmic price scale.
      case "fibLog":
        return <CheckboxRow checked={!!st().fibLevelsBasedOnLogScale} onChange={(v) => patchStyle({ fibLevelsBasedOnLogScale: v })} label="Fib levels based on log scale" />;
      // Regression trend Style: Base / Up / Down (check box + line).
      case "regressionLines":
        return (
          <For each={[["base", "Base"], ["up", "Up"], ["down", "Down"]] as const}>
            {([k, title]) => {
              const cur = () => (st().regressionLines ?? REGRESSION_LINE_DEFAULTS)[k];
              const patchLine = (patch: Partial<RegressionLine>) => {
                const all = st().regressionLines ?? REGRESSION_LINE_DEFAULTS;
                patchStyle({ regressionLines: { ...all, [k]: { ...all[k], ...patch } } });
              };
              return (
                <div class="drawing-settings-row">
                  <CheckboxRow checked={cur().visible} onChange={(v) => patchLine({ visible: v })} label={title} />
                  <div class="drawing-settings-row-inputs">
                    <ColorThicknessPicker color={cur().color} width={cur().width} lineStyle={cur().style} onColor={(c) => patchLine({ color: c })} onWidth={(w) => patchLine({ width: w })} onLineStyle={(x) => patchLine({ style: x })} />
                  </div>
                </div>
              );
            }}
          </For>
        );
      case "regressionExtend":
        return <CheckboxRow checked={!!st().extendRight} onChange={(v) => patchStyle({ extendRight: v })} label="Extend lines" />;
      case "pearsons":
        return <CheckboxRow checked={st().showPearsons !== false} onChange={(v) => patchStyle({ showPearsons: v })} label="Pearson's R" />;
      // Bars pattern: Mode, Mirrored, Flipped.
      case "barPattern":
        return (
          <>
            <DialogRow label="Mode">
              <Dropdown
                value={BAR_PATTERN_MODE_LABELS[Math.max(0, BAR_PATTERN_MODE_VALUES.indexOf((st().patternMode ?? "bars") as (typeof BAR_PATTERN_MODE_VALUES)[number]))]}
                options={[...BAR_PATTERN_MODE_LABELS]}
                onChange={(v) => {
                  const i = BAR_PATTERN_MODE_LABELS.indexOf(v as (typeof BAR_PATTERN_MODE_LABELS)[number]);
                  if (i >= 0) patchStyle({ patternMode: BAR_PATTERN_MODE_VALUES[i] });
                }}
              />
            </DialogRow>
            <CheckboxRow checked={!!st().mirrored} onChange={(v) => patchStyle({ mirrored: v })} label="Mirrored" />
            <CheckboxRow checked={!!st().flipped} onChange={(v) => patchStyle({ flipped: v })} label="Flipped" />
          </>
        );
      // Ghost feed Style: Candles (up / down), [x] Borders (up / down),
      // [x] Wick (colour), Transparency (factory 50).
      case "ghostFeed": {
        const cs = () => st().ghostCandle ?? GHOST_CANDLE_DEFAULTS;
        const patchCandle = (patch: Partial<GhostCandleStyle>) => patchStyle({ ghostCandle: { ...cs(), ...patch } });
        return (
          <>
            <DialogRow label="Candles">
              <DialogColorButton color={cs().upColor} onColor={(c) => patchCandle({ upColor: c })} />
              <DialogColorButton color={cs().downColor} onColor={(c) => patchCandle({ downColor: c })} />
            </DialogRow>
            <div class="drawing-settings-row">
              <CheckboxRow checked={cs().drawBorder} onChange={(v) => patchCandle({ drawBorder: v })} label="Borders" />
              <div class="drawing-settings-row-inputs">
                <DialogColorButton color={cs().borderUpColor} onColor={(c) => patchCandle({ borderUpColor: c })} />
                <DialogColorButton color={cs().borderDownColor} onColor={(c) => patchCandle({ borderDownColor: c })} />
              </div>
            </div>
            <div class="drawing-settings-row">
              <CheckboxRow checked={cs().drawWick} onChange={(v) => patchCandle({ drawWick: v })} label="Wick" />
              <div class="drawing-settings-row-inputs">
                <DialogColorButton color={cs().wickColor} onColor={(c) => patchCandle({ wickColor: c })} />
              </div>
            </div>
            <DialogRow label="Transparency">
              <TransparencySlider value={st().transparency ?? 50} onChange={(t) => patchStyle({ transparency: t })} />
            </DialogRow>
          </>
        );
      }
      // Fib time zone / trend-based fib time "Labels": check box +
      // horizontal + vertical (not swapped: stored top = "Top").
      case "ftzLabels":
        return (
          <div class="drawing-settings-row">
            <CheckboxRow checked={st().showLabels !== false} onChange={(v) => patchStyle({ showLabels: v })} label="Labels" />
            <div class="drawing-settings-row-inputs">
              <Dropdown value={capitalize(st().horzLabelsAlign ?? "right")} options={["Left", "Center", "Right"]} onChange={(v) => patchStyle({ horzLabelsAlign: v.toLowerCase() as "left" | "center" | "right" })} />
              <Dropdown value={capitalize(st().vertLabelsAlign ?? "bottom")} options={["Top", "Middle", "Bottom"]} onChange={(v) => patchStyle({ vertLabelsAlign: v.toLowerCase() as "top" | "middle" | "bottom" })} />
            </div>
          </div>
        );
      // Price note Style: Label text (colour, size, B, I), Label
      // background, Label border, Line color.
      case "priceNote":
        return (
          <>
            <DialogRow label="Label text">
              <div class="drawing-settings-text-format">
                <DialogColorButton color={st().priceLabelTextColor ?? "#ffffff"} onColor={(c) => patchStyle({ priceLabelTextColor: c })} />
                <Dropdown value={String(st().priceLabelFontSize ?? 12)} options={FONT_SIZES} onChange={(v) => patchStyle({ priceLabelFontSize: Number(v) })} />
                <FontStyleToggles bold={!!st().priceLabelBold} italic={!!st().priceLabelItalic} onBold={(v) => patchStyle({ priceLabelBold: v })} onItalic={(v) => patchStyle({ priceLabelItalic: v })} />
              </div>
            </DialogRow>
            <DialogRow label="Label background">
              <DialogColorButton color={st().priceLabelBackgroundColor ?? "#2962ff"} onColor={(c) => patchStyle({ priceLabelBackgroundColor: c })} />
            </DialogRow>
            <DialogRow label="Label border">
              <DialogColorButton color={st().priceLabelBorderColor ?? "#2962ff"} onColor={(c) => patchStyle({ priceLabelBorderColor: c })} />
            </DialogRow>
            <DialogRow label="Line color">
              <DialogColorButton color={st().color} onColor={(c) => patchStyle({ color: c })} />
            </DialogRow>
          </>
        );
      // Long / short position Style: Lines, Stop / Target color, Text,
      // Price labels, Info (Stats, Compact stats mode, Always show stats).
      case "position":
        return (
          <>
            <DialogRow label="Lines">
              <ColorThicknessPicker color={st().color} width={st().width} onColor={(c) => patchStyle({ color: c })} onWidth={(w) => patchStyle({ width: w })} />
            </DialogRow>
            <For each={[["Stop color", "stopColor", "stopTransparency", "#f23645"], ["Target color", "targetColor", "targetTransparency", "#089981"]] as const}>
              {([title, ck, tk, dflt]) => (
                <DialogRow label={title}>
                  <DialogColorButton
                    color={applyOpacity(parseColor(st()[ck] ?? dflt).hex, 100 - (st()[tk] ?? 80))}
                    onColor={(c) => {
                      const pc = parseColor(c);
                      patchStyle({ [ck]: pc.hex, [tk]: 100 - pc.opacity } as Partial<DrawingStyle>);
                    }}
                  />
                </DialogRow>
              )}
            </For>
            <DialogRow label="Text">
              <div class="drawing-settings-text-format">
                <DialogColorButton color={st().textColor ?? "#ffffff"} onColor={(c) => patchStyle({ textColor: c })} />
                <Dropdown value={String(st().fontSize ?? 12)} options={FONT_SIZES} onChange={(v) => patchStyle({ fontSize: Number(v) })} />
              </div>
            </DialogRow>
            <CheckboxRow checked={st().showPriceLabels !== false} onChange={(v) => patchStyle({ showPriceLabels: v })} label="Price labels" />
            <div class="drawing-settings-section-title">INFO</div>
            <DialogRow label="Stats">
              <StatsMultiSelect
                fields={POSITION_STATS.map(([k, t]) => [k, t] as const)}
                isOn={(k) => positionStatOn(st(), k as PositionStatKey)}
                onToggle={(k, v) => patchStyle({ positionStats: { ...st().positionStats, [k]: v } })}
              />
            </DialogRow>
            <CheckboxRow checked={!!st().compactStats} onChange={(v) => patchStyle({ compactStats: v })} label="Compact stats mode" />
            <CheckboxRow checked={!!st().showStats} onChange={(v) => patchStyle({ showStats: v })} label="Always show stats" />
            <div class="drawing-settings-group-sep" />
          </>
        );
      // Flat top/bottom, disjoint channel: [x] Prices (colour, size, B, I).
      case "channelPrices":
        return (
          <div class="drawing-settings-row">
            <CheckboxRow checked={!!st().showPrices} onChange={(v) => patchStyle({ showPrices: v })} label="Prices" />
            <div class="drawing-settings-row-inputs drawing-settings-text-format">
              <DialogColorButton color={st().priceLabelTextColor ?? st().color} onColor={(c) => patchStyle({ priceLabelTextColor: c })} />
              <Dropdown value={String(st().priceLabelFontSize ?? 12)} options={FONT_SIZES} onChange={(v) => patchStyle({ priceLabelFontSize: Number(v) })} />
              <FontStyleToggles bold={!!st().priceLabelBold} italic={!!st().priceLabelItalic} onBold={(v) => patchStyle({ priceLabelBold: v })} onItalic={(v) => patchStyle({ priceLabelItalic: v })} />
            </div>
          </div>
        );
      // Range tools: Extend = a list of two checks (price range left /
      // right, date range top / bottom; "Don't extend" when none).
      case "rangeExtend": {
        const fields: [string, string][] = kind() === "date-range" ? [["extendTop", "Extend top"], ["extendBottom", "Extend bottom"]] : [["extendLeft", "Extend left"], ["extendRight", "Extend right"]];
        return (
          <DialogRow label="Extend">
            <StatsMultiSelect fields={fields} emptyLabel="Don't extend" isOn={(k) => !!st()[k as keyof DrawingStyle]} onToggle={(k, v) => patchStyle({ [k]: v } as Partial<DrawingStyle>)} />
          </DialogRow>
        );
      }
      // Range tools Info: Stats (price range: Price range, Percent change,
      // Change in pips; date range: Bars range, Date/time range, Volume;
      // date and price range: all six; factory all on).
      case "rangeStats": {
        const price: [string, string][] = [["showPriceRange", "Price range"], ["showPercentPriceRange", "Percent change"], ["showPipsPriceRange", "Change in pips"]];
        const date: [string, string][] = [["showBarsRange", "Bars range"], ["showDateTimeRange", "Date/time range"], ["showVolume", "Volume"]];
        const fields = kind() === "price-range" ? price : kind() === "date-range" ? date : [...price, ...date];
        return (
          <>
            <div class="drawing-settings-section-title">Info</div>
            <DialogRow label="Stats">
              <StatsMultiSelect fields={fields} isOn={(k) => st()[k as keyof DrawingStyle] !== false} onToggle={(k, v) => patchStyle({ [k]: v } as Partial<DrawingStyle>)} />
            </DialogRow>
          </>
        );
      }
      // Range tools: Label (colour + size), [x] Label background.
      case "rangeLabel":
        return (
          <>
            <DialogRow label="Label">
              <DialogColorButton color={st().textColor ?? "#ffffff"} onColor={(c) => patchStyle({ textColor: c })} />
              <Dropdown value={String(st().fontSize ?? 12)} options={FONT_SIZES} onChange={(v) => patchStyle({ fontSize: Number(v) })} />
            </DialogRow>
            <div class="drawing-settings-row">
              <CheckboxRow checked={st().fillLabelBackground !== false} onChange={(v) => patchStyle({ fillLabelBackground: v })} label="Label background" />
              <div class="drawing-settings-row-inputs">
                <DialogColorButton color={st().labelBackgroundColor ?? "#2e2e2e"} onColor={(c) => patchStyle({ labelBackgroundColor: c })} />
              </div>
            </div>
            <div class="drawing-settings-group-sep" />
          </>
        );
      // Date and price range: [x] Border (colour + width; factory off,
      // ot-blue-500, 1px).
      case "rangeBorder":
        return (
          <div class="drawing-settings-row">
            <CheckboxRow checked={!!st().drawBorder} onChange={(v) => patchStyle({ drawBorder: v })} label="Border" />
            <div class="drawing-settings-row-inputs">
              <ColorThicknessPicker color={st().borderColor ?? st().color} width={st().borderWidth ?? 1} onColor={(c) => patchStyle({ borderColor: c })} onWidth={(w) => patchStyle({ borderWidth: w })} />
            </div>
          </div>
        );
      // Signpost Style: [x] Emoji pin (showImage) + the plate colour.
      case "emojiPin":
        return (
          <div class="drawing-settings-row">
            <CheckboxRow checked={!!st().showImage} onChange={(v) => patchStyle({ showImage: v })} label="Emoji pin" />
            <div class="drawing-settings-row-inputs">
              <DialogColorButton color={st().plateColor ?? "#2962ff"} onColor={(c) => patchStyle({ plateColor: c })} />
            </div>
          </div>
        );
      // Note Style: [x] Label background, [x] Label
      // border, Line color.
      case "noteLabel":
        return (
          <>
            <div class="drawing-settings-row">
              <CheckboxRow checked={st().fillBackground !== false} onChange={(v) => patchStyle({ fillBackground: v })} label="Label background" />
              <div class="drawing-settings-row-inputs">
                <DialogColorButton color={st().backgroundColor ?? "#2e2e2e"} onColor={(c) => patchStyle({ backgroundColor: c })} />
              </div>
            </div>
            <div class="drawing-settings-row">
              <CheckboxRow checked={!!st().drawBorder} onChange={(v) => patchStyle({ drawBorder: v })} label="Label border" />
              <div class="drawing-settings-row-inputs">
                <DialogColorButton color={st().borderColor ?? "#4a4a4a"} onColor={(c) => patchStyle({ borderColor: c })} />
              </div>
            </div>
            <DialogRow label="Line color">
              <DialogColorButton color={st().color} onColor={(c) => patchStyle({ color: c })} />
            </DialogRow>
          </>
        );
      // Price label Style: Text (colour + size), Background (its opacity =
      // transparency), Border.
      case "priceLabelTool":
        return (
          <>
            <DialogRow label="Text">
              <DialogColorButton color={st().textColor ?? "#ffffff"} onColor={(c) => patchStyle({ textColor: c })} />
              <Dropdown value={String(st().fontSize ?? 14)} options={FONT_SIZES} onChange={(v) => patchStyle({ fontSize: Number(v) })} />
            </DialogRow>
            <DialogRow label="Background">
              <DialogColorButton
                color={applyOpacity(parseColor(st().backgroundColor ?? st().color).hex, 100 - (st().transparency ?? 0))}
                onColor={(c) => {
                  const pc = parseColor(c);
                  patchStyle({ backgroundColor: pc.hex, transparency: 100 - pc.opacity });
                }}
              />
            </DialogRow>
            <DialogRow label="Border">
              <DialogColorButton color={st().borderColor ?? st().color} onColor={(c) => patchStyle({ borderColor: c })} />
            </DialogRow>
          </>
        );
      default:
        return null;
    }
  }

  // Title rename (pencil): the field replaces the title and the close
  // button with the whole name selected; Enter or leaving the field saves,
  // Escape cancels, an empty name keeps the old one.
  const [renaming, setRenaming] = createSignal(false);
  const displayName = () => props.drawing.name ?? labelForKind(props.drawing.kind);
  let renameCancelled = false;
  const endRename = (save: boolean, value: string) => {
    if (!renaming()) return;
    setRenaming(false);
    const v = value.trim();
    if (!save || !v || v === displayName()) return;
    props.onUpdate({ ...props.drawing, name: v !== labelForKind(props.drawing.kind) ? v : undefined } as Drawing);
  };

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (renaming()) { renameCancelled = true; setRenaming(false); return; }
        // Escape unwinds one layer at a time. The footer Template menu and any
        // open nested popover (colour panel / Stats checklist) each own their
        // own Escape dismissal — defer to them and only close the bare dialog.
        if (templatesOpen()) { setTemplatesOpen(false); return; }
        if (document.querySelector(".dlg-color-panel, .drawing-settings-multiselect-menu")) return;
        props.onClose();
      }
    };
    // Capture phase so the overlay's own Escape handler doesn't fire first.
    window.addEventListener("keydown", onKey, true);
    // Outside-click closes the template menu (capture, since the dialog stops
    // bubble-phase clicks at its root).
    const onDocClick = (e: MouseEvent) => {
      if (!templatesOpen()) return;
      const t = e.target as Node | null;
      if (t && footerTemplateEl?.contains(t)) return;
      setTemplatesOpen(false);
    };
    document.addEventListener("click", onDocClick, true);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("click", onDocClick, true);
    });
  });

  return (
    <div
      class="drawing-settings-backdrop"
      role="presentation"
      onClick={props.onClose}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        class="drawing-settings-dialog"
        role="dialog"
        aria-label={displayName()}
        data-name="source-properties-editor"
        onClick={(e) => e.stopPropagation()}
      >
        <header class="drawing-settings-header">
          <Show
            when={!renaming()}
            fallback={
              <input
                type="text"
                class="drawing-settings-rename"
                aria-label="Drawing name"
                value={displayName()}
                ref={(el) => queueMicrotask(() => { el.focus(); el.select(); })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); endRename(true, e.currentTarget.value); }
                }}
                onBlur={(e) => {
                  const cancelled = renameCancelled;
                  renameCancelled = false;
                  endRename(!cancelled, e.currentTarget.value);
                }}
              />
            }
          >
            <div class="drawing-settings-title">
              <span class="drawing-settings-title-text">{displayName()}</span>
              <button type="button" class="drawing-settings-edit" data-name="edit" aria-label="Rename" onClick={() => { renameCancelled = false; setRenaming(true); }}>
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28"><path fill="currentColor" d="M16.73 6.56a2.5 2.5 0 0 1 3.54 0l1.17 1.17a2.5 2.5 0 0 1 0 3.54l-.59.58-9 9-1 1-.14.15H6v-4.7l.15-.15 1-1 9-9 .58-.59Zm2.83.7a1.5 1.5 0 0 0-2.12 0l-.23.24 3.29 3.3.23-.24a1.5 1.5 0 0 0 0-2.12l-1.17-1.17Zm.23 4.24L16.5 8.2l-8.3 8.3 3.3 3.3 8.3-8.3Zm-9 9L7.5 17.2l-.5.5V21h3.3l.5-.5Z" /></svg>
              </button>
            </div>
            <button type="button" aria-label="Close" data-qa-id="close" class="drawing-settings-close" onClick={props.onClose}>
              <svg viewBox="0 0 18 18" width="18" height="18">
                <path stroke="currentColor" stroke-width="1.2" d="m1.5 1.5 15 15m0-15-15 15" />
              </svg>
            </button>
          </Show>
        </header>

        <nav class="drawing-settings-tabs" role="tablist" aria-orientation="horizontal">
          <For each={dialogTabs()}>
            {(tab) => (
              <button
                type="button"
                role="tab"
                aria-selected={activeTab() === tab}
                class={"drawing-settings-tab" + (activeTab() === tab ? " selected" : "")}
                onClick={() => setActiveTab(tab)}
              >
                {tab}
              </button>
            )}
          </For>
        </nav>

        <div class="drawing-settings-body" role="tabpanel">
          <Show when={activeTab() === "Inputs"}>
            {/* Regression trend Inputs: Upper / Lower Deviation. */}
            <Show when={kind() === "regression-trend"}>
              <DialogRow label="Upper Deviation">
                <DecimalInput narrow value={props.drawing.style.upperDeviation ?? 2} onCommit={(v) => patchStyle({ upperDeviation: v })} />
              </DialogRow>
              <DialogRow label="Lower Deviation">
                <DecimalInput narrow value={props.drawing.style.lowerDeviation ?? -2} onCommit={(v) => patchStyle({ lowerDeviation: v })} />
              </DialogRow>
              <CheckboxRow
                label="Use Upper Deviation"
                checked={props.drawing.style.useUpperDeviation !== false}
                onChange={(v) => patchStyle({ useUpperDeviation: v })}
              />
              <CheckboxRow
                label="Use Lower Deviation"
                checked={props.drawing.style.useLowerDeviation !== false}
                onChange={(v) => patchStyle({ useLowerDeviation: v })}
              />
              <DialogRow label="Source">
                <Dropdown
                  value={PRICE_SOURCE_LABELS[props.drawing.style.regressionSource ?? "close"]}
                  options={VWAP_SOURCES.map((k) => PRICE_SOURCE_LABELS[k])}
                  onChange={(v) => {
                    const k = VWAP_SOURCES.find((x) => PRICE_SOURCE_LABELS[x] === v);
                    if (k) patchStyle({ regressionSource: k });
                  }}
                />
              </DialogRow>
            </Show>
            {/* Position tool: the risk model feeding the Qty readout
                (qty = accountSize · risk% / stop distance). */}
            <Show when={POSITION_KINDS.has(kind())}>
              <DialogRow label="Account size">
                <DecimalInput
                  value={props.drawing.style.accountSize ?? POSITION_DEFAULTS.accountSize}
                  onCommit={(v) => patchStyle({ accountSize: Math.min(1e9, Math.max(1e-9, v)) })}
                />
              </DialogRow>
              {/* Lot size: the displayed Qty = risk units / lot size. */}
              <DialogRow label="Lot size">
                <DecimalInput
                  value={props.drawing.style.lotSize ?? POSITION_DEFAULTS.lotSize}
                  onCommit={(v) => patchStyle({ lotSize: Math.min(1e8, Math.max(1e-9, v)) })}
                />
              </DialogRow>
              {/* Risk: value + unit select (% / symbol currency); percent
                  mode 0.01 step, 2 decimals, max 100; money mode step 1,
                  capped at the account size. */}
              <DialogRow label="Risk">
                <Show
                  when={props.drawing.style.riskDisplayMode === "money"}
                  fallback={
                    <DecimalInput
                      value={props.drawing.style.riskPercent ?? POSITION_DEFAULTS.risk}
                      digits={2}
                      onCommit={(v) => patchStyle({ riskPercent: Math.min(100, Math.max(1e-9, v)) })}
                    />
                  }
                >
                  <DecimalInput
                    value={positionRiskSize(props.drawing.style)}
                    onCommit={(v) => {
                      const account = props.drawing.style.accountSize ?? POSITION_DEFAULTS.accountSize;
                      patchStyle({ riskAmount: Math.min(account, Math.max(1e-9, v)) });
                    }}
                  />
                </Show>
                <Dropdown
                  value={props.drawing.style.riskDisplayMode === "money" ? moneyUnit() : "%"}
                  options={["%", moneyUnit()]}
                  onChange={(v) => setRiskMode(v === "%" ? "percents" : "money")}
                />
              </DialogRow>
              <DialogRow label="Entry price">
                <DecimalInput value={props.drawing.points[0]?.price ?? 0} digits={priceDigits()} onCommit={setEntryPrice} />
              </DialogRow>
              <DialogRow label="Leverage">
                <DecimalInput
                  value={props.drawing.style.leverage ?? POSITION_DEFAULTS.leverage}
                  digits={1}
                  onCommit={(v) => patchStyle({ leverage: Math.min(10000, Math.max(1, v)) })}
                />
              </DialogRow>
              {/* Profit / stop level: ticks from the entry and the price;
                  a typed price is rounded to the tick and kept one tick past
                  the entry. */}
              <div class="drawing-settings-group-sep" />
              <For each={["profit", "stop"] as const}>
                {(leg) => {
                  const level = () => (leg === "profit" ? posLevels().profit : posLevels().stop);
                  const setLevel = (lvl: number) => patchStyle(leg === "profit" ? { profitLevel: lvl } : { stopLevel: lvl });
                  const legSign = () => (leg === "profit" ? posSide() : -posSide());
                  return (
                    <>
                      <div class="drawing-settings-section-title">{leg === "profit" ? "PROFIT LEVEL" : "STOP LEVEL"}</div>
                      <DialogRow label="Ticks">
                        <DecimalInput value={Math.round(level() / pip())} onCommit={(v) => setLevel(Math.min(1e9, Math.max(0, Math.round(v))) * pip())} />
                      </DialogRow>
                      <DialogRow label="Price">
                        <DecimalInput
                          value={(props.drawing.points[0]?.price ?? 0) + legSign() * level()}
                          digits={priceDigits()}
                          onCommit={(v) => {
                            const entry = props.drawing.points[0]?.price;
                            if (entry != null) setLevel(levelFromPrice(v, entry, pip(), posSide(), leg));
                          }}
                        />
                      </DialogRow>
                      <div class="drawing-settings-group-sep" />
                    </>
                  );
                }}
              </For>
              <DialogRow label="QTY precision">
                <Dropdown
                  value={QTY_PRECISION_OPTIONS.find((o) => o.value === (props.drawing.style.qtyPrecision ?? "default"))?.label ?? "Default"}
                  options={QTY_PRECISION_OPTIONS.map((o) => o.label)}
                  onChange={(v) => {
                    const o = QTY_PRECISION_OPTIONS.find((x) => x.label === v);
                    if (o) patchStyle({ qtyPrecision: o.value });
                  }}
                />
              </DialogRow>
              <div class="drawing-settings-group-sep" />
            </Show>
            {/* Anchored VWAP Inputs: BANDS SETTINGS, Bands Calculation Mode
                (+ info tooltip), "Bands Multiplier
                #k" = band computed checkbox + multiplier, then Source. */}
            <Show when={kind() === "anchored-vwap"}>
              {/* Study Inputs page: the group title is a 50 px row. */}
              <div class="drawing-settings-section-title tall">BANDS SETTINGS</div>
              <DialogRow label="Bands Calculation Mode">
                <Dropdown
                  value={props.drawing.style.vwapBandsMode === "percent" ? "Percentage" : "Standard Deviation"}
                  options={["Standard Deviation", "Percentage"]}
                  onChange={(v) => patchStyle({ vwapBandsMode: v === "Percentage" ? "percent" : "stdev" })}
                />
                <span class="drawing-settings-info" title="Determines the units used to calculate the distance of the bands. When 'Percentage' is selected, a multiplier of 1 means 1%.">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18"><path fill="currentColor" d="M9 17A8 8 0 1 0 9 1a8 8 0 0 0 0 16Zm1-12a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM8.5 9.5H7V8h3v6H8.5V9.5Z" /></svg>
                </span>
              </DialogRow>
              <For each={props.drawing.style.levels ?? VWAP_BAND_DEFAULTS}>
                {(lvl, i) => {
                  const patchBand = (patch: Partial<LevelDef>) => {
                    const cur = (props.drawing.style.levels ?? VWAP_BAND_DEFAULTS).map((l) => ({ ...l }));
                    cur[i()] = { ...cur[i()], ...patch };
                    patchStyle({ levels: cur });
                  };
                  return (
                    <div class="drawing-settings-row">
                      <CheckboxRow checked={lvl.visible} onChange={(v) => patchBand({ visible: v })} label={`Bands Multiplier #${i() + 1}`} />
                      <div class="drawing-settings-row-inputs">
                        <DecimalInput narrow value={lvl.coeff} onCommit={(v) => patchBand({ coeff: v })} />
                      </div>
                    </div>
                  );
                }}
              </For>
            {/* Anchored VWAP source (study input; hlc3 factory); a new
                group. */}
              <div class="drawing-settings-group-sep" />
              <DialogRow label="Source">
                <Dropdown
                  value={PRICE_SOURCE_LABELS[props.drawing.style.vwapSource ?? "hlc3"]}
                  options={VWAP_SOURCES.map((k) => PRICE_SOURCE_LABELS[k])}
                  onChange={(v) => {
                    const k = VWAP_SOURCES.find((x) => PRICE_SOURCE_LABELS[x] === v);
                    if (k) patchStyle({ vwapSource: k });
                  }}
                />
              </DialogRow>
            </Show>
            {/* Ghost feed Inputs: "Avg HL in minticks" (integer 1-50000,
                the frozen candle amplitude in ticks) and "Variance" (1-100). */}
            <Show when={kind() === "ghost-feed"}>
              <DialogRow label="Avg HL in minticks">
                <input
                  class="drawing-settings-level-coeff"
                  type="number"
                  min="1"
                  max="50000"
                  step="1"
                  value={Math.round((props.drawing.ghost?.amplitude ?? 0) / (props.coords?.pipSize() ?? 0.01))}
                  onChange={(e) => {
                    const v = Math.round(Number(e.currentTarget.value));
                    if (!Number.isFinite(v) || v < 1 || v > 50000 || !props.drawing.ghost) return;
                    props.onUpdate({ ...props.drawing, ghost: { ...props.drawing.ghost, amplitude: v * (props.coords?.pipSize() ?? 0.01) } } as Drawing);
                  }}
                />
              </DialogRow>
              <DialogRow label="Variance">
                <input
                  class="drawing-settings-level-coeff"
                  type="number"
                  min="1"
                  max="100"
                  step="1"
                  value={props.drawing.style.variance ?? 50}
                  onChange={(e) => {
                    const v = Math.round(Number(e.currentTarget.value));
                    if (Number.isFinite(v) && v >= 1 && v <= 100) patchStyle({ variance: v });
                  }}
                />
              </DialogRow>
            </Show>
          </Show>

          <Show when={activeTab() === "Style"}>
            {/* Style page: the rows of each tool in display order
                (STYLE_ROWS). */}
            <For each={styleRowsFor(kind())}>{(id) => styleRow(id)}</For>
          </Show>

          <Show when={activeTab() === "Text"}>
            <Show
              when={TEXT_KINDS.has(kind())}
              fallback={<div class="drawing-settings-section-title">No text options for this drawing.</div>}
            >
              {/* Formatting toolbar — colour, font size, bold, italic — sits
                  ABOVE the text box (text-properties layout). Single
                  no-wrap row so "Font size" never breaks onto two lines. */}
              <div class="drawing-settings-text-format">
                <Show when={kind() === "note" || kind() === "comment"}>
                  <span class="drawing-settings-row-label">Text</span>
                </Show>
                <Show when={kind() !== "signpost"}>
                  <DialogColorButton color={textColorValue()} onColor={setTextColor} />
                </Show>
                <Dropdown
                  value={String(textSize())}
                  options={FONT_SIZES}
                  onChange={(v) => setTextSize(Number(v))}
                />
                <Show when={kind() !== "comment"}>
                  <FontStyleToggles bold={textBold()} italic={textItalic()} onBold={() => toggleBold()} onItalic={() => toggleItalic()} />
                </Show>
              </div>
              {/* Text box: 9 lines for the Text and Callout tools, 5 for
                  the others. */}
              <textarea
                class={"drawing-settings-textarea" + (kind() === "text" || kind() === "callout" ? " tall" : "")}
                rows={kind() === "text" || kind() === "callout" ? 9 : 5}
                placeholder="Add text"
                value={textValue()}
                onInput={(e) => setText(e.currentTarget.value)}
              />
              {/* arrow-marker anchors its text to the arrow direction — no
                  alignment options. */}
              <Show when={(LINE_LABEL_KINDS.has(kind()) && kind() !== "arrow-marker") || kind() === "price-note" || kind() === "rectangle"}>
                <DialogRow label="Text alignment">
                  <Dropdown
                    value={vertTitle(props.drawing.style.vertLabelsAlign ?? labelVertDefault(kind()), kind())}
                    options={["Top", kind() === "rectangle" ? "Inside" : "Middle", "Bottom"]}
                    onChange={(v) => patchStyle({ vertLabelsAlign: vertAlignFromTitle(v) })}
                  />
                  <Dropdown
                    value={capitalize(props.drawing.style.horzLabelsAlign ?? "center")}
                    options={["Left", "Center", "Right"]}
                    onChange={(v) => patchStyle({ horzLabelsAlign: v.toLowerCase() as "left" | "center" | "right" })}
                  />
                </DialogRow>
              </Show>
              {/* Vertical line "Text orientation" (factory Vertical). */}
              <Show when={kind() === "vertical-line"}>
                <DialogRow label="Text orientation">
                  <Dropdown
                    value={props.drawing.style.textOrientation === "horizontal" ? "Horizontal" : "Vertical"}
                    options={["Vertical", "Horizontal"]}
                    onChange={(v) => patchStyle({ textOrientation: v === "Horizontal" ? "horizontal" : "vertical" })}
                  />
                </DialogRow>
              </Show>
            </Show>
          </Show>

          {/* Text tools, Text page rows after the text:
              text = [x] Background, [x] Border, [x] Text wrap; callout =
              Background, Border (colour + width), [x] Text wrap; comment =
              Background, Border; pin = [x] Background, [x] Border. */}
          <Show when={activeTab() === "Text" && TEXT_BOX_KINDS.has(kind())}>
            {(() => {
              const st = () => props.drawing.style;
              const bgColor = () => applyOpacity(parseColor(st().backgroundColor ?? (kind() === "callout" ? st().color : "#2962ff")).hex, 100 - (st().transparency ?? TEXT_BOX_TRANSPARENCY[kind()] ?? 0));
              const setBg = (c: string) => {
                const pc = parseColor(c);
                patchStyle({ backgroundColor: pc.hex, transparency: 100 - pc.opacity });
              };
              const checked = kind() === "text" || kind() === "pin";
              return (
                <>
                  <div class="drawing-settings-row">
                    <Show when={checked} fallback={<div class="drawing-settings-row-label">Background</div>}>
                      <CheckboxRow checked={kind() === "pin" ? st().fillBackground !== false : !!st().fillBackground} onChange={(v) => patchStyle({ fillBackground: v })} label="Background" />
                    </Show>
                    <div class="drawing-settings-row-inputs">
                      <DialogColorButton color={bgColor()} onColor={setBg} />
                    </div>
                  </div>
                  <div class="drawing-settings-row">
                    <Show when={checked} fallback={<div class="drawing-settings-row-label">Border</div>}>
                      <CheckboxRow checked={!!st().drawBorder} onChange={(v) => patchStyle({ drawBorder: v })} label="Border" />
                    </Show>
                    <div class="drawing-settings-row-inputs">
                      <Show
                        when={kind() === "callout"}
                        fallback={<DialogColorButton color={st().borderColor ?? TEXT_BORDER_DEFAULT[kind()] ?? st().color} onColor={(c) => patchStyle({ borderColor: c })} />}
                      >
                        <ColorThicknessPicker color={st().borderColor ?? st().color} width={st().width} onColor={(c) => patchStyle({ borderColor: c })} onWidth={(w) => patchStyle({ width: w })} />
                      </Show>
                    </div>
                  </div>
                  <Show when={kind() === "text" || kind() === "callout"}>
                    <CheckboxRow checked={!!st().wordWrap} onChange={(v) => patchStyle({ wordWrap: v })} label="Text wrap" />
                  </Show>
                </>
              );
            })()}
          </Show>

          <Show when={activeTab() === "Coordinates"}>
            {/* One row per anchor, "#N (price, bar)" then its inputs.
                Variants: horizontal line price only, vertical line
                and regression trend bar only, trend angle #1 + "Angle",
                parallel channel #1, #2 + "Price offset". */}
            <For each={coordPoints()}>
              {(pt, i) => {
                const mode = () => COORD_MODES[kind()] ?? "price, bar";
                return (
                  <div class="drawing-settings-row">
                    <div class="drawing-settings-row-label drawing-settings-coord-label">
                      #{i() + 1} ({mode()})
                    </div>
                    <div class="drawing-settings-row-inputs">
                      <Show when={mode() === "vertical position %, bar"}>
                        <DecimalInput
                          digits={2}
                          value={Math.abs(props.drawing.style.signpostPosition ?? 50)}
                          onCommit={(v) => {
                            const sign = (props.drawing.style.signpostPosition ?? 50) < 0 ? -1 : 1;
                            patchStyle({ signpostPosition: sign * Math.max(0, Math.min(100, v)) });
                          }}
                        />
                      </Show>
                      <Show when={mode() !== "bar" && mode() !== "vertical position %, bar"}>
                        <input
                          type="text"
                          class="drawing-settings-input"
                          aria-label={`Point ${i() + 1} price`}
                          value={pt.price.toFixed(2)}
                          onChange={(e) => {
                            const v = parseFloat(e.currentTarget.value);
                            if (Number.isFinite(v)) updatePoint(i(), { price: v });
                            else e.currentTarget.value = pt.price.toFixed(2);
                          }}
                        />
                      </Show>
                      <Show when={mode() !== "price"}>
                        <input
                          type="text"
                          class="drawing-settings-input"
                          aria-label={`Point ${i() + 1} bar`}
                          disabled={!props.coords}
                          value={barIndexOf(pt.time)}
                          onChange={(e) => {
                            const n = parseInt(e.currentTarget.value, 10);
                            const t = Number.isFinite(n) ? props.coords?.barIndexToTime(n) : null;
                            if (t != null) updatePoint(i(), { time: t });
                            else e.currentTarget.value = barIndexOf(pt.time);
                          }}
                        />
                      </Show>
                    </div>
                  </div>
                );
              }}
            </For>
            {/* Parallel channel "Price offset": the second line's price
                distance (OpenTrader p2 sits at p0's time). */}
            <Show when={kind() === "parallel-channel" && props.drawing.points[2]}>
              <DialogRow label="Price offset">
                <DecimalInput
                  digits={2}
                  value={(props.drawing.points[2]?.price ?? 0) - props.drawing.points[0].price}
                  onCommit={(v) => updatePoint(2, { price: props.drawing.points[0].price + v })}
                />
              </DialogRow>
            </Show>
            {/* Trend angle "Angle": turns p1 around p0 in screen space,
                keeping the length. */}
            <Show when={kind() === "trend-angle"}>
              <DialogRow label="Angle">
                <DecimalInput digits={2} value={trendAngleValue()} onCommit={setTrendAngle} />
              </DialogRow>
            </Show>
          </Show>

          <Show when={activeTab() === "Visibility"}>
            {/* Matrix: checkbox + from/to inputs per unit row; Ticks and
                Ranges carry the checkbox only. 50px row pitch, 70×28 inputs.
                Lock/Hide moved out (toolbar + context menu). */}
            <CheckboxRow
              checked={vis().ticks}
              onChange={(v) => patchVisibility({ ticks: v })}
              label="Ticks"
            />
            <For
              each={[
                ["seconds", "Seconds", 59],
                ["minutes", "Minutes", 59],
                ["hours", "Hours", 24],
                ["days", "Days", 366],
                ["weeks", "Weeks", 52],
                ["months", "Months", 12],
              ] as ReadonlyArray<readonly [keyof IntervalVisibility, string, number]>}
            >
              {([key, label, max]) => (
                <UnitVisibilityRow
                  label={label}
                  max={max}
                  unit={vis()[key] as UnitVisibility}
                  onChange={(u) => patchVisibility({ [key]: u } as Partial<IntervalVisibility>)}
                />
              )}
            </For>
            <CheckboxRow
              checked={vis().ranges}
              onChange={(v) => patchVisibility({ ranges: v })}
              label="Ranges"
            />
          </Show>
        </div>

        <footer class="drawing-settings-footer">
          {/* Template dropdown — save the current style as a named template,
              apply a saved one, or reset to the kind's defaults (footer
              "Template" control). Opens upward (footer is at the bottom). */}
          <div class="drawing-settings-footer-template" ref={footerTemplateEl}>
            <button
              type="button"
              class="drawing-settings-template-btn"
              aria-haspopup="menu"
              aria-expanded={templatesOpen()}
              onClick={() => setTemplatesOpen((o) => !o)}
            >
              Template
              <span class="drawing-settings-chevron"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3.92 7.83 9 12.29l5.08-4.46-1-1.13L9 10.29l-4.09-3.6-.99 1.14Z" /></svg></span>
            </button>
            <Show when={templatesOpen()}>
              <TemplatesMenu
                variant="dialog"
                kind={props.drawing.kind}
                getTemplate={() => ({ style: props.drawing.style, text: (props.drawing as { text?: string }).text })}
                // A saved template over the factory style (+ text of text tools).
                onApply={(tpl) =>
                  props.onUpdate({
                    ...props.drawing,
                    style: { ...factoryStyleFor(props.drawing.kind), ...tpl.style },
                    ...(tpl.text !== undefined ? { text: tpl.text } : {}),
                  } as Drawing)
                }
                // "Apply defaults" = factory style; the tool's saved default is
                // cleared.
                onApplyDefault={() => {
                  clearKindDefault(props.drawing.kind);
                  props.onUpdate({ ...props.drawing, style: factoryStyleFor(props.drawing.kind) } as Drawing);
                }}
                onClose={() => setTemplatesOpen(false)}
              />
            </Show>
          </div>
          <div class="drawing-settings-footer-buttons">
            <button
              type="button"
              name="cancel"
              class="drawing-settings-btn secondary"
              onClick={props.onClose}
            >
              Cancel
            </button>
            <button
              type="button"
              name="submit"
              data-name="submit-button"
              class="drawing-settings-btn primary"
              onClick={props.onClose}
            >
              Ok
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function DialogRow(props: { label?: string; children: import("solid-js").JSX.Element }) {
  return (
    <div class="drawing-settings-row">
      {props.label && <div class="drawing-settings-row-label">{props.label}</div>}
      <div class="drawing-settings-row-inputs">{props.children}</div>
    </div>
  );
}

/** Select: 100 px; `wide` = 180 px (Stats position), `mid` = 150 px
 *  (Elliott Degree). */
function Dropdown(props: { value: string; options: string[]; onChange: (v: string) => void; wide?: boolean; mid?: boolean }) {
  return (
    <select
      class={"drawing-settings-select" + (props.wide ? " wide" : props.mid ? " mid" : "")}
      value={props.value}
      onChange={(e) => props.onChange(e.currentTarget.value)}
    >
      <For each={props.options}>{(o) => <option value={o}>{o}</option>}</For>
    </select>
  );
}

/** Decimal field written with a dot and fixed decimals (a
 *  type="number" input would follow the system locale, e.g. "25,00").
 *  `digits` unset = the plain number ("0.382"). Invalid text reverts on
 *  commit. Every value field is 100 x 34 (`narrow` kept for callers). */
function DecimalInput(props: { value: number; digits?: number; narrow?: boolean; onCommit: (v: number) => void }) {
  const text = () => (props.digits == null ? String(props.value) : props.value.toFixed(props.digits));
  return (
    <input
      type="text"
      inputmode="decimal"
      class={"drawing-settings-level-coeff" + (props.narrow ? "" : " is-wide")}
      value={text()}
      onChange={(e) => {
        const v = parseFloat(e.currentTarget.value);
        if (Number.isFinite(v)) props.onCommit(v);
        else e.currentTarget.value = text();
      }}
    />
  );
}


/** Gann square / Gann square fixed Style page: LEVELS / FANS / ARCS grids (checkbox, title,
 *  colour + width; two columns), Use one color, Background (arcs fill +
 *  transparency), Reverse; Gann square adds Price/bar ratio (moves p1's
 *  price) and "Ranges and ratio" (labels on / size / B / I). */
function GannStyleRows(props: {
  drawing: Drawing;
  coords?: import("./coords").Coords | null;
  patchStyle: (p: Partial<DrawingStyle>) => void;
  onUpdate: (d: Drawing) => void;
}) {
  const st = () => props.drawing.style;
  const grid = <T extends GannLine>(key: "gannLevels" | "gannFans" | "gannArcs", list: () => T[], title: (l: T, i: number) => string) => (
    <div class="drawing-settings-levels two-col">
      <For each={list()}>
        {(l, i) => {
          const patch = (p: Partial<GannLine>) => {
            const cur = list().map((x) => ({ ...x }));
            cur[i()] = { ...cur[i()], ...p };
            props.patchStyle({ [key]: cur } as Partial<DrawingStyle>);
          };
          return (
            <div class={"drawing-settings-level-row" + (l.visible ? "" : " off")}>
              <CheckBox checked={l.visible} onChange={(v) => patch({ visible: v })} />
              <span class="drawing-settings-level-coeff is-fixed">{title(l, i())}</span>
              <ColorThicknessPicker color={l.color} width={l.width} onColor={(c) => patch({ color: c })} onWidth={(w) => patch({ width: w })} />
            </div>
          );
        }}
      </For>
    </div>
  );
  const levels = () => st().gannLevels ?? GANN_LEVEL_DEFAULTS;
  const fans = () => st().gannFans ?? GANN_FAN_DEFAULTS;
  const arcs = () => st().gannArcs ?? GANN_ARC_DEFAULTS;
  const ratio = (): number | null => {
    const c = props.coords;
    const [p0, p1] = props.drawing.points;
    if (!c || !p0 || !p1) return null;
    const i0 = c.timeToBarIndex(p0.time);
    const i1 = c.timeToBarIndex(p1.time);
    return i0 == null || i1 == null || i0 === i1 ? null : Math.abs((p1.price - p0.price) / (i1 - i0));
  };
  const setRatio = (v: number) => {
    const c = props.coords;
    const [p0, p1] = props.drawing.points;
    if (!c || !p0 || !p1 || !(v > 0)) return;
    const i0 = c.timeToBarIndex(p0.time);
    const i1 = c.timeToBarIndex(p1.time);
    if (i0 == null || i1 == null) return;
    const bars = Math.abs(i1 - i0);
    // Moves p1 (p0 when reversed), keeping its side of the other point.
    if (st().reverse) {
      const sign = p0.price - p1.price >= 0 ? 1 : -1;
      props.onUpdate({ ...props.drawing, points: [{ ...p0, price: p1.price + sign * bars * v }, p1] } as Drawing);
    } else {
      const sign = p1.price - p0.price >= 0 ? 1 : -1;
      props.onUpdate({ ...props.drawing, points: [p0, { ...p1, price: p0.price + sign * bars * v }] } as Drawing);
    }
  };
  const setReverse = (v: boolean) => {
    // Gann square fixed swaps its stored points; Gann square draws swapped.
    if (props.drawing.kind === "gann-square-fixed") {
      const [p0, p1] = props.drawing.points;
      props.onUpdate({ ...props.drawing, points: [p1, p0], style: { ...st(), reverse: v } } as Drawing);
    } else props.patchStyle({ reverse: v });
  };
  return (
    <>
      <div class="drawing-settings-section-title">LEVELS</div>
      {grid("gannLevels", levels, (_l, i) => String(i))}
      <div class="drawing-settings-group-sep" />
      <div class="drawing-settings-section-title">FANS</div>
      {grid("gannFans", fans, (l: GannRatioLine) => `${l.x}x${l.y}`)}
      <div class="drawing-settings-group-sep" />
      <div class="drawing-settings-section-title">ARCS</div>
      {grid("gannArcs", arcs, (l: GannRatioLine) => `${l.x}x${l.y}`)}
      <div class="drawing-settings-group-sep" />
      <DialogRow label="Use one color">
        <DialogColorButton
          color={levels()[0]?.color ?? "#808080"}
          onColor={(c) =>
            props.patchStyle({
              gannLevels: levels().map((l) => ({ ...l, color: c })),
              gannFans: fans().map((l) => ({ ...l, color: c })),
              gannArcs: arcs().map((l) => ({ ...l, color: c })),
            })
          }
        />
      </DialogRow>
      <div class="drawing-settings-row">
        <CheckboxRow checked={st().fillBackground !== false} onChange={(v) => props.patchStyle({ fillBackground: v })} label="Background" />
        <div class="drawing-settings-row-inputs">
          <TransparencySlider value={st().transparency ?? 80} onChange={(t) => props.patchStyle({ transparency: t })} />
        </div>
      </div>
      <CheckboxRow checked={!!st().reverse} onChange={setReverse} label="Reverse" />
      <Show when={props.drawing.kind === "gann-square"}>
        <DialogRow label="Price/bar ratio">
          <DecimalInput value={ratio() ?? 0} onCommit={setRatio} />
        </DialogRow>
        <div class="drawing-settings-row">
          <CheckboxRow checked={st().showLabels !== false} onChange={(v) => props.patchStyle({ showLabels: v })} label="Ranges and ratio" />
          <div class="drawing-settings-row-inputs drawing-settings-text-format">
            <Dropdown value={String(st().labelFontSize ?? 12)} options={FONT_SIZES} onChange={(v) => props.patchStyle({ labelFontSize: Number(v) })} />
            <button type="button" class={"drawing-settings-text-toggle" + (st().bold ? " active" : "")} style={{ "font-weight": 700 }} aria-pressed={!!st().bold} title="Bold" onClick={() => props.patchStyle({ bold: !st().bold })}>
              B
            </button>
            <button type="button" class={"drawing-settings-text-toggle" + (st().italic ? " active" : "")} style={{ "font-style": "italic" }} aria-pressed={!!st().italic} title="Italic" onClick={() => props.patchStyle({ italic: !st().italic })}>
              I
            </button>
          </div>
        </div>
      </Show>
    </>
  );
}

/** Gann box Style page: PRICE LEVELS grid (checkbox, value, colour; two columns), Left / Right
 *  labels, Background (+ transparency); TIME LEVELS grid, Top / Bottom
 *  labels, Background; Use one color (drawing, angles and every level
 *  colour); Angles (checkbox + colour); Reverse. */
function GannBoxStyleRows(props: { style: DrawingStyle; patchStyle: (p: Partial<DrawingStyle>) => void }) {
  const hLevels = () => props.style.levels ?? GANN_BOX_LEVEL_DEFAULTS;
  const vLevels = () => props.style.vLevels ?? GANN_BOX_LEVEL_DEFAULTS;
  const fans = () => props.style.fans ?? { visible: false, color: "#9C9C9C" };
  const grid = (key: "levels" | "vLevels", list: () => LevelDef[]) => (
    <div class="drawing-settings-levels two-col">
      <For each={list()}>
        {(lvl, i) => {
          const patch = (p: Partial<LevelDef>) => {
            const cur = list().map((l) => ({ ...l }));
            cur[i()] = { ...cur[i()], ...p };
            props.patchStyle({ [key]: cur } as Partial<DrawingStyle>);
          };
          return (
            <div class={"drawing-settings-level-row" + (lvl.visible ? "" : " off")}>
              <CheckBox checked={lvl.visible} onChange={(v) => patch({ visible: v })} />
              <DecimalInput narrow value={lvl.coeff} onCommit={(v) => patch({ coeff: v })} />
              <DialogColorButton color={lvl.color} onColor={(c) => patch({ color: c })} />
            </div>
          );
        }}
      </For>
    </div>
  );
  const background = (on: boolean, t: number, onOn: (v: boolean) => void, onT: (t: number) => void) => (
    <div class="drawing-settings-row">
      <CheckboxRow checked={on} onChange={onOn} label="Background" />
      <div class="drawing-settings-row-inputs">
        <TransparencySlider value={t} onChange={onT} />
      </div>
    </div>
  );
  // Line colors: color, fans.color and every level colour.
  const allColors = () => [props.style.color, fans().color, ...hLevels().map((l) => l.color), ...vLevels().map((l) => l.color)];
  const sameColor = () => allColors().every((c) => parseColor(c).hex === parseColor(allColors()[0]).hex);
  return (
    <>
      <div class="drawing-settings-section-title">PRICE LEVELS</div>
      {grid("levels", hLevels)}
      <CheckboxRow checked={props.style.showLeftLabels !== false} onChange={(v) => props.patchStyle({ showLeftLabels: v })} label="Left labels" />
      <CheckboxRow checked={props.style.showRightLabels !== false} onChange={(v) => props.patchStyle({ showRightLabels: v })} label="Right labels" />
      {background(props.style.fillBackground !== false, props.style.transparency ?? 80, (v) => props.patchStyle({ fillBackground: v }), (t) => props.patchStyle({ transparency: t }))}
      <div class="drawing-settings-group-sep" />
      <div class="drawing-settings-section-title">TIME LEVELS</div>
      {grid("vLevels", vLevels)}
      <CheckboxRow checked={props.style.showTopLabels !== false} onChange={(v) => props.patchStyle({ showTopLabels: v })} label="Top labels" />
      <CheckboxRow checked={props.style.showBottomLabels !== false} onChange={(v) => props.patchStyle({ showBottomLabels: v })} label="Bottom labels" />
      {background(props.style.fillVertBackground !== false, props.style.vertTransparency ?? 80, (v) => props.patchStyle({ fillVertBackground: v }), (t) => props.patchStyle({ vertTransparency: t }))}
      <div class="drawing-settings-group-sep" />
      <DialogRow label="Use one color">
        <DialogColorButton
          color={hLevels()[0]?.color ?? "#808080"}
          mixed={!sameColor()}
          onColor={(c) =>
            props.patchStyle({
              color: c,
              fans: { ...fans(), color: c },
              levels: hLevels().map((l) => ({ ...l, color: c })),
              vLevels: vLevels().map((l) => ({ ...l, color: c })),
            })
          }
        />
      </DialogRow>
      <div class="drawing-settings-row">
        <CheckboxRow checked={fans().visible} onChange={(v) => props.patchStyle({ fans: { ...fans(), visible: v } })} label="Angles" />
        <div class="drawing-settings-row-inputs">
          <DialogColorButton color={fans().color} onColor={(c) => props.patchStyle({ fans: { ...fans(), color: c } })} />
        </div>
      </div>
      <CheckboxRow checked={!!props.style.reverse} onChange={(v) => props.patchStyle({ reverse: v })} label="Reverse" />
    </>
  );
}

/** Fib speed resistance fan Style page: PRICE LEVELS grid
 *  (checkbox, value, colour; two columns) + Left / Right labels, TIME LEVELS
 *  grid + Top / Bottom labels, Use one color (every level and the grid),
 *  Background (checkbox + transparency), Grid (checkbox + line), Reverse. */
function SpeedFanStyleRows(props: { style: DrawingStyle; patchStyle: (p: Partial<DrawingStyle>) => void }) {
  const hLevels = () => props.style.levels ?? SPEED_FAN_LEVEL_DEFAULTS;
  const vLevels = () => props.style.vLevels ?? props.style.levels ?? SPEED_FAN_LEVEL_DEFAULTS;
  const grid = () => props.style.fanGrid ?? SPEED_FAN_GRID_DEFAULT;
  const grid2 = (key: "levels" | "vLevels", list: () => LevelDef[]) => (
    <div class="drawing-settings-levels two-col">
      <For each={list()}>
        {(lvl, i) => {
          const patch = (p: Partial<LevelDef>) => {
            const cur = list().map((l) => ({ ...l }));
            cur[i()] = { ...cur[i()], ...p };
            props.patchStyle({ [key]: cur } as Partial<DrawingStyle>);
          };
          return (
            <div class={"drawing-settings-level-row" + (lvl.visible ? "" : " off")}>
              <CheckBox checked={lvl.visible} onChange={(v) => patch({ visible: v })} />
              <DecimalInput narrow value={lvl.coeff} onCommit={(v) => patch({ coeff: v })} />
              <DialogColorButton color={lvl.color} onColor={(c) => patch({ color: c })} />
            </div>
          );
        }}
      </For>
    </div>
  );
  return (
    <>
      <div class="drawing-settings-section-title">PRICE LEVELS</div>
      {grid2("levels", hLevels)}
      <CheckboxRow checked={props.style.showLeftLabels !== false} onChange={(v) => props.patchStyle({ showLeftLabels: v })} label="Left labels" />
      <CheckboxRow checked={props.style.showRightLabels !== false} onChange={(v) => props.patchStyle({ showRightLabels: v })} label="Right labels" />
      <div class="drawing-settings-group-sep" />
      <div class="drawing-settings-section-title">TIME LEVELS</div>
      {grid2("vLevels", vLevels)}
      <CheckboxRow checked={props.style.showTopLabels !== false} onChange={(v) => props.patchStyle({ showTopLabels: v })} label="Top labels" />
      <CheckboxRow checked={props.style.showBottomLabels !== false} onChange={(v) => props.patchStyle({ showBottomLabels: v })} label="Bottom labels" />
      <div class="drawing-settings-group-sep" />
      <DialogRow label="Use one color">
        <DialogColorButton
          color={hLevels()[0]?.color ?? "#808080"}
          onColor={(c) =>
            props.patchStyle({
              levels: hLevels().map((l) => ({ ...l, color: c })),
              vLevels: vLevels().map((l) => ({ ...l, color: c })),
              fanGrid: { ...grid(), color: c },
            })
          }
        />
      </DialogRow>
      <div class="drawing-settings-row">
        <CheckboxRow checked={props.style.fillBackground !== false} onChange={(v) => props.patchStyle({ fillBackground: v })} label="Background" />
        <div class="drawing-settings-row-inputs">
          <TransparencySlider value={props.style.transparency ?? 80} onChange={(t) => props.patchStyle({ transparency: t })} />
        </div>
      </div>
      <div class="drawing-settings-row">
        <CheckboxRow checked={grid().visible} onChange={(v) => props.patchStyle({ fanGrid: { ...grid(), visible: v } })} label="Grid" />
        <div class="drawing-settings-row-inputs">
          <ColorThicknessPicker
            color={grid().color}
            width={grid().width}
            lineStyle={grid().style}
            onColor={(c) => props.patchStyle({ fanGrid: { ...grid(), color: c } })}
            onWidth={(w) => props.patchStyle({ fanGrid: { ...grid(), width: w } })}
            onLineStyle={(st) => props.patchStyle({ fanGrid: { ...grid(), style: st } })}
          />
        </div>
      </div>
      <CheckboxRow checked={!!props.style.reverse} onChange={(v) => props.patchStyle({ reverse: v })} label="Reverse" />
    </>
  );
}

/** Bold / italic toggle buttons (text style rows). */
function FontStyleToggles(props: { bold: boolean; italic: boolean; onBold: (v: boolean) => void; onItalic: (v: boolean) => void }) {
  return (
    <>
      <button type="button" class={"drawing-settings-text-toggle" + (props.bold ? " active" : "")} aria-pressed={props.bold} title="Bold" onClick={() => props.onBold(!props.bold)}>
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28" aria-hidden="true"><path fill="currentColor" d="M14 21h-3a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h3c2 0 4 1 4 3 0 1 0 2-1.5 3 1.5.5 2.5 2 2.5 4 0 2.75-2.638 4-5 4zM12 9l.004 3c.39.026.82 0 1.25 0C14.908 12 16 11.743 16 10.5c0-1.1-.996-1.5-2.5-1.5-.397 0-.927-.033-1.5 0zm0 5v5h1.5c1.5 0 3.5-.5 3.5-2.5S15 14 13.5 14c-.5 0-.895-.02-1.5 0z" /></svg>
      </button>
      <button type="button" class={"drawing-settings-text-toggle" + (props.italic ? " active" : "")} aria-pressed={props.italic} title="Italic" onClick={() => props.onItalic(!props.italic)}>
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28" aria-hidden="true"><path fill="currentColor" d="M12.143 20l1.714-12H12V7h5v1h-2.143l-1.714 12H15v1h-5v-1h2.143z" /></svg>
      </button>
    </>
  );
}

/** Check box without a title (level rows). */
function CheckBox(props: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label class={"drawing-settings-checkbox-row" + (props.disabled ? " disabled" : "")}>
      <span class={"drawing-settings-checkbox-box" + (props.checked ? " checked" : "")}>
        <Show when={props.checked}>
          <svg viewBox="0 0 16 16" width="12" height="12">
            <path fill="currentColor" d="M14.18 4.18 6 12.36l-4.18-4.18 1.4-1.41L6 9.54l6.77-6.78 1.41 1.42Z" />
          </svg>
        </Show>
        <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.currentTarget.checked)} />
      </span>
    </label>
  );
}

function CheckboxRow(props: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label class="drawing-settings-checkbox-row">
      <span class={"drawing-settings-checkbox-box" + (props.checked ? " checked" : "")}>
        <Show when={props.checked}>
          <svg viewBox="0 0 16 16" width="12" height="12">
            <path fill="currentColor" d="M14.18 4.18 6 12.36l-4.18-4.18 1.4-1.41L6 9.54l6.77-6.78 1.41 1.42Z" />
          </svg>
        </Show>
        <input
          type="checkbox"
          checked={props.checked}
          onChange={(e) => props.onChange(e.currentTarget.checked)}
        />
      </span>
      <span class="drawing-settings-checkbox-label">{props.label}</span>
    </label>
  );
}

/** Stats multi-select: a select-look button whose label is the
 *  comma-joined enabled stats; opens a checklist of the 7 stat flags. */
function StatsMultiSelect(props: {
  fields: ReadonlyArray<readonly [string, string]>;
  /** Summary when nothing is on ("Hidden"; extend lists "Don't extend"). */
  emptyLabel?: string;
  isOn: (key: string) => boolean;
  onToggle: (key: string, on: boolean) => void;
}) {
  const [open, setOpen] = createSignal(false);
  const [pos, setPos] = createSignal({ left: 0, top: 0, width: 0 });
  let rootEl: HTMLDivElement | undefined;
  let btnEl: HTMLButtonElement | undefined;
  let menuEl: HTMLDivElement | undefined;
  const summary = () => {
    const on = props.fields.filter(([key]) => props.isOn(key)).map(([, label]) => label);
    return on.length ? on.join(", ") : props.emptyLabel ?? "Hidden";
  };
  // The dialog body scrolls (overflow-y:auto), so an absolutely-positioned menu
  // clips at the body edge — open it fixed, anchored under the button and
  // clamped to the viewport (mirrors FixedColorPanel).
  const openMenu = () => {
    const r = btnEl!.getBoundingClientRect();
    setPos({ left: r.left, top: Math.min(r.bottom + 4, window.innerHeight - 8), width: r.width });
    setOpen(true);
  };
  onMount(() => {
    const onDown = (e: PointerEvent) => {
      if (!open()) return;
      const t = e.target as Node;
      if (rootEl?.contains(t) || menuEl?.contains(t)) return;
      setOpen(false);
    };
    // Escape closes just this menu; the dialog's own Escape defers while it's open.
    const onKey = (e: KeyboardEvent) => {
      if (open() && e.key === "Escape") { e.stopPropagation(); setOpen(false); }
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    });
  });
  return (
    <div class="drawing-settings-multiselect" ref={rootEl}>
      <button
        ref={btnEl}
        type="button"
        class="drawing-settings-multiselect-btn"
        aria-haspopup="listbox"
        aria-expanded={open()}
        onClick={() => (open() ? setOpen(false) : openMenu())}
      >
        <span class="drawing-settings-multiselect-label">{summary()}</span>
        <span class="drawing-settings-chevron"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3.92 7.83 9 12.29l5.08-4.46-1-1.13L9 10.29l-4.09-3.6-.99 1.14Z" /></svg></span>
      </button>
      <Show when={open()}>
        <div
          ref={menuEl}
          class="drawing-settings-multiselect-menu"
          role="listbox"
          aria-multiselectable="true"
          style={{ position: "fixed", left: `${pos().left}px`, top: `${pos().top}px`, "min-width": `${pos().width}px` }}
        >
          <For each={props.fields}>
            {([key, label]) => (
              <label class="drawing-settings-checkbox-row drawing-settings-multiselect-option" role="option" aria-selected={props.isOn(key)}>
                <span class={"drawing-settings-checkbox-box" + (props.isOn(key) ? " checked" : "")}>
                  <Show when={props.isOn(key)}>
                    <svg viewBox="0 0 16 16" width="12" height="12">
                      <path fill="currentColor" d="M14.18 4.18 6 12.36l-4.18-4.18 1.4-1.41L6 9.54l6.77-6.78 1.41 1.42Z" />
                    </svg>
                  </Show>
                  <input
                    type="checkbox"
                    checked={props.isOn(key)}
                    onChange={(e) => props.onToggle(key, e.currentTarget.checked)}
                  />
                </span>
                <span class="drawing-settings-checkbox-label">{label}</span>
              </label>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

/** One Visibility-matrix row: enable checkbox + a from/to range inside the
 *  unit (clamped to 1..max, from ≤ to on commit). */
function UnitVisibilityRow(props: {
  label: string;
  max: number;
  unit: UnitVisibility;
  onChange: (u: UnitVisibility) => void;
}) {
  const clamp = (n: number) => Math.max(1, Math.min(props.max, n));
  // Slider drag in progress: the fields follow it, the drawing is updated
  // on release.
  const [live, setLive] = createSignal<{ from: number; to: number } | null>(null);
  const commit = (field: "from" | "to", raw: string, el: HTMLInputElement) => {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) { el.value = String(props.unit[field]); return; }
    let from = field === "from" ? clamp(n) : props.unit.from;
    let to = field === "to" ? clamp(n) : props.unit.to;
    if (from > to) { if (field === "from") to = from; else from = to; }
    props.onChange({ ...props.unit, from, to });
  };
  return (
    <div class="drawing-settings-row drawing-settings-vis-row">
      <label class="drawing-settings-checkbox-row drawing-settings-vis-check">
        <span class={"drawing-settings-checkbox-box" + (props.unit.on ? " checked" : "")}>
          <Show when={props.unit.on}>
            <svg viewBox="0 0 16 16" width="12" height="12">
              <path fill="currentColor" d="M14.18 4.18 6 12.36l-4.18-4.18 1.4-1.41L6 9.54l6.77-6.78 1.41 1.42Z" />
            </svg>
          </Show>
          <input
            type="checkbox"
            checked={props.unit.on}
            onChange={(e) => props.onChange({ ...props.unit, on: e.currentTarget.checked })}
          />
        </span>
        <span class="drawing-settings-checkbox-label">{props.label}</span>
      </label>
      <div class="drawing-settings-row-inputs drawing-settings-vis-range">
        <input
          type="text"
          class="drawing-settings-input"
          aria-label={`${props.label} from`}
          disabled={!props.unit.on}
          value={String(live()?.from ?? props.unit.from)}
          onChange={(e) => commit("from", e.currentTarget.value, e.currentTarget)}
        />
        <RangeSlider
          min={1}
          max={props.max}
          from={live()?.from ?? props.unit.from}
          to={live()?.to ?? props.unit.to}
          disabled={!props.unit.on}
          onInput={(from, to) => setLive({ from, to })}
          onCommit={(from, to) => {
            setLive(null);
            if (from !== props.unit.from || to !== props.unit.to) props.onChange({ ...props.unit, from, to });
          }}
        />
        <input
          type="text"
          class="drawing-settings-input"
          aria-label={`${props.label} to`}
          disabled={!props.unit.on}
          value={String(live()?.to ?? props.unit.to)}
          onChange={(e) => commit("to", e.currentTarget.value, e.currentTarget)}
        />
      </div>
    </div>
  );
}

/** Visibility range slider: 10 px track
 *  (#3d3d3d, radius 5, at least 100 px), the #dbdbdb band between two 12 px
 *  thumbs (black, 2 px white border, shadow), thumb centres 6 px in from the
 *  ends. Value = min + round((x - 6) / (width - 12) * (max - min)); a thumb
 *  stops at the other one; a press (on the track or a thumb) moves the
 *  nearest thumb to the press point and drags it; the fields follow while dragging, the value is saved on
 *  release. Off (row unchecked): 50 % and inert. */
export function RangeSlider(props: {
  min: number;
  max: number;
  from: number;
  to: number;
  disabled?: boolean;
  onInput: (from: number, to: number) => void;
  onCommit: (from: number, to: number) => void;
}) {
  let track: HTMLDivElement | undefined;
  const [dragging, setDragging] = createSignal(false);
  const span = () => Math.max(1, props.max - props.min);
  const frac = (v: number) => Math.max(0, Math.min(1, (v - props.min) / span()));
  const valueAt = (clientX: number) => {
    if (!track) return props.min;
    const r = track.getBoundingClientRect();
    const f = (clientX - r.left - 6) / Math.max(1, r.width - 12);
    return Math.max(props.min, Math.min(props.max, props.min + Math.round(f * span())));
  };
  const onDown = (e: PointerEvent, thumb?: "from" | "to") => {
    if (props.disabled || e.button !== 0 || !track) return;
    e.preventDefault();
    e.stopPropagation();
    let which = thumb;
    if (!which) {
      // Track press: the nearest thumb.
      const r = track.getBoundingClientRect();
      const px = (v: number) => r.left + 6 + frac(v) * (r.width - 12);
      which = Math.abs(e.clientX - px(props.from)) <= Math.abs(e.clientX - px(props.to)) ? "from" : "to";
    }
    let from = props.from;
    let to = props.to;
    const apply = (clientX: number) => {
      const v = valueAt(clientX);
      if (which === "from") from = Math.min(v, to);
      else to = Math.max(v, from);
      props.onInput(from, to);
    };
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    setDragging(true);
    // The press itself sets the value (on a thumb too).
    apply(e.clientX);
    const move = (ev: PointerEvent) => apply(ev.clientX);
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      setDragging(false);
      props.onCommit(from, to);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  return (
    <div class={"ot-range" + (props.disabled ? " disabled" : "") + (dragging() ? " dragged" : "")}>
      <div class="ot-range-track" ref={track} onPointerDown={(e) => onDown(e)}>
        <div class="ot-range-middle-wrap">
          <div class="ot-range-middle" style={{ left: `${frac(props.from) * 100}%`, width: `${(frac(props.to) - frac(props.from)) * 100}%` }} />
        </div>
        <div class="ot-range-pointer-wrap">
          <div class="ot-range-pointer" style={{ left: `${frac(props.from) * 100}%` }} onPointerDown={(e) => onDown(e, "from")} />
        </div>
        <div class="ot-range-pointer-wrap">
          <div class="ot-range-pointer" style={{ left: `${frac(props.to) * 100}%` }} onPointerDown={(e) => onDown(e, "to")} />
        </div>
      </div>
    </div>
  );
}

/** Fixed-position ColorPanel host: opens under an anchor button, clamped to
 *  the viewport, scrolls internally (the panel extends past the dialog). */
function FixedColorPanel(props: {
  anchor: () => HTMLElement | undefined;
  onDismiss: () => void;
  children: import("solid-js").JSX.Element;
}) {
  let panelEl: HTMLDivElement | undefined;
  const rect = props.anchor()?.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect?.left ?? 0, window.innerWidth - 258));
  const top = Math.min((rect?.bottom ?? 0) + 4, window.innerHeight - 120);
  onMount(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panelEl?.contains(t) || props.anchor()?.contains(t)) return;
      props.onDismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); props.onDismiss(); }
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    });
  });
  return (
    <div
      ref={panelEl}
      class="dt-popover dlg-color-panel"
      style={{ position: "fixed", left: `${left}px`, top: `${top}px`, "max-height": `${window.innerHeight - top - 8}px` }}
    >
      {props.children}
    </div>
  );
}

/** Plain color swatch button (text color / fill color) opening the panel. */
/** Image Style rows: "Image" (the current picture; a click opens the Image
 *  dialog to replace it) and "Transparency". */
function ImageStyleRows(props: {
  drawing: Drawing;
  coords?: import("./coords").Coords | null;
  onUpdate: (d: Drawing) => void;
  patchStyle: (p: Partial<DrawingStyle>) => void;
}) {
  const [picking, setPicking] = createSignal(false);
  const url = () => {
    void imagesVersion();
    return drawingImage(props.drawing.image?.name)?.url ?? "";
  };
  return (
    <>
      <DialogRow label="Image">
        <button type="button" class="drawing-settings-image-thumb" aria-label="Image" onClick={() => setPicking(true)}>
          <Show when={url()}>
            <img src={url()} alt="" />
          </Show>
        </button>
      </DialogRow>
      <DialogRow label="Transparency">
        <TransparencySlider value={props.drawing.style.transparency ?? 0} onChange={(t) => props.patchStyle({ transparency: t })} />
      </DialogRow>
      <Show when={picking()}>
        <ImageDialog
          transparency={props.drawing.style.transparency ?? 0}
          onConfirm={(r) => {
            // The new picture fits the current box.
            const cur = props.drawing.image;
            const size = cur ? imageInitialSize(r.width, r.height, cur.cssWidth * 4, cur.cssHeight * 4) : { cssWidth: r.width, cssHeight: r.height };
            props.onUpdate({
              ...props.drawing,
              image: { name: r.name, ...size },
              style: { ...props.drawing.style, transparency: r.transparency },
            } as Drawing);
          }}
          onClose={() => setPicking(false)}
        />
      </Show>
    </>
  );
}

/** Background row for shapes: check box + colour button; the colour
 *  panel opacity is 100 - transparency. */
function BackgroundColorRow(props: { style: DrawingStyle; patchStyle: (p: Partial<DrawingStyle>) => void; fallbackColor?: string }) {
  const color = () => applyOpacity(parseColor(props.style.backgroundColor ?? props.fallbackColor ?? props.style.color).hex, 100 - (props.style.transparency ?? 50));
  return (
    <div class="drawing-settings-row">
      <CheckboxRow checked={!!props.style.fillBackground} onChange={(v) => props.patchStyle({ fillBackground: v })} label="Background" />
      <div class="drawing-settings-row-inputs">
        <DialogColorButton
          color={color()}
          onColor={(c) => {
            const pc = parseColor(c);
            props.patchStyle({ backgroundColor: pc.hex, transparency: 100 - pc.opacity });
          }}
        />
      </div>
    </div>
  );
}

/** Level grid + "Use one color" + "Background" (see the call site). */
function LevelGridRows(props: { kind: string; style: DrawingStyle; defaults: LevelDef[]; patchStyle: (p: Partial<DrawingStyle>) => void; extendRow?: import("solid-js").JSX.Element }) {
  const levels = () => props.style.levels ?? props.defaults;
  const patchLevel = (i: number, patch: Partial<LevelDef>) => {
    const cur = levels().map((l) => ({ ...l }));
    cur[i] = { ...cur[i], ...patch };
    props.patchStyle({ levels: cur });
  };
  const fragment = () => LEVEL_FRAGMENT_KINDS.has(props.kind);
  // "Use one color": the common colour, or an empty swatch when they differ.
  const sameColor = () => {
    const l = levels();
    return l.length > 0 && l.every((x) => parseColor(x.color).hex === parseColor(l[0].color).hex);
  };
  const first = () => levels()[0];
  return (
    <>
      <Show when={LEVELS_LINE_KINDS.has(props.kind)}>
        <DialogRow label="Levels line">
          <LineGlyphSelect kind="width" value={first()?.width ?? props.style.width} options={[1, 2, 3, 4]} onChange={(v) => props.patchStyle({ levels: levels().map((l) => ({ ...l, width: v })) })} />
          <LineGlyphSelect kind="style" value={(first()?.style ?? props.style.lineStyle) as LineStyle} options={["solid", "dashed", "dotted"] as LineStyle[]} onChange={(v) => props.patchStyle({ levels: levels().map((l) => ({ ...l, style: v })) })} />
        </DialogRow>
      </Show>
      {props.extendRow}
      <div class={"drawing-settings-levels" + (fragment() ? " two-col" : "")}>
        <For each={levels()}>
          {(lvl, i) => (
            <div class={"drawing-settings-level-row" + (lvl.visible ? "" : " off")}>
              <Show
                when={!lvl.label}
                fallback={
                  // Gann fan: the ratio is the row title (label column).
                  <span class="drawing-settings-level-title">
                    <CheckboxRow checked={lvl.visible} onChange={(v) => patchLevel(i(), { visible: v })} label={lvl.label ?? ""} />
                  </span>
                }
              >
                <CheckBox
                  checked={lvl.visible}
                  // Parallel channel: levels 0 and 1 (rows 2 and 6) are locked on.
                  disabled={props.kind === "parallel-channel" && (i() === 1 || i() === 5)}
                  onChange={(v) => patchLevel(i(), { visible: v })}
                />
                <DecimalInput narrow value={lvl.coeff} onCommit={(v) => patchLevel(i(), { coeff: v })} />
              </Show>
              <Show
                when={!fragment()}
                fallback={<DialogColorButton color={lvl.color} onColor={(c) => patchLevel(i(), { color: c })} />}
              >
                <ColorThicknessPicker
                  color={lvl.color}
                  width={lvl.width ?? props.style.width}
                  lineStyle={lvl.style ?? props.style.lineStyle}
                  onColor={(c) => patchLevel(i(), { color: c })}
                  onWidth={(w) => patchLevel(i(), { width: w })}
                  onLineStyle={(st) => patchLevel(i(), { style: st })}
                />
              </Show>
            </div>
          )}
        </For>
      </div>
      <Show when={fragment()}>
        <div class="drawing-settings-group-sep" />
      </Show>
      <Show when={props.kind !== "parallel-channel"}>
        <DialogRow label="Use one color">
          <DialogColorButton color={levels()[0]?.color ?? "#808080"} mixed={!sameColor()} onColor={(c) => props.patchStyle({ levels: levels().map((l) => ({ ...l, color: c })) })} />
        </DialogRow>
        <Show when={props.style.fillBackground !== undefined}>
          <div class="drawing-settings-row">
            <CheckboxRow checked={!!props.style.fillBackground} onChange={(v) => props.patchStyle({ fillBackground: v })} label="Background" />
            <div class="drawing-settings-row-inputs">
              <TransparencySlider value={props.style.transparency ?? 80} onChange={(t) => props.patchStyle({ transparency: t })} />
            </div>
          </div>
        </Show>
      </Show>
    </>
  );
}

function DialogColorButton(props: { color: string; onColor: (c: string) => void; mixed?: boolean }) {
  const [open, setOpen] = createSignal(false);
  let btnEl: HTMLButtonElement | undefined;
  return (
    <>
      <button
        type="button"
        class="drawing-settings-color-swatch"
        aria-label="Color"
        aria-haspopup="dialog"
        aria-expanded={open()}
        ref={btnEl}
        onClick={() => setOpen((o) => !o)}
      >
        <span
          class="drawing-settings-color-swatch-fill"
          // Mixed-colour placeholder: red / teal split along the diagonal.
          style={props.mixed ? { background: "linear-gradient(to top right, #f7525f 50%, #22ab94 50%)" } : { "--swatch-color": props.color }}
        />
      </button>
      <Show when={open()}>
        <FixedColorPanel anchor={() => btnEl} onDismiss={() => setOpen(false)}>
          <ColorPanel value={props.color} onChange={props.onColor} onPicked={() => setOpen(false)} />
        </FixedColorPanel>
      </Show>
    </>
  );
}

/** Composite `color-with-thickness-select` (75×34: swatch + current-width
 *  line preview) — opens ONE panel carrying swatches + opacity + Thickness +
 *  Line style sections (250×436). */
function ColorThicknessPicker(props: {
  color: string;
  width: number;
  lineStyle?: LineStyle;
  onColor: (c: string) => void;
  onWidth: (w: number) => void;
  /** Omitted → no "Line style" section (polyline). */
  onLineStyle?: (s: LineStyle) => void;
}) {
  const [open, setOpen] = createSignal(false);
  let btnEl: HTMLButtonElement | undefined;
  const lineCss = () =>
    `${Math.max(props.width, 1)}px ${props.lineStyle === "dashed" ? "dashed" : props.lineStyle === "dotted" ? "dotted" : "solid"} ${props.color}`;
  return (
    <span class="drawing-settings-color-thickness">
      <button
        type="button"
        class="dlg-color-thickness-btn"
        data-name="color-with-thickness-select"
        aria-haspopup="dialog"
        aria-expanded={open()}
        ref={btnEl}
        onClick={() => setOpen((o) => !o)}
      >
        <span class="dlg-ct-swatch" style={{ "--swatch-color": props.color }} />
        <span class="dlg-ct-line" style={{ "border-top": lineCss() }} />
      </button>
      <Show when={open()}>
        <FixedColorPanel anchor={() => btnEl} onDismiss={() => setOpen(false)}>
          <ColorPanel
            value={props.color}
            onChange={props.onColor}
            onPicked={() => setOpen(false)}
            thickness={props.width}
            onThickness={(w) => { props.onWidth(w); setOpen(false); }}
            lineStyle={props.lineStyle}
            onLineStyle={props.onLineStyle ? (s) => { props.onLineStyle!(s); setOpen(false); } : undefined}
          />
        </FixedColorPanel>
      </Show>
    </span>
  );
}
