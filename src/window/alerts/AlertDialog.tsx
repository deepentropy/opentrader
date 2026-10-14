/*
 * AlertDialog — create or edit a single alert rule.
 *
 * A real, condition-based alert (the per-symbol counterpart to the watchlist's
 * list-level AddAlertDialog). A (left · operator · right) condition over
 * price / drawing / indicator operands, plus trigger, expiration, message and
 * notifications. Saving writes to alert-store; the engine evaluates it live.
 *
 * Layout: 480 px, header "Create alert on <symbol>" (the symbol is a button
 * that turns into a field), the Condition block (label column 131 px, 34 px
 * controls stacked 8 px apart), a divider, then Trigger / Expiration /
 * Message / Notifications as one text row each. Trigger and Expiration open
 * a menu; Message and Notifications open their own view (back arrow, Cancel
 * / Apply). Footer: Cancel and Create.
 *
 * Opened from the header "Create alert" button and the chart context menu
 * (prefilled with the clicked symbol + price), or with an `editId` to edit.
 */
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js";
import { Portal } from "solid-js/web";
import {
  alertStore,
  type AlertFrequency,
  type AlertOperator,
  type Operand,
  type StudyConditionRef,
} from "../../data/alert-store";
import {
  LEVEL_OPERATORS,
  OPERATOR_LABELS,
  bandOperatorLabel,
  isBandOperator,
  shapeOperators,
  defaultAlertMessage,
  isPercentOperator,
  priceableDrawings,
  VWAP_PLOTS,
  alertIntervalText,
  conditionHasIntervalRow,
  alertAmountText,
  drawingSelectLabel,
  isMovingOperator,
  VALUE_OPERATORS,
} from "../../data/alert-condition";
import { chartLastPrice, indicatorPlotValue } from "../../data/chart-state-registry";
import { quoteFor } from "../../data/quotes";
import { cachedSymbolSessions } from "../../data/session";
import { buildIntervalMenu, sectionOf, SECTION_TITLES, type IntervalSection } from "../chart/custom-intervals";
import { compareIntervals, favoriteIntervals, longIntervalLabel } from "../chart/interval-favorites";
import { indicatorLegendFor } from "../../data/chart-state-registry";
import { hasAlertFunction, studyConditions } from "../../data/alert-study-conditions";
import { appendPlaceholder, placeholderGroups, type PlaceholderGroup } from "../../data/alert-placeholders";
import * as kv from "../../data/kv";
import { getIndicatorEntry } from "../chart/indicators/registry";
import { statusLineInputs } from "../chart/indicators/indicator-options";
import type { SessionId } from "../../data/session/symbol-sessions";
import { isFullSymbol, isSupportedResolution, toFullSymbol } from "../../data/datafeed";
import { SOUND_DURATIONS, SOUND_GROUP, SOUND_OPTIONS, isAlertSoundPlaying, playAlertSound, stopAlertSound } from "../../data/alert-sounds";
import { alertSettings } from "../../data/alert-settings";
import {
  alertWebhook,
  ensureNotificationPermission,
  resetRuleEvalState,
  setAlertWebhook,
} from "../../data/alert-engine";

type Props = {
  /** When set, edit this existing rule instead of creating one. */
  editId?: string;
  /** Prefill symbol (full name "EXCHANGE:TICKER") for new rules. */
  symbol?: string;
  /** Prefill the right-hand value (e.g. the clicked chart price). */
  price?: number;
  /** New alert on a study (chart menu in a study pane): the left operand. */
  indicatorId?: string;
  /** New alert on a drawing (its "Add alert" button): the right operand. */
  drawingId?: string;
  /** Chart interval to stamp onto the rule as its resolution. */
  interval: string;
  /** Session of the chart (regular or extended hours), kept on a new alert. */
  session?: SessionId;
  onClose: () => void;
};


/** Trigger choices. A condition on price offers "Once only" and "Every
 *  time"; one that reads a study has the per-bar ones, and "Every time" is
 *  then called "Once per minute" and comes last. */
const FREQUENCIES: { key: AlertFrequency; label: string; desc: string }[] = [
  { key: "only_once", label: "Once only", desc: "Triggers once when condition is met" },
  { key: "every_time", label: "Every time", desc: "Triggers once per minute while condition remains met" },
];
const STUDY_FREQUENCIES: { key: AlertFrequency; label: string; desc: string }[] = [
  { key: "only_once", label: "Once only", desc: "Triggers once when condition is met" },
  { key: "once_per_bar", label: "Once per bar", desc: "Triggers once per bar when condition is met" },
  { key: "once_per_bar_close", label: "Once per bar close", desc: "Triggers every time condition is met at bar close" },
  { key: "every_time", label: "Once per minute", desc: "Triggers once per minute while condition remains met" },
];

type ExpiryKey = "open" | "eod" | "1w" | "1m" | "custom";

/** "Oct 7, 23:59" */
function shortDateTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.toLocaleString("en-US", { month: "short" })} ${d.getDate()}, ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Expiry time of a choice, from now (null = open-ended). */
function expiryTime(key: ExpiryKey, customMs: number | null): number | null {
  const d = new Date();
  if (key === "eod") { d.setHours(23, 59, 0, 0); return d.getTime(); }
  if (key === "1w") return d.getTime() + 7 * 86_400_000;
  if (key === "1m") { d.setMonth(d.getMonth() + 1); return d.getTime(); }
  if (key === "custom") return customMs;
  return null;
}

/** datetime-local value of a time. */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

type MenuOption = { value: string; label: string; desc?: string; right?: string; disabled?: boolean; icon?: string; /** A play button at the end of the row (sound preview). */ play?: () => void; /** A line above the row (a new group). */ sep?: boolean };

/** Condition icons: stroked 18 x 18 paths. A level is a horizontal line, a
 *  channel two of them; the arrow or the dot is the price. */
const OPERATOR_ICONS: Record<AlertOperator, string> = {
  crossing: "M3 13.5 15 4.5M11.5 4.5H15V8M3 4.5l12 9",
  crossing_up: "M2.5 11.5h13M5 15.5l8-11M9.5 4.5H13V8",
  crossing_down: "M2.5 6.5h13M5 2.5l8 11M9.5 13.5H13V10",
  greater: "M2.5 13.5h13M9 10.5v-7M6 6.5l3-3 3 3",
  less: "M2.5 4.5h13M9 7.5v7M6 11.5l3 3 3-3",
  moving_up: "M2.5 13.5l4.5-4.5 3 3 5-6.5M11.5 5.5H15V9",
  moving_down: "M2.5 4.5 7 9l3-3 5 6.5M11.5 12.5H15V9",
  moving_up_pct: "M2.5 13.5l4.5-4.5 3 3 5-6.5M11.5 5.5H15V9",
  moving_down_pct: "M2.5 4.5 7 9l3-3 5 6.5M11.5 12.5H15V9",
  entering: "M2.5 5h13M2.5 12.5h13M9 16.5V8.5M6.5 11 9 8.5l2.5 2.5",
  exiting: "M2.5 5h13M2.5 12.5h13M9 8.5v8M6.5 14 9 16.5l2.5-2.5",
  inside: "M2.5 4.5h13M2.5 13.5h13M9 7.6a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8Z",
  outside: "M2.5 7h13M2.5 15.5h13M9 2.1a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8Z",
  hits_level: "M2.5 4h4M11.5 4h4M2.5 9h13M2.5 14h4M11.5 14h4M9 2.5v13",
  // A study's own conditions are listed by title, without an icon.
  alert_condition: "",
  // A script's alert() calls: a function sign ("f" with an "x").
  alert_function: "M10.5 3.2c-.4-.5-1-.7-1.6-.6-.8.1-1.4.8-1.4 1.6v9.6c0 .8-.6 1.5-1.4 1.6-.6.1-1.2-.1-1.6-.6M4.5 7.5h5M11 10.5l4 4M15 10.5l-4 4",
};

/** Dropdown of the dialog. `box`: a 34 px bordered control showing the value;
 *  `inline`: the value as text with a chevron (Trigger, Expiration). `more`:
 *  the options after this count sit behind a "Show more" row. */
