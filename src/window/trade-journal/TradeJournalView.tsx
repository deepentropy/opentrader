/*
 * Trade journal tab of the footer panel: the active journal's trades, grouped
 * and sorted, one click (or the arrow keys) showing a trade on the active
 * chart. The values come from the bars (trade-journal-calc.ts) and fill in as
 * they are read. Ctrl / Shift + click picks several trades; a trade's, or a
 * group's, context menu shares it to the Community (trade-journal-share.ts).
 */
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { Popover, PopItem } from "../screener/Popover";
import { requestShare } from "../../data/community/share";
import { shareListSeed, shareTradeSeed } from "../../data/trade-journal-share";
import { tradeJournal, type JournalTrade, type SortCol } from "../../data/trade-journal";
import { GROUP_LABELS, durationText, groupTrades, tradeDateText, type GroupBy } from "../../data/trade-journal-calc";
import { pickTradeFile } from "./ImportTradesDialog";

type Props = {
  /** Chart time zone (IANA): times and day groups are read in it. */
  timeZone: string;
};

const ROW = 32;
const OVERSCAN = 10;

type Item = { kind: "group"; key: string; label: string; count: number; computed: number; wins: number; pnl: number } | { kind: "trade"; t: JournalTrade; n: number };

const COLUMNS: { id: SortCol | null; label: string; width: string; end?: boolean; title?: string }[] = [
  { id: null, label: "#", width: "56px" },
  { id: "symbol", label: "Symbol", width: "minmax(110px, 1fr)" },
  { id: "entry", label: "Entry", width: "150px" },
  { id: "exit", label: "Exit", width: "150px" },
  { id: "duration", label: "Duration", width: "90px", end: true },
  { id: null, label: "Qty", width: "70px", end: true },
  { id: null, label: "Entry price", width: "100px", end: true },
  { id: null, label: "Exit price", width: "100px", end: true },
  { id: "pnl", label: "P&L", width: "110px", end: true },
  { id: "pnlPct", label: "P&L %", width: "90px", end: true },
  { id: "runUpPct", label: "Run-up %", width: "90px", end: true, title: "Largest move in the trade's favour, from the entry price" },
  { id: "drawdownPct", label: "Drawdown %", width: "100px", end: true, title: "Largest move against the trade, from the entry price" },
  { id: null, label: "Notes", width: "minmax(120px, 2fr)" },
  { id: null, label: "", width: "40px" },
];
const TEMPLATE = COLUMNS.map((c) => c.width).join(" ");

const GROUPS: GroupBy[] = ["none", "symbol", "day", "week", "month", "year", "profit", "drawdown"];

const num = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const qtyFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });

