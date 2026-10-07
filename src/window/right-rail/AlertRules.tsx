/*
 * Alerts panel, "Alerts" view: the toolbar (create, search, sort, options)
 * and the list of alert rules.
 *
 * Row: the alert text (its message, else its condition), then "TICKER,
 * interval" and the status (Active / Inactive). On hover: Pause or Restart,
 * Edit, Delete. Right-click: the same three, then the actions on the whole
 * filtered list and "Delete all inactive".
 * Sort: symbol, name, message (A to Z / Z to A), date created and time
 * triggering (oldest / newest first); date created, oldest first by default.
 * Options: Restart / Pause as per filter, Delete all inactive, and the
 * filters All / Active only / Inactive only, Current symbol, Current time
 * interval, by type (Price: price against a value; Technicals: an alert on
 * an indicator or a drawing), and the row parts to show (Name, Message, Last
 * triggered). Sort, filters and row parts are kept across sessions.
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { tickerOf } from "../../data/symbol-name";
import { Tooltip } from "../../components/Tooltip";
import { IconButton } from "../../components/IconButton";
import { alertStore, type AlertRule } from "../../data/alert-store";
import { describeCondition } from "../../data/alert-condition";
import { resetRuleEvalState, setAlertWebhook } from "../../data/alert-engine";
import { intervalLabel } from "../../data/datafeed";
import * as kv from "../../data/kv";

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
  /** Row parts shown. */
  name: boolean;
  message: boolean;
  triggered: boolean;
};
const DEFAULT_FILTERS: Filters = { status: "all", symbol: false, interval: false, price: true, technicals: true, name: true, message: true, triggered: false };

/** "Technicals": the alert reads an indicator or a drawing. */
const isTechnical = (r: AlertRule) => r.left.kind !== "price" || r.right.kind === "indicator" || r.right.kind === "drawing";

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
    const on = (k: "price" | "technicals" | "name" | "message" | "triggered") => (typeof f?.[k] === "boolean" ? f[k] : DEFAULT_FILTERS[k]);
    return { sort, filters: { status, symbol: !!f?.symbol, interval: !!f?.interval, price: on("price"), technicals: on("technicals"), name: on("name"), message: on("message"), triggered: on("triggered") } };
  } catch {
    return base;
  }
}

// One alerts panel per window: its list view state lives here, shared by the
// toolbar (panel header) and the list (panel body).
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

/** Chart context of the "Current symbol" / "Current time interval" filters. */
export type AlertListContext = { symbol: string; interval: string };

const ruleText = (r: AlertRule) => r.message || describeCondition(r);

