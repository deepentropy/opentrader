/*
 * List of trades (the reference app 3.4.1): header "List of trades" + Column setup,
 * sticky 40 px header row, one 98 px row per trade (Exit half above, Entry
 * half below), sortable by trade number (newest first), "Show on chart" on
 * the hovered half. Rows are windowed: only the visible ones are in the DOM
 * (thousands of trades stay instant).
 *
 * Download .csv (tooltip "Download .csv", before Column setup) writes
 * the reference app's file (trades-csv.ts): all 17 columns whatever the Column
 * setup, trade 1 first whatever the sort.
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { Popover, PopItem } from "../screener/Popover";
import type { BacktestReport, Trade } from "../../backtester/types";
import { DASH, compact, count, money, percent, tone, tradeDate } from "./format";
import { tradesCsv, tradesCsvFileName } from "./trades-csv";
import { DEFAULT_SYMBOL } from "../../backtester/types";
import { cachedSymbolSessions } from "../../data/session";

const ROW = 98;
const OVERSCAN = 6;

type OptionalCol = "Date and time" | "Signal" | "Price" | "Size" | "Net PnL" | "Return" | "Commission" | "Favorable excursion" | "Adverse excursion" | "Cumulative PnL" | "Duration (bars)";
/** Column setup menu, in the reference app's order; checked = shown by default. */
const COLUMNS: { name: OptionalCol; on: boolean; width: string; align: "start" | "end"; half: boolean }[] = [
  { name: "Date and time", on: true, width: "minmax(130px, 0.8fr)", align: "start", half: true },
  { name: "Signal", on: false, width: "minmax(120px, 0.8fr)", align: "start", half: true },
  { name: "Price", on: true, width: "minmax(110px, 1fr)", align: "end", half: true },
  { name: "Size", on: true, width: "minmax(110px, 1fr)", align: "end", half: false },
  { name: "Net PnL", on: true, width: "minmax(130px, 1.2fr)", align: "end", half: false },
  { name: "Return", on: true, width: "minmax(90px, 0.9fr)", align: "end", half: false },
  { name: "Commission", on: false, width: "minmax(110px, 0.8fr)", align: "end", half: false },
  { name: "Favorable excursion", on: false, width: "minmax(140px, 0.9fr)", align: "end", half: false },
  { name: "Adverse excursion", on: false, width: "minmax(140px, 0.9fr)", align: "end", half: false },
  { name: "Cumulative PnL", on: false, width: "minmax(130px, 0.9fr)", align: "end", half: false },
  { name: "Duration (bars)", on: false, width: "minmax(110px, 0.7fr)", align: "end", half: false },
];

type Props = {
  report: BacktestReport;
  intraday: boolean;
  onShowOnChart: (timeSec: number) => void;
  /** Strategy short title, chart symbol (EXCHANGE:TICKER) and interval: CSV name and dates. */
  title: string;
  symbol: string;
  interval: string;
};

