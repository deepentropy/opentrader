/*
 * BottomBar — chart-controls strip below the chart area.
 *
 * Date-range tabs (preset interval + span), Go-to dialog, live timezone
 * clock, RTH/ETH session menu, ADJ (split-adjustment) toggle, and the
 * maximize-chart toggle.
 *
 * "Maximize chart" (data-name=layoutFullscreen, hotkey Alt+Enter) enlarges the
 * FOCUSED pane over the others inside the active layout — it is NOT browser
 * fullscreen. The owning App holds the maximize state and applies it in
 * ChartGrid; this bar only renders the toggle.
 */
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { Tooltip } from "../../components/Tooltip";
import { TimezoneMenu } from "./TimezoneMenu";
import { SessionMenu, type SessionId } from "./SessionMenu";
import { GoToDateDialog } from "./GoToDateDialog";
import { lastGotoDate, queryGotoContext, rememberGotoDate } from "../chart/goto-query";
import type { TimezoneEntry } from "../../data/timezones";
import { isAdjusted, isIntradayInterval } from "../../data/datafeed";
import { setItem } from "../../data/kv";

type DateRangeId = "1D" | "5D" | "1M" | "3M" | "6M" | "YTD" | "1Y" | "5Y" | "All";

const DATE_RANGES: {
  id: DateRangeId;
  label: string;
  tooltip: string;
  /** Interval id this tab sets. */
  interval: string;
}[] = [
  { id: "1D",  label: "1D",  tooltip: "1 day in 1 minute intervals",     interval: "1"   },
  { id: "5D",  label: "5D",  tooltip: "5 days in 5 minutes intervals",   interval: "5"   },
  { id: "1M",  label: "1M",  tooltip: "1 month in 30 minutes intervals", interval: "30"  },
  { id: "3M",  label: "3M",  tooltip: "3 months in 1 hour intervals",    interval: "60"  },
  { id: "6M",  label: "6M",  tooltip: "6 months in 2 hours intervals",   interval: "120" },
  { id: "YTD", label: "YTD", tooltip: "Year to day in 1 day intervals",  interval: "1D"  },
  { id: "1Y",  label: "1Y",  tooltip: "1 year in 1 day intervals",       interval: "1D"  },
  { id: "5Y",  label: "5Y",  tooltip: "5 years in 1 week intervals",     interval: "1W"  },
  { id: "All", label: "All", tooltip: "All data in 1 month intervals",   interval: "1M"  },
];

const GoToIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28">
    <path
      fill="currentColor"
      fill-rule="evenodd"
      d="M11 4h-1v2H7.5A2.5 2.5 0 0 0 5 8.5V13h1v-2h16v8.5c0 .83-.67 1.5-1.5 1.5H14v1h6.5a2.5 2.5 0 0 0 2.5-2.5v-11A2.5 2.5 0 0 0 20.5 6H18V4h-1v2h-6V4Zm6 4V7h-6v1h-1V7H7.5C6.67 7 6 7.67 6 8.5V10h16V8.5c0-.83-.67-1.5-1.5-1.5H18v1h-1Zm-5.15 10.15-3.5-3.5-.7.7L10.29 18H4v1h6.3l-2.65 2.65.7.7 3.5-3.5.36-.35-.36-.35Z"
    />
  </svg>
);

// Expand glyph: corner brackets opening outward (shown while not maximized).
const MaximizeIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18">
    <path fill="currentColor" d="M11 2v5h5v1h-6V2h1ZM7 16v-5H2v-1h6v6H7Z" />
  </svg>
);

// Collapse glyph: corner brackets pointing inward (shown while maximized).
const RestoreIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18">
    <path fill="currentColor" d="M10 2h6v6h-1V3h-5V2ZM8 16h-6v-6h1v5h5v1Z" />
  </svg>
);

function formatClock(now: Date, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    ...(timeZone ? { timeZone } : {}),
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "shortOffset",
  }).formatToParts(now);
  const get = (t: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === t)?.value ?? "";
  let hh = get("hour");
  if (hh === "24") hh = "00";
  const mm = get("minute");
  const ss = get("second");
  let offset = get("timeZoneName"); // "GMT-4", "GMT", …
  offset = offset.replace(/^GMT/, "UTC");
  return `${hh}:${mm}:${ss} ${offset}`;
}

type Props = {
  interval: string;
  setInterval: (id: string) => void;
  /** Focused pane's session (RTH/ETH) + its setter. Only meaningful on intraday
   *  frames; the button is hidden on daily+. */
  session: SessionId;
  onSessionChange: (id: SessionId) => void;
  /** Display timezone label (TimezoneMenu) + IANA id (clock + chart axis). */
  timezoneLabel?: string;
  timezoneIana?: string;
  onTimezoneChange?: (entry: TimezoneEntry) => void;
  /** True while the focused pane is maximized over the rest of the layout. */
  maximized?: boolean;
  /** Toggle maximize on the focused pane (also bound to Alt+Enter). */
  onToggleMaximize?: () => void;
};

