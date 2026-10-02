/*
 * Floating toolbar style buttons per tool (the reference app's floating
 * toolbar, module "floating-toolbars" + each tool's property class).
 *
 * The reference toolbar builds its colour / width / style buttons from five
 * collected property groups each tool declares (`collectedPropertyChildNames`:
 * lineColor, backgroundColor, textColor, lineWidth, lineStyle). A button
 * writes its value to EVERY property of its group (a fib colour sets the trend
 * line and all 24 level colours) and reads "mixed" when they differ. Some
 * tools replace the default buttons with their own list ("exception cases":
 * text tools, ranges, pin, positions, path, regression trend, bars pattern,
 * sector, signpost, highlighter). Tools without groups (ghost feed, volume
 * profiles, image, emoji, sticker) show no style button.
 *
 * Each group here maps the reference properties to this app's DrawingStyle
 * fields, the ones the renderers read.
 */
import type { Drawing, DrawingKind, DrawingStyle, GannLine, LevelDef, LineStyle } from "lightweight-charts-drawing/core/types";
import {
  FIB_CIRCLE_LEVEL_DEFAULTS, FIB_LEVEL_DEFAULTS, FIB_TIMEZONE_LEVEL_DEFAULTS, FIB_TREND_LINE_DEFAULT, FIB_WEDGE_LEVEL_DEFAULTS,
  FIB_WEDGE_TREND_LINE_DEFAULT, GANN_ARC_DEFAULTS, GANN_BOX_LEVEL_DEFAULTS, GANN_FAN_DEFAULTS, GANN_FAN_LEVEL_DEFAULTS,
  GANN_LEVEL_DEFAULTS, OVERLAY_SPECS, PARALLEL_CHANNEL_LEVEL_DEFAULTS, PITCHFAN_LEVEL_DEFAULTS, PITCHFORK_LEVEL_DEFAULTS,
  REGRESSION_LINE_DEFAULTS, SPEED_ARC_LEVEL_DEFAULTS, SPEED_FAN_GRID_DEFAULT, SPEED_FAN_LEVEL_DEFAULTS,
  TREND_FIB_TIME_LEVEL_DEFAULTS, TREND_FIB_TIME_TREND_DEFAULT,
} from "lightweight-charts-drawing/core/specs";
import { applyOpacity, parseColor } from "lightweight-charts-drawing/core/color";

/** One collected group: the values of its properties, and the style with one
 *  value written to all of them. */
export type Group<T> = {
  get: (d: Drawing) => T[];
  set: (d: Drawing, s: DrawingStyle, v: T) => DrawingStyle;
};

export type ColorButton = {
  /** data-name of the button (icon: line / background / text). */
  id: "line-tool-color" | "background-color" | "text-color";
  title: string;
  group: Group<string>;
};

export type ToolbarGroups = {
  colors: ColorButton[];
  width?: Group<number> & { highlighter?: boolean };
  style?: Group<LineStyle>;
  /** "Font size" button (text tools, pin, signpost; after the colours). */
  fontSize?: Group<number>;
};

/** Font size of a text tool, with the size its renderer uses when unset. */
const fontSize = (fallback: number) => field("fontSize", () => fallback);

// ── Group builders ─────────────────────────────────────────────────────────

/** A plain style field (fallback when unset). */
function field<K extends keyof DrawingStyle>(k: K, fallback: (s: DrawingStyle) => DrawingStyle[K]): Group<NonNullable<DrawingStyle[K]>> {
  return {
    get: (d) => [(d.style[k] ?? fallback(d.style)) as NonNullable<DrawingStyle[K]>],
    set: (_d, s, v) => ({ ...s, [k]: v }),
  };
}

/** A colour field whose opacity is the drawing's separate transparency field
 *  (as in the settings dialog): the button shows colour + opacity, a pick
 *  stores the hex and 100 - opacity. */
function colorWithTransparency(k: keyof DrawingStyle, tk: keyof DrawingStyle, fallbackColor: (s: DrawingStyle) => string, fallbackT: number): Group<string> {
  return {
    get: (d) => {
      const s = d.style as Record<string, unknown>;
      const c = (s[k] as string | undefined) ?? fallbackColor(d.style);
      return [applyOpacity(parseColor(c).hex, 100 - ((s[tk] as number | undefined) ?? fallbackT))];
    },
    set: (_d, s, v) => {
      const pc = parseColor(v);
      return { ...s, [k]: pc.hex, [tk]: 100 - pc.opacity };
    },
  };
}

