/*
 * Emoji button of a name field (reference app's input with an emoji select):
 * the field shows the name without its leading emoji; the button at its start
 * shows that emoji (a smiley when none) and opens the emoji picker below it
 * (tabs of the groups over one scrolling list, the first group the recently
 * used emojis led by "Remove selected emoji").
 */
import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import * as kv from "../data/kv";
import { Tooltip } from "./Tooltip";
import { EMOJI_GROUPS } from "./emoji-groups";
import { EmojiImage } from "./emoji-images";

export { separateEmoji } from "./emoji-images";

/** Recently used emojis kept (reference app). */
export const MAX_RECENTLY_USED = 18;
const RECENT_KEY = "ot:emoji:recently-used";


function readRecent(current: string): string[] {
  try {
    const v = JSON.parse(kv.getItem(RECENT_KEY) ?? "null");
    if (Array.isArray(v)) return v.filter((e): e is string => typeof e === "string" && e !== "");
  } catch {
    /* default below */
  }
  return current ? [current] : [];
}

/** Smiley of the empty button. */
const AddEmojiIcon = () => (
  <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
    <circle cx="9" cy="9" r="7.5" fill="none" stroke="currentColor" />
    <circle cx="6.75" cy="7.25" r="1" fill="currentColor" />
    <circle cx="11.25" cy="7.25" r="1" fill="currentColor" />
    <path d="M5.9 10.4a3.4 3.4 0 0 0 6.2 0" fill="none" stroke="currentColor" />
  </svg>
);

/** "Remove selected emoji": a slashed circle. */
const NoEmojiIcon = () => (
  <svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true">
    <circle cx="14" cy="14" r="9" fill="none" stroke="currentColor" />
    <path d="M7.6 7.6l12.8 12.8" stroke="currentColor" />
  </svg>
);

/** Tab icons: recently used, then one per group. */
const TAB_ICONS: Record<string, () => ReturnType<typeof AddEmojiIcon>> = {
  recent: () => (
    <svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true">
      <circle cx="14" cy="14" r="8.5" fill="none" stroke="currentColor" />
      <path d="M13.5 9v5.5h4.5" fill="none" stroke="currentColor" />
    </svg>
  ),
  smileys: () => (
    <svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true">
      <circle cx="14" cy="14" r="8.5" fill="none" stroke="currentColor" />
      <circle cx="11.5" cy="12.5" r="1" fill="currentColor" />
      <circle cx="16.5" cy="12.5" r="1" fill="currentColor" />
      <path d="M10.2 16.2a4.4 4.4 0 0 0 7.6 0" fill="none" stroke="currentColor" />
    </svg>
  ),
  animals: () => (
    <svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true">
      <g fill="none" stroke="currentColor">
        <ellipse cx="14" cy="17.5" rx="4.5" ry="4" />
        <ellipse cx="8" cy="12.5" rx="1.8" ry="2.3" />
        <ellipse cx="20" cy="12.5" rx="1.8" ry="2.3" />
        <ellipse cx="11.5" cy="8" rx="1.8" ry="2.3" />
        <ellipse cx="16.5" cy="8" rx="1.8" ry="2.3" />
      </g>
    </svg>
  ),
  food: () => (
    <svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true">
      <g fill="none" stroke="currentColor">
        <path d="M6.5 13.5h15a7.5 7.5 0 0 1-15 0z" />
        <path d="M14 13.5V7.5M14 7.5l3-2" />
      </g>
    </svg>
  ),
  activity: () => (
    <svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true">
      <g fill="none" stroke="currentColor">
        <circle cx="14" cy="14" r="8.5" />
        <path d="M14 5.5v17M5.5 14h17M8 8c3 2.5 3 9.5 0 12M20 8c-3 2.5-3 9.5 0 12" />
      </g>
    </svg>
  ),
  travel: () => (
    <svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true">
      <g fill="none" stroke="currentColor" stroke-linejoin="round">
        <path d="M21.5 6.5c-4.5.3-8 2.6-10 6.5l3.5 3.5c3.9-2 6.2-5.5 6.5-10z" />
        <path d="M11.5 13l-3.5.5-2 2.5 3.5.5M15 16.5l-.5 3.5-2.5 2-.5-3.5M9.5 18.5l-3 3" />
        <circle cx="17" cy="11" r="1.5" />
      </g>
    </svg>
  ),
  objects: () => (
    <svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true">
      <g fill="none" stroke="currentColor">
        <path d="M11 18.5a6.5 6.5 0 1 1 6 0v2.5h-6z" />
        <path d="M11.5 23.5h5M14 21v-6" />
      </g>
    </svg>
  ),
  symbols: () => (
    <svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true">
      <path d="M14 21.5l-7-7a4.3 4.3 0 0 1 7-5 4.3 4.3 0 0 1 7 5z" fill="none" stroke="currentColor" stroke-linejoin="round" />
    </svg>
  ),
  flags: () => (
    <svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true">
      <path d="M8.5 23.5v-17M8.5 7c3-1.3 5 .3 7.5.5 1.6.1 3-.4 3.5-.6v8.6c-.5.2-1.9.7-3.5.6-2.5-.2-4.5-1.8-7.5-.5" fill="none" stroke="currentColor" />
    </svg>
  ),
};

type Group = { id: string; title: string; emojis: string[] };
const GROUPS: Group[] = EMOJI_GROUPS.map((g) => ({ id: g.id, title: g.title, emojis: g.emojis.split(" ") }));

