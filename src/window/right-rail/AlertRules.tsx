import { translate, translateWith } from "../../i18n/translator";
/*
 * Alerts panel, "Alerts" view: the toolbar row (create on the left; search,
 * sort, options on the right) and the list of alerts: the alert rules and
 * the watchlist alerts (a list's price-move threshold, watchlist-store).
 *
 * Row, as the reference app draws it: the alert's name (bold) and its
 * message (or condition), then the attributes line: instrument logo (a list
 * icon for a watchlist alert), "TICKER, interval" ("List, 1D"), the status
 * (Active / Inactive, "Paused — Cloned" for a copy), the source icon (the
 * indicator or drawing the alert reads) and the last trigger time, separated
 * by dots. A click shows the alert's symbol and interval on the chart (a
 * screen alert opens its editor, a watchlist alert does nothing); a double
 * click on a watchlist alert edits it. On hover: Pause or Restart, Edit,
 * Delete, over the end of the text. Right-click: Pause or Restart, Edit…,
 * Clone (a paused copy; not for a watchlist alert), Delete, then the actions
 * on the whole filtered list and "Delete all inactive".
 * Sort: symbol, name, message (A to Z / Z to A), date created and time
 * triggering (oldest / newest first); date created, oldest first by default.
 * Options: Restart / Pause as per filter, Delete all inactive, then the
 * sections Show alerts (All / Active only / Inactive only), Filter alerts
 * (Current symbol, Current time interval), Show alerts by type (Price: price
 * against a value; Technicals: an alert on an indicator or a drawing;
 * Watchlist),
 * Customize list (the row parts) and "Alerts settings...". Sort, filters and
 * row parts are kept across sessions; the Options button counts the filters
 * applied.
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { tickerOf } from "../../data/symbol-name";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { IconButton } from "../../components/IconButton";
import { alertStore, type AlertRule, type Operand } from "../../data/alert-store";
import { watchlistStore, clearFiredForList } from "../../data/watchlist-store";
import { AddAlertDialog } from "./AddAlertDialog";
import { defaultAlertMessage, ruleConditions } from "../../data/alert-condition";
import { intervalLabel } from "../../data/datafeed";
import { loadDrawings } from "../drawings/persistence";
import { iconForKind } from "../drawings/labels";
import * as kv from "../../data/kv";
import { emitAppEvent } from "../../data/app-events";
import { GLYPH, MenuAction, MenuSection, MenuSep, MenuSort, MenuToggle } from "./alerts-menu";
import { createPopover } from "../../components/popover";

type SortKey = "symbol" | "name" | "message" | "created" | "triggered";
type Sort = { key: SortKey; desc: boolean };
type Status = "all" | "active" | "inactive";
type Filters = {
  status: Status;
  symbol: boolean;
  interval: boolean;
  /** Types shown. */
  price: boolean;
  technicals: boolean;
  watchlist: boolean;
  /** Row parts shown. */
  name: boolean;
  message: boolean;
  source: boolean;
  logo: boolean;
  triggered: boolean;
};
type Part = "price" | "technicals" | "watchlist" | "name" | "message" | "source" | "logo" | "triggered";
const DEFAULT_FILTERS: Filters = { status: "all", symbol: false, interval: false, price: true, technicals: true, watchlist: true, name: true, message: true, source: true, logo: true, triggered: false };

/** "Technicals": a condition on a study, a compared symbol or a drawing (any of an alert's conditions). */
export const isTechnical = (r: AlertRule) => ruleConditions(r).some((c) => c.left.kind !== "price" || c.right.kind === "indicator" || c.right.kind === "drawing");