type LevelsKey = "levels" | "vLevels";
/** One column of a level list (colour / width / style of every level, hidden
 *  ones included, like the reference groups). */
function levelsColumn<C extends "color" | "width" | "style">(
  key: LevelsKey, fallback: (s: DrawingStyle) => LevelDef[], col: C,
): Group<NonNullable<LevelDef[C]>> {
  const list = (s: DrawingStyle) => s[key] ?? fallback(s);
  return {
    get: (d) => list(d.style).map((l) => (l[col] ?? (col === "width" ? d.style.width : col === "style" ? d.style.lineStyle : undefined)) as NonNullable<LevelDef[C]>),
    set: (_d, s, v) => ({ ...s, [key]: list(s).map((l) => ({ ...l, [col]: v })) }),
  };
}

/** A sub-object line (trend line of the fib tools, speed fan grid, gann box
 *  fans). */
function lineObject<O extends { color: string; width?: number }, C extends "color" | "width">(
  k: "fibTrendLine" | "fanGrid" | "fans", fallback: O, col: C,
): Group<NonNullable<O[C]>> {
  const cur = (s: DrawingStyle) => ((s[k] as O | undefined) ?? fallback);
  return {
    get: (d) => [cur(d.style)[col] as NonNullable<O[C]>],
    set: (_d, s, v) => ({ ...s, [k]: { ...cur(s), [col]: v } }),
  };
}

/** Gann square lists (levels / fan lines / arcs). */
function gannColumn(k: "gannLevels" | "gannFans" | "gannArcs", fallback: GannLine[], col: "color" | "width"): Group<string | number> {
  const list = (s: DrawingStyle) => (s[k] ?? fallback) as GannLine[];
  return {
    get: (d) => list(d.style).map((l) => l[col]),
    set: (_d, s, v) => ({ ...s, [k]: list(s).map((l) => ({ ...l, [col]: v })) }),
  };
}

/** Several groups as one (values concatenated, a write goes to all). */
function all<T>(...gs: Group<T>[]): Group<T> {
  return {
    get: (d) => gs.flatMap((g) => g.get(d)),
    set: (d, s, v) => gs.reduce((acc, g) => g.set(d, acc, v), s),
  };
}

// ── Common groups ──────────────────────────────────────────────────────────
const color = field("color", () => "#2962ff");
const width = field("width", () => 1);
const lineStyle = field("lineStyle", () => "solid" as LineStyle);
const textColor = field("textColor", (s) => s.color);
/** Shape / channel / pattern backgrounds (dialog Background row). */
const shapeBackground = colorWithTransparency("backgroundColor", "transparency", (s) => s.color, 50);

// ── Button titles (the reference toolbar strings) ──────────────────────────
const LINE_COLORS = "Line tool colors";
const BACKGROUNDS = "Line tool backgrounds";
const TEXT_COLORS = "Line tool text colors";

const lineBtn = (group: Group<string>, title = LINE_COLORS): ColorButton => ({ id: "line-tool-color", title, group });
const bgBtn = (group: Group<string>, title = BACKGROUNDS): ColorButton => ({ id: "background-color", title, group });
const textBtn = (group: Group<string>, title = TEXT_COLORS): ColorButton => ({ id: "text-color", title, group });

/** Default button set from the groups a tool declares, in the reference
 *  order: line colours, backgrounds, text colours, width, style. */
function groups(g: { line?: Group<string>; bg?: Group<string>; text?: Group<string>; width?: Group<number>; style?: Group<LineStyle> }): ToolbarGroups {
  const colors: ColorButton[] = [];
  if (g.line) colors.push(lineBtn(g.line));
  if (g.bg) colors.push(bgBtn(g.bg));
  if (g.text) colors.push(textBtn(g.text));
  return { colors, width: g.width, style: g.style };
}

