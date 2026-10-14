/*
 * App events a chart view answers: layout sync and tab links (inbound), the
 * Go to dialog, the bottom-bar date ranges, the keyboard chart actions, data
 * reloads, script / strategy updates and study requests from the panels.
 */
import { onCleanup, onMount } from "solid-js";
import { typeIdOf } from "../indicators/study-id";
import { PriceScaleMode, type UTCTimestamp } from "lightweight-charts";
import { ZOOM_FACTOR } from "../control-bar";
import { isIntradayResolution, isSecondResolution } from "../../../data/datafeed";
import { layoutSync } from "../layout-sync";
import { utcToWall, wallTimeToUtc, type WallDate, type WallTime } from "../day-key";
import type { GotoQuery } from "../goto-query";
import { type DialogTab } from "../IndicatorSettingsDialog";
import { OAKSCRIPT_UPDATED_EVENT, userIndicatorId, type OakScriptUpdatedDetail } from "../indicators/user-scripts";
import { STRATEGY_UPDATED_EVENT, type StrategyUpdatedDetail } from "../indicators/strategy-entries";
import { type ChartCx } from "./context";

/** What createWindowEvents adds to the chart context. */
export interface WindowEventsApi {
  installChartEvents: () => void;
  installDataEvents: () => void;
}

