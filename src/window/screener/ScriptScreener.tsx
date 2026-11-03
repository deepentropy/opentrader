/*
 * ScriptScreener: one indicator of the Indicators dialog run over a list of
 * symbols (an index of the live table or a watchlist), read on the newest
 * daily, weekly or monthly bar. The layout follows the reference app's
 * script screener:
 *   toolbar: symbol source pill · indicator | interval | Settings block ·
 *   divider · one pill per filter · Add new filter (+) · Reset options (…) ·
 *   Scan (Stop while scanning);
 *   table: Symbol (with the row count) · one column per output · Manage
 *   columns; a header click opens Sort ascending / descending, Move right,
 *   Move to the end, Remove.
 * A new indicator starts with one pill per output (up to ten) and its line
 * plots as columns. Scans are manual. Filters, sort and columns apply to the
 * scanned rows at once; a change of source, indicator, inputs or interval
 * asks for a rescan ("Rescan to update the results").
 * Beyond the reference: signal columns (alert conditions and the marks the
 * indicator draws) read as "bars since it happened", with a "True within"
 * filter, and the session in progress counts as the newest bar.
 * Rows: a click picks the symbol on the chart; the right-click menu flags it,
 * unflags every symbol or adds it to the active watchlist; the magnifier of
 * the Symbol header searches the rows. Shift+F: Add new filter, Shift+C:
 * Manage columns. Intraday intervals scan INTRADAY_MAX_SYMBOLS symbols at most.
 */
