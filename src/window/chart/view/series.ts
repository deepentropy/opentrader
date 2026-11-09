/*
 * The main series: built again for a chart type or appearance change (its
 * view, primitives and decorations carried over), its pane and scale (the
 * price pane can sit at any position and the series can share a study pane;
 * the controller keeps the pane layout, the series and the decorations follow
 * it), its price format and its hidden state.
 */
import { createEffect, createMemo, createSignal, on, untrack, type Accessor } from "solid-js";
import { LineStyle, type IPriceScaleApi, type Logical, type Time, type UTCTimestamp } from "lightweight-charts";
import type { Bar } from "oakscriptjs";
import { createSeriesForType, isTransformType, setDataForType, transformBarsOf, type AnySeries, type ChartTypeId, type OHLC } from "../chart-types";
import { countdownText } from "../countdown";
import { chartPriceFormat } from "../price-format";
import { readChartTokens } from "../chart-tokens";
import { chartSeconds } from "../profiles/vbp-studies";
import { isScaleKey, type ScaleKey } from "../scales/scale-layout";
import { makeCoords } from "../../drawings/coords";
import { isEconomicSymbol, isIntradayInterval, isLocalSymbol, splitSymbol } from "../../../data/datafeed";
import { cachedSymbolSessions } from "../../../data/session";
import { barsSpan } from "./helpers";
import { type ChartCx } from "./context";

/** What createSeries adds to the chart context. */
export interface SeriesApi {
  /** Style work that depends on the series data (base level, gradient label, history end, future bars, journal). */
  afterSeriesData: () => void;
  /** Apply the price format again (the symbol's tick grid is known). */
  applyPriceFormat: () => void;
  /** Put the series on the scale it should be on. */
  applySeriesScale: () => void;
  dataExtras: () => Parameters<typeof setDataForType>[4];
  /** The newest bar is still forming (its countdown runs). */
  lastBarForming: () => boolean;
  /** Width of the left price axis (0 when hidden). */
  leftAxisWidth: () => number;
  /** Price text of the main series (Precision choice), shared with the legend. */
  legendPriceFormat: Accessor<((p: number) => string) | undefined>;
  mainLastIndex: () => number | null;
  /** Pane of the main series (the price pane; any position). */
  mainPane: () => number;
  /** Bumped when the price pane moves or the series changes pane or scale. */
  mainPaneEpoch: Accessor<number>;
  /** Price scale of the main series. */
  mainScale: () => IPriceScaleApi | null;
  /** Side of the main series' scale (the free side in a study pane it shares). */
  mainSide: () => "left" | "right";
  /** The price pane moved or changed (controller hook). */
  onMainPaneMoved: () => void;
  /** Build the series again for the current type and appearance. */
  rebuildSeries: () => void;
  /** The time a label shows (a brick reads the real time of its source bar). */
  realTimeOf: (t: Time) => UTCTimestamp;
  /** Scale key of the main series (pinned, else its side) and its library scale id. */
  seriesKey: () => ScaleKey | "none";
  seriesLibId: () => string;
  /** "Scale price chart only": the library id of the series' scale, null when off. */
  seriesOnlyScale: () => string | null;
  /** Show the price axes the series and the compared symbols use. */
  syncScaleSides: () => void;
}

