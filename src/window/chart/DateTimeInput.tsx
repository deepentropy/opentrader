/*
 * DateTimeInput — the control of a Pine `input.time` in the study Settings
 * Inputs tab: TradingView draws two controls side by side, a date field with
 * a calendar popup (DatePicker + DateInput) and an HH:MM time field
 * (TimeInput), the value shown in the chart time zone with seconds at 0
 * (research/backtester/design/doc §14.7). The date field follows the Go to
 * dialog's typing rules and calendar (GoToDateDialog helpers); the time
 * field is the Go to dialog's TimeInput.
 */
import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import {
  CalendarIcon,
  ChevronIcon,
  DATE_KEY,
  WEEKDAYS,
  ariaDay,
  dowMondayFirst,
  fixDate,
  monthLabel,
  monthWeeks,
  parseYmd,
  ymd,
} from "../bottom-bar/GoToDateDialog";
import { TimeInput } from "../bottom-bar/TimeInput";
import { timestamp } from "../../backtester/pine";

type Props = {
  /** UNIX ms. */
  value: number;
  timeZone: string;
  onChange: (ms: number) => void;
};

/** Wall date + minutes of a UNIX ms time in a time zone. */
function wall(ms: number, timeZone: string): { date: Date; minutes: number } {
  const p = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(new Date(ms));
  const v = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return { date: new Date(v("year"), v("month") - 1, v("day")), minutes: v("hour") * 60 + v("minute") };
}
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export function DateTimeInput(props: Props) {
  const current = () => wall(props.value, props.timeZone);
  const commit = (date: Date, minutes: number) =>
    props.onChange(timestamp(props.timeZone, date.getFullYear(), date.getMonth() + 1, date.getDate(), Math.floor(minutes / 60), minutes % 60));

  let field!: HTMLLabelElement;
  let input!: HTMLInputElement;
  let pop: HTMLDivElement | undefined;
  const [open, setOpen] = createSignal<DOMRect | null>(null);
  const [view, setView] = createSignal({ y: current().date.getFullYear(), m: current().date.getMonth() });

  const openCalendar = () => {
    const d = parseYmd(input.value) ?? current().date;
    setView({ y: d.getFullYear(), m: d.getMonth() });
    setOpen(field.getBoundingClientRect());
  };
  const commitText = () => {
    const d = parseYmd(input.value);
    if (d) commit(d, current().minutes);
    else input.value = ymd(current().date);
  };
  const step = (dir: -1 | 1) => {
    const v = view();
    const d = new Date(v.y, v.m + dir, 1);
    setView({ y: d.getFullYear(), m: d.getMonth() });
  };

  onMount(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (pop?.contains(t) || field.contains(t)) return;
      setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open()) {
        e.stopPropagation();
        setOpen(null);
      }
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    });
  });

  return (
    <span class="ind3-datetime">
      <label ref={field} class="goto-dialog-input-wrap is-date ind3-date" classList={{ "is-active": !!open() }}>
        <input
          ref={input}
          class="goto-dialog-input"
          placeholder="YYYY-MM-DD"
          value={ymd(current().date)}
          onFocus={openCalendar}
          onKeyPress={(e) => {
            if (e.key.length === 1 && !DATE_KEY.test(e.key)) e.preventDefault();
          }}
          onKeyUp={(e) => {
            if (e.key !== "Backspace") e.currentTarget.value = fixDate(e.currentTarget.value);
            if (e.key === "Enter") {
              commitText();
              setOpen(null);
            }
          }}
          onBlur={commitText}
        />
        <span class="goto-dialog-input-icon" aria-hidden="true" onMouseDown={(e) => { e.preventDefault(); if (open()) setOpen(null); else { input.focus(); openCalendar(); } }}>
          <CalendarIcon />
        </span>
      </label>
      <span class="ind3-time">
        <TimeInput
          value={hhmm(current().minutes)}
          onChange={(v) => {
            const [h, m] = v.split(":").map(Number);
            if (Number.isFinite(h) && Number.isFinite(m)) commit(current().date, h * 60 + m);
          }}
        />
      </span>
      <Show when={open()}>
        {(r) => (
          <Portal>
            <div ref={pop} class="goto-dialog-calendar ind3-calendar" style={{ left: `${r().left}px`, top: `${r().bottom + 4}px` }}>
              <div class="goto-dialog-cal-header">
                <button type="button" class="goto-dialog-cal-nav" aria-label="Previous month" onClick={() => step(-1)}><ChevronIcon /></button>
                <span class="goto-dialog-cal-monthbtn"><span>{monthLabel(view().y, view().m)}</span></span>
                <button type="button" class="goto-dialog-cal-nav is-next" aria-label="Next month" onClick={() => step(1)}><ChevronIcon /></button>
              </div>
              <div class="goto-dialog-cal-sub-header" aria-hidden="true">
                <For each={WEEKDAYS}>{(w) => <span>{w}</span>}</For>
              </div>
              <div class="goto-dialog-cal-view-month">
                <div class="goto-dialog-cal-weeks">
                  <For each={monthWeeks(view().y, view().m)}>
                    {(week) => (
                      <div role="row" class="goto-dialog-cal-week">
                        <For each={week}>
                          {(d) => (
                            <button
                              type="button"
                              tabIndex={-1}
                              role="cell"
                              aria-label={ariaDay(d)}
                              aria-colindex={dowMondayFirst(d) + 1}
                              class={"goto-dialog-cal-day" + (ymd(d) === ymd(current().date) ? " is-accent" : "") + (ymd(d) === ymd(new Date()) ? " is-current" : "")}
                              onClick={() => {
                                commit(d, current().minutes);
                                input.value = ymd(d);
                                setOpen(null);
                              }}
                            >
                              {d.getDate()}
                            </button>
                          )}
                        </For>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </div>
          </Portal>
        )}
      </Show>
    </span>
  );
}