import { For, Show, batch, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import type { IndicatorRegistryEntry } from "lightweight-charts-indicators";
import { Icon } from "../../components/Icon";
import { showConfirm } from "../../components/Dialogs";
import * as kv from "../../data/kv";
import { FLAG_HEX, FLAG_SORT_ORDER, type FlagColor } from "../../data/watchlist";
import { isDeletedList, watchlistStore, type WatchList } from "../../data/watchlist-store";
import { INDEXES } from "../../data/screener-catalog";
import { allFlags, clearAllFlags, lastFlagColor, setFlag } from "../../data/symbol-flags";
import {
  OP_ICON,
  OP_LABEL,
  PRICE_TARGETS,
  INTRADAY_MAX_SYMBOLS,
  SCRIPT_INTERVALS,
  SIGNAL_OPS,
  SYMBOL_KEY,
  VALUE_OPS,
  bareTicker,
  declaredColumns,
  filterComplete,
  intradayMinutes,
  screenRows,
  type ScriptColumn,
  type ScriptFilter,
  type ScriptOp,
  type ScriptRow,
} from "../../data/script-screen";
import { indexTickers, runScriptScan, tickerNames } from "../../data/script-screener";
import { onScreenerUpdate } from "../../data/screener-api";
import { scriptScreenStore, type ScriptScreen, type ScriptSource } from "../../data/script-screen-store";
import { getIndicatorEntry, indicatorName, isLibraryIndicatorId, loadIndicatorLibrary } from "../chart/indicators/registry";
import { isUserIndicatorId } from "../chart/indicators/user-scripts";
import { ChartContextMenu, type CtxNode } from "../chart/ChartContextMenu";
import { CheckBox, SelectControl } from "../header/ChartPropertiesDialog";
import { defaultIndicatorOptions } from "../chart/indicators/indicator-options";
import { IndicatorsDialog } from "../header/IndicatorsDialog";
import { IndicatorSettingsDialog } from "../chart/IndicatorSettingsDialog";
import { PopDivider, PopItem, PopSearch, PopSectionTitle, Popover, SelectButton } from "./Popover";
import { ValueInput } from "./FilterEditor";

/** Pills a new indicator starts with (the reference: its first ten outputs). */
const MAX_PILLS = 10;
const ROW_H = 41;
const OVERSCAN = 8;
const SYMBOL_W = 300;
const COL_W = 150;
const SETUP_W = 45;
const REPLACE_ASK_KEY = "ot:screener:script:replace-ask";
const NOT_SUPPORTED = "Not supported in Script Screener";

type Props = {
  /** Same callback as the watchlist row pick (sets the chart symbol). */
  onSymbolPicked: (ticker: string) => void;
  flagOf: (ticker: string) => FlagColor | null;
  /** Rows shown (filtered, sorted), for the panel's title menu (CSV, save as watchlist). */
  onShownRows?: (rows: () => ScriptRow[], columns: () => ScriptColumn[], names: () => ReadonlyMap<string, string>) => void;
};

/** The screener can run an indicator of the library or one of the user's OakScript indicators that draws something
 *  it can read (plots, conditions, marks) and does not depend on the chart's visible range. Strategies cannot. */
export function scriptScreenerSupports(id: string): boolean {
  const user = isUserIndicatorId(id);
  if (!user && !isLibraryIndicatorId(id)) return false;
  const e = getIndicatorEntry(id);
  if (!e) return !user;
  if (e.usesVisibleRange) return false;
  return (e.plotConfig?.length ?? 0) > 0 || (e.alertConditions?.length ?? 0) > 0;
}

const newFilterId = () => `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

/** A pill of a column, not set: a value's "Above" with no value yet, a signal's with no operation. */
const blankFilter = (c: Pick<ScriptColumn, "key" | "kind"> | undefined, key: string, id = newFilterId()): ScriptFilter => ({
  id,
  key,
  op: c?.kind === "signal" ? null : "above",
  value: null,
});

/** Plots an indicator keeps out of view (display none): not a column or a pill unless asked for. */
function hiddenPlots(e: IndicatorRegistryEntry | undefined): Set<string> {
  return new Set((e?.plotConfig ?? []).filter((p) => (p as { display?: string }).display === "none").map((p) => `out:${p.id}`));
}

/** The pills of a new indicator: one per output, up to ten, not set. */
function initialFilters(e: IndicatorRegistryEntry | undefined, cols: ScriptColumn[]): ScriptFilter[] {
  const hidden = hiddenPlots(e);
  return cols.filter((c) => !hidden.has(c.key)).slice(0, MAX_PILLS).map((c) => blankFilter(c, c.key));
}

const numberFmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** A filter value as typed ("300", "0.5"). */
const valueFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });
function cellText(col: ScriptColumn, v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (col.kind === "signal") return v === 0 ? "Last bar" : v === 1 ? "1 bar ago" : `${v} bars ago`;
  return numberFmt.format(v);
}

export function ScriptScreener(props: Props) {
  const screen = scriptScreenStore.screen;
  const update = (fn: (s: ScriptScreen) => ScriptScreen) => scriptScreenStore.update(fn);

  // ── Indicator ──
  void loadIndicatorLibrary();
  const entry = createMemo<IndicatorRegistryEntry | undefined>(() => {
    const id = screen().indicatorId;
    return id ? getIndicatorEntry(id) : undefined;
  });
  const inputs = createMemo(() => ({ ...(entry()?.defaultInputs ?? {}), ...screen().inputs }));
  const indicatorTitle = () => {
    const id = screen().indicatorId;
    return id ? entry()?.name ?? indicatorName(id) ?? id : "Add indicator";
  };

  // ── Columns: declared outputs, then the marks met by the scans ──
  const [marks, setMarks] = createSignal<ScriptColumn[]>([]);
  const declared = createMemo(() => {
    const e = entry();
    return e ? declaredColumns(e, inputs()) : [];
  });
  const allColumns = createMemo(() => [...declared(), ...marks().filter((m) => !declared().some((d) => d.key === m.key))]);
  const columnByKey = createMemo(() => new Map(allColumns().map((c) => [c.key, c])));
  /** Line plots shown by default (shapes, conditions and marks are offered in Manage columns). */
  const defaultColumns = createMemo(() => {
    const hidden = hiddenPlots(entry());
    const plots = new Set((entry()?.plotConfig ?? []).map((p) => `out:${p.id}`).filter((k) => !hidden.has(k)));
    return declared().filter((c) => plots.has(c.key)).map((c) => c.key);
  });
  const visible = createMemo(() => (screen().columns ?? defaultColumns()).map((k) => columnByKey().get(k)).filter((c): c is ScriptColumn => !!c));
  /** Plot colour of a value column (its first colour), as the reference draws the values. */
  const colorOf = (key: string): string | undefined => {
    const p = (entry()?.plotConfig ?? []).find((x) => `out:${x.id}` === key) as { color?: string } | undefined;
    return typeof p?.color === "string" ? p.color : undefined;
  };

  // ── Symbols of the source ──
  const [symbols, setSymbols] = createSignal<string[]>([]);
  const [names, setNames] = createSignal<Map<string, string>>(new Map());
  const watchlistSymbols = (id: string): string[] | null => {
    const l = watchlistStore.lists().find((x) => x.id === id);
    if (!l) return null;
    return [...new Set([...l.groups.flatMap((g) => g.rows), ...l.extras].map((r) => r.ticker))];
  };
  const sourceKey = () => JSON.stringify(screen().source);
  const loadSource = () => {
    const src = screen().source;
    const load = src.kind === "index" ? indexTickers(src.code) : Promise.resolve(watchlistSymbols(src.id) ?? []);
    void load
      .then(async (list) => {
        setSymbols(list);
        setNames(await tickerNames(list).catch(() => new Map<string, string>()));
      })
      .catch((e) => console.warn("[script-screener] source failed", e));
  };
  createEffect(
    on(() => [sourceKey(), screen().source.kind === "watchlist" ? watchlistSymbols((screen().source as { id: string }).id)?.join(",") : ""], loadSource),
  );
  // The live table loads after the panel opens: an index (and the names) are read again once it is there.
  let offUpdate: (() => void) | null = null;
  let disposed = false;
  void onScreenerUpdate(() => {
    if (!symbols().length || !names().size) loadSource();
  }).then((off) => (disposed ? off() : (offUpdate = off)));
  onCleanup(() => {
    disposed = true;
    offUpdate?.();
  });

  // ── Scan ──
  /** The interval the indicator runs on: its own calculation timeframe, else the screener's. */
  const runInterval = () => screen().calcInterval ?? screen().interval;
  const overCap = () => intradayMinutes(runInterval()) !== null && symbols().length > INTRADAY_MAX_SYMBOLS;
  const [results, setResults] = createSignal<Map<string, ScriptRow>>(new Map());
  const [scanning, setScanning] = createSignal(false);
  const [progress, setProgress] = createSignal({ done: 0, total: 0 });
  const [toast, setToast] = createSignal<"done" | "rescan" | null>(null);
  /** What the shown results were computed for: a change of it asks for a rescan. */
  const scanKey = () => JSON.stringify([screen().indicatorId, screen().inputs, runInterval(), screen().waitClose, screen().source]);
  const [resultsKey, setResultsKey] = createSignal<string | null>(null);
  let gen = 0;
  let toastTimer: number | undefined;
  const showToast = (t: "done" | "rescan" | null) => {
    window.clearTimeout(toastTimer);
    setToast(t);
    if (t === "done") toastTimer = window.setTimeout(() => setToast((x) => (x === "done" ? null : x)), 3000);
  };
  onCleanup(() => {
    gen++;
    window.clearTimeout(toastTimer);
  });

  const scan = async () => {
    const e = entry();
    if (!e || scanning() || overCap()) return;
    const my = ++gen;
    const list = symbols();
    const key = scanKey();
    batch(() => {
      setScanning(true);
      setProgress({ done: 0, total: list.length });
      setMarks([]);
      showToast(null);
    });
    const next = new Map<string, ScriptRow>();
    let pending: ScriptRow[] = [];
    let flushTimer: number | undefined;
    const flush = () => {
      flushTimer = undefined;
      if (my !== gen) return;
      for (const r of pending) next.set(r.symbol, r);
      pending = [];
      batch(() => {
        setResults(new Map(next));
        setProgress({ done: next.size, total: list.length });
      });
    };
    setResults(new Map());
    setResultsKey(key);
    try {
      await runScriptScan(
        { entry: e, inputs: inputs(), interval: runInterval(), closedOnly: screen().waitClose, symbols: list },
        {
          wanted: () => my === gen,
          onRow: (row) => {
            pending.push(row);
            flushTimer ??= window.setTimeout(flush, 100);
          },
          onMark: (k, title) => {
            if (!marks().some((m) => m.key === k)) setMarks([...marks(), { key: k, title, kind: "signal" }]);
          },
        },
      );
    } finally {
      if (my === gen) {
        window.clearTimeout(flushTimer);
        flush();
        setScanning(false);
        showToast("done");
      }
    }
  };
  const stop = () => {
    gen++;
    setScanning(false);
  };
  // A change of what the results were computed for asks for a rescan.
  createEffect(
    on(scanKey, (k) => {
      const done = resultsKey();
      if (done !== null && done !== k && !scanning()) showToast("rescan");
      else if (done === k && toast() === "rescan") showToast(null);
    }, { defer: true }),
  );

  // ── Rows shown ──
  const [search, setSearch] = createSignal<string | null>(null);
  const rows = createMemo<ScriptRow[]>(() => {
    const res = results();
    const q = search()?.trim().toUpperCase() ?? "";
    const hit = (s: string) => !q || bareTicker(s).toUpperCase().includes(q) || (names().get(bareTicker(s)) ?? "").toUpperCase().includes(q);
    const all = symbols().filter(hit).map((s) => res.get(s) ?? { symbol: s, cells: {} });
    const sort = screen().sort ?? { key: SYMBOL_KEY, order: "asc" as const };
    return screenRows(all, screen().filters, sort);
  });
  props.onShownRows?.(rows, visible, names);

  // ── Indicator picking ──
  const [pickerOpen, setPickerOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const setIndicator = (id: string) => {
    const apply = () => {
      const e = getIndicatorEntry(id);
      const cols = e ? declaredColumns(e, e.defaultInputs) : [];
      gen++;
      batch(() => {
        setScanning(false);
        setResults(new Map());
        setResultsKey(null);
        setMarks([]);
        showToast(null);
        update((s) => ({ ...s, indicatorId: id, inputs: {}, filters: initialFilters(e, cols), columns: null, sort: null }));
      });
    };
    setPickerOpen(false);
    const cur = screen().indicatorId;
    if (!cur || cur === id || kv.getItem(REPLACE_ASK_KEY) === "0") {
      if (cur !== id) apply();
      return;
    }
    const [dontAsk, setDontAsk] = createSignal(false);
    showConfirm({
      title: "Replace indicator?",
      text: `You're about to replace "${indicatorTitle()}" with another indicator. This will clear all current filters and columns.`,
      mainText: "Replace",
      cancelText: "Cancel",
      intent: "neutral",
      doNotShow: { label: "Don't show again", checked: dontAsk, onChange: setDontAsk },
      onConfirm: () => {
        if (dontAsk()) kv.setItem(REPLACE_ASK_KEY, "0");
        apply();
      },
    });
  };
  // "CALCULATION" rows of the Settings dialog: a draft committed with Apply.
  const [calcDraft, setCalcDraft] = createSignal<{ interval: string; waitClose: boolean }>({ interval: "", waitClose: false });
  const openSettings = () => {
    setCalcDraft({ interval: screen().calcInterval ?? "", waitClose: screen().waitClose });
    setSettingsOpen(true);
  };
  const intervalLabel = (id: string) => (id ? SCRIPT_INTERVALS.find((i) => i.id === id)?.label ?? id : "Script Screener");
  const calculationRows = () => (
    <>
      <div class="cp3-section ind3-group">Calculation</div>
      <div class="cp3-cell cp3-label"><div class="cp3-label-inner"><span class="cp3-title">Timeframe</span></div></div>
      <div class="cp3-cell cp3-controls">
        <SelectControl
          value={calcDraft().interval}
          options={["", ...SCRIPT_INTERVALS.map((i) => i.id)]}
          width={160}
          labelOf={intervalLabel}
          display={intervalLabel(calcDraft().interval)}
          onPick={(v) => setCalcDraft({ ...calcDraft(), interval: v })}
        />
      </div>
      <div class="cp3-cell cp3-label is-full ind3-check-row">
        <div class="cp3-label-inner">
          <CheckBox checked={calcDraft().waitClose} onToggle={() => setCalcDraft({ ...calcDraft(), waitClose: !calcDraft().waitClose })} />
          <span class="cp3-title" onClick={() => setCalcDraft({ ...calcDraft(), waitClose: !calcDraft().waitClose })}>Wait for timeframe closes</span>
        </div>
      </div>
    </>
  );

  // ── Source pill ──
  let sourceBtn!: HTMLDivElement;
  const [sourceOpen, setSourceOpen] = createSignal(false);
  const [sourceTab, setSourceTab] = createSignal<"watchlist" | "index">(screen().source.kind);
  const [sourceQuery, setSourceQuery] = createSignal("");
  const sourceTitle = () => {
    const src = screen().source;
    if (src.kind === "index") return INDEXES.find(([c]) => c === src.code)?.[1] ?? src.code;
    return watchlistStore.lists().find((l) => l.id === src.id)?.name ?? "Watchlist";
  };
  const sourceFlag = (): FlagColor | null => {
    const src = screen().source;
    return src.kind === "watchlist" ? watchlistStore.lists().find((l) => l.id === src.id)?.flag ?? null : null;
  };
  const watchlists = () => {
    const isColor = (l: WatchList) => l.id.startsWith("color-");
    const size = (l: WatchList) => l.extras.length + l.groups.reduce((n, g) => n + g.rows.length, 0);
    const at = (l: WatchList) => FLAG_SORT_ORDER.indexOf(l.flag!);
    const all = watchlistStore.lists();
    const q = sourceQuery().trim().toLowerCase();
    return [
      ...all.filter((l) => isColor(l) && size(l) > 0).sort((a, b) => at(a) - at(b)),
      ...all.filter((l) => !isColor(l) && !isDeletedList(l.id)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
    ]
      .filter((l) => !q || l.name.toLowerCase().includes(q))
      .map((l) => ({ list: l, count: size(l) }));
  };
  const indexes = () => {
    const q = sourceQuery().trim().toLowerCase();
    return INDEXES.filter(([c, n]) => !q || c.toLowerCase().includes(q) || n.toLowerCase().includes(q));
  };
  const setSource = (src: ScriptSource) => {
    setSourceOpen(false);
    update((s) => ({ ...s, source: src }));
  };

  // ── Interval menu ──
  let intervalBtn!: HTMLButtonElement;
  const [intervalOpen, setIntervalOpen] = createSignal(false);

  // ── Filter pills ──
  const [openFilter, setOpenFilter] = createSignal<string | null>(null);
  const pillEls = new Map<string, HTMLElement>();
  const filterIds = createMemo(
    () => screen().filters.map((f) => f.id),
    [],
    { equals: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]) },
  );
  const filterById = (id: string) => screen().filters.find((f) => f.id === id);
  const setFilter = (f: ScriptFilter) => update((s) => ({ ...s, filters: s.filters.map((x) => (x.id === f.id ? f : x)) }));
  const removeFilter = (id: string) => {
    setOpenFilter(null);
    update((s) => ({ ...s, filters: s.filters.filter((x) => x.id !== id) }));
  };
  const resetFilter = (f: ScriptFilter) => setFilter(blankFilter(columnByKey().get(f.key), f.key, f.id));
  const titleOf = (key: string) => columnByKey().get(key)?.title ?? PRICE_TARGETS.find((p) => p.key === key)?.title ?? key;
  /** Pill text of a set filter: "Short MA > 300", "Short MA ↗ Long MA", "Bearish Breakout True". */
  const pillValue = (f: ScriptFilter): string => {
    if (f.op === "true") return "True";
    if (f.op === "trueWithin") return `True within ${f.value} bars`;
    if (f.op === "between" || f.op === "outside") return `${valueFmt.format(f.value as number)} – ${valueFmt.format(f.value2 as number)}`;
    return f.other ? titleOf(f.other) : valueFmt.format(f.value as number);
  };
  let addBtn!: HTMLButtonElement;
  let moreBtn!: HTMLButtonElement;
  const [addOpen, setAddOpen] = createSignal(false);
  const [moreOpen, setMoreOpen] = createSignal(false);
  const addFilter = (c: ScriptColumn) => {
    const f = blankFilter(c, c.key);
    setAddOpen(false);
    update((s) => ({ ...s, filters: [...s.filters, f] }));
    setOpenFilter(f.id);
  };
  const inactiveCount = () => screen().filters.filter((f) => !filterComplete(f)).length;

  // ── Table ──
  let scroller!: HTMLDivElement;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewH, setViewH] = createSignal(600);
  const [selected, setSelected] = createSignal<string | null>(null);
  const [headMenu, setHeadMenu] = createSignal<{ key: string; el: HTMLElement } | null>(null);
  let manageBtn!: HTMLButtonElement;
  const [manageOpen, setManageOpen] = createSignal(false);
  const range = createMemo(() => {
    const n = rows().length;
    const first = Math.max(0, Math.floor(scrollTop() / ROW_H) - OVERSCAN);
    const last = Math.min(n - 1, Math.ceil((scrollTop() + viewH()) / ROW_H) + OVERSCAN);
    return { first, last: Math.max(first - 1, last) };
  });
  const shownRows = createMemo(() => rows().slice(range().first, range().last + 1));
  const setColumns = (fn: (keys: string[]) => string[]) => update((s) => ({ ...s, columns: fn(visible().map((c) => c.key)) }));
  const sortBy = (key: string, order: "asc" | "desc") => update((s) => ({ ...s, sort: { key, order } }));
  const isSorted = (key: string) => (screen().sort ?? { key: SYMBOL_KEY }).key === key;
  const sortOrder = () => screen().sort?.order ?? "asc";

  const pending = (r: ScriptRow) => !r.error && Object.keys(r.cells).length === 0;

  // ── Row menu ──
  const [rowMenu, setRowMenu] = createSignal<{ x: number; y: number; symbol: string } | null>(null);
  /** The flag key of a symbol: the one it is flagged under (a watchlist row's "EXCHANGE:TICKER"), else as listed. */
  const flagKey = (symbol: string) => {
    const t = bareTicker(symbol);
    return Object.keys(allFlags()).find((k) => bareTicker(k) === t) ?? symbol;
  };
  const toggleFlag = (symbol: string) => {
    const t = bareTicker(symbol);
    setFlag(flagKey(symbol), props.flagOf(t) ? null : lastFlagColor());
  };
  const rowMenuNodes = (symbol: string): CtxNode[] => {
    const t = bareTicker(symbol);
    const flagged = !!props.flagOf(t);
    return [
      { kind: "item", id: "flag", label: `${flagged ? "Unflag" : "Flag"} ${t}`, shortcut: "Alt + Enter", onSelect: () => toggleFlag(symbol) },
      { kind: "item", id: "unflag-all", label: "Unflag all symbols", disabled: Object.keys(allFlags()).length === 0, onSelect: () => clearAllFlags() },
      { kind: "separator" },
      {
        kind: "item",
        id: "add",
        label: `Add ${t} to watchlist`,
        disabled: watchlistStore.listHas(watchlistStore.activeId(), symbol) || watchlistStore.listHas(watchlistStore.activeId(), t),
        onSelect: () => watchlistStore.addSymbols([{ ticker: symbol, short: t, last: "—", changePercent: "0.00%", prePostChange: "0.00%", flag: null }], null),
      },
    ];
  };
  // Shift+F: Add new filter; Shift+C: Manage columns; Alt+Enter: flag the selected row (not while typing).
  const onKey = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
    if (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && e.code === "KeyF" && entry()) {
      e.preventDefault();
      setAddOpen(true);
    } else if (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && e.code === "KeyC" && allColumns().length) {
      e.preventDefault();
      setManageOpen(true);
    } else if (e.altKey && e.key === "Enter" && selected()) {
      e.preventDefault();
      toggleFlag(selected()!);
    }
  };
  window.addEventListener("keydown", onKey);
  onCleanup(() => window.removeEventListener("keydown", onKey));

  return (
    <div class="sscr">
      <div class="sscr-toolbar">
        {/* Symbol source */}
        <div ref={sourceBtn} class="scr-pill sscr-source" classList={{ "is-open": sourceOpen() }}>
          <button type="button" class="scr-pill-main" aria-expanded={sourceOpen()} onClick={() => setSourceOpen(!sourceOpen())}>
            <Show when={sourceFlag()} keyed>
              {(fl) => (
                <span class="scr-pill-flag" style={{ color: FLAG_HEX[fl] }}>
                  <Icon name="scr-flag" />
                </span>
              )}
            </Show>
            <span class="scr-pill-value">{sourceTitle()}</span>
            <span class="scr-pill-caret"><Icon name="scr-pill-caret" size={18} /></span>
          </button>
        </div>

        {/* Indicator · interval · settings */}
        <div class="sscr-indicator-block">
          <button type="button" class="sscr-block-btn sscr-indicator-btn" classList={{ "is-empty": !screen().indicatorId }} onClick={() => setPickerOpen(true)}>
            <Show when={!screen().indicatorId}>
              <Icon name="scr-add" size={18} />
            </Show>
            <span>{indicatorTitle()}</span>
          </button>
          <button ref={intervalBtn} type="button" class="sscr-block-btn" classList={{ "is-open": intervalOpen() }} title="Interval" onClick={() => setIntervalOpen(!intervalOpen())}>
            {SCRIPT_INTERVALS.find((i) => i.id === screen().interval)?.short ?? screen().interval}
          </button>
          <button
            type="button"
            class="sscr-block-btn is-icon"
            title="Settings"
            aria-label="Settings"
            disabled={!entry()}
            onClick={openSettings}
          >
            <Icon name="sscr-settings" size={18} />
          </button>
        </div>

        <div class="scr-pills-divider" />

        {/* Filters */}
        <For each={filterIds()}>
          {(id) => {
            const f = () => filterById(id)!;
            const active = () => !!filterById(id) && filterComplete(f());
            return (
              <Show when={filterById(id)}>
                <div ref={(el) => pillEls.set(id, el)} class="scr-pill" classList={{ "is-active": active(), "is-open": openFilter() === id }}>
                  <button type="button" class="scr-pill-main" aria-expanded={openFilter() === id} onClick={() => setOpenFilter(openFilter() === id ? null : id)}>
                    <span class="scr-pill-text">{titleOf(f().key)}</span>
                    <Show when={active()}>
                      <Show when={f().op && OP_ICON[f().op!]}>
                        {(icon) => (
                          <span class="scr-pill-icon">
                            <Icon name={`scr-op-${icon()}`} size={18} />
                          </span>
                        )}
                      </Show>
                      <span class="scr-pill-end">
                        <span class="scr-pill-value">{pillValue(f())}</span>
                      </span>
                    </Show>
                    <Show when={!active()}>
                      <span class="scr-pill-caret"><Icon name="scr-pill-caret" size={18} /></span>
                    </Show>
                  </button>
                  <Show when={active()}>
                    <button type="button" class="scr-pill-x" aria-label={`Reset ${titleOf(f().key)}`} onClick={() => resetFilter(f())}>
                      <Icon name="scr-pill-remove" size={18} />
                    </button>
                  </Show>
                </div>
              </Show>
            );
          }}
        </For>
        <button
          ref={addBtn}
          type="button"
          class="scr-light-btn scr-light-btn--secondary is-icon-only"
          classList={{ "is-open": addOpen() }}
          title="Add new filter"
          aria-label="Add new filter"
          disabled={!entry()}
          onClick={() => setAddOpen(!addOpen())}
        >
          <Icon name="scr-add" size={28} />
        </button>
        <button
          ref={moreBtn}
          type="button"
          class="scr-light-btn scr-light-btn--ghost is-icon-only"
          classList={{ "is-open": moreOpen() }}
          title="Reset options"
          aria-label="Reset options"
          disabled={!screen().filters.length}
          onClick={() => setMoreOpen(!moreOpen())}
        >
          <Icon name="scr-more" size={28} />
        </button>
        <button
          type="button"
          class="scr-light-btn sscr-scan-btn"
          disabled={!entry() || (!scanning() && (!symbols().length || overCap()))}
          onClick={() => (scanning() ? stop() : void scan())}
        >
          <Icon name={scanning() ? "sscr-stop" : "sscr-scan"} size={18} />
          <span class="scr-light-btn-text">{scanning() ? "Stop" : "Scan"}</span>
        </button>
        <Show when={!scanning() && overCap()}>
          <span class="sscr-progress">Intraday intervals scan up to {INTRADAY_MAX_SYMBOLS} symbols</span>
        </Show>
        <Show when={scanning()}>
          <span class="sscr-progress" role="status">
            {progress().done} / {progress().total}
          </span>
        </Show>
      </div>

      {/* Results */}
      <div
        class="scr-table-scroll sscr-table-scroll"
        ref={(el) => {
          scroller = el;
          const ro = new ResizeObserver(() => setViewH(el.clientHeight));
          ro.observe(el);
          onCleanup(() => ro.disconnect());
        }}
        onScroll={() => setScrollTop(scroller.scrollTop)}
      >
        <table class="scr-table" classList={{ "is-scanning": scanning() }} style={{ width: `max(${SYMBOL_W + visible().length * COL_W + SETUP_W}px, 100%)` }}>
          <colgroup>
            <col style={{ width: `${SYMBOL_W}px` }} />
            <For each={visible()}>{() => <col style={{ width: `${COL_W}px` }} />}</For>
            <col />
          </colgroup>
          <thead>
            <tr>
              <th
                class="scr-th scr-th-symbol"
                classList={{ "is-sorted": isSorted(SYMBOL_KEY), "is-menu": headMenu()?.key === SYMBOL_KEY }}
                onClick={(e) => search() === null && setHeadMenu({ key: SYMBOL_KEY, el: e.currentTarget })}
              >
                <div class="scr-th-wrap sscr-th-symbol" title="Symbol">
                  <button
                    type="button"
                    class="sscr-search-btn"
                    classList={{ "is-active": search() !== null }}
                    title="Search"
                    aria-label="Search"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSearch(search() === null ? "" : null);
                    }}
                  >
                    <Icon name="scr-search" size={18} />
                  </button>
                  <Show
                    when={search() === null}
                    fallback={
                      <>
                      <input
                        class="sscr-search-input"
                        placeholder="Search"
                        value={search() ?? ""}
                        ref={(el) => queueMicrotask(() => el.focus())}
                        onClick={(e) => e.stopPropagation()}
                        onInput={(e) => setSearch(e.currentTarget.value)}
                        onKeyDown={(e) => e.key === "Escape" && setSearch(null)}
                      />
                      <span class="scr-th-count">{rows().length}</span>
                      </>
                    }
                  >
                  <div class="scr-th-symbol-data">
                    <div class="scr-th-upper">Symbol</div>
                    <Show when={isSorted(SYMBOL_KEY)}>
                      <span class="scr-sort-btn is-active" classList={{ "is-asc": sortOrder() === "asc" }}>
                        <Icon name="scr-sort-active" size={18} />
                      </span>
                    </Show>
                    <span class="scr-th-count">{rows().length}</span>
                  </div>
                  </Show>
                </div>
              </th>
              <For each={visible()}>
                {(c) => (
                  <th
                    class="scr-th is-right"
                    classList={{ "is-sorted": isSorted(c.key), "is-menu": headMenu()?.key === c.key }}
                    onClick={(e) => setHeadMenu({ key: c.key, el: e.currentTarget })}
                  >
                    <div class="scr-th-wrap" title={c.title}>
                      <Show when={isSorted(c.key)}>
                        <span class="scr-sort-btn is-active" classList={{ "is-asc": sortOrder() === "asc" }}>
                          <Icon name="scr-sort-active" size={18} />
                        </span>
                      </Show>
                      <div class="scr-th-title">
                        <div class="scr-th-upper">{c.title}</div>
                      </div>
                    </div>
                  </th>
                )}
              </For>
              <th class="scr-th scr-th-setup">
                <button
                  ref={manageBtn}
                  type="button"
                  class="scr-setup-btn"
                  classList={{ "is-open": manageOpen() }}
                  title="Manage columns"
                  aria-label="Manage columns"
                  disabled={!allColumns().length}
                  onClick={() => setManageOpen(!manageOpen())}
                >
                  <Icon name="sscr-columns" size={28} />
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr class="scr-spacer" style={{ height: `${range().first * ROW_H}px` }} />
            <For each={shownRows()}>
              {(r) => {
                const ticker = bareTicker(r.symbol);
                const flag = () => props.flagOf(ticker);
                return (
                  <tr
                    class="scr-tr"
                    classList={{ "is-selected": selected() === r.symbol, "is-pending": scanning() && pending(r) }}
                    onClick={() => {
                      setSelected(r.symbol);
                      props.onSymbolPicked(ticker);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setSelected(r.symbol);
                      setRowMenu({ x: e.clientX, y: e.clientY, symbol: r.symbol });
                    }}
                  >
                    <td class="scr-td scr-td-symbol">
                      <span class="scr-ticker-cell">
                        <Show when={flag()} keyed>
                          {(fl) => (
                            <span class="scr-row-flag" style={{ color: FLAG_HEX[fl] }}>
                              <Icon name="scr-flag" />
                            </span>
                          )}
                        </Show>
                        <span class="ot-ticker-logo ot-ticker-logo--md scr-row-logo" aria-hidden="true">{ticker.charAt(0)}</span>
                        <span class="scr-ticker-chip">{ticker}</span>
                        <span class="sscr-name" title={r.error ?? names().get(ticker)}>
                          {r.error ? r.error : names().get(ticker) ?? ""}
                        </span>
                      </span>
                    </td>
                    <For each={visible()}>
                      {(c) => (
                        <td class="scr-td is-right">
                          <span style={{ color: c.kind === "value" && r.cells[c.key]?.value != null ? colorOf(c.key) : undefined }}>
                            {cellText(c, r.cells[c.key]?.value)}
                          </span>
                        </td>
                      )}
                    </For>
                    <td class="scr-td" />
                  </tr>
                );
              }}
            </For>
            <tr class="scr-spacer" style={{ height: `${Math.max(0, rows().length - range().last - 1) * ROW_H}px` }} />
          </tbody>
        </table>
        <Show when={!screen().indicatorId}>
          <div class="scr-empty">Add an indicator to scan the symbols</div>
        </Show>
        <Show when={screen().indicatorId && resultsKey() !== null && !scanning() && rows().length === 0}>
          <div class="scr-empty">No symbols match your filters</div>
        </Show>
      </div>

      {/* Toasts */}
      <Show when={toast()}>
        <div class="sscr-toast" role="status">
          <Show
            when={toast() === "rescan"}
            fallback={
              <>
                <Icon name="scr-check" size={18} />
                <span>Scan completed</span>
              </>
            }
          >
            <span>Rescan to update the results</span>
            <button type="button" class="sscr-toast-btn" onClick={() => void scan()}>
              Rescan
            </button>
            <button type="button" class="sscr-toast-x" aria-label="Close" onClick={() => showToast(null)}>
              <Icon name="scr-pill-remove" size={18} />
            </button>
          </Show>
        </div>
      </Show>

      {/* Popovers and dialogs */}
      <Show when={sourceOpen()}>
        <Popover anchor={sourceBtn} onClose={() => setSourceOpen(false)} width={300} class="sscr-source-pop">
          <div class="scr-editor-header"><div class="scr-editor-title">Symbol source</div></div>
          <div class="sscr-tabs" role="tablist">
            <button type="button" role="tab" class="sscr-tab" classList={{ "is-active": sourceTab() === "watchlist" }} onClick={() => setSourceTab("watchlist")}>
              Watchlist
            </button>
            <button type="button" role="tab" class="sscr-tab" classList={{ "is-active": sourceTab() === "index" }} onClick={() => setSourceTab("index")}>
              Index
            </button>
          </div>
          <PopSearch value={sourceQuery()} onInput={setSourceQuery} autofocus />
          <div class="scr-pop-scroll" role="listbox">
            <Show
              when={sourceTab() === "watchlist"}
              fallback={
                <For each={indexes()}>
                  {([code, name]) => (
                    <PopItem
                      title={`${code} • ${name}`}
                      selected={screen().source.kind === "index" && (screen().source as { code: string }).code === code}
                      onClick={() => setSource({ kind: "index", code })}
                    />
                  )}
                </For>
              }
            >
              <For each={watchlists()}>
                {(w) => (
                  <PopItem
                    title={w.list.name}
                    right={<span class="sscr-count">{w.count}</span>}
                    selected={screen().source.kind === "watchlist" && (screen().source as { id: string }).id === w.list.id}
                    onClick={() => setSource({ kind: "watchlist", id: w.list.id })}
                  />
                )}
              </For>
            </Show>
          </div>
        </Popover>
      </Show>

      <Show when={intervalOpen()}>
        <Popover anchor={intervalBtn} onClose={() => setIntervalOpen(false)} width={180}>
          <PopSectionTitle title="Interval" />
          <For each={SCRIPT_INTERVALS}>
            {(iv) => (
              <PopItem
                title={iv.label}
                selected={screen().interval === iv.id}
                onClick={() => {
                  setIntervalOpen(false);
                  update((s) => ({ ...s, interval: iv.id }));
                }}
              />
            )}
          </For>
        </Popover>
      </Show>

      <Show when={openFilter()} keyed>
        {(id) => (
          <Show when={filterById(id)}>
            <Popover anchor={pillEls.get(id)} onClose={() => setOpenFilter(null)} width={300}>
              <FilterEditor
                filter={filterById(id)!}
                column={columnByKey().get(filterById(id)!.key)}
                valueColumns={allColumns().filter((c) => c.kind === "value" && c.key !== filterById(id)!.key)}
                onChange={setFilter}
                onRemove={() => removeFilter(id)}
                onReset={() => resetFilter(filterById(id)!)}
              />
            </Popover>
          </Show>
        )}
      </Show>

      <Show when={addOpen()}>
        <Popover anchor={addBtn} onClose={() => setAddOpen(false)} width={260}>
          <Show when={allColumns().some((c) => c.kind === "value" || c.key.startsWith("mark:"))}>
            <PopSectionTitle title="Plots" />
            <For each={allColumns().filter((c) => c.kind === "value" || c.key.startsWith("mark:"))}>{(c) => <PopItem title={c.title} onClick={() => addFilter(c)} />}</For>
          </Show>
          <Show when={allColumns().some((c) => c.key.startsWith("cond:"))}>
            <PopSectionTitle title="Alert conditions" />
            <For each={allColumns().filter((c) => c.key.startsWith("cond:"))}>{(c) => <PopItem title={c.title} onClick={() => addFilter(c)} />}</For>
          </Show>
        </Popover>
      </Show>

      <Show when={moreOpen()}>
        <Popover anchor={moreBtn} onClose={() => setMoreOpen(false)} width={260}>
          <PopItem
            title="Reset all filters"
            onClick={() => {
              setMoreOpen(false);
              update((s) => ({ ...s, filters: s.filters.map((f) => blankFilter(columnByKey().get(f.key), f.key, f.id)) }));
            }}
          />
          <PopItem
            title={`Remove ${inactiveCount()} inactive filter${inactiveCount() === 1 ? "" : "s"}`}
            disabled={inactiveCount() === 0}
            onClick={() => {
              setMoreOpen(false);
              update((s) => ({ ...s, filters: s.filters.filter(filterComplete) }));
            }}
          />
          <PopItem
            title="Remove all filters"
            onClick={() => {
              setMoreOpen(false);
              update((s) => ({ ...s, filters: [] }));
            }}
          />
        </Popover>
      </Show>

      <Show when={manageOpen()}>
        <Popover anchor={manageBtn} onClose={() => setManageOpen(false)} width={280}>
          <PopSectionTitle title="Manage columns" />
          <div class="scr-pop-scroll">
            <For each={allColumns()}>
              {(c) => {
                const on = () => visible().some((v) => v.key === c.key);
                return (
                  <div
                    class="scr-item"
                    role="menuitemcheckbox"
                    aria-checked={on()}
                    onClick={() => setColumns((keys) => (on() ? keys.filter((k) => k !== c.key) : [...keys, c.key]))}
                  >
                    <span class="scr-checkbox" classList={{ "is-checked": on() }}>
                      <Show when={on()}>
                        <Icon name="scr-check" size={18} />
                      </Show>
                    </span>
                    <span class="scr-item-text">
                      <span class="scr-item-title">{c.title}</span>
                    </span>
                  </div>
                );
              }}
            </For>
          </div>
        </Popover>
      </Show>

      <Show when={headMenu()} keyed>
        {(m) => {
          const keys = () => visible().map((c) => c.key);
          const at = () => keys().indexOf(m.key);
          const close = () => setHeadMenu(null);
          return (
            <Popover anchor={m.el} onClose={close} width={240}>
              <PopItem title="Sort ascending" icon="scr-menu-sort-asc" selected={isSorted(m.key) && sortOrder() === "asc"} onClick={() => { close(); sortBy(m.key, "asc"); }} />
              <PopItem title="Sort descending" icon="scr-menu-sort-desc" selected={isSorted(m.key) && sortOrder() === "desc"} onClick={() => { close(); sortBy(m.key, "desc"); }} />
              <Show when={m.key !== SYMBOL_KEY}>
                <PopDivider />
                <Show when={at() < keys().length - 1}>
                  <PopItem
                    title="Move right"
                    icon="scr-menu-move-right"
                    onClick={() => {
                      close();
                      setColumns((k) => {
                        const i = k.indexOf(m.key);
                        [k[i], k[i + 1]] = [k[i + 1], k[i]];
                        return k;
                      });
                    }}
                  />
                  <PopItem title="Move to the end" icon="scr-menu-move-end" onClick={() => { close(); setColumns((k) => [...k.filter((x) => x !== m.key), m.key]); }} />
                </Show>
                <PopItem title="Remove" icon="scr-trash" onClick={() => { close(); setColumns((k) => k.filter((x) => x !== m.key)); }} />
              </Show>
            </Popover>
          );
        }}
      </Show>

      <Show when={rowMenu()} keyed>
        {(m) => <ChartContextMenu x={m.x} y={m.y} nodes={rowMenuNodes(m.symbol)} onClose={() => setRowMenu(null)} />}
      </Show>

      <Show when={pickerOpen()}>
        <IndicatorsDialog
          title="Indicators"
          supported={scriptScreenerSupports}
          unsupportedText={NOT_SUPPORTED}
          onAddIndicator={setIndicator}
          onClose={() => setPickerOpen(false)}
        />
      </Show>

      <Show when={settingsOpen() && entry()} keyed>
        {(e) => (
          <IndicatorSettingsDialog
            title={e.name}
            inputsOnly
            extraRows={calculationRows}
            onOk={() => {
              const d = calcDraft();
              update((s) => ({ ...s, calcInterval: (d.interval || null) as ScriptScreen["calcInterval"], waitClose: d.waitClose }));
            }}
            inputConfig={e.inputConfig}
            plotConfig={e.plotConfig}
            inputs={inputs()}
            styles={{}}
            options={defaultIndicatorOptions()}
            onApply={({ inputs: next }) => {
              // Only the inputs changed from the defaults are kept.
              const changed: Record<string, unknown> = {};
              for (const [k, v] of Object.entries(next)) if (JSON.stringify(v) !== JSON.stringify(e.defaultInputs[k])) changed[k] = v;
              update((s) => ({ ...s, inputs: changed }));
            }}
            onSaveAsDefault={() => {}}
            onClose={() => setSettingsOpen(false)}
          />
        )}
      </Show>
    </div>
  );
}

