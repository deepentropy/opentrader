/*
 * Rows of the symbol search lists: a result (with the Local tab's rename / remove and the watchlist's add / remove
 * / go to), and the Compare dialog's rows with their placement buttons.
 */
import { For, Show } from "solid-js";
import type { FilteredRow } from "../../../data/symbol-search";
import type { ComparePlacement } from "../../shell/tabs";
import { renderHighlighted, rowFlag } from "./parts";
import type { SymbolSearch } from "./search-model";
import type { SymbolSearchProps } from "./types";

/** What a row reads and does. */
export type RowContext = {
  s: SymbolSearch;
  props: SymbolSearchProps;
  flashed: () => string | null;
  commit: (row: FilteredRow, shift: boolean) => void;
  addRow: (row: FilteredRow) => void;
  afterAction: (shift: boolean) => void;
  addCompare: (symbolName: string, placement: ComparePlacement) => void;
  renameSeries: (name: string) => void;
  removeSeries: (name: string) => void;
};

/** Compare dialog row buttons. */
const COMPARE_BUTTONS: { placement: ComparePlacement; label: string }[] = [
  { placement: "percent", label: "Same % scale" },
  { placement: "scale", label: "New price scale" },
  { placement: "pane", label: "New pane" },
];

// Row action icons of the watchlist search dialog.
const ICON_ADD =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28" fill="none"><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M13.9 14.1V22h1.2v-7.9H23v-1.2h-7.9V5h-1.2v7.9H6v1.2h7.9z"></path></svg>';
const ICON_REMOVE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28"><path fill="currentColor" d="M18 7h5v1h-2.01l-1.33 14.64a1.5 1.5 0 0 1-1.5 1.36H9.84a1.5 1.5 0 0 1-1.49-1.36L7.01 8H5V7h5V6c0-1.1.9-2 2-2h4a2 2 0 0 1 2 2v1Zm-6-2a1 1 0 0 0-1 1v1h6V6a1 1 0 0 0-1-1h-4ZM8.02 8l1.32 14.54a.5.5 0 0 0 .5.46h8.33a.5.5 0 0 0 .5-.46L19.99 8H8.02Z"></path></svg>';
const ICON_GOTO =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28" fill="none"><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M14 9.5a.5.5 0 0 0 1 0V7.02A6.5 6.5 0 0 1 20.98 13H18.5a.5.5 0 0 0 0 1h2.48A6.5 6.5 0 0 1 15 19.98V17.5a.5.5 0 0 0-1 0v2.48A6.5 6.5 0 0 1 8.02 14h2.48a.5.5 0 0 0 0-1H8.02A6.5 6.5 0 0 1 14 7.02V9.5zm1-3.48V4.5a.5.5 0 0 0-1 0v1.52A7.5 7.5 0 0 0 7.02 13H5.5a.5.5 0 0 0 0 1h1.52A7.5 7.5 0 0 0 14 20.98v1.52a.5.5 0 0 0 1 0v-1.52A7.5 7.5 0 0 0 21.98 14h1.52a.5.5 0 0 0 0-1h-1.52A7.5 7.5 0 0 0 15 6.02z"></path></svg>';

export function compareInfo(ticker: string, description: string, logo?: string | null, tr?: [number, number] | null, dr?: [number, number] | null) {
  return (
    <div class="symbol-search-cell cmp-search-info">
      <span class="symbol-search-logo" aria-hidden="true">
        <Show when={logo} fallback={<span class="symbol-search-logo-letter">{ticker[0]}</span>}>
          <img src={logo!} alt="" crossOrigin="anonymous" decoding="async" onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = "none")} />
        </Show>
      </span>
      <div class="cmp-search-titles">
        <div class="cmp-search-ticker" data-name="list-item-title">{renderHighlighted(ticker, tr ?? null)}</div>
        <div class="cmp-search-desc">{renderHighlighted(description, dr ?? null)}</div>
      </div>
    </div>
  );
}
/** Compare result / recent row: click = Same % scale; hover shows the
 *  three placement buttons over the exchange cell. */
export function compareRow(ctx: RowContext, row: FilteredRow, i: () => number) {
  const { s } = ctx;
  return (
    <div
      data-name="symbol-search-dialog-content-item"
      data-role={s.compareHome() ? "recent-symbol-item" : "list-item"}
      data-symbol-name={row.symbolName}
      data-type={row.marketType}
      role="option"
      aria-selected={i() === s.highlightIdx()}
      class={"symbol-search-row cmp-search-row" + (i() === s.highlightIdx() ? " is-highlighted" : "")}
      onMouseEnter={() => s.setHighlightIdx(i())}
      onClick={() => ctx.addCompare(row.symbolName, "percent")}
    >
      {compareInfo(row.ticker, row.description, row.logoSrc, row.titleHighlight, row.descriptionHighlight)}
      <div class="cmp-search-buttons" data-name="compare-buttons-group">
        <For each={COMPARE_BUTTONS}>
          {(b) => (
            <button
              type="button"
              class="cmp-search-button"
              onClick={(e) => { e.stopPropagation(); ctx.addCompare(row.symbolName, b.placement); }}
            >
              {b.label}
            </button>
          )}
        </For>
      </div>
      <div class="symbol-search-cell symbol-search-exchange-cell cmp-search-exchange">
        <div class="symbol-search-market-type" data-i18n-sense="market">{row.marketType}</div>
        <div class="symbol-search-exchange-source">
          <span class="symbol-search-exchange" data-no-translate title={row.exchangeTooltip ?? row.exchange}>{row.exchange}</span>
        </div>
        <Show when={rowFlag(row)}>
          <span class="symbol-search-flag" aria-hidden="true">
            <img src={rowFlag(row)!} alt="" crossOrigin="anonymous" onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = "none")} />
          </span>
        </Show>
      </div>
    </div>
  );
}

