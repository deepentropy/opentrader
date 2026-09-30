/*
 * Strategy Tester — TradingView Desktop 3.4.1 footer report panel
 * (research/backtester/design/doc/STRATEGY-TESTER-DESIGN-3.4.1.md).
 *
 * Shown under the chart only while the active chart holds a strategy: a 38 px
 * footer bar with one tab per strategy (icon + short title + caret menu) and
 * Collapse / Maximize buttons, then the report (toolbar + Metrics or Trades
 * view). Clicking the active tab closes (collapses) the report.
 *
 * The report is the one computed for the active chart (strategy-tester-store,
 * written by the strategy registry entries when the backtest worker answers).
 */
import { Show, For, createEffect, createMemo, createSignal } from "solid-js";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { Popover, PopItem, PopDivider } from "../screener/Popover";
import { strategyTester } from "../../data/strategy-tester-store";
import { getStrategyEntry, strategyKeyOf } from "../chart/indicators/strategy-entries";
import { STRATEGIES } from "../../backtester/strategies";
import { ReportToolbar } from "./ReportToolbar";
import { KeyStatsInline, MetricsView } from "./MetricsView";
import { TradesView } from "./TradesView";

/** Report content height when the panel opens (MEASURED: 275 px under the 38 px bar). */
const DEFAULT_HEIGHT = 275;
const MIN_HEIGHT = 120;
const CHART_MIN = 150;
const FOOTER = 38;

type Props = {
  /** Strategy study ids (`strategy:<key>`) on the active chart, in legend order. */
  strategyIds: string[];
  /** Interval of the active chart (intraday dates show the time). */
  intraday: boolean;
  /** Interval of the active chart in seconds (equity chart Whitespaces). */
  intervalSec: number;
  /** Active chart interval ("5", "1D"...) and symbol (EXCHANGE:TICKER): CSV export. */
  interval: string;
  symbol: string;
  /** Open the strategy settings; `tab` forces a tab (report toolbar gear = Properties). */
  onSettings: (id: string, tab?: "properties") => void;
  onAddStrategy: () => void;
  /** Merge strategy property overrides (e.g. initial capital) into the study. */
  onPatchProperties: (id: string, patch: Record<string, unknown>) => void;
  /** Current property overrides of a study. */
  properties: (id: string) => Record<string, unknown>;
  /** Jump the chart to a bar time (UNIX seconds). */
  onShowOnChart: (timeSec: number) => void;
};

