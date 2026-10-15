/*
 * Watchlist list headers: the table view's column headers (click to sort,
 * flag sort, resize dividers, back to the custom order) and the tile view's
 * "Symbol" / "Sort by" header with its sort menu.
 */
import { For, Show } from "solid-js";
import { Tooltip } from "../../../components/Tooltip";
import { WL_ICONS } from "../../../data/watchlist";
import { SYMBOL_COL_KEY } from "./prefs";
import { SORT_MENU_FIELDS } from "./sort";
import { type WatchlistCx } from "./context";
import type { JSX } from "solid-js";

/** What createHeaders adds to the watchlist context. */
export interface HeadersApi {
  ColumnHeaders: () => JSX.Element;
  TileHeader: () => JSX.Element;
}

export function createHeaders(cx: WatchlistCx): HeadersApi {
  const {
    colResizeHandle,
    gridTemplate,
    headerLabel,
    isFlashing,
    setSortBy,
    setSortMenuOpen,
    sortArrow,
    sortBy,
    sortDirFor,
    sortMenuOpen,
    sortTipIcon,
    toggleSort,
    visibleCols,
  } = cx;

  /** Tile view header: "Symbol" left, "Sort by ⌄" right. */
  function TileHeader() {
    return (
      <div class="watchlist-tile-header" role="row">
        <span role="columnheader" class="watchlist-tile-header-symbol">Symbol</span>
        <div class="watchlist-sortby-wrap" ref={cx.sortWrapEl}>
          <button
            type="button"
            class="watchlist-sortby"
            classList={{ "is-active": sortMenuOpen() || sortBy() !== "default" }}
            aria-haspopup="menu"
            aria-expanded={sortMenuOpen()}
            onClick={() => setSortMenuOpen((o) => !o)}
          >
            <span>Sort by</span>
            <span class="watchlist-sortby-arrow" aria-hidden="true" innerHTML={WL_ICONS.menuArrow} />
          </button>
          <Show when={sortMenuOpen()}>
            <div class="watchlist-sort-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                class="watchlist-sort-item"
                disabled={sortBy() === "default"}
                onClick={() => {
                  setSortBy("default");
                  setSortMenuOpen(false);
                }}
              >
                Customized order
              </button>
              <For each={SORT_MENU_FIELDS}>
                {(opt) => (
                  <>
                    <div class="watchlist-sort-separator" role="separator" />
                    <For each={["asc", "desc"] as const}>
                      {(dir) => (
                        <button
                          type="button"
                          role="menuitem"
                          class="watchlist-sort-item"
                          data-name={`${opt.field}_${dir}`}
                          onClick={() => {
                            setSortBy(`${opt.field}-${dir}`);
                            setSortMenuOpen(false);
                          }}
                        >
                          <span
                            class="watchlist-sort-item-icon"
                            aria-hidden="true"
                            innerHTML={dir === "asc" ? WL_ICONS.sortAsc : WL_ICONS.sortDesc}
                          />
                          <span>{opt.label}</span>
                        </button>
                      )}
                    </For>
                  </>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>
    );
  }

  /** Table view header: one sortable, resizable header per visible column. */
  function ColumnHeaders() {
    return (
      <div
        ref={cx.headersEl}
        class="watchlist-column-headers"
        role="row"
        style={{ "grid-template-columns": gridTemplate() }}
      >
        <span
          role="columnheader"
          class="watchlist-column-header watchlist-column-symbol"
          aria-sort={sortDirFor("symbol") ? (sortDirFor("symbol") === "asc" ? "ascending" : "descending") : "none"}
        >
          {/* Flag-sort button in the 12px gutter left of "Symbol" (no
              arrow, no blue state; tooltip only). */}
          <span class="watchlist-column-flag">
            <Tooltip text="Click to sort by Flag" icon={sortTipIcon("flag")} side="top" farther>
              <button
                type="button"
                class="watchlist-column-flag-btn"
                aria-label="Sort by flag"
                onClick={() => toggleSort("flag")}
                innerHTML={WL_ICONS.flag}
              />
            </Tooltip>
          </span>
          <Tooltip text="Click to sort by Symbol" icon={sortTipIcon("symbol")} side="top" farther>
            <button
              type="button"
              class="watchlist-column-label"
              classList={{ sorted: isFlashing("symbol") }}
              onClick={() => toggleSort("symbol")}
            >
              Symbol
            </button>
          </Tooltip>
          {sortArrow("symbol")}
          {colResizeHandle(SYMBOL_COL_KEY)}
        </span>
        <For each={visibleCols()}>
          {(c) => (
            <span
              role="columnheader"
              class="watchlist-column-header watchlist-column-header--num"
              aria-sort={sortDirFor(c.key) ? (sortDirFor(c.key) === "asc" ? "ascending" : "descending") : "none"}
            >
              {sortArrow(c.key)}
              <Tooltip text={`Click to sort by ${headerLabel(c.key)}`} icon={sortTipIcon(c.key)} side="top" farther>
                <button
                  type="button"
                  class="watchlist-column-label"
                  classList={{ sorted: isFlashing(c.key) }}
                  onClick={() => toggleSort(c.key)}
                >
                  {headerLabel(c.key)}
                </button>
              </Tooltip>
              {colResizeHandle(c.key)}
            </span>
          )}
        </For>
        <Show when={sortBy() !== "default"}>
          <span class="watchlist-sort-reset-wrap">
            <Tooltip text="Return to custom watchlist order" side="top" farther>
              <button
                type="button"
                class="watchlist-sort-reset"
                aria-label="Return to custom watchlist order"
                onClick={() => setSortBy("default")}
                innerHTML={WL_ICONS.sortReset}
              />
            </Tooltip>
          </span>
        </Show>
      </div>
    );
  }

  return { ColumnHeaders, TileHeader };
}