const SORTS: { key: SortKey; desc: boolean; label: string }[] = [
  { key: "symbol", desc: false, label: "Symbol (A to Z)" },
  { key: "symbol", desc: true, label: "Symbol (Z to A)" },
  { key: "name", desc: false, label: "Name (A to Z)" },
  { key: "name", desc: true, label: "Name (Z to A)" },
  { key: "message", desc: false, label: "Message (A to Z)" },
  { key: "message", desc: true, label: "Message (Z to A)" },
  { key: "created", desc: false, label: "Date created (oldest first)" },
  { key: "created", desc: true, label: "Date created (newest first)" },
  { key: "triggered", desc: false, label: "Time triggering (oldest first)" },
  { key: "triggered", desc: true, label: "Time triggering (newest first)" },
];
const sortLabel = (s: Sort) => SORTS.find((x) => x.key === s.key && x.desc === s.desc)?.label ?? SORTS[6].label;

const VIEW_KEY = "ot:alerts:list-view:v1";
function loadView(): { sort: Sort; filters: Filters } {
  const base = { sort: { key: "created" as SortKey, desc: false }, filters: DEFAULT_FILTERS };
  try {
    const v = JSON.parse(kv.getItem(VIEW_KEY) ?? "null") as { sort?: Sort; filters?: Filters } | null;
    if (!v) return base;
    const sort = v.sort && SORTS.some((x) => x.key === v.sort!.key) ? { key: v.sort.key, desc: !!v.sort.desc } : base.sort;
    const f = v.filters;
    const status: Status = f?.status === "active" || f?.status === "inactive" ? f.status : "all";
    const on = (k: Part) => (typeof f?.[k] === "boolean" ? f[k] : DEFAULT_FILTERS[k]);
    return {
      sort,
      filters: { status, symbol: !!f?.symbol, interval: !!f?.interval, price: on("price"), technicals: on("technicals"), watchlist: on("watchlist"), name: on("name"), message: on("message"), source: on("source"), logo: on("logo"), triggered: on("triggered") },
    };
  } catch {
    return base;
  }
}

// One alerts panel per window: its list view state lives here, shared by the
// toolbar and the list.
const initial = loadView();
const [sort, setSortSignal] = createSignal<Sort>(initial.sort);
const [filters, setFiltersSignal] = createSignal<Filters>(initial.filters);
const [search, setSearch] = createSignal("");
const [searchOpen, setSearchOpen] = createSignal(false);
const persist = () => {
  try {
    kv.setItem(VIEW_KEY, JSON.stringify({ sort: sort(), filters: filters() }));
  } catch {
    /* best-effort */
  }
};
const setSort = (s: Sort) => { setSortSignal(s); persist(); };
const setFilters = (f: Filters) => { setFiltersSignal(f); persist(); };
const flip = (k: Exclude<keyof Filters, "status">) => setFilters({ ...filters(), [k]: !filters()[k] });

/** Filters applied (the Options button's count). */
const filterCount = () => {
  const f = filters();
  return (f.status !== "all" ? 1 : 0) + (f.symbol ? 1 : 0) + (f.interval ? 1 : 0) + (f.price ? 0 : 1) + (f.technicals ? 0 : 1) + (f.watchlist ? 0 : 1);
};

/** Chart context of the "Current symbol" / "Current time interval" filters. */
export type AlertListContext = { symbol: string; interval: string };

const ruleText = (r: AlertRule) => r.message || defaultAlertMessage(r);

/** A watchlist alert: notify when a symbol of the list moves by the threshold. */
type ListAlert = { listId: string; name: string; threshold: number; createdAt: number; enabled: boolean };
/** A row of the list: an alert rule or a watchlist alert. */
type Item = { kind: "rule"; rule: AlertRule } | { kind: "list"; list: ListAlert };

/** Id of a row: the rule's, or the one its log events carry ("list:<id>"). */
const itemId = (i: Item) => (i.kind === "rule" ? i.rule.id : `list:${i.list.listId}`);
const itemEnabled = (i: Item) => (i.kind === "rule" ? i.rule.enabled : i.list.enabled);
const itemName = (i: Item) => (i.kind === "rule" ? i.rule.name : "");
const listMessage = (l: ListAlert) => translateWith("Absolute change ≥ {0}%", l.threshold);
const itemMessage = (i: Item) => (i.kind === "rule" ? ruleText(i.rule) : listMessage(i.list));
const itemType = (i: Item): "price" | "technicals" | "watchlist" => (i.kind === "list" ? "watchlist" : isTechnical(i.rule) ? "technicals" : "price");

