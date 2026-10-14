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
import { OAKSCRIPT_UPDATED_EVENT, userIndicatorId, type OakScriptUpdatedDetail } from "../indicators/user-scripts";
import { STRATEGY_UPDATED_EVENT, type StrategyUpdatedDetail } from "../indicators/strategy-entries";
import { emitAppEvent, onAppEvent, type AppEventName, type AppEvents } from "../../../data/app-events";
import { type ChartCx } from "./context";

/** What createWindowEvents adds to the chart context. */
export interface WindowEventsApi {
  installChartEvents: () => void;
  installDataEvents: () => void;
}

export function createWindowEvents(cx: ChartCx): WindowEventsApi {
  const { currentTokens, paneId, props, refreshIndicatorLegend, refreshLegend, setSettingsForId, setSettingsTab } = cx;
  /** The window-wide chart events belong to the shown tab: a hidden tab's
   *  chart ignores them. Removed with the chart. */
  const listenWhenShown = <K extends AppEventName>(type: K, fn: (detail: AppEvents[K]) => void) =>
    onCleanup(onAppEvent(type, (d) => { if (props.shown !== false) fn(d); }));

  function installChartEvents() {
    // ── Layout-sync bus (inbound) ──────────────────────────────────────────
    // Apply crosshair / range broadcasts from sibling panes. The suppress
    // flags stop the resulting local event from re-broadcasting (echo loop);
    // they clear on the next frame so genuine user moves still propagate.
    const onSyncCrosshair = (d: AppEvents["chart-sync-crosshair"]) => {
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
    const onSyncRange = (d: AppEvents["chart-sync-range"]) => {
      if (!cx.chart || d.sourceId === paneId || !layoutSync().dateRange) return;
      cx.queueSyncRange(d.from, d.to);
    };
    // Tab link (tab-link-bus): a linked tab's range lands on the ACTIVE pane,
    // and this layout's own Date range sync spreads it (with its link events
    // muted).
    const onLinkRange = (d: AppEvents["chart-link-range"]) => {
      if (!cx.chart || !props.active) return;
      cx.queueSyncRange(d.from, d.to);
      if (layoutSync().dateRange) {
        emitAppEvent("chart-sync-range", { from: d.from, to: d.to, sourceId: paneId });
      }
    };
    // Tab link time: every pane when this layout's Time sync is on, else the
    // active pane only.
    const onLinkTime = (d: AppEvents["chart-link-time"]) => {
      if (!cx.chart || !cx.series || !(props.active || layoutSync().time)) return;
      if (cx.raw.length === 0 || cx.history.loading || cx.swapping) cx.pendingLinkTime = d.time;
      else void cx.goToTime(d.time);
    };
    // "Time" sync, receiving side: see goToTime.
    const onSyncTime = (d: AppEvents["chart-sync-time"]) => {
      if (!cx.chart || !cx.series || d.sourceId === paneId || !layoutSync().time || layoutSync().dateRange) return;
      void cx.goToTime(d.time);
    };
    listenWhenShown("chart-sync-crosshair", onSyncCrosshair);
    listenWhenShown("chart-sync-range", onSyncRange);
    listenWhenShown("chart-sync-time", onSyncTime);
    listenWhenShown("chart-link-range", onLinkRange);
    listenWhenShown("chart-link-time", onLinkTime);

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
    const onGoToDate = (d: Partial<AppEvents["chart-goto-date"]> | undefined) => {
      if (!d?.date || !cx.chart || !props.active) return;
      const sec = isDwm()
        ? Date.UTC(d.date.y, d.date.m, d.date.d) / 1000
        : wallSec(d.date, Math.floor((d.minutes ?? 0) / 60), (d.minutes ?? 0) % 60);
      if (cx.raw.length === 0 || cx.history.loading || cx.swapping) return;
      void cx.goToTime(sec, { alignIfVisible: true, driver: true, index: cx.gotoDateIndex });
    };
    listenWhenShown("chart-goto-date", onGoToDate);

    // Custom range tab (the reference app `setTimeFrame`): the active chart, or every chart
    // when Interval sync is on. Frames [From, To] (date + time; DWM: dates).
    const onGoToRange = (d: Partial<AppEvents["chart-goto-range"]> | undefined) => {
      if (!cx.chart || !d?.from || !d?.to || !(props.active || layoutSync().interval)) return;
      if (cx.raw.length === 0 || cx.history.loading || cx.swapping) return;
      const at = (w: WallTime) =>
        isDwm() ? Date.UTC(w.y, w.m, w.d) / 1000 : wallSec(w, Math.floor(w.minutes / 60), w.minutes % 60);
      void cx.goToRange(at(d.from), at(d.to));
    };
    // The dialog asks the active chart, when it opens, for its first and last
    // fully visible bars (the reference app `visibleBarsStrictRange`: the Custom range
    // start values) and whether it is DWM (date only, time fields disabled).
    const onGoToQuery = (q: GotoQuery | undefined) => {
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
    listenWhenShown("chart-goto-query", onGoToQuery);
    listenWhenShown("chart-goto-range", onGoToRange);

    // Bottom-bar date-range tabs: frame the preset span (the tab also set the
    // preset interval, usually triggering a reload — the span is remembered
    // and applied by the data-apply effect once the new bars land). Only the
    // focused pane reacts, matching the interval change it rides with.
    const onSetRangeSpan = (d: Partial<AppEvents["chart-set-range"]> | undefined) => {
      if (!props.active) return;
      const id = d?.span;
      if (!id) return;
      cx.pendingRangeSpan = id;
      // No reload coming (the tab's interval was already active) → apply now.
      if (!cx.swapping && !cx.history.loading) {
        if (cx.applyRangeSpan(id)) cx.pendingRangeSpan = null;
      }
    };
    listenWhenShown("chart-set-range", onSetRangeSpan);

    // ── Keyboard chart actions ─────────────────────────────────────────────
    // App.tsx broadcasts these as app events; only the FOCUSED pane reacts
    // (props.active), so multi-pane layouts pan/zoom/scale the chart the user
    // is on — not all of them at once.
    //
    // Pan (←/→, Ctrl+←/→) is not here: both are HELD gestures that build speed,
    // so they run through the scroll animation (chart-scroll-start/stop).
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
    const onZoom = (d: AppEvents["chart-zoom"]) => {
      if (!props.active) return;
      cx.zoomSpan(d.dir === "in" ? 1 / ZOOM_FACTOR : ZOOM_FACTOR);
    };
    const onGotoRealtime = () => { if (props.active) cx.scrollToRealtime(); };
    const onGotoFirst = () => { if (props.active) cx.scrollToFirstBar(); };
    // Held ←/→ ("bar") and Ctrl+←/→ ("smooth"). One stop for both, as a
    // single stop move. Start is pane-gated; stop is not — a pane that started a
    // run must still be able to end it if focus moved in between.
    const onScrollStart = (d: AppEvents["chart-scroll-start"]) => {
      if (!props.active) return;
      if (d.mode === "smooth") cx.startPan(d.dir);
      else cx.moveBars(d.dir);
    };
    const onScrollStop = () => cx.stopScroll();
    const onScale = (d: AppEvents["chart-scale"]) => {
      if (!props.active) return;
      applyScale(d.mode);
    };
    const onSnapshot = (d: AppEvents["chart-snapshot"] | undefined) => {
      if (!props.active) return;
      void cx.takeSnapshot(d?.action ?? "copy");
    };
    const onReset = () => { if (props.active) cx.resetChartView(); };
    const onResetTime = () => {
      if (!props.active) return;
      cx.resetTimeScale();
      cx.refreshBarsRef?.();
    };
    listenWhenShown("chart-zoom", onZoom);
    listenWhenShown("chart-scale", onScale);
    listenWhenShown("chart-snapshot", onSnapshot);
    listenWhenShown("chart-reset", onReset);
    listenWhenShown("chart-reset-time", onResetTime);
    listenWhenShown("chart-goto-realtime", onGotoRealtime);
    listenWhenShown("chart-goto-first", onGotoFirst);
    listenWhenShown("chart-scroll-start", onScrollStart);
    listenWhenShown("chart-scroll-stop", onScrollStop);
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
      onCleanup(onAppEvent("chart-reload-data", onReload));
    });

    // OakScript indicators: the editor recompiled a script, or its async worker
    // run produced a fresh result — redraw the affected study. Structural means
    // the overlay flag flipped, so the study's pane assignment must be rebuilt.
    onMount(() => {
      const onOakScriptUpdated = (detail: OakScriptUpdatedDetail | undefined) => {
        if (!detail) return;
        const uid = userIndicatorId(detail.scriptId);
        // Every instance of the script on this chart (a re-added one is "#2"…).
        const ids = (props.indicators ?? []).filter((id) => typeIdOf(id) === uid);
        if (!ids.length) return;
        if (detail.structural) for (const id of ids) cx.controller?.refresh(id);
        else cx.controller?.renderAll();
        refreshIndicatorLegend();
      };
      onCleanup(onAppEvent(OAKSCRIPT_UPDATED_EVENT, onOakScriptUpdated));
    });
    // Strategy Tester requests for the active chart: open a study's Settings
    // dialog, or merge input values into a study (strategy properties).
    onMount(() => {
      const onOpenSettings = (d: AppEvents["chart-open-study-settings"] | undefined) => {
        const id = d?.id;
        if (!props.active || props.shown === false || !id || !(props.indicators ?? []).includes(id)) return;
        setSettingsTab(d.tab);
        setSettingsForId(id);
      };
      const onPatchInputs = (d: AppEvents["chart-patch-study-inputs"] | undefined) => {
        if (!props.active || props.shown === false || !d || !cx.controller || !(props.indicators ?? []).includes(d.id)) return;
        const inputs = { ...(cx.controller.getInputs(d.id) ?? {}), ...d.patch };
        const styles = cx.controller.getStyles(d.id) ?? {};
        const options = cx.controller.getOptions(d.id);
        cx.controller.applySettings(d.id, inputs, styles, options);
        props.onIndicatorSettings?.(d.id, { inputs, styles, options });
      };
      onCleanup(onAppEvent("chart-open-study-settings", onOpenSettings));
      onCleanup(onAppEvent("chart-patch-study-inputs", onPatchInputs));
    });
    // Strategies: a backtest of this chart finished — redraw its trade marks.
    onMount(() => {
      const onStrategyUpdated = (detail: StrategyUpdatedDetail | undefined) => {
        if (!detail || detail.chartId !== String(paneId)) return;
        cx.controller?.renderAll();
        refreshIndicatorLegend();
        cx.applyStrategyMarkers();
      };
      onCleanup(onAppEvent(STRATEGY_UPDATED_EVENT, onStrategyUpdated));
    });
  }

  return {
    installChartEvents,
    installDataEvents,
  };
}
