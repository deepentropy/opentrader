/*
 * Keyboard shortcuts (#335): opened from the account menu or with Ctrl + /.
 * As in the reference app, a panel over the window's end side, under the
 * title bar, resized by the grip on its start edge (350 px at least): a title,
 * a "Find shortcut" field and one folding section per area (shortcut-list.ts).
 * Typing in the field shows the matching shortcuts of every section.
 * Esc or the close button closes it.
 */
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { translate } from "../../i18n/translator";
import { SHORTCUT_SECTIONS, type Combo, type Shortcut, type ShortcutSection } from "./shortcut-list";
import { isTauri } from "./window-bridge";

const MIN_WIDTH = 350;
/** Share of the window the panel opens with (1060 px of a 1920 px window). */
const START_SHARE = 0.55;

/** The shortcuts this build answers (no windows, app zoom or Exit in a browser). */
function sections(): ShortcutSection[] {
  const desktop = isTauri();
  return SHORTCUT_SECTIONS.map((s) => ({ ...s, items: s.items.filter((i) => desktop || !i.desktop) }));
}

/** Matches the query, in English or in the shown language. */
function matches(item: Shortcut, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return item.label.toLowerCase().includes(q) || translate(item.label).toLowerCase().includes(q);
}

function Keys(props: { combo: Combo }) {
  return (
    <Show when={"keys" in props.combo ? props.combo.keys : null} fallback={<span class="kbs-text">{(props.combo as { text: string }).text}</span>}>
      {(keys) => (
        <For each={keys()}>
          {(key, i) => (
            <>
              <Show when={i() > 0}><span class="kbs-text" aria-hidden="true">+</span></Show>
              <kbd class="kbs-key" data-no-translate>{key}</kbd>
            </>
          )}
        </For>
      )}
    </Show>
  );
}

function Row(props: { item: Shortcut }) {
  return (
    <li class="kbs-row">
      <span class="kbs-label">
        {props.item.label}
        <Show when={props.item.note}>
          {(note) => (
            <Tooltip text={note()} side="top">
              <span class="kbs-note" tabindex="0" aria-label={note()}><Icon name="st-settings-info" size={18} /></span>
            </Tooltip>
          )}
        </Show>
      </span>
      <span class="kbs-keys">
        <For each={props.item.combos}>
          {(combo, i) => (
            <>
              <Show when={i() > 0}><span class="kbs-text">or</span></Show>
              <Keys combo={combo} />
            </>
          )}
        </For>
      </span>
    </li>
  );
}

export function KeyboardShortcutsPanel(props: { onClose: () => void }) {
  let input!: HTMLInputElement;
  const [query, setQuery] = createSignal("");
  const [open, setOpen] = createSignal<Set<string>>(new Set());
  const [width, setWidth] = createSignal(Math.max(MIN_WIDTH, Math.round(window.innerWidth * START_SHARE)));
  // Under the title bar, as the reference panel sits under its title bar.
  const top = () => Math.round(document.querySelector(".tab-bar")?.getBoundingClientRect().bottom ?? 0);

  const shown = createMemo(() =>
    sections()
      .map((s) => ({ ...s, items: s.items.filter((i) => matches(i, query())) }))
      .filter((s) => s.items.length > 0),
  );
  const searching = () => query().trim() !== "";
  const isOpen = (id: string) => searching() || open().has(id);
  const toggle = (id: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  onMount(() => {
    input.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });

  // The grip: the panel's start edge follows the pointer.
  const startResize = (e: PointerEvent) => {
    e.preventDefault();
    const grip = e.currentTarget as HTMLElement;
    grip.setPointerCapture(e.pointerId);
    const rtl = document.documentElement.dir === "rtl";
    const move = (ev: PointerEvent) => {
      const w = rtl ? ev.clientX : window.innerWidth - ev.clientX;
      setWidth(Math.round(Math.min(window.innerWidth, Math.max(MIN_WIDTH, w))));
    };
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
  };

  return (
    <div
      class="kbs-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="kbs-title"
      style={{ top: `${top()}px`, width: `${width()}px` }}
    >
      <div class="kbs-grip" onPointerDown={startResize} aria-hidden="true"><span class="kbs-grip-bar" /></div>
      <button type="button" class="kbs-close" aria-label="Close" onClick={() => props.onClose()}>
        <Icon name="scr-panel-close" size={28} />
      </button>
      <div class="kbs-scroll">
        <div class="kbs-content">
          <h1 id="kbs-title" class="kbs-title">Keyboard shortcuts</h1>
          <p class="kbs-intro">Shortcuts save time on the chart, the watchlist, the trading panel and the tabs.</p>
          <label class="kbs-search">
            <Icon name="scr-search" size={28} />
            <input
              ref={input}
              type="text"
              placeholder="Find shortcut"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
          </label>
          <Show when={shown().length > 0} fallback={<p class="kbs-empty">No shortcuts found</p>}>
            <For each={shown()}>
              {(s) => (
                <section class={`kbs-section${isOpen(s.id) ? " is-open" : ""}`}>
                  <button
                    type="button"
                    class="kbs-section-head"
                    aria-expanded={isOpen(s.id)}
                    disabled={searching()}
                    onClick={() => toggle(s.id)}
                  >
                    <span class="kbs-section-icon"><Icon name={s.icon} size={28} /></span>
                    <h2 class="kbs-section-title">{s.title}</h2>
                    <span class="kbs-chevron" aria-hidden="true"><Icon name="st-pill-chevron-down" size={18} /></span>
                  </button>
                  <Show when={isOpen(s.id)}>
                    <ul class="kbs-rows">
                      <For each={s.items}>{(item) => <Row item={item} />}</For>
                    </ul>
                  </Show>
                </section>
              )}
            </For>
          </Show>
        </div>
      </div>
    </div>
  );
}
