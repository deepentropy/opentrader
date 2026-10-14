/*
 * Price lines and labels drawn on the main series (Scales tab): high / low,
 * previous day close, pre / post market, the countdown plate, the baseline
 * waterline, the gradient label colour and the locked price-to-bar ratio.
 */
import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { LineStyle } from "lightweight-charts";
import type { IPriceLine, Logical } from "lightweight-charts";
import { readFontFamily } from "../chart-tokens";
import { countdownText } from "../countdown";
import { isIntradayInterval, splitSymbol } from "../../../data/datafeed";
import { heikinAshiLast, isTransformType } from "../chart-types";
import { quoteFor } from "../../../data/quotes";
import { marketSession as marketSessionOf } from "../../../data/market-session";
import { cachedSymbolSessions } from "../../../data/session";
import { mixColor, textColorOn } from "./helpers";
import { type ChartCx } from "./context";
import type { MarketSession } from "../../../data/session";
import type { Setter } from "solid-js";

/** What createDecorations adds to the chart context. */
export interface DecorationsApi {
  applyLockedRatio: () => void;
  forgetBaseline: () => void;
  forgetPriceLines: () => void;
  liveScaleRatio: () => number | undefined;
  lockedSpacingFromScale: () => void;
  marketSession: () => MarketSession | undefined;
  setStatusClock: Setter<number>;
  syncBaseline: () => void;
  syncGradientLabel: () => void;
  updateCountdown: () => void;
  updateHighLowLines: () => void;
  updatePrePostLine: () => void;
  updatePrevClosePriceLine: () => void;
}

