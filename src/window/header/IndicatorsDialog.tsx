/*
 * IndicatorsDialog — the "Indicators, metrics, and strategies" modal opened from
 * the header's `open-indicators-dialog` button (hotkey "/"). Ported to SolidJS
 * from the reference mock.
 *
 * Layout (840×638): header, bordered search, a
 * sidebar (Personal / Built-In / Community), and a NAME · AUTHOR list.
 * Tabs holding several script types get round type tabs (Indicators /
 * Strategies / Patterns ...) over the list, shown by the reference rule in
 * visibleFilters().  Typing searches every tab at once: results are grouped
 * under the tab names and the sidebar shows no active tab.
 * Registry-backed rows are clickable: each click adds one more instance of
 * the study to the chart (rows of studies already on the chart look the
 * same). Keyboard: ↑/↓ move the selection · Enter adds · Esc closes; the
 * mouse only hovers, it does not move the selection.
 */
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import {
  SIDEBAR,
  SIDEBAR_ICONS,
  TAB_CONTENT,
  DEFAULT_SIDEBAR_ITEM,
  FALLBACK_SIDEBAR_ITEM,
  FILTER_LABELS,
  isSection,
  listHeader,
  typeFilters,
  visibleFilters,
  type FilterId,
  type IndicatorRow,
  type ListItem,
  type FundamentalMetric,
  type FundamentalSubtab,
  type TabContent,
} from "../../data/indicators-dialog";
import type { MetricPeriod } from "../../data/fundamental-metrics";
import { fundamentalId } from "../../window/chart/indicators/fundamental-entry";
import { highlightParts, rankRows } from "../../data/indicator-search";
import {
  favoriteIndicators,
  isFavoriteIndicator,
  toggleFavoriteIndicator,
} from "../../data/indicator-favorites";
import { getIndicatorEntry, indicatorName } from "../../window/chart/indicators/registry";
import { listScripts, loadScript } from "../../data/oakscript-store";
import { userIndicatorId } from "../../window/chart/indicators/user-scripts";
import { isStrategyId, strategyRows, userStrategyId } from "../../window/chart/indicators/strategy-entries";
import { typeIdOf } from "../../window/chart/indicators/study-id";
import { Tooltip } from "../../components/Tooltip";
import { Icon } from "../../components/Icon";

type Props = {
  onClose: () => void;
  /** Add an instance of an indicator (by registry id) to the chart. */
  onAddIndicator?: (indicatorId: string) => void;
};

// Kept for the app session: the reference dialog reopens on its last tab,
// and each tab keeps the type filter picked last.
let lastTab: string | null = null;
const lastFilter: Record<string, FilterId> = {};

/** The search runs this long after the last key (reference: 200 ms). */
const SEARCH_DELAY_MS = 200;

/** Tabs the search goes through, in the order of its result sections. */
const SEARCH_TABS = ["favorites", "my-scripts", "built-ins", "fundamentals", "community"];
const TAB_TITLES: Record<string, string> = Object.fromEntries(
  SIDEBAR.flatMap((g) => g.items.map((i) => [i.id, i.label])),
);

/** Render the FontIcon glyph for a sidebar item. */
function Glyph(props: { id: string }) {
  const def = () => SIDEBAR_ICONS[props.id];
  return (
    <Show when={def()}>
      {(d) => (
        <svg
          class="indicators-sidebar-icon"
          width="24"
          height="24"
          viewBox={d().viewBox}
          fill={d().fill}
          aria-hidden="true"
          innerHTML={d().inner}
        />
      )}
    </Show>
  );
}

/* Fundamentals — round sub-tabs over a single METRIC NAME column; depth-1
 * metrics are indented with a bullet dot. A click on a row adds the metric on
 * its first period; a hovered row with several periods shows one button per
 * period (Quarterly / Annual / TTM). */
const PERIOD_LABELS: Record<MetricPeriod, string> = { FQ: "Quarterly", FY: "Annual", TTM: "TTM" };

