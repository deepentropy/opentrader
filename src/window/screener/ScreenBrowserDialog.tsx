/*
 * ScreenBrowserDialog: "Open screen…" of the screen menu: every local saved
 * screen with a search filter; a row opens the screen, the trash deletes it.
 * Same modal as the "Open layout" dialog (layout-browser styles).
 */
import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { screenerStore } from "../../data/screener-store";
import { isActive } from "../../data/screener-query";

/** dd/mm/yyyy of an epoch-ms time. */
function ddmmyyyy(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

export function ScreenBrowserDialog(props: { onClose: () => void }) {
  const [query, setQuery] = createSignal("");
  let input!: HTMLInputElement;

  const filtered = () => {
    const q = query().trim().toLowerCase();
    const list = [...screenerStore.savedScreens()].sort((a, b) => b.updatedAt - a.updatedAt);
    return q ? list.filter((s) => s.screen.title.toLowerCase().includes(q)) : list;
  };

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

  return (
    <Portal mount={document.body}>
      <div class="layout-browser-backdrop" role="presentation" onMouseDown={() => props.onClose()}>
        <div class="layout-browser" role="dialog" aria-label="Open screen" onMouseDown={(e) => e.stopPropagation()}>
          <header class="layout-browser-header">
            <span class="layout-browser-title">Open screen</span>
            <button type="button" class="layout-browser-close" aria-label="Close" onClick={() => props.onClose()}>
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18">
                <path stroke="currentColor" stroke-width="1.2" fill="none" d="m1.5 1.5 15 15m0-15-15 15" />
              </svg>
            </button>
          </header>
          <div class="layout-browser-search">
            <input
              ref={input}
              class="layout-browser-input"
              type="text"
              placeholder="Search"
              value={query()}
              spellcheck={false}
              autocomplete="off"
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
          </div>
          <div class="layout-browser-list" role="listbox">
            <For
              each={filtered()}
              fallback={<div class="layout-browser-empty">{screenerStore.savedScreens().length ? "Nothing matches this search" : "No saved screens yet"}</div>}
            >
              {(s) => (
                <div role="option" aria-selected={s.id === screenerStore.savedId()} class={`layout-browser-row${s.id === screenerStore.savedId() ? " active" : ""}`}>
                  <button
                    type="button"
                    class="layout-browser-row-main"
                    onClick={() => {
                      screenerStore.open(s.id);
                      props.onClose();
                    }}
                  >
                    <span class="layout-browser-row-marker">{s.screen.title.charAt(0).toUpperCase()}</span>
                    <span class="layout-browser-row-text">
                      <span class="layout-browser-row-name">{s.screen.title}</span>
                      <span class="layout-browser-row-sub">
                        {s.screen.filters.filter(isActive).length} filters · {ddmmyyyy(s.updatedAt)}
                      </span>
                    </span>
                    <Show when={s.id === screenerStore.savedId()}>
                      <span class="layout-browser-row-current">Current</span>
                    </Show>
                  </button>
                  <button
                    type="button"
                    class="layout-browser-row-delete"
                    aria-label={`Delete ${s.screen.title}`}
                    title="Delete screen"
                    onClick={() => screenerStore.remove(s.id)}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="16" height="16">
                      <path
                        fill="currentColor"
                        d="M7 2h4l.5 1H15v1H3V3h3.5L7 2zM4 5h10l-.8 10.1A2 2 0 0 1 11.2 17H6.8a2 2 0 0 1-2-1.9L4 5zm2.5 2 .3 8h1l-.3-8h-1zm3.7 0-.3 8h1l.3-8h-1z"
                      />
                    </svg>
                  </button>
                </div>
              )}
            </For>
          </div>
        </div>
      </div>
    </Portal>
  );
}