// Level-tool groups.
const lv = (fb: LevelDef[]) => (s: DrawingStyle) => s.levels ?? fb;
type TrendLine = { visible: boolean; color: string; width: number; style: LineStyle };
const fibTrend = (fb: TrendLine) => ({
  color: lineObject("fibTrendLine", fb, "color") as Group<string>,
  width: lineObject("fibTrendLine", fb, "width") as Group<number>,
});
/** Fib tools with a trend line + levels (colour and width of both). */
function fibWithTrend(levels: LevelDef[], trend: TrendLine): ToolbarGroups {
  const t = fibTrend(trend);
  return groups({
    line: all(t.color, levelsColumn("levels", lv(levels), "color")),
    width: all(t.width, levelsColumn("levels", lv(levels), "width")),
  });
}
/** Pitchfork family / pitchfan: the median (drawing colour / width) and the
 *  levels; no style. */
function pitch(levels: LevelDef[]): ToolbarGroups {
  return groups({
    line: all(color, levelsColumn("levels", lv(levels), "color")),
    width: all(width, levelsColumn("levels", lv(levels), "width")),
  });
}

const LINE_TOOL = groups({ line: color, text: textColor, width, style: lineStyle });

/** Tool kinds whose spec declares a background switch: the background button
 *  shows only while the background is on (reference
 *  `_shouldShowBackgroundProperty`). */
function hasFillSwitch(kind: DrawingKind): boolean {
  return OVERLAY_SPECS[kind].defaults?.fillBackground !== undefined;
}

/** Icon (monochrome glyph) vs emoji / sticker: only the icon has a colour. */
export function isIconGlyph(d: Drawing): boolean {
  const g = d.glyph?.trim() ?? "";
  return g.startsWith("<svg") && g.includes("currentColor");
}