export function BottomBar(props: Props) {
  // Date-range tabs are click-triggers, not state holders. They set the
  // chart's interval and stay highlighted only while that interval still
  // matches their preset (mirrors the mock).
  const [pickedRange, setPickedRange] = createSignal<DateRangeId | null>(null);
  const [clock, setClock] = createSignal(formatClock(new Date(), props.timezoneIana));
  // Popover anchors (drop-up menus open above their trigger).
  const [tzAnchor, setTzAnchor] = createSignal<DOMRect | null>(null);
  const [sessionAnchor, setSessionAnchor] = createSignal<DOMRect | null>(null);
  // Session applies only to intraday frames; daily/weekly/monthly hide it.
  const sessionEnabled = () => isIntradayInterval(props.interval);
  // ADJ toggle (split/dividend adjustment). The flag lives in kv where the
  // datafeed reads it per fetch; toggling asks every pane to refetch — no
  // App-level wiring needed.
  const [adjusted, setAdjusted] = createSignal(isAdjusted());
  const toggleAdjusted = () => {
    const next = !adjusted();
    setAdjusted(next);
    setItem("ot:adjusted", String(next));
    window.dispatchEvent(new CustomEvent("chart-reload-data"));
  };
  // The Settings dialog's "Adjust data for dividends" writes the same flag —
  // follow it so the button state stays in sync (same-window kv writes don't
  // notify).
  const onAdjustedChanged = () => setAdjusted(isAdjusted());
  window.addEventListener("adjusted-changed", onAdjustedChanged);
  onCleanup(() => window.removeEventListener("adjusted-changed", onAdjustedChanged));
  const [goToAnchor, setGoToAnchor] = createSignal<DOMRect | null>(null);
  let goToButton!: HTMLButtonElement;
  const openGoTo = () => setGoToAnchor(goToButton.getBoundingClientRect());
  const closeGoTo = () => setGoToAnchor(null);

  // Narrow-bar mode: when the expanded range tabs would collide with the
  // right cluster, they collapse into a single "Date Range" drop-up button
  // (`date-ranges-menu`, 107×38). Both variants stay rendered — the
  // expanded strip is visibility-hidden while collapsed so it stays measurable.
  const [rangesCollapsed, setRangesCollapsed] = createSignal(false);
  const [rangesAnchor, setRangesAnchor] = createSignal<DOMRect | null>(null);
  let barEl: HTMLDivElement | undefined;
  let expandedEl: HTMLDivElement | undefined;
  let rightEl: HTMLDivElement | undefined;
  let rangesBtn: HTMLButtonElement | undefined;
  // Re-expanding unmounts the trigger — never leave the drop-up orphaned.
  createEffect(() => {
    if (!rangesCollapsed()) setRangesAnchor(null);
  });

  onMount(() => {
    const tick = () => setClock(formatClock(new Date(), props.timezoneIana));
    tick();
    const id = window.setInterval(tick, 1000);
    const measure = () => {
      if (!barEl || !expandedEl || !rightEl) return;
      // tabs strip + right cluster + the fixed separator/Go-to/margins (~84px)
      const need = expandedEl.scrollWidth + rightEl.offsetWidth + 84;
      setRangesCollapsed(barEl.offsetWidth < need);
    };
    const ro = new ResizeObserver(measure);
    if (barEl) ro.observe(barEl);
    measure();
    onCleanup(() => ro.disconnect());
    // Alt+G toggles the Go-to dialog; Alt+Enter toggles maximize,
    // unless focus is in a field.
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.code === "KeyG") {
        e.preventDefault();
        if (goToAnchor()) closeGoTo(); else openGoTo();
      } else if (e.code === "Enter" || e.code === "NumpadEnter") {
        // The focused watchlist owns Alt+↵ (flag the selected row); defer to it
        // so the same keystroke doesn't also maximize the pane. Its Solid-
        // delegated handler can't cancel this sibling document listener, so the
        // check has to live here.
        if (t?.closest?.(".watchlist-rows")) return;
        e.preventDefault();
        props.onToggleMaximize?.();
      }
    };
    document.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.clearInterval(id);
      document.removeEventListener("keydown", onKey);
    });
  });
  // Re-render the clock immediately when the timezone changes.
  createEffect(() => setClock(formatClock(new Date(), props.timezoneIana)));

  return (
    <div class="chart-controls-bar bottom-bar" data-is-chart-toolbar-component="true">
      <div class="bottom-bar-toolbar" role="toolbar" ref={barEl}>
        {/* Left group: date range + go-to */}
        <div class="bottom-bar-date-range-wrapper">
          <Show when={rangesCollapsed()}>
            <button
              ref={rangesBtn}
              type="button"
              tabIndex={-1}
              class={"bottom-bar-item bottom-bar-text-button" + (rangesAnchor() ? " is-opened" : "")}
              data-name="date-ranges-menu"
              aria-haspopup="menu"
              aria-expanded={!!rangesAnchor()}
              onClick={(e) => setRangesAnchor((cur) => (cur ? null : e.currentTarget.getBoundingClientRect()))}
            >
              Date Range
            </button>
          </Show>
          <div
            class="bottom-bar-date-range-expanded"
            classList={{ "is-measure-only": rangesCollapsed() }}
            ref={expandedEl}
          >
            <div class="bottom-bar-date-range-tabs" data-name="date-ranges-tabs">
              <For each={DATE_RANGES}>
                {(r) => {
                  const isActive = () =>
                    pickedRange() === r.id && r.interval === props.interval;
                  return (
                    <Tooltip text={r.tooltip} side="top">
                      <button
                        type="button"
                        tabIndex={-1}
                        class={"bottom-bar-tab" + (isActive() ? " is-active" : "")}
                        data-name={`date-range-tab-${r.id}`}
                        aria-label={r.tooltip}
                        aria-pressed={isActive()}
                        onClick={() => {
                          setPickedRange(r.id);
                          props.setInterval(r.interval);
                          // A range tab sets the visible span AND the
                          // interval. The focused ChartView frames the span
                          // once the new interval's bars land.
                          window.dispatchEvent(
                            new CustomEvent("chart-set-range", { detail: { span: r.id } }),
                          );
                        }}
                      >
                        <div class="bottom-bar-tab-text">{r.label}</div>
                      </button>
                    </Tooltip>
                  );
                }}
              </For>
            </div>
          </div>
          {/* Separator + Go-to live OUTSIDE the collapsible strip so they stay
              visible in the "Date Range" drop-up mode. */}
          <span class="bottom-bar-separator" />
          <Tooltip text="Go to" hotkey="Alt + G" side="top">
            <button
              ref={goToButton}
              type="button"
              tabIndex={-1}
              // No state while the dialog is open.
              class="bottom-bar-item bottom-bar-icon-button bottom-bar-icon-button--small"
              data-name="go-to-date"
              aria-label="Go to"
              aria-haspopup="dialog"
              aria-expanded={!!goToAnchor()}
              onClick={() => (goToAnchor() ? closeGoTo() : openGoTo())}
            >
              <span class="bottom-bar-icon" role="img" aria-hidden="true">
                <GoToIcon />
              </span>
            </button>
          </Tooltip>
        </div>

        {/* Right group, in order:
            [HH:MM:SS UTC-4] [RTH] [|] [ADJ] [maximize]. */}
        <div class="bottom-bar-series-control-wrapper" ref={rightEl}>
          <div class="bottom-bar-inline">
            <Tooltip text="Timezone" side="top">
              <button
                type="button"
                tabIndex={-1}
                class={"bottom-bar-item bottom-bar-text-button" + (tzAnchor() ? " is-opened" : "")}
                data-name="time-zone-menu"
                aria-label="Timezone"
                aria-haspopup="menu"
                aria-expanded={!!tzAnchor()}
                onClick={(e) => setTzAnchor(tzAnchor() ? null : e.currentTarget.getBoundingClientRect())}
              >
                <div class="bottom-bar-tab-text">{clock()}</div>
              </button>
            </Tooltip>
          </div>
          <Show when={sessionEnabled()}>
            <div class="bottom-bar-inline">
              <Tooltip text="Session" side="top">
                <button
                  type="button"
                  tabIndex={-1}
                  class={"bottom-bar-item bottom-bar-text-button" + (sessionAnchor() ? " is-opened" : "")}
                  data-name="session-menu"
                  aria-label="Session"
                  aria-haspopup="menu"
                  aria-expanded={!!sessionAnchor()}
                  onClick={(e) =>
                    setSessionAnchor(sessionAnchor() ? null : e.currentTarget.getBoundingClientRect())
                  }
                >
                  <div class="bottom-bar-tab-text">{props.session}</div>
                </button>
              </Tooltip>
            </div>
          </Show>
          <div class="bottom-bar-inline">
            <span class="bottom-bar-separator" />
          </div>
          <div class="bottom-bar-inline">
            <Tooltip text="Adjust data for splits" side="top">
              <button
                type="button"
                tabIndex={-1}
                class={"bottom-bar-item bottom-bar-text-button" + (adjusted() ? " is-active" : "")}
                data-name="adjustments-menu"
                aria-label="Adjust data for splits"
                aria-pressed={adjusted()}
                onClick={toggleAdjusted}
              >
                <div class="bottom-bar-tab-text">ADJ</div>
              </button>
            </Tooltip>
          </div>
          <div class="bottom-bar-inline">
            <Tooltip
              text={props.maximized ? "Restore chart" : "Maximize chart"}
              hotkey="Alt + Enter"
              side="top"
            >
              <button
                type="button"
                tabIndex={-1}
                class={
                  "bottom-bar-item bottom-bar-icon-button bottom-bar-fullscreen" +
                  (props.maximized ? " is-active" : "")
                }
                data-name="layoutFullscreen"
                aria-label={props.maximized ? "Restore chart" : "Maximize chart"}
                aria-pressed={!!props.maximized}
                onClick={() => props.onToggleMaximize?.()}
              >
                <span class="bottom-bar-icon" role="img" aria-hidden="true">
                  {props.maximized ? <RestoreIcon /> : <MaximizeIcon />}
                </span>
              </button>
            </Tooltip>
          </div>
        </div>
      </div>

      <Show when={rangesAnchor()}>
        {(rect) => (
          <RangesMenu
            anchor={rect()}
            activeId={pickedRange()}
            interval={props.interval}
            trigger={() => rangesBtn}
            onSelect={(r) => {
              setPickedRange(r.id);
              props.setInterval(r.interval);
              window.dispatchEvent(
                new CustomEvent("chart-set-range", { detail: { span: r.id } }),
              );
            }}
            onClose={() => setRangesAnchor(null)}
          />
        )}
      </Show>
      <Show when={tzAnchor()}>
        {(rect) => (
          <TimezoneMenu
            anchor={rect()}
            activeLabel={props.timezoneLabel ?? "Exchange"}
            onSelect={(e) => props.onTimezoneChange?.(e)}
            onClose={() => setTzAnchor(null)}
          />
        )}
      </Show>
      <Show when={sessionAnchor()}>
        {(rect) => (
          <SessionMenu
            anchor={rect()}
            active={props.session}
            onSelect={props.onSessionChange}
            onClose={() => setSessionAnchor(null)}
          />
        )}
      </Show>
      <Show when={goToAnchor()}>
        {(rect) => {
          // Read once per opening: the active chart's DWM state and visible
          // bars, and the session's last submitted date.
          const ctx = queryGotoContext();
          return (
            <GoToDateDialog
              anchor={rect()}
              initial={lastGotoDate()}
              dateOnly={ctx.dateOnly}
              initialRange={ctx.visible}
              onSubmit={(date, minutes) => {
                rememberGotoDate({ ...date, minutes });
                // Wall-clock date: each chart reads it in its own time zone.
                window.dispatchEvent(new CustomEvent("chart-goto-date", { detail: { date, minutes } }));
              }}
              onSubmitRange={(from, to) =>
                window.dispatchEvent(new CustomEvent("chart-goto-range", { detail: { from, to } }))
              }
              onClose={closeGoTo}
            />
          );
        }}
      </Show>
    </div>
  );
}

