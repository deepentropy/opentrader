/*
 * AddColumnDialog — "Add column…" of the watchlist settings menu and of a column header's menu (not in the reference
 * watchlist). The Indicators dialog's frame, search, sidebar and rows:
 *  - Metrics: the Screener's columns by category, values of its market table (US stocks and ETFs; other symbols
 *    show "—"). A row adds its column; a metric with a choice (10D / 30D, 1h / 4h...) shows the choices as buttons,
 *    as the Fundamentals periods of the Indicators dialog, each adding that column.
 *  - Indicators: the built-ins and the user's scripts the Script Screener can run, computed on each symbol's bars on
 *    a timeframe (any symbol with bars). A row opens its settings (timeframe, value, inputs), then "Add column".
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { IndicatorRegistryEntry } from "lightweight-charts-indicators";
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { SelectControl } from "../../components/form";
import { CATEGORIES, COLUMNS, defaultRef, isOffered, visibleParams, type Category, type ColumnDef, type ColumnRef } from "../../data/screener-catalog";
import { screenerClose, screenerFields, screenerOpen, onScreenerUpdate } from "../../data/screener-api";
import { INTRADAY_MAX_SYMBOLS, SCRIPT_INTERVALS, declaredColumns, intradayMinutes, type ScriptInterval } from "../../data/script-screen";
import { TAB_CONTENT, isSection, type IndicatorRow } from "../../data/indicators-dialog";
import { highlightParts } from "../../data/indicator-search";
import { listScripts, loadScript } from "../../data/oakscript-store";
import type { WlAddedColumn } from "../../data/watchlist";
import { getIndicatorEntry, indicatorName, loadIndicatorLibrary } from "../chart/indicators/registry";
import { userIndicatorId } from "../chart/indicators/user-scripts";
import { defaultIndicatorOptions } from "../chart/indicators/indicator-options";
import { IndicatorSettingsDialog } from "../chart/IndicatorSettingsDialog";
import { SidebarGlyph } from "../header/IndicatorsDialog";
import { scriptScreenerSupports } from "../screener/ScriptScreener";
import { newAddedKey, scriptColumnNames } from "./watchlist/added-columns";
import { translate, translateWith } from "../../i18n/translator";

type Props = {
  /** Columns already added (their rows are marked). */
  added: WlAddedColumn[];
  onAdd: (column: WlAddedColumn) => void;
  onClose: () => void;
};

/** Owner of the screener's table while the dialog is open (the metrics it serves). */
const OWNER = "watchlist:add-column";
/** Timeframe an indicator column starts on. */
const DEFAULT_INTERVAL: ScriptInterval = "1D";

type Tab = { kind: "metrics"; category: Category } | { kind: "indicators"; source: "built-ins" | "my-scripts" };
const tabId = (t: Tab) => (t.kind === "metrics" ? `m:${t.category}` : t.source);

// Kept for the app session: the dialog reopens on its last tab.
let lastTab: Tab = { kind: "metrics", category: "marketData" };

/** Columns of the screener the watchlist cannot show (the ticker itself, pattern badges). */
const SKIPPED = new Set(["TickerUniversal"]);