/** The floating toolbar style buttons of a drawing. */
export function toolbarGroups(d: Drawing): ToolbarGroups {
  switch (d.kind) {
    // Trend line family (one property class): colour, text, width, style.
    case "trend-line":
    case "ray":
    case "extended-line":
    case "info-line":
    case "arrow":
    case "horizontal-line":
    case "horizontal-ray":
    case "vertical-line":
      return LINE_TOOL;
    case "trend-angle":
    case "cross-line":
    case "sine-line":
      return groups({ line: color, width, style: lineStyle });
    case "cyclic-lines":
    case "fib-spiral":
    case "elliott-impulse":
    case "elliott-correction":
    case "elliott-triangle":
    case "elliott-double-combo":
    case "elliott-triple-combo":
    case "position-forecast":
    case "anchored-vwap":
      return groups({ line: color, width });
    case "rectangle":
    case "disjoint-channel":
    case "flat-top-bottom":
      return groups({ line: color, bg: shapeBackground, text: textColor, width, style: lineStyle });
    case "circle":
    case "ellipse":
    case "xabcd-pattern":
    case "cypher-pattern":
    case "head-and-shoulders":
    case "triangle-pattern":
      return groups({ line: color, bg: shapeBackground, text: textColor, width });
    case "rotated-rectangle":
    case "triangle":
    case "arc":
      return groups({ line: color, bg: shapeBackground, width });
    case "polyline":
    case "time-cycles":
    case "curve":
    case "double-curve":
      return groups({ line: color, bg: shapeBackground, width, style: lineStyle });
    case "abcd-pattern":
    case "three-drives-pattern":
      return groups({ line: color, text: textColor, width });
    case "brush":
      return groups({ line: color, bg: shapeBackground, width });
    case "highlighter":
      return { colors: [lineBtn(color)], width: { ...width, highlighter: true } };
    case "path":
      return groups({ line: color, width, style: lineStyle });
    case "parallel-channel":
      return groups({
        line: levelsColumn("levels", lv(PARALLEL_CHANNEL_LEVEL_DEFAULTS), "color"),
        bg: shapeBackground,
        text: textColor,
        width: levelsColumn("levels", lv(PARALLEL_CHANNEL_LEVEL_DEFAULTS), "width"),
      });
    case "fib-retracement":
    case "trend-based-fib-extension":
      return fibWithTrend(FIB_LEVEL_DEFAULTS, FIB_TREND_LINE_DEFAULT);
    case "fib-circles": {
      const g = fibWithTrend(FIB_CIRCLE_LEVEL_DEFAULTS, FIB_TREND_LINE_DEFAULT);
      // Drawings saved before the current circles model draw in the drawing's own
      // colour / width.
      if (d.fmt === 2) return g;
      return { colors: [lineBtn(all(g.colors[0].group, color))], width: all(g.width!, width) };
    }
    case "fib-speed-resistance-arcs":
      return fibWithTrend(SPEED_ARC_LEVEL_DEFAULTS, FIB_TREND_LINE_DEFAULT);
    case "fib-wedge":
      return fibWithTrend(FIB_WEDGE_LEVEL_DEFAULTS, FIB_WEDGE_TREND_LINE_DEFAULT);
    case "trend-based-fib-time":
      return fibWithTrend(TREND_FIB_TIME_LEVEL_DEFAULTS, TREND_FIB_TIME_TREND_DEFAULT);
    case "fib-channel":
      return groups({ line: levelsColumn("levels", lv(FIB_LEVEL_DEFAULTS), "color") });
    case "fib-time-zone":
      return groups({
        line: levelsColumn("levels", lv(FIB_TIMEZONE_LEVEL_DEFAULTS), "color"),
        width: levelsColumn("levels", lv(FIB_TIMEZONE_LEVEL_DEFAULTS), "width"),
        style: levelsColumn("levels", lv(FIB_TIMEZONE_LEVEL_DEFAULTS), "style"),
      });
    case "fib-speed-resistance-fan":
      return groups({
        line: all(
          lineObject("fanGrid", SPEED_FAN_GRID_DEFAULT, "color") as Group<string>,
          levelsColumn("levels", lv(SPEED_FAN_LEVEL_DEFAULTS), "color"),
          // Time levels (drawings saved before 25/09/2026 share `levels`).
          levelsColumn("vLevels", (s) => s.levels ?? SPEED_FAN_LEVEL_DEFAULTS, "color"),
        ),
        width,
        style: lineStyle,
      });
    case "pitchfork":
    case "schiff-pitchfork":
    case "modified-schiff-pitchfork":
    case "inside-pitchfork":
      return pitch(PITCHFORK_LEVEL_DEFAULTS);
    case "pitchfan":
      return pitch(PITCHFAN_LEVEL_DEFAULTS);
    case "gann-fan":
      return groups({
        line: levelsColumn("levels", lv(GANN_FAN_LEVEL_DEFAULTS), "color"),
        width: levelsColumn("levels", lv(GANN_FAN_LEVEL_DEFAULTS), "width"),
      });
    case "gann-box":
      return groups({
        line: all(
          color,
          lineObject("fans", { visible: false, color: "#9C9C9C" }, "color") as Group<string>,
          levelsColumn("levels", lv(GANN_BOX_LEVEL_DEFAULTS), "color"),
          levelsColumn("vLevels", (s) => s.vLevels ?? GANN_BOX_LEVEL_DEFAULTS, "color"),
        ),
        width,
        style: lineStyle,
      });
    case "gann-square":
    case "gann-square-fixed":
      return groups({
        line: all(
          gannColumn("gannLevels", GANN_LEVEL_DEFAULTS, "color"),
          gannColumn("gannFans", GANN_FAN_DEFAULTS, "color"),
          gannColumn("gannArcs", GANN_ARC_DEFAULTS, "color"),
        ) as Group<string>,
        width: all(
          gannColumn("gannLevels", GANN_LEVEL_DEFAULTS, "width"),
          gannColumn("gannFans", GANN_FAN_DEFAULTS, "width"),
          gannColumn("gannArcs", GANN_ARC_DEFAULTS, "width"),
        ) as Group<number>,
      });
    // Regression trend: the up / down / base line widths only.
    case "regression-trend": {
      const rl = (s: DrawingStyle) => s.regressionLines ?? REGRESSION_LINE_DEFAULTS;
      return {
        colors: [],
        width: {
          get: (x) => [rl(x.style).up.width, rl(x.style).down.width, rl(x.style).base.width],
          set: (_x, s, w) => {
            const r = rl(s);
            return { ...s, regressionLines: { base: { ...r.base, width: w }, up: { ...r.up, width: w }, down: { ...r.down, width: w } } };
          },
        },
      };
    }
    // Ranges: "Color" (line), background, text (custom text colour), width.
    case "price-range":
    case "date-range":
    case "date-and-price-range":
      return {
        colors: [
          lineBtn(color, "Color"),
          bgBtn(colorWithTransparency("backgroundColor", "transparency", (s) => s.color, 85), "Background color"),
          textBtn(field("customTextColor", () => "#2962ff")),
        ],
        width,
      };
    // Positions: text colour, profit and stop backgrounds.
    case "long-position":
    case "short-position":
      return {
        colors: [
          textBtn(field("textColor", () => "#ffffff"), "Text color"),
          bgBtn(colorWithTransparency("targetColor", "targetTransparency", () => "#089981", 80), "Profit background color"),
          bgBtn(colorWithTransparency("stopColor", "stopTransparency", () => "#f23645", 80), "Stop background color"),
        ],
      };
    // Text tools: text colour, background and font size.
    case "text":
      return {
        colors: [
          textBtn(color, "Text color"),
          bgBtn(colorWithTransparency("backgroundColor", "transparency", (s) => s.color, 75), "Background color"),
        ],
        fontSize: fontSize(14),
      };
    case "comment":
      return {
        colors: [
          textBtn(field("textColor", () => "#ffffff"), "Text color"),
          bgBtn(colorWithTransparency("backgroundColor", "transparency", (s) => s.color, 0), "Background color"),
        ],
        fontSize: fontSize(16),
      };
    case "callout":
      return {
        colors: [
          textBtn(field("textColor", () => "#ffffff"), "Text color"),
          bgBtn(colorWithTransparency("backgroundColor", "transparency", (s) => s.color, 50), "Background color"),
        ],
        fontSize: fontSize(14),
      };
    case "price-label":
      return {
        colors: [
          textBtn(field("textColor", () => "#ffffff"), "Text color"),
          bgBtn(colorWithTransparency("backgroundColor", "transparency", (s) => s.color, 0), "Background color"),
        ],
        fontSize: fontSize(14),
      };
    // Pin (reference Note): marker colour, text colour, font size.
    case "pin":
      return {
        colors: [lineBtn(color, "Marker color"), textBtn(field("textColor", () => "#dbdbdb"), "Text color")],
        fontSize: fontSize(14),
      };
    // Note (reference text note): line, background, text.
    case "note":
      return groups({ line: color, bg: field("backgroundColor", () => "#2e2e2e"), text: field("textColor", () => "#dbdbdb") });
    case "price-note":
      return groups({
        line: color,
        bg: field("priceLabelBackgroundColor", () => "#2962ff"),
        text: field("priceLabelTextColor", () => "#ffffff"),
      });
    case "table":
      return groups({ line: color, bg: field("backgroundColor", () => "#0f0f0f"), text: field("textColor", () => "#dbdbdb") });
    case "arrow-marker":
      return groups({ bg: color, text: textColor });
    case "arrow-mark-up":
    case "arrow-mark-down":
      return groups({ line: color, text: textColor });
    case "flag-mark":
      return groups({ bg: color });
    case "bar-pattern":
      return { colors: [bgBtn(color, "Color")] };
    case "sector":
      return {
        colors: [
          bgBtn(colorWithTransparency("sectorColor1", "transparency", () => "#2962ff", 80), "Background color 1"),
          bgBtn(colorWithTransparency("sectorColor2", "transparency", () => "#9c27b0", 80), "Background color 2"),
        ],
        width,
      };
    case "signpost":
      return { colors: d.style.showImage ? [bgBtn(field("plateColor", () => "#2962ff"))] : [], fontSize: fontSize(12) };
    case "font-icon":
      return { colors: isIconGlyph(d) ? [bgBtn(color)] : [] };
    case "ghost-feed":
    case "fixed-range-volume-profile":
    case "anchored-volume-profile":
    case "image":
      return { colors: [] };
  }
  return { colors: [] };
}

/** Background buttons hide while a tool's background switch is off. */
export function visibleColors(d: Drawing): ColorButton[] {
  const g = toolbarGroups(d).colors;
  if (!hasFillSwitch(d.kind) || d.style.fillBackground !== false) return g;
  // Brush keeps its background button (reference exception case).
  return d.kind === "brush" ? g : g.filter((b) => b.id !== "background-color");
}

/** The value a button shows: the common value, or "mixed". */
export function groupValue<T>(values: T[], same: (a: T, b: T) => boolean = (a, b) => a === b): T | "mixed" {
  if (values.length === 0) return "mixed";
  return values.every((v) => same(v, values[0])) ? values[0] : "mixed";
}

export const sameColor = (a: string, b: string): boolean => {
  const x = parseColor(a);
  const y = parseColor(b);
  return x.hex === y.hex && x.opacity === y.opacity;
};
