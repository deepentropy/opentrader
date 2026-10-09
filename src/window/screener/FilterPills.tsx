/*
 * FilterPills: the pill rows under the screener topbar (the reference desktop app
 * 3.4.1): US market pill, Watchlist pill + divider, one pill per filter, then
 * "Add new filter" (+) and "Reset options" (…).
 *
 * Pill states (34 px, 8 px radius, 16 px text):
 *   inactive  transparent, 1 px #4a4a4a border, #8c8c8c text, caret; hover
 *             #2e2e2e, open #3d3d3d with #dbdbdb text.
 *   active    #f2f2f2, #575757 title + operation icon + bold #000 value, and a
 *             34 px reset (×) area behind a #8c8c8c divider; hover #dbdbdb.
 *   market    like inactive with #dbdbdb text (US flag + primary listing icon).
 * The market pill is static here (US stocks only); the AI pill is not shown.
 */
import { For, Show, createMemo, createSignal } from "solid-js";
import { Icon } from "../../components/Icon";
import { FLAG_HEX, FLAG_SORT_ORDER } from "../../data/watchlist";
import { isDeletedList, watchlistStore, type WatchList } from "../../data/watchlist-store";
import { COLUMN_BY_ID, OPERATION_ICON, emptyFilter, type ColumnRef, type Filter } from "../../data/screener-catalog";
import { isActive, pillOperation, pillTexts } from "../../data/screener-query";
import { screenerStore } from "../../data/screener-store";
import { CategoryMenu } from "./CategoryMenu";
import { FilterEditor } from "./FilterEditor";
import { PopItem, Popover } from "./Popover";

type Props = { has: (field: string) => boolean };

/** Bare tickers of an OpenTrader watchlist (sections + extras). */
export function watchlistTickers(id: string | null): string[] | null {
  if (!id) return null;
  const l = watchlistStore.lists().find((x) => x.id === id);
  if (!l) return null;
  const all = [...l.groups.flatMap((g) => g.rows), ...l.extras].map((r) => r.ticker.split(":").pop() ?? r.ticker);
  return [...new Set(all)];
}