/** "Last triggered" row part: day and time of the last fire. */
function lastTriggeredText(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function lastFireTimes(): Map<string, number> {
  const m = new Map<string, number>();
  for (const f of alertStore.fires()) if ((m.get(f.alertId) ?? 0) < f.fireTime) m.set(f.alertId, f.fireTime);
  return m;
}

/** The rules the list shows: filtered, searched, sorted. */
function visibleRules(ctx: AlertListContext): AlertRule[] {
  const f = filters();
  const q = search().trim().toLowerCase();
  const sym = ctx.symbol.toUpperCase();
  const list = alertStore.rules().filter(
    (r) =>
      (f.status === "all" || (f.status === "active") === r.enabled) &&
      (isTechnical(r) ? f.technicals : f.price) &&
      (!f.symbol || r.symbol === sym) &&
      (!f.interval || r.resolution === ctx.interval) &&
      (!q || `${r.symbol} ${r.name} ${ruleText(r)}`.toLowerCase().includes(q)),
  );
  const s = sort();
  const fired = s.key === "triggered" ? lastFireTimes() : null;
  const text = (r: AlertRule) => (s.key === "symbol" ? tickerOf(r.symbol) : s.key === "name" ? r.name : ruleText(r)).toLowerCase();
  const cmp = (a: AlertRule, b: AlertRule) => {
    if (s.key === "created") return a.createdAt - b.createdAt;
    if (s.key === "triggered") return (fired!.get(a.id) ?? 0) - (fired!.get(b.id) ?? 0);
    return text(a).localeCompare(text(b));
  };
  return [...list].sort((a, b) => (s.desc ? -cmp(a, b) : cmp(a, b)));
}

function removeRule(r: AlertRule) {
  resetRuleEvalState(r.id);
  setAlertWebhook(r.id, null);
  alertStore.remove(r.id);
}
function setRuleEnabled(r: AlertRule, enabled: boolean) {
  if (enabled && !r.enabled) resetRuleEvalState(r.id);
  alertStore.setEnabled(r.id, enabled);
}
const editRule = (r: AlertRule) =>
  window.dispatchEvent(new CustomEvent("chart-open-alert-dialog", { detail: { editId: r.id } }));

/** Actions on every rule the list shows. */
const restartShown = (ctx: AlertListContext) => visibleRules(ctx).forEach((r) => setRuleEnabled(r, true));
const pauseShown = (ctx: AlertListContext) => visibleRules(ctx).forEach((r) => setRuleEnabled(r, false));
const deleteShown = (ctx: AlertListContext) => visibleRules(ctx).forEach(removeRule);
const deleteInactive = () => alertStore.rules().filter((r) => !r.enabled).forEach(removeRule);

const icon = (d: string, fill = false) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
    <path d={d} fill={fill ? "currentColor" : "none"} stroke={fill ? "none" : "currentColor"} stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
);
const ICON = {
  plus: "M9 3v12M3 9h12",
  search: "M12 12l3.5 3.5M13 8A5 5 0 1 1 3 8a5 5 0 0 1 10 0Z",
  sort: "M5 3v12M5 3 2.5 5.5M5 3l2.5 2.5M10 5h6M10 9h4.5M10 13h3",
  dots: "M4 7.8a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4Zm5 0a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4Zm5 0a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4Z",
  pause: "M6.5 4v10M11.5 4v10",
  restart: "M6 4l8 5-8 5V4Z",
  edit: "M3 15h3l8.5-8.5-3-3L3 12v3ZM10 5l3 3",
  trash: "M3.5 5h11M7 5V3.5h4V5M5 5l.7 9.5h6.6L13 5",
};

function MenuItem(props: { label: string; checked?: boolean; disabled?: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      role={props.checked === undefined ? "menuitem" : "menuitemcheckbox"}
      aria-checked={props.checked}
      aria-disabled={props.disabled || undefined}
      class="ot-menu-item alerts-panel-menu-item"
      classList={{ "is-disabled": !!props.disabled }}
      onClick={() => { if (!props.disabled) props.onSelect(); }}
    >
      <span class="alerts-panel-menu-check">{props.checked ? "✓" : ""}</span>
      <span class="ot-menu-item__label">{props.label}</span>
    </button>
  );
}

