/*
 * TimeInput — the Go to dialog's time field, a port of the reference app's desktop
 * TimeInput (module 282695, checked live 30/09/2026 in the reference app 3.4.1):
 *
 *   • typing goes through the mask "09:00" (`0930` → `09:30`, max 5 chars);
 *     leaving the field commits it as HH:MM (hours padded left, minutes
 *     padded right, clamped to 23:59);
 *   • focus selects the text and opens a list of times in 15-minute steps
 *     (00:00 … 23:45). The field's own value is marked in the list and, when
 *     it is not on the 15-minute grid, inserted in order (10:07 between 10:00
 *     and 10:15);
 *   • ↑/↓ move the highlighted row (wrapping; the mouse only paints a CSS
 *     hover), Enter or a click commits it and leaves the field;
 *   • the list sits under the field, as wide as it, 231 px high, flipped
 *     above when there is no room below;
 *   • `disabled` (DWM charts): no typing, no list.
 */
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";

// ─── Mask + commit rules ────────────────────────────────────────────────────
/** The reference app's input mask engine (`0` = digit, `9` = optional digit, anything else
 *  = literal). */
const MASK_TOKENS: Record<string, { pattern: RegExp; optional?: boolean }> = {
  "0": { pattern: /\d/ },
  "9": { pattern: /\d/, optional: true },
};
const TIME_MASK = "09:00";
export function applyMask(mask: string, value: string): string {
  const out: string[] = [];
  let i = 0;
  let r = 0;
  let pending: string | undefined;
  while (i < mask.length && r < value.length) {
    const m = mask.charAt(i);
    const ch = value.charAt(r);
    const tok = MASK_TOKENS[m];
    if (tok) {
      if (ch.match(tok.pattern)) {
        out.push(ch);
        i++;
      } else if (ch === pending) {
        pending = undefined;
      } else if (tok.optional) {
        i++;
        r--;
      }
      r++;
    } else {
      out.push(m);
      if (ch === m) r++;
      else pending = m;
      i++;
    }
  }
  const last = mask.charAt(mask.length - 1);
  if (mask.length === value.length + 1 && !MASK_TOKENS[last]) out.push(last);
  return out.join("");
}

/** The reference app commit rule: hours padded left, minutes padded right, then clamped to
 *  00-23 / 00-59 when not a valid HH:MM. */
export function normalizeTime(v: string): string {
  const [h = "", m = ""] = v.split(":");
  const t = `${h.slice(0, 2).padStart(2, "0")}:${m.slice(0, 2).padEnd(2, "0")}`;
  if (/^(0?[0-9]|1[0-9]|2[0-3]):[0-5][0-9]$/.test(t)) return t;
  const [a, b] = t.split(":");
  const hh = Math.min(23, Math.max(0, parseInt(a) || 0));
  const mm = Math.min(59, Math.max(0, parseInt(b) || 0));
  return `${String(hh).padStart(2, "0")}:${String(mm).padEnd(2, "0")}`;
}

/** The 96 list rows, 00:00 … 23:45. */
const GRID: string[] = (() => {
  const out: string[] = [];
  for (let h = 0; h < 24; h++) for (let m = 0; m < 60; m += 15) out.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
  return out;
})();

const LIST_HEIGHT = 231;

type Props = {
  value: string;
  /** Committed HH:MM (leave, Enter, row click). */
  onChange: (v: string) => void;
  /** DWM chart: the reference app disables the time fields (date only). */
  disabled?: boolean;
};

