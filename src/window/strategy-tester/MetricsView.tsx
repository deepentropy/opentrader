/*
 * Metrics view (the reference app 3.4.1): Key stats, Performance (equity chart),
 * Performance analysis and Trades analysis with their round sub-tabs.
 *
 * Only metrics whose value was matched against the reference app are shown; the
 * others of each sub-tab (Commission load, Sharpe / Sortino, Correlation,
 * run-up / drawdown durations, best hour / day, margin figures, returns
 * histogram) are listed as open in the design doc.
 */
import { For, Show, createMemo, createSignal, type JSX } from "solid-js";
import type { BacktestReport } from "../../backtester/types";
import { EquityChart } from "./EquityChart";
import { strategyTester } from "../../data/strategy-tester-store";
import { DASH, count, money, percent, ratio, tone } from "./format";
import { bestMonth, cagr, distribution, outliers, pnlBy, streaks, totalPnl, type PnlRow } from "./metrics";

/** One metric cell: label, value [+ currency] [+ second value]. */
function Cell(props: { label: string; value: string; currency?: string; change?: string; tone?: string }): JSX.Element {
  return (
    <div class="st-cell">
      <div class="st-cell-title">{props.label}</div>
      <div class={`st-cell-value ${props.tone ?? ""}`}>
        <span class="st-value">{props.value}</span>
        <Show when={props.currency}>
          <span class="st-currency">{props.currency}</span>
        </Show>
        <Show when={props.change}>
          <span class="st-change">{props.change}</span>
        </Show>
      </div>
    </div>
  );
}

function RoundTabs<T extends string>(props: { tabs: readonly T[]; value: T; onChange: (t: T) => void }) {
  return (
    <div class="st-round-tabs" role="tablist">
      <For each={props.tabs}>
        {(t) => (
          <button
            type="button"
            role="tab"
            class="st-round-tab"
            classList={{ "is-selected": t === props.value }}
            aria-selected={t === props.value}
            onClick={() => props.onChange(t)}
          >
            {t}
          </button>
        )}
      </For>
    </div>
  );
}

const PERF_TABS = ["Breakdown", "Periodical", "Benchmarking", "Growth and decline"] as const;
const TRADE_TABS = ["Distribution", "Streaks", "Time patterns"] as const;

type ViewProps = {
  report: BacktestReport;
  intraday: boolean;
  intervalSec: number;
  onShowOnChart: (timeSec: number) => void;
  /** Charted symbol: dates show in its exchange time zone. */
  symbol?: string;
};

/** Key stats values (the 4 cells, or the inline strip of the expanded chart). */
function keyStats(r: BacktestReport) {
  const perf = r.performance;
  const total = totalPnl(r);
  const cap = r.properties.initialCapital;
  return [
    { label: "Total PnL", value: money(total, true), currency: r.currency, change: percent(total / cap, true), tone: tone(total) },
    { label: "Max drawdown", value: money(perf.maxStrategyDrawDown), currency: r.currency, change: percent(perf.maxStrategyDrawDownPercent) },
    { label: "Profitable trades", value: percent(perf.all.percentProfitable), change: `${perf.all.numberOfWiningTrades}/${perf.all.totalTrades}` },
    { label: "Profit factor", value: ratio(perf.all.profitFactor) },
  ];
}

/** Expanded chart: Key stats as one line in place of the toolbar (row, gap 12px, padding 7px 0, 1 x 14 px #4a4a4a separators). */
export function KeyStatsInline(props: { report: BacktestReport }) {
  return (
    <div class="st-keystats-inline">
      <For each={keyStats(props.report)}>
        {(c, i) => (
          <>
            <Show when={i() > 0}>
              <span class="st-keystats-sep" />
            </Show>
            <span class="st-keystats-item">
              <span class="st-cell-title">{c.label}</span>
              <span class={`st-cell-value ${c.tone ?? ""}`}>
                <span class="st-value">{c.value}</span>
                <Show when={c.currency}>
                  <span class="st-currency">{c.currency}</span>
                </Show>
                <Show when={c.change}>
                  <span class="st-change">{c.change}</span>
                </Show>
              </span>
            </span>
          </>
        )}
      </For>
    </div>
  );
}

