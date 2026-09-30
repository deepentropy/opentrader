/*
 * ScreenBrowserDialog: "Open screen…" of the screen menu, TradingView
 * Desktop 3.4.1 `screener-custom-screens-dialog` (480 × 600): title, search,
 * "My screens" (local saved screens, most recently used first) then "Popular
 * screens" (TV presets with a data source here, title + description). The
 * current screen row is highlighted; "Make a copy" (and "Delete" on saved
 * screens) show on row hover.
 */
import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { Icon } from "../../components/Icon";
import { POPULAR_SCREENS, type Screen } from "../../data/screener-catalog";
import { screenerStore } from "../../data/screener-store";

export function ScreenBrowserDialog(props: { onClose: () => void; onCopy: (screen: Screen) => void }) {
  const [query, setQuery] = createSignal("");
  let input!: HTMLInputElement;

  const match = (title: string) => title.toLowerCase().includes(query().trim().toLowerCase());
  const mine = () => {
    const order = new Map(screenerStore.recentScreens().map((s, i) => [s.id, i] as const));
    return [...screenerStore.savedScreens()]
      .filter((s) => match(s.screen.title))
      .sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9) || b.updatedAt - a.updatedAt);
  };
  const popular = () => POPULAR_SCREENS.filter((p) => match(p.title));
  const isCurrentSaved = (id: string) => screenerStore.savedId() === id;
  const isCurrentPopular = (id: string) => !screenerStore.savedId() && screenerStore.popularId() === id;

  onMount(() => {
    input.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        props.onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    onCleanup(() => document.removeEventListener("keydown", onKey, true));
  });

  const copyButton = (screen: () => Screen) => (
    <button
      type="button"
      class="scr-open-action"
      title="Make a copy"
      aria-label="Make a copy"
      onClick={(e) => {
        e.stopPropagation();
        props.onClose();
        props.onCopy(screen());
      }}
    >
      <Icon name="scr-row-copy" size={18} />
    </button>
  );

  return (
    <Portal mount={document.body}>
      <div class="layout-browser-backdrop" role="presentation" onMouseDown={() => props.onClose()}>
        <div
          class="scr-open"
          role="dialog"
          aria-label="Open screen"
          data-name="screener-custom-screens-dialog"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <header class="scr-open-header">
            <span class="scr-open-title">Open screen</span>
            <button type="button" class="scr-open-close" aria-label="Close menu" onClick={() => props.onClose()}>
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14" width="14" height="14">
                <path stroke="currentColor" stroke-width="1.2" fill="none" d="m1.5 1.5 11 11m0-11-11 11" />
              </svg>
            </button>
          </header>
          <div class="scr-open-search">
            <span class="scr-open-search-icon"><Icon name="scr-search" size={28} /></span>
            <input
              ref={input}
              class="scr-open-input"
              type="text"
              role="searchbox"
              placeholder="Search"
              value={query()}
              spellcheck={false}
              autocomplete="off"
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
          </div>
          <div class="scr-open-list">
            <Show when={mine().length > 0}>
              <div class="scr-open-section">My screens</div>
              <For each={mine()}>
                {(s) => (
                  <div
                    role="option"
                    aria-selected={isCurrentSaved(s.id)}
                    class="scr-open-row"
                    classList={{ selected: isCurrentSaved(s.id) }}
                    onClick={() => {
                      screenerStore.open(s.id);
                      props.onClose();
                    }}
                  >
                    <span class="scr-open-row-title" title={s.screen.title}>{s.screen.title}</span>
                    <span class="scr-open-actions">
                      {copyButton(() => s.screen)}
                      <button
                        type="button"
                        class="scr-open-action"
                        title="Delete"
                        aria-label="Delete"
                        onClick={(e) => {
                          e.stopPropagation();
                          screenerStore.remove(s.id);
                        }}
                      >
                        <Icon name="scr-row-delete" size={18} />
                      </button>
                    </span>
                  </div>
                )}
              </For>
            </Show>
            <Show when={popular().length > 0}>
              <div class="scr-open-section">Popular screens</div>
              <For each={popular()}>
                {(p) => (
                  <div
                    role="option"
                    aria-selected={isCurrentPopular(p.id)}
                    class="scr-open-row with-description"
                    classList={{ selected: isCurrentPopular(p.id) }}
                    onClick={() => {
                      screenerStore.openPopular(p.id);
                      props.onClose();
                    }}
                  >
                    <span class="scr-open-row-text">
                      <span class="scr-open-row-title">{p.title}</span>
                      <span class="scr-open-row-description">{p.description}</span>
                    </span>
                    <span class="scr-open-actions">{copyButton(() => p.screen())}</span>
                  </div>
                )}
              </For>
            </Show>
            <Show when={mine().length === 0 && popular().length === 0}>
              <div class="scr-open-empty">Nothing matches this search</div>
            </Show>
          </div>
        </div>
      </div>
    </Portal>
  );
}
