/*
 * Reads the `--ot-chart-*` CSS custom properties off `<html>` so the chart
 * picks up the same palette as the rest of the chrome. The fallbacks match
 * the dark theme so calls before tokens.css loads still render sensibly.
 *
 * Ported from the reference mock (its `readTokens` function).
 */
import { DEFAULT_RIGHT_OFFSET, DEFAULT_SERIES_STYLES, type ChartAppearance, type NavButtonsBehavior, type SeriesStyles } from "../header/chart-settings";

export type ChartTokens = {
  bg: string;
  bgGradient: boolean; // Canvas → Background: Solid vs vertical Gradient
  bgBottom: string; // gradient bottom colour (`bg` is the top)
  text: string;
  grid: string;
  up: string;
  down: string;
  // Candle body / borders / wicks, each with its own up/down colour and a
  // visibility flag (Symbol tab: Body / Borders / Wick rows). `up`/`down` above
  // are the body colours.
  bodyVisible: boolean;
  borderUpColor: string;
  borderDownColor: string;
  borderVisible: boolean;
  wickUpColor: string;
  wickDownColor: string;
  wickVisible: boolean;
  // Grid lines: two independent checkable rows, each with its own colour +
  // line style. `grid` above is their shared colour fallback; the scale
  // border has its own default (transparent).
  gridVertColor: string;
  gridHorzColor: string;
  gridVertVisible: boolean;
  gridHorzVisible: boolean;
  gridVertStyle: number; // 0 solid, 1 dashed, 2 dotted
  gridHorzStyle: number;
  // Canvas tab: crosshair colour, scale text colour + size, scale-line colour,
  // and price/time margins.
  crosshairColor: string;
  crosshairStyle: number; // 0 solid, 1 dashed, 2 dotted
  crosshairWidth: number;
  // Crosshair axis-label plate (themed per scheme; the library default is a
  // fixed #131722 that only suits a navy dark theme).
  crosshairLabelBg: string;
  // Divider between stacked panes inside ONE chart (indicator panes). The
  // library default is the light-theme #E0E3EB.
  paneSeparator: string;
  scaleTextColor: string;
  scaleFontSize: number;
  scaleLinesColor: string;
  marginTop: number; // price-scale top margin, 0..1
  marginBottom: number; // price-scale bottom margin, 0..1
  rightOffset: number; // time-scale right margin, in bars (committed only)
  scalesPlacement: "left" | "right"; // Scales → Scales placement
  navButtons: NavButtonsBehavior; // Canvas → Buttons → Navigation
  paneButtons: NavButtonsBehavior; // Canvas → Buttons → Pane
  precision: string; // Symbol → Precision (e.g. "Default", "2 decimals", "Integer")
  // Session breaks (Events tab): on/off + line colour + style.
  sessionBreaksVisible: boolean;
  sessionBreaksColor: string;
  sessionBreaksStyle: number; // 0 solid, 1 dashed, 2 dotted
  sessionBreaksWidth: number;
  // Symbol tab: per-bar colours vs the PREVIOUS close instead of the bar's own open.
  colorBarsOnPrevClose: boolean;
  // Scales → Price labels → Symbol: last-value label, price line, and the
  // ticker inside the price-scale label (check-list "Name" option).
  symbolLastValue: boolean;
  symbolPriceLine: boolean;
  symbolNameLabel: boolean;
  /** "" = the last bar's direction colour. */
  symbolPriceLineColor: string;
  symbolPriceLineWidth: number;
  /** Symbol last-value label: "Price and percentage value" mode. */
  symbolValuePercent: boolean;
  // Scales → "Countdown to bar close" (axis label under the last price).
  countdownVisible: boolean;
  // Scales → "Previous day close": price line + axis label at the close of
  // the last bar's previous trading day.
  prevCloseLabel: boolean;
  prevCloseLine: boolean;
  prevCloseColor: string;
  prevCloseWidth: number;
  // Scales → "Pre/post/night market": the extended-hours price label + line
  prePostLabel: boolean;
  prePostLine: boolean;
  preMarketColor: string;
  postMarketColor: string;
  // Scales → "High and low": visible-bars extreme price lines/labels
  // (check-list "Value" / "Line" memberships).
  highLowLabels: boolean;
  highLowLines: boolean;
  /** "" = automatic: High line up colour, Low line down colour. */
  highLowColor: string;
  highLowWidth: number;
  // Canvas → Watermark (checkable list + colour).
  watermarkColor: string;
  watermarkTicker: boolean;
  watermarkInterval: boolean;
  watermarkDescription: boolean;
  // Scales → "Indicators and financials": study-series last-value axis labels.
  indLastValue: boolean;
  // Alerts tab: price lines for the charted symbol's price-level alert rules
  // (colorPair up = active rules, down = inactive; "Only active alerts" hides
  // the inactive ones entirely).
  alertLinesVisible: boolean;
  alertLinesOnlyActive: boolean;
  alertLineColor: string;
  // Scales → Price Scale / Price labels rows.
  currencyUnit: NavButtonsBehavior;
  scaleModes: NavButtonsBehavior;
  lockRatio: boolean;
  lockRatioValue: number | undefined;
  alignLabels: boolean;
  plusButton: boolean;
  saveLeftEdge: boolean;
  preMarketBgColor: string;
  postMarketBgColor: string;
  legendMarketStatus: boolean;
  latestNews: boolean;
  newsNotification: boolean;
  autoHideToasts: boolean;
  /** Per-chart-type style rows (Symbol tab). */
  styles: SeriesStyles;
  /** Chart font stack (labels drawn by custom renderers). */
  fontFamily: string;
};