function FundamentalsView(props: { subtabs: FundamentalSubtab[]; query: string; onAdd?: (id: string) => void }) {
  const [active, setActive] = createSignal(0);
  const metrics = createMemo(() => {
    const q = props.query.trim().toLowerCase();
    return (props.subtabs[active()]?.metrics ?? []).filter((m) => !q || m.name.toLowerCase().includes(q));
  });
  const idOf = (m: FundamentalMetric, period?: MetricPeriod) => fundamentalId(m.key, period ?? m.periods[0]);
  return (
    <div class="indicators-fund">
      <div class="indicators-subtabs" role="tablist">
        <For each={props.subtabs}>
          {(st, i) => (
            <button
              type="button"
              role="tab"
              aria-selected={i() === active()}
              class={`indicators-subtab${i() === active() ? " selected" : ""}`}
              onClick={() => setActive(i())}
            >
              {st.label}
            </button>
          )}
        </For>
      </div>
      <div class="indicators-fund-head">Metric name</div>
      <div class="indicators-fund-list">
        <Show
          when={metrics().length > 0}
          fallback={<div class="ot-empty-state indicators-empty">No matches</div>}
        >
          <For each={metrics()}>
            {(m) => {
              const favorited = () => isFavoriteIndicator(idOf(m));
              return (
                <div
                  class={`indicators-metric depth-${m.depth}${props.onAdd ? " is-addable" : ""}`}
                  data-role="list-item"
                  onClick={() => props.onAdd?.(idOf(m))}
                >
                  <Tooltip text={favorited() ? "Remove from favorites" : "Add to favorites"} side="bottom">
                    <span
                      class={`indicators-favorite${favorited() ? " is-active" : ""}`}
                      aria-label={favorited() ? "Remove from favorites" : "Add to favorites"}
                      role="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleFavoriteIndicator(idOf(m));
                      }}
                    >
                      <svg viewBox="0 0 18 18" width="16" height="16" fill={favorited() ? "currentColor" : "none"} stroke="currentColor" stroke-width={favorited() ? 0 : 1.2} aria-hidden="true">
                        <path d="M9 2.2l1.96 4.02 4.44.62-3.22 3.1.78 4.44L9 12.78 5.26 14.4l.78-4.44-3.22-3.1 4.44-.62z" />
                      </svg>
                    </span>
                  </Tooltip>
                  <Show when={m.depth > 0}>
                    <span class="indicators-metric-dot" aria-hidden="true" />
                  </Show>
                  <span class="indicators-metric-name">{m.name}</span>
                  <Show when={m.periods.length > 1}>
                    <div class="indicators-metric-actions">
                      <For each={m.periods}>
                        {(p) => (
                          <button
                            type="button"
                            class="indicators-metric-period"
                            onClick={(e) => {
                              e.stopPropagation();
                              props.onAdd?.(idOf(m, p));
                            }}
                          >
                            {PERIOD_LABELS[p]}
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              );
            }}
          </For>
        </Show>
      </div>
    </div>
  );
}

/** Every row of a tab once (no section titles), for the search. */
function tabRows(c: TabContent | undefined): IndicatorRow[] {
  if (c?.kind === "rows") return c.rows;
  if (c?.kind === "fundamentals") {
    return c.subtabs.flatMap((st) => st.metrics.map((m) => ({
      name: m.name, indicatorId: fundamentalId(m.key, m.periods[0]), metricKey: m.key, periods: m.periods,
    })));
  }
  if (c?.kind !== "filtered") return [];
  const all = c.filters.find((f) => f.id === "all");
  const items = all ? all.items : c.filters.flatMap((f) => f.items);
  return items.filter((i): i is IndicatorRow => !isSection(i));
}

