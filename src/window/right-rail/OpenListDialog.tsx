/*
 * OpenListDialog — the watchlist "Open list…" action: the Watchlists manager
 * (840×638 dialog, left sidebar
 * "My watchlists", a SYMBOLS column, and lists split into "Flagged
 * lists" (those with a colour flag) and "Created lists" (the rest)). Each row
 * leads with a favourite star, then the flag marker + name + an inline rename
 * pencil, and reveals copy / delete on hover. Choosing a row switches lists.
 */
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { FLAG_HEX, WL_ICONS } from "../../data/watchlist";
import { Icon } from "../../components/Icon";
import { watchlistStore, type WatchList } from "../../data/watchlist-store";

type Props = {
  lists: WatchList[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
};

function Marker(props: { list: WatchList }) {
  return (
    <Show
      when={props.list.flag}
      fallback={
        props.list.emoji
          ? <span class="wl-dialog-emoji">{props.list.emoji}</span>
          : <span class="wl-dialog-initial">{props.list.name.charAt(0).toUpperCase()}</span>
      }
    >
      {(f) => <span class="watchlist-menu-flag" style={{ color: FLAG_HEX[f()] }} innerHTML={WL_ICONS.flag} />}
    </Show>
  );
}

export function OpenListDialog(props: Props) {
  const [query, setQuery] = createSignal("");
  // One sidebar tab here ("Hotlists" needs a data source this app lacks).
  const [tab, setTab] = createSignal<"mine">("mine");
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [draft, setDraft] = createSignal("");
  const [confirmingId, setConfirmingId] = createSignal<string | null>(null);
  let input!: HTMLInputElement;

  const filtered = () => {
    const q = query().trim().toLowerCase();
    return q ? props.lists.filter((l) => l.name.toLowerCase().includes(q)) : props.lists;
  };
  // Split by colour flag: flagged (has a flag) vs created (no flag).
  const flagged = () => filtered().filter((l) => l.flag);
  const created = () => filtered().filter((l) => !l.flag);
  const count = (l: WatchList) => l.groups.reduce((n, g) => n + g.rows.length, 0) + l.extras.length;

  onMount(() => {
    input.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (confirmingId()) setConfirmingId(null);
        else if (editingId()) setEditingId(null);
        else props.onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    onCleanup(() => document.removeEventListener("keydown", onKey, true));
  });

  const choose = (id: string) => { props.onSelect(id); props.onClose(); };
  const startRename = (l: WatchList) => { setDraft(l.name); setEditingId(l.id); };
  const commitRename = () => {
    const id = editingId();
    if (id) watchlistStore.renameList(id, draft());
    setEditingId(null);
  };

  const Row = (l: WatchList) => {
    const busy = () => editingId() === l.id || confirmingId() === l.id;
    return (
      <div
        role="option"
        tabindex={0}
        class={`wl-lm-row${l.id === props.activeId ? " active" : ""}`}
        aria-selected={l.id === props.activeId}
        onClick={() => !busy() && choose(l.id)}
        onKeyDown={(e) => { if (e.key === "Enter" && !busy()) choose(l.id); }}
      >
        <Show when={confirmingId() !== l.id} fallback={
          <span class="wl-lm-confirm" onClick={(e) => e.stopPropagation()}>
            <span class="wl-dialog-confirm-text">Delete “{l.name}”?</span>
            <button type="button" class="wl-dialog-confirm-btn wl-dialog-confirm-yes" onClick={() => { watchlistStore.deleteList(l.id); setConfirmingId(null); }}>Delete</button>
            <button type="button" class="wl-dialog-confirm-btn" onClick={() => setConfirmingId(null)}>Cancel</button>
          </span>
        }>
          <button
            type="button"
            class={`wl-lm-star${l.favorite ? " is-on" : ""}`}
            title={l.favorite ? "Remove from favorites" : "Add to favorites"}
            aria-label={l.favorite ? "Remove from favorites" : "Add to favorites"}
            aria-pressed={l.favorite}
            onClick={(e) => { e.stopPropagation(); watchlistStore.toggleFavorite(l.id); }}
          >
            <Icon name={l.favorite ? "draw-remove-from-favorites" : "draw-add-to-favorites"} size={16} />
          </button>
          <span class="wl-lm-marker"><Marker list={l} /></span>
          <Show when={editingId() === l.id} fallback={<span class="wl-lm-name">{l.name}</span>}>
            <input
              class="wl-dialog-rename-input"
              value={draft()}
              onClick={(e) => e.stopPropagation()}
              onInput={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") commitRename(); else if (e.key === "Escape") setEditingId(null); }}
              onBlur={commitRename}
              ref={(el) => queueMicrotask(() => el.focus())}
            />
          </Show>
          <Show when={editingId() !== l.id}>
            <button type="button" class="wl-lm-action wl-lm-rename" title="Rename" aria-label="Rename" onClick={(e) => { e.stopPropagation(); startRename(l); }}>
              <Icon name="menu-manage-layouts-rename" size={16} />
            </button>
          </Show>
          <span class="wl-lm-spacer" />
          <span class="wl-lm-count">{count(l)}</span>
          <span class="wl-lm-actions" onClick={(e) => e.stopPropagation()}>
            <button type="button" class="wl-lm-action" title="Make a copy" aria-label="Make a copy" onClick={() => watchlistStore.copyList(l.id)}>
              <Icon name="wl-copy" size={16} />
            </button>
            <button type="button" class="wl-lm-action wl-lm-action-danger" title="Delete" aria-label="Delete" disabled={props.lists.length <= 1} onClick={() => setConfirmingId(l.id)}>
              <Icon name="draw-trash" size={16} />
            </button>
          </span>
        </Show>
      </div>
    );
  };

  return (
    <Portal mount={document.body}>
      <div class="wl-dialog-backdrop" role="presentation" onMouseDown={() => props.onClose()}>
        <div class="wl-dialog wl-dialog--lists" role="dialog" aria-label="Watchlists" onMouseDown={(e) => e.stopPropagation()}>
          <header class="wl-dialog-header">
            <span class="wl-dialog-title">Watchlists</span>
            <button type="button" class="wl-dialog-close" aria-label="Close" onClick={() => props.onClose()}>
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18">
                <path stroke="currentColor" stroke-width="1.2" fill="none" d="m1.5 1.5 15 15m0-15-15 15" />
              </svg>
            </button>
          </header>
          <div class="wl-dialog-search">
            <input ref={input} class="wl-dialog-input" type="text" placeholder="Search lists" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />
          </div>
          <div class="wl-lm-body">
            <nav class="wl-lm-sidebar" aria-label="Watchlist groups">
              <button type="button" class={`wl-lm-tab${tab() === "mine" ? " active" : ""}`} onClick={() => setTab("mine")}>My watchlists</button>
            </nav>
            <div class="wl-lm-main">
              <Show when={tab() === "mine"}>
                <div class="wl-lm-colhead"><span class="wl-lm-colhead-symbols">Symbols</span></div>
                <div class="wl-lm-list" role="listbox">
                  <Show when={filtered().length} fallback={<div class="wl-dialog-empty">No lists found</div>}>
                    <Show when={flagged().length}>
                      <div class="wl-lm-section">Flagged lists</div>
                      <For each={flagged()}>{Row}</For>
                    </Show>
                    <Show when={created().length}>
                      <div class="wl-lm-section">Created lists</div>
                      <For each={created()}>{Row}</For>
                    </Show>
                  </Show>
                </div>
              </Show>
            </div>
          </div>
        </div>
      </div>
    </Portal>
  );
}
