/*
 * Legends of a chart view: the series status line (values of the hovered or
 * latest bar, data window), the studies legend of each pane and their layout
 * next to the price scale.
 */
/*
 * ChartView — single chart pane backed by lightweight-charts (v5).
 *
 * Chart and series are imperative state held in plain `let` bindings.
 * Theme + chart-type changes both flow in via Solid effects that swap the
 * active series via createSeriesForType / setDataForType.
 *
 * Drawings: every kind lives in the <DrawingsOverlay> SVG layer fed a
 * Coords bridge (refreshed on every series rebuild) and a `coordEpoch`
 * counter that bumps on pan/zoom. Horizontal-line was the last holdout
 * (native priceLine through Feature 5a); Feature 5c moved it to the
 * overlay for parity with the other 13 kinds.
 */
import { For, Show } from "solid-js";
import { reconcile } from "solid-js/store";
import { flagOf, lastFlagColor, setFlag } from "../../../data/symbol-flags";
import { FlagColorPopup } from "../FlagColorPopup";
import { ChartSyncMenu, SYNC_GROUPS } from "../ChartSyncMenu";
import { FLAG_HEX } from "../../../data/watchlist";
import { type PriceSource } from "../../header/chart-settings";
import { intervalLabel, isEconomicSymbol, splitSymbol } from "../../../data/datafeed";
import { flagUrl } from "../../../data/country-flags";
import { CHART_TYPE_ICON } from "../chart-types";
import { ChartLegend } from "../ChartLegend";
import { IndicatorLegend } from "../IndicatorLegend";
import { OAKSCRIPT_OPEN_EVENT } from "../indicators/user-scripts";
import { editorScriptOfStudy, isOpenedInEditor } from "../../oakscript/editor-state";
import { publishDataWindow, type DataWindowState } from "../../../data/data-window-store";
import { type ChartCx } from "./context";
import { indexOfTime, buildLegend } from "./helpers";
import { emitAppEvent } from "../../../data/app-events";
import type { JSX } from "solid-js";

/** What createLegend adds to the chart context. */
export interface LegendApi {
  LegendStacks: () => JSX.Element;
  mainPriceSource: () => PriceSource;
  refreshIndicatorLegend: (time?: number) => void;
  refreshLegend: (time?: number) => void;
}