/** The emoji button at the start of a name field and its picker. `emoji` is
 *  the name's leading emoji ("" for none); picking "" removes it. */
export function EmojiSelect(props: { emoji: string; onSelect: (emoji: string) => void; onOpenChange?: (open: boolean) => void; onClose?: () => void }) {
  const [open, setOpen] = createSignal(false);
  const [recent, setRecent] = createSignal(readRecent(props.emoji));
  let wrap!: HTMLSpanElement;
  const close = () => {
    if (!open()) return;
    setOpen(false);
    props.onOpenChange?.(false);
    props.onClose?.();
  };
  const toggle = () => {
    if (open()) return close();
    setOpen(true);
    props.onOpenChange?.(true);
  };
  const select = (e: string) => {
    if (e !== "") {
      const next = Array.from(new Set([e, ...recent()])).slice(0, MAX_RECENTLY_USED);
      kv.setItem(RECENT_KEY, JSON.stringify(next));
      setRecent(next);
    }
    props.onSelect(e);
    close();
  };
  return (
    <span ref={wrap} class="ot-emoji-select">
      <Tooltip text="Add emoji" side="top">
        <button
          type="button"
          class="ot-emoji-select-btn"
          classList={{ "is-open": open() }}
          aria-label="Add emoji"
          aria-haspopup="menu"
          aria-expanded={open()}
          data-name="emoji-picker"
          onMouseDown={(e) => e.preventDefault()}
          onClick={toggle}
        >
          <Show when={props.emoji} fallback={<AddEmojiIcon />}>
            <EmojiImage emoji={props.emoji} size={18} class="ot-emoji-select-glyph" />
          </Show>
        </button>
      </Tooltip>
      <Show when={open()}>
        <EmojiPicker anchor={wrap} recent={["", ...recent()].slice(0, MAX_RECENTLY_USED)} onSelect={select} onClose={close} />
      </Show>
    </span>
  );
}

/** The picker popup under `anchor`: the group tabs over one scrolling list. */
function EmojiPicker(props: { anchor: HTMLElement; recent: string[]; onSelect: (emoji: string) => void; onClose: () => void }) {
  const groups = (): Group[] => [{ id: "recent", title: "Recently used", emojis: props.recent }, ...GROUPS];
  const [active, setActive] = createSignal("recent");
  let box!: HTMLDivElement;
  let list!: HTMLDivElement;
  const titles = new Map<string, HTMLDivElement>();
  const r = props.anchor.getBoundingClientRect();
  const W = 354;
  const H = 330;
  const left = Math.max(0, Math.min(r.left, window.innerWidth - W));
  const top = r.bottom + H <= window.innerHeight ? r.bottom : Math.max(0, r.top - H);
  // Scrolling marks the group at the top of the list; a tab click scrolls to its group.
  let jumping = false;
  const onScroll = () => {
    if (jumping) return;
    let id = "recent";
    for (const g of groups()) {
      const t = titles.get(g.id);
      if (t && t.offsetTop <= list.scrollTop + 1) id = g.id;
    }
    setActive(id);
  };
  const jump = (id: string) => {
    setActive(id);
    const t = titles.get(id);
    if (!t) return;
    jumping = true;
    list.scrollTop = t.offsetTop;
    requestAnimationFrame(() => (jumping = false));
  };
  onMount(() => {
    box.focus({ preventScroll: true });
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!box.contains(t) && !props.anchor.contains(t)) props.onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
    };
    // Scrolling the page (not the list) closes it.
    const scroll = (e: Event) => {
      if (!box.contains(e.target as Node)) props.onClose();
    };
    document.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("scroll", scroll, true);
    onCleanup(() => {
      document.removeEventListener("mousedown", down, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", scroll, true);
    });
  });
  return (
    <Portal mount={document.body}>
      <div
        ref={box}
        class="ot-emoji-picker"
        role="menu"
        tabIndex={-1}
        data-qa-id="emojipicker-menu"
        style={{ left: `${left}px`, top: `${top}px` }}
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div class="ot-emoji-tabs">
          <For each={groups()}>
            {(g) => (
              <button type="button" class="ot-emoji-tab" classList={{ "is-active": active() === g.id }} aria-label={g.title} onClick={() => jump(g.id)}>
                <span class="ot-emoji-tab-icon">{TAB_ICONS[g.id]?.()}</span>
              </button>
            )}
          </For>
        </div>
        <div ref={list} class="ot-emoji-list" onScroll={onScroll}>
          <For each={groups()}>
            {(g) => (
              <>
                <div ref={(el) => titles.set(g.id, el)} class="ot-emoji-group-title">{g.title}</div>
                <div class="ot-emoji-grid">
                  <For each={g.emojis}>
                    {(e) =>
                      e === "" ? (
                        <Tooltip text="Remove selected emoji" side="top">
                          <button type="button" class="ot-emoji-cell is-clear" aria-label="Remove selected emoji" onClick={() => props.onSelect("")}>
                            <NoEmojiIcon />
                          </button>
                        </Tooltip>
                      ) : (
                        <button type="button" class="ot-emoji-cell" aria-label={e} onClick={() => props.onSelect(e)}>
                          <EmojiImage emoji={e} size={24} />
                        </button>
                      )
                    }
                  </For>
                </div>
              </>
            )}
          </For>
        </div>
      </div>
    </Portal>
  );
}
