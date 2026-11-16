/*
 * The chart an embed opens on (#338): one tab, one chart, built from the
 * embed's settings (the app would otherwise restore the visitor's tabs).
 */
import type { EmbedConfig } from "./config";
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
  tab.panes = tab.panes.map((p) => ({
    ...p,
    ...(Object.keys(indicatorSettings).length ? { indicatorSettings } : {}),
    ...(compare.length ? { compare } : {}),
  }));
  return tab;
}
