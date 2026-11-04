/*
 * Alerts panel, "Alerts" view: the toolbar row (create on the left; search,
 * sort, options on the right) and the list of alert rules.
 *
 * Row, as the reference app draws it: one line of text (the alert's name,
 * else its message or condition), then the attributes line: instrument logo,
 * "TICKER, interval", the status (Active / Inactive, "Paused — Cloned" for a
 * copy), the source icon (the indicator or drawing the alert reads) and the
 * last trigger time, separated by dots. A click shows the alert's symbol and
 * interval on the chart (a screen alert opens its editor). On hover: Pause or
 * Restart, Edit, Delete, over the end of the text. Right-click: Pause or
 * Restart, Edit…, Clone (a paused copy), Delete, then the actions on the
 * whole filtered list and "Delete all inactive".
 * Sort: symbol, name, message (A to Z / Z to A), date created and time
 * triggering (oldest / newest first); date created, oldest first by default.
 * Options: Restart / Pause as per filter, Delete all inactive, then the
 * sections Show alerts (All / Active only / Inactive only), Filter alerts
 * (Current symbol, Current time interval), Show alerts by type (Price: price
 * against a value; Technicals: an alert on an indicator or a drawing),
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
import { defaultAlertMessage, ruleConditions } from "../../data/alert-condition";
import { resetRuleEvalState, setAlertWebhook } from "../../data/alert-engine";
import { intervalLabel } from "../../data/datafeed";
import { loadDrawings } from "../drawings/persistence";
import { iconForKind } from "../drawings/labels";
import * as kv from "../../data/kv";
import { emitAppEvent } from "../../data/app-events";
import { GLYPH, MenuAction, MenuSection, MenuSep, MenuSort, MenuToggle } from "./alerts-menu";

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
  source: boolean;
  logo: boolean;
  triggered: boolean;
};
type Part = "price" | "technicals" | "name" | "message" | "source" | "logo" | "triggered";
const DEFAULT_FILTERS: Filters = { status: "all", symbol: false, interval: false, price: true, technicals: true, name: true, message: true, source: true, logo: true, triggered: false };

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
      filters: { status, symbol: !!f?.symbol, interval: !!f?.interval, price: on("price"), technicals: on("technicals"), name: on("name"), message: on("message"), source: on("source"), logo: on("logo"), triggered: on("triggered") },
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
  return (f.status !== "all" ? 1 : 0) + (f.symbol ? 1 : 0) + (f.interval ? 1 : 0) + (f.price ? 0 : 1) + (f.technicals ? 0 : 1);
};

/** Chart context of the "Current symbol" / "Current time interval" filters. */
export type AlertListContext = { symbol: string; interval: string };

const ruleText = (r: AlertRule) => r.message || defaultAlertMessage(r);

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
const editRule = (r: AlertRule) => emitAppEvent("chart-open-alert-dialog", { editId: r.id });

/** Actions on every rule the list shows. */
const restartShown = (ctx: AlertListContext) => visibleRules(ctx).forEach((r) => setRuleEnabled(r, true));
const pauseShown = (ctx: AlertListContext) => visibleRules(ctx).forEach((r) => setRuleEnabled(r, false));
const deleteShown = (ctx: AlertListContext) => visibleRules(ctx).forEach(removeRule);
const deleteInactive = () => alertStore.rules().filter((r) => !r.enabled).forEach(removeRule);

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
  let el: HTMLDivElement | undefined;
  onMount(() => {
    const onDown = (e: PointerEvent) => { if (el && !el.contains(e.target as Node)) setMenu(null); };
    window.addEventListener("pointerdown", onDown);
    onCleanup(() => window.removeEventListener("pointerdown", onDown));
  });
  const toggle = (m: "sort" | "options") => setMenu((cur) => (cur === m ? null : m));
  const rules = () => alertStore.rules();
  const shown = () => visibleRules(props.ctx);
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
        {tool("alert-sort-button", `Sorted by ${sortLabel(sort()).replace(/^./, (c) => c.toLowerCase())}`, sort().desc ? "scr-menu-sort-desc" : "scr-menu-sort-asc", () => toggle("sort"), menu() === "sort")}
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
          <MenuAction icon={GLYPH.restart()} label="Restart as per filter" disabled={!shown().some((r) => !r.enabled)} onSelect={close(() => restartShown(props.ctx))} />
          <MenuAction icon={GLYPH.pause()} label="Pause as per filter" disabled={!shown().some((r) => r.enabled)} onSelect={close(() => pauseShown(props.ctx))} />
          <MenuAction icon={GLYPH.trash()} label="Delete all inactive" disabled={!rules().some((r) => !r.enabled)} onSelect={close(deleteInactive)} />
          <MenuSection title="Show alerts">
            <MenuToggle radio label="All" count={rules().length} checked={filters().status === "all"} onSelect={() => setFilters({ ...filters(), status: "all" })} />
            <MenuToggle radio label="Active only" count={rules().filter((r) => r.enabled).length} checked={filters().status === "active"} onSelect={() => setFilters({ ...filters(), status: "active" })} />
            <MenuToggle radio label="Inactive only" count={rules().filter((r) => !r.enabled).length} checked={filters().status === "inactive"} onSelect={() => setFilters({ ...filters(), status: "inactive" })} />
          </MenuSection>
          <MenuSection title="Filter alerts">
            <MenuToggle label="Current symbol" checked={filters().symbol} onSelect={() => flip("symbol")} />
            <MenuToggle label="Current time interval" checked={filters().interval} onSelect={() => flip("interval")} />
          </MenuSection>
          <MenuSection title="Show alerts by type">
            <MenuToggle label="Price" count={rules().filter((r) => !isTechnical(r)).length} checked={filters().price} onSelect={() => flip("price")} />
            <MenuToggle label="Technicals" count={rules().filter(isTechnical).length} checked={filters().technicals} onSelect={() => flip("technicals")} />
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

