/*
 * Multi-tab shell state — each tab is an independent chart view holding its own
 * symbol / interval / chart-type / layout / indicators. Ported from the
 * reference mock's per-tab maps (App-owned chartTypes/layouts/indicators keyed
 * by tab id), collapsed here into one self-contained TabChart record per tab.
 *
 * Electron-only bits from the mock (detach-to-new-window, IPC initial tabs,
 * live per-tab snapshot prices, link channels, title customization) are NOT
 * modelled — see the gap notes in the program memory.
 */
import { DEFAULT_LAYOUT, LAYOUT_SPECS, type LayoutId } from "../chart/layouts";
import { DEFAULT_CHART_TYPE, type ChartTypeId } from "../chart/chart-types";
import { SYMBOLS } from "../../data/symbol-search";
import type { LinkChannels, LinkColor, TabLink } from "./tab-linking";
import { linkGroup, setLinkGroup } from "../../data/link-groups";
import { defaultLayoutSync, reviveLayoutSync, type LayoutSyncState } from "../chart/layout-sync";
import { cloneDraft, loadChartSettingsDefaults, reviveDraft, SETTINGS_FINGERPRINT, SETTINGS_REV, type Draft } from "../header/chart-settings";
import type { SessionId } from "../../data/datafeed";
import type { IndicatorStyleOverrides } from "../chart/indicators/indicator-layer";
import type { IndicatorOptions } from "../chart/indicators/indicator-options";

/** A study's persisted overrides — the inputs + plot styles the user set in the
 *  indicator Settings dialog. Keyed by indicator registry id on the pane. */
export type PaneIndicatorSettings = {
  inputs?: Record<string, unknown>;
  styles?: IndicatorStyleOverrides;
  /** Style-tab output / input options + Visibility tab (indicator-options.ts). */
  options?: IndicatorOptions;
};

/** Restore a persisted pane's `settings` only if its fingerprint matches the
 *  current form structure (else drop both). Re-stamps with the current
 *  fingerprint so a later save round-trips cleanly. Shared by migrateTab and
 *  the saved-layout restore path in App. */
export function revivePaneSettings(
  raw: { settings?: unknown; settingsFp?: unknown; settingsRev?: unknown },
): Pick<PaneChart, "settings" | "settingsFp" | "settingsRev"> {
  const settings = reviveDraft(raw.settings, raw.settingsFp, raw.settingsRev);
  // Always return ALL keys (undefined when dropped) so a `{ ...p, ...revive }`
  // spread overwrites — never leaves a stale draft behind.
  return settings
    ? { settings, settingsFp: SETTINGS_FINGERPRINT, settingsRev: SETTINGS_REV }
    : { settings: undefined, settingsFp: undefined, settingsRev: undefined };
}

/** One chart pane inside a tab's layout — its own symbol / interval / chart-type
 *  / indicators, so every cell of a multi-pane layout is a fully independent
 *  chart (each pane has its own symbol). */
export type PaneChart = {
  /** Stable per-pane id — survives layout reconcile and persistence, so
   *  drawings can be scoped to a single pane ("No sync" mode). Cloned panes
   *  (splits) get a fresh id; persisted panes keep theirs. */
  id: string;
  symbol: string;
  interval: string;
  chartType: ChartTypeId;
  /** Bottom-bar session: regular (09:30–16:00 ET) vs extended hours. Only
   *  affects intraday frames; daily+ ignore it. Defaults to RTH. */
  session: SessionId;
  indicators: string[];
  /** Compared symbols overlaid as line series on this pane (header "Compare
   *  symbols"). Rendered on a shared overlay price scale with its own
   *  autoscale (not a percentage scale). */
  compare?: string[];
  /** Per-indicator settings overrides (Settings dialog → Inputs/Style), keyed by
   *  indicator registry id. Persisted so a study's inputs/colours survive
   *  reloads and ride along in saved layouts. Absent = registry defaults. */
  indicatorSettings?: Record<string, PaneIndicatorSettings>;
  /** Per-pane chart Settings (the dialog's committed draft). Persisted, but
   *  guarded by `settingsFp`: the draft is keyed by TAB_FORMS row index (not
   *  stable across versions), so a draft whose fingerprint no longer matches the
   *  running build is dropped on load rather than mis-applied. "Apply to all"
   *  copies one pane's settings onto every pane. */
  settings?: Draft;
  /** Fingerprint of the TAB_FORMS structure this `settings` draft was written
   *  under. Must equal `SETTINGS_FINGERPRINT` to restore (see reviveDraft). */
  settingsFp?: string;
  /** Value revision of `settings` (SETTINGS_REV when written; absent = 1).
   *  Older drafts are upgraded once on load (see migrateDraft). */
  settingsRev?: number;
  /** Last visible logical range (bar-index based) the user scrolled/zoomed to.
   *  Persisted so switching tabs — and reloading the window — restores the
   *  anchored view instead of snapping to the latest bar. Ignored on restore
   *  when out of bounds for the loaded bar count (e.g. a shorter-history
   *  symbol), in which case the default framing is used. */
  visibleLogicalRange?: { from: number; to: number };
  /** Main series hidden with the legend eye (series `visible` property,
   *  saved with the chart). Absent = shown. */
  seriesHidden?: boolean;
};