export function StrategyTesterPanel(props: Props) {
  let rootRef: HTMLElement | undefined;
  const [selected, setSelected] = createSignal<string | null>(null);
  const [menuFor, setMenuFor] = createSignal<{ id: string; anchor: HTMLElement } | null>(null);

  // Keep a valid selection: the last strategy added when the current one left.
  createEffect(() => {
    const ids = props.strategyIds;
    const cur = selected();
    if (!cur || !ids.includes(cur)) setSelected(ids[ids.length - 1] ?? null);
  });

  const title = (id: string) => {
    const def = STRATEGIES.find((s) => s.key === strategyKeyOf(id));
    return def?.shortTitle ?? getStrategyEntry(id)?.name ?? id;
  };
  const run = createMemo(() => {
    const id = selected();
    return id ? strategyTester.run(strategyTester.activeChartId(), strategyKeyOf(id)) : undefined;
  });

  const contentHeight = () => strategyTester.height() || DEFAULT_HEIGHT;
  const maxContent = () => Math.max(MIN_HEIGHT, (rootRef?.parentElement?.clientHeight ?? 0) - CHART_MIN - FOOTER);

  function beginResize(e: MouseEvent) {
    if (strategyTester.collapsed() || strategyTester.maximized()) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = contentHeight();
    const maxH = maxContent();
    const next = (ev: MouseEvent) => Math.min(maxH, Math.max(MIN_HEIGHT, startH + (startY - ev.clientY)));
    const onMove = (ev: MouseEvent) => strategyTester.setHeight(next(ev), false);
    const onUp = (ev: MouseEvent) => {
      strategyTester.setHeight(next(ev), true);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "ns-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  const style = () => {
    if (strategyTester.maximized()) return { height: "100%" };
    if (strategyTester.collapsed()) return { height: `${FOOTER}px` };
    return { height: `${FOOTER + contentHeight()}px` };
  };

  const onTabClick = (id: string) => {
    if (id === selected() && !strategyTester.collapsed()) {
      strategyTester.setCollapsed(true);
      strategyTester.setMaximized(false);
      return;
    }
    setSelected(id);
    strategyTester.setCollapsed(false);
  };

  return (
    <Show when={props.strategyIds.length > 0}>
      <section
        ref={rootRef}
        class="st-panel"
        classList={{ "is-collapsed": strategyTester.collapsed(), "is-maximized": strategyTester.maximized() }}
        style={style()}
        data-name="strategy-tester"
        aria-label="Strategy report"
      >
        <Show when={!strategyTester.collapsed() && !strategyTester.maximized()}>
          <div class="st-resize-handle" onMouseDown={beginResize} />
        </Show>

        {/* Footer bar: strategy tabs | Collapse / Maximize */}
        <div class="st-footer" id="footer-chart-panel">
          <div class="st-tabbar">
            <div class="st-tabs" role="tablist">
              <For each={props.strategyIds}>
                {(id) => {
                  const active = () => id === selected() && !strategyTester.collapsed();
                  let caretRef: HTMLButtonElement | undefined;
                  return (
                    <div class="st-tab" classList={{ "is-active": active() }} role="tab" aria-selected={active()}>
                      <Tooltip text="Close strategy report" side="top">
                        <button type="button" class="st-tab-btn" onClick={() => onTabClick(id)}>
                          <span class="st-tab-icon"><Icon name="st-footer-tab-strategy-icon" size={24} /></span>
                          <span class="st-tab-title">{title(id)}</span>
                        </button>
                      </Tooltip>
                      <Tooltip text="Open context menu" side="top">
                        <button
                          type="button"
                          ref={caretRef}
                          class="st-tab-caret"
                          classList={{ "is-open": menuFor()?.id === id }}
                          aria-label="Open context menu"
                          onClick={() => setMenuFor(menuFor()?.id === id ? null : { id, anchor: caretRef! })}
                        >
                          <Icon name="st-footer-tab-caret" />
                        </button>
                      </Tooltip>
                    </div>
                  );
                }}
              </For>
            </div>
          </div>
          <div class="st-footer-buttons">
            <Tooltip text={strategyTester.collapsed() ? "Open panel" : "Collapse panel"} side="top">
              <button
                type="button"
                class="st-footer-btn"
                aria-label={strategyTester.collapsed() ? "Open panel" : "Collapse panel"}
                onClick={() => {
                  const c = !strategyTester.collapsed();
                  strategyTester.setCollapsed(c);
                  if (c) strategyTester.setMaximized(false);
                }}
              >
                <Icon name={strategyTester.collapsed() ? "st-footer-collapsed-visibility" : "st-footer-normal-visibility"} size={28} />
              </button>
            </Tooltip>
            <Tooltip text={strategyTester.maximized() ? "Restore panel" : "Maximize panel"} side="top">
              <button
                type="button"
                class="st-footer-btn"
                aria-label={strategyTester.maximized() ? "Restore panel" : "Maximize panel"}
                onClick={() => {
                  const m = !strategyTester.maximized();
                  strategyTester.setMaximized(m);
                  if (m) strategyTester.setCollapsed(false);
                }}
              >
                <Icon name={strategyTester.maximized() ? "st-footer-maximized-maximize" : "st-footer-normal-maximize"} size={28} />
              </button>
            </Tooltip>
          </div>
        </div>

        <Show when={!strategyTester.collapsed()}>
          <div class="st-report">
            <Show when={selected()}>
              {(id) => (
                <>
                  <Show
                    when={strategyTester.equityExpanded() && strategyTester.view() === "metrics" && run()?.report}
                    fallback={
                      <ReportToolbar
                        report={run()?.report ?? null}
                        properties={props.properties(id())}
                        onPatchProperties={(patch) => props.onPatchProperties(id(), patch)}
                        onSettings={() => props.onSettings(id(), "properties")}
                      />
                    }
                  >
                    {(report) => <KeyStatsInline report={report()} />}
                  </Show>
                  <div class="st-report-body">
                    <Show
                      when={run()?.report}
                      fallback={
                        <Show when={run()?.status === "error"}>
                          <div class="st-report-message">{run()?.error?.message}</div>
                        </Show>
                      }
                    >
                      {(report) => (
                        <Show
                          when={strategyTester.view() === "metrics"}
                          fallback={
                            <TradesView
                              report={report()}
                              intraday={props.intraday}
                              onShowOnChart={props.onShowOnChart}
                              title={title(id())}
                              symbol={props.symbol}
                              interval={props.interval}
                            />
                          }
                        >
                          <MetricsView report={report()} intraday={props.intraday} intervalSec={props.intervalSec} onShowOnChart={props.onShowOnChart} />
                        </Show>
                      )}
                    </Show>
                  </div>
                </>
              )}
            </Show>
          </div>
        </Show>

        <Show when={menuFor()}>
          {(m) => (
            <Popover anchor={m().anchor} onClose={() => setMenuFor(null)} class="st-tab-menu" offset={{ x: 0, y: 4 }}>
              <PopItem
                title="Settings…"
                onClick={() => {
                  const id = m().id; // read before closing: the menu's accessor goes stale
                  setMenuFor(null);
                  props.onSettings(id);
                }}
              />
              <PopDivider />
              <PopItem
                title="Add strategy…"
                onClick={() => {
                  setMenuFor(null);
                  props.onAddStrategy();
                }}
              />
            </Popover>
          )}
        </Show>
      </section>
    </Show>
  );
}
