/*
 * IndicatorsDialog — the "Indicators, metrics, and strategies" modal opened from
 * the header's `open-indicators-dialog` button (hotkey "/"). Ported to SolidJS
 * from the reference mock, reverse-engineered from TV Desktop's
 * `[data-name="indicators-dialog"]`.
 *
 * Layout kept 1:1 with the live dialog (840×638): header, bordered search, a
 * sidebar (Personal / Built-In / Community), and a NAME · AUTHOR · BOOSTS list.
 * Registry-backed rows are clickable: clicking adds/removes the study on the
 * chart. Keyboard: ↑/↓ move highlight · Enter toggles · Esc closes.
 */
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import {
  SIDEBAR,
  SIDEBAR_ICONS,
  TAB_CONTENT,
  DEFAULT_SIDEBAR_ITEM,
  type IndicatorRow,
  type FundamentalSubtab,
  type TabContent,
} from "../../data/indicators-dialog";
import {
  favoriteIndicators,
  isFavoriteIndicator,
  toggleFavoriteIndicator,
} from "../../data/indicator-favorites";
import { getIndicatorEntry } from "../../window/chart/indicators/registry";
import { Tooltip } from "../../components/Tooltip";

type Props = {
  onClose: () => void;
  /** Registry ids of indicators currently on the chart — drives the per-row
   *  "added" check. */
  activeIndicatorIds?: ReadonlySet<string>;
  /** Add/remove an indicator (by registry id) on the chart. */
  onToggleIndicator?: (indicatorId: string) => void;
};

/** Render the exact FontIcon glyph probed for a sidebar item. */
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
 * metrics are indented with a bullet dot. */