export type TabChart = {
  id: string;
  /** Multi-chart template — drives how many panes the tab holds. */
  layout: LayoutId;
  /** Index into `panes` of the focused pane (the one the header / right-rail /
   *  drawing tools act on). */
  activePane: number;
  /** One entry per cell of `layout` (kept in sync by `reconcilePanes`). */
  panes: PaneChart[];
  /** Charts render a symbol; non-chart tabs (future) would render other views. */
  isChart: boolean;
  /** Tab-syncing link colour; absent = unlinked. The channels belong to the
   *  colour's group (data/link-groups.ts). */
  link?: TabLink;
  /** "Sync in layout" toggles of this tab (saved per layout). */
  sync: LayoutSyncState;
  /** Pinned ("Pin tab"): kept in the block at the left of the strip, no
   *  close button, spared by "Close other tabs" / "Close tabs to the right". */
  pinned?: boolean;
  /** Id of the saved layout this tab was loaded from / last saved to (see
   *  data/layout-store.ts). Absent = an unsaved ("Untitled") chart. */
  savedLayoutId?: string;
  /** Cached display name of `savedLayoutId` — shown in the header save badge
   *  without a store lookup. Kept in sync on save / open / rename. */
  savedLayoutName?: string;
};

/** Pane count a layout template requires (one per grid cell). */
export function paneCountFor(layout: LayoutId): number {
  return LAYOUT_SPECS[layout]?.cells.length ?? 1;
}

/** The focused pane of a tab (clamped, never undefined for a chart tab). */
export function activePaneOf(tab: TabChart): PaneChart {
  return tab.panes[tab.activePane] ?? tab.panes[0];
}

/** Grow/shrink a tab's `panes` to match `layout`'s cell count. New panes clone
 *  `template` (the active pane) so a fresh split shows the same chart; extras
 *  are dropped and `activePane` clamped. Returns the patch to apply. */
export function reconcilePanes(
  tab: TabChart,
  layout: LayoutId,
): Pick<TabChart, "layout" | "panes" | "activePane"> {
  const count = paneCountFor(layout);
  const panes = tab.panes.slice(0, count);
  const template = tab.panes[tab.activePane] ?? tab.panes[0];
  while (panes.length < count) {
    panes.push({ ...template, id: newPaneId(), indicators: [...template.indicators] });
  }
  return { layout, panes, activePane: Math.min(tab.activePane, count - 1) };
}

let nextTabId = 1;
export function newTabId(): string {
  return `tab-${nextTabId++}-${Math.random().toString(36).slice(2, 7)}`;
}