export function createLegend(cx: ChartCx): LegendApi {
  const { appearance, currentTokens, flagPopup, indLegend, legend, props, removeStudy, selectStudy, selectedStudy, setFlagPopup, setIndLegendStore, setLegend, setSettingsForId, setSettingsTab, setSyncMenu, syncMenu, toggleSourceHidden } = cx;
  function refreshIndicatorLegend(time?: number) {
    setIndLegendStore("rows", reconcile([...(cx.controller?.getLegend(time) ?? []), ...cx.compareLegendRows(time)], { key: "id" }));
  }

  /** Top of the legend stack inside its pane (`.ot-legend-stack` top). */
  const LEGEND_TOP = 4;
  /** The legends end 8 px before the right price scale (the plot width): a
   *  title too long for it is cut with an ellipsis, so the legend buttons stay
   *  in view on a narrow chart. */
  const legendMaxWidth = () => {
    const g = cx.scaleGeom();
    const right = g && !g.left ? g.w : 0;
    return `calc(100% - ${8 + cx.legendLeft() + right + 8}px)`;
  };
  /** Studies legend of one pane (the price pane's under the series row). */
  const studyLegend = (pane: () => number) => (
    <IndicatorLegend
      rows={indLegend().filter((r) => r.pane === pane())}
      formatPrice={cx.legendPriceFormat()}
      showTitles={appearance().legendIndTitles}
      showInputs={appearance().legendIndInputs}
      showValues={appearance().legendIndValues}
      bgColor={appearance().bg}
      bgOpacity={appearance().legendIndBgOpacity}
      onToggleHide={toggleSourceHidden}
      onSettings={(id) => {
        selectStudy(id);
        if (cx.compareEntry(id)) cx.setCompareSettingsFor(id);
        else setSettingsForId(id);
      }}
      onRemove={removeStudy}
      selectedId={selectedStudy()}
      onSelect={selectStudy}
      onMore={(id, r) => (cx.compareEntry(id) ? cx.openCompareMoreMenu(id, r) : cx.openIndicatorMoreMenu(id, r))}
      hasSource={(id) => editorScriptOfStudy(id) !== null}
      onSource={(id) => {
        const scriptId = editorScriptOfStudy(id);
        if (scriptId) emitAppEvent(OAKSCRIPT_OPEN_EVENT, { scriptId });
      }}
      openedInEditor={isOpenedInEditor}
      onIntervalSettings={(id) => {
        selectStudy(id);
        setSettingsTab("visibility");
        setSettingsForId(id);
      }}
      onTitleClick={(id) => { if (cx.compareEntry(id)) props.onChangeCompareSymbol?.(id); }}
    />
  );

  /** Re-resolve the legend for a crosshair time (or the latest bar when
   *  omitted). Reads the live `raw` + `activeType` closures. */
  /** Price source of a single-value main series (Symbol tab "Price source"). */
  function mainPriceSource(): PriceSource {
    const st = currentTokens().styles;
    return cx.activeType === "line" || cx.activeType === "lineWithMarkers" || cx.activeType === "stepline" ? st[cx.activeType].source
      : cx.activeType === "area" ? st.area.source
      : cx.activeType === "baseline" ? st.baseline.source
      : cx.activeType === "column" ? st.column.source
      : "close";
  }

  function refreshLegend(time?: number) {
    if (cx.raw.length === 0) {
      setLegend(null);
      if (props.active) publishDataWindow(null);
      return;
    }
    let idx = cx.raw.length - 1;
    if (time != null) {
      const hit = indexOfTime(cx.raw, time);
      if (hit >= 0) idx = hit;
    }
    setLegend(buildLegend(cx.raw, idx, cx.activeType, cx.prevDayClose[idx] ?? null, mainPriceSource()));
    publishDataWindowIfOwner(idx, time);
  }

  /** Publish this pane's data-window snapshot for the bar at `idx`, but only
   *  when this pane owns the data window: the crosshair is over it, or it's the
   *  focused pane (so a sibling pane's live tick can't steal it). Indicator
   *  values resolve at the same `time` the legend used. */
  function publishDataWindowIfOwner(idx: number, time?: number) {
    if (!(props.active || cx.crosshairActive)) return;
    const bar = cx.raw[idx];
    const prevClose = idx > 0 ? cx.raw[idx - 1].close : null;
    const changeAbs = prevClose == null ? 0 : bar.close - prevClose;
    const changePct = prevClose ? (changeAbs / prevClose) * 100 : 0;
    const { ticker, exchange } = splitSymbol(props.symbol ?? "");
    const iv = props.interval ?? "";
    const indicators: DataWindowState["indicators"] = (cx.controller?.getLegend(time) ?? []).map((r) => ({
      id: r.id,
      title: r.title,
      plots: r.plots,
    }));
    publishDataWindow({
      ticker,
      exchange,
      interval: iv,
      chartTypeIcon: CHART_TYPE_ICON[cx.activeType],
      time: bar.time as number,
      // Seconds/minutes/hours show a time-of-day row; D/W/M don't.
      intraday: !/^\d+[DWM]$/i.test(iv),
      timeZone: props.timeZone,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      changeAbs,
      changePct,
      dir: bar.close >= bar.open ? "up" : "down",
      volume: bar.volume ?? null,
      indicators,
    });
  }

  /** Top of the price pane (the series legend sits at its top-left). */
  const mainTop = () => {
    void cx.mainPaneEpoch();
    const m = cx.mainPane();
    return cx.paneBoxes().find((b) => b.index === m)?.top ?? 0;
  };
  function LegendStacks() {
    return (
      <>
        <div class="ot-legend-stack" style={{ top: `${mainTop() + LEGEND_TOP}px`, left: `${8 + cx.legendLeft()}px`, "max-width": legendMaxWidth() }}>
          <ChartLegend
            ticker={splitSymbol(props.symbol ?? "").ticker}
            interval={intervalLabel(props.interval ?? "1D")}
            exchange={isEconomicSymbol(props.symbol) ? cx.legendSource() : splitSymbol(props.symbol ?? "").exchange}
            logoUrl={isEconomicSymbol(props.symbol) ? flagUrl("US") : undefined}
            values={legend()}
            formatPrice={cx.legendPriceFormat()}
            titleMode={appearance().legendTitleMode}
            description={cx.legendDesc()}
            showLogo={appearance().legendLogo}
            showTitle={appearance().legendTitle}
            showChartValues={appearance().legendChartValues}
            showBarChange={appearance().legendBarChange}
            showVolume={appearance().legendVolume}
            showLastDayChange={appearance().legendLastDayChange}
            marketStatus={isEconomicSymbol(props.symbol) ? undefined : cx.marketSession()}
            showOpenStatus={appearance().legendMarketStatus ?? true}
            replayStatus={cx.replayStatus()}
            statusSymbol={isEconomicSymbol(props.symbol) ? undefined : props.symbol}
            hideChangeValues={(props.chartType ?? "candle") === "hilo" || (props.chartType ?? "candle") === "svp"}
            seriesHidden={!!props.seriesHidden}
            onToggleSeries={props.onToggleSeries}
            flagColor={(() => { const f = props.symbol ? flagOf(props.symbol) : null; return f ? FLAG_HEX[f] : null; })()}
            onFlag={(btn) => {
              // Reference marker click: an unflagged symbol is flagged in the
              // last used colour and the colour popup opens; a flagged one is
              // unflagged.
              const sym = props.symbol;
              if (!sym) return;
              if (flagOf(sym)) { setFlag(sym, null); setFlagPopup(null); return; }
              setFlag(sym, lastFlagColor());
              setFlagPopup(btn);
            }}
            onChangeSymbol={props.onChangeSymbol}
            onChangeInterval={props.onChangeInterval}
            onMore={cx.openSeriesMoreMenu}
            linkVisible={!!props.linkSyncVisible}
            linkIcon={props.linkGroup != null ? SYNC_GROUPS[props.linkGroup]?.icon ?? null : null}
            onLink={(r) => setSyncMenu(syncMenu() ? null : r)}
          />
          <Show when={syncMenu()}>
            {(r) => (
              <ChartSyncMenu anchor={r()} group={props.linkGroup} onPick={(g) => props.onLinkGroup?.(g)} onClose={() => setSyncMenu(null)} />
            )}
          </Show>
          <Show when={flagPopup()}>
            {(btn) => (
              <FlagColorPopup
                anchor={btn()}
                value={props.symbol ? flagOf(props.symbol) : null}
                onPick={(c) => { if (props.symbol) setFlag(props.symbol, c); }}
                onClose={() => setFlagPopup(null)}
              />
            )}
          </Show>
          {studyLegend(() => (void cx.mainPaneEpoch(), cx.mainPane()))}
        </div>
        {/* Study panes: each pane's legend at its own top-left, same offset
            as the main legend. */}
        <For each={cx.paneBoxes().filter((b) => (void cx.mainPaneEpoch(), b.index !== cx.mainPane()))}>
          {(b) => (
            <Show when={indLegend().some((r) => r.pane === b.index)}>
              <div class="ot-legend-stack" style={{ top: `${b.top + LEGEND_TOP}px`, left: `${8 + cx.legendLeft()}px`, "max-width": legendMaxWidth() }}>
                {studyLegend(() => b.index)}
              </div>
            </Show>
          )}
        </For>
      </>
    );
  }

  return {
    LegendStacks,
    mainPriceSource,
    refreshIndicatorLegend,
    refreshLegend,
  };
}