export function createWindowEvents(cx: ChartCx): WindowEventsApi {
  const { currentTokens, paneId, props, refreshIndicatorLegend, refreshLegend, setSettingsForId, setSettingsTab, whenShown } = cx;
  function installChartEvents() {
    // ── Layout-sync bus (inbound) ──────────────────────────────────────────
    // Apply crosshair / range broadcasts from sibling panes. The suppress
    // flags stop the resulting local event from re-broadcasting (echo loop);
    // they clear on the next frame so genuine user moves still propagate.
    const onSyncCrosshair = (e: Event) => {
      const d = (e as CustomEvent<{ time: number | null; price?: number | null; sourceId: number }>).detail;
      if (!cx.chart || !cx.series || d.sourceId === paneId || !layoutSync().crosshair) return;
      cx.suppressCrosshairBroadcast = true;
      cx.crosshairAt = null;
      try {
        if (d.time == null) {
          cx.chart.clearCrosshairPosition();
        } else if (cx.raw.length === 0 || (d.time as number) < (cx.raw[0].time as number)) {
          // Hide the mirrored crosshair on a chart whose loaded history
          // doesn't reach the synced time. Without this, setCrosshairPosition
          // clamps to the FIRST loaded bar and the label stands there stale
          // (e.g. a 1D hover at 13 Feb left the 5m/1m panes labelled at their
          // oldest bars, 21 Jul / 23 Jul).
          cx.chart.clearCrosshairPosition();
        } else {
          // Vertical line aligns by time; the horizontal line uses the source
          // cursor's price (so it mirrors too). Fall back to the latest close
          // only if no price was sent (older broadcast / off-scale cursor).
          const price = d.price != null ? d.price : (cx.raw.length ? cx.raw[cx.raw.length - 1].close : 0);
          cx.chart.setCrosshairPosition(price, d.time as UTCTimestamp, cx.series);
          const y = cx.series.priceToCoordinate(price);
          cx.crosshairAt = y === null ? null : { time: d.time as number, y };
        }
      } catch {
        /* time out of range / series swapped mid-apply — ignore */
      }
      // Cleared: the legend goes back to the latest bar (clearing the
      // crosshair fires no crosshair move).
      if (cx.crosshairAt === null && cx.crosshairActive) {
        cx.crosshairActive = false;
        cx.lastLegendTime = undefined;
        refreshLegend();
        refreshIndicatorLegend();
      }
      requestAnimationFrame(() => (cx.suppressCrosshairBroadcast = false));
    };
    const onSyncRange = (e: Event) => {
      const d = (e as CustomEvent<{ from: number; to: number; sourceId: number }>).detail;
      if (!cx.chart || d.sourceId === paneId || !layoutSync().dateRange) return;
      cx.queueSyncRange(d.from, d.to);
    };
    // Tab link (tab-link-bus): a linked tab's range lands on the ACTIVE pane,
    // and this layout's own Date range sync spreads it (with its link events
    // muted).
    const onLinkRange = (e: Event) => {
      const d = (e as CustomEvent<{ from: number; to: number }>).detail;
      if (!cx.chart || !props.active) return;
      cx.queueSyncRange(d.from, d.to);
      if (layoutSync().dateRange) {
        window.dispatchEvent(new CustomEvent("chart-sync-range", { detail: { from: d.from, to: d.to, sourceId: paneId } }));
      }
    };
    // Tab link time: every pane when this layout's Time sync is on, else the
    // active pane only.
    const onLinkTime = (e: Event) => {
      const d = (e as CustomEvent<{ time: number }>).detail;
      if (!cx.chart || !cx.series || !(props.active || layoutSync().time)) return;
      if (cx.raw.length === 0 || cx.history.loading || cx.swapping) cx.pendingLinkTime = d.time;
      else void cx.goToTime(d.time);
    };
    // "Time" sync, receiving side: see goToTime.
    const onSyncTime = (e: Event) => {
      const d = (e as CustomEvent<{ time: number; sourceId: number }>).detail;
      if (!cx.chart || !cx.series || d.sourceId === paneId || !layoutSync().time || layoutSync().dateRange) return;
      void cx.goToTime(d.time);
    };
    window.addEventListener("chart-sync-crosshair", whenShown(onSyncCrosshair));
    window.addEventListener("chart-sync-range", whenShown(onSyncRange));
    window.addEventListener("chart-sync-time", whenShown(onSyncTime));
    window.addEventListener("chart-link-range", whenShown(onLinkRange));
    window.addEventListener("chart-link-time", whenShown(onLinkTime));
    onCleanup(() => {
      window.removeEventListener("chart-link-range", whenShown(onLinkRange));
      window.removeEventListener("chart-link-time", whenShown(onLinkTime));
      window.removeEventListener("chart-sync-crosshair", whenShown(onSyncCrosshair));
      window.removeEventListener("chart-sync-range", whenShown(onSyncRange));
      window.removeEventListener("chart-sync-time", whenShown(onSyncTime));
    });

    // "Go to" dialog (bottom-bar GoToDateDialog). The dialog sends wall-clock
    // dates; each pane reads them in its own time zone (the reference app converts in the
    // chart time zone). DWM targets are calendar dates.
    const isDwm = () => {
      const iv = props.interval ?? "1D";
      return !isIntradayResolution(iv) && !isSecondResolution(iv);
    };
    const wallSec = (w: WallDate, h = 0, mi = 0) => wallTimeToUtc(props.timeZone ?? "UTC", w.y, w.m, w.d, h, mi);
    // Date tab (the reference app `gotoTime`): the active chart only; history loads back to
    // the date, and the target is centred even when already in view.
    const onGoToDate = (e: Event) => {
      const d = (e as CustomEvent<{ date?: WallDate; minutes?: number }>).detail;
      if (!d?.date || !cx.chart || !props.active) return;
      const sec = isDwm()
        ? Date.UTC(d.date.y, d.date.m, d.date.d) / 1000
        : wallSec(d.date, Math.floor((d.minutes ?? 0) / 60), (d.minutes ?? 0) % 60);
      if (cx.raw.length === 0 || cx.history.loading || cx.swapping) return;
      void cx.goToTime(sec, { alignIfVisible: true, driver: true, index: cx.gotoDateIndex });
    };
    window.addEventListener("chart-goto-date", whenShown(onGoToDate));
    onCleanup(() => window.removeEventListener("chart-goto-date", whenShown(onGoToDate)));

    // Custom range tab (the reference app `setTimeFrame`): the active chart, or every chart
    // when Interval sync is on. Frames [From, To] (date + time; DWM: dates).
    const onGoToRange = (e: Event) => {
      const d = (e as CustomEvent<{ from?: WallTime; to?: WallTime }>).detail;
      if (!cx.chart || !d?.from || !d?.to || !(props.active || layoutSync().interval)) return;
      if (cx.raw.length === 0 || cx.history.loading || cx.swapping) return;
      const at = (w: WallTime) =>
        isDwm() ? Date.UTC(w.y, w.m, w.d) / 1000 : wallSec(w, Math.floor(w.minutes / 60), w.minutes % 60);
      void cx.goToRange(at(d.from), at(d.to));
    };
    // The dialog asks the active chart, when it opens, for its first and last
    // fully visible bars (the reference app `visibleBarsStrictRange`: the Custom range
    // start values) and whether it is DWM (date only, time fields disabled).
    const onGoToQuery = (e: Event) => {
      const q = (e as CustomEvent<GotoQuery>).detail;
      if (!cx.chart || !props.active || !q) return;
      q.dateOnly = isDwm();
      const lr = cx.chart.timeScale().getVisibleLogicalRange();
      if (!lr || cx.raw.length === 0) return;
      const first = Math.max(0, Math.ceil(lr.from));
      const lastBar = Math.min(cx.raw.length - 1, Math.floor(lr.to));
      if (first > lastBar) return;
      // DWM bars sit on their date (noon UTC is inside the day in any zone
      // the exchange date is read in).
      const wall = (sec: number): WallTime =>
        isDwm() ? { ...utcToWall("UTC", sec + 43200), minutes: 0 } : utcToWall(props.timeZone ?? "UTC", sec);
      q.visible = { from: wall(cx.raw[first].time as number), to: wall(cx.raw[lastBar].time as number) };
    };
    window.addEventListener("chart-goto-query", whenShown(onGoToQuery));
    onCleanup(() => window.removeEventListener("chart-goto-query", whenShown(onGoToQuery)));
    window.addEventListener("chart-goto-range", whenShown(onGoToRange));
    onCleanup(() => window.removeEventListener("chart-goto-range", whenShown(onGoToRange)));

    // Bottom-bar date-range tabs: frame the preset span (the tab also set the
    // preset interval, usually triggering a reload — the span is remembered
    // and applied by the data-apply effect once the new bars land). Only the
    // focused pane reacts, matching the interval change it rides with.
    const onSetRangeSpan = (e: Event) => {
      if (!props.active) return;
      const id = (e as CustomEvent<{ span?: string }>).detail?.span;
      if (!id) return;
      cx.pendingRangeSpan = id;
      // No reload coming (the tab's interval was already active) → apply now.
      if (!cx.swapping && !cx.history.loading) {
        if (cx.applyRangeSpan(id)) cx.pendingRangeSpan = null;
      }
    };
    window.addEventListener("chart-set-range", whenShown(onSetRangeSpan));
    onCleanup(() => window.removeEventListener("chart-set-range", whenShown(onSetRangeSpan)));

    // ── Keyboard chart actions ─────────────────────────────────────────────
    // App.tsx broadcasts these as window events; only the FOCUSED pane reacts
    // (props.active), so multi-pane layouts pan/zoom/scale the chart the user
    // is on — not all of them at once.
    //
    // Pan (←/→, Ctrl+←/→) is not here: both are HELD gestures that build speed,
    // so they run through the scroll animation above (chart-scroll-start/stop).
    //
    // Alt+I/L/P toggles read the LIVE scale options (the price-scale context
    // menu writes the same options, so a tracked local would go stale) and
    // target the placement scale, not a hardcoded "right".
    const applyScale = (mode: "invert" | "log" | "percent") => {
      if (!cx.chart) return;
      const ps = cx.chart.priceScale(currentTokens().scalesPlacement);
      const cur = ps.options();
      if (mode === "invert") {
        ps.applyOptions({ invertScale: !cur.invertScale });
        return;
      }
      const target = mode === "log" ? PriceScaleMode.Logarithmic : PriceScaleMode.Percentage;
      ps.applyOptions({ mode: cur.mode === target ? PriceScaleMode.Normal : target });
    };

    // Ctrl+↑/↓ is the same action as the control bar's zoom buttons, so
    // both go through zoomSpan (animated, the measured step).
    const onZoom = (e: Event) => {
      if (!props.active) return;
      cx.zoomSpan((e as CustomEvent<{ dir: "in" | "out" }>).detail.dir === "in" ? 1 / ZOOM_FACTOR : ZOOM_FACTOR);
    };
    const onGotoRealtime = () => { if (props.active) cx.scrollToRealtime(); };
    const onGotoFirst = () => { if (props.active) cx.scrollToFirstBar(); };
    // Held ←/→ ("bar") and Ctrl+←/→ ("smooth"). One stop for both, as a
    // single stop move. Start is pane-gated; stop is not — a pane that started a
    // run must still be able to end it if focus moved in between.
    const onScrollStart = (e: Event) => {
      if (!props.active) return;
      const d = (e as CustomEvent<{ dir: -1 | 1; mode: "bar" | "smooth" }>).detail;
      if (d.mode === "smooth") cx.startPan(d.dir);
      else cx.moveBars(d.dir);
    };
    const onScrollStop = () => cx.stopScroll();
    const onScale = (e: Event) => {
      if (!props.active) return;
      applyScale((e as CustomEvent<{ mode: "invert" | "log" | "percent" }>).detail.mode);
    };
    const onSnapshot = (e: Event) => {
      if (!props.active) return;
      void cx.takeSnapshot((e as CustomEvent<{ action?: "copy" | "download" | "open" }>).detail?.action ?? "copy");
    };
    const onReset = () => { if (props.active) cx.resetChartView(); };
    const onResetTime = () => {
      if (!props.active) return;
      cx.resetTimeScale();
      cx.refreshBarsRef?.();
    };
    window.addEventListener("chart-zoom", whenShown(onZoom));
    window.addEventListener("chart-scale", whenShown(onScale));
    window.addEventListener("chart-snapshot", whenShown(onSnapshot));
    window.addEventListener("chart-reset", whenShown(onReset));
    window.addEventListener("chart-reset-time", whenShown(onResetTime));
    window.addEventListener("chart-goto-realtime", whenShown(onGotoRealtime));
    window.addEventListener("chart-goto-first", whenShown(onGotoFirst));
    window.addEventListener("chart-scroll-start", whenShown(onScrollStart));
    window.addEventListener("chart-scroll-stop", whenShown(onScrollStop));
    onCleanup(() => {
      window.removeEventListener("chart-zoom", whenShown(onZoom));
      window.removeEventListener("chart-scale", whenShown(onScale));
      window.removeEventListener("chart-snapshot", whenShown(onSnapshot));
      window.removeEventListener("chart-reset", whenShown(onReset));
      window.removeEventListener("chart-reset-time", whenShown(onResetTime));
      window.removeEventListener("chart-goto-realtime", whenShown(onGotoRealtime));
      window.removeEventListener("chart-goto-first", whenShown(onGotoFirst));
      window.removeEventListener("chart-scroll-start", whenShown(onScrollStart));
      window.removeEventListener("chart-scroll-stop", whenShown(onScrollStop));
    });
  }

  function installDataEvents() {
  onMount(() => {
    const onReload = () => {
      // The reload flips the fetch basis (e.g. the ADJ toggle): invalidate the
      // scroll-back generation + drop the read-ahead buffer so a page fetched
      // under the previous basis can never prepend into the reloaded series
      // (bars of two bases in one series).
      cx.fetchGen++;
      cx.prefetch = null;
      cx.setReloadTick((n) => n + 1);
    };
    window.addEventListener("chart-reload-data", onReload);
    onCleanup(() => window.removeEventListener("chart-reload-data", onReload));
  });

  // OakScript indicators: the editor recompiled a script, or its async worker
  // run produced a fresh result — redraw the affected study. Structural means
  // the overlay flag flipped, so the study's pane assignment must be rebuilt.
  onMount(() => {
    const onOakScriptUpdated = (e: Event) => {
      const detail = (e as CustomEvent<OakScriptUpdatedDetail>).detail;
      if (!detail) return;
      const uid = userIndicatorId(detail.scriptId);
      // Every instance of the script on this chart (a re-added one is "#2"…).
      const ids = (props.indicators ?? []).filter((id) => typeIdOf(id) === uid);
      if (!ids.length) return;
      if (detail.structural) for (const id of ids) cx.controller?.refresh(id);
      else cx.controller?.renderAll();
      refreshIndicatorLegend();
    };
    window.addEventListener(OAKSCRIPT_UPDATED_EVENT, onOakScriptUpdated);
    onCleanup(() => window.removeEventListener(OAKSCRIPT_UPDATED_EVENT, onOakScriptUpdated));
  });
  // Strategy Tester requests for the active chart: open a study's Settings
  // dialog, or merge input values into a study (strategy properties).
  onMount(() => {
    const onOpenSettings = (e: Event) => {
      const d = (e as CustomEvent<{ id: string; tab?: DialogTab }>).detail;
      const id = d?.id;
      if (!props.active || props.shown === false || !id || !(props.indicators ?? []).includes(id)) return;
      setSettingsTab(d.tab);
      setSettingsForId(id);
    };
    const onPatchInputs = (e: Event) => {
      const d = (e as CustomEvent<{ id: string; patch: Record<string, unknown> }>).detail;
      if (!props.active || props.shown === false || !d || !cx.controller || !(props.indicators ?? []).includes(d.id)) return;
      const inputs = { ...(cx.controller.getInputs(d.id) ?? {}), ...d.patch };
      const styles = cx.controller.getStyles(d.id) ?? {};
      const options = cx.controller.getOptions(d.id);
      cx.controller.applySettings(d.id, inputs, styles, options);
      props.onIndicatorSettings?.(d.id, { inputs, styles, options });
    };
    window.addEventListener("chart-open-study-settings", onOpenSettings);
    window.addEventListener("chart-patch-study-inputs", onPatchInputs);
    onCleanup(() => {
      window.removeEventListener("chart-open-study-settings", onOpenSettings);
      window.removeEventListener("chart-patch-study-inputs", onPatchInputs);
    });
  });
  // Strategies: a backtest of this chart finished — redraw its trade marks.
  onMount(() => {
    const onStrategyUpdated = (e: Event) => {
      const detail = (e as CustomEvent<StrategyUpdatedDetail>).detail;
      if (!detail || detail.chartId !== String(paneId)) return;
      cx.controller?.renderAll();
      refreshIndicatorLegend();
      cx.applyStrategyMarkers();
    };
    window.addEventListener(STRATEGY_UPDATED_EVENT, onStrategyUpdated);
    onCleanup(() => window.removeEventListener(STRATEGY_UPDATED_EVENT, onStrategyUpdated));
  });
  }

  return {
    installChartEvents,
    installDataEvents,
  };
}