/** The filter popover of a pill: title, Reset and remove, the condition, the right side. */
function FilterEditor(props: {
  filter: ScriptFilter;
  column: ScriptColumn | undefined;
  /** The other value columns a value can be compared with. */
  valueColumns: ScriptColumn[];
  onChange: (f: ScriptFilter) => void;
  onRemove: () => void;
  onReset: () => void;
}) {
  const f = () => props.filter;
  const signal = () => props.column?.kind === "signal";
  const ops = (): ScriptOp[] => (signal() ? SIGNAL_OPS : VALUE_OPS);
  const range = () => f().op === "between" || f().op === "outside";
  const targets = () => [
    { value: "value", label: "Value" },
    ...PRICE_TARGETS.map((p, i) => ({ value: p.key, label: p.title, divider: i === 0 })),
    ...props.valueColumns.map((c, i) => ({ value: c.key, label: c.title, divider: i === 0 })),
  ];
  const targetLabel = () => (f().other ? targets().find((t) => t.value === f().other)?.label ?? f().other! : "Value");
  const setOp = (op: string) => {
    const next = op as ScriptOp;
    const wantRange = next === "between" || next === "outside";
    props.onChange({ ...f(), op: next, ...(wantRange ? { other: undefined } : {}), ...(next === "true" ? { value: null } : {}) });
  };
  return (
    <div class="scr-editor sscr-editor">
      <div class="scr-editor-header">
        <div class="scr-editor-title">{props.column?.title ?? f().key}</div>
        <div class="scr-editor-tools" role="toolbar">
          <button type="button" class="scr-text-btn" classList={{ "is-hidden": !filterComplete(f()) }} onClick={props.onReset}>
            Reset
          </button>
          <span class="scr-editor-tools-divider" classList={{ "is-hidden": !filterComplete(f()) }} />
          <button type="button" class="scr-text-btn scr-icon-only" aria-label="Remove" onClick={props.onRemove}>
            <Icon name="scr-trash" size={18} />
          </button>
        </div>
      </div>
      <div class="scr-manual">
        <SelectButton
          class="scr-select--stretch"
          label={f().op ? OP_LABEL[f().op!] : "Select condition"}
          options={ops().map((o) => ({ value: o, label: OP_LABEL[o], icon: OP_ICON[o] ? `scr-op-lg-${OP_ICON[o]}` : undefined }))}
          value={f().op ?? ""}
          onChange={setOp}
        />
        <Show when={f().op === "trueWithin"}>
          <ValueInput value={f().value ?? null} placeholder="Bars" unit="bars" onValue={(v) => props.onChange({ ...f(), value: v === null ? null : Math.max(0, Math.round(v)) })} />
        </Show>
        <Show when={!signal()}>
          <Show when={!range()}>
            <SelectButton
              label={targetLabel()}
              options={targets()}
              value={f().other ?? "value"}
              onChange={(t) => props.onChange({ ...f(), other: t === "value" ? undefined : t })}
            />
          </Show>
          <Show
            when={range()}
            fallback={
              <Show when={!f().other}>
                <ValueInput value={f().value ?? null} placeholder="Enter value" unit={null} onValue={(v) => props.onChange({ ...f(), value: v })} />
              </Show>
            }
          >
            <div class="scr-range-values">
              <ValueInput value={f().value ?? null} placeholder="From" unit={null} onValue={(v) => props.onChange({ ...f(), value: v })} />
              <ValueInput value={f().value2 ?? null} placeholder="To" unit={null} onValue={(v) => props.onChange({ ...f(), value2: v })} />
            </div>
          </Show>
        </Show>
      </div>
    </div>
  );
}