export function createSeries(cx: ChartCx): SeriesApi {
  const { appearance, currentTokens, props } = cx;
  // Type the current series was built with (rebuildSeries compares it with
  // the new type to choose how the view carries over).
  let builtType: ChartTypeId | null = null;
  const [legendPriceFormat, setLegendPriceFormat] = createSignal<((p: number) => string) | undefined>(undefined);
  const [mainPaneEpoch, setMainPaneEpoch] = createSignal(0);

  /** The newest bar is still forming (its countdown runs): price-based
   *  types draw what it built as projection bars. */
  function lastBarForming(): boolean {
    const { raw } = cx;
    const last = raw.length > 0 ? raw[raw.length - 1] : null;
    if (!last || typeof last.time !== "number" || isEconomicSymbol(props.symbol) || isLocalSymbol(props.symbol)) return false;
    const sessions = cachedSymbolSessions(props.symbol ?? "");
    return countdownText(props.interval ?? "1D", Date.now() / 1000, last.time as number, props.session ?? "RTH", sessions) != null;
  }
  const dataExtras = () => ({
    subMinute: cx.subMinute ?? undefined,
    lastForming: lastBarForming(),
    sessions: cachedSymbolSessions(props.symbol ?? ""),
  });

  /** Style work that depends on the series data: the Baseline base level
   *  and the gradient line's label colour. */
  function afterSeriesData() {
    cx.syncBaseline();
    cx.syncGradientLabel();
    cx.updateHistoryEnd();
    cx.syncFutureBars();
    cx.syncJournalMarks();
  }

  /** Time-scale index of the main series' last item. Price-based types have
   *  their own items, and study series add their times to the axis, so it is
   *  not the source bar count there. */
  function mainLastIndex(): number | null {
    const { chart, series, raw } = cx;
    if (!chart || !series) return null;
    if (!isTransformType(cx.activeType)) return raw.length > 0 ? raw.length - 1 : null;
    const items = series.data();
    if (items.length === 0) return null;
    return chart.timeScale().timeToIndex(items[items.length - 1].time, true) as number | null;
  }

  /** The time a label shows: a price-based type's brick reads the real time
   *  of its source bar (its own time is synthetic). */
  const realTimeOf = (t: Time): UTCTimestamp => {
    const m = isTransformType(cx.activeType) ? transformBarsOf(cx.series)?.realTime : null;
    return (m?.get(t as number) ?? (t as number)) as UTCTimestamp;
  };

  // ── The price pane ────────────────────────────────────────────────────
  function mainPane(): number {
    return cx.controller?.mainPaneIndex() ?? 0;
  }
  /** Side of the series' scale: the chosen side ("Scales placement"); in a
   *  study pane it shares, the pane's scale when it shows prices (a price
   *  study or a compared symbol leads it), else the study keeps its scale and
   *  the series takes the free side (reference "Auto" rule; with "Stack on
   *  the left / right" the reference stacks a second scale on that side,
   *  which the chart library cannot draw: the free side too). */
  function mainSide(): "left" | "right" {
    const placement = currentTokens().scalesPlacement;
    const { controller } = cx;
    if (!controller?.seriesShares() || controller.seriesSharesPriceScale()) return placement;
    return placement === "right" ? "left" : "right";
  }
  /** Scale key of the main series: the scale it was pinned to (series menu "Pin to scale"), else its side. */
  function seriesKey(): ScaleKey | "none" {
    const k = props.seriesScale;
    return k === "none" || isScaleKey(k) ? k : mainSide();
  }
  /** Chart library scale id of the main series (a hidden scale of its own for "no scale"). */
  function seriesLibId(): string {
    const k = seriesKey();
    if (k === "none") return "series:none";
    return cx.scaleLayout().libId(mainPane(), k);
  }
  /** The series on the scale it should be on (pinned, a scale layout change). */
  function applySeriesScale() {
    const { series } = cx;
    if (!series) return;
    const id = seriesLibId();
    if ((series.options() as { priceScaleId?: string }).priceScaleId !== id) series.applyOptions({ priceScaleId: id });
  }
  function mainScale() {
    const { chart, series } = cx;
    if (!chart) return null;
    if (series) return series.priceScale();
    return chart.priceScale(mainSide(), mainPane());
  }
  function leftAxisWidth(): number {
    if (!cx.chart) return 0;
    try { return cx.chart.priceScale("left").width(); } catch { return 0; }
  }
  /** Price axes shown: the chosen side, and the other one while a scale of
   *  the chart is there (the series in a study pane it shares, a compared
   *  symbol on a new price scale, a study pinned to it). */
  function syncScaleSides() {
    const { chart } = cx;
    if (!chart) return;
    const placement = currentTokens().scalesPlacement;
    const other = placement === "right" ? "left" : "right";
    const counts = cx.scaleLayout().slotCounts();
    const used = mainSide() === other || counts[other] > 0;
    chart.applyOptions(other === "left" ? { leftPriceScale: { visible: used } } : { rightPriceScale: { visible: used } });
  }
  /** "Scale price chart only": studies and compared symbols on the main
   *  series' scale leave its auto-scale. */
  const seriesOnlyScale = () => {
    const t = readChartTokens(appearance());
    void mainPaneEpoch();
    return t.scaleSeriesOnly ? seriesLibId() : null;
  };
  /** The price pane moved or changed (controller hook): the series goes to
   *  its pane and side (its scale keeps its modes), the price pane's other
   *  sources and the decorations follow. */
  function onMainPaneMoved() {
    const { chart, series, controller } = cx;
    if (!chart || !series || !controller) return;
    const m = mainPane();
    let pane = -1;
    try { pane = series.getPane().paneIndex(); } catch { /* not laid out */ }
    const side = seriesLibId();
    const sideNow = (series.options() as { priceScaleId?: string }).priceScaleId;
    if (pane !== m || sideNow !== side) {
      let o: ReturnType<ReturnType<AnySeries["priceScale"]>["options"]> | null = null;
      try { o = series.priceScale().options(); } catch { /* not on a scale */ }
      // Built again in its pane on its side (moving a series with its
      // primitives between panes in place lets them read it while it has no
      // pane), its view and decorations kept.
      rebuildSeries();
      // A scale of its own keeps the modes of its former scale (percent,
      // log, inverted); a shared price scale keeps its own (reference).
      if (o && cx.series && !controller.seriesSharesPriceScale()) cx.series.priceScale().applyOptions({ mode: o.mode, invertScale: o.invertScale, autoScale: o.autoScale });
    }
    // Compared symbols over the series follow it (not syncCompare: it
    // re-applies the saved pane order, which the caller saves after this).
    cx.followMainPane();
    // Studies over the series take its new scale (and pane mode).
    controller.redrawAll();
    // Saved after the move (the save re-runs the chart's effects).
    queueMicrotask(() => {
      const group = cx.controller?.seriesPaneGroup() ?? null;
      if (group !== (props.seriesPane ?? null)) {
        cx.appliedSeriesPane = group;
        cx.edits.setSeriesPane(group);
      }
    });
    setMainPaneEpoch((n) => n + 1);
    cx.setPaneEpoch((n) => n + 1);
    // The panes are laid out again on the next frame: their boxes then.
    const relayout = () => {
      cx.refreshPaneBoxes();
      cx.refreshScaleOverlays();
    };
    queueMicrotask(relayout);
    requestAnimationFrame(() => requestAnimationFrame(relayout));
    cx.refreshIndicatorLegend(cx.crosshairActive ? cx.lastLegendTime : undefined);
  }

  /** Symbol → Precision on the series and the legend ("Default": the symbol's tick grid, known once its session
   *  resolved — applied again when its bars arrive). */
  function applyPriceFormat() {
    if (!cx.series) return;
    // An economic series: values from 1,000 on abbreviated (reference).
    const fmt = chartPriceFormat(currentTokens().precision, cachedSymbolSessions(props.symbol ?? ""), isEconomicSymbol(props.symbol));
    if (fmt) cx.series.applyOptions({ priceFormat: { type: "custom", formatter: fmt.format, minMove: fmt.minMove } });
    setLegendPriceFormat(() => fmt?.format);
  }

  function rebuildSeries() {
    const { chart } = cx;
    if (!chart) return;
    // Preserve the user's scroll position across the series swap. Creating a
    // fresh series and calling setData snaps the time scale back to the latest
    // bars (default rightOffset framing) — so a chart-type or Settings change
    // while scrolled to a historical date would jump the view to today. Capture
    // the visible logical range first and restore it after re-seeding. Null on
    // the empty initial mount (no data yet), where the data-apply effect frames
    // the view instead.
    const savedRange = chart.timeScale().getVisibleLogicalRange();
    // Detach first: removing a series fires range / scale callbacks (locked
    // ratio, baseline, countdown), which must not reach the removed series;
    // the library throws on a detached series' price scale.
    const old = cx.series;
    cx.series = null;
    // The library deletes a pane left empty while other panes exist: with a
    // study pane open, removing the main series would delete its pane, and the
    // new series would land in the study pane (wrong height, study moved to
    // a new pane). Keep the main pane alive across the swap.
    const oldPane = old ? old.getPane() : null;
    const preserved = oldPane?.preserveEmptyPane() ?? false;
    oldPane?.setPreserveEmptyPane(true);
    cx.dropFutureSeries();
    if (old) chart.removeSeries(old);
    cx.forgetBaseline();
    const tokens = currentTokens();
    const activeType = cx.activeType;
    const series = createSeriesForType(chart, activeType, tokens, mainPane());
    cx.series = series;
    oldPane?.setPreserveEmptyPane(preserved);
    const prevType = builtType;
    builtType = activeType;
    setDataForType(series, activeType, cx.raw, tokens, dataExtras());
    afterSeriesData();
    // To or from a price-based type: the studies run on other bars.
    if (prevType !== activeType && ((prevType !== null && isTransformType(prevType)) || isTransformType(activeType))) cx.controller?.renderAll();
    // Symbol → Precision: the picked decimals ("Default" follows the
    // symbol's tick grid), thousands grouped; the legend uses the same text.
    // The fractional choices (1/2 …) use the fractional format (123'16).
    applyPriceFormat();
    // Bind the price axis to the series' side (Scales placement; the free
    // side in a study pane it shares).
    series.applyOptions({ priceScaleId: seriesLibId() });
    syncScaleSides();
    cx.syncScaleLayout();
    // Legend eye (series `visible`): a rebuilt series keeps the hidden state
    // (the live toggle is the seriesHidden effect below).
    series.applyOptions({ visible: !untrack(() => props.seriesHidden) });
    // A rebuilt series is created in front: back to its place in the order.
    cx.scheduleSourceOrder();
    // Scales → Price labels → Symbol: last-value axis label + price line
    // (picker enum 0/1/2 → library Solid/Dashed/Dotted). "Name" puts the
    // ticker inside the price-scale label (the library's series title).
    // The price line is dotted by default; its colour "" follows
    // the last bar (library default), a picked colour overrides it.
    series.applyOptions({
      lastValueVisible: tokens.symbolLastValue,
      priceLineVisible: tokens.symbolPriceLine,
      priceLineColor: tokens.symbolPriceLineColor,
      priceLineStyle: LineStyle.Dotted,
      priceLineWidth: Math.max(1, Math.min(4, tokens.symbolPriceLineWidth)) as 1 | 2 | 3 | 4,
      title: tokens.symbolNameLabel ? splitSymbol(props.symbol ?? "").ticker : "",
    });
    // Re-attach the session-breaks separators to the fresh series and refresh
    // their boundaries against the current bars.
    series.attachPrimitive(cx.sessionBreaks);
    series.attachPrimitive(cx.sessionBackgrounds);
    if (cx.lockAxis) series.attachPrimitive(cx.lockAxis);
    // Strategy trade marks belong to the series: re-attach to the new one.
    cx.forgetTradeMarkers();
    cx.applyStrategyMarkers();
    // Study markers and bar colours are drawn on the main series: redraw the
    // studies on the new one (from their last results).
    cx.controller?.redrawAll();
    cx.forgetPriceLines();
    cx.updateSessionBreaks();
    cx.setAlertSeriesEpoch((n) => n + 1);
    cx.updatePrePostLine();
    // Re-attach the dividend/split markers (their data is retained in the
    // instance and refreshed by the events effect below).
    series.attachPrimitive(cx.eventMarkers);
    series.attachPrimitive(cx.newsLollipop);
    series.attachPrimitive(cx.historyEnd);
    // Countdown axis label (state retained; the 1s timer keeps it ticking).
    series.attachPrimitive(cx.countdown);
    series.attachPrimitive(cx.scaleWatch);
    // Re-sync now, not on the next 1s tick — the fresh series was just
    // created with the plain lastValueVisible, which the countdown plate
    // replaces while it's showing.
    cx.updateCountdown();
    const mainCoords = makeCoords(
      chart,
      series,
      () => cx.raw,
      (sec) => (cx.controller ? cx.controller.overlayValuesAt(sec ?? undefined) : []),
      () => ({ timeZone: props.timeZone ?? "UTC", intraday: isIntradayInterval(props.interval ?? "1D") }),
      cx.futureAxis,
    );
    // Volume profile drawings: built from lower-timeframe bars of the chart symbol (as the profile studies).
    mainCoords.lowerTimeframe = {
      bars: (resolution, from) => cx.controller?.drawingLowerBars(resolution, from) as unknown as OHLC[] | undefined,
      barEnd: (time) => {
        const iv = props.interval ?? "1D";
        const sessions = cachedSymbolSessions(props.symbol ?? "");
        if (isIntradayInterval(iv) || !sessions) return time + Math.max(1, chartSeconds(iv));
        if (chartSeconds(iv) > 86400) {
          const raw = cx.raw;
          const i = raw.findIndex((b) => (b.time as number) === time);
          if (i >= 0 && i + 1 < raw.length) return raw[i + 1].time as number;
        }
        const day = sessions.regular.tradingDay(time);
        return sessions.regular.dayBounds(day)?.end ?? time + 86400;
      },
      seconds: /S$/i.test(props.interval ?? ""),
    };
    cx.setCoords(mainCoords);
    if (!cx.crosshairActive) cx.refreshLegend();
    // Renko / line break / kagi / P&F / range emit a DIFFERENT number of
    // items than the source bars (synthetic times ending at the last bar), so
    // a logical range taken on either side of such a switch no longer maps:
    // leaving one, the saved range still counts its synthetic times and
    // points past the last bar. Show the newest items instead of restoring
    // it. The other types keep one bar per source bar, so their view is
    // preserved.
    if (isTransformType(activeType) || (prevType !== null && isTransformType(prevType))) {
      // Frame the newest items at the current bar spacing, right margin kept
      // (set directly: scrollToRealTime animates and loses to later updates).
      const ts = chart.timeScale();
      const items = series.data();
      const lastT = items.length ? items[items.length - 1].time : null;
      const idx = lastT != null ? ts.timeToIndex(lastT, true) : null;
      const c0 = ts.logicalToCoordinate(0 as Logical);
      const c1 = ts.logicalToCoordinate(1 as Logical);
      const spacing = c0 != null && c1 != null ? Math.abs((c1 as number) - (c0 as number)) : 6;
      if (idx != null && spacing > 0) {
        const ro = currentTokens().rightOffset;
        ts.setVisibleLogicalRange({ from: (idx as number) + ro - barsSpan(ts.width(), spacing), to: (idx as number) + ro });
      }
    } else if (savedRange) {
      chart.timeScale().setVisibleLogicalRange({ from: savedRange.from, to: savedRange.to });
    }
  }

  // Legend eye: hide / show the main series (series `visible` property).
  createEffect(() => {
    const visible = !props.seriesHidden;
    cx.series?.applyOptions({ visible });
  });

  // Chart-type reactivity.
  let firstType = true;
  createEffect(() => {
    const t = props.chartType ?? "candle";
    if (firstType) {
      firstType = false;
      cx.activeType = t;
      return;
    }
    if (t === cx.activeType) return;
    cx.activeType = t;
    rebuildSeries();
  });

  // The series pinned to a scale (series menu "Pin to scale", undo): it goes there, the layout follows. On a change
  // of the scale only: the pane's props are read again on every save of the view, and redrawing every study then
  // (a projection after the last bar removed and drawn again) moved the view, which saved it again, in a loop.
  const seriesScale = createMemo(() => props.seriesScale);
  createEffect(on(seriesScale, () => {
    applySeriesScale();
    cx.controller?.redrawAll();
    cx.syncScaleLayout();
  }, { defer: true }));

  return {
    afterSeriesData,
    applyPriceFormat,
    applySeriesScale,
    dataExtras,
    lastBarForming,
    leftAxisWidth,
    legendPriceFormat,
    mainLastIndex,
    mainPane,
    mainPaneEpoch,
    mainScale,
    mainSide,
    onMainPaneMoved,
    rebuildSeries,
    realTimeOf,
    seriesKey,
    seriesLibId,
    seriesOnlyScale,
    syncScaleSides,
  };
}

/** Bars the studies run on: a price-based type's bricks (reference app), else the chart's bars. */
export function studyBars(cx: Pick<ChartCx, "activeType" | "series" | "raw">): Bar[] {
  return ((isTransformType(cx.activeType) ? transformBarsOf(cx.series)?.bars : null) ?? cx.raw) as unknown as Bar[];
}