/** Colours/toggles committed from the Chart Properties dialog, folded over the
 *  CSS tokens by readChartTokens. Per-pane: each ChartView passes its own
 *  pane's committed appearance (window/header/chart-settings.ts →
 *  appearanceFrom). */
export type AppearanceOverride = ChartAppearance;

/** Read the CSS chart tokens, folding a pane's committed appearance over them.
 *  `o` is that pane's override (empty when the pane has no committed settings). */
export function readChartTokens(o: AppearanceOverride = {}): ChartTokens {
  // Panes OK'd in the Settings dialog before 26/07/2026 froze that day's
  // dialog defaults into their committed draft: grid rgba(242,242,242,0.06)
  // solid (the default has since been corrected to 0.2 dotted). That
  // exact combination was never a deliberate user choice — treat it as
  // unset so the corrected defaults apply.
  const STALE_GRID = "rgba(242, 242, 242, 0.06)";
  if (o.grid === STALE_GRID) o = { ...o, grid: undefined };
  if (o.gridVertColor === STALE_GRID && !o.gridVertStyle)
    o = { ...o, gridVertColor: undefined, gridVertStyle: undefined };
  if (o.gridHorzColor === STALE_GRID && !o.gridHorzStyle)
    o = { ...o, gridHorzColor: undefined, gridHorzStyle: undefined };
  const s = getComputedStyle(document.documentElement);
  const grid = o.grid || s.getPropertyValue("--ot-chart-grid").trim() || "#2e2e2e";
  const text = s.getPropertyValue("--ot-chart-text").trim() || "#dbdbdb";
  const up = o.up || s.getPropertyValue("--ot-chart-up").trim() || "#4caf50";
  const down = o.down || s.getPropertyValue("--ot-chart-down").trim() || "#f23645";
  const bg = o.bg || s.getPropertyValue("--ot-chart-bg").trim() || "#0f0f0f";
  return {
    bg,
    bgGradient: o.bgGradient ?? false,
    bgBottom: o.bgBottom || bg,
    text,
    grid,
    up,
    down,
    bodyVisible: o.bodyVisible ?? true,
    borderUpColor: o.borderUpColor || up,
    borderDownColor: o.borderDownColor || down,
    borderVisible: o.borderVisible ?? true,
    wickUpColor: o.wickUpColor || up,
    wickDownColor: o.wickDownColor || down,
    wickVisible: o.wickVisible ?? true,
    gridVertColor: o.gridVertColor || grid,
    gridHorzColor: o.gridHorzColor || grid,
    gridVertVisible: o.gridVertVisible ?? true,
    gridHorzVisible: o.gridHorzVisible ?? true,
    // Dark default: both grids dotted.
    gridVertStyle: o.gridVertStyle ?? 2,
    gridHorzStyle: o.gridHorzStyle ?? 2,
    crosshairColor: o.crosshairColor || "rgb(156, 156, 156)",
    crosshairStyle: o.crosshairStyle ?? 1,
    crosshairWidth: o.crosshairWidth ?? 1,
    crosshairLabelBg:
      s.getPropertyValue("--ot-chart-crosshair-label-bg").trim() || "#3d3d3d",
    paneSeparator: s.getPropertyValue("--ot-chart-pane-separator").trim() || "#4a4a4a",
    // Scales: text #B8B8B8, border lines fully transparent. Both differ from
    // the general chart text/grid colours.
    scaleTextColor: o.scaleTextColor || "#b8b8b8",
    scaleFontSize: o.scaleFontSize ?? 12,
    scaleLinesColor: o.scaleLinesColor || "rgba(242, 242, 242, 0)",
    marginTop: o.marginTop ?? 0.1,
    marginBottom: o.marginBottom ?? 0.08,
    // Not `?? 0`: an uncommitted pane must match the dialog's Canvas → Margins
    // → Right row (10 bars), or the chart has no right margin until the Settings
    // dialog happens to be OK'd once.
    rightOffset: o.rightOffset ?? DEFAULT_RIGHT_OFFSET,
    scalesPlacement: o.scalesPlacement ?? "right",
    navButtons: o.navButtons ?? "visibleOnMouseOver",
    paneButtons: o.paneButtons ?? "visibleOnMouseOver",
    precision: o.precision || "Default",
    sessionBreaksVisible: o.sessionBreaksVisible ?? false,
    sessionBreaksColor: o.sessionBreaksColor || "rgb(73, 133, 231)",
    // Session breaks: dashed, 1 px.
    sessionBreaksStyle: o.sessionBreaksStyle ?? 1,
    sessionBreaksWidth: o.sessionBreaksWidth ?? 1,
    colorBarsOnPrevClose: o.colorBarsOnPrevClose ?? false,
    symbolLastValue: o.symbolLastValue ?? true,
    symbolPriceLine: o.symbolPriceLine ?? true,
    // The Symbol check list defaults to "Name" on (the ticker inside the
    // price label), matching the dialog default.
    symbolNameLabel: o.symbolNameLabel ?? true,
    symbolPriceLineColor: o.symbolPriceLineColor ?? "",
    symbolPriceLineWidth: o.symbolPriceLineWidth ?? 1,
    symbolValuePercent: o.symbolValuePercent ?? false,
    // Countdown defaults ON (the Scales row ships checked).
    countdownVisible: o.countdown ?? true,
    // "Previous day close" ships Hidden (both options unchecked); the swatch
    // default is gray.
    prevCloseLabel: o.prevCloseLabel ?? false,
    prevCloseLine: o.prevCloseLine ?? false,
    prevCloseColor: o.prevCloseColor || "#555555",
    prevCloseWidth: o.prevCloseWidth ?? 1,
    // "Pre/post/night market" ships Value + Line on (series default
    // prePostMarket.visible true + scalesProperties.showPrePostMarketPriceLabel
    // true); colours are the defaults.
    prePostLabel: o.prePostLabel ?? true,
    prePostLine: o.prePostLine ?? true,
    preMarketColor: o.preMarketColor || "rgb(251, 140, 0)",
    postMarketColor: o.postMarketColor || "rgb(41, 98, 255)",
    // "High and low" labels default ON (highLowPriceLabelsVisible: true);
    // lines stay off.
    highLowLabels: o.highLowLabels ?? true,
    highLowLines: o.highLowLines ?? false,
    highLowColor: o.highLowColor ?? "",
    highLowWidth: o.highLowWidth ?? 1,
    watermarkColor: o.watermarkColor || "rgba(80, 83, 94, 0.3)",
    watermarkTicker: o.watermarkTicker ?? false,
    watermarkInterval: o.watermarkInterval ?? false,
    watermarkDescription: o.watermarkDescription ?? false,
    // "Indicators and financials" value labels default OFF
    // (showStudyLastValue: false), and stacked study badges have no overlap
    // management here. The dialog row re-enables them.
    indLastValue: o.indLastValue ?? false,
    // Alerts tab rows both ship checked.
    alertLinesVisible: o.alertLines ?? true,
    alertLinesOnlyActive: o.alertLinesOnlyActive ?? true,
    alertLineColor: o.alertLineColor || up,
    currencyUnit: o.currencyUnit ?? "visibleOnMouseOver",
    scaleModes: o.scaleModes ?? "visibleOnMouseOver",
    lockRatio: o.lockRatio ?? false,
    lockRatioValue: o.lockRatioValue,
    alignLabels: o.alignLabels ?? true,
    plusButton: o.plusButton ?? true,
    saveLeftEdge: o.saveLeftEdge ?? false,
    preMarketBgColor: o.preMarketBgColor || "rgba(255, 152, 0, 0.08)",
    postMarketBgColor: o.postMarketBgColor || "rgba(41, 98, 255, 0.08)",
    legendMarketStatus: o.legendMarketStatus ?? true,
    latestNews: o.latestNews ?? true,
    newsNotification: o.newsNotification ?? false,
    autoHideToasts: o.autoHideToasts ?? true,
    styles: o.styles ?? DEFAULT_SERIES_STYLES,
    fontFamily: readFontFamily(),
  };
}

export function readFontFamily(): string {
  return (
    getComputedStyle(document.documentElement)
      .getPropertyValue("--font-family-base")
      .trim() ||
    "-apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif"
  );
}