/** Toolbar of the Alerts view (the panel header's right side). */
export function AlertRulesToolbar(props: { ctx: AlertListContext }) {
  const [menu, setMenu] = createSignal<"sort" | "options" | null>(null);
  let el: HTMLDivElement | undefined;
  onMount(() => {
    const onDown = (e: PointerEvent) => { if (el && !el.contains(e.target as Node)) setMenu(null); };
    window.addEventListener("pointerdown", onDown);
    onCleanup(() => window.removeEventListener("pointerdown", onDown));
  });
  const toggle = (m: "sort" | "options") => setMenu((cur) => (cur === m ? null : m));
  const anyInactive = () => alertStore.rules().some((r) => !r.enabled);
  const shown = () => visibleRules(props.ctx);
  const btn = (name: string, label: string, d: string, onClick: () => void, pressed?: boolean, fill = false): JSX.Element => (
    <Tooltip text={label} side="bottom">
      <IconButton data-name={name} aria-label={label} aria-pressed={pressed || undefined} onClick={onClick}>
        {icon(d, fill)}
      </IconButton>
    </Tooltip>
  );
  return (
    <div class="alerts-panel-toolbar-group" ref={el}>
      {btn("set-alert-button", "Create alert", ICON.plus, () => window.dispatchEvent(new CustomEvent("chart-open-alert-dialog", { detail: { symbol: props.ctx.symbol } })))}
      {btn("alerts-search-button", "Search", ICON.search, () => { if (searchOpen()) setSearch(""); setSearchOpen(!searchOpen()); }, searchOpen())}
      {btn("alert-sort-button", `Sorted by ${sortLabel(sort()).replace(/^./, (c) => c.toLowerCase())}`, ICON.sort, () => toggle("sort"), menu() === "sort")}
      {btn("alerts-settings-button", "Options", ICON.dots, () => toggle("options"), menu() === "options", true)}
      <Show when={menu() === "sort"}>
        <div class="ot-popover alerts-panel-menu" role="menu" aria-label="Sort alerts">
          <For each={SORTS}>
            {(s) => (
              <MenuItem
                label={s.label}
                checked={sort().key === s.key && sort().desc === s.desc}
                onSelect={() => { setSort({ key: s.key, desc: s.desc }); setMenu(null); }}
              />
            )}
          </For>
        </div>
      </Show>
      <Show when={menu() === "options"}>
        <div class="ot-popover alerts-panel-menu" role="menu" aria-label="Alerts options">
          <MenuItem label="Restart as per filter" disabled={!shown().some((r) => !r.enabled)} onSelect={() => { restartShown(props.ctx); setMenu(null); }} />
          <MenuItem label="Pause as per filter" disabled={!shown().some((r) => r.enabled)} onSelect={() => { pauseShown(props.ctx); setMenu(null); }} />
          <MenuItem label="Delete all inactive" disabled={!anyInactive()} onSelect={() => { deleteInactive(); setMenu(null); }} />
          <div class="alerts-panel-menu-sep" />
          <MenuItem label="All" checked={filters().status === "all"} onSelect={() => setFilters({ ...filters(), status: "all" })} />
          <MenuItem label="Active only" checked={filters().status === "active"} onSelect={() => setFilters({ ...filters(), status: "active" })} />
          <MenuItem label="Inactive only" checked={filters().status === "inactive"} onSelect={() => setFilters({ ...filters(), status: "inactive" })} />
          <div class="alerts-panel-menu-sep" />
          <MenuItem label="Current symbol" checked={filters().symbol} onSelect={() => setFilters({ ...filters(), symbol: !filters().symbol })} />
          <MenuItem label="Current time interval" checked={filters().interval} onSelect={() => setFilters({ ...filters(), interval: !filters().interval })} />
          <div class="alerts-panel-menu-sep" />
          <MenuItem label={`Price · ${alertStore.rules().filter((r) => !isTechnical(r)).length}`} checked={filters().price} onSelect={() => setFilters({ ...filters(), price: !filters().price })} />
          <MenuItem label={`Technicals · ${alertStore.rules().filter(isTechnical).length}`} checked={filters().technicals} onSelect={() => setFilters({ ...filters(), technicals: !filters().technicals })} />
          <div class="alerts-panel-menu-sep" />
          <MenuItem label="Name" checked={filters().name} onSelect={() => setFilters({ ...filters(), name: !filters().name })} />
          <MenuItem label="Message" checked={filters().message} onSelect={() => setFilters({ ...filters(), message: !filters().message })} />
          <MenuItem label="Last triggered" checked={filters().triggered} onSelect={() => setFilters({ ...filters(), triggered: !filters().triggered })} />
        </div>
      </Show>
    </div>
  );
}

