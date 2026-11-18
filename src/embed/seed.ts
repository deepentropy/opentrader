/*
 * The chart an embed opens on (#338): one tab, built from the embed's settings
 * (the app would otherwise restore the visitor's tabs): one chart, or a layout
 * of charts with one symbol each, their interval and date range synced (#366). The
 * page's colours (#339) become the chart's own settings: background, candle
 * up/down colours, scale text and grid.
 */
import type { EmbedColors, EmbedConfig } from "./config";
import { cloneDraft, keyOf, makeDefaultDraft, SETTINGS_FINGERPRINT, SETTINGS_REV, type Draft } from "../window/header/chart-settings";
import { DEFAULT_INDICATORS, makeTab, newCompareId, type CompareEntry, type PaneIndicatorSettings, type TabChart } from "../window/shell/tabs";
import { CHART_TYPE_IDS, type ChartTypeId } from "../window/chart/chart-types";
import { COMPARE_COLORS, newCompareStyle } from "../window/chart/compare/compare-style";
import { DATE_RANGES } from "../window/bottom-bar/BottomBar";
import { isSupportedResolution } from "../data/datafeed";
import { defaultLayoutSync } from "../window/chart/layout-sync";

/** The interval a chart opens on: the range's own interval when a range is set. */
export function embedInterval(c: EmbedConfig): string {
  const range = c.range && DATE_RANGES.find((r) => r.id === c.range);
  if (range) return range.interval;
  return isSupportedResolution(c.interval) ? c.interval : "1D";
}

/** The symbol of each chart: the page's `symbols` in order, then `symbol`. */
export function embedChartSymbols(c: EmbedConfig, count: number): string[] {
  return Array.from({ length: count }, (_, i) => (c.layout ? c.symbols[i] : undefined) ?? c.symbol);
}

/** The chart settings of a page's colours, over the theme's defaults (null: no colour the chart uses). */
export function embedChartDraft(colors: EmbedColors, base: Draft = makeDefaultDraft()): Draft | null {
  const { background, text, up, down, border } = colors;
  if (!background && !text && !up && !down && !border) return null;
  const d = cloneDraft(base);
  const set = (key: string, i: number, patch: Record<string, string>) => {
    const ctl = d[key]?.controls[i];
    if (ctl) d[key].controls[i] = { ...ctl, ...patch } as typeof ctl;
  };
  if (background) {
    set(keyOf("canvas", "Background"), 0, { value: "Solid" });
    set(keyOf("canvas", "Background"), 1, { color: background });
  }
  if (text) set(keyOf("canvas", "Text"), 0, { color: text });
  if (border) {
    set(keyOf("canvas", "Vertical grid lines"), 0, { color: border });
    set(keyOf("canvas", "Horizontal grid lines"), 0, { color: border });
  }
  // Every up/down pair of the series styles (candles, bars, Heikin Ashi…).
  if (up || down) {
    for (const [key, row] of Object.entries(d)) {
      if (!key.startsWith("symbol:") && !key.startsWith("style.")) continue;
      row.controls = row.controls.map((c) => (c.kind === "colorPair" ? { ...c, up: up ?? c.up, down: down ?? c.down } : c));
    }
  }
  return d;
}

export function embedSeedTab(c: EmbedConfig): TabChart {
  const indicators = c.hideVolume ? DEFAULT_INDICATORS.filter((id) => id !== "volume") : [...DEFAULT_INDICATORS];
  const indicatorSettings: Record<string, PaneIndicatorSettings> = {};
  for (const s of c.studies) {
    if (indicators.includes(s.id)) continue;
    indicators.push(s.id);
    if (s.inputs) indicatorSettings[s.id] = { inputs: { ...s.inputs } };
  }
  const tab = makeTab({
    layout: c.layout,
    symbol: c.symbol,
    interval: embedInterval(c),
    chartType: c.chartType && CHART_TYPE_IDS.has(c.chartType as ChartTypeId) ? (c.chartType as ChartTypeId) : undefined,
    session: c.extendedHours ? "ETH" : "RTH",
    indicators,
  });
  const compareOf = (own: string): CompareEntry[] =>
    c.compare
      .filter((s) => s !== own)
      .map((symbol, i) => {
        const color = COMPARE_COLORS[i % COMPARE_COLORS.length];
        return { id: newCompareId(), symbol, placement: "percent", color, style: newCompareStyle(color) };
      });
  const settings = embedChartDraft(c.colors);
  const symbols = embedChartSymbols(c, tab.panes.length);
  tab.panes = tab.panes.map((p, i) => {
    const compare = compareOf(symbols[i]);
    return {
      ...p,
      symbol: symbols[i],
      ...(settings ? { settings: cloneDraft(settings), settingsFp: SETTINGS_FINGERPRINT, settingsRev: SETTINGS_REV } : {}),
      ...(Object.keys(indicatorSettings).length ? { indicatorSettings: structuredClone(indicatorSettings) } : {}),
      ...(compare.length ? { compare } : {}),
    };
  });
  // Several charts: the page's interval and span apply to them all.
  if (tab.panes.length > 1) tab.sync = { ...defaultLayoutSync(), interval: true, dateRange: true };
  return tab;
}