function listAlerts(): ListAlert[] {
  return watchlistStore.lists().flatMap((l) => {
    const threshold = watchlistStore.alertFor(l.id);
    if (threshold == null) return [];
    return [{ listId: l.id, name: l.name, threshold, createdAt: watchlistStore.alertMetaFor(l.id).createdAt, enabled: watchlistStore.alertActive(l.id) }];
  });
}
const allItems = (): Item[] => [
  ...alertStore.rules().map((rule) => ({ kind: "rule" as const, rule })),
  ...listAlerts().map((list) => ({ kind: "list" as const, list })),
];

/** "Last triggered" part: day and time of the last fire. */
function lastTriggeredText(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function lastFireTimes(): Map<string, number> {
  const m = new Map<string, number>();
  for (const f of alertStore.fires()) if ((m.get(f.alertId) ?? 0) < f.fireTime) m.set(f.alertId, f.fireTime);
  return m;
}

/** The rows the list shows: filtered, searched, sorted. */
function visibleItems(ctx: AlertListContext): Item[] {
  const f = filters();
  const q = search().trim().toLowerCase();
  const sym = ctx.symbol.toUpperCase();
  const list = allItems().filter((i) => {
    const r = i.kind === "rule" ? i.rule : null;
    const where = r ? r.symbol : i.kind === "list" ? i.list.name : "";
    return (
      (f.status === "all" || (f.status === "active") === itemEnabled(i)) &&
      f[itemType(i)] &&
      (!f.symbol || r?.symbol === sym) &&
      (!f.interval || (r ? r.resolution : "1D") === ctx.interval) &&
      (!q || `${where} ${itemName(i)} ${itemMessage(i)}`.toLowerCase().includes(q))
    );
  });
  const s = sort();
  const fired = s.key === "triggered" ? lastFireTimes() : null;
  const created = (i: Item) => (i.kind === "rule" ? i.rule.createdAt : i.list.createdAt);
  const text = (i: Item) =>
    (s.key === "symbol" ? (i.kind === "rule" ? tickerOf(i.rule.symbol) : i.list.name) : s.key === "name" ? itemName(i) : itemMessage(i)).toLowerCase();
  const cmp = (a: Item, b: Item) => {
    if (s.key === "created") return created(a) - created(b);
    if (s.key === "triggered") return (fired!.get(itemId(a)) ?? 0) - (fired!.get(itemId(b)) ?? 0);
    return text(a).localeCompare(text(b));
  };
  return [...list].sort((a, b) => (s.desc ? -cmp(a, b) : cmp(a, b)));
}

function removeItem(i: Item) {
  if (i.kind === "list") {
    watchlistStore.clearAlert(i.list.listId);
    clearFiredForList(i.list.listId);
    return;
  }
  alertStore.remove(i.rule.id);
}
function setItemEnabled(i: Item, enabled: boolean) {
  if (i.kind === "list") {
    // A restarted watchlist alert may notify again the symbols it notified today.
    if (enabled && !i.list.enabled) clearFiredForList(i.list.listId);
    watchlistStore.setAlertPaused(i.list.listId, !enabled);
    return;
  }
  alertStore.setEnabled(i.rule.id, enabled);
}

// The watchlist alert being edited (its threshold dialog).
const [editingList, setEditingList] = createSignal<ListAlert | null>(null);
const editItem = (i: Item) => (i.kind === "rule" ? emitAppEvent("chart-open-alert-dialog", { editId: i.rule.id }) : setEditingList(i.list));

/** Actions on every row the list shows. */
const restartShown = (ctx: AlertListContext) => visibleItems(ctx).forEach((i) => setItemEnabled(i, true));
const pauseShown = (ctx: AlertListContext) => visibleItems(ctx).forEach((i) => setItemEnabled(i, false));
const deleteShown = (ctx: AlertListContext) => visibleItems(ctx).forEach(removeItem);
const deleteInactive = () => allItems().filter((i) => !itemEnabled(i)).forEach(removeItem);

/** Source icon: the drawing's tool icon or the indicator glyph; none for a price alert. */
function SourceIcon(props: { rule: AlertRule }) {
  const operand = (): Operand | undefined => {
    const c = ruleConditions(props.rule)[0];
    return [c.left, c.right].find((o) => o.kind === "drawing" || o.kind === "indicator");
  };
  return (
    <Show when={operand()}>
      {(o) => {
        const op = o();
        if (op.kind === "indicator") return <span class="alerts-panel-attr alerts-panel-source">{GLYPH.indicator()}</span>;
        if (op.kind !== "drawing") return null;
        const kind = loadDrawings(props.rule.symbol).find((d) => d.id === op.drawingId)?.kind;
        return kind ? <span class="alerts-panel-attr alerts-panel-source"><Icon name={iconForKind(kind)} size={18} /></span> : null;
      }}
    </Show>
  );
}

/** Logo of a row (the letter badge). */
export const RowLogo = (props: { symbol: string }) => (
  <span class="ot-ticker-logo ot-ticker-logo--sm alerts-panel-logo" aria-hidden="true">{tickerOf(props.symbol).charAt(0)}</span>
);

/** Logo of a watchlist alert's row. */
const ListLogo = () => (
  <span class="ot-ticker-logo ot-ticker-logo--sm alerts-panel-logo" aria-hidden="true">
    <svg viewBox="0 0 18 18" width="12" height="12"><path fill="none" stroke="currentColor" stroke-linecap="round" d="M4 5.5h10M4 9h10M4 12.5h10" /></svg>
  </span>
);

/** Options button with the count of the filters applied. */
export function OptionsButton(props: { name: string; count: number; pressed: boolean; onClick: () => void }) {
  return (
    <Tooltip text="Options" side="bottom">
      <IconButton data-name={props.name} aria-label="Options" aria-pressed={props.pressed || undefined} class="alerts-panel-tool" onClick={props.onClick}>
        <Icon name="al-alerts-log-actions" size={28} />
        <Show when={props.count > 0}>
          <span class="alerts-panel-count" role="img" aria-label={`${props.count} filter${props.count > 1 ? "s" : ""} applied`}>{props.count}</span>
        </Show>
      </IconButton>
    </Tooltip>
  );
}

/** Toolbar row of the Alerts view. */
export function AlertRulesToolbar(props: { ctx: AlertListContext; onOpenSettings?: () => void }) {
  const [menu, setMenu] = createSignal<"sort" | "options" | null>(null);
  // A press outside the toolbar (its menus included) closes the open menu.
  const el = createPopover(undefined, { onClose: () => setMenu(null), placement: false, escape: "none", on: { target: "window", capture: false } });
  const toggle = (m: "sort" | "options") => setMenu((cur) => (cur === m ? null : m));
  const items = () => allItems();
  const shown = () => visibleItems(props.ctx);
  const tool = (name: string, label: string, icon: string, onClick: () => void, pressed?: boolean) => (
    <Tooltip text={label} side="bottom">
      <IconButton data-name={name} aria-label={label} aria-pressed={pressed || undefined} class="alerts-panel-tool" onClick={onClick}>
        <Icon name={icon} size={28} />
      </IconButton>
    </Tooltip>
  );
  const close = (run: () => void) => () => { run(); setMenu(null); };
  return (
    <div class="alerts-panel-subheader" ref={el}>
      {tool("set-alert-button", "Create alert", "scr-add", () => emitAppEvent("chart-open-alert-dialog", { symbol: props.ctx.symbol }))}
      <div class="alerts-panel-subheader-right">
        {tool("alerts-search-button", "Search", "scr-search", () => { if (searchOpen()) setSearch(""); setSearchOpen(!searchOpen()); }, searchOpen())}
        {tool("alert-sort-button", translateWith("Sorted by {0}", translate(sortLabel(sort())).replace(/^./, (c) => c.toLowerCase())), sort().desc ? "scr-menu-sort-desc" : "scr-menu-sort-asc", () => toggle("sort"), menu() === "sort")}
        <OptionsButton name="alerts-settings-button" count={filterCount()} pressed={menu() === "options"} onClick={() => toggle("options")} />
      </div>
      <Show when={menu() === "sort"}>
        <div class="ot-popover alerts-panel-menu alerts-panel-menu--sort" role="menu" aria-label="Sort alerts">
          <For each={SORTS}>
            {(s, i) => (
              <>
                <Show when={i() > 0 && i() % 2 === 0}><MenuSep /></Show>
                <MenuSort
                  label={s.label}
                  desc={s.desc}
                  selected={sort().key === s.key && sort().desc === s.desc}
                  onSelect={close(() => setSort({ key: s.key, desc: s.desc }))}
                />
              </>
            )}
          </For>
        </div>
      </Show>
      <Show when={menu() === "options"}>
        <div class="ot-popover alerts-panel-menu" role="menu" aria-label="Alerts options">
          <MenuAction icon={GLYPH.restart()} label="Restart as per filter" disabled={!shown().some((i) => !itemEnabled(i))} onSelect={close(() => restartShown(props.ctx))} />
          <MenuAction icon={GLYPH.pause()} label="Pause as per filter" disabled={!shown().some(itemEnabled)} onSelect={close(() => pauseShown(props.ctx))} />
          <MenuAction icon={GLYPH.trash()} label="Delete all inactive" disabled={!items().some((i) => !itemEnabled(i))} onSelect={close(deleteInactive)} />
          <MenuSection title="Show alerts">
            <MenuToggle radio label="All" count={items().length} checked={filters().status === "all"} onSelect={() => setFilters({ ...filters(), status: "all" })} />
            <MenuToggle radio label="Active only" count={items().filter(itemEnabled).length} checked={filters().status === "active"} onSelect={() => setFilters({ ...filters(), status: "active" })} />
            <MenuToggle radio label="Inactive only" count={items().filter((i) => !itemEnabled(i)).length} checked={filters().status === "inactive"} onSelect={() => setFilters({ ...filters(), status: "inactive" })} />
          </MenuSection>
          <MenuSection title="Filter alerts">
            <MenuToggle label="Current symbol" checked={filters().symbol} onSelect={() => flip("symbol")} />
            <MenuToggle label="Current time interval" checked={filters().interval} onSelect={() => flip("interval")} />
          </MenuSection>
          <MenuSection title="Show alerts by type">
            <MenuToggle label="Price" count={items().filter((i) => itemType(i) === "price").length} checked={filters().price} onSelect={() => flip("price")} />
            <MenuToggle label="Technicals" count={items().filter((i) => itemType(i) === "technicals").length} checked={filters().technicals} onSelect={() => flip("technicals")} />
            <MenuToggle label="Watchlist" count={items().filter((i) => i.kind === "list").length} checked={filters().watchlist} onSelect={() => flip("watchlist")} />
          </MenuSection>
          <MenuSection title="Customize list">
            <MenuToggle label="Name" checked={filters().name} onSelect={() => flip("name")} />
            <MenuToggle label="Message" checked={filters().message} onSelect={() => flip("message")} />
            <MenuToggle label="Source icon" checked={filters().source} onSelect={() => flip("source")} />
            <MenuToggle label="Instrument logo" checked={filters().logo} onSelect={() => flip("logo")} />
            <MenuToggle label="Last triggered" checked={filters().triggered} onSelect={() => flip("triggered")} />
          </MenuSection>
          <Show when={props.onOpenSettings}>
            <MenuSep />
            <MenuAction icon={GLYPH.edit()} label="Alerts settings..." onSelect={close(() => props.onOpenSettings!())} />
          </Show>
        </div>
      </Show>
    </div>
  );
}

/** The list of alerts (the panel body of the Alerts view). */
export function AlertRulesList(props: {
  ctx: AlertListContext;
  drawingMissing: (r: AlertRule) => boolean;
  /** Show a symbol and interval on the active chart (a row click). */
  onShow?: (symbol: string, interval: string) => void;
}) {
  const items = createMemo(() => visibleItems(props.ctx));
  const fired = createMemo(lastFireTimes);
  const [rowMenu, setRowMenu] = createSignal<{ item: Item; x: number; y: number } | null>(null);
  onMount(() => {
    const close = () => setRowMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    onCleanup(() => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", onKey); });
  });
  const rowBtn = (name: string, label: string, icon: () => JSX.Element, run: () => void) => (
    <Tooltip text={label} side="bottom">
      <button type="button" class="alerts-panel-row-btn" data-name={name} aria-label={label} onClick={(e) => { e.stopPropagation(); run(); }}>
        {icon()}
      </button>
    </Tooltip>
  );
  const act = (run: () => void) => () => { run(); setRowMenu(null); };
  const onRowClick = (i: Item) => {
    if (i.kind === "list") return;
    if (i.rule.left.kind === "screen" || !props.onShow) editItem(i);
    else props.onShow(i.rule.symbol, i.rule.resolution);
  };
  const ticker = (i: Item) =>
    i.kind === "list" ? `${i.list.name}, 1D` : i.rule.left.kind === "screen" ? `Screen · ${i.rule.left.title}` : `${tickerOf(i.rule.symbol)}, ${intervalLabel(i.rule.resolution)}`;
  const statusText = (i: Item) => (itemEnabled(i) ? "Active" : i.kind === "rule" && i.rule.cloned ? "Paused — Cloned" : "Inactive");
  const ruleOf = (i: Item) => (i.kind === "rule" ? i.rule : null);
  return (
    <>
      <Show when={searchOpen()}>
        <div class="alerts-panel-search">
          <input
            class="wl-dialog-input"
            type="text"
            placeholder="Search"
            spellcheck={false}
            value={search()}
            ref={(el) => queueMicrotask(() => el.focus())}
            onInput={(e) => setSearch(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Escape") { setSearch(""); setSearchOpen(false); } }}
          />
        </div>
      </Show>
      <Show
        when={items().length > 0}
        fallback={
          <div class="ot-empty-state alerts-panel-empty">
            {allItems().length > 0
              ? "No alerts match the filters"
              : "No alerts yet. Right-click the chart or use the header “Alert” button to create one."}
          </div>
        }
      >
        <For each={items()}>
          {(i) => (
            <div
              data-name="alert-rule-item"
              class="alerts-panel-item"
              classList={{ "is-disabled": !itemEnabled(i), "is-menu-open": !!rowMenu() && itemId(rowMenu()!.item) === itemId(i) }}
              onClick={() => onRowClick(i)}
              onDblClick={() => { if (i.kind === "list") editItem(i); }}
              onContextMenu={(e) => { e.preventDefault(); setRowMenu({ item: i, x: e.clientX, y: e.clientY }); }}
            >
              <Show when={filters().name && itemName(i)}>
                <div class="alerts-panel-item-text alerts-panel-item-name" data-name="alert-item-name">{itemName(i)}</div>
              </Show>
              <Show when={filters().message}>
                <div class="alerts-panel-item-text" data-name="alert-item-description">{itemMessage(i)}</div>
              </Show>
              <div class="alerts-panel-attrs">
                <Show when={filters().logo && ruleOf(i)?.left.kind !== "screen"}>
                  {i.kind === "list" ? <ListLogo /> : <RowLogo symbol={i.rule.symbol} />}
                </Show>
                <span class="alerts-panel-attr alerts-panel-attr--strong" data-name="alert-item-ticker">{ticker(i)}</span>
                <span class="alerts-panel-attr alerts-panel-status" classList={{ "is-active": itemEnabled(i) }} data-name="alert-item-status">
                  {statusText(i)}
                </span>
                <Show when={filters().source && ruleOf(i)}>
                  {(r) => <SourceIcon rule={r()} />}
                </Show>
                <Show when={filters().triggered && fired().get(itemId(i))}>
                  {(t) => <span class="alerts-panel-attr" data-name="alert-item-time">{lastTriggeredText(t())}</span>}
                </Show>
                <Show when={ruleOf(i) && props.drawingMissing(ruleOf(i)!)}>
                  <span class="alerts-panel-attr alerts-panel-warn" title="Source drawing was deleted — this alert can't trigger">
                    <svg viewBox="0 0 18 18" width="14" height="14" aria-hidden="true">
                      <path fill="currentColor" fill-rule="evenodd" d="M9 1.5 17 16H1L9 1.5Zm-.75 5.5h1.5v5h-1.5V7Zm.75 8.1a.9.9 0 1 0 0-1.8.9.9 0 0 0 0 1.8Z" />
                    </svg>
                  </span>
                </Show>
              </div>
              <div class="alerts-panel-row-actions">
                {itemEnabled(i)
                  ? rowBtn("alert-stop-button", "Pause", GLYPH.pause, () => setItemEnabled(i, false))
                  : rowBtn("alert-restart-button", "Restart", GLYPH.restart, () => setItemEnabled(i, true))}
                {rowBtn("alert-edit-button", "Edit", GLYPH.edit, () => editItem(i))}
                {rowBtn("alert-delete-button", "Delete", GLYPH.trash, () => removeItem(i))}
              </div>
            </div>
          )}
        </For>
      </Show>
      <Show when={rowMenu()}>
        {(m) => (
          <div
            class="ot-popover alerts-panel-menu alerts-panel-row-menu"
            role="menu"
            style={{ left: `${Math.min(m().x, window.innerWidth - 270)}px`, top: `${Math.min(m().y, window.innerHeight - 300)}px` }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {itemEnabled(m().item)
              ? <MenuAction icon={GLYPH.pause()} label="Pause" onSelect={act(() => setItemEnabled(m().item, false))} />
              : <MenuAction icon={GLYPH.restart()} label="Restart" onSelect={act(() => setItemEnabled(m().item, true))} />}
            <MenuAction icon={GLYPH.edit()} label="Edit…" onSelect={act(() => editItem(m().item))} />
            <Show when={m().item.kind === "rule"}>
              <MenuAction icon={<Icon name="ot-header-copy-clone" size={28} />} label="Clone" onSelect={act(() => alertStore.clone(itemId(m().item)))} />
            </Show>
            <MenuAction icon={GLYPH.trash()} label="Delete" onSelect={act(() => removeItem(m().item))} />
            <MenuSep />
            <MenuAction label="Restart as per filter" disabled={!items().some((i) => !itemEnabled(i))} onSelect={act(() => restartShown(props.ctx))} />
            <MenuAction label="Pause as per filter" disabled={!items().some(itemEnabled)} onSelect={act(() => pauseShown(props.ctx))} />
            <MenuAction label="Delete as per filter" onSelect={act(() => deleteShown(props.ctx))} />
            <MenuAction label="Delete all inactive" disabled={!allItems().some((i) => !itemEnabled(i))} onSelect={act(deleteInactive)} />
          </div>
        )}
      </Show>
      <Show when={editingList()}>
        {(l) => (
          <AddAlertDialog
            listName={l().name}
            initial={l().threshold}
            onSave={(threshold) => {
              watchlistStore.setAlert(l().listId, threshold);
              clearFiredForList(l().listId);
            }}
            onRemove={() => {
              watchlistStore.clearAlert(l().listId);
              clearFiredForList(l().listId);
            }}
            onClose={() => setEditingList(null)}
          />
        )}
      </Show>
    </>
  );
}