const price = (v: number) => (Math.abs(v) < 1 ? v.toFixed(4) : num.format(v));
const signed = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${num.format(Math.abs(v))}`;
const pct = (v: number, sign = true) => `${sign && v > 0 ? "+" : v < 0 ? "−" : ""}${(Math.abs(v) * 100).toFixed(2)}%`;
const tradesText = (n: number) => `${n} trade${n === 1 ? "" : "s"}`;
const tone = (v: number) => (v > 0 ? "is-positive" : v < 0 ? "is-negative" : "");

function sortValue(t: JournalTrade, col: SortCol): number | string {
  switch (col) {
    case "entry":
      return t.entryTime;
    case "exit":
      return t.exitTime;
    case "symbol":
      return t.symbol;
    case "duration":
      return t.exitTime - t.entryTime;
    case "pnl":
      return t.calc?.pnl ?? -Infinity;
    case "pnlPct":
      return t.calc?.pnlPct ?? -Infinity;
    case "runUpPct":
      return t.calc?.runUpPct ?? -Infinity;
    case "drawdownPct":
      return t.calc?.drawdownPct ?? -Infinity;
  }
}

export function TradeJournalView(props: Props) {
  let scroller!: HTMLDivElement;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewH, setViewH] = createSignal(300);
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set());
  /** Trades picked with Ctrl / Shift + click (a list to share). */
  const [picked, setPicked] = createSignal<Set<string>>(new Set());
  /** Context menu at the pointer: a trade's, or a group's. */
  const [menu, setMenu] = createSignal<{ x: number; y: number; trade?: JournalTrade; group?: { label: string; trades: JournalTrade[] } } | null>(null);

  onMount(() => {
    const ro = new ResizeObserver(() => setViewH(scroller.clientHeight));
    ro.observe(scroller);
    onCleanup(() => ro.disconnect());
  });

  const journal = () => tradeJournal.active();
  const prefs = () => tradeJournal.prefs();

  /** Trade numbers: entry order in the journal. */
  const numbers = createMemo(() => new Map((journal()?.trades ?? []).map((t, i) => [t.id, i + 1])));
  const sorted = createMemo(() => {
    const { col, desc } = prefs().sort;
    const list = [...(journal()?.trades ?? [])];
    list.sort((a, b) => {
      const va = sortValue(a, col);
      const vb = sortValue(b, col);
      const c = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number);
      return (desc ? -c : c) || a.entryTime - b.entryTime;
    });
    return list;
  });
  const groups = createMemo(() => groupTrades(sorted(), prefs().groupBy, props.timeZone));
  const items = createMemo<Item[]>(() => {
    const out: Item[] = [];
    const nums = numbers();
    const grouped = prefs().groupBy !== "none";
    for (const g of groups()) {
      if (grouped) out.push({ kind: "group", key: g.key, label: g.label, count: g.trades.length, computed: g.computed, wins: g.wins, pnl: g.pnl });
      if (grouped && collapsed().has(g.key)) continue;
      for (const t of g.trades) out.push({ kind: "trade", t, n: nums.get(t.id) ?? 0 });
    }
    return out;
  });
  /** Trades in the order shown (arrow keys step through them). */
  const shownTrades = createMemo(() => items().flatMap((i) => (i.kind === "trade" ? [i.t] : [])));
  const range = createMemo(() => {
    const first = Math.max(0, Math.floor(scrollTop() / ROW) - OVERSCAN);
    const last = Math.min(items().length, Math.ceil((scrollTop() + viewH()) / ROW) + OVERSCAN);
    return { first, last };
  });
  const visible = createMemo(() => items().slice(range().first, range().last));

  const summary = createMemo(() => {
    const ts = journal()?.trades ?? [];
    const done = ts.filter((t) => t.calc);
    const wins = done.filter((t) => t.calc!.pnl > 0).length;
    const pnl = done.reduce((s, t) => s + t.calc!.pnl, 0);
    const pending = ts.filter((t) => t.status === "pending").length;
    const failed = ts.filter((t) => t.status === "unknown" || t.status === "nodata").length;
    return { count: ts.length, done: done.length, wins, pnl, pending, failed };
  });

  // Collapsed groups belong to one grouping; picked trades to one journal.
  createEffect(on(() => [prefs().groupBy, journal()?.id], () => setCollapsed(new Set<string>()), { defer: true }));
  createEffect(on(() => journal()?.id, () => setPicked(new Set<string>()), { defer: true }));

  function show(t: JournalTrade, replay = false) {
    tradeJournal.show(t, replay);
  }
  /** A plain click shows the trade; Ctrl + click adds it to (or takes it from) the picked trades; Shift + click
   *  picks the trades shown from the one on the chart to it. */
  function onRowClick(e: MouseEvent, t: JournalTrade) {
    const from = tradeJournal.selectedId();
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(picked());
      if (next.size === 0 && from && from !== t.id) next.add(from);
      if (next.has(t.id)) next.delete(t.id);
      else next.add(t.id);
      setPicked(next);
      return;
    }
    if (e.shiftKey && from) {
      const list = shownTrades();
      const a = list.findIndex((x) => x.id === from);
      const b = list.findIndex((x) => x.id === t.id);
      if (a >= 0 && b >= 0) {
        setPicked(new Set(list.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.id)));
        return;
      }
    }
    setPicked(new Set<string>());
    show(t);
  }
  /** The picked trades, in the order shown. */
  const pickedTrades = () => shownTrades().filter((t) => picked().has(t.id));

  /** One trade: the chart shows it first, so the post's picture is framed on it with its marks. */
  async function shareTrade(t: JournalTrade) {
    if (t.fullSymbol) await tradeJournal.showFramed(t);
    requestShare(shareTradeSeed(t, props.timeZone));
  }
  function shareList(trades: JournalTrade[], label?: string) {
    requestShare(shareListSeed(trades, props.timeZone, label));
  }
  /** Scroll the selected trade into view. */
  function reveal(id: string) {
    const i = items().findIndex((x) => x.kind === "trade" && x.t.id === id);
    if (i < 0) return;
    const top = i * ROW;
    const head = 40;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (top + ROW > scroller.scrollTop + scroller.clientHeight - head) scroller.scrollTop = top + ROW - scroller.clientHeight + head;
  }
  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const list = shownTrades();
    if (list.length === 0) return;
    e.preventDefault();
    const cur = list.findIndex((t) => t.id === tradeJournal.selectedId());
    const next = cur < 0 ? 0 : Math.min(list.length - 1, Math.max(0, cur + (e.key === "ArrowDown" ? 1 : -1)));
    if (next === cur) return;
    show(list[next]);
    reveal(list[next].id);
  }

  function sortBy(col: SortCol) {
    const s = prefs().sort;
    tradeJournal.setPrefs({ sort: { col, desc: s.col === col ? !s.desc : col !== "symbol" } });
  }
  function toggleGroup(key: string) {
    const next = new Set(collapsed());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setCollapsed(next);
  }

  const statusText = (t: JournalTrade) =>
    t.status === "unknown" ? "Unknown symbol" : t.status === "nodata" ? "No bars for these dates" : t.status === "pending" ? "Reading the bars…" : "";

  return (
    <div class="tj-view" data-name="trade-journal">
      <div class="tj-toolbar">
        <Show when={journal()}>{(j) => <span class="tj-journal-name">{j().name}</span>}</Show>
        <label class="tj-toolbar-label">
          Group by
          <select class="tj-select" value={prefs().groupBy} onChange={(e) => tradeJournal.setPrefs({ groupBy: e.currentTarget.value as GroupBy })}>
            <For each={GROUPS}>{(g) => <option value={g}>{GROUP_LABELS[g]}</option>}</For>
          </select>
        </label>
        <label class="tj-toolbar-label">
          Chart interval
          <select class="tj-select" value={prefs().interval} onChange={(e) => tradeJournal.setPrefs({ interval: e.currentTarget.value as "auto" | "keep" })}>
            <option value="auto">Fit the trade</option>
            <option value="keep">Keep the chart's</option>
          </select>
        </label>
        <Show when={journal()}>
          <div class="tj-summary">
            <span>{tradesText(summary().count)}</span>
            <Show when={summary().done > 0}>
              <span>Win rate {((summary().wins / summary().done) * 100).toFixed(1)}%</span>
              <span>
                Net P&L <span class={tone(summary().pnl)}>{signed(summary().pnl)}</span>
              </span>
            </Show>
            <Show when={summary().pending > 0}>
              <span class="tj-muted">Reading {summary().pending}…</span>
            </Show>
            <Show when={summary().failed > 0}>
              <span class="tj-muted">{summary().failed} without values</span>
            </Show>
          </div>
        </Show>
      </div>

      <div class="tj-scroll" ref={scroller} tabIndex={0} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} onKeyDown={onKeyDown}>
        <Show
          when={journal()}
          fallback={
            <div class="tj-empty">
              <div>Import a CSV of trades: one row per trade with its symbol, entry date and exit date.</div>
              <div class="tj-muted">Side, quantity, prices, fees and notes are read when the file has them. A Strategy Tester list of trades can be imported as is.</div>
              <button type="button" class="tj-btn" onClick={pickTradeFile}>
                Import trades…
              </button>
            </div>
          }
        >
          <div class="tj-head" style={{ "grid-template-columns": TEMPLATE }} role="row">
            <For each={COLUMNS}>
              {(c) =>
                c.id ? (
                  <button type="button" class="tj-th tj-th-sort" classList={{ "is-end": c.end }} title={c.title} onClick={() => sortBy(c.id!)}>
                    {c.label}
                    <Show when={prefs().sort.col === c.id}>
                      <span class="st-sort-glyph">{prefs().sort.desc ? "↓" : "↑"}</span>
                    </Show>
                  </button>
                ) : (
                  <span class="tj-th" classList={{ "is-end": c.end }}>
                    {c.label}
                  </span>
                )
              }
            </For>
          </div>
          <div class="tj-body" style={{ height: `${items().length * ROW}px` }}>
            <For each={visible()}>
              {(item, i) => {
                const top = () => (range().first + i()) * ROW;
                if (item.kind === "group") {
                  return (
                    <div
                      class="tj-group"
                      style={{ top: `${top()}px` }}
                      role="row"
                      onClick={() => toggleGroup(item.key)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        const g = groups().find((x) => x.key === item.key);
                        if (g) setMenu({ x: e.clientX, y: e.clientY, group: { label: g.label, trades: g.trades } });
                      }}
                    >
                      <span class="tj-group-caret" classList={{ "is-collapsed": collapsed().has(item.key) }}>
                        <Icon name="st-footer-tab-caret" />
                      </span>
                      <span class="tj-group-label">{item.label}</span>
                      <span class="tj-muted">{tradesText(item.count)}</span>
                      <Show when={item.computed > 0}>
                        <span class="tj-muted">Win rate {((item.wins / item.computed) * 100).toFixed(1)}%</span>
                        <span class={tone(item.pnl)}>{signed(item.pnl)}</span>
                      </Show>
                    </div>
                  );
                }
                const t = item.t;
                const c = t.calc;
                const zone = t.dateOnly ? t.zone : props.timeZone;
                return (
                  <div
                    class="tj-row"
                    classList={{
                      "is-selected": tradeJournal.selectedId() === t.id,
                      "is-picked": picked().has(t.id),
                      "is-failed": t.status === "unknown" || t.status === "nodata",
                    }}
                    style={{ top: `${top()}px`, "grid-template-columns": TEMPLATE }}
                    role="row"
                    onClick={(e) => onRowClick(e, t)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({ x: e.clientX, y: e.clientY, trade: t });
                    }}
                  >
                    <span class="tj-td tj-muted">{item.n}</span>
                    <span class="tj-td tj-symbol">
                      {t.symbol}
                      <span class={t.side === "long" ? "st-side-long" : "st-side-short"}>{t.side === "long" ? "Long" : "Short"}</span>
                    </span>
                    <span class="tj-td">{tradeDateText(t.entryTime, zone, t.dateOnly)}</span>
                    <span class="tj-td">{tradeDateText(t.exitTime, zone, t.dateOnly)}</span>
                    <span class="tj-td is-end">{durationText(t)}</span>
                    <span class="tj-td is-end">{t.qty !== undefined ? qtyFmt.format(t.qty) : "—"}</span>
                    <span class="tj-td is-end" classList={{ "tj-estimated": !!c?.entryEstimated }} title={c?.entryEstimated ? "Read on the bars (not in the file)" : undefined}>
                      {c ? price(c.entryPrice) : t.entryPrice !== undefined ? price(t.entryPrice) : "—"}
                    </span>
                    <span class="tj-td is-end" classList={{ "tj-estimated": !!c?.exitEstimated }} title={c?.exitEstimated ? "Read on the bars (not in the file)" : undefined}>
                      {c ? price(c.exitPrice) : t.exitPrice !== undefined ? price(t.exitPrice) : "—"}
                    </span>
                    <span class={`tj-td is-end ${c ? tone(c.pnl) : ""}`}>{c ? signed(c.pnl) : "—"}</span>
                    <span class={`tj-td is-end ${c ? tone(c.pnlPct) : ""}`}>{c ? pct(c.pnlPct) : "—"}</span>
                    <span class="tj-td is-end">{c ? pct(c.runUpPct, false) : "—"}</span>
                    <span class="tj-td is-end">{c ? pct(c.drawdownPct, false) : "—"}</span>
                    <span class="tj-td tj-notes" title={t.notes ?? statusText(t)}>
                      <Show when={t.status !== "ok"} fallback={t.notes ?? ""}>
                        <span class="tj-muted">{statusText(t)}</span>
                      </Show>
                    </span>
                    <span class="tj-td tj-actions">
                      <Show when={t.fullSymbol}>
                        <Tooltip text="Replay from entry" side="top">
                          <button
                            type="button"
                            class="st-goto-btn tj-replay-btn"
                            aria-label="Replay from entry"
                            onClick={(e) => {
                              e.stopPropagation();
                              show(t, true);
                            }}
                          >
                            <Icon name="replay-status" size={18} />
                          </button>
                        </Tooltip>
                      </Show>
                    </span>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
      </div>

      <Show when={menu()}>
        {(m) => {
          let anchor!: HTMLDivElement;
          // Read once: the menu's accessors go stale when it closes.
          const { x, y, trade, group } = m();
          const list = trade && picked().has(trade.id) && picked().size > 1 ? pickedTrades() : [];
          const run = (fn: () => void) => () => {
            setMenu(null);
            fn();
          };
          return (
            <>
              <div ref={anchor} class="tj-menu-anchor" style={{ left: `${x}px`, top: `${y}px` }} />
              <Popover anchor={anchor} onClose={() => setMenu(null)} class="st-tab-menu">
                <Show when={trade}>{(t) => <PopItem title="Share trade to Community…" onClick={run(() => void shareTrade(t()))} />}</Show>
                <Show when={list.length > 0}>
                  <PopItem title={`Share ${tradesText(list.length)} to Community…`} onClick={run(() => shareList(list))} />
                </Show>
                <Show when={group}>{(g) => <PopItem title={`Share ${g().label} to Community…`} onClick={run(() => shareList(g().trades, g().label))} />}</Show>
              </Popover>
            </>
          );
        }}
      </Show>
    </div>
  );
}