export function createDecorations(cx: ChartCx): DecorationsApi {
  const { appearance, chartReady, countdown, currentTokens, hidden, props } = cx;
  // "High and low" price lines (Scales tab) over the LOADED data's extremes.
  // Series-owned, so a series rebuild drops them; refs + the memo key reset there.
  let highLine: IPriceLine | null = null;
  let lowLine: IPriceLine | null = null;
  let highLowKey = "";
  // "Previous day close" price line (Scales tab) at the last bar's previous
  // trading-day close. Same series-owned lifecycle as high/low above.
  let prevClosePriceLine: IPriceLine | null = null;
  let prevCloseKey = "";
  // "Pre/post/night market" price line + label (Scales tab). Same
  // series-owned lifecycle.
  let prePostLine: IPriceLine | null = null;
  let prePostKey = "";

  /** Locked ratio, other direction: a price-scale change (axis drag, pane
   *  resize) sets the bar spacing that keeps the ratio
   *  (spacing = height ÷ range × ratio). */
  function lockedSpacingFromScale() {
    const t = currentTokens();
    if (!t.lockRatio || !cx.chart || !cx.series || lockApplying) return;
    const ratio = t.lockRatioValue;
    const r = cx.series.priceScale().getVisibleRange();
    const h = cx.chart.paneSize(0).height;
    if (!(ratio !== undefined && ratio > 0) || !r || !(h > 0)) return;
    const len = Math.abs(r.to - r.from);
    if (!(len > 0)) return;
    const want = (h / len) * ratio;
    const cur = liveScaleRatio();
    if (cur !== undefined && Math.abs(cur - ratio) <= ratio * 1e-6) return;
    lockApplying = true;
    try { cx.chart.timeScale().applyOptions({ barSpacing: want }); } finally { lockApplying = false; }
  }

  /** Baseline: the base level sits at `Base level` % of the pane height
   *  from the bottom (height · (100 − level) / 100)
   *  and draws a sparse-dotted waterline there. The library takes a PRICE,
   *  so the price under that pixel row is re-derived whenever the visible
   *  price range can have moved. */
  let baselineWaterline: IPriceLine | null = null;
  let baselineLevelPrice: number | null = null;
  function syncBaseline() {
    for (const layer of cx.compareLayers.values()) layer.syncBaseline();
    if (!cx.chart || !cx.series || cx.activeType !== "baseline") return;
    const b = currentTokens().styles.baseline;
    const h = cx.chart.paneSize(0).height;
    if (!(h > 0)) return;
    const y = (h * Math.abs(100 - b.level)) / 100;
    const price = cx.series.coordinateToPrice(y);
    if (price == null || !Number.isFinite(price as number)) return;
    if (baselineLevelPrice !== null && Math.abs((price as number) - baselineLevelPrice) < 1e-9) return;
    baselineLevelPrice = price as number;
    cx.series.applyOptions({ baseValue: { type: "price", price: price as number } } as never);
    if (!baselineWaterline) {
      baselineWaterline = cx.series.createPriceLine({ price: price as number, color: "#8c8c8c", lineStyle: LineStyle.SparseDotted, lineWidth: 1, axisLabelVisible: false, title: "" });
    } else {
      baselineWaterline.applyOptions({ price: price as number });
    }
  }

  /** Gradient line: the last-value label takes the gradient colour at the
   *  last price's height. */
  function syncGradientLabel() {
    if (!cx.chart || !cx.series || (cx.activeType !== "line" && cx.activeType !== "lineWithMarkers" && cx.activeType !== "stepline")) return;
    const s = currentTokens().styles[cx.activeType];
    if (s.type !== "Gradient") return;
    const last = cx.raw.length > 0 ? cx.raw[cx.raw.length - 1] : null;
    const h = cx.chart.paneSize(0).height;
    const y = last ? cx.series.priceToCoordinate(last.close) : null;
    if (y == null || !(h > 0)) return;
    cx.series.applyOptions({ color: mixColor(s.start, s.end, Math.max(0, Math.min(1, (y as number) / h))) } as never);
  }

  /** Main series scale ratio: bar spacing ×
   *  visible price range ÷ pane height — price units per bar at a 1:1 pixel
   *  aspect. Undefined before the chart has data. */
  function liveScaleRatio(): number | undefined {
    if (!cx.chart || !cx.series) return undefined;
    const ts = cx.chart.timeScale();
    const c0 = ts.logicalToCoordinate(0 as Logical);
    const c1 = ts.logicalToCoordinate(1 as Logical);
    const r = cx.series.priceScale().getVisibleRange();
    const h = cx.chart.paneSize(0).height;
    if (c0 == null || c1 == null || !r || !(h > 0)) return undefined;
    return (Math.abs((c1 as number) - (c0 as number)) * Math.abs(r.to - r.from)) / h;
  }

  /** "Lock price to bar ratio": while locked, a bar-spacing change resizes
   *  the price range around its centre so the ratio holds
   *  (range = height ÷ (spacing ÷ ratio)). */
  let lockApplying = false;
  function applyLockedRatio() {
    const t = currentTokens();
    if (!t.lockRatio || !cx.chart || !cx.series || lockApplying) return;
    const ratio = t.lockRatioValue;
    if (!(ratio !== undefined && ratio > 0)) return;
    const ts = cx.chart.timeScale();
    const c0 = ts.logicalToCoordinate(0 as Logical);
    const c1 = ts.logicalToCoordinate(1 as Logical);
    const r = cx.series.priceScale().getVisibleRange();
    const h = cx.chart.paneSize(0).height;
    if (c0 == null || c1 == null || !r || !(h > 0)) return;
    const spacing = Math.abs((c1 as number) - (c0 as number));
    if (!(spacing > 0)) return;
    const len = (h * ratio) / spacing;
    if (Math.abs(Math.abs(r.to - r.from) - len) <= len * 1e-6) return;
    const mid = (r.from + r.to) / 2;
    lockApplying = true;
    try {
      cx.series.priceScale().setAutoScale(false);
      cx.series.priceScale().setVisibleRange({ from: mid - len / 2, to: mid + len / 2 });
    } finally {
      lockApplying = false;
    }
  }

  /** Scales → "Previous day close": one price line at the close of the LAST
   *  bar's previous trading day (the tail of {@link prevDayClose}, so it
   *  follows the recompute above). Memo key skips the createPriceLine churn
   *  like the high/low updater below. The badge is the row's gray by
   *  default; the line carries no title. */
  function updatePrevClosePriceLine() {
    if (!cx.series) return;
    const t = currentTokens();
    const price = cx.raw.length > 0 ? cx.prevDayClose[cx.raw.length - 1] : null;
    const enabled = (t.prevCloseLabel || t.prevCloseLine) && price != null;
    if (!enabled) {
      if (prevClosePriceLine) { cx.series.removePriceLine(prevClosePriceLine); prevClosePriceLine = null; }
      prevCloseKey = "";
      return;
    }
    const key = `${price}|${t.prevCloseLabel}|${t.prevCloseLine}|${t.prevCloseColor}|${t.prevCloseWidth}`;
    if (key === prevCloseKey && prevClosePriceLine) return;
    prevCloseKey = key;
    if (prevClosePriceLine) cx.series.removePriceLine(prevClosePriceLine);
    prevClosePriceLine = cx.series.createPriceLine({
      price: price!,
      color: t.prevCloseColor,
      title: "",
      lineStyle: LineStyle.Dotted,
      lineWidth: Math.max(1, Math.min(4, t.prevCloseWidth)) as 1 | 2 | 3 | 4,
      lineVisible: t.prevCloseLine,
      axisLabelVisible: t.prevCloseLabel,
    });
  }

  /** Scales → "Pre/post/night market": the latest extended-hours trade as a
   *  "Pre"/"Post" price label + dotted line: shown only while the market is in
   *  pre- or post-market, and only when the chart does not draw that trade
   *  itself (daily/weekly/monthly, or intraday on the regular session).
   *  Colour by session; label text black/white from the background. No
   *  overnight ("night") price: the data plan has none. */
  const [statusClock, setStatusClock] = createSignal(Date.now());
  /** Market state of the charted symbol's own market (re-read every 15 s). */
  const marketSession = () => marketSessionOf(props.symbol ?? "", new Date(statusClock())) ?? undefined;
  onMount(() => {
    const id = window.setInterval(() => { if (!hidden()) setStatusClock(Date.now()); }, 15_000);
    onCleanup(() => window.clearInterval(id));
  });

  function updatePrePostLine() {
    if (!cx.series) return;
    const t = currentTokens();
    const session = marketSession();
    const q = quoteFor(props.symbol ?? "");
    const onChartAlready =
      isIntradayInterval(props.interval ?? "1D") && (props.session ?? "RTH") === "ETH";
    const price =
      q && q.extChangePercent != null && q.last > 0 ? q.last * (1 + q.extChangePercent / 100) : null;
    const enabled =
      (t.prePostLabel || t.prePostLine) &&
      (session === "pre" || session === "post") &&
      !onChartAlready &&
      price != null;
    if (!enabled) {
      if (prePostLine) { cx.series.removePriceLine(prePostLine); prePostLine = null; }
      prePostKey = "";
      return;
    }
    const color = session === "pre" ? t.preMarketColor : t.postMarketColor;
    const key = `${session}|${t.prePostLabel}|${t.prePostLine}|${color}`;
    if (key === prePostKey && prePostLine) {
      prePostLine.applyOptions({ price: price! });
      return;
    }
    prePostKey = key;
    if (prePostLine) cx.series.removePriceLine(prePostLine);
    prePostLine = cx.series.createPriceLine({
      price: price!,
      color,
      title: session === "pre" ? "Pre" : "Post",
      // Dotted, width 1 (drawn 1 px on / 3 px off; the
      // library's SparseDotted 1/4 is the closest, as for the grid).
      lineStyle: LineStyle.SparseDotted,
      lineWidth: 1,
      lineVisible: t.prePostLine,
      axisLabelVisible: t.prePostLabel,
      axisLabelColor: color,
      axisLabelTextColor: textColorOn(color),
    });
  }

  createEffect(() => {
    chartReady();
    appearance();
    marketSession();
    const q = quoteFor(props.symbol ?? "");
    q?.last;
    q?.extChangePercent;
    props.interval;
    props.session;
    // Hidden tab: no redraw on each quote (the snapshot poll moves the
    // pre/post price every few seconds); this effect re-runs when shown.
    if (hidden()) return;
    updatePrePostLine();
  });

  /** Scales → "High and low": two price lines at the highest high / lowest
   *  low of the VISIBLE bars (not of all loaded bars), honouring the row's
   *  label/line modes + colorPair.
   *  Runs on data changes, live extreme pushes and every visible-range change,
   *  so an unchanged key is a no-op and a moved extreme only re-prices the two
   *  existing lines. */
  function updateHighLowLines() {
    if (!cx.series) return;
    const t = currentTokens();
    const enabled = (t.highLowLabels || t.highLowLines) && cx.raw.length > 0;
    if (!enabled) {
      if (highLine) { cx.series.removePriceLine(highLine); highLine = null; }
      if (lowLine) { cx.series.removePriceLine(lowLine); lowLine = null; }
      highLowKey = "";
      return;
    }
    // Visible slice of `raw` by time (bar times are ascending). Before the
    // first layout there is no visible range: fall back to every loaded bar.
    let i0 = 0;
    let i1 = cx.raw.length - 1;
    const vr = cx.chart?.timeScale().getVisibleRange();
    if (vr) {
      const from = vr.from as number;
      const to = vr.to as number;
      let lo = 0, hi = cx.raw.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if ((cx.raw[m].time as number) < from) lo = m + 1; else hi = m; }
      i0 = lo;
      lo = i0; hi = cx.raw.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if ((cx.raw[m].time as number) <= to) lo = m + 1; else hi = m; }
      i1 = lo - 1;
    }
    let hi = -Infinity;
    let lo = Infinity;
    for (let i = i0; i <= i1; i++) {
      const r = cx.raw[i];
      if (r.high > hi) hi = r.high;
      if (r.low < lo) lo = r.low;
    }
    if (!(hi > -Infinity && lo < Infinity)) return;
    const styleKey = `${t.highLowLabels}|${t.highLowLines}|${t.highLowColor}|${t.highLowWidth}|${t.up}|${t.down}`;
    const key = `${hi}|${lo}|${styleKey}`;
    if (key === highLowKey && highLine && lowLine) return;
    const sameStyle = highLine && lowLine && highLowKey.endsWith(`|${styleKey}`);
    highLowKey = key;
    if (sameStyle) {
      highLine!.applyOptions({ price: hi });
      lowLine!.applyOptions({ price: lo });
      return;
    }
    // High/low views (dark): dotted line, colour = the
    // row colour or #808080, label background = the row colour or #142E61
    // with a contrasting text colour.
    const lineStyle = LineStyle.Dotted;
    const labelBg = t.highLowColor || "#142e61";
    const mk = (price: number, title: string) =>
      cx.series!.createPriceLine({
        price,
        color: t.highLowColor || "#808080",
        title,
        lineStyle,
        lineWidth: Math.max(1, Math.min(4, t.highLowWidth)) as 1 | 2 | 3 | 4,
        lineVisible: t.highLowLines,
        axisLabelVisible: t.highLowLabels,
        axisLabelColor: labelBg,
        axisLabelTextColor: textColorOn(labelBg),
      });
    if (highLine) cx.series.removePriceLine(highLine);
    if (lowLine) cx.series.removePriceLine(lowLine);
    highLine = mk(hi, "High");
    lowLine = mk(lo, "Low");
  }

  /** Scales → "Countdown to bar close": refresh the axis label's remaining
   *  time (1s cadence — see the onMount timer). Anchored at the last close,
   *  coloured by the last bar's direction, sitting just under the last-price
   *  label. */
  function updateCountdown() {
    const t = currentTokens();
    const last = cx.raw.length > 0 ? cx.raw[cx.raw.length - 1] : null;
    // The countdown shows for time-based styles only (renko, line break,
    // kagi, P&F and range bars have no bar close to count to).
    const timeBased = !isTransformType(cx.activeType);
    const text = last && timeBased
      ? countdownText(
          props.interval ?? "1D",
          Date.now() / 1000,
          typeof last.time === "number" ? (last.time as number) : undefined,
          props.session ?? "RTH",
          cachedSymbolSessions(props.symbol ?? ""),
        )
      : null;
    const showCountdown = t.countdownVisible && text != null;
    // Value shown in the label: the series' own last value (Heikin-Ashi close
    // on an HA chart) unless "Real prices on price scale" is on.
    const haReal = cx.activeType === "ha" && t.styles.ha.realPrices;
    let labelPrice = last?.close ?? 0;
    let labelUp = last ? last.close >= last.open : true;
    if (cx.activeType === "ha" && !haReal && last) {
      const ha = heikinAshiLast(cx.raw);
      if (ha) { labelPrice = ha.close; labelUp = ha.close >= ha.open; }
    }
    // "Price and percentage value": a second row with the change from the
    // first visible bar (regular scale).
    let pctText = "";
    if (t.symbolValuePercent && timeBased && last && cx.chart) {
      const lr = cx.chart.timeScale().getVisibleLogicalRange();
      const idx = lr ? Math.max(0, Math.min(cx.raw.length - 1, Math.ceil(lr.from))) : 0;
      const base = cx.raw[idx]?.close;
      if (base) {
        const pct = ((last.close - base) / Math.abs(base)) * 100;
        pctText = `${pct < 0 ? "−" : ""}${Math.abs(pct).toFixed(2)}%`;
      }
    }
    const labelOn = t.symbolLastValue && last != null;
    const active = last != null && (showCountdown || (labelOn && (pctText !== "" || haReal)));
    countdown.setState({
      visible: active,
      price: labelPrice,
      // Row 1 of the combined label — empty when the Symbol price-label
      // setting is off (the plate then shows the countdown row alone). The
      // "Name" option prefixes the ticker, like the library label it replaces.
      priceText:
        active && labelOn && cx.series
          ? (t.symbolNameLabel ? `${splitSymbol(props.symbol ?? "").ticker} ` : "") +
            cx.series.priceFormatter().format(labelPrice)
          : "",
      pctText: active && labelOn ? pctText : "",
      text: showCountdown ? text ?? "" : "",
      backColor: labelUp ? t.up : t.down,
      textColor: "#ffffff",
      fontSize: t.scaleFontSize,
      fontFamily: readFontFamily(),
    });
    // The plate REPLACES the library's last-value label while it shows (ONE
    // label: price row + percentage row + countdown row) — toggle
    // the library label off/on as the market opens/closes. Read-compare so
    // the 1s timer doesn't spam applyOptions.
    if (cx.series) {
      const wantLabel = t.symbolLastValue && !active;
      if (cx.series.options().lastValueVisible !== wantLabel) {
        cx.series.applyOptions({ lastValueVisible: wantLabel });
      }
    }
  }

  // Countdown tick: 1s cadence, reading the live closures (interval / raw /
  // tokens) so it follows symbol/interval/settings changes without re-wiring.
  onMount(() => {
    const timer = window.setInterval(() => { if (!hidden()) updateCountdown(); }, 1000);
    onCleanup(() => window.clearInterval(timer));
  });

  /** A rebuilt series took its baseline waterline with it. */
  function forgetBaseline() {
    baselineWaterline = null;
    baselineLevelPrice = null;
  }
  /** A rebuilt series took its price lines with it: they are made again. */
  function forgetPriceLines() {
    highLine = null;
    lowLine = null;
    highLowKey = "";
    prevClosePriceLine = null;
    prevCloseKey = "";
    prePostLine = null;
    prePostKey = "";
  }

  return {
    applyLockedRatio,
    forgetBaseline,
    forgetPriceLines,
    liveScaleRatio,
    lockedSpacingFromScale,
    marketSession,
    setStatusClock,
    syncBaseline,
    syncGradientLabel,
    updateCountdown,
    updateHighLowLines,
    updatePrePostLine,
    updatePrevClosePriceLine,
  };
}