export function MetricsView(props: ViewProps) {
  const r = () => props.report;
  const cur = () => r().currency;
  const perf = () => r().performance;
  const cap = () => r().properties.initialCapital;
  const [perfTab, setPerfTab] = createSignal<(typeof PERF_TABS)[number]>("Breakdown");
  const [tradeTab, setTradeTab] = createSignal<(typeof TRADE_TABS)[number]>("Distribution");

  const total = createMemo(() => totalPnl(r()));
  const dist = createMemo(() => distribution(r()));
  const out = createMemo(() => outliers(r()));
  const st = createMemo(() => streaks(r()));
  const best = createMemo(() => bestMonth(r()));
  const trades = (n: number | null) => (n == null ? DASH : `${Number(n.toFixed(1))} trades`);

  const chart = () => <EquityChart report={r()} intraday={props.intraday} intervalSec={props.intervalSec} onShowOnChart={props.onShowOnChart} symbol={props.symbol} />;

  return (
    <Show when={!strategyTester.equityExpanded()} fallback={<div class="st-equity-expanded">{chart()}</div>}>
    <div class="st-metrics" data-name="metrics-view">
      <h2 class="st-view-title">Key stats</h2>
      <div class="st-cells st-cells-key">
        <For each={keyStats(r())}>{(c) => <Cell {...c} />}</For>
      </div>

      <div class="st-block">{chart()}</div>

      <h2 class="st-view-title">Performance analysis</h2>
      <div class="st-section">
        <RoundTabs tabs={PERF_TABS} value={perfTab()} onChange={setPerfTab} />
        <Show when={perfTab() === "Breakdown"}>
          <div class="st-cells">
            <Cell label="Gross profit" value={money(perf().all.grossProfit)} currency={cur()} change={percent(perf().all.grossProfitPercent)} />
            <Cell label="Gross loss" value={money(perf().all.grossLoss)} currency={cur()} change={percent(perf().all.grossLossPercent)} />
            <Cell label="Profit factor" value={ratio(perf().all.profitFactor)} />
          </div>
          <ProfitsAndLosses report={r()} />
        </Show>
        <Show when={perfTab() === "Periodical"}>
          <div class="st-cells">
            <Cell label="Annualized return (CAGR)" value={percent(cagr(r()), true)} tone={tone(cagr(r()))} />
            <Cell label="Total return" value={percent(total() / cap(), true)} tone={tone(total())} />
          </div>
        </Show>
        <Show when={perfTab() === "Benchmarking"}>
          {(() => {
            const strat = perf().all.netProfitPercent;
            const bh = perf().buyHoldReturnPercent;
            return (
              <div class="st-cells">
                <Cell label="Strategy return" value={percent(strat, true)} tone={tone(strat)} />
                <Cell label="Buy and hold return" value={percent(bh, true)} tone={tone(bh)} />
                <Cell label="Strategy outperformance" value={bh == null ? DASH : percent(strat - bh, true)} tone={bh == null ? "" : tone(strat - bh)} />
              </div>
            );
          })()}
        </Show>
        <Show when={perfTab() === "Growth and decline"}>
          <div class="st-cells">
            <Cell label="Max drawdown" value={money(perf().maxStrategyDrawDown)} currency={cur()} change={percent(perf().maxStrategyDrawDownPercent)} />
            <Cell label="Max drawdown as % of initial capital" value={percent(perf().maxStrategyDrawDown / cap())} />
          </div>
        </Show>
      </div>

      <h2 class="st-view-title">Trades analysis</h2>
      <div class="st-section">
        <RoundTabs tabs={TRADE_TABS} value={tradeTab()} onChange={setTradeTab} />
        <Show when={tradeTab() === "Distribution"}>
          <div class="st-cells">
            <Cell label="Expectancy" value={money(perf().all.avgTrade)} currency={cur()} change={percent(perf().all.avgTradePercent)} />
            <Cell label="Outliers PnL" value={money(out().pnl)} currency={cur()} change={percent(out().pnl / cap())} />
            <Cell label="Largest profit" value={money(perf().all.largestWinTrade)} currency={cur()} />
            <Cell label="Largest loss" value={money(perf().all.largestLosTrade)} currency={cur()} />
          </div>
          <TradesDistribution total={dist().total} winners={dist().winners} losers={dist().losers} breakevens={dist().breakevens} />
        </Show>
        <Show when={tradeTab() === "Streaks"}>
          <div class="st-cells">
            <Cell label="Longest winning streak" value={trades(st().longestWin)} />
            <Cell label="Longest losing streak" value={trades(st().longestLoss)} />
            <Cell label="Average winning streak" value={trades(st().avgWin)} />
            <Cell label="Average losing streak" value={trades(st().avgLoss)} />
          </div>
        </Show>
        <Show when={tradeTab() === "Time patterns"}>
          <div class="st-cells">
            <Cell
              label="Best month for entries"
              value={best()?.month ?? DASH}
              change={best() ? `${percent(best()!.winRate)} winners` : undefined}
            />
            <Cell label="Average trade duration" value={perf().all.avgBarsInTrade == null ? DASH : `${Math.round(perf().all.avgBarsInTrade!)} bars`} />
          </div>
        </Show>
      </div>
    </div>
    </Show>
  );
}