export function AddColumnDialog(props: Props) {
  // ── Metrics the backend serves (known once the screener's table is loaded; all offered before) ──
  const [fields, setFields] = createSignal<Set<string> | null>(null);
  const has = (f: string) => fields()?.has(f) ?? true;
  onMount(() => {
    let disposed = false;
    let off: (() => void) | undefined;
    const load = () =>
      void screenerFields()
        .then((l) => !disposed && l.length && setFields(new Set(l.map((f) => f.id))))
        .catch(() => {});
    void screenerOpen(OWNER).then(load).catch(() => {});
    // The table comes in parts (prices, then the fundamentals): read the fields again at each update.
    void onScreenerUpdate(() => load()).then((f) => (disposed ? f() : (off = f)));
    void loadIndicatorLibrary();
    onCleanup(() => {
      disposed = true;
      off?.();
      void screenerClose(OWNER).catch(() => {});
    });
  });

  const metricsOf = (category: Category | null): ColumnDef[] =>
    COLUMNS.filter((d) => (category === null || d.category === category) && !SKIPPED.has(d.id) && d.fmt !== "patterns" && isOffered(d, has));
  const categories = createMemo(() => CATEGORIES.filter((c) => metricsOf(c.id).length > 0));

  // ── Indicators the Script Screener can run ──
  const builtIns = (): IndicatorRow[] => {
    const c = TAB_CONTENT["built-ins"];
    if (c?.kind !== "filtered") return [];
    const items = c.filters.find((f) => f.id === "indicators")?.items ?? [];
    return items.filter((i): i is IndicatorRow => !isSection(i) && !!i.indicatorId && scriptScreenerSupports(i.indicatorId));
  };
  const myScripts = (): IndicatorRow[] =>
    listScripts()
      .filter((m) => !loadScript(m.id)?.meta?.strategy)
      .map((m) => ({ name: m.name, indicatorId: userIndicatorId(m.id), authored: true }))
      .filter((r) => scriptScreenerSupports(r.indicatorId!));

  // ── Tabs and search ──
  const [tab, setTab] = createSignal<Tab>(lastTab);
  onCleanup(() => (lastTab = tab()));
  const [query, setQuery] = createSignal("");
  const q = () => query().trim().toLowerCase();
  const matches = (...texts: (string | undefined)[]) => texts.some((t) => !!t && (t.toLowerCase().includes(q()) || translate(t).toLowerCase().includes(q())));
  const [config, setConfig] = createSignal<string | null>(null);

  const shownMetrics = createMemo(() => {
    if (q()) return metricsOf(null).filter((d) => matches(d.title, d.short));
    const t = tab();
    return t.kind === "metrics" ? metricsOf(t.category) : [];
  });
  const shownIndicators = createMemo(() => {
    if (q()) return [...builtIns(), ...myScripts()].filter((r) => matches(r.name, r.shortName));
    const t = tab();
    if (t.kind !== "indicators") return [];
    return t.source === "built-ins" ? builtIns() : myScripts();
  });

  const isAddedMetric = (col: ColumnRef) =>
    props.added.some((a) => a.kind === "metric" && a.col.id === col.id && JSON.stringify(a.col.params) === JSON.stringify(col.params));
  // A metric shows once (an indicator column can be added again, with other inputs or another timeframe).
  const addMetric = (col: ColumnRef) => {
    if (!isAddedMetric(col)) props.onAdd({ kind: "metric", key: newAddedKey(), col: { id: col.id, params: { ...col.params } } });
  };

  const MetricRow = (p: { def: ColumnDef }) => {
    const choice = () => visibleParams(p.def, has);
    // One choice with a few options: its buttons add that column (the other params at their defaults).
    const buttons = () => (choice().length === 1 && choice()[0].options.length <= 8 ? choice()[0] : null);
    const refFor = (value: string): ColumnRef => {
      const base = defaultRef(p.def, has);
      const param = buttons()!;
      return { id: base.id, params: { ...base.params, [param.key]: value } };
    };
    return (
      <div
        class="indicators-row is-addable"
        classList={{ "is-metric": !!buttons(), "is-added": !buttons() && isAddedMetric(defaultRef(p.def, has)) }}
        role="option"
        aria-selected="false"
        onClick={() => addMetric(buttons() ? refFor(buttons()!.default) : defaultRef(p.def, has))}
      >
        <div class="indicators-cell indicators-name-cell">
          <span class="indicators-name">
            <For each={highlightParts(translate(p.def.title), query())}>
              {(part) => (part.hit ? <span class="indicators-hit">{part.text}</span> : part.text)}
            </For>
          </span>
        </div>
        <Show when={buttons()}>
          {(param) => (
            <div class="indicators-metric-actions">
              <For each={param().options}>
                {(o) => (
                  <button
                    type="button"
                    class="indicators-metric-period"
                    classList={{ "is-added": isAddedMetric(refFor(o.value)) }}
                    title={o.label}
                    onClick={(e) => {
                      e.stopPropagation();
                      addMetric(refFor(o.value));
                    }}
                  >
                    {o.short}
                  </button>
                )}
              </For>
            </div>
          )}
        </Show>
      </div>
    );
  };

  const IndicatorItem = (p: { row: IndicatorRow }) => (
    <div class="indicators-row is-addable" role="option" aria-selected="false" onClick={() => setConfig(p.row.indicatorId!)}>
      <div class="indicators-cell indicators-name-cell">
        <span class="indicators-name" data-no-translate={p.row.authored || undefined}>
          <For each={highlightParts(p.row.name, query())}>{(part) => (part.hit ? <span class="indicators-hit">{part.text}</span> : part.text)}</For>
        </span>
      </div>
    </div>
  );

  const title = () => {
    const t = tab();
    if (t.kind === "metrics") return CATEGORIES.find((c) => c.id === t.category)?.title ?? "";
    return t.source === "built-ins" ? "Built-In" : "My scripts";
  };

  return (
    <Dialog
      look="indicators"
      layerClass="indicators-backdrop"
      backdrop="close"
      inline
      class="indicators-dialog wl-add-column"
      data-name="watchlist-add-column-dialog"
      title="Add column"
      onClose={props.onClose}
    >
      <div class="indicators-search-wrap">
        <span class="indicators-search-icon" aria-hidden="true">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="20" height="20" fill="none">
            <path stroke="currentColor" stroke-width="1.4" d="M19.5 19.5 24 24M21 13a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z" />
          </svg>
        </span>
        <input
          type="search"
          role="searchbox"
          class="indicators-search-input"
          placeholder="Search"
          value={query()}
          onInput={(e) => {
            setQuery(e.currentTarget.value);
            setConfig(null);
          }}
          autocomplete="off"
          spellcheck={false}
          autofocus
        />
      </div>

      <div class="indicators-content">
        <nav class="indicators-sidebar" aria-label="Column categories">
          <div class="indicators-sidebar-group">
            <div class="indicators-sidebar-title">Metrics</div>
            <For each={categories()}>
              {(c) => {
                const t: Tab = { kind: "metrics", category: c.id };
                return (
                  <button
                    type="button"
                    class="indicators-sidebar-item"
                    classList={{ "is-active": !q() && !config() && tabId(tab()) === tabId(t) }}
                    onClick={() => {
                      setQuery("");
                      setConfig(null);
                      setTab(t);
                    }}
                  >
                    <span class="indicators-sidebar-icon wl-add-column-cat-icon" aria-hidden="true">
                      <Icon name={c.icon as never} size={24} />
                    </span>
                    <span class="indicators-sidebar-label">{c.title}</span>
                  </button>
                );
              }}
            </For>
          </div>
          <div class="indicators-sidebar-group">
            <div class="indicators-sidebar-title">Indicators</div>
            <For each={[{ id: "built-ins", label: "Built-In" }, { id: "my-scripts", label: "My scripts" }] as const}>
              {(s) => {
                const t: Tab = { kind: "indicators", source: s.id };
                return (
                  <button
                    type="button"
                    class="indicators-sidebar-item"
                    classList={{ "is-active": !q() && tabId(tab()) === tabId(t) }}
                    onClick={() => {
                      setQuery("");
                      setConfig(null);
                      setTab(t);
                    }}
                  >
                    <SidebarGlyph id={s.id} />
                    <span class="indicators-sidebar-label">{s.label}</span>
                  </button>
                );
              }}
            </For>
          </div>
        </nav>

        <div class="indicators-list-pane">
          <Show
            when={config()}
            fallback={
              <>
                <Show when={!q()}>
                  <div class="indicators-list-head">
                    <span class="indicators-col-name">{title()}</span>
                  </div>
                </Show>
                <div class="indicators-list-scroll">
                  <Show
                    when={shownMetrics().length || shownIndicators().length}
                    fallback={<div class="ot-empty-state indicators-empty">{q() ? "No matches" : tab().kind === "indicators" ? "No indicators" : "No metrics"}</div>}
                  >
                    <div class="indicators-list" role="listbox">
                      <Show when={q() && shownMetrics().length}>
                        <div class="indicators-section-title" role="presentation">Metrics</div>
                      </Show>
                      <For each={shownMetrics()}>{(d) => <MetricRow def={d} />}</For>
                      <Show when={q() && shownIndicators().length}>
                        <div class="indicators-section-title" role="presentation">Indicators</div>
                      </Show>
                      <For each={shownIndicators()}>{(r) => <IndicatorItem row={r} />}</For>
                    </div>
                  </Show>
                </div>
                <div class="wl-add-column-note">
                  {tab().kind === "metrics" && !q()
                    ? "Metrics come from the screener: US stocks and ETFs. Other symbols show a dash."
                    : "Indicators are computed on each symbol's bars, on the timeframe you pick."}
                </div>
              </>
            }
          >
            {(id) => <IndicatorConfig id={id()} onBack={() => setConfig(null)} onAdd={props.onAdd} />}
          </Show>
        </div>
      </div>
    </Dialog>
  );
}