/** Save a text file through the browser download (as the app's other exports). */
function download(name: string, text: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/octet-stream" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function TradesView(props: Props) {
  let scroller!: HTMLDivElement;
  let setupRef: HTMLButtonElement | undefined;
  const [desc, setDesc] = createSignal(true);
  const [shown, setShown] = createSignal(new Set(COLUMNS.filter((c) => c.on).map((c) => c.name)));
  const [setupOpen, setSetupOpen] = createSignal(false);
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewH, setViewH] = createSignal(400);

  // Trade numbers follow the reference app: entry order, open trades last.
  const numbered = createMemo(() => props.report.trades.map((t, i) => ({ t, n: i + 1 })));
  const ordered = createMemo(() => (desc() ? numbered().slice().reverse() : numbered()));
  const cols = () => COLUMNS.filter((c) => shown().has(c.name));
  const template = () => ["minmax(150px, 1.4fr)", "46px", "72px", ...cols().map((c) => c.width)].join(" ");

  onMount(() => {
    const ro = new ResizeObserver(() => setViewH(scroller.clientHeight));
    ro.observe(scroller);
    onCleanup(() => ro.disconnect());
  });

  const range = () => {
    const first = Math.max(0, Math.floor(scrollTop() / ROW) - OVERSCAN);
    const last = Math.min(ordered().length, Math.ceil((scrollTop() + viewH()) / ROW) + OVERSCAN);
    return { first, last };
  };
  const visible = createMemo(() => ordered().slice(range().first, range().last));
  const cur = () => props.report.currency;
  /** Exchange zone of the charted symbol (resolved with its bars). */
  const timeZone = () => cachedSymbolSessions(props.symbol ?? "")?.timeZone ?? null;

  const cell = (col: OptionalCol, t: Trade, half: "exit" | "entry" | null) => {
    switch (col) {
      case "Date and time": {
        const zone = timeZone();
        return half === "exit" && t.open ? <span class="st-muted">Open</span> : zone ? tradeDate(half === "exit" ? t.exit.time : t.entry.time, props.intraday, zone) : "";
      }
      case "Signal":
        return half === "exit" ? (t.open ? DASH : t.exit.signal) : t.entry.signal;
      case "Price":
        return half === "exit" && t.open ? DASH : <Money v={half === "exit" ? t.exit.price : t.entry.price} cur={cur()} />;
      case "Size":
        return (
          <span class="st-size">
            <span>{count(t.qty)}</span>
            <span class="st-size-value">
              {compact(t.qty * t.entry.price)}
              <span class="st-cur">{cur()}</span>
            </span>
          </span>
        );
      case "Net PnL":
        return <Money v={t.profit} cur={cur()} signed tone />;
      case "Return":
        return t.open ? DASH : <span class={tone(t.profitPercent)}>{percent(t.profitPercent, true)}</span>;
      case "Commission":
        return <Money v={t.commission} cur={cur()} />;
      case "Favorable excursion":
        return <Money v={t.runUp} cur={cur()} />;
      case "Adverse excursion":
        return <Money v={t.drawdown} cur={cur()} />;
      case "Cumulative PnL":
        return <Money v={t.cumProfit} cur={cur()} signed tone />;
      case "Duration (bars)":
        return count(t.exit.bar - t.entry.bar + 1);
    }
  };

  return (
    <div class="st-trades" data-name="trades-view">
      <div class="st-trades-header">
        <h2 class="st-view-title st-trades-title">List of trades</h2>
        <div class="st-trades-actions">
          <Tooltip text="Download .csv" side="bottom">
            <button
              type="button"
              class="st-icon-btn st-icon-btn-csv"
              aria-label="Download .csv"
              onClick={() => {
                const r = props.report;
                const zone = timeZone();
                if (!zone) return;
                const csv = tradesCsv({
                  trades: r.trades,
                  currency: r.currency,
                  priceCurrency: r.currency,
                  initialCapital: r.properties.initialCapital,
                  mintick: cachedSymbolSessions(props.symbol ?? "")?.mintick ?? DEFAULT_SYMBOL.mintick,
                  pointValue: DEFAULT_SYMBOL.pointValue,
                  timeZone: zone,
                  interval: props.interval,
                });
                download(tradesCsvFileName(props.title, props.symbol), csv);
              }}
            >
              <Icon name="st-trades-download-csv" size={28} />
            </button>
          </Tooltip>
          <Tooltip text="Column setup" side="bottom">
            <button type="button" ref={setupRef} class="st-icon-btn st-icon-btn-sm" aria-label="Column setup" onClick={() => setSetupOpen(!setupOpen())}>
              <Icon name="st-trades-column-setup" size={18} />
            </button>
          </Tooltip>
        </div>
      </div>
      <div class="st-trades-scroll" ref={scroller} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        <div class="st-trades-head" style={{ "grid-template-columns": template() }} role="row">
          <button type="button" class="st-th st-th-sort" onClick={() => setDesc(!desc())}>
            Trade number <span class="st-sort-glyph">{desc() ? "↓" : "↑"}</span>
          </button>
          <span class="st-th" />
          <span class="st-th">Type</span>
          <For each={cols()}>{(c) => <span class={`st-th is-${c.align}`}>{c.name}</span>}</For>
        </div>
        <div class="st-trades-body" style={{ height: `${ordered().length * ROW}px` }}>
          <For each={visible()}>
            {(row, i) => {
              const t = row.t;
              const top = () => (range().first + i()) * ROW;
              return (
                <div class="st-trade-row" style={{ top: `${top()}px`, "grid-template-columns": template() }} role="row">
                  <span class="st-td st-td-span st-trade-number">
                    {row.n}
                    <span class={t.direction === "long" ? "st-side-long" : "st-side-short"}>{t.direction === "long" ? "Long" : "Short"}</span>
                  </span>
                  <span class="st-td-halves st-goto">
                    <GotoButton onClick={() => props.onShowOnChart((t.open ? t.entry.time : t.exit.time) / 1000)} hidden={t.open} />
                    <GotoButton onClick={() => props.onShowOnChart(t.entry.time / 1000)} />
                  </span>
                  <span class="st-td-halves st-type">
                    <span class="st-half">Exit</span>
                    <span class="st-half">Entry</span>
                  </span>
                  <For each={cols()}>
                    {(c) =>
                      c.half ? (
                        <span class={`st-td-halves is-${c.align}`}>
                          <span class="st-half">{cell(c.name, t, "exit")}</span>
                          <span class="st-half">{cell(c.name, t, "entry")}</span>
                        </span>
                      ) : (
                        <span class={`st-td st-td-span is-${c.align}`}>{cell(c.name, t, null)}</span>
                      )
                    }
                  </For>
                </div>
              );
            }}
          </For>
        </div>
      </div>

      <Show when={setupOpen()}>
        <Popover anchor={setupRef} onClose={() => setSetupOpen(false)} class="st-column-setup">
          <For each={COLUMNS}>
            {(c) => (
              <PopItem
                title={c.name}
                right={<span class="st-check">{shown().has(c.name) ? "✓" : ""}</span>}
                onClick={() => {
                  const next = new Set(shown());
                  if (next.has(c.name)) next.delete(c.name);
                  else next.add(c.name);
                  setShown(next);
                }}
              />
            )}
          </For>
        </Popover>
      </Show>
    </div>
  );
}

function Money(props: { v: number; cur: string; signed?: boolean; tone?: boolean }) {
  return (
    <span class={props.tone ? tone(props.v) : ""}>
      {money(props.v, props.signed)}
      <span class="st-cur">{props.cur}</span>
    </span>
  );
}

function GotoButton(props: { onClick: () => void; hidden?: boolean }) {
  return (
    <span class="st-half">
      <Show when={!props.hidden}>
        <Tooltip text="Show on chart" side="top">
          <button type="button" class="st-goto-btn" aria-label="Show on chart" onClick={props.onClick}>
            <Icon name="st-trades-show-on-chart" size={18} />
          </button>
        </Tooltip>
      </Show>
    </span>
  );
}
