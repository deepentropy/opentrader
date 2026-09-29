/*
 * LayoutBrowserDialog — the "Open layout" action in the header "Manage layouts"
 * dropdown (hotkey "."). A modal picker over every saved chart layout with a
 * search filter; choosing one loads it into the active tab. Each row also
 * exposes a delete (trash) affordance, so this doubles as the layout manager.
 *
 * Local stand-in for TV's cloud layout-manager window — see data/layout-store.ts
 * for the persistence model. Mirrors the watchlist OpenListDialog pattern.
 */
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { SavedLayout } from "../../data/layout-store";

type Props = {
  layouts: SavedLayout[];
  activeId?: string;
  /** "SYMBOL, INTERVAL" summary of a layout's focused pane. */
  summaryOf: (l: SavedLayout) => string;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  /** Star / unstar a layout (header favorite circles). */
  onToggleFavorite: (id: string) => void;
  onClose: () => void;
};

/** Coarse "x ago" label from an epoch-ms timestamp (no external dep). */
function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30);
  return mo < 12 ? `${mo}mo ago` : `${Math.round(mo / 12)}y ago`;
}

export function LayoutBrowserDialog(props: Props) {
  const [query, setQuery] = createSignal("");
  let input!: HTMLInputElement;

  const filtered = () => {
    const q = query().trim().toLowerCase();
    const sorted = [...props.layouts].sort((a, b) => b.updatedAt - a.updatedAt);
    if (!q) return sorted;
    return sorted.filter(
      (l) => l.name.toLowerCase().includes(q) || props.summaryOf(l).toLowerCase().includes(q),
    );
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

  const choose = (id: string) => {
    props.onOpen(id);
    props.onClose();
  };

  return (
    <Portal mount={document.body}>
      <div class="layout-browser-backdrop" role="presentation" onMouseDown={() => props.onClose()}>
        <div class="layout-browser" role="dialog" aria-label="Open layout" onMouseDown={(e) => e.stopPropagation()}>
          <header class="layout-browser-header">
            <span class="layout-browser-title">Open layout</span>
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
              placeholder="Search layouts"
              value={query()}
              spellcheck={false}
              autocomplete="off"
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
          </div>
          <div class="layout-browser-list" role="listbox">
            <For
              each={filtered()}
              fallback={
                <div class="layout-browser-empty">
                  {props.layouts.length ? "No layouts found" : "No saved layouts yet"}
                </div>
              }
            >
              {(l) => (
                <div
                  role="option"
                  aria-selected={l.id === props.activeId}
                  class={`layout-browser-row${l.id === props.activeId ? " active" : ""}`}
                >
                  {/* TV load-layout dialog: star cell at the row start, shown
                      on row hover, kept (filled) when favorited. Icons are
                      TV's 18px star paths (desktop 3.4.1, 23/09/2026). */}
                  <button
                    type="button"
                    class={`layout-browser-row-favorite${l.favorite ? " is-favorite" : ""}`}
                    data-name="list-item-favorite-button"
                    aria-label={l.favorite ? "Remove from favorites" : "Add to favorites"}
                    title={l.favorite ? "Remove from favorites" : "Add to favorites"}
                    onClick={() => props.onToggleFavorite(l.id)}
                  >
                    <Show
                      when={l.favorite}
                      fallback={
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" fill="none">
                          <path stroke="currentColor" d="M9 2.13l1.903 3.855.116.236.26.038 4.255.618-3.079 3.001-.188.184.044.259.727 4.237-3.805-2L9 12.434l-.233.122-3.805 2.001.727-4.237.044-.26-.188-.183-3.079-3.001 4.255-.618.26-.038.116-.236L9 2.13z" />
                        </svg>
                      }
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" fill="none">
                        <path fill="currentColor" d="M9 1l2.35 4.76 5.26.77-3.8 3.7.9 5.24L9 13l-4.7 2.47.9-5.23-3.8-3.71 5.25-.77L9 1z" />
                      </svg>
                    </Show>
                  </button>
                  <button type="button" class="layout-browser-row-main" onClick={() => choose(l.id)}>
                    <span class="layout-browser-row-marker">{l.name.charAt(0).toUpperCase()}</span>
                    <span class="layout-browser-row-text">
                      <span class="layout-browser-row-name">{l.name}</span>
                      <span class="layout-browser-row-sub">
                        {props.summaryOf(l)} · {timeAgo(l.updatedAt)}
                      </span>
                    </span>
                    <Show when={l.id === props.activeId}>
                      <span class="layout-browser-row-current">Current</span>
                    </Show>
                  </button>
                  <button
                    type="button"
                    class="layout-browser-row-delete"
                    aria-label={`Delete ${l.name}`}
                    title="Delete layout"
                    onClick={() => props.onDelete(l.id)}
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
