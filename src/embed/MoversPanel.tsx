/*
 * Market movers of an embedded chart's right panel (#339): the US stocks most
 * traded today, the biggest gainers and the biggest losers, from the stock
 * screener's market table (read again on each of its updates). Stocks under
 * $1 or under 100,000 shares traded are left out: they would fill the
 * gainers and losers. A click shows the symbol on the chart.
 */
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { Clause, ScanRow } from "../bindings";
import { onScreenerUpdate, screenerClose, screenerOpen, screenerScan } from "../data/screener-api";
import { PRIMARY_UNIVERSE_CLAUSE } from "../data/screener-query";
import { changeText, moveClass, percentText, priceText } from "./widgets/parts";

type Tab = "active" | "gainers" | "losers";
const SORT: Record<Tab, { sortBy: string; sortOrder: "asc" | "desc" }> = {
  active: { sortBy: "volume", sortOrder: "desc" },
  gainers: { sortBy: "change", sortOrder: "desc" },
  losers: { sortBy: "change", sortOrder: "asc" },
};
const COLUMNS = ["description", "close", "change_abs", "change"];
const FILTER: Clause[] = [
  PRIMARY_UNIVERSE_CLAUSE,
  { left: "close", operation: "egreater", right: 1 },
  { left: "volume", operation: "egreater", right: 100_000 },
];
const ROWS = 20;
const OWNER = "embed:movers";

type Mover = { ticker: string; name: string; last: number | null; change: number | null; changePercent: number | null };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const moverOf = (r: ScanRow): Mover => ({
  ticker: r.s,
  name: typeof r.d[0] === "string" ? r.d[0] : "",
  last: num(r.d[1]),
  change: num(r.d[2]),
  changePercent: num(r.d[3]),
});

export function MoversPanel(props: { onSymbolSelect: (ticker: string) => void }) {
  const [tab, setTab] = createSignal<Tab>("active");
  const [rows, setRows] = createSignal<Mover[] | null>(null);
  let alive = true;

  const scan = async () => {
    const t = tab();
    try {
      const r = await screenerScan({ columns: COLUMNS, filter: FILTER, sort: SORT[t], range: [0, ROWS], tickers: null });
      if (alive && t === tab()) setRows(r.rows.map(moverOf));
    } catch (e) {
      console.warn(`[embed] movers: ${e}`);
    }
  };
  const tabClass = (t: Tab) => "ot-movers-tab" + (tab() === t ? " is-active" : "");
  const pick = (t: Tab) => {
    setTab(t);
    setRows(null);
    void scan();
  };

  onMount(() => {
    void screenerOpen(OWNER)
      .then((st) => {
        if (alive && st.complete) void scan();
      })
      .catch((e) => console.warn(`[embed] movers: ${e}`));
    const off = onScreenerUpdate((u) => u.complete && void scan());
    onCleanup(() => {
      alive = false;
      void off.then((f) => f());
      void screenerClose(OWNER).catch(() => {});
    });
  });

  return (
    <div class="ot-movers">
      {/* The market's losers, not losing trades: the tabs' words take the "market" sense. */}
      <div class="ot-movers-tabs" role="tablist" data-i18n-sense="market">
        <button type="button" role="tab" aria-selected={tab() === "active"} class={tabClass("active")} onClick={() => pick("active")}>
          Most active
        </button>
        <button type="button" role="tab" aria-selected={tab() === "gainers"} class={tabClass("gainers")} onClick={() => pick("gainers")}>
          Gainers
        </button>
        <button type="button" role="tab" aria-selected={tab() === "losers"} class={tabClass("losers")} onClick={() => pick("losers")}>
          Losers
        </button>
      </div>
      <div class="ot-movers-list">
        <Show when={rows()} fallback={<div class="ot-movers-empty">Loading…</div>}>
          <For each={rows()}>
            {(m) => (
              <button type="button" class="ot-movers-row" onClick={() => props.onSymbolSelect(m.ticker)}>
                <span class="ot-movers-names">
                  <span class="ot-movers-ticker" data-no-translate>{m.ticker}</span>
                  <span class="ot-movers-name" data-no-translate>{m.name}</span>
                </span>
                <span class="ot-movers-values">
                  <span class="ot-value">{priceText(m.last)}</span>
                  <span class={`ot-movers-change ot-value ${moveClass(m.change)}`}>
                    {changeText(m.change)} {percentText(m.changePercent)}
                  </span>
                </span>
              </button>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}
