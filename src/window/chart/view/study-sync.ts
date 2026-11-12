/*
 * The chart's studies: the indicator controller (created once the chart
 * exists, with the chart as its host) and the effects that keep it in step
 * with the pane (the active set and its saved settings, the chart context of
 * the scripts, the chart type, the interval, the study axis labels).
 */
import { createEffect, untrack } from "solid-js";
import type { IChartApi, ISeriesApi, SeriesType } from "lightweight-charts";
import { IndicatorController } from "../indicators/indicator-controller";
import { scriptChartContext } from "../indicators/script-chart";
import { compareSource } from "../compare/compare-style";
import { readChartTokens } from "../chart-tokens";
import { studyBars } from "./series";
import { type ChartCx } from "./context";

/** What createStudySync adds to the chart context. */
export interface StudySyncApi {
  /** The controller of this chart's studies, the chart as its host. */
  createController: (chart: IChartApi) => IndicatorController;
  /** The studies' chart context follows the series whose bars the chart now shows (set with its bars, #308). */
  applyScriptChart: () => void;
}

export function createStudySync(cx: ChartCx): StudySyncApi {
  const { appearance, chartReady, props } = cx;
  const legendAtCrosshair = () => cx.refreshIndicatorLegend(cx.crosshairActive ? cx.lastLegendTime : undefined);

  function createController(chart: IChartApi): IndicatorController {
    return new IndicatorController(chart, {
      chartId: String(cx.paneId),
      // The controller reads the bars on demand, so it always recomputes against the freshest dataset.
      bars: () => studyBars(cx),
      // The chart's bars: a slice of the loaded ones on a long history (bar-slice.ts).
      chartBars: () => (cx.raw !== cx.allBars && !cx.replayActive ? (cx.raw as unknown as ReturnType<typeof studyBars>) : studyBars(cx)),
      lastBarOpen: () => cx.lastBarForming(),
      mainSeries: () => cx.series as ISeriesApi<SeriesType> | null,
      // Studies over the series take its scale (its side when it has no scale).
      scaleIds: () => {
        const k = cx.seriesKey();
        return { price: k === "none" ? cx.mainSide() : k, pane: cx.currentTokens().scalesPlacement };
      },
      scaleResolve: (id, pane, key) => cx.scaleResolve(id, pane, key),
      // Study on study: a compared symbol's values, the names of the sources in the legend.
      externalSource: (id) => cx.compareLayers.get(id)?.sourcePoints() ?? null,
      externalSpec: (id) => {
        const e = cx.compareEntry(id);
        return e ? { symbol: e.symbol, source: compareSource(e.style) } : null;
      },
      sourceText: (v) => cx.sourceInputText(v),
      mainPaneMoved: () => cx.onMainPaneMoved(),
      seriesChanged: () => {
        cx.scheduleSourceOrder();
        cx.syncSideScales();
        cx.syncScaleLayout();
        cx.setAlertSeriesEpoch((n) => n + 1);
      },
      drawingsData: () => cx.setCoordEpoch((n) => n + 1),
      redrawn: legendAtCrosshair,
    });
  }

  // Sync the active-indicator set onto the chart whenever it changes (or once
  // the controller exists). The controller adds/removes study layers and stacks
  // oscillator panes; overlay studies render against whatever bars `raw` holds.
  createEffect(() => {
    chartReady();
    const { controller } = cx;
    // "Hide indicators" suppresses the layers (sync an empty set) while keeping
    // props.indicators intact, so toggling it back restores them verbatim.
    const ids = props.indicatorsHidden ? [] : (props.indicators ?? []);
    // The saved place of the series first: the studies of the pane it
    // shares open in its pane.
    // Only a new saved value (a chart load, a tab shown in this view): the
    // chart's own moves save theirs after the move.
    const seriesPane = props.seriesPane ?? null;
    if (seriesPane !== cx.appliedSeriesPane) {
      cx.appliedSeriesPane = seriesPane;
      untrack(() => {
        controller?.setSeriesGroup(seriesPane);
        // A saved place given back (undo of a move): the panes take the saved stacking order again (the move put
        // the series' new pane at the bottom).
        controller?.setPaneOrder(props.paneOrder ?? []);
      });
    }
    // Seed persisted inputs/styles before sync so a freshly-added layer renders
    // with the user's saved values (sync → add reads the seeded maps). After
    // the series' place: an undo of a series move gives the studies that
    // stayed behind their former pane once the series is back in its own.
    if (props.indicatorSettings) controller?.seedSettings(props.indicatorSettings);
    controller?.sync(ids);
    // The study pane the series was dragged into is gone (its studies were
    // removed): the saved place goes too ("Hide indicators" keeps it).
    if (!props.indicatorsHidden && controller?.seriesGroupGone()) untrack(() => cx.edits.setSeriesPane(null));
    // Study panes added / removed: the drawing panes follow.
    cx.setPaneEpoch((n) => n + 1);
    queueMicrotask(cx.refreshPaneBoxes);
    legendAtCrosshair();
  });

  // Chart context (timeframe, session, tickerid, background) of the studies: the series whose bars are shown. While
  // another series loads, the studies still calculate on the bars before (a script update, a resize): the context of
  // the new one would read them as its own (intraday bars stamped as daily ones, #308). The data apply sets the new
  // context with the new bars (applyScriptChart).
  const pushScriptChart = () => {
    const s = cx.shownSeries() ?? { symbol: props.symbol, interval: props.interval, session: props.session };
    const t = readChartTokens(appearance());
    cx.controller?.setScriptChart(scriptChartContext(s.symbol, s.interval, s.session, { top: t.bg, bottom: t.bgGradient ? t.bgBottom : t.bg }));
  };
  createEffect(() => {
    chartReady();
    pushScriptChart();
  });
  const applyScriptChart = () => untrack(pushScriptChart);

  // Strategies on a Heikin Ashi chart run on its Heikin Ashi bars.
  createEffect(() => {
    chartReady();
    cx.controller?.setHeikinAshi((props.chartType ?? "candle") === "ha");
  });

  // Volume Candles: column plots (Volume) as wide as their candle.
  createEffect(() => {
    chartReady();
    cx.controller?.setVolumeCandles((props.chartType ?? "candle") === "volCandles");
  });

  // Indicator Visibility tab: studies off the chart interval stop drawing.
  createEffect(() => {
    chartReady();
    const iv = props.interval ?? "1D";
    cx.controller?.setChartInterval(iv);
    legendAtCrosshair();
    cx.applyStrategyMarkers();
  });

  // Scales → "Indicators and financials": last-value axis labels on the study
  // series. Re-runs on settings commit; the controller no-ops when unchanged.
  createEffect(() => {
    chartReady();
    const t = readChartTokens(appearance());
    cx.controller?.setLastValueVisible(t.indLastValue);
    cx.controller?.setNameLabelsVisible(t.indNameLabel);
  });

  return { createController, applyScriptChart };
}