function FundamentalsView(props: { subtabs: FundamentalSubtab[]; query: string }) {
  const [active, setActive] = createSignal(0);
  const metrics = createMemo(() => {
    const q = props.query.trim().toLowerCase();
    return (props.subtabs[active()]?.metrics ?? []).filter((m) => !q || m.name.toLowerCase().includes(q));
  });
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
          fallback={<div class="tv-empty-state indicators-empty">No matches</div>}
        >
          <For each={metrics()}>
            {(m) => (
              <div class={`indicators-metric depth-${m.depth}`}>
                <Show when={m.depth > 0}>
                  <span class="indicators-metric-dot" aria-hidden="true" />
                </Show>
                <span class="indicators-metric-name">{m.name}</span>
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}

export function IndicatorsDialog(props: Props) {
  const [activeItem, setActiveItem] = createSignal(DEFAULT_SIDEBAR_ITEM);
  const [query, setQuery] = createSignal("");
  const [highlightIdx, setHighlightIdx] = createSignal(-1);
  let inputRef: HTMLInputElement | undefined;
  let listRef: HTMLDivElement | undefined;

  // Favorites is the live user-curated set (starred rows); other tabs come
  // from the static registry-backed content map.
  const content = (): TabContent | undefined => {
    if (activeItem() === "favorites") {
      return {
        kind: "rows",
        rows: favoriteIndicators().map((id) => ({
          name: getIndicatorEntry(id)?.name ?? id,
          indicatorId: id,
        })),
      };
    }
    return TAB_CONTENT[activeItem()];
  };

  // Rows for the active tab, filtered by the search query.
  const rows = createMemo<IndicatorRow[]>(() => {
    const c = content();
    if (c?.kind !== "rows") return [];
    const q = query().trim().toLowerCase();
    if (!q) return c.rows;
    return c.rows.filter(
      (r) => r.name.toLowerCase().includes(q) || r.author?.toLowerCase().includes(q),
    );
  });

  // Reset the highlight whenever the visible set changes.
  createEffect(() => {
    activeItem();
    query();
    setHighlightIdx(-1);
  });

  // Scroll the highlighted row into view.
  createEffect(() => {
    const i = highlightIdx();
    if (i < 0) return;
    const el = listRef?.children[i] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  });

  onMount(() => {
    inputRef?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); props.onClose(); return; }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightIdx((i) => Math.min(rows().length - 1, i + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightIdx((i) => Math.max(0, i - 1));
      } else if (e.key === "Enter") {
        const id = rows()[highlightIdx()]?.indicatorId;
        if (id && props.onToggleIndicator) { e.preventDefault(); props.onToggleIndicator(id); }
      }
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });

  const showColumns = () => content()?.kind === "rows";

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
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
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
                  <For each={group.items}>
                    {(item) => (
                      <button
                        type="button"
                        data-qa-id={`indicator-sidebar-item-${item.id}`}
                        class={`indicators-sidebar-item${activeItem() === item.id ? " is-active" : ""}`}
                        aria-current={activeItem() === item.id}
                        onClick={() => setActiveItem(item.id)}
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
            <Show when={showColumns()}>
              <div class="indicators-list-head">
                <span class="indicators-col-name">Name</span>
                <span class="indicators-col-author">Author</span>
                <span class="indicators-col-boosts">Boosts</span>
              </div>
            </Show>
            <div class="indicators-list-scroll">
              {/* Tab body */}
              <Show when={content()}>
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
                      <div class="tv-empty-state indicators-empty">{(c() as any).note}</div>
                    </Show>

                    <Show when={c().kind === "fundamentals"}>
                      <FundamentalsView subtabs={(c() as any).subtabs} query={query()} />
                    </Show>

                    <Show when={c().kind === "rows"}>
                      <Show
                        when={rows().length > 0}
                        fallback={
                          <div class="tv-empty-state indicators-empty">{query() ? "No matches" : "No indicators"}</div>
                        }
                      >
                        <div class="indicators-list" ref={listRef} role="listbox">
                          <For each={rows()}>
                            {(row, i) => {
                              const addable = () => !!row.indicatorId && !!props.onToggleIndicator;
                              const added = () => !!row.indicatorId && !!props.activeIndicatorIds?.has(row.indicatorId);
                              const favorited = () => !!row.indicatorId && isFavoriteIndicator(row.indicatorId);
                              return (
                                <div
                                  class={`indicators-row${i() === highlightIdx() ? " is-highlighted" : ""}${addable() ? " is-addable" : ""}${added() ? " is-added" : ""}`}
                                  role="option"
                                  aria-selected={i() === highlightIdx()}
                                  onMouseEnter={() => setHighlightIdx(i())}
                                  onClick={addable() ? () => props.onToggleIndicator!(row.indicatorId!) : undefined}
                                >
                                  <div class="indicators-cell indicators-name-cell">
                                    <Show
                                      when={added()}
                                      fallback={
                                        <Tooltip text={favorited() ? "Remove from favorites" : "Add to favorites"} side="bottom">
                                          <span
                                            class={`indicators-favorite${favorited() ? " is-active" : ""}`}
                                            aria-label={favorited() ? "Remove from favorites" : "Add to favorites"}
                                            role="button"
                                            onClick={(e) => {
                                              // Star toggles the favourite without
                                              // adding the study (TV idiom).
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
                                      }
                                    >
                                      <span class="indicators-favorite is-added" aria-label="Added" role="img">
                                        <svg viewBox="0 0 18 18" width="16" height="16" fill="none" aria-hidden="true">
                                          <path d="M3.5 9.5l3.5 3.5 7.5-8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                                        </svg>
                                      </span>
                                    </Show>
                                    <span class="indicators-name">{row.name}</span>
                                    <For each={row.badges ?? []}>
                                      {(b) => <span class={`indicators-badge badge-${b.toLowerCase()}`}>{b}</span>}
                                    </For>
                                  </div>
                                  <div class="indicators-cell indicators-author-cell">
                                    <Show when={row.author}>
                                      <a class="indicators-author" href="#" onClick={(e) => e.preventDefault()}>{row.author}</a>
                                    </Show>
                                  </div>
                                  <div class="indicators-cell indicators-boosts-cell">{row.boosts}</div>
                                </div>
                              );
                            }}
                          </For>
                        </div>
                      </Show>
                    </Show>
                  </>
                )}
              </Show>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
