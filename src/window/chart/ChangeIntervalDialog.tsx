/*
 * ChangeIntervalDialog: the "Change interval" popup dialog. Opened by typing a
 * digit 1-9 on the chart (`initVal` = the digit, caret at the end) and by
 * clicking the legend interval (initVal = the chart interval, selected). The input is upper-cased, max 8 characters; the hint under it is
 * the interval name ("7 minutes") or "Not applicable" (red) when the value is
 * not a valid, supported interval. Enter applies a valid, changed interval and
 * closes; Escape and a click outside close. Centred in the window, no backdrop.
 */
import { createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { Tooltip } from "../../components/Tooltip";
import { longIntervalLabel } from "./interval-favorites";

/** Interval parse / normalize: "<n?><T|S|H|D|W|M|R>" or
 *  "<n>" minutes; an empty number is 1; H = minutes x 60; minutes stay a bare
 *  number, the others keep their letter ("D" → "1D", "2H" → "120"). Null when
 *  invalid. */
export function normalizeInterval(raw: string): string | null {
  const v = raw.toUpperCase().split(",")[0];
  const m = /^(\d*)([TSHDWMR])$/.exec(v);
  const num = (s: string) => (s.length === 0 ? 1 : parseInt(s, 10));
  if (m) {
    const n = num(m[1]);
    if (!(n > 0)) return null;
    if (m[2] === "H") return String(n * 60);
    return `${n}${m[2]}`;
  }
  if (/^\d+$/.test(v)) {
    const n = parseInt(v, 10);
    return n > 0 ? String(n) : null;
  }
  return null;
}

/** Info hint title (the seconds-enabled variant). */
const INFO_TEXT =
  "Type the interval number for minute charts (i.e. 5 if it's going to be a five minute chart). Or number plus letter for other intervals: S for 1 second chart (15S for 15 second chart, etc.), H (Hourly), D (Daily), W (Weekly), M (Monthly) intervals (i.e. D or 2H)";

const INFO_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" fill="none"><path stroke="currentColor" d="M8 8.5h1.5V14"/><circle fill="currentColor" cx="9" cy="5" r="1"/><path stroke="currentColor" d="M16.5 9a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0z"/></svg>';

type Props = {
  initVal: string;
  selectOnInit: boolean;
  /** The chart's current interval (Enter does nothing when unchanged). */
  current: string;
  /** Whether the datafeed serves an interval id (datafeed.isSupportedResolution). */
  isSupported: (id: string) => boolean;
  onApply: (id: string) => void;
  onClose: () => void;
};

export function ChangeIntervalDialog(props: Props) {
  const [value, setValue] = createSignal(props.initVal.toUpperCase());
  let input!: HTMLInputElement;
  let dialog!: HTMLDivElement;
  const normalized = createMemo(() => normalizeInterval(value()));
  const valid = createMemo(() => {
    const n = normalized();
    return n !== null && props.isSupported(n);
  });

  onMount(() => {
    if (props.selectOnInit) input.select();
    else {
      input.focus();
      const end = input.value.length;
      input.setSelectionRange(end, end);
    }
    const onDown = (e: PointerEvent) => {
      if (!dialog.contains(e.target as Node)) props.onClose();
    };
    // Next tick: the press that opened the dialog must not close it.
    const t = window.setTimeout(() => document.addEventListener("pointerdown", onDown, true), 0);
    onCleanup(() => {
      window.clearTimeout(t);
      document.removeEventListener("pointerdown", onDown, true);
    });
  });

  const submit = (e: Event) => {
    e.preventDefault();
    const n = normalized();
    if (n && valid() && n !== props.current) props.onApply(n);
    props.onClose();
  };

  return (
    <Portal mount={document.body}>
      <div
        ref={dialog}
        class="change-interval-dialog"
        role="dialog"
        aria-label="Change interval"
        data-dialog-name="change-interval-dialog"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            props.onClose();
          }
        }}
      >
        <div class="change-interval-inner">
          <div class="change-interval-title-row">
            <div class="change-interval-title">Change interval</div>
            <Tooltip text={INFO_TEXT} side="bottom">
              <span class="change-interval-info" role="img" aria-label={INFO_TEXT} innerHTML={INFO_ICON} />
            </Tooltip>
          </div>
          <form class="change-interval-form" onSubmit={submit}>
            <span class={`change-interval-input-wrap${valid() ? "" : " is-danger"}`}>
              <input
                ref={input}
                class="change-interval-input"
                type="text"
                maxLength={8}
                value={value()}
                onInput={(e) => setValue(e.currentTarget.value.toUpperCase())}
              />
            </span>
          </form>
          <div class={`change-interval-hint${valid() ? "" : " is-error"}`}>
            {valid() ? longIntervalLabel(normalized()!) : "Not applicable"}
          </div>
        </div>
      </div>
    </Portal>
  );
}