/** The list of alert rules (the panel body of the Alerts view). */
export function AlertRulesList(props: {
  ctx: AlertListContext;
  drawingMissing: (r: AlertRule) => boolean;
  /** Show a symbol and interval on the active chart (a row click). */
  onShow?: (symbol: string, interval: string) => void;
}) {
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
  const rowBtn = (name: string, label: string, icon: () => JSX.Element, run: () => void) => (
    <Tooltip text={label} side="bottom">
      <button type="button" class="alerts-panel-row-btn" data-name={name} aria-label={label} onClick={(e) => { e.stopPropagation(); run(); }}>
        {icon()}
      </button>
    </Tooltip>
  );
  const act = (run: () => void) => () => { run(); setRowMenu(null); };
  /** The row's line of text: its name when shown, else its message (an alert without a name keeps its text when Message is off). */
  const description = (r: AlertRule) => (r.name && (filters().name || !filters().message) ? r.name : ruleText(r));
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
              class="alerts-panel-item"
              classList={{ "is-disabled": !r.enabled, "is-menu-open": rowMenu()?.rule.id === r.id }}
              onClick={() => (r.left.kind === "screen" || !props.onShow ? editRule(r) : props.onShow(r.symbol, r.resolution))}
              onContextMenu={(e) => { e.preventDefault(); setRowMenu({ rule: r, x: e.clientX, y: e.clientY }); }}
            >
              <div class="alerts-panel-item-text" data-name="alert-item-description">{description(r)}</div>
              <Show when={r.name && filters().name && filters().message && r.message}>
                <div class="alerts-panel-item-text">{r.message}</div>
              </Show>
              <div class="alerts-panel-attrs">
                <Show when={filters().logo && r.left.kind !== "screen"}>
                  <RowLogo symbol={r.symbol} />
                </Show>
                <span class="alerts-panel-attr alerts-panel-attr--strong" data-name="alert-item-ticker">
                  {r.left.kind === "screen" ? `Screen · ${r.left.title}` : `${tickerOf(r.symbol)}, ${intervalLabel(r.resolution)}`}
                </span>
                <span class="alerts-panel-attr alerts-panel-status" classList={{ "is-active": r.enabled }} data-name="alert-item-status">
                  {r.enabled ? "Active" : r.cloned ? "Paused — Cloned" : "Inactive"}
                </span>
                <Show when={filters().source}>
                  <SourceIcon rule={r} />
                </Show>
                <Show when={filters().triggered && fired().get(r.id)}>
                  {(t) => <span class="alerts-panel-attr" data-name="alert-item-time">{lastTriggeredText(t())}</span>}
                </Show>
                <Show when={props.drawingMissing(r)}>
                  <span class="alerts-panel-attr alerts-panel-warn" title="Source drawing was deleted — this alert can't trigger">
                    <svg viewBox="0 0 18 18" width="14" height="14" aria-hidden="true">
                      <path fill="currentColor" fill-rule="evenodd" d="M9 1.5 17 16H1L9 1.5Zm-.75 5.5h1.5v5h-1.5V7Zm.75 8.1a.9.9 0 1 0 0-1.8.9.9 0 0 0 0 1.8Z" />
                    </svg>
                  </span>
                </Show>
              </div>
              <div class="alerts-panel-row-actions">
                {r.enabled
                  ? rowBtn("alert-stop-button", "Pause", GLYPH.pause, () => setRuleEnabled(r, false))
                  : rowBtn("alert-restart-button", "Restart", GLYPH.restart, () => setRuleEnabled(r, true))}
                {rowBtn("alert-edit-button", "Edit", GLYPH.edit, () => editRule(r))}
                {rowBtn("alert-delete-button", "Delete", GLYPH.trash, () => removeRule(r))}
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
            {m().rule.enabled
              ? <MenuAction icon={GLYPH.pause()} label="Pause" onSelect={act(() => setRuleEnabled(m().rule, false))} />
              : <MenuAction icon={GLYPH.restart()} label="Restart" onSelect={act(() => setRuleEnabled(m().rule, true))} />}
            <MenuAction icon={GLYPH.edit()} label="Edit…" onSelect={act(() => editRule(m().rule))} />
            <MenuAction icon={<Icon name="ot-header-copy-clone" size={28} />} label="Clone" onSelect={act(() => alertStore.clone(m().rule.id))} />
            <MenuAction icon={GLYPH.trash()} label="Delete" onSelect={act(() => removeRule(m().rule))} />
            <MenuSep />
            <MenuAction label="Restart as per filter" disabled={!rules().some((r) => !r.enabled)} onSelect={act(() => restartShown(props.ctx))} />
            <MenuAction label="Pause as per filter" disabled={!rules().some((r) => r.enabled)} onSelect={act(() => pauseShown(props.ctx))} />
            <MenuAction label="Delete as per filter" onSelect={act(() => deleteShown(props.ctx))} />
            <MenuAction label="Delete all inactive" disabled={!alertStore.rules().some((r) => !r.enabled)} onSelect={act(deleteInactive)} />
          </div>
        )}
      </Show>
    </>
  );
}