export function ResultRow(props: { ctx: RowContext; row: FilteredRow; i: () => number }) {
  const { ctx, row, i } = props;
  const { s, props: dlg } = ctx;
  const isActive = () => row.symbolName === dlg.activeSymbol;
  const isHighlighted = () => i() === s.highlightIdx();
  return (
    <div
      data-name="symbol-search-dialog-content-item"
      data-symbol-name={row.symbolName}
      data-type={row.marketType}
      role="option"
      aria-selected={isHighlighted()}
      class={
        "symbol-search-row" +
        (isActive() ? " is-active-symbol" : "") +
        (isHighlighted() ? " is-highlighted" : "") +
        (ctx.flashed() === row.symbolName ? " is-flashed" : "")
      }
      onMouseEnter={() => s.setHighlightIdx(i())}
      onClick={(e) => ctx.commit(row, e.shiftKey)}
    >
      <div class="symbol-search-cell symbol-search-info-cell">
        <span class="symbol-search-marker" aria-hidden="true">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 12" width="14" height="12" fill="currentColor">
            <path d="M14 12l-4-6 4-6H0v12z" />
          </svg>
        </span>
        <span class="symbol-search-logo" aria-hidden="true">
          <Show
            when={row.logoSrc}
            fallback={
              <span class="symbol-search-logo-letter">
                {row.ticker[0]}
              </span>
            }
          >
            <img
              src={row.logoSrc!}
              alt=""
              crossOrigin="anonymous"
              decoding="async"
              onError={(e) =>
                ((e.currentTarget as HTMLImageElement).style.display =
                  "none")
              }
            />
          </Show>
        </span>
        <div class="symbol-search-title-cell" data-no-translate>
          {renderHighlighted(row.ticker, row.titleHighlight)}
        </div>
      </div>

      <div class="symbol-search-cell symbol-search-desc-cell" data-no-translate>
        {renderHighlighted(row.description, row.descriptionHighlight)}
      </div>

      <div class="symbol-search-cell symbol-search-exchange-cell">
        <div class="symbol-search-market-type" data-i18n-sense="market">
          {/* Economic series: no type label (reference). */}
          {row.marketType === "economic" ? "" : row.marketType}
        </div>
        <div class="symbol-search-exchange-source">
          <Show when={row.primaryExchange}>
            <span class="symbol-search-primary-icon" title="Primary exchange" aria-hidden="true">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="14" height="14" fill="none">
                <path fill="currentColor" d="M15 11.5V14H3v-2.5zm-2.25-3.75L15 6v4H3V6l2.25 1.75L9 4z" />
              </svg>
            </span>
          </Show>
          <span
            class="symbol-search-exchange"
            data-no-translate
            title={row.exchangeTooltip ?? row.exchange}
          >
            {row.exchange}
          </span>
        </div>
        <Show when={rowFlag(row)}>
          <span class="symbol-search-flag" aria-hidden="true">
            <img
              src={rowFlag(row)!}
              alt=""
              crossOrigin="anonymous"
              onError={(e) =>
                ((e.currentTarget as HTMLImageElement).style.display =
                  "none")
              }
            />
          </span>
        </Show>
      </div>

      <Show when={s.category() === "local" && !dlg.watchlist && !s.multiMode()}>
        <div class="symbol-search-cell symbol-search-actions-cell">
          <span class="symbol-search-local-actions">
            <button
              type="button"
              class="symbol-search-local-action"
              title="Rename"
              aria-label="Rename"
              onClick={(e) => {
                e.stopPropagation();
                ctx.renameSeries(row.ticker);
              }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
                <path fill="none" stroke="currentColor" d="M11.5 3.5l3 3-8 8H3.5v-3l8-8zM10 5l3 3" />
              </svg>
            </button>
            <button
              type="button"
              class="symbol-search-local-action"
              title="Remove"
              aria-label="Remove"
              onClick={(e) => {
                e.stopPropagation();
                ctx.removeSeries(row.ticker);
              }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
                <path fill="none" stroke="currentColor" d="M3 5h12M7 5V3.5h4V5M5 5l.7 9.5h6.6L13 5M7.5 7.5v5M10.5 7.5v5" />
              </svg>
            </button>
          </span>
        </div>
      </Show>
      <Show when={!s.multiMode() && dlg.watchlist}>
        {(wl) => (
          <div class="symbol-search-cell symbol-search-actions-cell">
            <Show
              when={wl().has(row.symbolName)}
              fallback={
                <span
                  role="img"
                  class="symbol-search-action is-add"
                  title="Add to Watchlist"
                  innerHTML={ICON_ADD}
                  onClick={(e) => {
                    e.stopPropagation();
                    ctx.addRow(row);
                    ctx.afterAction(e.shiftKey);
                  }}
                />
              }
            >
              <span
                role="img"
                class="symbol-search-action is-remove"
                title="Remove from Watchlist"
                innerHTML={ICON_REMOVE}
                onClick={(e) => {
                  e.stopPropagation();
                  wl().remove(row.symbolName);
                  ctx.afterAction(e.shiftKey);
                }}
              />
              <span
                role="img"
                class="symbol-search-action is-goto"
                title="Go to symbol"
                innerHTML={ICON_GOTO}
                onClick={(e) => {
                  e.stopPropagation();
                  wl().goTo(row.symbolName);
                  dlg.onClose();
                }}
              />
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}