/** The list of alert rules (the panel body of the Alerts view). */
export function AlertRulesList(props: { ctx: AlertListContext; drawingMissing: (r: AlertRule) => boolean }) {
  const rules = createMemo(() => visibleRules(props.ctx));
  const fired = createMemo(lastFireTimes);
  const [rowMenu, setRowMenu] = createSignal<{ rule: AlertRule; x: number; y: number } | null>(null);
  onMount(() => {
    const close = () => setRowMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    onCleanup(() => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", onKey); });
  });
  const rowBtn = (name: string, label: string, d: string, run: () => void, fill = false) => (
    <Tooltip text={label} side="bottom">
      <button type="button" class="alerts-panel-rule-btn" data-name={name} aria-label={label} onClick={(e) => { e.stopPropagation(); run(); }}>
        {icon(d, fill)}
      </button>
    </Tooltip>
  );
  const act = (run: () => void) => () => { run(); setRowMenu(null); };
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
        when={rules().length > 0}
        fallback={
          <div class="ot-empty-state alerts-panel-empty">
            {alertStore.rules().length > 0
              ? "No alerts match the filters"
              : "No alerts yet. Right-click the chart or use the header “Alert” button to create one."}
          </div>
        }
      >
        <For each={rules()}>
          {(r) => (
            <div
              data-name="alert-rule-item"
              class="alerts-panel-rule"
              classList={{ "is-disabled": !r.enabled }}
              onClick={() => editRule(r)}
              onContextMenu={(e) => { e.preventDefault(); setRowMenu({ rule: r, x: e.clientX, y: e.clientY }); }}
            >
              <div class="alerts-panel-rule-main">
                <div class="alerts-panel-rule-cond" data-name="alert-item-description">
                  <Show when={r.name && (filters().name || !filters().message)}>
                    <span class="alerts-panel-rule-name">{r.name}</span>
                  </Show>
                  {/* An alert without a name keeps its text when Message is off. */}
                  <Show when={filters().message || !r.name}>{ruleText(r)}</Show>
                </div>
                <div class="alerts-panel-rule-meta">
                  <span data-name="alert-item-ticker">{`${tickerOf(r.symbol)}, ${intervalLabel(r.resolution)}`}</span>
                  <span class="alerts-panel-rule-status" classList={{ "is-active": r.enabled }} data-name="alert-item-status">
                    {r.enabled ? "Active" : "Inactive"}
                  </span>
                  <Show when={filters().triggered && fired().get(r.id)}>
                    {(t) => <span data-name="alert-item-last-triggered">{lastTriggeredText(t())}</span>}
                  </Show>
                  <Show when={props.drawingMissing(r)}>
                    <span
                      class="alerts-panel-rule-warn"
                      title="Source drawing was deleted — this alert can't trigger"
                      style={{ color: "var(--color-invalid-symbol)", display: "inline-flex" }}
                    >
                      <svg viewBox="0 0 18 18" width="14" height="14" aria-hidden="true">
                        <path fill="currentColor" fill-rule="evenodd" d="M9 1.5 17 16H1L9 1.5Zm-.75 5.5h1.5v5h-1.5V7Zm.75 8.1a.9.9 0 1 0 0-1.8.9.9 0 0 0 0 1.8Z" />
                      </svg>
                    </span>
                  </Show>
                </div>
              </div>
              <div class="alerts-panel-rule-actions">
                {r.enabled
                  ? rowBtn("alert-stop-button", "Pause", ICON.pause, () => setRuleEnabled(r, false))
                  : rowBtn("alert-restart-button", "Restart", ICON.restart, () => setRuleEnabled(r, true))}
                {rowBtn("alert-edit-button", "Edit", ICON.edit, () => editRule(r))}
                {rowBtn("alert-delete-button", "Delete", ICON.trash, () => removeRule(r))}
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
            style={{ left: `${Math.min(m().x, window.innerWidth - 230)}px`, top: `${Math.min(m().y, window.innerHeight - 250)}px` }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {m().rule.enabled
              ? <MenuItem label="Pause" onSelect={act(() => setRuleEnabled(m().rule, false))} />
              : <MenuItem label="Restart" onSelect={act(() => setRuleEnabled(m().rule, true))} />}
            <MenuItem label="Edit…" onSelect={act(() => editRule(m().rule))} />
            <MenuItem label="Delete" onSelect={act(() => removeRule(m().rule))} />
            <div class="alerts-panel-menu-sep" />
            <MenuItem label="Restart as per filter" disabled={!rules().some((r) => !r.enabled)} onSelect={act(() => restartShown(props.ctx))} />
            <MenuItem label="Pause as per filter" disabled={!rules().some((r) => r.enabled)} onSelect={act(() => pauseShown(props.ctx))} />
            <MenuItem label="Delete as per filter" onSelect={act(() => deleteShown(props.ctx))} />
            <MenuItem label="Delete all inactive" disabled={!alertStore.rules().some((r) => !r.enabled)} onSelect={act(deleteInactive)} />
          </div>
        )}
      </Show>
    </>
  );
}