/** Drop-up listing the range presets when the tab strip is collapsed
 *  (`date-ranges-menu` narrow-bar mode). Mirrors SessionMenu's mechanics;
 *  row text uses each preset's descriptive tooltip (the compact label set
 *  is for expanded mode only). */
function RangesMenu(props: {
  anchor: DOMRect;
  activeId: DateRangeId | null;
  interval: string;
  /** The opening button — pointerdowns inside it are ignored so its onClick
   *  toggle can CLOSE the menu instead of close-then-reopen. */
  trigger?: () => HTMLElement | undefined;
  onSelect: (r: (typeof DATE_RANGES)[number]) => void;
  onClose: () => void;
}) {
  let root!: HTMLDivElement;
  const [pos, setPos] = createSignal({ left: props.anchor.left, top: props.anchor.top });
  onMount(() => {
    const r = root.getBoundingClientRect();
    setPos({
      left: Math.min(props.anchor.left, window.innerWidth - r.width - 8),
      top: Math.max(8, props.anchor.top - r.height - 4),
    });
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (root.contains(t) || props.trigger?.()?.contains(t)) return;
      props.onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") props.onClose(); };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    });
  });
  return (
    <Portal>
    <div
      ref={root}
      class="ot-popover session-menu context-menu"
      role="menu"
      aria-label="Date range"
      style={{ position: "fixed", left: `${pos().left}px`, top: `${pos().top}px`, "z-index": 200 }}
    >
      <div class="session-menu-title">Date Range</div>
      <For each={DATE_RANGES}>
        {(r) => {
          const active = () => props.activeId === r.id && r.interval === props.interval;
          return (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={active()}
              class={"session-menu-item" + (active() ? " is-active" : "")}
              onClick={() => { props.onSelect(r); props.onClose(); }}
            >
              {r.tooltip}
            </button>
          );
        }}
      </For>
    </div>
    </Portal>
  );
}