/** Profits and losses by signal / by side, with the reference app's split bars. */
function ProfitsAndLosses(props: { report: BacktestReport }) {
  const [by, setBy] = createSignal<"signal" | "side">("signal");
  const rows = createMemo(() => pnlBy(props.report, by()));
  const scale = createMemo(() => {
    const maxLoss = Math.max(0, ...rows().map((x) => x.lossSum + x.commission));
    const maxProfit = Math.max(0, ...rows().map((x) => x.profitSum));
    return { maxLoss, maxProfit, total: maxLoss + maxProfit || 1 };
  });
  const bar = (row: PnlRow) => {
    const s = scale();
    const pct = (v: number) => `${(v / s.total) * 100}%`;
    const net = row.pnl;
    return (
      <div class="st-pnl-bar" style={{ "grid-template-columns": `${pct(s.maxLoss)} ${pct(s.maxProfit)}` }}>
        <div class="st-pnl-left">
          <Show when={row.commission > 0}>
            <span class="st-pnl-commission" style={{ width: pct(row.commission) }} />
          </Show>
          <span class="st-pnl-loss" style={{ width: pct(Math.max(0, row.lossSum - Math.max(0, -net))) }} />
          <Show when={net < 0}>
            <span class="st-pnl-netloss" style={{ width: pct(Math.min(row.lossSum, -net)) }} />
          </Show>
        </div>
        <div class="st-pnl-right">
          <Show when={net > 0}>
            <span class="st-pnl-netprofit" style={{ width: pct(Math.min(row.profitSum, net)) }} />
          </Show>
          <span class="st-pnl-profit" style={{ width: pct(Math.max(0, row.profitSum - Math.max(0, net))) }} />
        </div>
      </div>
    );
  };
  return (
    <div class="st-block">
      <div class="st-block-header">
        <span class="st-block-title">Profits and losses</span>
        <div class="st-segmented" role="radiogroup">
          <button type="button" role="radio" class="st-segment" classList={{ "is-checked": by() === "signal" }} aria-checked={by() === "signal"} onClick={() => setBy("signal")}>
            By signals
          </button>
          <button type="button" role="radio" class="st-segment" classList={{ "is-checked": by() === "side" }} aria-checked={by() === "side"} onClick={() => setBy("side")}>
            By side
          </button>
        </div>
      </div>
      <div class="st-pnl-rows">
        <For each={rows()}>
          {(row, i) => (
            <div class="st-pnl-row" classList={{ "is-first": i() === 0 }}>
              <span class="st-pnl-label" title={row.label}>{row.label}</span>
              {bar(row)}
              <span class={`st-pnl-value ${tone(row.pnl)}`}>
                {money(row.pnl, true)}
                <span class="st-pnl-currency">{props.report.currency}</span>
              </span>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

/** Trades distribution donut (winners / losers / breakevens). */
function TradesDistribution(props: { total: number; winners: number; losers: number; breakevens: number }) {
  const R = 80;
  const W = 18;
  const C = 2 * Math.PI * (R - W / 2);
  const parts = () => [
    { label: "Winners", n: props.winners, color: "var(--st-positive-strong)" },
    { label: "Losers", n: props.losers, color: "var(--st-negative-strong)" },
    { label: "Breakevens", n: props.breakevens, color: "var(--st-breakeven)" },
  ];
  const arcs = () => {
    let offset = 0;
    return parts().map((p) => {
      const len = props.total ? (p.n / props.total) * C : 0;
      const a = { ...p, len, offset };
      offset += len;
      return a;
    });
  };
  return (
    <div class="st-block">
      <div class="st-block-header">
        <span class="st-block-title">Trades distribution</span>
      </div>
      <div class="st-donut-wrap">
        <div class="st-donut">
          <svg viewBox={`0 0 ${2 * R} ${2 * R}`} width={2 * R} height={2 * R}>
            <For each={arcs()}>
              {(a) => (
                <circle
                  cx={R}
                  cy={R}
                  r={R - W / 2}
                  fill="none"
                  stroke={a.color}
                  stroke-width={W}
                  stroke-dasharray={`${a.len} ${C - a.len}`}
                  stroke-dashoffset={-a.offset}
                  transform={`rotate(-90 ${R} ${R})`}
                />
              )}
            </For>
          </svg>
          <div class="st-donut-center">
            <span class="st-donut-count">{count(props.total)}</span>
            <span class="st-donut-label">Total trades</span>
          </div>
        </div>
        <div class="st-donut-legend">
          <For each={parts()}>
            {(p) => (
              <>
                <span class="st-dot" style={{ background: p.color }} />
                <span>{p.label}</span>
                <span class="st-donut-num">{p.n} trades</span>
                <span class="st-donut-num">{percent(props.total ? p.n / props.total : 0)}</span>
              </>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