export function FilterPills(props: Props) {
  const screen = screenerStore.screen;
  const [openId, setOpenId] = createSignal<string | null>(null);
  const els = new Map<string, HTMLElement>();
  let addBtn!: HTMLButtonElement;
  let moreBtn!: HTMLButtonElement;

  const toggle = (id: string) => setOpenId(openId() === id ? null : id);
  const close = () => setOpenId(null);

  const updateFilter = (f: Filter) =>
    screenerStore.update((s) => ({ ...s, filters: s.filters.map((x) => (x.id === f.id ? f : x)) }));
  const removeFilter = (id: string) => {
    close();
    screenerStore.update((s) => ({ ...s, filters: s.filters.filter((x) => x.id !== id) }));
  };
  const resetFilter = (f: Filter) => {
    const e = emptyFilter(f.left);
    if (e) updateFilter({ ...e, id: f.id });
  };
  const addFilter = (col: ColumnRef) => {
    const f = emptyFilter(col);
    if (!f) return;
    screenerStore.update((s) => ({ ...s, filters: [...s.filters, f] }));
    setOpenId(f.id);
  };

  const activeCount = () => screen().filters.filter(isActive).length;
  const inactiveCount = () => screen().filters.length - activeCount();

  const watchlist = () => {
    const id = screen().watchlistId;
    return id ? watchlistStore.lists().find((l) => l.id === id) : undefined;
  };
  // The lists to screen on: the colour lists first, in colour order (the Red
  // list always, the others when they hold symbols), then the user's lists
  // by name; the chosen one goes first. "Deleted symbols" is not one of them.
  const watchlistOptions = () => {
    const all = watchlistStore.lists();
    const isColor = (l: WatchList) => l.id.startsWith("color-");
    const size = (l: WatchList) => l.extras.length + l.groups.reduce((n, g) => n + g.rows.length, 0);
    const at = (l: WatchList) => FLAG_SORT_ORDER.indexOf(l.flag!);
    const lists = [
      ...all.filter((l) => isColor(l) && (l.flag === "red" || size(l) > 0)).sort((a, b) => at(a) - at(b)),
      ...all.filter((l) => !isColor(l) && !isDeletedList(l.id)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
    ];
    const sel = lists.findIndex((l) => l.id === screen().watchlistId);
    if (sel > 0) lists.unshift(...lists.splice(sel, 1));
    return lists;
  };

  // Pills and editors are keyed by filter id so an edit keeps the pill element
  // (the open popover's anchor) and the editor's focus.
  const ids = createMemo(
    () => screen().filters.filter((f) => !!COLUMN_BY_ID[f.left.id]).map((f) => f.id),
    [],
    { equals: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]) },
  );
  const byId = (id: string) => screen().filters.find((x) => x.id === id);
  /** The code + name checkbox list (Index) opens 360 px wide. */
  const wide = (id: string) => {
    const cfg = COLUMN_BY_ID[byId(id)?.left.id ?? ""]?.filter;
    return cfg?.type === "CheckboxGroup" && !!cfg.codes;
  };

  const filterPill = (id: string) => {
    const f = () => byId(id)!;
    const active = () => isActive(f());
    const texts = () => pillTexts(f());
    const def = () => COLUMN_BY_ID[f().left.id];
    return (
      <div
        ref={(el) => els.set(id, el)}
        class="scr-pill"
        classList={{ "is-active": active(), "is-open": openId() === id }}
      >
        <button
          type="button"
          class="scr-pill-main"
          data-name={`screener-filter-pill-${id}`}
          aria-expanded={openId() === id}
          onClick={() => toggle(id)}
        >
          <Show when={texts().primary}>
            <span class="scr-pill-text">{texts().primary}</span>
          </Show>
          <Show when={active() && f().type === "CheckboxGroup" && texts().value}>
            <span class="scr-pill-value">{texts().value}</span>
          </Show>
          <Show when={active() && f().type === "CheckboxGroup" && !texts().value}>
            <span class="scr-pill-counter">{(f() as Extract<Filter, { type: "CheckboxGroup" }>).values.length}</span>
          </Show>
          <Show when={active() && f().type === "Condition"}>
            <span class="scr-pill-icon">
              <Icon name={`scr-op-${OPERATION_ICON[pillOperation(f() as Extract<Filter, { type: "Condition" }>)]}`} size={18} />
            </span>
            <span class="scr-pill-value">{texts().value}</span>
          </Show>
          <Show when={!active()}>
            <span class="scr-pill-caret"><Icon name="scr-pill-caret" size={18} /></span>
          </Show>
        </button>
        <Show when={active()}>
          <button type="button" class="scr-pill-x" aria-label={`Reset ${def()?.short ?? ""}`} onClick={() => resetFilter(f())}>
            <Icon name="scr-pill-remove" size={18} />
          </button>
        </Show>
      </div>
    );
  };

  let wlEl!: HTMLDivElement;
  return (
    <div class="scr-pills">
      {/* Market: static US pill (flag, name, primary listing marker). */}
      <div class="scr-pill scr-pill--market" aria-label="Market: USA, primary listing">
        <span class="scr-pill-main is-static">
          <span class="scr-pill-flag"><Icon name="scr-flag-us" size={18} /></span>
          <span class="scr-pill-text">US</span>
          <span class="scr-pill-icon"><Icon name="scr-market-primary" size={18} /></span>
        </span>
      </div>
      <div class="scr-pills-watchlist">
        <div ref={wlEl} class="scr-pill" classList={{ "is-active": !!watchlist(), "is-open": openId() === "watchlist" }}>
          <button type="button" class="scr-pill-main" aria-expanded={openId() === "watchlist"} onClick={() => toggle("watchlist")}>
            <Show when={watchlist()} keyed fallback={<span class="scr-pill-text">Watchlist</span>}>
              {(l) => (
                <>
                  <Show when={l.flag}>
                    <span class="scr-pill-flag" style={{ color: FLAG_HEX[l.flag!] }}><Icon name="scr-flag" /></span>
                  </Show>
                  <span class="scr-pill-value">{l.name.length > 32 ? `${l.name.slice(0, 32)}…` : l.name}</span>
                </>
              )}
            </Show>
            <Show when={!watchlist()}>
              <span class="scr-pill-caret"><Icon name="scr-pill-caret" size={18} /></span>
            </Show>
          </button>
          <Show when={watchlist()}>
            <button
              type="button"
              class="scr-pill-x"
              aria-label="Reset watchlist"
              onClick={() => screenerStore.update((s) => ({ ...s, watchlistId: null }))}
            >
              <Icon name="scr-pill-remove" size={18} />
            </button>
          </Show>
        </div>
        <div class="scr-pills-divider" />
      </div>
      <For each={ids()}>{(id) => filterPill(id)}</For>
      <div class="scr-pills-controls">
        <button
          ref={addBtn}
          type="button"
          class="scr-light-btn scr-light-btn--secondary"
          classList={{ "is-icon-only": screen().filters.length > 0, "is-open": openId() === "add" }}
          title="Add new filter"
          aria-label="Add new filter"
          onClick={() => toggle("add")}
        >
          <Icon name="scr-add" size={28} />
          <Show when={screen().filters.length === 0}>
            <span class="scr-light-btn-text">Add filter</span>
          </Show>
        </button>
        <Show when={activeCount() > 0 || inactiveCount() > 0}>
          <button
            ref={moreBtn}
            type="button"
            class="scr-light-btn scr-light-btn--ghost is-icon-only"
            classList={{ "is-open": openId() === "more" }}
            title="Reset options"
            aria-label="Reset options"
            onClick={() => toggle("more")}
          >
            <Icon name="scr-more" size={28} />
          </button>
        </Show>
      </div>

      {/* Popovers */}
      <Show when={openId() === "watchlist"}>
        <Popover anchor={wlEl} onClose={close} width={212} class="scr-watchlist-pop">
          <div class="scr-editor-header"><div class="scr-editor-title">Watchlist</div></div>
          <div class="scr-pop-scroll" role="listbox">
            <For each={watchlistOptions()}>
              {(l) => (
                <div
                  role="option"
                  aria-selected={l.id === screen().watchlistId}
                  class="scr-item"
                  classList={{ "is-selected": l.id === screen().watchlistId }}
                  onClick={() => {
                    screenerStore.update((s) => ({ ...s, watchlistId: l.id }));
                    close();
                  }}
                >
                  <Show when={l.flag}>
                    <span class="scr-item-flag" style={{ color: FLAG_HEX[l.flag!] }}><Icon name="scr-flag" /></span>
                  </Show>
                  <span class="scr-item-text"><span class="scr-item-title">{l.name}</span></span>
                  <span class="scr-item-right"><span class="scr-item-count">{watchlistTickers(l.id)?.length ?? 0}</span></span>
                </div>
              )}
            </For>
          </div>
        </Popover>
      </Show>
      {/* Plain condition (no narrowed accessor): the editor reads the filter
          from the store, so a late read while the popover closes is safe. */}
      <For each={ids()}>
        {(id) => (
          <Show when={openId() === id && !!byId(id)}>
            <Popover anchor={els.get(id)} onClose={close} width={wide(id) ? 360 : 320}>
              <FilterEditor filter={byId(id)!} has={props.has} onChange={updateFilter} onRemove={() => removeFilter(id)} onClose={close} />
            </Popover>
          </Show>
        )}
      </For>
      <Show when={openId() === "add"}>
        <CategoryMenu anchor={addBtn} kind="filters" has={props.has} onPick={addFilter} onClose={close} />
      </Show>
      <Show when={openId() === "more"}>
        <Popover anchor={moreBtn} onClose={close}>
          <PopItem
            title="Reset all filters"
            disabled={activeCount() === 0}
            onClick={() => {
              screenerStore.update((s) => ({ ...s, filters: s.filters.map((f) => ({ ...(emptyFilter(f.left) ?? f), id: f.id })) }));
              close();
            }}
          />
          <Show when={inactiveCount() > 0 && activeCount() > 0}>
            <PopItem
              title={`Remove ${inactiveCount()} inactive filter${inactiveCount() === 1 ? "" : "s"}`}
              onClick={() => {
                screenerStore.update((s) => ({ ...s, filters: s.filters.filter(isActive) }));
                close();
              }}
            />
          </Show>
          <PopItem
            title="Remove all filters"
            disabled={screen().filters.length === 0}
            onClick={() => {
              screenerStore.update((s) => ({ ...s, filters: [] }));
              close();
            }}
          />
        </Popover>
      </Show>
    </div>
  );
}
