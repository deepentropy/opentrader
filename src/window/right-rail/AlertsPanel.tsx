/*
 * AlertsPanel — right-rail "alerts" tab: the Alerts / Log switch across the
 * header, a toolbar row under it, then the view:
 *   • Alerts — the configured alert *rules* (./AlertRules: list + toolbar)
 *   • Log    — the fired-event history, grouped by day
 *
 * Both are backed by the local alert-store (data/alert-store.ts); the engine
 * (data/alert-engine.ts) evaluates the rules and appends fires. Editing a rule
 * dispatches the same window event the header/chart use to open AlertDialog.
 *
 * Log toolbar: Clear log on the left; on the right the Options menu
 * (Download log as CSV, then the sections Filter events: current symbol /
 * time interval; Show events by type: price, technicals, watchlist; Customize
 * list: name, message, instrument logo, webhook status), its button counting
 * the filters applied. A row's Delete button (on hover) removes that event.
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { tickerOf } from "../../data/symbol-name";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { SegmentedControl } from "../../components/SegmentedControl";
import { PanelHeader } from "../../components/PanelHeader";
import { IconButton } from "../../components/IconButton";
import { TABS } from "../../data/alerts-panel";
import { alertStore, type AlertFire, type AlertRule } from "../../data/alert-store";
import { ruleDrawingMissing } from "../../data/alert-condition";
import { intervalLabel } from "../../data/datafeed";
import { csvFileName, downloadText } from "../screener/screener-csv";
import { webhookStatus } from "../../data/webhook-status";
import { AlertRulesList, AlertRulesToolbar, OptionsButton, RowLogo, isTechnical } from "./AlertRules";
import { GLYPH, MenuAction, MenuSection, MenuToggle } from "./alerts-menu";
import * as kv from "../../data/kv";

type LogFilters = { symbol: boolean; interval: boolean; price: boolean; technicals: boolean; watchlist: boolean; name: boolean; message: boolean; logo: boolean; webhook: boolean };
const LOG_DEFAULTS: LogFilters = { symbol: false, interval: false, price: true, technicals: true, watchlist: true, name: true, message: true, logo: true, webhook: true };
const LOG_VIEW_KEY = "ot:alerts:log-view:v1";
function loadLogFilters(): LogFilters {
  try {
    const v = JSON.parse(kv.getItem(LOG_VIEW_KEY) ?? "null") as Partial<LogFilters> | null;
    const out = { ...LOG_DEFAULTS };
    for (const k of Object.keys(LOG_DEFAULTS) as (keyof LogFilters)[]) if (typeof v?.[k] === "boolean") out[k] = v[k]!;
    return out;
  } catch {
    return { ...LOG_DEFAULTS };
  }
}

const pad = (n: number) => String(n).padStart(2, "0");
const clockTime = (ms: number) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
/** Day group title ("October 22"; the panel writes it in capitals). */
const dayTitle = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "long", day: "numeric" });
const dayKey = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };

/** Type of an event: a watchlist alert, else that of its rule (price when the rule is gone). */
function fireType(f: AlertFire, rules: Map<string, AlertRule>): "price" | "technicals" | "watchlist" {
  if (f.alertId.startsWith("list:")) return "watchlist";
  const r = rules.get(f.alertId);
  return r && isTechnical(r) ? "technicals" : "price";
}

/** The log as CSV: one row per event, as the list shows them. */
function logCsv(fires: AlertFire[]): string {
  const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const rows = fires.map((f) => {
    const d = new Date(f.fireTime);
    return [`${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${clockTime(f.fireTime)}`, f.symbol, intervalLabel(f.resolution), f.name ?? "", f.message].map(cell).join(",");
  });
  return ["Time,Symbol,Interval,Name,Message", ...rows].join("\n");
}

