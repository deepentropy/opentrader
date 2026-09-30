/*
 * ScreenerPanel: the Stock Screener as a right split-view panel (TradingView
 * Desktop 3.4.1, opened by the right-rail "Screeners" button):
 *   a 4 px resizer at its left edge (drag, width persisted), a 50 px header
 *   (title "Stock Screener", Fullscreen mode, Close), then the screener:
 *   topbar, filter pills, control panel (Column sets, Refresh with its
 *   countdown badge, Maximize) and the results table.
 * The main layout (header toolbar, drawing toolbar, charts, rail) shrinks to
 * the remaining width; Fullscreen mode gives the panel the whole window.
 *
 * Data: `screenerOpen(owner)` starts the backend's 10 s polling while the
 * panel is mounted; every `screener-update` re-runs the scan (visible pages),
 * every screen change re-plans it. The Refresh badge counts down the seconds
 * to the next update ("Time to refresh"), like TV's 10 s auto refresh.
 */
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { Icon } from "../../components/Icon";
import type { FieldInfo } from "../../bindings";
import { POLL_MS, onScreenerUpdate, screenerClose, screenerFields, screenerOpen } from "../../data/screener-api";
import {
  COLUMN_SETS,
  CUSTOM_SET_ID,
  CUSTOM_SET_TITLE,
  fieldOf,
  sameColumn,
  type ColumnRef,
} from "../../data/screener-catalog";
import { activeColumns, planScreen, type Plan } from "../../data/screener-query";
import { PANEL_MIN_WIDTH, screenerPanel, screenerStore } from "../../data/screener-store";
import { watchlistStore } from "../../data/watchlist-store";
import type { FlagColor } from "../../data/watchlist";
import { FilterPills, watchlistTickers } from "./FilterPills";
import { PopItem, PopSectionTitle, Popover } from "./Popover";
import { ScreenerTable } from "./ScreenerTable";
import { ScreenerTopbar } from "./ScreenerTopbar";
import { createScanController } from "./scan-controller";

type Props = {
  /** Window label; the backend owner is `${label}:screener`. */
  windowLabel: string;
  /** Same callback as the watchlist row pick (sets the chart symbol). */
  onSymbolPicked: (ticker: string) => void;
};

