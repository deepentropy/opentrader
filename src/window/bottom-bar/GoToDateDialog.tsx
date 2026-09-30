/*
 * GoToDateDialog — the "Go to" date dialog opened by the calendar button next
 * to the date-range tabs in the bottom bar (hotkey Alt+G). Solid port of the
 * reference mock: Date / Custom-range tabs, a date + time input, a Monday-first
 * month calendar with month nav, and a Cancel / Go to footer. Submitting calls
 * `onSubmit(date, minutes)`; the bottom bar relays it to the chart as a
 * jump-to-date. The time field is TimeInput (mask + 15-minute list).
 *
 * The Custom-range tab picks a [from, to] date pair and submits it via
 * `onSubmitRange`; the bottom bar frames the chart on that span. Anchored as a
 * drop-up above the trigger, clamped into the viewport.
 */
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { WallDate } from "../chart/day-key";
import { normalizeTime, TimeInput } from "./TimeInput";

type Props = {
  anchor: DOMRect;
  initialDate?: Date;
  initialTime?: string;
  /** Date tab submit: the picked calendar date and time (minutes after
   *  midnight), read by each chart in its own time zone. */
  onSubmit: (date: WallDate, minutes: number) => void;
  /** Custom-range tab submit — frame the chart on [from, to]. */
  onSubmitRange?: (from: WallDate, to: WallDate) => void;
  onClose: () => void;
};

// ─── Calendar primitives (Monday-first week) ────────────────────────────────
const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const dowMondayFirst = (d: Date) => (d.getDay() + 6) % 7;

