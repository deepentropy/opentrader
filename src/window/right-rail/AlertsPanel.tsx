/*
 * AlertsPanel — right-rail "alerts" tab. Two views via the segmented control:
 *   • Alerts — the configured alert *rules* (toggle / edit / delete)
 *   • Log    — the fired-event history
 *
 * Both are backed by the local alert-store (data/alert-store.ts); the engine
 * (data/alert-engine.ts) evaluates the rules and appends fires. Editing a rule
 * dispatches the same window event the header/chart use to open AlertDialog.
 *
 * Header toolbar: clear-log, an Options menu (mark all read / clear log), and
 * a filters popover (symbol + active-rules-only) that narrows the Log view.
 * "Read" state is a single kv watermark (fires newer than it show a dot) —
 * the store's Fire records stay untouched.
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { TvIcon } from "../../components/TvIcon";
import { Tooltip } from "../../components/Tooltip";
import { SegmentedControl } from "../../components/SegmentedControl";
import { PanelHeader } from "../../components/PanelHeader";
import { IconButton } from "../../components/IconButton";
import { TABS, TOOLBAR } from "../../data/alerts-panel";
import { alertStore, type AlertRule } from "../../data/alert-store";
import { describeCondition, ruleDrawingMissing } from "../../data/alert-condition";
import { resetRuleEvalState, setAlertWebhook } from "../../data/alert-engine";
import * as kv from "../../data/kv";

const LOG_READ_KEY = "tv:alerts:log-read:v1";
function loadLastRead(): number {
  const n = Number(kv.getItem(LOG_READ_KEY));
  return Number.isFinite(n) ? n : 0;
}

function clockTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function openEdit(rule: AlertRule): void {
  window.dispatchEvent(
    new CustomEvent("chart-open-alert-dialog", { detail: { editId: rule.id } }),
  );
}

export function AlertsPanel() {
  const [view, setView] = createSignal<string>("alerts");

  // Deleted-drawing detection for drawing-operand rules: re-checked on each
  // render of the rules list and whenever another window edits any symbol's
  // drawings (kv prefix change). Same-window deletes catch up on the next
  // rules-list render — good enough per TV, which only flags, never disables.
  const [drawingsRev, setDrawingsRev] = createSignal(0);
  onCleanup(kv.onExternalChangePrefix("tv:drawings:", () => setDrawingsRev((n) => n + 1)));
  const drawingMissing = (rule: AlertRule): boolean => {
    drawingsRev();
    return ruleDrawingMissing(rule);
  };

  // One popover at a time: the Options menu or the filters menu.
  const [optionsOpen, setOptionsOpen] = createSignal(false);
  const [filtersOpen, setFiltersOpen] = createSignal(false);
  let toolbarEl: HTMLDivElement | undefined;
  onMount(() => {
    const onDown = (e: PointerEvent) => {
      if (!toolbarEl || toolbarEl.contains(e.target as Node)) return;
      setOptionsOpen(false);
      setFiltersOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    onCleanup(() => window.removeEventListener("pointerdown", onDown));
  });

  // ── Log filters ── symbol (from the fires present) + active-rules-only.
  const [filterSymbol, setFilterSymbol] = createSignal<string>("");
  const [filterActive, setFilterActive] = createSignal(false);
  const filterCount = () => (filterSymbol() ? 1 : 0) + (filterActive() ? 1 : 0);
  const logSymbols = createMemo(() =>
    [...new Set(alertStore.fires().map((f) => f.symbol))].sort(),
  );
  const enabledIds = createMemo(() => new Set(alertStore.enabledRules().map((r) => r.id)));
  const visibleFires = createMemo(() =>
    alertStore.fires().filter(
      (f) =>
        (!filterSymbol() || f.symbol === filterSymbol()) &&
        (!filterActive() || enabledIds().has(f.alertId)),
    ),
  );

  // ── Read watermark ── fires newer than it render an unread dot.
  const [lastRead, setLastRead] = createSignal(loadLastRead());
  onCleanup(kv.onExternalChange(LOG_READ_KEY, () => setLastRead(loadLastRead())));
  const markAllRead = () => {
    const now = Date.now();
    setLastRead(now);
    try {
      kv.setItem(LOG_READ_KEY, String(now));
    } catch {
      /* best-effort */
    }
  };

  const clearLog = () => alertStore.clearFires();

  const onToolbarClick = (dataName: string) => {
    if (dataName === "clear-log-button") clearLog();
    else if (dataName === "alerts-log-actions-button") {
      setFiltersOpen(false);
      setOptionsOpen((o) => !o);
    } else if (dataName === "alerts-dropdown-filters-count") {
      setOptionsOpen(false);
      setFiltersOpen((o) => !o);
    }
  };

  return (
    <aside class="tv-rail-panel alerts-panel" aria-label="Alerts">
      <PanelHeader
        ariaLabel="Alerts header"
        left={<SegmentedControl items={TABS} value={view()} onChange={setView} ariaLabel="Alerts view" />}
        right={
          <div class="alerts-panel-toolbar-group" ref={toolbarEl}>
            <For each={TOOLBAR}>
              {(t) => (
                <Tooltip text={t.label ?? "Filters"} side="bottom">
                  <IconButton
                    data-name={t.dataName}
                    aria-label={t.label ?? "Filters"}
                    aria-pressed={
                      (t.dataName === "alerts-log-actions-button" && optionsOpen()) ||
                      (t.dataName === "alerts-dropdown-filters-count" && (filtersOpen() || filterCount() > 0)) ||
                      undefined
                    }
                    onClick={() => onToolbarClick(t.dataName)}
                  >
                    <Show
                      when={t.iconName}
                      fallback={
                        <span class="alerts-panel-toolbar-text">
                          {t.dataName === "alerts-dropdown-filters-count"
                            ? `Filters${filterCount() ? ` · ${filterCount()}` : ""}`
                            : t.label}
                        </span>
                      }
                    >
                      <TvIcon name={t.iconName!} size={18} />
                    </Show>
                  </IconButton>
                </Tooltip>
              )}
            </For>

            {/* Options menu */}
            <Show when={optionsOpen()}>
              <div class="tv-popover alerts-panel-menu" role="menu" aria-label="Alert log options">
                <button
                  type="button"
                  role="menuitem"
                  class="tv-menu-item"
                  onClick={() => {
                    markAllRead();
                    setOptionsOpen(false);
                  }}
                >
                  <span class="tv-menu-item__label">Mark all as read</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  class="tv-menu-item"
                  onClick={() => {
                    clearLog();
                    setOptionsOpen(false);
                  }}
                >
                  <span class="tv-menu-item__label">Clear log</span>
                </button>
              </div>
            </Show>

            {/* Filters popover */}
            <Show when={filtersOpen()}>
              <div class="tv-popover alerts-panel-menu alerts-panel-filters" aria-label="Alert log filters">
                <label class="alerts-panel-filter-row">
                  <span>Symbol</span>
                  <select
                    class="wl-dialog-input"
                    value={filterSymbol()}
                    onChange={(e) => setFilterSymbol(e.currentTarget.value)}
                  >
                    <option value="">All symbols</option>
                    <For each={logSymbols()}>{(s) => <option value={s}>{s}</option>}</For>
                  </select>
                </label>
                <label class="alerts-panel-filter-row alerts-panel-filter-check">
                  <input
                    type="checkbox"
                    checked={filterActive()}
                    onChange={() => setFilterActive((v) => !v)}
                  />
                  <span>Active alerts only</span>
                </label>
                <Show when={filterCount() > 0}>
                  <button
                    type="button"
                    class="tv-menu-item alerts-panel-filter-reset"
                    onClick={() => {
                      setFilterSymbol("");
                      setFilterActive(false);
                    }}
                  >
                    <span class="tv-menu-item__label">Reset filters</span>
                  </button>
                </Show>
              </div>
            </Show>
          </div>
        }
      />
      <div class="alerts-panel-body">
        {/* ── Configured rules ── */}
        <Show when={view() === "alerts"}>
          <Show
            when={alertStore.rules().length > 0}
            fallback={
              <div class="tv-empty-state alerts-panel-empty">
                No alerts yet. Right-click the chart or use the header “Alert” button to create one.
              </div>
            }
          >
            <For each={alertStore.rules()}>
              {(r) => (
                <div
                  data-name="alert-rule-item"
                  class="alerts-panel-rule"
                  classList={{ "is-disabled": !r.enabled }}
                  onClick={() => openEdit(r)}
                >
                  <label class="alerts-panel-rule-toggle" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={r.enabled}
                      onChange={() => alertStore.setEnabled(r.id, !r.enabled)}
                      aria-label={r.enabled ? "Disable alert" : "Enable alert"}
                    />
                  </label>
                  <div class="alerts-panel-rule-main">
                    <div class="alerts-panel-rule-title">
                      <span class="alerts-panel-rule-symbol">{r.symbol}</span>
                      <Show when={r.name}>
                        <span class="alerts-panel-rule-name">{r.name}</span>
                      </Show>
                      <Show when={drawingMissing(r)}>
                        <span
                          class="alerts-panel-rule-warn"
                          title="Source drawing was deleted — this alert can't trigger"
                          style={{ color: "var(--color-invalid-symbol)", display: "inline-flex" }}
                        >
                          <svg viewBox="0 0 18 18" width="14" height="14" aria-hidden="true">
                            <path
                              fill="currentColor"
                              fill-rule="evenodd"
                              d="M9 1.5 17 16H1L9 1.5Zm-.75 5.5h1.5v5h-1.5V7Zm.75 8.1a.9.9 0 1 0 0-1.8.9.9 0 0 0 0 1.8Z"
                            />
                          </svg>
                        </span>
                      </Show>
                    </div>
                    <div class="alerts-panel-rule-cond">{describeCondition(r)}</div>
                  </div>
                  <button
                    type="button"
                    class="alerts-panel-rule-delete"
                    aria-label="Delete alert"
                    onClick={(e) => {
                      e.stopPropagation();
                      resetRuleEvalState(r.id);
                      setAlertWebhook(r.id, null);
                      alertStore.remove(r.id);
                    }}
                  >
                    <svg viewBox="0 0 18 18" width="16" height="16">
                      <path stroke="currentColor" stroke-width="1.2" fill="none" d="m1.5 1.5 15 15m0-15-15 15" />
                    </svg>
                  </button>
                </div>
              )}
            </For>
          </Show>
        </Show>

        {/* ── Fired-event log ── */}
        <Show when={view() === "log"}>
          <Show
            when={visibleFires().length > 0}
            fallback={
              <div class="tv-empty-state alerts-panel-empty">
                {alertStore.fires().length > 0 ? "No events match the filters" : "No events yet"}
              </div>
            }
          >
            <For each={visibleFires()}>
              {(e) => (
                <div
                  data-name="alert-log-item"
                  class="alerts-panel-log-item"
                  classList={{ unread: e.fireTime > lastRead() }}
                >
                  <div class="alerts-panel-log-message">{e.message}</div>
                  <div class="alerts-panel-log-meta">
                    <Show
                      when={e.logoUrl}
                      fallback={<span class="alerts-panel-log-logo placeholder" />}
                    >
                      <img src={e.logoUrl!} alt="" class="tv-ticker-logo tv-ticker-logo--sm alerts-panel-log-logo" crossorigin="anonymous" referrerpolicy="no-referrer" />
                    </Show>
                    <span class="alerts-panel-log-ticker">{`${e.symbol}, ${e.resolution}`}</span>
                    <span class="alerts-panel-log-time">{clockTime(e.fireTime)}</span>
                  </div>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>
    </aside>
  );
}
