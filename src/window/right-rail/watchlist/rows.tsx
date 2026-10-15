/*
 * Watchlist rows: a section header and a symbol row in the table view or the
 * tile view (the same handlers in both views).
 */
import { For, Show } from "solid-js";
import { WL_ICONS, type Group, type Row } from "../../../data/watchlist";
import { sectionId } from "../../../data/watchlist-store";
import { flagOf } from "../../../data/symbol-flags";
import { FlagMarker } from "./markers";
import { type WatchlistCx } from "./context";
import type { JSX } from "solid-js";

/** What createRows adds to the watchlist context. */
export interface RowsApi {
  groupHeader: (g: Group) => JSX.Element;
  tableRow: (r: Row, section: string | null) => JSX.Element;
  tileRow: (r: Row, section: string | null) => JSX.Element;
}

export function createRows(cx: WatchlistCx): RowsApi {
  const {
    cellFor,
    clickItem,
    commitRename,
    dotClass,
    draft,
    dropAfter,
    dropBefore,
    gridTemplate,
    highlighted,
    isCollapsed,
    isDragging,
    isHighlighted,
    isSectionSelected,
    isSelected,
    lastForRow,
    nameFor,
    onItemDragStart,
    onTitleClick,
    openContext,
    openSectionContext,
    primaryLabel,
    removeFromButton,
    renaming,
    selectRow,
    setDraft,
    setRenaming,
    settings,
    toggleCollapse,
    visibleCols,
  } = cx;
  // ── Per-section + per-row renderers (shared by table and tile views) ──
  // One section header: chevron (collapse), label / inline rename input, and a
  // remove button shown while the pointer is over the header (none on a
  // collapsed section).
  const groupHeader = (g: Group) => (
    <div
      class="watchlist-group"
      classList={{
        renaming: renaming() === g.name,
        highlighted: highlighted().has(sectionId(g.name)),
        selected: isSectionSelected(g.name) && renaming() !== g.name,
        dragging: isDragging(sectionId(g.name)),
        "drop-before": dropBefore(sectionId(g.name)),
        "drop-after": dropAfter(sectionId(g.name)),
      }}
      role="row"
      data-item-id={sectionId(g.name)}
      draggable={renaming() !== g.name}
      onClick={(e) => onTitleClick(e, g.name)}
      onContextMenu={(e) => openSectionContext(e, g.name)}
      onDragStart={(e) => onItemDragStart(e, sectionId(g.name))}
    >
      <button
        type="button"
        class="watchlist-group-expand"
        classList={{ collapsed: isCollapsed(g.name) }}
        aria-label={isCollapsed(g.name) ? "Expand section" : "Collapse section"}
        aria-expanded={!isCollapsed(g.name)}
        onClick={(e) => {
          e.stopPropagation();
          toggleCollapse(g.name);
        }}
        innerHTML={WL_ICONS.chevron}
      />
      <Show
        when={renaming() === g.name}
        fallback={<span class="watchlist-group-label">{g.name}</span>}
      >
        <input
          class="watchlist-group-rename"
          value={draft()}
          aria-label="Rename section"
          ref={(el) => queueMicrotask(() => el.focus())}
          onClick={(e) => e.stopPropagation()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            else if (e.key === "Escape") setRenaming(null);
          }}
          onBlur={commitRename}
        />
      </Show>
      <Show when={!isCollapsed(g.name)}>
        <button
          type="button"
          class="watchlist-group-delete"
          aria-label="Delete section"
          title="Delete section"
          onClick={(e) => {
            e.stopPropagation();
            removeFromButton(sectionId(g.name));
          }}
          innerHTML={WL_ICONS.trash}
        />
      </Show>
    </div>
  );

  // Remove-from-list trash — hidden until the row is hovered. Stops
  // propagation so removing doesn't also select.
  const removeButton = (onRemove: () => void) => (
    <button
      type="button"
      class="watchlist-row-remove"
      aria-label="Remove from list"
      title="Remove from list"
      innerHTML={WL_ICONS.trash}
      onClick={(e) => {
        e.stopPropagation();
        onRemove();
      }}
    />
  );

  // One table-view symbol row (dynamic column grid).
  const tableRow = (r: Row, section: string | null) => (
    <div
      role="row"
      class="watchlist-row"
      classList={{
        selected: isSelected(r),
        highlighted: isHighlighted(r),
        dragging: isDragging(r.ticker),
        "drop-before": dropBefore(r.ticker),
        "drop-after": dropAfter(r.ticker),
      }}
      data-symbol-full={r.ticker}
      data-symbol-short={r.short}
      data-item-id={r.ticker}
      aria-selected={isSelected(r) || undefined}
      style={{ "grid-template-columns": gridTemplate() }}
      draggable={true}
      onClick={(e) => {
        if (clickItem(e, r.ticker)) selectRow(r.ticker);
      }}
      onContextMenu={(e) => openContext(e, r, section)}
      onDragStart={(e) => onItemDragStart(e, r.ticker)}
    >
      <Show when={flagOf(r.ticker)}>{(f) => <FlagMarker flag={f()} />}</Show>
      <div class="watchlist-cell watchlist-symbol">
        <Show when={settings().logo}>
          <span class="ot-ticker-logo ot-ticker-logo--sm watchlist-logo" aria-hidden="true">{r.short.charAt(0)}</span>
        </Show>
        <span class="watchlist-ticker">{primaryLabel(r)}</span>
        <Show when={dotClass(r)}>
          {(c) => <span class={c()} aria-hidden="true" />}
        </Show>
      </div>
      <For each={visibleCols()}>
        {(c) => {
          // Derived accessor (not a one-shot const): each JSX read re-runs
          // cellFor → lastForRow → quoteFor, so live ticks re-render the cell.
          const cell = () => cellFor(r, c.key);
          return (
            <div class={`watchlist-cell ${cell().tint ?? ""}`} style={{ "text-align": "right" }}>
              {cell().text}
            </div>
          );
        }}
      </For>
      {removeButton(() => removeFromButton(r.ticker))}
    </div>
  );

  // One tile-view symbol row (two-line card): ticker + last on top, company
  // name + abs-change + change% below.
  const tileRow = (r: Row, section: string | null) => {
    const chg = () => cellFor(r, "change");
    const pct = () => cellFor(r, "change_percent");
    return (
      <div
        role="row"
        class="watchlist-tile"
        classList={{
          selected: isSelected(r),
          highlighted: isHighlighted(r),
          dragging: isDragging(r.ticker),
          "drop-before": dropBefore(r.ticker),
          "drop-after": dropAfter(r.ticker),
        }}
        data-symbol-full={r.ticker}
        data-item-id={r.ticker}
        aria-selected={isSelected(r) || undefined}
        draggable={true}
        onClick={(e) => {
          if (clickItem(e, r.ticker)) selectRow(r.ticker);
        }}
        onContextMenu={(e) => openContext(e, r, section)}
        onDragStart={(e) => onItemDragStart(e, r.ticker)}
      >
        <Show when={flagOf(r.ticker)}>{(f) => <FlagMarker flag={f()} />}</Show>
        <Show when={settings().logo}>
          <span class="ot-ticker-logo ot-ticker-logo--md watchlist-logo" aria-hidden="true">{r.short.charAt(0)}</span>
        </Show>
        <div class="watchlist-tile-main">
          <div class="watchlist-tile-line">
            <span class="watchlist-tile-ticker">{r.short}</span>
            <Show when={dotClass(r)}>
              {(c) => <span class={c()} aria-hidden="true" />}
            </Show>
            <span class="watchlist-tile-last">{lastForRow(r)}</span>
          </div>
          <div class="watchlist-tile-line watchlist-tile-line--sub">
            <span class="watchlist-tile-name">{nameFor(r)}</span>
            <span class={`watchlist-tile-change ${chg().tint ?? ""}`}>{chg().text}</span>
            <span class={`watchlist-tile-pct ${pct().tint ?? ""}`}>{pct().text}</span>
          </div>
        </div>
        {removeButton(() => removeFromButton(r.ticker))}
      </div>
    );
  };

  return { groupHeader, tableRow, tileRow };
}