let nextPaneId = 1;
export function newPaneId(): string {
  return `pane-${nextPaneId++}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Convenience pane-shaped overrides accepted by `makeTab`. */
type MakeTabPartial = Partial<PaneChart> & { layout?: LayoutId; isChart?: boolean };

/** Studies a brand-new pane starts with (registry ids). `colored-volume` is the
 *  library's Volume bars study — a non-overlay columns pane below price, the
 *  default volume. Only seeds fresh tabs/panes; persisted panes keep their
 *  own saved list. */
export const DEFAULT_INDICATORS: string[] = ["colored-volume"];

export function makeTab(partial: MakeTabPartial = {}): TabChart {
  const { layout = DEFAULT_LAYOUT, isChart = true, ...pane } = partial;
  const base: Omit<PaneChart, "id"> = {
    symbol: pane.symbol ?? "INTC",
    interval: pane.interval ?? "1D",
    chartType: pane.chartType ?? DEFAULT_CHART_TYPE,
    session: pane.session ?? "RTH",
    indicators: pane.indicators ?? [...DEFAULT_INDICATORS],
  };
  const count = paneCountFor(layout);
  // A new chart starts with the user's chart settings defaults, unless
  // the caller passes its own settings.
  const defaults = pane.settings ? undefined : loadChartSettingsDefaults();
  const seed = (): Partial<PaneChart> =>
    pane.settings
      ? { settings: cloneDraft(pane.settings), settingsFp: SETTINGS_FINGERPRINT, settingsRev: SETTINGS_REV }
      : defaults
        ? { settings: cloneDraft(defaults), settingsFp: SETTINGS_FINGERPRINT, settingsRev: SETTINGS_REV }
        : {};
  const panes = Array.from({ length: count }, () => ({ ...base, ...seed(), id: newPaneId(), indicators: [...base.indicators] }));
  return { id: newTabId(), layout, activePane: 0, panes, isChart, sync: defaultLayoutSync() };
}

/** Normalise a persisted/handed-off tab into the current shape — wraps the old
 *  flat {symbol,interval,…} record into a `panes` array, and ensures the pane
 *  count matches the layout (forward-compatible with already-migrated tabs). */
// deno-lint-ignore no-explicit-any
export function migrateTab(raw: any): TabChart {
  const layout: LayoutId = raw?.layout ?? DEFAULT_LAYOUT;
  const isChart = raw?.isChart ?? true;
  const id = typeof raw?.id === "string" ? raw.id : newTabId();
  let panes: PaneChart[];
  let activePane = Number.isInteger(raw?.activePane) ? raw.activePane : 0;
  if (Array.isArray(raw?.panes) && raw.panes.length > 0) {
    panes = raw.panes.map((p: Partial<PaneChart>) => ({
      id: typeof p.id === "string" ? p.id : newPaneId(),
      symbol: p.symbol ?? "INTC",
      interval: p.interval ?? "1D",
      chartType: p.chartType ?? DEFAULT_CHART_TYPE,
      session: p.session ?? "RTH",
      indicators: Array.isArray(p.indicators) ? [...p.indicators] : [],
      indicatorSettings:
        p.indicatorSettings && typeof p.indicatorSettings === "object" ? p.indicatorSettings : undefined,
      visibleLogicalRange:
        p.visibleLogicalRange &&
        typeof p.visibleLogicalRange.from === "number" &&
        typeof p.visibleLogicalRange.to === "number"
          ? { from: p.visibleLogicalRange.from, to: p.visibleLogicalRange.to }
          : undefined,
      seriesHidden: p.seriesHidden === true ? true : undefined,
      ...revivePaneSettings(p),
    }));
  } else {
    const base: PaneChart = {
      id: newPaneId(),
      symbol: raw?.symbol ?? "INTC",
      interval: raw?.interval ?? "1D",
      chartType: raw?.chartType ?? DEFAULT_CHART_TYPE,
      session: raw?.session ?? "RTH",
      indicators: Array.isArray(raw?.indicators) ? [...raw.indicators] : [],
    };
    panes = [base];
  }
  // Reconcile to the layout's cell count.
  const sync = reviveLayoutSync(raw?.sync);
  const stub: TabChart = { id, layout, activePane, panes, isChart, sync };
  const reconciled = reconcilePanes(stub, layout);
  const link: TabLink | undefined =
    raw?.link && typeof raw.link.color === "string" ? { color: raw.link.color as LinkColor } : undefined;
  // Tabs saved before the channels moved to the group carry their own switches:
  // they seed the colour's group once, so the user's choice is kept.
  if (link && raw.link.channels && typeof raw.link.channels === "object" && !linkGroup(link.color)) {
    const pane = reconciled.panes[reconciled.activePane] ?? reconciled.panes[0];
    setLinkGroup(link.color, {
      channels: raw.link.channels as LinkChannels,
      symbol: pane?.symbol,
      interval: pane?.interval,
    });
  }
  const savedLayoutId = typeof raw?.savedLayoutId === "string" ? raw.savedLayoutId : undefined;
  const savedLayoutName = typeof raw?.savedLayoutName === "string" ? raw.savedLayoutName : undefined;
  const pinned = raw?.pinned === true ? true : undefined;
  return { id, isChart, ...reconciled, sync, link, pinned, savedLayoutId, savedLayoutName };
}

/** Full "EXCHANGE:TICKER" for a bare ticker, falling back to the ticker. */
export function fullSymbolFor(ticker: string): string {
  return SYMBOLS.find((s) => s.ticker === ticker)?.symbolName ?? ticker;
}

/** Tab strip title — "EXCHANGE:TICKER, INTERVAL" of the tab's active pane
 *  (tab caption). */
export function tabTitle(tab: TabChart): string {
  const pane = activePaneOf(tab);
  return `${fullSymbolFor(pane.symbol)}, ${pane.interval}`;
}

/** First letter of a ticker, for the EmptyLogo circle. */
export function tickerInitial(ticker: string): string {
  return (ticker[0] ?? "").toUpperCase();
}

/** Layout-name part shown after the ticker ("/ Daily"), derived from interval
 *  (the mock has no saved layout names). */
export function layoutNameFromInterval(interval: string): string {
  const s = interval.toUpperCase();
  switch (s) {
    case "1D": return "Daily";
    case "1W": return "Weekly";
    case "1M": return "Monthly";
    case "12M": return "Yearly";
    default: break;
  }
  if (/^\d+M$/.test(s)) return `${s.slice(0, -1)} Months`;
  if (/^\d+W$/.test(s)) return `${s.slice(0, -1)} Weeks`;
  if (/^\d+D$/.test(s)) return `${s.slice(0, -1)} Days`;
  return "Intraday";
}

// Per-window storage (Tauri WebView2 windows share one localStorage origin, so
// each window scopes its tab state by its window label — see window-bridge.ts).
const tabsKey = (label: string) => `ot:tabs:${label}`;
const activeKey = (label: string) => `ot:active-tab:${label}`;

type Persisted = { tabs: TabChart[]; activeId: string };

/** Reseed the id counter past a restored id so fresh tabs don't collide. */
function bumpSeqPast(id: string): void {
  const n = Number(/^tab-(\d+)-/.exec(id)?.[1]);
  if (Number.isFinite(n) && n >= nextTabId) nextTabId = n + 1;
}

/**
 * Load this window's tabs. `seed` (a tab handed off by a detach) wins — a
 * detached window opens showing only that one tab. Otherwise restore the
 * label-scoped persisted set, falling back to the default three on the main
 * window's first run.
 */
export function loadTabs(label: string, seed?: TabChart | null): Persisted {
  if (seed) {
    const tab = migrateTab(seed);
    bumpSeqPast(tab.id);
    return { tabs: [tab], activeId: tab.id };
  }
  try {
    const raw = localStorage.getItem(tabsKey(label));
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const tabs = parsed.map(migrateTab);
        for (const t of tabs) bumpSeqPast(t.id);
        const activeId = localStorage.getItem(activeKey(label));
        return {
          tabs,
          activeId: activeId && tabs.some((t) => t.id === activeId) ? activeId : tabs[0].id,
        };
      }
    }
  } catch {
    /* malformed / unavailable — fall through to defaults */
  }
  // Detached windows that lost their handoff shouldn't resurrect the default
  // three; only the main window seeds the starter set.
  const tabs =
    label === "main"
      ? [
          makeTab({ symbol: "INTC", interval: "1D" }),
          makeTab({ symbol: "AAPL", interval: "60" }),
          makeTab({ symbol: "TSLA", interval: "240" }),
        ]
      : [makeTab()];
  return { tabs, activeId: tabs[0].id };
}

export function saveTabs(label: string, tabs: TabChart[], activeId: string): void {
  try {
    localStorage.setItem(tabsKey(label), JSON.stringify(tabs));
    localStorage.setItem(activeKey(label), activeId);
  } catch {
    /* best-effort */
  }
}

/** Drop a window's persisted tab state — used to GC closed detached/new windows. */
export function clearTabs(label: string): void {
  try {
    localStorage.removeItem(tabsKey(label));
    localStorage.removeItem(activeKey(label));
  } catch {
    /* best-effort */
  }
}

/** Tabs linked to `color` in every OTHER window (read from their persisted tab
 *  state, which saveTabs keeps current). Windows that closed have already
 *  cleared their keys (window-bridge.ts). */
export function linkedTabCountInOtherWindows(color: LinkColor, exceptLabel: string): number {
  let n = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith("ot:tabs:") || key === tabsKey(exceptLabel)) continue;
      const parsed = JSON.parse(localStorage.getItem(key) ?? "[]");
      if (!Array.isArray(parsed)) continue;
      for (const t of parsed) if (t?.link?.color === color) n++;
    }
  } catch {
    /* unreadable entry: count what was read */
  }
  return n;
}

/** Number of pinned tabs (they always sit first). */
export function pinnedCount(tabs: TabChart[]): number {
  const i = tabs.findIndex((t) => !t.pinned);
  return i === -1 ? tabs.length : i;
}

/** Where a tab may be inserted: a pinned
 *  tab inside the pinned block, an unpinned one after it. */
export function insertPosition(tabs: TabChart[], pinned: boolean, requested?: number): number {
  const count = pinnedCount(tabs);
  if (pinned) return requested === undefined ? count : Math.min(Math.max(requested, 0), count);
  if (requested !== undefined && requested <= tabs.length) return Math.max(requested, count);
  return tabs.length;
}

/** Drag target index kept on the dragged tab's side of the pinned border. */
export function clampMoveIndex(tabs: TabChart[], from: number, to: number): number {
  const first = tabs.findIndex((t) => !t.pinned);
  if (first === -1) return to;
  if (tabs[from]?.pinned) return to >= first ? first - 1 : to;
  return to < first ? first : to;
}