export function ScreenerPanel(props: Props) {
  const owner = `${props.windowLabel}:screener`;
  const [fields, setFields] = createSignal<Map<string, FieldInfo> | null>(null);
  const has = (f: string) => fields()?.has(f) ?? false;
  const [lastUpdate, setLastUpdate] = createSignal<number | null>(null);
  const [now, setNow] = createSignal(Date.now());
  const [selected, setSelected] = createSignal<string | null>(null);
  const [setsOpen, setSetsOpen] = createSignal(false);
  const [manualRefresh, setManualRefresh] = createSignal(false);
  const [resetKey, setResetKey] = createSignal(0);
  let setsBtn!: HTMLButtonElement;

  const screen = screenerStore.screen;
  const tickers = createMemo(() => watchlistTickers(screen().watchlistId));
  const plan = createMemo<Plan | null>(() => (fields() ? planScreen(screen(), has, tickers()) : null));
  const ctl = createScanController(plan);

  // Re-plan → reset rows (only when the request really changes).
  createEffect(
    on(
      () => {
        const p = plan();
        return p ? JSON.stringify([p.fields, p.filter, p.sort, p.tickers]) : "";
      },
      (key) => {
        if (!key) return;
        ctl.reset();
        setResetKey((k) => k + 1);
      },
    ),
  );
  createEffect(() => {
    if (!ctl.loading()) setManualRefresh(false);
  });

  onMount(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void (async () => {
      try {
        const list = await screenerFields();
        if (disposed) return;
        setFields(new Map(list.map((f) => [f.id, f])));
        const st = await screenerOpen(owner);
        if (disposed) return;
        if (st.updatedMs !== null) setLastUpdate(Date.now());
        unlisten = await onScreenerUpdate((u) => {
          setLastUpdate(Date.now());
          if (!u.error) ctl.refresh();
        });
        if (disposed) unlisten();
      } catch (e) {
        console.error("[screener] open failed", e);
      }
    })();
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => {
      disposed = true;
      window.clearInterval(tick);
      unlisten?.();
      void screenerClose(owner).catch(() => {});
    });
  });

  // Seconds to the next backend update (TV "Time to refresh").
  const countdown = () => {
    const t = lastUpdate();
    if (t === null) return null;
    const s = Math.floor((t + POLL_MS - now()) / 1000);
    return s > 0 ? s : null;
  };

  // Column set helpers.
  const offeredSets = () =>
    COLUMN_SETS.filter((s) => s.columns.some((c) => {
      const f = fieldOf(c);
      return f !== null && has(f);
    }));
  const setTitle = () =>
    screen().activeColumnSetId === CUSTOM_SET_ID ? CUSTOM_SET_TITLE : COLUMN_SETS.find((s) => s.id === screen().activeColumnSetId)?.title ?? "";
  /** Write a new column list: TV stores it as the "custom" set and selects it. */
  const setColumns = (fn: (cols: ColumnRef[]) => ColumnRef[]) =>
    screenerStore.update((s) => ({ ...s, customColumns: fn([...activeColumns(s)]), activeColumnSetId: CUSTOM_SET_ID }));

  // Flags of the rows = flags of the symbols in the OpenTrader watchlists.
  const flags = createMemo(() => {
    const m = new Map<string, FlagColor>();
    for (const l of watchlistStore.lists()) {
      for (const r of [...l.groups.flatMap((g) => g.rows), ...l.extras]) {
        if (r.flag) m.set(r.ticker.split(":").pop() ?? r.ticker, r.flag);
      }
    }
    return m;
  });

  // Resizer: drag the 4 px strip; the panel grows to the left.
  const beginResize = (e: MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = screenerPanel.width();
    const maxW = () => Math.max(PANEL_MIN_WIDTH, document.documentElement.clientWidth - 360);
    const onMove = (ev: MouseEvent) => screenerPanel.setWidth(Math.min(maxW(), startW + (startX - ev.clientX)));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      screenerPanel.setWidth(screenerPanel.width(), true);
    };
    document.body.style.cursor = "ew-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div
      class="scr-split"
      classList={{ "is-fullscreen": screenerPanel.fullscreen() }}
      style={{ width: screenerPanel.fullscreen() ? undefined : `${screenerPanel.width()}px` }}
    >
      <Show when={!screenerPanel.fullscreen()}>
        <div class="scr-resizer" role="separator" aria-orientation="vertical" onMouseDown={beginResize} />
      </Show>
      <section class="scr-panel" aria-label="Stock Screener">
        <header class="scr-panel-header">
          <div class="scr-panel-title">Stock Screener</div>
          <div class="scr-panel-buttons">
            <button
              type="button"
              class="scr-light-btn scr-light-btn--ghost is-icon-only"
              title={screenerPanel.fullscreen() ? "Restore panel" : "Fullscreen mode"}
              aria-label={screenerPanel.fullscreen() ? "Restore panel" : "Fullscreen mode"}
              onClick={() => screenerPanel.setFullscreen(!screenerPanel.fullscreen())}
            >
              <Icon name={screenerPanel.fullscreen() ? "scr-panel-restore" : "scr-panel-fullscreen"} size={28} />
            </button>
            <button
              type="button"
              class="scr-light-btn scr-light-btn--ghost is-icon-only"
              title="Close"
              aria-label="Close"
              onClick={() => screenerPanel.setOpen(false)}
            >
              <Icon name="scr-panel-close" size={28} />
            </button>
          </div>
        </header>
        <div class="scr-body">
          <div class="scr-head">
            <ScreenerTopbar />
            <FilterPills has={has} />
            <div class="scr-control-panel">
              <button
                ref={setsBtn}
                type="button"
                class="scr-light-btn scr-light-btn--ghost scr-sets-btn"
                classList={{ "is-open": setsOpen() }}
                title="Column sets"
                onClick={() => setSetsOpen(!setsOpen())}
              >
                <Icon name="scr-column-sets" size={28} />
                <span class="scr-light-btn-text">{setTitle()}</span>
                <span class="scr-sets-caret" classList={{ "is-open": setsOpen() }}><Icon name="scr-caret-small" size={18} /></span>
              </button>
              <div class="scr-header-controls">
                <div class="scr-refresh-wrap">
                  <Show when={countdown()} keyed>
                    {(s) => <span class="scr-counter" role="img" aria-label="Time to refresh">{s}</span>}
                  </Show>
                  <button
                    type="button"
                    class="scr-light-btn scr-light-btn--secondary is-icon-only"
                    classList={{ "is-rotating": manualRefresh() && ctl.loading() }}
                    title="Refresh"
                    aria-label="Refresh"
                    onClick={() => {
                      setManualRefresh(true);
                      ctl.refresh();
                    }}
                  >
                    <Icon name="scr-refresh" size={28} />
                  </button>
                </div>
                <button
                  type="button"
                  class="scr-light-btn scr-light-btn--secondary is-icon-only"
                  title={screenerPanel.fullscreen() ? "Restore panel" : "Maximize"}
                  aria-label={screenerPanel.fullscreen() ? "Restore panel" : "Maximize"}
                  onClick={() => screenerPanel.setFullscreen(!screenerPanel.fullscreen())}
                >
                  <Icon name={screenerPanel.fullscreen() ? "scr-panel-restore" : "scr-maximize"} size={28} />
                </button>
              </div>
            </div>
          </div>
          <Show when={fields()}>
            <ScreenerTable
              ctl={ctl}
              columns={plan()?.columns ?? []}
              fields={plan()?.fields ?? []}
              sort={screen().sort}
              onSort={(col, order) => screenerStore.update((s) => ({ ...s, sort: { sortBy: col, sortOrder: order } }))}
              onRowClick={(t) => {
                setSelected(t);
                props.onSymbolPicked(t);
              }}
              selected={selected()}
              flagOf={(t) => flags().get(t) ?? null}
              has={has}
              onAddColumn={(col) => setColumns((c) => [...c, col])}
              onRemoveColumn={(i) => {
                const col = plan()?.columns[i];
                if (col) setColumns((c) => c.filter((x) => !sameColumn(x, col)));
              }}
              onMoveColumn={(i, to) =>
                setColumns((c) => {
                  const col = plan()?.columns[i];
                  const from = col ? c.findIndex((x) => sameColumn(x, col)) : -1;
                  if (from < 0) return c;
                  const [x] = c.splice(from, 1);
                  const dest = to === "start" ? 0 : to === "end" ? c.length : to === "prev" ? Math.max(0, from - 1) : Math.min(c.length, from + 1);
                  c.splice(dest, 0, x);
                  return c;
                })
              }
              onReplaceColumn={(i, col) => {
                const old = plan()?.columns[i];
                if (!old) return;
                screenerStore.update((s) => ({
                  ...s,
                  customColumns: activeColumns(s).map((x) => (sameColumn(x, old) ? col : x)),
                  activeColumnSetId: CUSTOM_SET_ID,
                  sort: sameColumn(s.sort.sortBy, old) ? { ...s.sort, sortBy: col } : s.sort,
                }));
              }}
              resetKey={resetKey()}
            />
          </Show>
        </div>
      </section>

      <Show when={setsOpen()}>
        <Popover anchor={setsBtn} onClose={() => setSetsOpen(false)} class="scr-sets-menu">
          <PopSectionTitle title="Column sets" />
          <Show when={screen().customColumns}>
            <PopItem
              title={CUSTOM_SET_TITLE}
              selected={screen().activeColumnSetId === CUSTOM_SET_ID}
              onClick={() => {
                screenerStore.update((s) => ({ ...s, activeColumnSetId: CUSTOM_SET_ID }));
                setSetsOpen(false);
              }}
            />
          </Show>
          <For each={offeredSets()}>
            {(set) => (
              <PopItem
                title={set.title}
                selected={screen().activeColumnSetId === set.id}
                onClick={() => {
                  screenerStore.update((s) => ({ ...s, activeColumnSetId: set.id }));
                  setSetsOpen(false);
                }}
              />
            )}
          </For>
        </Popover>
      </Show>
    </div>
  );
}