export function IndicatorsDialog(props: Props) {
  const hasFavorites = () => favoriteIndicators().length > 0;
  // Favorites is listed only once something is starred (reference rule).
  const isVisibleTab = (id: string) => id !== "favorites" || hasFavorites();
  const firstTab = () => (lastTab && isVisibleTab(lastTab) ? lastTab : hasFavorites() ? DEFAULT_SIDEBAR_ITEM : FALLBACK_SIDEBAR_ITEM);

  // null while searching: the search spans every tab.
  const [activeItem, setActiveItem] = createSignal<string | null>(firstTab());
  // Tab to come back to when the search is cleared.
  const [searchFromTab, setSearchFromTab] = createSignal<string | null>(null);
  const [input, setInput] = createSignal("");
  const [query, setQuery] = createSignal("");
  const [filters, setFilters] = createSignal<Record<string, FilterId>>({ ...lastFilter });
  const [selectedIdx, setSelectedIdx] = createSignal(-1);
  let inputRef: HTMLInputElement | undefined;
  let listRef: HTMLDivElement | undefined;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;

  // Unstarring the last favourite hides the Favorites tab.
  createEffect(() => {
    if (activeItem() === "favorites" && !hasFavorites()) setActiveItem(FALLBACK_SIDEBAR_ITEM);
  });

  const strategyAuthors = new Map(strategyRows().map((r) => [r.id, r.author]));

  // Favorites and My scripts are live lists; other tabs come from the
  // static registry-backed content map.
  const content = (tab: string): TabContent | undefined => {
    if (tab === "favorites") {
      return {
        kind: "filtered",
        filters: typeFilters(favoriteIndicators().map((id) => {
          const entry = getIndicatorEntry(id);
          const row: IndicatorRow = { name: entry?.name ?? indicatorName(id) ?? id, shortName: entry?.shortName, indicatorId: id };
          if (isStrategyId(typeIdOf(id))) { row.scriptType = "strategy"; row.author = strategyAuthors.get(id); }
          return row;
        })),
      };
    }
    // My scripts: the user's OakScript scripts (a strategy() script goes on
    // the chart as a strategy, like the editor's Add to chart).
    if (tab === "my-scripts") {
      const mine: IndicatorRow[] = listScripts().map((m) => {
        const strategy = !!loadScript(m.id)?.meta?.strategy;
        return strategy
          ? { name: m.name, indicatorId: userStrategyId(m.id), scriptType: "strategy" as const }
          : { name: m.name, indicatorId: userIndicatorId(m.id) };
      });
      if (mine.length) return { kind: "filtered", filters: typeFilters(mine) };
    }
    return TAB_CONTENT[tab];
  };

  // The active tab: its type tabs, the picked one and the rows under it.
  const view = createMemo(() => {
    const tab = activeItem();
    const c = tab ? content(tab) : undefined;
    if (!tab || !c) return null;
    if (c.kind === "rows") return { tab, content: c, filters: [], filter: null, items: c.rows as ListItem[] };
    if (c.kind !== "filtered") return { tab, content: c, filters: [], filter: null, items: [] as ListItem[] };
    const v = visibleFilters(c.filters);
    if (!v.filters.length) return { tab, content: c, filters: [], filter: null, items: v.items };
    const picked = v.filters.find((f) => f.id === filters()[tab]) ?? v.filters[0];
    return { tab, content: c, filters: v.filters, filter: picked.id, items: picked.items };
  });

  // Search results: every tab's matches under its title.
  const searchItems = createMemo<ListItem[]>(() => {
    const q = query().trim();
    if (!q) return [];
    const out: ListItem[] = [];
    for (const tab of SEARCH_TABS) {
      if (!isVisibleTab(tab)) continue;
      const found = rankRows(tabRows(content(tab)), q);
      if (found.length) out.push({ section: TAB_TITLES[tab] ?? tab }, ...found);
    }
    return out;
  });

  const searching = () => query().trim() !== "";
  const items = () => (searching() ? searchItems() : view()?.items ?? []);
  const isList = () => searching() || view()?.content.kind === "rows" || view()?.content.kind === "filtered";
  const header = () => {
    const v = view();
    return searching() || !v || !isList() ? null : listHeader(v.tab, v.filter, v.items);
  };

  const applyQuery = (text: string) => {
    setQuery(text);
    if (!text.trim()) {
      if (searchFromTab()) setActiveItem(searchFromTab());
      setSearchFromTab(null);
    } else if (activeItem() !== null) {
      setSearchFromTab(activeItem());
      setActiveItem(null);
    }
  };
  const onSearchInput = (text: string) => {
    setInput(text);
    clearTimeout(searchTimer);
    if (!text) applyQuery("");
    else searchTimer = setTimeout(() => applyQuery(text), SEARCH_DELAY_MS);
  };
  // A sidebar click ends the search and opens that tab.
  const openTab = (id: string) => {
    clearTimeout(searchTimer);
    setInput("");
    setQuery("");
    setSearchFromTab(null);
    setActiveItem(id);
  };
  const pickFilter = (tab: string, id: FilterId) => {
    lastFilter[tab] = id;
    setFilters({ ...lastFilter });
  };

  // Reset the selection whenever the visible set changes.
  createEffect(() => {
    items();
    setSelectedIdx(-1);
  });

  // Scroll the selected row into view.
  createEffect(() => {
    const i = selectedIdx();
    if (i < 0) return;
    const el = listRef?.children[i] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  });

  /** Next row index from `from` in direction `step` (section titles skipped). */
  const stepRow = (from: number, step: 1 | -1): number => {
    const list = items();
    for (let i = from + step; i >= 0 && i < list.length; i += step) {
      if (!isSection(list[i])) return i;
    }
    return from;
  };

  onMount(() => {
    inputRef?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); props.onClose(); return; }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx((i) => stepRow(i, 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx((i) => (i < 0 ? i : stepRow(i, -1)));
      } else if (e.key === "Enter") {
        const item = items()[selectedIdx()];
        const id = item && !isSection(item) ? item.indicatorId : undefined;
        if (id && props.onAddIndicator) { e.preventDefault(); props.onAddIndicator(id); }
      }
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });

  onCleanup(() => {
    clearTimeout(searchTimer);
    lastTab = activeItem() ?? searchFromTab();
  });

  return (
    <div class="indicators-backdrop" role="presentation" onMouseDown={() => props.onClose()}>
      <div
        class="indicators-dialog"
        data-name="indicators-dialog"
        role="dialog"
        aria-label="Indicators, metrics, and strategies"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* ─── Header ─── */}
        <header class="indicators-header">
          <div class="indicators-title">Indicators, metrics, and strategies</div>
          <button
            type="button"
            data-qa-id="close"
            aria-label="Close menu"
            class="indicators-close"
            onClick={() => props.onClose()}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18">
              <path stroke="currentColor" stroke-width="1.2" fill="none" d="m1.5 1.5 15 15m0-15-15 15" />
            </svg>
          </button>
        </header>

        {/* ─── Search ─── */}
        <div class="indicators-search-wrap">
          <span class="indicators-search-icon" aria-hidden="true">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="20" height="20" fill="none">
              <path stroke="currentColor" stroke-width="1.4" d="M19.5 19.5 24 24M21 13a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z" />
            </svg>
          </span>
          <input
            ref={inputRef}
            type="search"
            role="searchbox"
            class="indicators-search-input"
            data-qa-id="indicators-dialog-search-input"
            placeholder="Search"
            value={input()}
            onInput={(e) => onSearchInput(e.currentTarget.value)}
            autocomplete="off"
            spellcheck={false}
          />
        </div>

        {/* ─── Content: sidebar + list ─── */}
        <div class="indicators-content">
          <nav class="indicators-sidebar" data-qa-id="indicator-sidebar" aria-label="Indicator categories">
            <For each={SIDEBAR}>
              {(group) => (
                <div class="indicators-sidebar-group" data-qa-id={`indicator-sidebar-group-${group.key}`}>
                  <div class="indicators-sidebar-title">{group.title}</div>
                  <For each={group.items.filter((item) => isVisibleTab(item.id))}>
                    {(item) => (
                      <button
                        type="button"
                        data-qa-id={`indicator-sidebar-item-${item.id}`}
                        class={`indicators-sidebar-item${activeItem() === item.id ? " is-active" : ""}${item.disabled ? " is-disabled" : ""}`}
                        aria-current={activeItem() === item.id}
                        aria-disabled={item.disabled || undefined}
                        disabled={item.disabled}
                        onClick={() => { if (!item.disabled) openTab(item.id); }}
                      >
                        <Glyph id={item.id} />
                        <span class="indicators-sidebar-label">{item.label}</span>
                      </button>
                    )}
                  </For>
                </div>
              )}
            </For>
          </nav>

          <div class="indicators-list-pane">
            <Show when={!searching() && (view()?.filters.length ?? 0) > 0}>
              <div class="indicators-type-tabs" role="tablist" data-qa-id="indicators-type-tabs">
                <For each={view()?.filters ?? []}>
                  {(f) => (
                    <button
                      type="button"
                      role="tab"
                      data-filter={f.id}
                      aria-selected={view()?.filter === f.id}
                      class={`indicators-subtab${view()?.filter === f.id ? " selected" : ""}`}
                      onClick={() => { const tab = activeItem(); if (tab) pickFilter(tab, f.id); }}
                    >
                      {FILTER_LABELS[f.id]}
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <Show when={header()}>
              {(h) => (
                <div class={`indicators-list-head${(view()?.filters.length ?? 0) > 0 ? " has-filters" : ""}`}>
                  <span class="indicators-col-name">{h().title}</span>
                  <Show when={h().author}>
                    <span class="indicators-col-author">Author</span>
                  </Show>
                </div>
              )}
            </Show>
            <div class="indicators-list-scroll">
              {/* Tab body */}
              <Show when={!searching() && view()?.content}>
                {(c) => (
                  <>
                    <Show when={c().kind === "empty"}>
                      <div class="indicators-empty-state">
                        <div class="indicators-empty-title">{(c() as any).title}</div>
                        <Show when={(c() as any).body}>
                          <div class="indicators-empty-body">{(c() as any).body}</div>
                        </Show>
                        <Show when={(c() as any).action}>
                          <button type="button" class="indicators-empty-action">{(c() as any).action}</button>
                        </Show>
                      </div>
                    </Show>

                    <Show when={c().kind === "placeholder" || c().kind === "gap"}>
                      <div class="ot-empty-state indicators-empty">{(c() as any).note}</div>
                    </Show>

                    <Show when={c().kind === "fundamentals"}>
                      <FundamentalsView subtabs={(c() as any).subtabs} query={query()} onAdd={props.onAddIndicator} />
                    </Show>
                  </>
                )}
              </Show>

              <Show when={isList()}>
                <Show
                  when={items().length > 0}
                  fallback={
                    <div class="ot-empty-state indicators-empty">{searching() ? "No matches" : "No indicators"}</div>
                  }
                >
                  <div class={`indicators-list${!searching() && (view()?.filters.length ?? 0) > 0 ? " has-filters" : ""}`} ref={listRef} role="listbox">
                    <For each={items()}>
                      {(item, i) => {
                        if (isSection(item)) {
                          return <div class="indicators-section-title" role="presentation">{item.section}</div>;
                        }
                        const row = item;
                        const addable = () => !!row.indicatorId && !!props.onAddIndicator;
                        const favorited = () => !!row.indicatorId && isFavoriteIndicator(row.indicatorId);
                        return (
                          <div
                            class={`indicators-row${row.metricKey ? " is-metric" : ""}${i() === selectedIdx() ? " is-selected" : ""}${addable() ? " is-addable" : ""}`}
                            role="option"
                            aria-selected={i() === selectedIdx()}
                            onClick={addable() ? () => props.onAddIndicator!(row.indicatorId!) : undefined}
                          >
                            <div class="indicators-cell indicators-name-cell">
                              <Tooltip text={favorited() ? "Remove from favorites" : "Add to favorites"} side="bottom">
                                <span
                                  class={`indicators-favorite${favorited() ? " is-active" : ""}`}
                                  aria-label={favorited() ? "Remove from favorites" : "Add to favorites"}
                                  role="button"
                                  onClick={(e) => {
                                    // Star toggles the favourite without
                                    // adding the study.
                                    if (!row.indicatorId) return;
                                    e.stopPropagation();
                                    toggleFavoriteIndicator(row.indicatorId);
                                  }}
                                >
                                  <svg viewBox="0 0 18 18" width="16" height="16" fill={favorited() ? "currentColor" : "none"} stroke="currentColor" stroke-width={favorited() ? 0 : 1.2} aria-hidden="true">
                                    <path d="M9 2.2l1.96 4.02 4.44.62-3.22 3.1.78 4.44L9 12.78 5.26 14.4l.78-4.44-3.22-3.1 4.44-.62z" />
                                  </svg>
                                </span>
                              </Tooltip>
                              <span class="indicators-name">
                                <For each={highlightParts(row.name, query())}>
                                  {(part) => (part.hit ? <span class="indicators-hit">{part.text}</span> : part.text)}
                                </For>
                              </span>
                              <Show when={row.scriptType === "strategy"}>
                                <span class="indicators-script-type" aria-label="Strategy">
                                  <Icon name="st-indicators-dialog-strategy-scriptType" size={18} />
                                </span>
                              </Show>
                              <For each={row.badges ?? []}>
                                {(b) => <span class={`indicators-badge badge-${b.toLowerCase()}`}>{b}</span>}
                              </For>
                            </div>
                            <Show
                              when={row.metricKey}
                              fallback={
                                <div class="indicators-cell indicators-author-cell">
                                  <Show when={row.author}>
                                    <span class="indicators-author">{row.author}</span>
                                  </Show>
                                </div>
                              }
                            >
                              <Show when={(row.periods?.length ?? 0) > 1}>
                                <div class="indicators-metric-actions">
                                  <For each={row.periods}>
                                    {(p) => (
                                      <button
                                        type="button"
                                        class="indicators-metric-period"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          props.onAddIndicator?.(fundamentalId(row.metricKey!, p));
                                        }}
                                      >
                                        {PERIOD_LABELS[p]}
                                      </button>
                                    )}
                                  </For>
                                </div>
                              </Show>
                            </Show>
                          </div>
                        );
                      }}
                    </For>
                  </div>
                </Show>
              </Show>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
