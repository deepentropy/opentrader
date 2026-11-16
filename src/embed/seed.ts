/*
 * The chart an embed opens on (#338): one tab, one chart, built from the
 * embed's settings (the app would otherwise restore the visitor's tabs). The
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

/** The interval a chart opens on: the range's own interval when a range is set. */
export function embedInterval(c: EmbedConfig): string {
  const range = c.range && DATE_RANGES.find((r) => r.id === c.range);
  if (range) return range.interval;
  return isSupportedResolution(c.interval) ? c.interval : "1D";
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
    symbol: c.symbol,
    interval: embedInterval(c),
    chartType: c.chartType && CHART_TYPE_IDS.has(c.chartType as ChartTypeId) ? (c.chartType as ChartTypeId) : undefined,
    session: c.extendedHours ? "ETH" : "RTH",
    indicators,
  });
  const compare: CompareEntry[] = c.compare
    .filter((s) => s !== c.symbol)
    .map((symbol, i) => {
      const color = COMPARE_COLORS[i % COMPARE_COLORS.length];
      return { id: newCompareId(), symbol, placement: "percent", color, style: newCompareStyle(color) };
    });
  const settings = embedChartDraft(c.colors);
  tab.panes = tab.panes.map((p) => ({
    ...p,
    ...(settings ? { settings: cloneDraft(settings), settingsFp: SETTINGS_FINGERPRINT, settingsRev: SETTINGS_REV } : {}),
    ...(Object.keys(indicatorSettings).length ? { indicatorSettings } : {}),
    ...(compare.length ? { compare } : {}),
  }));
  return tab;
}
