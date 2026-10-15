/*
 * Watchlist — right-rail panel listing tracked symbols with last price and
 * change. Static seed values; live last-price overlay via
 * Feature 9 (live trades). Row click → updates the active chart symbol.
 *
 * Settings (Feature: watchlist settings, ported from the reference mock): the
 * header gear opens WatchlistSettingsMenu — Table/tile view, customizable
 * columns, logo toggle, Symbol/Name display. Persisted to localStorage.
 *
 * The panel's parts (columns, cells, sort, selection, sections, drag and
 * drop, menus, rows, headers) live in watchlist/; they share the panel's
 * state through watchlist/context.ts.
 */
import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { PanelHeader } from "../../components/PanelHeader";
import { IconButton } from "../../components/IconButton";
import {
  HEADER_ITEMS,
  WL_COLUMNS,
  WL_ICONS,
  type SortKey,
  type WlSettings,
} from "../../data/watchlist";
import {
  watchlistStore,
  isSectionId,
  isDeletedList,
  sectionId,
  sectionNameOf,
  type AddAnchor,
  type WatchList,
} from "../../data/watchlist-store";
import { showConfirm } from "../../components/Dialogs";
import { WatchlistSettingsMenu } from "./WatchlistSettingsMenu";
import { WatchlistMenu } from "./WatchlistMenu";
import { SectionContextMenu, WatchlistContextMenu } from "./WatchlistContextMenu";
import { SymbolSearchDialog } from "../header/SymbolSearchDialog";
import { OpenListDialog } from "./OpenListDialog";
import { AddAlertDialog } from "./AddAlertDialog";
import * as kv from "../../data/kv";
import { SETTINGS_KEY, loadSettings } from "./watchlist/prefs";
import { listAlertListeners, type ListAlertListener } from "./watchlist/list-alerts";
import { ListMarker } from "./watchlist/markers";
import { attach, type WatchlistCore, type WatchlistCx, type WatchlistProps } from "./watchlist/context";
import { createColumns } from "./watchlist/columns";
import { createCells } from "./watchlist/cells";
import { createSort } from "./watchlist/sort";
import { createSelection } from "./watchlist/selection";
import { createSections } from "./watchlist/sections";
import { createDrag } from "./watchlist/drag";
import { createAddSymbols } from "./watchlist/add-symbols";
import { createListActions } from "./watchlist/list-actions";
import { createKeyboard } from "./watchlist/keyboard";
import { createRowMenus } from "./watchlist/row-menus";
import { createRows } from "./watchlist/rows";
import { createHeaders } from "./watchlist/headers";