export function AlertsPanel(props: { symbol?: string; interval?: string; onShow?: (symbol: string, interval: string) => void; onOpenSettings?: () => void }) {
  const [view, setView] = createSignal<string>("alerts");
  /** Chart the "Current symbol" / "Current time interval" filters refer to. */
  const ctx = () => ({ symbol: props.symbol ?? "", interval: props.interval ?? "" });

  // Deleted-drawing detection for drawing-operand rules: re-checked on each
  // render of the rules list and whenever another window edits any symbol's
  // drawings (kv prefix change). Same-window deletes catch up on the next
  // rules-list render — good enough, since a missing drawing only flags the
  // rule, never disables it.
  const [drawingsRev, setDrawingsRev] = createSignal(0);
  onCleanup(kv.onExternalChangePrefix("ot:drawings:", () => setDrawingsRev((n) => n + 1)));
  const drawingMissing = (rule: AlertRule): boolean => {
    drawingsRev();
    return ruleDrawingMissing(rule);
  };

  // ── Log ──
  const [logFilters, setLogFiltersSignal] = createSignal<LogFilters>(loadLogFilters());
  const flipLog = (k: keyof LogFilters) => {
    const next = { ...logFilters(), [k]: !logFilters()[k] };
    setLogFiltersSignal(next);
    try {
      kv.setItem(LOG_VIEW_KEY, JSON.stringify(next));
    } catch {
      /* best-effort */
    }
  };
  const logFilterCount = () => {
    const f = logFilters();
    return (f.symbol ? 1 : 0) + (f.interval ? 1 : 0) + (f.price ? 0 : 1) + (f.technicals ? 0 : 1) + (f.watchlist ? 0 : 1);
  };
  const visibleFires = createMemo(() => {
    const f = logFilters();
    const rules = new Map(alertStore.rules().map((r) => [r.id, r]));
    const sym = ctx().symbol.toUpperCase();
    return alertStore.fires().filter(
      (e) => (!f.symbol || e.symbol === sym) && (!f.interval || e.resolution === ctx().interval) && f[fireType(e, rules)],
    );
  });
  /** Events by day, newest day first (the log is kept newest first). */
  const days = createMemo(() => {
    const out: { key: string; title: string; fires: AlertFire[] }[] = [];
    for (const e of visibleFires()) {
      const key = dayKey(e.fireTime);
      if (out[out.length - 1]?.key !== key) out.push({ key, title: dayTitle(e.fireTime), fires: [] });
      out[out.length - 1].fires.push(e);
    }
    return out;
  });

  const [logMenu, setLogMenu] = createSignal(false);
  let logToolbarEl: HTMLDivElement | undefined;
  onMount(() => {
    const onDown = (e: PointerEvent) => { if (logToolbarEl && !logToolbarEl.contains(e.target as Node)) setLogMenu(false); };
    window.addEventListener("pointerdown", onDown);
    onCleanup(() => window.removeEventListener("pointerdown", onDown));
  });

  return (
    <aside class="ot-rail-panel alerts-panel" aria-label="Alerts">
      <PanelHeader
        ariaLabel="Alerts header"
        left={<SegmentedControl items={TABS} value={view()} onChange={setView} ariaLabel="Alerts view" class="alerts-panel-tabs" />}
      />
      <Show
        when={view() === "log"}
        fallback={<AlertRulesToolbar ctx={ctx()} onOpenSettings={props.onOpenSettings} />}
      >
        <div class="alerts-panel-subheader" ref={logToolbarEl}>
          <Tooltip text="Clear log" side="bottom">
            <IconButton data-name="clear-log-button" aria-label="Clear log" class="alerts-panel-tool" onClick={() => alertStore.clearFires()}>
              <Icon name="al-clear-log" size={28} />
            </IconButton>
          </Tooltip>
          <div class="alerts-panel-subheader-right">
            <OptionsButton name="alerts-log-actions-button" count={logFilterCount()} pressed={logMenu()} onClick={() => setLogMenu((o) => !o)} />
          </div>
          <Show when={logMenu()}>
            <div class="ot-popover alerts-panel-menu" role="menu" aria-label="Alert log options">
              <MenuAction
                icon={GLYPH.download()}
                label="Download log as CSV"
                disabled={visibleFires().length === 0}
                onSelect={() => { downloadText(csvFileName("Alerts log"), logCsv(visibleFires())); setLogMenu(false); }}
              />
              <MenuSection title="Filter events">
                <MenuToggle label="Current symbol" checked={logFilters().symbol} onSelect={() => flipLog("symbol")} />
                <MenuToggle label="Current time interval" checked={logFilters().interval} onSelect={() => flipLog("interval")} />
              </MenuSection>
              <MenuSection title="Show events by type">
                <MenuToggle label="Price" checked={logFilters().price} onSelect={() => flipLog("price")} />
                <MenuToggle label="Technicals" checked={logFilters().technicals} onSelect={() => flipLog("technicals")} />
                <MenuToggle label="Watchlist" checked={logFilters().watchlist} onSelect={() => flipLog("watchlist")} />
              </MenuSection>
              <MenuSection title="Customize list">
                <MenuToggle label="Name" checked={logFilters().name} onSelect={() => flipLog("name")} />
                <MenuToggle label="Message" checked={logFilters().message} onSelect={() => flipLog("message")} />
                <MenuToggle label="Instrument logo" checked={logFilters().logo} onSelect={() => flipLog("logo")} />
                <MenuToggle label="Webhook status" checked={logFilters().webhook} onSelect={() => flipLog("webhook")} />
              </MenuSection>
            </div>
          </Show>
        </div>
      </Show>
      <div class="alerts-panel-body">
        {/* ── Configured rules ── */}
        <Show when={view() === "alerts"}>
          <AlertRulesList ctx={ctx()} drawingMissing={drawingMissing} onShow={props.onShow} />
        </Show>

        {/* ── Fired-event log ── */}
        <Show when={view() === "log"}>
          <Show
            when={visibleFires().length > 0}
            fallback={
              <Show when={alertStore.fires().length === 0}>
                <div class="ot-empty-state alerts-panel-empty">No events yet</div>
              </Show>
            }
          >
            <For each={days()}>
              {(day) => (
                <>
                  <div class="alerts-panel-day">{day.title}</div>
                  <For each={day.fires}>
                    {(e) => (
                      <div data-name="alert-log-item" class="alerts-panel-item">
                        <Show when={logFilters().name && e.name}>
                          <div class="alerts-panel-item-text alerts-panel-item-name">{e.name}</div>
                        </Show>
                        <Show when={logFilters().message}>
                          <div class="alerts-panel-item-text">{e.message}</div>
                        </Show>
                        <div class="alerts-panel-attrs">
                          <Show when={logFilters().logo}>
                            <RowLogo symbol={e.symbol} />
                          </Show>
                          <span class="alerts-panel-attr alerts-panel-attr--strong">{`${tickerOf(e.symbol)}, ${intervalLabel(e.resolution)}`}</span>
                          <span class="alerts-panel-attr">{clockTime(e.fireTime)}</span>
                        </div>
                        <Show when={logFilters().webhook && webhookStatus(e.webhook)}>
                          {(w) => (
                            <div class="alerts-panel-webhook" classList={{ "is-ok": w().ok }} data-name="alert-log-webhook-status">
                              <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
                                <path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d={w().ok ? "M9 16a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM6 9.2l2 2 4-4.4" : "M9 16a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM9 5.5v4.5M9 12.5v.01"} />
                              </svg>
                              <span>{w().text}</span>
                            </div>
                          )}
                        </Show>
                        <div class="alerts-panel-row-actions">
                          <Tooltip text="Delete" side="bottom">
                            <button type="button" class="alerts-panel-row-btn" data-name="event-delete-button" aria-label="Delete" onClick={() => alertStore.removeFire(e.fireId)}>
                              {GLYPH.trash()}
                            </button>
                          </Tooltip>
                        </div>
                      </div>
                    )}
                  </For>
                </>
              )}
            </For>
          </Show>
        </Show>
      </div>
    </aside>
  );
}