/** An indicator's column settings: timeframe, value, inputs; "Add column". */
function IndicatorConfig(props: { id: string; onBack: () => void; onAdd: (c: WlAddedColumn) => void }) {
  const entry = (): IndicatorRegistryEntry | undefined => getIndicatorEntry(props.id);
  const [interval, setTimeframe] = createSignal<ScriptInterval>(DEFAULT_INTERVAL);
  const [changed, setChanged] = createSignal<Record<string, unknown>>({});
  const inputs = () => ({ ...(entry()?.defaultInputs ?? {}), ...changed() });
  const outputs = createMemo(() => {
    const e = entry();
    return e ? declaredColumns(e, inputs()) : [];
  });
  const [output, setOutput] = createSignal<string | null>(null);
  const picked = () => outputs().find((o) => o.key === output()) ?? outputs().find((o) => o.kind === "value") ?? outputs()[0];
  const [inputsOpen, setInputsOpen] = createSignal(false);
  const name = () => entry()?.name ?? indicatorName(props.id) ?? props.id;

  const add = () => {
    const e = entry();
    const o = picked();
    if (!e || !o) return;
    const names = scriptColumnNames(e.name, e.shortName ?? e.name, o, outputs().length, interval());
    props.onAdd({ kind: "script", key: newAddedKey(), indicatorId: props.id, inputs: changed(), interval: interval(), output: o.key, ...names });
    props.onBack();
  };

  return (
    <div class="wl-add-column-config">
      <button type="button" class="wl-add-column-back" onClick={props.onBack}>
        <svg class="ot-flip-rtl" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
          <path fill="currentColor" d="M10.62 4.33 6.17 9l4.45 4.67-.73.69L4.79 9l5.1-5.36.73.69Z" />
        </svg>
        <span data-no-translate>{name()}</span>
      </button>
      <Show when={entry()} fallback={<div class="ot-empty-state indicators-empty">Loading…</div>}>
        <div class="wl-add-column-form">
          <span class="wl-add-column-label">Timeframe</span>
          <SelectControl
            value={interval()}
            options={SCRIPT_INTERVALS.map((i) => i.id)}
            labelOf={(id) => SCRIPT_INTERVALS.find((i) => i.id === id)?.label ?? id}
            width={240}
            onPick={(v) => setTimeframe(v as ScriptInterval)}
          />
          <span class="wl-add-column-label">Value</span>
          <SelectControl
            value={picked()?.key ?? ""}
            options={outputs().map((o) => o.key)}
            labelOf={(k) => outputs().find((o) => o.key === k)?.title ?? k}
            data
            width={240}
            onPick={setOutput}
          />
          <Show when={(entry()?.inputConfig?.length ?? 0) > 0}>
            <span class="wl-add-column-label">Inputs</span>
            <button type="button" class="cp3-btn wl-add-column-inputs" onClick={() => setInputsOpen(true)}>
              Settings…
            </button>
          </Show>
        </div>
        <Show when={intradayMinutes(interval()) !== null}>
          <p class="wl-add-column-hint">
            {translateWith("Intraday values are computed for the first {0} symbols of a list, again at each new bar.", INTRADAY_MAX_SYMBOLS)}
          </p>
        </Show>
        <div class="wl-add-column-actions">
          <button type="button" class="cp3-btn" onClick={props.onBack}>
            Cancel
          </button>
          <button type="button" class="cp3-btn is-primary" disabled={!picked()} onClick={add}>
            Add column
          </button>
        </div>
      </Show>
      <Show when={inputsOpen() && entry()} keyed>
        {(e) => (
          <IndicatorSettingsDialog
            title={e.name}
            inputsOnly
            inputConfig={e.inputConfig}
            plotConfig={e.plotConfig}
            inputs={inputs()}
            styles={{}}
            options={defaultIndicatorOptions()}
            onApply={({ inputs: next }) => {
              // Only the inputs changed from the defaults are kept.
              const out: Record<string, unknown> = {};
              for (const [k, v] of Object.entries(next)) if (JSON.stringify(v) !== JSON.stringify(e.defaultInputs[k])) out[k] = v;
              setChanged(out);
            }}
            onSaveAsDefault={() => {}}
            onClose={() => setInputsOpen(false)}
          />
        )}
      </Show>
    </div>
  );
}