function AdMenu(props: { variant: "box" | "inline"; value: string; options: MenuOption[]; onPick: (v: string) => void; more?: number; label?: string; placeholder?: string; group?: string; /** One option only: shown read-only (no menu). */ lockSingle?: boolean }) {
  const [open, setOpen] = createSignal(false);
  const [all, setAll] = createSignal(false);
  let el: HTMLDivElement | undefined;
  onMount(() => {
    const onDown = (e: PointerEvent) => { if (el && !el.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", onDown, true);
    onCleanup(() => document.removeEventListener("pointerdown", onDown, true));
  });
  const current = () => props.options.find((o) => o.value === props.value);
  const locked = () => !!props.lockSingle && props.options.length <= 1;
  const cut = () => (props.more !== undefined && !all() && props.options.findIndex((o) => o.value === props.value) < props.more ? props.more : props.options.length);
  const menuIcon = (d: string) => (
    <svg class="ad-option-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
      <path fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" d={d} />
    </svg>
  );
  const row = (o: MenuOption) => (
    <>
    <Show when={o.sep}><div class="ad-option-sep" role="separator" /></Show>
    <button
      type="button"
      role="option"
      aria-selected={o.value === props.value}
      disabled={o.disabled}
      class="ad-option"
      classList={{ "is-selected": o.value === props.value, "has-desc": !!o.desc }}
      onClick={() => { props.onPick(o.value); setOpen(false); }}
    >
      <Show when={o.icon}>{menuIcon(o.icon!)}</Show>
      <span class="ad-option-main">
        <span class="ad-option-label">{o.label}</span>
        <Show when={o.desc}><span class="ad-option-desc">{o.desc}</span></Show>
      </span>
      <Show when={o.right}><span class="ad-option-right">{o.right}</span></Show>
      <Show when={o.play}>
        <span class="ad-option-play" role="button" title="Play" onClick={(e) => { e.stopPropagation(); o.play!(); }}>
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
            <circle cx="9" cy="9" r="6.9" fill="none" stroke="currentColor" stroke-width="1.2" />
            <path fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" d="M7.4 6.2v5.6L12 9 7.4 6.2Z" />
          </svg>
        </span>
      </Show>
    </button>
    </>
  );
  return (
    <div class={`ad-menu ad-menu--${props.variant}`} ref={el}>
      <button
        type="button"
        class="ad-menu-btn"
        aria-label={props.label}
        aria-expanded={open()}
        aria-disabled={locked() || undefined}
        onClick={() => { if (locked()) return; setAll(false); setOpen(!open()); }}
      >
        <Show when={current()?.icon}>{menuIcon(current()!.icon!)}</Show>
        <span class="ad-menu-value">{current()?.label ?? props.placeholder ?? ""}</span>
        <svg class="ad-chevron" classList={{ "is-open": open() }} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
          <path fill="none" stroke="currentColor" stroke-width="1.2" d="m4.5 7 4.5 4 4.5-4" />
        </svg>
      </button>
      <Show when={open()}>
        <div class="ad-menu-list" role="listbox">
          <Show when={props.group}><div class="ad-option-group">{props.group}</div></Show>
          <For each={props.options.slice(0, cut())}>{row}</For>
          <Show when={cut() < props.options.length}>
            <button type="button" class="ad-option ad-option-more" onClick={() => setAll(true)}>
              <span class="ad-option-label">Show more</span>
              <svg class="ad-chevron" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
                <path fill="none" stroke="currentColor" stroke-width="1.2" d="m4.5 7 4.5 4 4.5-4" />
              </svg>
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}

/** Interval sections of the Interval row (no ticks or ranges). */
const INTERVAL_SECTIONS: IntervalSection[] = ["seconds", "minutes", "hours", "days"];
const isAlertInterval = (id: string) => INTERVAL_SECTIONS.includes(sectionOf(id) as IntervalSection);
type IntervalGroup = { id: string; title: string; items: string[] };

/** Groups of the Interval menu: the interval menu's rows (built-in and
 *  custom) by section, with `extra` (the chart's interval, the alert's own)
 *  added where missing. */
function intervalGroups(extra: string[]): IntervalGroup[] {
  const ids = new Set<string>();
  for (const s of buildIntervalMenu().sections) for (const r of s.items) if (!r.iconName && isAlertInterval(r.id)) ids.add(r.id);
  for (const id of extra) if (isAlertInterval(id)) ids.add(id);
  const all = [...ids].sort(compareIntervals);
  return INTERVAL_SECTIONS.map((k) => ({ id: k, title: SECTION_TITLES[k], items: all.filter((id) => sectionOf(id) === k) })).filter((g) => g.items.length > 0);
}

/** Interval row of a condition: the button shows "Same as chart" with the
 *  chart's interval, or the chosen one ("1h"). Its menu: "Same as chart",
 *  then Favorites and the interval sections, folded except the one the
 *  choice was made in (or the one holding it); a row is selected in the
 *  group it was picked from only. */
function AdIntervalMenu(props: { value: string; origin: string; chart?: string; favorites: string[]; groups: IntervalGroup[]; onPick: (id: string, origin: string) => void }) {
  const [open, setOpen] = createSignal(false);
  const [unfolded, setUnfolded] = createSignal<Record<string, boolean>>({});
  const [maxHeight, setMaxHeight] = createSignal(420);
  let el: HTMLDivElement | undefined;
  let btn: HTMLButtonElement | undefined;
  let list: HTMLDivElement | undefined;
  // The width of the list's scroll bar, once the rows are laid out (folding a section changes it).
  createEffect(() => {
    if (!open()) return;
    unfolded();
    queueMicrotask(() => list?.style.setProperty("--ad-iv-scrollbar", `${list.offsetWidth - list.clientWidth}px`));
  });
  onMount(() => {
    const onDown = (e: PointerEvent) => { if (el && !el.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", onDown, true);
    onCleanup(() => document.removeEventListener("pointerdown", onDown, true));
  });
  const groups = (): IntervalGroup[] => [...(props.favorites.length ? [{ id: "favorites", title: "Favorites", items: props.favorites }] : []), ...props.groups];
  const toggle = () => {
    if (open()) { setOpen(false); return; }
    const init: Record<string, boolean> = {};
    for (const g of groups()) init[g.id] = g.id === "favorites" ? props.origin === "favorites" : props.origin !== "favorites" && g.items.includes(props.value);
    setUnfolded(init);
    // The list goes down to the bottom of the window at most.
    if (btn) setMaxHeight(Math.max(160, window.innerHeight - btn.getBoundingClientRect().bottom - 8));
    setOpen(true);
  };
  const pick = (id: string, origin: string) => { props.onPick(id, origin); setOpen(false); };
  const same = () => props.origin === "same-as-chart";
  return (
    <div class="ad-menu ad-menu--box ad-iv" ref={el}>
      <button type="button" class="ad-menu-btn" ref={btn} data-name="resolution-dropdown" aria-label="Interval" aria-expanded={open()} onClick={toggle}>
        <span class="ad-menu-value">{same() ? "Same as chart" : alertIntervalText(props.value, true)}</span>
        <Show when={same() && props.chart}><span class="ad-iv-hint">{longIntervalLabel(props.chart!)}</span></Show>
        <svg class="ad-chevron" classList={{ "is-open": open() }} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
          <path fill="none" stroke="currentColor" stroke-width="1.2" d="m4.5 7 4.5 4 4.5-4" />
        </svg>
      </button>
      <Show when={open()}>
        <div class="ad-iv-menu" role="listbox" style={{ "max-height": `${maxHeight()}px` }} ref={list}>
          <div class="ad-iv-rows">
          <Show when={props.chart}>
            <button type="button" role="option" aria-selected={same()} class="ad-option" classList={{ "is-selected": same() }} onClick={() => pick(props.chart!, "same-as-chart")}>
              <span class="ad-option-main"><span class="ad-option-label">Same as chart</span></span>
              <span class="ad-option-right">{longIntervalLabel(props.chart!)}</span>
            </button>
            <div class="ad-ph-divider" role="separator" />
          </Show>
          <For each={groups()}>
            {(g, i) => (
              <>
                <button type="button" class="ad-ph-title" role="group" aria-expanded={!!unfolded()[g.id]} onClick={() => setUnfolded({ ...unfolded(), [g.id]: !unfolded()[g.id] })}>
                  <span class="ad-ph-title-text">{g.title}</span>
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
                    <path fill="currentColor" d={unfolded()[g.id] ? "m4.67 10.62.66.76L9 8.16l3.67 3.22.66-.76L9 6.84l-4.33 3.78Z" : "m4.67 7.38.66-.76L9 9.84l3.67-3.22.66.76L9 11.16 4.67 7.38Z"} />
                  </svg>
                </button>
                <Show when={unfolded()[g.id]}>
                  <For each={g.items}>
                    {(id) => {
                      const selected = () => props.value === id && props.origin === g.id;
                      return (
                        <button type="button" role="option" aria-selected={selected()} class="ad-option" classList={{ "is-selected": selected() }} disabled={!isSupportedResolution(id)} onClick={() => pick(id, g.id)}>
                          <span class="ad-option-main"><span class="ad-option-label">{longIntervalLabel(id)}</span></span>
                        </button>
                      );
                    }}
                  </For>
                </Show>
                <Show when={i() < groups().length - 1}><div class="ad-ph-divider" role="separator" /></Show>
              </>
            )}
          </For>
          </div>
        </div>
      </Show>
    </div>
  );
}

/** Groups of the placeholder menu shown open; General only until the user
 *  opens or closes one (remembered). */
const PLACEHOLDER_GROUPS_KEY = "alerts.placeholder-groups.v1";
function openPlaceholderGroups(): Record<string, boolean> {
  try {
    return { general: true, ...JSON.parse(kv.getItem(PLACEHOLDER_GROUPS_KEY) ?? "{}") };
  } catch {
    return { general: true };
  }
}

/** "Add placeholder" button of the message view and its menu: opens above the
 *  button, one foldable group per kind, a row = title + placeholder; a click
 *  adds the placeholder to the message and closes the menu. */
function AdPlaceholders(props: { groups: PlaceholderGroup[]; onPick: (value: string) => void }) {
  const [open, setOpen] = createSignal(false);
  const [expanded, setExpanded] = createSignal(openPlaceholderGroups());
  let el: HTMLDivElement | undefined;
  onMount(() => {
    const onDown = (e: PointerEvent) => { if (el && !el.contains(e.target as Node)) setOpen(false); };
    // Escape closes the menu only (the dialog stays).
    const onKey = (e: KeyboardEvent) => { if (open() && e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => { document.removeEventListener("pointerdown", onDown, true); window.removeEventListener("keydown", onKey, true); });
  });
  const toggle = (id: string) => {
    const next = { ...expanded(), [id]: !expanded()[id] };
    setExpanded(next);
    try { kv.setItem(PLACEHOLDER_GROUPS_KEY, JSON.stringify(next)); } catch { /* best-effort */ }
  };
  return (
    <div class="ad-ph" ref={el}>
      <button type="button" class="ad-small-btn" data-name="alert-message-placeholder-button" aria-expanded={open()} onClick={() => setOpen(!open())}>
        Add placeholder
      </button>
      <Show when={open()}>
        <div class="ad-ph-menu" role="menu" data-name="alert-placeholders-menu">
          <For each={props.groups.filter((g) => g.items.length)}>
            {(g, i) => (
              <>
                <Show when={i() > 0}><div class="ad-ph-divider" role="separator" /></Show>
                <button type="button" class="ad-ph-title" role="group" aria-expanded={!!expanded()[g.id]} onClick={() => toggle(g.id)}>
                  <span class="ad-ph-title-text">{g.title}</span>
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
                    <path fill="currentColor" d={expanded()[g.id] ? "m4.67 10.62.66.76L9 8.16l3.67 3.22.66-.76L9 6.84l-4.33 3.78Z" : "m4.67 7.38.66-.76L9 9.84l3.67-3.22.66.76L9 11.16 4.67 7.38Z"} />
                  </svg>
                </button>
                <Show when={expanded()[g.id]}>
                  <For each={g.items}>
                    {(it) => (
                      <button type="button" class="ad-ph-item" role="option" onClick={() => { props.onPick(it.value); setOpen(false); }}>
                        <span class="ad-ph-item-title">{it.title}</span>
                        <span class="ad-ph-item-value">{it.value}</span>
                      </button>
                    )}
                  </For>
                </Show>
              </>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

/** A formatted amount as a number field holds it: no thousands separator, a plain minus sign. */
const fieldText = (t: string) => t.replace(/,/g, "").replace(/−/g, "-");

type SideKind = "value" | "drawing" | "indicator" | "price";

/** A deliverable webhook target: parses as a URL with an http(s) scheme. */
function isValidWebhookUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function AlertDialog(props: Props) {
  const existing = props.editId ? alertStore.rule(props.editId) : undefined;

  const [symbol, setSymbol] = createSignal((existing?.symbol ?? props.symbol ?? "").toUpperCase());

  // The set of indicators / priceable drawings available for the symbol comes
  // from the charted symbol; captured once at open (the dialog is short-lived).
  const indicators = () => indicatorLegendFor(symbol());
  // A drawing is a choice only in the dialog opened from it (its alert button) or the alert made on it.
  const drawings = () =>
    priceableDrawings(symbol()).filter((d) => d.id === props.drawingId || (existing?.right.kind === "drawing" && existing.right.drawingId === d.id));

  // Include the rule's *existing* operands as options even when the symbol
  // isn't currently charted (or the study/drawing is gone), so editing never
  // silently drops or mis-displays an indicator/drawing operand.
  const indicatorOptions = createMemo(() => {
    const opts: { id: string; label: string; inputs?: Record<string, unknown> }[] = indicators().map((r) => ({ id: r.id, label: r.title, inputs: r.inputValues }));
    const ids = new Set(opts.map((o) => o.id));
    for (const o of [existing?.left, existing?.right]) {
      if (o && o.kind === "indicator" && !ids.has(o.indicatorId)) {
        opts.push({ id: o.indicatorId, label: o.label ?? "indicator", inputs: o.inputs });
        ids.add(o.indicatorId);
      }
    }
    return opts;
  });
  const drawingOptions = createMemo(() => {
    const opts = drawings();
    const r = existing?.right;
    if (r && r.kind === "drawing" && !opts.some((o) => o.id === r.drawingId)) {
      return [...opts, { id: r.drawingId, label: r.label ?? "drawing", band: r.band ?? null, ...(r.plot != null ? { plots: VWAP_PLOTS } : {}) }];
    }
    return opts;
  });


  // ── Left operand ── price or an indicator plot.
  const [leftKind, setLeftKind] = createSignal<"price" | "indicator">(
    existing?.left.kind === "indicator" || (!existing && props.indicatorId) ? "indicator" : "price",
  );
  const [leftIndicator, setLeftIndicator] = createSignal(
    existing?.left.kind === "indicator" ? existing.left.indicatorId : (!existing && props.indicatorId) || "",
  );
  const [leftPlot, setLeftPlot] = createSignal(existing?.left.kind === "indicator" ? (existing.left.plot ?? 0) : 0);

  /** The conditions a study declares for alerts (script alertcondition(),
   *  TPO extended levels), with its inputs on the chart. An alert being
   *  edited keeps its own condition in the list. */
  const condsOf = (indicatorId: string): StudyConditionRef[] => {
    const list = studyConditions(getIndicatorEntry(indicatorId), indicatorOptions().find((o) => o.id === indicatorId)?.inputs);
    const kept = existing?.left.kind === "indicator" && existing.left.indicatorId === indicatorId ? existing.left.condition : undefined;
    return kept && !list.some((c) => c.id === kept.id) ? [kept, ...list] : list;
  };
  const [leftCond, setLeftCond] = createSignal<string | null>(
    existing?.op === "alert_condition" && existing.left.kind === "indicator" ? (existing.left.condition?.id ?? null) : null,
  );

  /** The study calls alert(): "Any alert() function call" comes first in its condition list. */
  const callsOf = (indicatorId: string): boolean =>
    hasAlertFunction(getIndicatorEntry(indicatorId)) || (existing?.op === "alert_function" && existing.left.kind === "indicator" && existing.left.indicatorId === indicatorId);
  // A study with alert() calls opens on them, one that declares conditions on its first one.
  const firstCalls = !existing && !!props.indicatorId && untrack(() => callsOf(props.indicatorId!));
  const firstCond = !existing && props.indicatorId && !firstCalls ? untrack(() => condsOf(props.indicatorId!))[0] : undefined;
  if (firstCond) setLeftCond(firstCond.id);
  const [op, setOp] = createSignal<AlertOperator>(existing?.op ?? (firstCalls ? "alert_function" : firstCond ? "alert_condition" : "crossing"));
  const isCond = () => op() === "alert_condition";
  /** "Any alert() function call": the script's calls give the message and how often it fires. */
  const isCalls = () => op() === "alert_function";
  /** A condition of the study itself: no plot, nothing compared. */
  const isOwn = () => isCond() || isCalls();
  const leftCalls = () => leftKind() === "indicator" && callsOf(leftIndicator());
  const leftConds = () => (leftKind() === "indicator" ? condsOf(leftIndicator()) : []);
  const leftCondition = () => leftConds().find((c) => c.id === leftCond());

  // ── Right operand ── a value, a drawing level, or an indicator plot.
  const [rightKind, setRightKind] = createSignal<SideKind>(
    existing?.right.kind === "drawing" || (!existing && props.drawingId)
      ? "drawing"
      : existing?.right.kind === "indicator"
        ? "indicator"
        : existing?.right.kind === "price"
          ? "price"
          : "value",
  );
  // A saved number is shown as the source's values are written.
  const savedText = (v: number) => fieldText(alertAmountText(existing?.symbol, existing?.left ?? { kind: "price" }, v));
  const defaultValue =
    existing?.right.kind === "value"
      ? savedText(existing.right.value)
      : props.price != null
        ? String(props.price)
        : "";
  const [rightValue, setRightValue] = createSignal(defaultValue);
  // The value starts on the source's current value (the price, or the study's
  // last value) and follows the source until it is edited.
  const [valueEdited, setValueEdited] = createSignal(defaultValue !== "");
  const [rightDrawing, setRightDrawing] = createSignal(
    existing?.right.kind === "drawing" ? existing.right.drawingId : (!existing && props.drawingId) || "",
  );
  const [rightIndicator, setRightIndicator] = createSignal(
    existing?.right.kind === "indicator" ? existing.right.indicatorId : "",
  );
  const [rightPlot, setRightPlot] = createSignal(existing?.right.kind === "indicator" ? (existing.right.plot ?? 0) : 0);
  /** Plots of an indicator (title per plotConfig index), for the plot select
   *  shown next to a study with 2 or more plots. */
  const plotsOf = (indicatorId: string) =>
    (getIndicatorEntry(indicatorId)?.plotConfig ?? []).map((p, i) => ({ index: i, title: p.title || p.id }));

  // ── Moving conditions: the amount (or %) "in N bars" ──
  const [pct, setPct] = createSignal(
    isMovingOperator(existing?.op ?? "crossing") && existing?.right.kind === "value"
      ? isPercentOperator(existing.op) ? existing.right.value.toFixed(2) : savedText(existing.right.value)
      : "1.00",
  );
  // "in N bars" (1-300; 2 minimum on a study): 1 bar on a price, 2 on a
  // study until it is edited.
  const [bars, setBars] = createSignal(existing?.bars != null ? String(existing.bars) : "");
  const barsMin = () => (leftKind() === "indicator" ? 2 : 1);
  const barsValue = () => {
    const n = Math.round(Number(bars()));
    return bars() !== "" && Number.isFinite(n) ? Math.max(barsMin(), Math.min(300, n)) : barsMin();
  };

  // ── Channel between two bounds: a value, the price (study source) or a
  // study for each; the upper one in `right`, the lower one in `right2`. ──
  const boundSel = (o: Operand | undefined) => (!o ? "value" : o.kind === "price" ? "price" : o.kind === "indicator" ? `ind:${o.indicatorId}` : "value");
  const valueBandAtOpen = !!existing && isBandOperator(existing.op) && existing.right.kind !== "drawing";
  const [upperSel, setUpperSel] = createSignal(valueBandAtOpen ? boundSel(existing!.right) : "value");
  const [lowerSel, setLowerSel] = createSignal(valueBandAtOpen ? boundSel(existing!.right2) : "value");
  const [upperValue, setUpperValue] = createSignal(valueBandAtOpen && existing!.right.kind === "value" ? savedText(existing!.right.value) : "");
  const [lowerValue, setLowerValue] = createSignal(valueBandAtOpen && existing!.right2?.kind === "value" ? savedText(existing!.right2.value) : "");
  const [upperPlot, setUpperPlot] = createSignal(valueBandAtOpen && existing!.right.kind === "indicator" ? (existing!.right.plot ?? 0) : 0);
  const [lowerPlot, setLowerPlot] = createSignal(valueBandAtOpen && existing!.right2?.kind === "indicator" ? (existing!.right2.plot ?? 0) : 0);
  // The bounds start on the source's value plus one tick and the value itself.
  const [boundsEdited, setBoundsEdited] = createSignal(valueBandAtOpen);

  // ── Interval of the condition ── "Same as chart" on a new alert; an alert
  // being edited shows its own. A chart on ticks or ranges: 1 minute.
  const chartInterval = isAlertInterval(props.interval) ? props.interval : undefined;
  const [resolution, setResolution] = createSignal(existing?.resolution ?? chartInterval ?? "1");
  const [intervalOrigin, setIntervalOrigin] = createSignal(!existing && chartInterval ? "same-as-chart" : (sectionOf(untrack(resolution)) ?? ""));
  const intervalChoices = createMemo(() => ({
    favorites: favoriteIntervals().filter(isAlertInterval).sort(compareIntervals),
    groups: intervalGroups([chartInterval ?? "", existing?.resolution ?? ""]),
  }));

  const [frequency, setFrequency] = createSignal<AlertFrequency>(existing?.frequency ?? "only_once");
  const [name, setName] = createSignal(existing?.name ?? "");
  const [message, setMessage] = createSignal(existing?.message ?? "");
  const [sound, setSound] = createSignal(existing?.sound ?? "fired");
  const [soundDuration, setSoundDuration] = createSignal(existing?.soundDuration ?? 0);
  const [popup, setPopup] = createSignal(existing?.popup ?? true);
  // Webhook — persisted per-rule beside the store (see alert-engine's kv map).
  const existingWebhook = existing ? alertWebhook(existing.id) : null;
  const [webhookOn, setWebhookOn] = createSignal(existingWebhook != null);
  const [webhookUrl, setWebhookUrl] = createSignal(existingWebhook ?? "");
  // Expiration: a rule that already expires opens on "Custom date" with it.
  const [expiry, setExpiry] = createSignal<ExpiryKey>(existing?.expiresAt == null ? "open" : "custom");
  const [customExpiry, setCustomExpiry] = createSignal<number | null>(existing?.expiresAt ?? null);
  const expiryOptions = (): MenuOption[] => [
    { value: "open", label: "Open-ended", right: "Won't expire" },
    { value: "eod", label: "End of day", right: shortDateTime(expiryTime("eod", null)!) },
    { value: "1w", label: "1 week", right: shortDateTime(expiryTime("1w", null)!) },
    { value: "1m", label: "1 month", right: shortDateTime(expiryTime("1m", null)!) },
    { value: "custom", label: "Custom date", right: customExpiry() != null ? shortDateTime(customExpiry()!) : "" },
  ];

  // Which view of the dialog shows; the two sub-views edit a copy and write
  // it back on Apply.
  const [view, setView] = createSignal<"main" | "message" | "notifications">("main");
  const [draftName, setDraftName] = createSignal("");
  const [draftMessage, setDraftMessage] = createSignal("");
  const [draftPopup, setDraftPopup] = createSignal(true);
  const [draftWebhookOn, setDraftWebhookOn] = createSignal(false);
  const [draftWebhookUrl, setDraftWebhookUrl] = createSignal("");
  const [draftSound, setDraftSound] = createSignal("");
  const [draftSoundDuration, setDraftSoundDuration] = createSignal(0);
  /** Play button of a sound row: plays it once, or stops it when it is the one playing. */
  const previewSound = (key: string) => {
    const was = isAlertSoundPlaying(key);
    stopAlertSound();
    if (!was) playAlertSound(key, { preview: true });
  };
  const [draftSoundOn, setDraftSoundOn] = createSignal(true);
  const [symbolEdit, setSymbolEdit] = createSignal(!((existing?.symbol ?? props.symbol ?? "").trim()));

  const isPct = () => isPercentOperator(op());
  /** Moving Up / Down (%): an amount in N bars, nothing compared. */
  const isMoving = () => isMovingOperator(op());
  /** A channel between two bounds (not a drawing's). */
  const valueBand = () => isBandOperator(op()) && rightKind() !== "drawing";

  /** Current value of the source: the study's last value, else the price. */
  const sourceValue = (): number | null => {
    if (leftKind() === "indicator") return indicatorPlotValue(symbol(), leftIndicator(), leftPlot());
    return chartLastPrice(symbol()) ?? quoteFor(symbol())?.last ?? null;
  };
  /** A value written as the source's values are. */
  const valueText = (v: number) => fieldText(alertAmountText(symbol(), buildLeft(), v));
  createEffect(() => {
    const v = sourceValue();
    if (v == null) return;
    if (!valueEdited()) setRightValue(untrack(() => valueText(v)));
    if (!boundsEdited()) {
      const tick = cachedSymbolSessions(symbol())?.tickAt(v) ?? 0.01;
      setUpperValue(untrack(() => valueText(v + tick)));
      setLowerValue(untrack(() => valueText(v)));
    }
  });

  // The drawing chosen as the level sets the conditions: a channel or a
  // rectangle has entering / exiting / inside / outside, a vertical line
  // only "Crossing" (once, so no trigger choice), a position its one fixed
  // condition; a fib tool adds the choice of its level.
  const drawingOption = () => (rightKind() === "drawing" ? drawingOptions().find((o) => o.id === rightDrawing()) : undefined);
  const band = () => drawingOption()?.band ?? null;
  const fibLevels = () => drawingOption()?.levels ?? [];
  // An anchored VWAP: the five level conditions on one of its lines.
  const vwapPlots = () => drawingOption()?.plots ?? [];
  const [rightVwapPlot, setRightVwapPlot] = createSignal(existing?.right.kind === "drawing" ? (existing.right.plot ?? 0) : 0);
  const fixedOperators = () => (vwapPlots().length > 0 ? LEVEL_OPERATORS : shapeOperators(band(), fibLevels().length > 0));
  // A study without plots (a TPO) has only its conditions.
  const operators = () => (leftKind() === "indicator" && plotsOf(leftIndicator()).length === 0 ? [] : (fixedOperators() ?? VALUE_OPERATORS));
  const operatorLabel = (o: AlertOperator) =>
    !isBandOperator(o) ? OPERATOR_LABELS[o] : bandOperatorLabel(o, band() === "rectangle" ? "rectangle" : "channel");
  createEffect(() => {
    const list = operators();
    const conds = leftConds();
    const calls = leftCalls();
    if (untrack(op) === "alert_function") {
      if (calls) return;
      if (conds.length) {
        setLeftCond(conds[0].id);
        setOp("alert_condition");
      } else if (list.length) setOp(list[0]);
      return;
    }
    if (untrack(op) === "alert_condition") {
      if (conds.some((c) => c.id === untrack(leftCond))) return;
      if (conds.length) setLeftCond(conds[0].id);
      else if (list.length) setOp(list[0]);
      return;
    }
    if (list.includes(untrack(op))) return;
    if (calls) setOp("alert_function");
    else if (conds.length) {
      setLeftCond(conds[0].id);
      setOp("alert_condition");
    } else if (list.length) setOp(list[0]);
  });
  /** The condition list: the script's alert() calls, a line, the study's conditions, a line, then the comparisons
   *  ("Show more" after the first three). */
  const conditionOptions = (): MenuOption[] => [
    ...(leftCalls() ? [{ value: "alert_function", label: OPERATOR_LABELS.alert_function, icon: OPERATOR_ICONS.alert_function }] : []),
    ...leftConds().map((c, i) => ({ value: `cond:${c.id}`, label: c.title, sep: i === 0 && leftCalls() })),
    ...operators().map((o, i) => ({ value: o, label: operatorLabel(o), icon: OPERATOR_ICONS[o], sep: i === 0 && (leftConds().length > 0 || leftCalls()) })),
  ];
  const [rightLevel, setRightLevel] = createSignal<number>(existing?.right.kind === "drawing" && existing.right.level != null ? existing.right.level : 0.5);
  createEffect(() => {
    const lv = fibLevels();
    if (lv.length && !lv.some((l) => l.coeff === untrack(rightLevel))) setRightLevel((lv.find((l) => l.coeff === 0.5) ?? lv[0]).coeff);
  });
  const levelText = (l: { coeff: number; price: number }) => `${l.coeff} (${l.price.toFixed(2)})`;
  // Fib tool, channel condition: a second level (the lower bound), by
  // default the level after the first one.
  const fibChannel = () => fibLevels().length > 0 && isBandOperator(op());
  const [rightLevel2, setRightLevel2] = createSignal<number | null>(existing?.right.kind === "drawing" && existing.right.level2 != null ? existing.right.level2 : null);
  createEffect(() => {
    const lv = fibLevels();
    if (!lv.length) return;
    const cur = untrack(rightLevel2);
    if (cur != null && lv.some((l) => l.coeff === cur)) return;
    const i = lv.findIndex((l) => l.coeff === rightLevel());
    setRightLevel2((lv[i + 1] ?? lv[i - 1] ?? lv[0]).coeff);
  });

  function buildLeft(): Operand {
    if (leftKind() === "indicator" && leftIndicator()) {
      if (!isOwn()) return indicatorOperand(leftIndicator(), leftPlot(), existing?.left);
      // A condition reads no plot: the study's label without a plot title.
      const o = indicatorOperand(leftIndicator(), 0, existing?.left);
      if (o.kind !== "indicator") return o;
      const plots = plotsOf(leftIndicator());
      const label = plots.length >= 2 && o.label ? o.label.slice(0, o.label.length - `: ${plots[0]?.title ?? ""}`.length) : o.label;
      if (isCalls()) {
        const { condition: _condition, ...rest } = o;
        return { ...rest, label };
      }
      const cond = leftCondition();
      if (!cond) return o;
      return { ...o, label, condition: cond };
    }
    return { kind: "price" };
  }

  /** A bound of a channel: a value, the price or a study's plot. */
  function boundOperand(sel: string, text: string, plot: number, was: Operand | undefined): Operand {
    if (sel === "price") return { kind: "price" };
    if (sel.startsWith("ind:")) return indicatorOperand(sel.slice(4), plot, was);
    return { kind: "value", value: parseFloat(text) || 0 };
  }

  /** The lower bound of a channel between two bounds, else none. */
  function buildRight2(): Operand | undefined {
    return valueBand() ? boundOperand(lowerSel(), lowerValue(), lowerPlot(), existing?.right2) : undefined;
  }

  function buildRight(): Operand {
    // A study's condition compares nothing.
    if (isOwn()) return { kind: "value", value: 0 };
    if (isMoving()) return { kind: "value", value: parseFloat(pct()) || 0 };
    if (valueBand()) return boundOperand(upperSel(), upperValue(), upperPlot(), existing?.right);
    switch (rightKind()) {
      case "drawing": {
        const o = drawingOptions().find((x) => x.id === rightDrawing());
        const lv = o?.levels?.find((l) => l.coeff === rightLevel());
        const lv2 = fibChannel() ? o?.levels?.find((l) => l.coeff === rightLevel2()) : undefined;
        return {
          kind: "drawing",
          drawingId: rightDrawing(),
          label: lv && lv2 ? `${o?.label} (upper bound: level ${lv.coeff}, lower bound: level ${lv2.coeff})` : lv ? `${o?.label} level ${levelText(lv)}` : o?.label,
          ...(o?.band ? { band: o.band } : {}),
          ...(lv ? { level: lv.coeff } : {}),
          ...(lv2 ? { level2: lv2.coeff } : {}),
          ...(o?.plots ? { plot: rightVwapPlot() } : {}),
        };
      }
      case "indicator": {
        return indicatorOperand(rightIndicator(), rightPlot(), existing?.right);
      }
      case "price":
        return { kind: "price" };
      default:
        return { kind: "value", value: parseFloat(rightValue()) || 0 };
    }
  }

  /** Operand label: the study title with its inputs, and the plot title for
   *  a study with several plots ("BB (20, 2): Upper"). */
  function plotLabel(title: string | undefined, indicatorId: string, plot: number, inputs?: Record<string, unknown>): string | undefined {
    const plots = plotsOf(indicatorId);
    const entry = getIndicatorEntry(indicatorId);
    const shown = entry && inputs ? statusLineInputs(entry, inputs, ", ") : "";
    const name = title && shown ? `${title} (${shown})` : title;
    return plots.length >= 2 && name ? `${name}: ${plots[plot]?.title ?? ""}` : name;
  }

  /** An operand on a study. It carries the study's inputs as they are now on
   *  the chart; an alert being edited keeps the ones it was made with. */
  function indicatorOperand(indicatorId: string, plot: number, was: Operand | undefined): Operand {
    const o = indicatorOptions().find((x) => x.id === indicatorId);
    const kept = was?.kind === "indicator" && was.indicatorId === indicatorId ? was : undefined;
    const inputs = kept?.inputs ?? (o?.inputs ? { ...o.inputs } : undefined);
    const label = kept?.inputs && kept.plot === plot && kept.label ? kept.label : plotLabel(kept?.inputs ? kept.label?.replace(/ \(.*$/, "") ?? o?.label : o?.label, indicatorId, plot, inputs);
    // Messages name the study by its full title with its inputs.
    const entry = getIndicatorEntry(indicatorId);
    const shown = entry && inputs ? statusLineInputs(entry, inputs, ", ") : "";
    const full = entry?.metadata.title;
    const title = kept?.title ?? (full ? (shown ? `${full} (${shown})` : full) : undefined);
    const precision = (entry?.metadata as { precision?: number } | undefined)?.precision;
    return { kind: "indicator", indicatorId, plot, label, ...(title ? { title } : {}), ...(precision != null ? { precision } : {}), ...(inputs ? { inputs } : {}) };
  }

  /** Default message: the condition as it is set ("AZO Crossing 150"), or
   *  the message a study's condition declares. An alert keeps no message of
   *  its own while its message is this one, so it follows the condition. */
  const condition = createMemo(() => ({ left: buildLeft(), op: op(), right: buildRight(), right2: buildRight2() }));
  /** The Interval row: a condition that reads an interval, unless a drawing
   *  gives the level. Without it the alert keeps the chart's interval. */
  const intervalRow = () => conditionHasIntervalRow(condition());
  const ruleResolution = () => (intervalRow() ? resolution() : (existing?.resolution ?? props.interval));
  const preview = createMemo(() => defaultAlertMessage({ symbol: symbol(), resolution: ruleResolution(), ...condition(), bars: barsValue() }));

  // The webhook only saves (and the dialog only closes) with an http(s) URL —
  // any other string would silently never deliver.
  const webhookValid = createMemo(() => !webhookOn() || isValidWebhookUrl(webhookUrl()));

  const canSave = createMemo(() => {
    if (!symbol().trim()) return false;
    if (!webhookValid()) return false;
    if (isCond()) return !!leftCondition();
    if (isCalls()) return leftCalls();
    if (isMoving()) return Number.isFinite(parseFloat(pct()));
    if (valueBand()) {
      const ok = (sel: string, text: string) => (sel === "value" ? Number.isFinite(parseFloat(text)) : sel === "price" || indicatorOptions().some((o) => `ind:${o.id}` === sel));
      return ok(upperSel(), upperValue()) && ok(lowerSel(), lowerValue());
    }
    if (rightKind() === "value") return Number.isFinite(parseFloat(rightValue()));
    if (rightKind() === "drawing") return drawingOptions().some((o) => o.id === rightDrawing());
    if (rightKind() === "indicator") return indicatorOptions().some((o) => o.id === rightIndicator());
    return true;
  });

  function save() {
    if (!canSave()) return;
    const expiresAt = expiryTime(expiry(), customExpiry());

    const typed = symbol().trim().toUpperCase();
    const rule = {
      symbol: typed,
      resolution: ruleResolution(),
      session: existing ? existing.session : props.session,
      left: buildLeft(),
      op: op(),
      right: buildRight(),
      right2: buildRight2(),
      bars: isMoving() ? barsValue() : undefined,
      // alert() calls: each call's frequency and message.
      frequency: isCalls() ? ("once_per_bar" as AlertFrequency) : band() === "time" ? ("only_once" as AlertFrequency) : frequency(),
      name: isCalls() && name().trim() === preview() ? "" : name().trim(),
      message: isCalls() ? "" : message().trim(),
      sound: sound(),
      soundDuration: sound() ? soundDuration() : 0,
      popup: popup(),
      expiresAt,
    };

    if (popup()) ensureNotificationPermission();

    const webhook = webhookOn() ? webhookUrl() : null;
    const commit = (sym: string) => {
      const r = { ...rule, symbol: sym };
      let id: string;
      if (existing) {
        alertStore.update(existing.id, { ...r, enabled: true });
        // The condition may have changed — drop the stale crossing baseline so the
        // next tick re-establishes it instead of manufacturing a spurious cross.
        resetRuleEvalState(existing.id);
        id = existing.id;
      } else {
        id = alertStore.add(r);
      }
      setAlertWebhook(id, webhook);
    };
    // A typed bare ticker gets its primary listing (rules are keyed by the
    // full name); if the lookup fails it is kept and migrated on a later start.
    if (isFullSymbol(typed)) commit(typed);
    else void toFullSymbol(typed).then(commit, () => commit(typed));
    props.onClose();
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        props.onClose();
      } else if (existing && e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
        // "Save changes in the Edit alert dialog" = Ctrl+Enter (bound for the
        // Edit dialog only).
        e.preventDefault();
        e.stopPropagation();
        save();
      }
    };
    document.addEventListener("keydown", onKey, true);
    onCleanup(() => document.removeEventListener("keydown", onKey, true));
  });

  // ── View helpers ──────────────────────────────────────────────────────────
  const usesIndicator = () =>
    leftKind() === "indicator" || (!isMoving() && (valueBand() ? upperSel().startsWith("ind:") || lowerSel().startsWith("ind:") : rightKind() === "indicator"));
  const triggerOptions = (): MenuOption[] => {
    const list = usesIndicator() ? STUDY_FREQUENCIES : FREQUENCIES;
    const kept = list.some((f) => f.key === frequency()) ? [] : STUDY_FREQUENCIES.filter((f) => f.key === frequency());
    return [...list, ...kept].map((f) => ({ value: f.key, label: f.label, desc: f.desc }));
  };
  // A study is a source when it has plots or conditions; the one being edited stays.
  const alertable = (id: string) =>
    plotsOf(id).length > 0 || condsOf(id).length > 0 || callsOf(id) || (existing?.left.kind === "indicator" && existing.left.indicatorId === id);
  const sourceOptions = (): MenuOption[] => [
    { value: "price", label: "Price" },
    ...indicatorOptions().filter((r) => alertable(r.id)).map((r) => ({ value: `ind:${r.id}`, label: r.label })),
  ];
  /** What the condition compares with, in one select: a value, the price (a study's level conditions), the other
   *  studies with plots, and the drawing the dialog was opened for. */
  const compareOptions = (): MenuOption[] => [
    { value: "value", label: "Value" },
    ...(leftKind() === "indicator" && LEVEL_OPERATORS.includes(op()) ? [{ value: "price", label: "Price" }] : []),
    ...indicatorOptions()
      .filter((r) => (plotsOf(r.id).length > 0 || r.id === rightIndicator()) && !(leftKind() === "indicator" && r.id === leftIndicator()))
      .map((r) => ({ value: `ind:${r.id}`, label: r.label })),
    ...drawingOptions().map((d) => ({ value: `drw:${d.id}`, label: drawingSelectLabel(d.label) })),
  ];
  const compareValue = () => (rightKind() === "indicator" ? `ind:${rightIndicator()}` : rightKind() === "drawing" ? `drw:${rightDrawing()}` : rightKind());
  const pickCompare = (v: string) => {
    if (v.startsWith("ind:")) {
      setRightKind("indicator");
      setRightIndicator(v.slice(4));
      setRightPlot(0);
    } else if (v.startsWith("drw:")) {
      setRightKind("drawing");
      setRightDrawing(v.slice(4));
    } else setRightKind(v as SideKind);
  };
  const levelOptions = (): MenuOption[] => fibLevels().map((l) => ({ value: String(l.coeff), label: levelText(l) }));
  const plotOptions = (id: string): MenuOption[] => plotsOf(id).map((p) => ({ value: String(p.index), label: p.title }));
  const notificationsText = () => {
    const on = [popup() && "Notification", webhookOn() && "Webhook", sound() && "Sound"].filter(Boolean);
    return on.length ? on.join(", ") : "None";
  };
  // alert() calls: the view edits the alert's name only (the calls give the messages), shown as the condition until
  // changed.
  const openMessage = () => { setDraftName(isCalls() ? name() || preview() : name()); setDraftMessage(message() || preview()); setView("message"); };
  /** Placeholder menu: the plots of the source when it is a study. */
  const placeholderMenu = () => placeholderGroups(leftKind() === "indicator" ? plotsOf(leftIndicator()) : null);
  const openNotifications = () => {
    setDraftPopup(popup());
    setDraftWebhookOn(webhookOn());
    setDraftWebhookUrl(webhookUrl());
    setDraftSoundOn(!!sound());
    setDraftSound(sound() || "fired");
    setDraftSoundDuration(soundDuration());
    setView("notifications");
  };
  const draftWebhookValid = () => !draftWebhookOn() || isValidWebhookUrl(draftWebhookUrl());
  /** One step up / down of a number field, in its last decimal. */
  const stepped = (text: string, dir: 1 | -1) => {
    const v = parseFloat(text);
    const t = text.trim();
    const decimals = t.includes(".") ? t.split(".")[1].length : 2;
    const step = 1 / 10 ** decimals;
    return ((Number.isFinite(v) ? v : 0) + dir * step).toFixed(decimals);
  };
  /** A number field with its up / down steppers. */
  const valueBox = (get: () => string, set: (v: string) => void, label: string) => (
    <span class="ad-number">
      <input class="ad-input" type="text" inputmode="decimal" aria-label={label} value={get()} onInput={(e) => set(e.currentTarget.value)} placeholder="0.00" />
      <span class="ad-steppers">
        <button type="button" tabIndex={-1} aria-label="Increase" onClick={() => set(stepped(get(), 1))}>{arrow("m5 11 4-4 4 4")}</button>
        <button type="button" tabIndex={-1} aria-label="Decrease" onClick={() => set(stepped(get(), -1))}>{arrow("m5 7 4 4 4-4")}</button>
      </span>
    </span>
  );
  /** What a bound can be: a value, the studies with plots (not the source itself), and the drawing with two bounds
   *  the dialog was opened for (picking it makes the drawing the level). The price is not a bound. */
  const boundOptions = (): MenuOption[] => [
    { value: "value", label: "Value" },
    ...indicatorOptions().filter((r) => plotsOf(r.id).length > 0 && !(leftKind() === "indicator" && r.id === leftIndicator())).map((r) => ({ value: `ind:${r.id}`, label: r.label })),
    ...drawingOptions().filter((d) => d.band === "channel" || d.band === "rectangle" || (d.levels?.length ?? 0) > 0).map((d) => ({ value: `drw:${d.id}`, label: drawingSelectLabel(d.label) })),
  ];
  /** A row "Upper bound" / "Lower bound": its select, the value field for a value, the plot select for a study with
   *  several plots. */
  const boundRow = (title: string, sel: () => string, setSel: (v: string) => void, value: () => string, setValue: (v: string) => void, plot: () => number, setPlot: (v: number) => void) => (
    <div class="ad-row">
      <span class="ad-label">{title}</span>
      <div class="ad-controls">
        <div class="ad-pair">
          <AdMenu
            variant="box"
            label={title}
            value={sel()}
            options={boundOptions()}
            onPick={(v) => {
              if (v.startsWith("drw:")) {
                setRightKind("drawing");
                setRightDrawing(v.slice(4));
                return;
              }
              setBoundsEdited(true);
              setSel(v);
              setPlot(0);
            }}
          />
          <Show when={sel() === "value"}>{valueBox(value, (v) => { setBoundsEdited(true); setValue(v); }, title)}</Show>
        </div>
        <Show when={sel().startsWith("ind:") && plotsOf(sel().slice(4)).length >= 2}>
          <AdMenu variant="box" label={`${title} plot`} value={String(plot())} options={plotOptions(sel().slice(4))} onPick={(v) => setPlot(Number(v))} />
        </Show>
      </div>
    </div>
  );
  const closeIcon = (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
      <path stroke="currentColor" stroke-width="1.2" fill="none" d="m1.5 1.5 15 15m0-15-15 15" />
    </svg>
  );
  const arrow = (d: string) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
      <path stroke="currentColor" stroke-width="1.2" fill="none" d={d} />
    </svg>
  );
  const subHeader = (title: string) => (
    <header class="ad-header">
      <button type="button" class="ad-icon-btn" data-name="back" aria-label="Back" onClick={() => setView("main")}>
        {arrow("M11 3.5 5.5 9l5.5 5.5")}
      </button>
      <span class="ad-title">{title}</span>
      <span class="ad-spacer" />
      <button type="button" class="ad-icon-btn" data-name="close" aria-label="Close" onClick={() => props.onClose()}>
        {closeIcon}
      </button>
    </header>
  );

  return (
    <Portal mount={document.body}>
      <div class="ad-backdrop" role="presentation" onMouseDown={() => props.onClose()}>
        <div class="ad" role="dialog" aria-label={existing ? "Edit alert" : "Create alert"} onMouseDown={(e) => e.stopPropagation()}>
          {/* ── Main view ── */}
          <Show when={view() === "main"}>
            <header class="ad-header">
              <span class="ad-title">{existing ? "Edit alert on" : "Create alert on"}</span>
              <Show
                when={!symbolEdit()}
                fallback={
                  <input
                    class="ad-input ad-symbol-input"
                    type="text"
                    aria-label="Symbol"
                    value={symbol()}
                    placeholder="Symbol"
                    spellcheck={false}
                    ref={(el) => queueMicrotask(() => { if (symbol()) el.select(); el.focus(); })}
                    onInput={(e) => setSymbol(e.currentTarget.value.toUpperCase())}
                    onKeyDown={(e) => { if (e.key === "Enter" && symbol().trim()) setSymbolEdit(false); }}
                    onBlur={() => { if (symbol().trim()) setSymbolEdit(false); }}
                  />
                }
              >
                <button type="button" class="ad-symbol-btn" data-name="symbols-button" onClick={() => setSymbolEdit(true)}>
                  {/* A level from a drawing: the drawing's chart sets the interval, shown with the symbol. */}
                  <span class="ad-symbol-text">
                    {symbol().includes(":") ? symbol().split(":")[1] : symbol()}
                    {condition().right.kind === "drawing" ? `, ${alertIntervalText(ruleResolution(), true)}` : ""}
                  </span>
                  {arrow("m4.5 7 4.5 4 4.5-4")}
                </button>
              </Show>
              <span class="ad-spacer" />
              <button type="button" class="ad-icon-btn" data-name="close" aria-label="Close" onClick={() => props.onClose()}>
                {closeIcon}
              </button>
            </header>

            <div class="ad-body">
              <div class="ad-row ad-row--top">
                <span class="ad-label">Condition</span>
                <div class="ad-controls">
                  <AdMenu
                    variant="box"
                    label="Source"
                    value={leftKind() === "indicator" ? `ind:${leftIndicator()}` : "price"}
                    options={sourceOptions()}
                    onPick={(v) => {
                      if (v === "price") {
                        setLeftKind("price");
                        if (isOwn()) setOp("crossing");
                        return;
                      }
                      setLeftKind("indicator");
                      setLeftIndicator(v.slice(4));
                      setLeftPlot(0);
                      // A study with alert() calls starts on them, one with conditions on its first one.
                      const conds = condsOf(v.slice(4));
                      if (callsOf(v.slice(4))) setOp("alert_function");
                      else if (conds.length) {
                        setLeftCond(conds[0].id);
                        setOp("alert_condition");
                      } else if (isOwn()) setOp("crossing");
                    }}
                  />
                  {/* Plot select: a study with 2 or more plots (not for one of its conditions). */}
                  <Show when={!isOwn() && leftKind() === "indicator" && plotsOf(leftIndicator()).length >= 2}>
                    <AdMenu variant="box" label="Plot" value={String(leftPlot())} options={plotOptions(leftIndicator())} onPick={(v) => setLeftPlot(Number(v))} />
                  </Show>

                  <AdMenu
                    variant="box"
                    label="Condition"
                    value={isCond() ? `cond:${leftCond()}` : op()}
                    more={fixedOperators() ? undefined : (leftCalls() ? 1 : 0) + leftConds().length + 3}
                    options={conditionOptions()}
                    lockSingle
                    onPick={(v) => {
                      if (v.startsWith("cond:")) {
                        setLeftCond(v.slice(5));
                        setOp("alert_condition");
                      } else setOp(v as AlertOperator);
                    }}
                  />

                  {/* A study's condition compares nothing. */}
                  <Show when={!isOwn()}>
                  <Show
                    when={!isMoving()}
                    fallback={
                      <div class="ad-pair ad-pct">
                        {/* The amount ("1.00"), with "%" for Moving Up / Down %, then "in N bars". */}
                        {valueBox(pct, setPct, isPct() ? "Percent" : "Amount")}
                        <span class="ad-suffix">{isPct() ? "% in" : "in"}</span>
                        <input
                          class="ad-input"
                          type="number"
                          step="1"
                          min={barsMin()}
                          max="300"
                          aria-label="Bars"
                          value={bars() || String(barsMin())}
                          onInput={(e) => setBars(e.currentTarget.value)}
                        />
                        <span class="ad-suffix">{barsValue() === 1 ? "bar" : "bars"}</span>
                      </div>
                    }
                  >
                    <Show when={!valueBand()}>
                    <div class="ad-pair">
                      <AdMenu variant="box" label="Compared with" value={compareValue()} options={compareOptions()} onPick={pickCompare} />
                      <Show when={rightKind() === "value"}>
                        {valueBox(rightValue, (v) => { setValueEdited(true); setRightValue(v); }, "Value")}
                      </Show>
                    </div>
                    {/* Anchored VWAP: which of its lines. */}
                    <Show when={rightKind() === "drawing" && vwapPlots().length > 0}>
                      <AdMenu variant="box" label="Line" value={String(rightVwapPlot())} options={vwapPlots().map((p, i) => ({ value: String(i), label: p }))} onPick={(v) => setRightVwapPlot(Number(v))} />
                    </Show>
                    <Show when={rightKind() === "indicator" && plotsOf(rightIndicator()).length >= 2}>
                      <AdMenu variant="box" label="Plot" value={String(rightPlot())} options={plotOptions(rightIndicator())} onPick={(v) => setRightPlot(Number(v))} />
                    </Show>
                    </Show>
                  </Show>
                  </Show>
                </div>
              </div>
              {/* Channel between two bounds: a value, the price or a study each. */}
              <Show when={!isOwn() && valueBand()}>
                {boundRow("Upper bound", upperSel, setUpperSel, upperValue, setUpperValue, upperPlot, setUpperPlot)}
                {boundRow("Lower bound", lowerSel, setLowerSel, lowerValue, setLowerValue, lowerPlot, setLowerPlot)}
              </Show>
              {/* Fib tool: its level; with a channel condition the two bounds. */}
              <Show when={!isMoving() && rightKind() === "drawing" && fibLevels().length > 0}>
                <div class="ad-row">
                  <span class="ad-label">{fibChannel() ? "Upper bound" : "Level"}</span>
                  <div class="ad-controls">
                    <AdMenu variant="box" label={fibChannel() ? "Upper bound" : "Level"} value={String(rightLevel())} options={levelOptions()} onPick={(v) => setRightLevel(Number(v))} />
                  </div>
                </div>
                <Show when={fibChannel()}>
                  <div class="ad-row">
                    <span class="ad-label">Lower bound</span>
                    <div class="ad-controls">
                      <AdMenu variant="box" label="Lower bound" value={String(rightLevel2())} options={levelOptions()} onPick={(v) => setRightLevel2(Number(v))} />
                    </div>
                  </div>
                </Show>
              </Show>
              <Show when={intervalRow()}>
                <div class="ad-row">
                  <span class="ad-label">Interval</span>
                  <div class="ad-controls">
                    <AdIntervalMenu
                      value={resolution()}
                      origin={intervalOrigin()}
                      chart={chartInterval}
                      favorites={intervalChoices().favorites}
                      groups={intervalChoices().groups}
                      onPick={(id, origin) => { setResolution(id); setIntervalOrigin(origin); }}
                    />
                  </div>
                </div>
              </Show>

              <div class="ad-divider" />

              {/* A vertical line is crossed once: no trigger choice; alert() calls say how often they fire. */}
              <Show when={band() !== "time" && !isCalls()}>
                <div class="ad-row ad-row--text">
                  <span class="ad-label">Trigger</span>
                  <AdMenu variant="inline" label="Trigger" value={frequency()} options={triggerOptions()} onPick={(v) => setFrequency(v as AlertFrequency)} />
                </div>
              </Show>
              <div class="ad-row ad-row--text">
                <span class="ad-label">Expiration</span>
                <AdMenu variant="inline" label="Expiration" value={expiry()} options={expiryOptions()} onPick={(v) => { setExpiry(v as ExpiryKey); if (v === "custom" && customExpiry() == null) setCustomExpiry(expiryTime("1w", null)); }} />
                <Show when={expiry() === "custom"}>
                  <input
                    class="ad-input ad-date"
                    type="datetime-local"
                    aria-label="Expiration date"
                    value={customExpiry() != null ? toLocalInput(customExpiry()!) : ""}
                    onChange={(e) => { const t = Date.parse(e.currentTarget.value); setCustomExpiry(Number.isFinite(t) ? t : null); }}
                  />
                </Show>
              </div>
              <div class="ad-row ad-row--text">
                <span class="ad-label">Message</span>
                <button type="button" class="ad-link" data-name="alert-message-button" onClick={openMessage}>
                  <span class="ad-link-text">{isCalls() ? name() || preview() : <>{name() ? `${name()}: ` : ""}{message() || preview()}</>}</span>
                  {arrow("m7 4.5 4 4.5-4 4.5")}
                </button>
              </div>
              <div class="ad-row ad-row--text">
                <span class="ad-label">Notifications</span>
                <button type="button" class="ad-link" data-name="alert-notifications-button" onClick={openNotifications}>
                  <span class="ad-link-text">{notificationsText()}</span>
                  {arrow("m7 4.5 4 4.5-4 4.5")}
                </button>
              </div>
            </div>

            <footer class="ad-footer">
              <Show when={existing}>
                <button
                  type="button"
                  class="ot-dlg-btn is-secondary ad-delete"
                  onClick={() => {
                    resetRuleEvalState(existing!.id);
                    setAlertWebhook(existing!.id, null);
                    alertStore.remove(existing!.id);
                    props.onClose();
                  }}
                >
                  Delete
                </button>
              </Show>
              <span class="ad-spacer" />
              <button type="button" class="ot-dlg-btn is-secondary" data-name="cancel" onClick={() => props.onClose()}>Cancel</button>
              <button type="button" class="ot-dlg-btn is-main is-neutral" data-name="submit" aria-disabled={!canSave()} disabled={!canSave()} onClick={save}>
                {existing ? "Save" : "Create"}
              </button>
            </footer>
          </Show>

          {/* ── Edit message ── */}
          <Show when={view() === "message"}>
            {subHeader("Edit message")}
            <div class="ad-body">
              <label class="ad-field">
                <span class="ad-label">Alert name</span>
                <input class="ad-input" type="text" value={draftName()} onInput={(e) => setDraftName(e.currentTarget.value)} />
              </label>
              <Show when={!isCalls()}>
              <div class="ad-field">
                <label class="ad-label" for="alert-message">Message</label>
                <textarea id="alert-message" class="ad-input ad-textarea" data-name="alert-message-textarea" value={draftMessage()} onInput={(e) => setDraftMessage(e.currentTarget.value)} />
                <div class="ad-message-buttons">
                  <AdPlaceholders groups={placeholderMenu()} onPick={(v) => setDraftMessage(appendPlaceholder(draftMessage(), v))} />
                  <Show when={draftMessage() !== preview()}>
                    <button type="button" class="ad-small-btn is-icon" data-name="alert-message-reset-button" title="Reset to default" aria-label="Reset to default" onClick={() => setDraftMessage(preview())}>
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
                        <path fill="currentColor" d="M10 6.13V8L6 5.5 10 3v2.1A5 5 0 1 1 4 10a.5.5 0 0 1 1 0 4 4 0 1 0 5-3.87Z" />
                      </svg>
                    </button>
                  </Show>
                </div>
              </div>
              </Show>
            </div>
            <footer class="ad-footer">
              <span class="ad-spacer" />
              <button type="button" class="ot-dlg-btn is-secondary" onClick={() => setView("main")}>Cancel</button>
              <button
                type="button"
                class="ot-dlg-btn is-main is-neutral"
                onClick={() => {
                  if (isCalls()) setName(draftName().trim() === preview() ? "" : draftName());
                  else {
                    setName(draftName());
                    setMessage(draftMessage() === preview() ? "" : draftMessage());
                  }
                  setView("main");
                }}
              >
                Apply
              </button>
            </footer>
          </Show>

          {/* ── Notifications ── */}
          <Show when={view() === "notifications"}>
            {subHeader("Notifications")}
            <div class="ad-body">
              <label class="ad-check">
                <input type="checkbox" checked={draftPopup()} onChange={() => setDraftPopup((v) => !v)} />
                <span class="ad-check-title">Show desktop notification</span>
                <span class="ad-check-desc">Displays a notification of the operating system when your alert triggers.</span>
              </label>
              {/* Webhook — POSTs the fire payload as JSON (see alert-engine). */}
              <label class="ad-check">
                <input type="checkbox" checked={draftWebhookOn()} onChange={() => setDraftWebhookOn((v) => !v)} />
                <span class="ad-check-title">Webhook URL</span>
                <span class="ad-check-desc">Sends a POST request to your specified URL when your alert triggers.</span>
              </label>
              <Show when={draftWebhookOn()}>
                <input
                  class="ad-input ad-indent"
                  type="url"
                  value={draftWebhookUrl()}
                  onInput={(e) => setDraftWebhookUrl(e.currentTarget.value)}
                  placeholder="https://example.com/alert-hook"
                  aria-label="Webhook URL"
                  aria-invalid={!draftWebhookValid() || undefined}
                  title={draftWebhookValid() ? undefined : "Enter an http:// or https:// URL"}
                />
              </Show>
              <label class="ad-check">
                <input type="checkbox" checked={draftSoundOn()} onChange={() => setDraftSoundOn((v) => !v)} />
                <span class="ad-check-title">Play sound</span>
                <span class="ad-check-desc">Plays an audio cue when your alert triggers.</span>
              </label>
              <Show when={draftSoundOn()}>
                <div class="ad-pair ad-pair--sound ad-indent">
                  <AdMenu variant="box" label="Sound" group={SOUND_GROUP} value={draftSound()} options={SOUND_OPTIONS.filter((s) => s.key).map((s) => ({ value: s.key, label: s.label, play: () => previewSound(s.key) }))} onPick={setDraftSound} />
                  <AdMenu variant="box" label="Sound duration" value={String(draftSoundDuration())} options={SOUND_DURATIONS.map((d) => ({ value: String(d.value), label: d.label }))} onPick={(v) => setDraftSoundDuration(Number(v))} />
                </div>
                <Show when={!alertSettings.soundEnabled()}>
                  <div class="ad-hint ad-indent">Alert sounds are off in Settings: this alert fires without sound.</div>
                </Show>
              </Show>
            </div>
            <footer class="ad-footer">
              <span class="ad-spacer" />
              <button type="button" class="ot-dlg-btn is-secondary" onClick={() => setView("main")}>Cancel</button>
              <button
                type="button"
                class="ot-dlg-btn is-main is-neutral"
                aria-disabled={!draftWebhookValid()}
                disabled={!draftWebhookValid()}
                onClick={() => {
                  setPopup(draftPopup());
                  setWebhookOn(draftWebhookOn());
                  setWebhookUrl(draftWebhookUrl());
                  setSound(draftSoundOn() ? draftSound() : "");
                  setSoundDuration(draftSoundDuration());
                  setView("main");
                }}
              >
                Apply
              </button>
            </footer>
          </Show>
        </div>
      </div>
    </Portal>
  );
}
