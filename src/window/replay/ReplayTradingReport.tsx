/*
 * Replay Trading panel body (bottom panel tab of Bar Replay): the strategy
 * report of the focused chart's paper trading account. Two icon tabs, Strategy
 * report (the Strategy Tester metrics) and List of trades (the trades table,
 * its Signal column titled "Order type"); "No data here, yet" until the first
 * trade.
 */
import { Show, createMemo } from "solid-js";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { replayBroker } from "../../data/trading/replay-broker";
import { tradingUi } from "../../data/trading/trading-ui";
import { MetricsView } from "../strategy-tester/MetricsView";
import { TradesView } from "../strategy-tester/TradesView";

/** Below this content height the empty state shows nothing (the reference app: 100 px). */
const EMPTY_MIN_HEIGHT = 100;

type Props = {
  intraday: boolean;
  intervalSec: number;
  interval: string;
  /** Focused chart symbol (EXCHANGE:TICKER) when no account symbol is known. */
  symbol: string;
  /** Report content height (px): the empty state needs room. */
  height: number;
  onShowOnChart: (timeSec: number) => void;
};

export function ReplayTradingReport(props: Props) {
  const report = createMemo(() => replayBroker.report());
  const symbol = () => replayBroker.symbol() ?? props.symbol;

  return (
    <Show
      when={report()}
      fallback={
        <Show when={props.height > EMPTY_MIN_HEIGHT}>
          <div class="rt-empty" data-name="replay-trading-empty">
            <div class="rt-empty-title">No data here, yet</div>
            <div class="rt-empty-text">Choose a bar or date in Bar Replay and place at least one trade to see results.</div>
          </div>
        </Show>
      }
    >
      {(r) => (
        <div class="rt-report" data-name="replay-trading-report">
          <div class="rt-toolbar">
            <div class="st-light-tabs" role="tablist">
              <Tooltip text="Strategy report" side="bottom">
                <button
                  type="button"
                  role="tab"
                  class="st-light-tab"
                  classList={{ "is-selected": tradingUi.reportView() === "report" }}
                  aria-selected={tradingUi.reportView() === "report"}
                  aria-label="Strategy report"
                  onClick={() => tradingUi.setReportView("report")}
                >
                  <Icon name="st-toolbar-tab-metrics" size={18} />
                </button>
              </Tooltip>
              <Tooltip text="List of trades" side="bottom">
                <button
                  type="button"
                  role="tab"
                  class="st-light-tab"
                  classList={{ "is-selected": tradingUi.reportView() === "trades" }}
                  aria-selected={tradingUi.reportView() === "trades"}
                  aria-label="List of trades"
                  onClick={() => tradingUi.setReportView("trades")}
                >
                  <Icon name={tradingUi.reportView() === "trades" ? "st-toolbar-tab-trades-selected" : "st-toolbar-tab-trades"} size={18} />
                </button>
              </Tooltip>
            </div>
          </div>
          <div class="st-report-body">
            <Show
              when={tradingUi.reportView() === "report"}
              fallback={
                <TradesView
                  report={r()}
                  intraday={props.intraday}
                  onShowOnChart={props.onShowOnChart}
                  title="Replay Trading"
                  symbol={symbol()}
                  interval={props.interval}
                  signalLabel="Order type"
                />
              }
            >
              <MetricsView report={r()} intraday={props.intraday} intervalSec={props.intervalSec} onShowOnChart={props.onShowOnChart} symbol={symbol()} />
            </Show>
          </div>
        </div>
      )}
    </Show>
  );
}