export function Watchlist(props: WatchlistProps) {
  const watchlistsHeader = HEADER_ITEMS.find((h) => h.dataName === "watchlists-button");
  const activeWatchlist = watchlistsHeader?.currentValue ?? "Watchlist";
  const actionItems = HEADER_ITEMS.filter((h) => h.dataName !== "watchlists-button");

  // ── Active list (multi-list store) ──
  // The store owns the lists + which one is active and persists to localStorage.
  // Its sections/extras drive the rows; its marker drives the header + toolbar.
  const active = (): WatchList | undefined => watchlistStore.active();
  const groups = () => active()?.groups ?? [];
  const extras = () => active()?.extras ?? [];
  const listName = () => active()?.name ?? activeWatchlist;
  const allRows = () => extras().concat(groups().flatMap((g) => g.rows));

  // Inline header rename (the menu's "Rename" action edits the active list name).
  const [renamingList, setRenamingList] = createSignal(false);
  const [listDraft, setListDraft] = createSignal("");

  const [settings, setSettings] = createSignal<WlSettings>(loadSettings());
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [menuOpen, setMenuOpen] = createSignal(false);
  // "Add symbol" search dialog + where its symbols are inserted (anchor:
  // header button = end of list, section menu = top of that section, row
  // menu = right after that row).
  const [addOpen, setAddOpen] = createSignal(false);
  const [addAnchor, setAddAnchor] = createSignal<AddAnchor>(null);
  // "Deleted symbols" takes no symbol by hand, no section and no new name.
  const inDeleted = () => isDeletedList(watchlistStore.activeId());
  const openAdd = (anchor: AddAnchor) => {
    if (inDeleted()) return;
    setAddAnchor(anchor);
    setAddOpen(true);
  };
  // "Open list…" picker + "Add alert…" dialog (watchlist menu actions).
  const [openListOpen, setOpenListOpen] = createSignal(false);
  const [alertOpen, setAlertOpen] = createSignal(false);
  // Sort (table header, tile-view "Sort by" menu). A sort re-orders the rows of
  // the active list once, with the values of that moment, and the result is
  // the list's order: later price ticks move no row. "default" goes back to
  // the order from before the sort.
  const sortBy = (): SortKey => active()?.sort ?? "default";
  const setSortBy = (next: SortKey | ((cur: SortKey) => SortKey)): void => {
    const key = typeof next === "function" ? next(sortBy()) : next;
    if (key === "default") watchlistStore.resetSort();
    else watchlistStore.applySort(key, (rows) => sortRows(key, rows));
  };
  const [sortMenuOpen, setSortMenuOpen] = createSignal(false);
  let sortWrapEl: HTMLDivElement | undefined;
  onMount(() => {
    const onDown = (e: PointerEvent) => {
      if (sortMenuOpen() && sortWrapEl && !sortWrapEl.contains(e.target as Node)) setSortMenuOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    onCleanup(() => window.removeEventListener("pointerdown", onDown));
  });
  // Hidden file input backing the menu's "Upload list…" action.
  let uploadInput: HTMLInputElement | undefined;

  // ── Transient toast (share confirmation, alert firing) ──
  const [toast, setToast] = createSignal<string | null>(null);
  let toastTimer: number | undefined;
  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => setToast(null), 3000);
  };
  onCleanup(() => {
    if (toastTimer) clearTimeout(toastTimer);
  });
  // Surface module-singleton list-alert fires as an in-panel toast while mounted
  // (the singleton raises the OS notification itself, mounted or not).
  onMount(() => {
    const onFire: ListAlertListener = (title, body) => showToast(`${title}: ${body}`);
    listAlertListeners.add(onFire);
    onCleanup(() => listAlertListeners.delete(onFire));
  });
  createEffect(() => {
    try {
      kv.setItem(SETTINGS_KEY, JSON.stringify(settings()));
    } catch {
      /* best-effort */
    }
  });
  // Live cross-window sync for the view prefs (raw signal setters; the persist
  // effects above then re-write identical strings, which kv.setItem dedups).
  onCleanup(kv.onExternalChange(SETTINGS_KEY, () => setSettings(loadSettings())));
  // (Sort is per-list now — synced via the watchlist store's own cross-window sync.)

  /** Visible data columns (after the fixed Symbol column), in display order —
   *  driven by the gear's per-column checkboxes. */
  const visibleCols = () =>
    WL_COLUMNS.filter((c) => settings().columns[c.key]);

  /** Favourited lists — shown icon-only in the quick-switch bar under the title. */
  const favoriteLists = () => watchlistStore.lists().filter((l) => l.favorite);

  // Shared context of the panel's parts (watchlist/*.ts): live accessors of
  // the state above; each part adds its functions when it is created.
  const cx = {
    props,
    get active() { return active; },
    get addAnchor() { return addAnchor; },
    get allRows() { return allRows; },
    get extras() { return extras; },
    get groups() { return groups; },
    get inDeleted() { return inDeleted; },
    get listDraft() { return listDraft; },
    get listName() { return listName; },
    get setAddAnchor() { return setAddAnchor; },
    get setAlertOpen() { return setAlertOpen; },
    get setListDraft() { return setListDraft; },
    get setOpenListOpen() { return setOpenListOpen; },
    get setRenamingList() { return setRenamingList; },
    get setSortBy() { return setSortBy; },
    get setSortMenuOpen() { return setSortMenuOpen; },
    get settings() { return settings; },
    get showToast() { return showToast; },
    get sortBy() { return sortBy; },
    get sortMenuOpen() { return sortMenuOpen; },
    get sortWrapEl() { return sortWrapEl; }, set sortWrapEl(v: WatchlistCore["sortWrapEl"]) { sortWrapEl = v; },
    get uploadInput() { return uploadInput; }, set uploadInput(v: WatchlistCore["uploadInput"]) { uploadInput = v; },
    get visibleCols() { return visibleCols; },
  } as WatchlistCx;

  const { guide } = attach(cx, createColumns(cx));
  attach(cx, createCells(cx));
  const { sortRows } = attach(cx, createSort(cx));
  const { chartRow, removeFromButton, selection } = attach(cx, createSelection(cx));
  const { isCollapsed, startRename } = attach(cx, createSections(cx));
  const { dragAt, dragIds, onRowsDragEnd, onRowsDragOver, onRowsDrop } = attach(cx, createDrag(cx));
  const { addMany, addSymbol, goToSymbol, removeSymbolFromDialog } = attach(cx, createAddSymbols(cx));
  const {
    addAlert,
    addSection,
    clearList,
    commitListRename,
    copyList,
    createList,
    onUploadFile,
    openList,
    removeAlert,
    renameList,
    saveAlert,
    uploadList,
  } = attach(cx, createListActions(cx));
  const { onListKeyDown } = attach(cx, createKeyboard(cx));
  const {
    createListWithItems,
    ctxIds,
    ctxLists,
    ctxMenu,
    openNoteFor,
    sectionCtx,
    setCtxMenu,
    setSectionCtx,
    toggleFlags,
    toggleItemsInList,
  } = attach(cx, createRowMenus(cx));
  const { groupHeader, tableRow, tileRow } = attach(cx, createRows(cx));
  const { ColumnHeaders, TileHeader } = attach(cx, createHeaders(cx));

  return (
    <aside ref={cx.asideEl} class="ot-rail-panel watchlist" aria-label="Watchlist" style={{ position: "relative" }}>
      {/* Guide line under a hovered or dragged column divider. */}
      <Show when={guide()}>
        {(g) => <div class="watchlist-col-guide" aria-hidden="true" style={{ left: `${g().x}px`, top: `${g().top}px` }} />}
      </Show>
      <PanelHeader
        ariaLabel="Watchlist header"
        left={
          <Show
            when={renamingList()}
            fallback={
              <button
                class={"watchlist-name" + (menuOpen() ? " is-open" : "")}
                data-name="watchlists-button"
                type="button"
                aria-haspopup="menu"
                aria-expanded={menuOpen()}
                onClick={() => setMenuOpen((o) => !o)}
              >
                <ListMarker flag={active()?.flag ?? null} emoji={active()?.emoji ?? null} name={listName()} />
                <span class="watchlist-name-label">{listName()}</span>
                <span class="watchlist-name-arrow" aria-hidden="true" innerHTML={WL_ICONS.menuArrow} />
              </button>
            }
          >
            <input
              class="watchlist-name-rename"
              value={listDraft()}
              aria-label="Rename list"
              ref={(el) => queueMicrotask(() => { el.focus(); el.select(); })}
              onInput={(e) => setListDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitListRename();
                else if (e.key === "Escape") setRenamingList(false);
              }}
              onBlur={commitListRename}
            />
          </Show>
        }
        right={
          <For each={actionItems}>
            {(h) => (
              <Tooltip text={h.label ?? ""} side="bottom">
                <IconButton
                  data-name={h.dataName}
                  aria-label={h.label ?? undefined}
                  class={
                    h.dataName === "settings-button" && settingsOpen()
                      ? "is-active"
                      : h.dataName === "add-symbol-button" && inDeleted()
                        ? "is-disabled"
                        : undefined
                  }
                  disabled={h.dataName === "add-symbol-button" && inDeleted()}
                  onClick={() => {
                    if (h.dataName === "settings-button") setSettingsOpen((o) => !o);
                    else if (h.dataName === "add-symbol-button") openAdd(null);
                  }}
                >
                  {h.iconName && <Icon name={h.iconName} size={18} />}
                </IconButton>
              </Tooltip>
            )}
          </For>
        }
      />

      <Show when={menuOpen()}>
        <WatchlistMenu
          lists={watchlistStore.shownLists()}
          activeId={watchlistStore.activeId()}
          onSelectList={(id) => watchlistStore.setActive(id)}
          onClose={() => setMenuOpen(false)}
          disabled={inDeleted() ? ["rename", "add-section"] : []}
          onRenameList={renameList}
          onAddSection={() => addSection(chartRow())}
          onClearList={clearList}
          onCreateList={createList}
          onCopyList={copyList}
          onUploadList={uploadList}
          onAddAlert={addAlert}
          onOpenList={openList}
        />
      </Show>

      <Show when={settingsOpen()}>
        <WatchlistSettingsMenu
          settings={settings()}
          onChange={setSettings}
          onClose={() => setSettingsOpen(false)}
        />
      </Show>

      {/* Quick-switch list toolbar — one round button per saved list; the
          active one is a white pill with the list's marker. Clicking switches
          the active list (multi-list store). */}
      {/* Favourite-lists quick bar: the flagged/favourited lists shown icon-only
          for one-click switching (a row of list markers under the title). */}
      <Show when={favoriteLists().length}>
        <div class="watchlist-tabs" role="toolbar" aria-label="Favourite watchlists">
          <For each={favoriteLists()}>
            {(t) => (
              <Tooltip text={t.name} side="bottom">
                <button
                  type="button"
                  class="watchlist-tab"
                  classList={{ active: t.id === watchlistStore.activeId() }}
                  aria-label={t.name}
                  aria-pressed={t.id === watchlistStore.activeId() || undefined}
                  onClick={() => watchlistStore.setActive(t.id)}
                >
                  <span class="watchlist-tab-round">
                    <ListMarker flag={t.flag} emoji={t.emoji} name={t.name} />
                  </span>
                </button>
              </Tooltip>
            )}
          </For>
        </div>
      </Show>

      <Show
        when={settings().tableView}
        fallback={
          /* ── Tile view (two-line rows, grouped by section) ── */
          <>
          {/* Header: "Symbol" left, "Sort by ⌄" right. The sort menu sorts
              the rows in place. */}
          <TileHeader />
          <div
            class="watchlist-rows"
            role="grid"
            tabindex={0}
            ref={cx.rowsEl}
            onKeyDown={onListKeyDown}
            onDragOver={onRowsDragOver}
            onDrop={onRowsDrop}
            onDragEnd={onRowsDragEnd}
          >
            <For each={extras()}>
              {(r) => tileRow(r, null)}
            </For>
            <For each={groups()}>
              {(g) => (
                <>
                  {groupHeader(g)}
                  <Show when={!isCollapsed(g.name)}>
                    <For each={g.rows}>
                      {(r) => tileRow(r, g.name)}
                    </For>
                  </Show>
                </>
              )}
            </For>
          </div>
          </>
        }
      >
        {/* ── Table view (grouped by section) ── */}
        <ColumnHeaders />
        <div
          class="watchlist-rows"
          role="grid"
          tabindex={0}
          ref={cx.rowsEl}
          onKeyDown={onListKeyDown}
          onDragOver={onRowsDragOver}
          onDrop={onRowsDrop}
          onDragEnd={onRowsDragEnd}
        >
          <For each={extras()}>
            {(r) => tableRow(r, null)}
          </For>
          <For each={groups()}>
            {(g) => (
              <>
                {groupHeader(g)}
                <Show when={!isCollapsed(g.name)}>
                  <For each={g.rows}>
                    {(r) => tableRow(r, g.name)}
                  </For>
                </Show>
              </>
            )}
          </For>
        </div>
      </Show>

      <Show when={addOpen()}>
        <SymbolSearchDialog
          activeSymbol={props.activeSymbol}
          onSelect={addSymbol}
          onClose={() => setAddOpen(false)}
          watchlist={{
            has: (name) => allRows().some((r) => r.ticker === name),
            add: addSymbol,
            addMany,
            remove: removeSymbolFromDialog,
            goTo: goToSymbol,
          }}
        />
      </Show>

      {/* Hidden picker backing the menu's "Upload list…" action. */}
      <input
        ref={uploadInput}
        type="file"
        accept=".txt,.csv,text/plain"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          if (file) onUploadFile(file);
          e.currentTarget.value = ""; // allow re-uploading the same file
        }}
      />

      <Show when={openListOpen()}>
        <OpenListDialog
          lists={watchlistStore.lists()}
          activeId={watchlistStore.activeId()}
          onSelect={(id) => watchlistStore.setActive(id)}
          onClose={() => setOpenListOpen(false)}
        />
      </Show>

      <Show when={alertOpen()}>
        <AddAlertDialog
          listName={listName()}
          initial={watchlistStore.alertFor(watchlistStore.activeId())}
          onSave={saveAlert}
          onRemove={removeAlert}
          onClose={() => setAlertOpen(false)}
        />
      </Show>

      <Show when={ctxMenu()}>
        {(m) => (
          <WatchlistContextMenu
            row={m().row}
            selected={m().selected}
            ids={ctxIds(m())}
            x={m().x}
            y={m().y}
            lists={ctxLists()}
            listHas={(listId, ticker) => watchlistStore.listHas(listId, ticker)}
            onToggleFlag={(rows) => toggleFlags(rows, m().selected != null)}
            onSetFlag={(rows, flag) => rows.forEach((r) => watchlistStore.setRowFlag(r.ticker, flag))}
            onUnflagAll={() =>
              showConfirm({
                title: "Unflag all symbols?",
                text: "Doing this will unflag all symbols from all your watchlists.",
                mainText: "Unflag",
                cancelText: "Cancel",
                intent: "danger",
                onConfirm: () => watchlistStore.clearAllFlags(),
              })
            }
            onToggleList={(listId) => toggleItemsInList(listId, ctxIds(m()))}
            onCreateListWith={() => createListWithItems(ctxIds(m()))}
            canCompare={!!props.onAddCompare && (m().selected == null || selection().length <= 10)}
            onAddCompare={(rows) => props.onAddCompare?.(rows.map((r) => r.ticker))}
            onAddNote={openNoteFor}
            canAdd={!inDeleted()}
            onAddSection={() => addSection(m().row?.ticker ?? sectionId(m().section!))}
            onAddSymbol={() => openAdd(m().row ? { section: m().section, after: m().row!.ticker } : { section: m().section! })}
            onClose={() => setCtxMenu(null)}
          />
        )}
      </Show>

      <Show when={sectionCtx()}>
        {(m) => (
          <SectionContextMenu
            name={m().name}
            x={m().x}
            y={m().y}
            onRename={(name) => startRename(name)}
            canRemove={!isCollapsed(m().name)}
            onRemove={(name) => removeFromButton(sectionId(name))}
            onAddSymbol={() => openAdd({ section: m().name })}
            onClose={() => setSectionCtx(null)}
          />
        )}
      </Show>

      <Show when={dragIds().length > 0 && dragAt()}>
        {(at) => (
          <Portal>
            <div class="watchlist-drag-image" aria-hidden="true" style={{ transform: `translate(${at().x}px, ${at().y}px)` }}>
              <For each={dragIds()}>
                {(id) => (
                  <div class="watchlist-drag-item" classList={{ "watchlist-drag-item--section": isSectionId(id) }}>
                    {isSectionId(id) ? sectionNameOf(id) : id.slice(id.indexOf(":") + 1)}
                  </div>
                )}
              </For>
            </div>
          </Portal>
        )}
      </Show>

      <Show when={toast()}>
        <div class="watchlist-toast" role="status">{toast()}</div>
      </Show>
    </aside>
  );
}