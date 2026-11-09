/*
 * ScreenBrowserDialog: "Open screen…" of the screen menu, the reference app
 * Desktop 3.4.1 `screener-custom-screens-dialog` (480 × 600): title, search,
 * "My screens" (local saved screens, most recently used first) then "Popular
 * screens" (the reference app presets with a data source here, title + description). The
 * current screen row is highlighted; "Make a copy" (and "Delete" on saved
 * screens) show on row hover.
 */
import { leaveScreen } from "./leave-screen";
import { For, Show, createSignal, onMount } from "solid-js";
import { Icon } from "../../components/Icon";
import { popularScreens, type Screen } from "../../data/screener-catalog";
import { screenerStore } from "../../data/screener-store";
import { Dialog } from "../../components/Dialog";

export function ScreenBrowserDialog(props: { onClose: () => void; onCopy: (screen: Screen) => void }) {
  const [query, setQuery] = createSignal("");
  let input!: HTMLInputElement;

  const match = (title: string) => title.toLowerCase().includes(query().trim().toLowerCase());
  const mine = () => {
    const order = new Map(screenerStore.recentScreens().map((s, i) => [s.id, i] as const));
    return [...screenerStore.typeScreens()]
      .filter((s) => match(s.screen.title))
      .sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9) || b.updatedAt - a.updatedAt);
  };
  const popular = () => popularScreens(screenerStore.type()).filter((p) => match(p.title));
  const isCurrentSaved = (id: string) => screenerStore.savedId() === id;
  const isCurrentPopular = (id: string) => !screenerStore.savedId() && screenerStore.popularId() === id;

  onMount(() => input.focus());

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
    <Dialog
      look="screen-browser"
      layerClass="layout-browser-backdrop"
      backdrop="close"
      class="scr-open"
      data-name="screener-custom-screens-dialog"
      title="Open screen"
      onClose={props.onClose}
      keys={{ target: "document" }}
    >
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
                  props.onClose();
                  leaveScreen(() => screenerStore.open(s.id));
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
                  props.onClose();
                  leaveScreen(() => screenerStore.openPopular(p.id));
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
    </Dialog>
  );
}