export function TimeInput(props: Props) {
  let wrap!: HTMLLabelElement;
  let input!: HTMLInputElement;
  let list: HTMLDivElement | undefined;
  const [typed, setTyped] = createSignal(props.value);
  const [focused, setFocused] = createSignal(false);
  createEffect(on(() => props.value, (v) => setTyped(v), { defer: true }));

  // The field's value as it would commit; the highlighted row follows it
  // whenever the text or the focus changes.
  const current = createMemo(() => normalizeTime(typed()));
  const [hovered, setHovered] = createSignal(current());
  createEffect(on([current, focused], ([c]) => setHovered(c)));
  const rows = createMemo(() => {
    const c = current();
    if (GRID.includes(c)) return GRID;
    const at = GRID.findIndex((g) => g > c);
    const out = [...GRID];
    out.splice(at < 0 ? out.length : at, 0, c);
    return out;
  });

  const [pos, setPos] = createSignal<{ left: number; top: number; width: number; height: number } | null>(null);
  const place = () => {
    const r = wrap.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const above = r.top;
    let h = LIST_HEIGHT;
    let top = r.bottom;
    if (h > above && h > below) {
      const a = Math.max(0, Math.min(h, above));
      const b = Math.max(0, Math.min(h, below));
      h = Math.max(a, b);
      top = a > b ? r.top - a : r.bottom;
    } else if (h > below) {
      top = r.top - h;
    }
    setPos({ left: r.left, top, width: r.width, height: h });
  };

  /** Keep the highlighted row visible: jump on open / follow the text,
   *  glide on arrow keys. */
  const reveal = (behavior: ScrollBehavior) => {
    const row = list?.querySelector<HTMLElement>(`[data-time="${hovered()}"]`);
    if (!list || !row) return;
    const lr = list.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    // Row to the top of the list (the reference app scrollIntoView). The list scrolls
    // itself only: scrollIntoView would also scroll the dialog body.
    if (lr.top > rr.top || lr.bottom < rr.bottom) list.scrollTo({ top: row.offsetTop, behavior });
  };
  createEffect(on(hovered, (h) => {
    if (focused()) queueMicrotask(() => reveal(h === current() ? "auto" : "smooth"));
  }));

  const commit = (v: string) => {
    const t = normalizeTime(v);
    setTyped(t);
    input.value = t;
    props.onChange(t);
  };

  const onFocus = () => {
    place();
    setFocused(true);
    // The reference app selects the whole text on focus.
    window.setTimeout(() => input.setSelectionRange(0, input.value.length), 0);
    queueMicrotask(() => reveal("auto"));
  };
  const onBlur = () => {
    setFocused(false);
    commit(typed());
  };
  const onInput = (e: InputEvent & { currentTarget: HTMLInputElement }) => {
    const el = e.currentTarget;
    const v = el.value;
    const masked = applyMask(TIME_MASK, v);
    if (masked !== v) {
      const atEnd = el.selectionStart === v.length;
      const p = el.selectionStart ?? masked.length;
      el.value = masked;
      const caret = atEnd ? masked.length : Math.min(p, masked.length);
      el.setSelectionRange(caret, caret);
    }
    setTyped(masked);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const all = rows();
      const step = e.key === "ArrowUp" ? -1 : 1;
      setHovered(all[(all.indexOf(hovered()) + all.length + step) % all.length]);
    } else if (e.key === "Enter") {
      e.preventDefault();
      commit(hovered());
      input.blur();
    }
  };
  const pick = (t: string) => {
    commit(t);
    input.blur();
  };

  return (
    <label ref={wrap} class={"goto-dialog-input-wrap is-time" + (props.disabled ? " is-disabled" : "")}>
      <input
        ref={input}
        class="goto-dialog-input"
        disabled={props.disabled}
        role="combobox"
        aria-expanded={focused()}
        aria-activedescendant={focused() ? `goto-time-${hovered()}` : undefined}
        placeholder="00:00"
        value={typed()}
        maxLength={5}
        autocomplete="off"
        spellcheck={false}
        onFocus={onFocus}
        onBlur={onBlur}
        onInput={onInput}
        onKeyDown={onKeyDown}
      />
      <span class="goto-dialog-input-icon" aria-hidden="true">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28" fill="none">
          <path fill="currentColor" d="M14 3c6.075 0 11 4.925 11 11s-4.925 11-11 11S3 20.075 3 14 7.925 3 14 3m0 1C8.477 4 4 8.477 4 14s4.477 10 10 10 10-4.477 10-10S19.523 4 14 4m1 12h-5v-1h4V8h1z" />
        </svg>
      </span>
      <Show when={focused() && pos()}>
        {(p) => (
          <div
            ref={list}
            class="goto-time-list"
            role="listbox"
            style={{ left: `${p().left}px`, top: `${p().top}px`, width: `${p().width}px`, height: `${p().height}px` }}
            // Keep the focus in the field while a row is pressed.
            onMouseDown={(e) => e.preventDefault()}
          >
            <div class="goto-time-list-box">
              <For each={rows()}>
                {(t) => (
                  <div
                    id={`goto-time-${t}`}
                    data-time={t}
                    role="option"
                    aria-selected={t === current()}
                    class={
                      "goto-time-item" + (t === current() ? " is-active" : "") + (t === hovered() ? " is-hovered" : "")
                    }
                    onClick={() => pick(t)}
                  >
                    {t}
                  </div>
                )}
              </For>
            </div>
          </div>
        )}
      </Show>
    </label>
  );
}