function ymd(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function parseYmd(s: string): Date | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return isNaN(d.getTime()) ? null : d;
}
function monthLabel(year: number, month: number): string {
  return new Date(year, month, 1).toLocaleString("en-US", { month: "long", year: "numeric" });
}
function ariaDay(d: Date): string {
  return d.toLocaleString("en-US", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

// ─── Date typing rules (TV DatePicker 368690) ───────────────────────────────
/** Keys the date field accepts (TV `inputRegex`); others are blocked. */
const DATE_KEY = /[0-9.]/;
/** TV `_fixValue`, run on key release (not after Backspace): at most 10
 *  chars, repeated dashes collapsed, a dash added after `YYYY` and `YYYY-MM`. */
function fixDate(v: string): string {
  let s = v.substring(0, 10).replace(/-+/g, "-");
  if (/^\d{4}$/.test(s) || /^\d{4}-\d{2}$/.test(s)) s += "-";
  return s;
}

/** Visible weeks for a month — first/last weeks are short (partial); CSS pins
 *  them right/left via the `.week:first-child`/`:last-child` rules. */
function monthWeeks(year: number, month: number): Date[][] {
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const firstCol = dowMondayFirst(first);
  const out: Date[][] = [];
  const cursor = new Date(first);
  const firstWeek: Date[] = [];
  for (let c = firstCol; c < 7 && cursor.getMonth() === month; c++) {
    firstWeek.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  if (firstWeek.length) out.push(firstWeek);
  while (cursor.getMonth() === month && cursor.getDate() + 7 <= last.getDate() + 1) {
    const week: Date[] = [];
    for (let c = 0; c < 7; c++) {
      if (cursor.getMonth() !== month) break;
      week.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    if (week.length === 7) out.push(week);
    else { if (week.length) out.push(week); break; }
  }
  if (cursor.getMonth() === month) {
    const lastWeek: Date[] = [];
    while (cursor.getMonth() === month) {
      lastWeek.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    if (lastWeek.length) out.push(lastWeek);
  }
  return out;
}

const CalendarIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28" fill="none">
    <path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M10 4h1v2h6V4h1v2h2.5A2.5 2.5 0 0 1 23 8.5v11a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 5 19.5v-11A2.5 2.5 0 0 1 7.5 6H10V4zm8 3H7.5C6.67 7 6 7.67 6 8.5v11c0 .83.67 1.5 1.5 1.5h13c.83 0 1.5-.67 1.5-1.5v-11c0-.83-.67-1.5-1.5-1.5H18zm-3 2h-2v2h2V9zm-7 4h2v2H8v-2zm12-4h-2v2h2V9zm-7 4h2v2h-2v-2zm-3 4H8v2h2v-2zm3 0h2v2h-2v-2zm7-4h-2v2h2v-2z" />
  </svg>
);
const CloseIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28">
    <path fill="currentColor" d="M19.78 8.22 14 14l5.78 5.78-1.06 1.06L13 15.06l-5.78 5.78-1.06-1.06L11.94 14 6.16 8.22l1.06-1.06L13 12.94l5.72-5.78 1.06 1.06Z" />
  </svg>
);
const ChevronLeftIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
    <path fill="currentColor" d="M10.97 4.97 6.94 9l4.03 4.03-1.06 1.06L4.82 9l5.09-5.09 1.06 1.06Z" />
  </svg>
);
const ChevronRightIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
    <path fill="currentColor" d="m5.03 4.97 5.09 5.09-5.09 5.09L3.97 14.09 8 10.06 3.97 6.03Z" />
  </svg>
);

type TabId = "date" | "customrange";

export function GoToDateDialog(props: Props) {
  const today = (() => { const t = new Date(); t.setHours(0, 0, 0, 0); return t; })();
  const initial = props.initialDate ?? today;
  const [tab, setTab] = createSignal<TabId>("date");
  const [selected, setSelected] = createSignal<Date>(new Date(initial));
  const [dateText, setDateText] = createSignal<string>(ymd(initial));
  const [timeText, setTimeText] = createSignal<string>(props.initialTime ?? "00:00");
  // Custom-range fields. Calendar clicks fill the armed one, then arm the
  // other (first click = From, second = To). Defaults frame the last month.
  const monthAgo = (() => { const d = new Date(initial); d.setDate(d.getDate() - 30); return d; })();
  const [fromText, setFromText] = createSignal<string>(ymd(monthAgo));
  const [toText, setToText] = createSignal<string>(ymd(initial));
  const [armedField, setArmedField] = createSignal<"from" | "to">("from");
  const [viewYear, setViewYear] = createSignal<number>(initial.getFullYear());
  const [viewMonth, setViewMonth] = createSignal<number>(initial.getMonth());
  // Month-label click switches the calendar body to a 12-month grid (the nav
  // chevrons then step YEARS); picking a month drops back to the day grid.
  const [calView, setCalView] = createSignal<"days" | "months">("days");
  const [pos, setPos] = createSignal<{ left: number; top: number } | null>(null);
  let popup!: HTMLDivElement;

  // Date-input typing keeps the calendar in sync — only when it parses.
  createEffect(() => {
    const d = parseYmd(dateText());
    if (!d) return;
    setSelected(d);
    setViewYear(d.getFullYear());
    setViewMonth(d.getMonth());
  });

  const weeks = createMemo(() => monthWeeks(viewYear(), viewMonth()));

  // Position drop-up from the anchor; clamp into the viewport. Recompute on tab
  // change (Custom-range resizes the body).
  const reposition = () => {
    const H = popup.offsetHeight;
    const W = popup.offsetWidth;
    const M = 4;
    let left = Math.round(props.anchor.left + props.anchor.width / 2 - W / 2);
    let top = Math.round(props.anchor.top - H - M);
    if (left < M) left = M;
    if (left + W > window.innerWidth - M) left = window.innerWidth - W - M;
    if (top < M) top = Math.round(props.anchor.bottom + M);
    setPos({ left, top });
  };

  onMount(() => {
    reposition();
    const onDown = (e: PointerEvent) => { if (!popup.contains(e.target as Node)) props.onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); props.onClose(); } };
    // Defer the outside-click listener a tick so the opening click doesn't close it.
    const t = window.setTimeout(() => window.addEventListener("pointerdown", onDown), 0);
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => {
      window.clearTimeout(t);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
    });
  });
  createEffect(() => { tab(); reposition(); });

  const stepMonth = (delta: number) => {
    const m = viewMonth() + delta;
    setViewYear(viewYear() + Math.floor(m / 12));
    setViewMonth(((m % 12) + 12) % 12);
  };
  /* The header chevrons step months in the day view, years in the months view. */
  const stepNav = (delta: number) => {
    if (calView() === "months") setViewYear(viewYear() + delta);
    else stepMonth(delta);
  };
  const navLabel = (delta: number) =>
    calView() === "months"
      ? `${delta < 0 ? "Previous" : "Next"} year, ${viewYear() + delta}`
      : `${delta < 0 ? "Previous" : "Next"} month, ${monthLabel(viewYear(), viewMonth() + delta)}`;

  // Date fields: block other keys, add the dashes on key release (TV).
  const onDateKeyPress = (e: KeyboardEvent) => {
    if (e.key.length === 1 && !DATE_KEY.test(e.key)) e.preventDefault();
  };
  const onDateKeyUp = (e: KeyboardEvent & { currentTarget: HTMLInputElement }, set: (v: string) => void) => {
    if (e.key === "Backspace") return;
    const v = e.currentTarget.value;
    const fixed = fixDate(v);
    if (fixed !== v) {
      e.currentTarget.value = fixed;
      set(fixed);
    }
  };
  const wall = (d: Date): WallDate => ({ y: d.getFullYear(), m: d.getMonth(), d: d.getDate() });

  const submit = () => {
    if (tab() === "customrange") {
      const a = parseYmd(fromText());
      const b = parseYmd(toText());
      if (!a || !b) return;
      // Order-agnostic: swap if the user picked them backwards.
      const [from, to] = a.getTime() <= b.getTime() ? [a, b] : [b, a];
      props.onSubmitRange?.(wall(from), wall(to));
      props.onClose();
      return;
    }
    const d = parseYmd(dateText()) ?? selected();
    const [h, m] = normalizeTime(timeText()).split(":").map(Number);
    props.onSubmit(wall(d), h * 60 + m);
    props.onClose();
  };

  /** Calendar-day click: Date tab picks the single date; Custom-range fills
   *  the armed endpoint then arms the other one. */
  const pickDay = (d: Date) => {
    if (tab() === "customrange") {
      if (armedField() === "from") {
        setFromText(ymd(d));
        setArmedField("to");
      } else {
        setToText(ymd(d));
        setArmedField("from");
      }
      return;
    }
    setSelected(new Date(d));
    setDateText(ymd(d));
  };

  return (
    <Portal mount={document.body}>
      <div
        ref={popup}
        class="ot-popover goto-dialog-wrapper"
        role="dialog"
        data-name="go-to-date-dialog"
        aria-label="Go to"
        style={pos() ? { left: `${pos()!.left}px`, top: `${pos()!.top}px` } : { left: "-9999px", top: "-9999px" }}
      >
        <div class="goto-dialog-titlebar" data-dragg-area="true">
          <div class="goto-dialog-title">Go to</div>
          <button type="button" class="goto-dialog-close" aria-label="Close menu" onClick={() => props.onClose()}>
            <span class="goto-dialog-close-icon" role="img" aria-hidden="true"><CloseIcon /></span>
          </button>
        </div>

        <div class="goto-dialog-tabs">
          <div class="goto-dialog-tablist" role="tablist">
            <button type="button" role="tab" aria-selected={tab() === "date"}
              class={`goto-dialog-tab${tab() === "date" ? " is-selected" : ""}`}
              onClick={() => setTab("date")}>Date</button>
            <button type="button" role="tab" aria-selected={tab() === "customrange"}
              class={`goto-dialog-tab${tab() === "customrange" ? " is-selected" : ""}`}
              onClick={() => setTab("customrange")}>Custom range</button>
            <div class={`goto-dialog-underline is-${tab()}`} />
          </div>
        </div>

        <div class="goto-dialog-content">
            <div class="goto-dialog-body">
              <Show
                when={tab() === "date"}
                fallback={
                  <div class="goto-dialog-row">
                    <label
                      class={"goto-dialog-input-wrap is-date" + (armedField() === "from" ? " is-armed" : "")}
                    >
                      <input class="goto-dialog-input" placeholder="YYYY-MM-DD" value={fromText()}
                        onFocus={() => setArmedField("from")}
                        onKeyPress={onDateKeyPress}
                        onKeyUp={(e) => onDateKeyUp(e, setFromText)}
                        onInput={(e) => setFromText(e.currentTarget.value)} spellcheck={false} />
                      <span class="goto-dialog-input-icon" aria-hidden="true"><CalendarIcon /></span>
                    </label>
                    <label
                      class={"goto-dialog-input-wrap is-date" + (armedField() === "to" ? " is-armed" : "")}
                    >
                      <input class="goto-dialog-input" placeholder="YYYY-MM-DD" value={toText()}
                        onFocus={() => setArmedField("to")}
                        onKeyPress={onDateKeyPress}
                        onKeyUp={(e) => onDateKeyUp(e, setToText)}
                        onInput={(e) => setToText(e.currentTarget.value)} spellcheck={false} />
                      <span class="goto-dialog-input-icon" aria-hidden="true"><CalendarIcon /></span>
                    </label>
                  </div>
                }
              >
                <div class="goto-dialog-row">
                  <label class="goto-dialog-input-wrap is-date">
                    <input class="goto-dialog-input" placeholder="YYYY-MM-DD" value={dateText()}
                      onKeyPress={onDateKeyPress}
                      onKeyUp={(e) => onDateKeyUp(e, setDateText)}
                      onInput={(e) => setDateText(e.currentTarget.value)} spellcheck={false} />
                    <span class="goto-dialog-input-icon" aria-hidden="true"><CalendarIcon /></span>
                  </label>
                  <TimeInput value={timeText()} onChange={setTimeText} />
                </div>
              </Show>

              <div class="goto-dialog-calendar">
                <div class="goto-dialog-cal-header">
                  <button type="button" class="goto-dialog-cal-nav"
                    aria-label={navLabel(-1)}
                    onClick={() => stepNav(-1)}><ChevronLeftIcon /></button>
                  <button type="button" class="goto-dialog-cal-monthbtn"
                    aria-label={calView() === "days" ? "Switch to months view" : "Switch to days view"}
                    aria-expanded={calView() === "months"}
                    onClick={() => setCalView(calView() === "days" ? "months" : "days")}>
                    <span>{calView() === "days" ? monthLabel(viewYear(), viewMonth()) : viewYear()}</span>
                  </button>
                  <button type="button" class="goto-dialog-cal-nav"
                    aria-label={navLabel(1)}
                    onClick={() => stepNav(1)}><ChevronRightIcon /></button>
                </div>

                <Show when={calView() === "days"}>
                  <div class="goto-dialog-cal-sub-header" aria-hidden="true">
                    <For each={WEEKDAYS}>{(w) => <span>{w}</span>}</For>
                  </div>
                </Show>

                <Show when={calView() === "months"}>
                  <div class="goto-dialog-cal-view-months">
                    <For each={MONTHS}>
                      {(m, i) => (
                        <button
                          type="button"
                          tabIndex={-1}
                          class={"goto-dialog-cal-month" + (i() === viewMonth() ? " is-accent" : "")}
                          aria-label={monthLabel(viewYear(), i())}
                          onClick={() => { setViewMonth(i()); setCalView("days"); }}
                        >{m}</button>
                      )}
                    </For>
                  </div>
                </Show>

                <Show when={calView() === "days"}>
                <div class="goto-dialog-cal-view-month">
                  <div class="goto-dialog-cal-weeks">
                    <For each={weeks()}>
                      {(week) => (
                        <div role="row" class="goto-dialog-cal-week">
                          <For each={week}>
                            {(d) => {
                              // Date tab highlights the single pick; Custom
                              // range highlights both endpoints.
                              const isSelected = () =>
                                tab() === "customrange"
                                  ? ymd(d) === fromText() || ymd(d) === toText()
                                  : ymd(d) === ymd(selected());
                              const isToday = ymd(d) === ymd(today);
                              return (
                                <button
                                  type="button"
                                  tabIndex={-1}
                                  data-day={ymd(d)}
                                  aria-label={ariaDay(d)}
                                  aria-selected={isSelected()}
                                  aria-colindex={dowMondayFirst(d) + 1}
                                  class={
                                    "goto-dialog-cal-day" +
                                    (isSelected() ? " is-accent" : "") +
                                    (isToday ? " is-current" : "")
                                  }
                                  role="cell"
                                  onClick={() => pickDay(d)}
                                >{d.getDate()}</button>
                              );
                            }}
                          </For>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
                </Show>
              </div>
            </div>
        </div>

        <div class="goto-dialog-footer">
          <div class="goto-dialog-footer-buttons">
            <button type="button" class="goto-dialog-btn is-secondary" onClick={() => props.onClose()}>
              <span class="goto-dialog-btn-content">Cancel</span>
            </button>
            <span class="goto-dialog-submit-wrap">
              <button type="button" class="goto-dialog-btn is-primary" data-name="submit-button" onClick={submit}>
                <span class="goto-dialog-btn-content">Go to</span>
              </button>
            </span>
          </div>
        </div>
      </div>
    </Portal>
  );
}
