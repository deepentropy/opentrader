/*
 * WatchlistMenu — the dropdown opened from the watchlists ("Strong ▾") button.
 * Solid port of the reference mock: list actions · Create/
 * Upload · Recently-used saved lists · Open list.
 *
 * Every row is wired to the multi-list store via props: the recently-used list,
 * Create / Make a copy / Rename / Add section / Clear / Upload, plus Add alert
 * (local price-move alert) and Open list
 * (picker). "Add alert on the list…" is the only row with no real backend
 * equivalent beyond the local stand-in.
 */
import { For, onCleanup, onMount, Show } from "solid-js";
import {
  FLAG_HEX,
  WL_ICONS,
  WL_MENU_GROUPS,
  type FlagColor,
  type WlMenuAction,
} from "../../data/watchlist";
import { Icon } from "../../components/Icon";
import { isDeletedList, watchlistStore, type WatchList } from "../../data/watchlist-store";

type Props = {
  /** All saved lists + which one is active (drives the "Recently used" group). */
  lists: WatchList[];
  activeId: string;
  onSelectList: (id: string) => void;
  onClose: () => void;
  /** "Rename" — start an inline rename of the active list (header title). */
  onRenameList?: () => void;
  /** "Add section" — append a new, immediately-editable section. */
  onAddSection?: () => void;
  /** "Clear list" — remove every symbol from the active list. */
  onClearList?: () => void;
  /** "Create new list…" — make a new empty list and switch to it. */
  onCreateList?: () => void;
  /** "Make a copy…" — duplicate the active list. */
  onCopyList?: () => void;
  /** "Upload list…" — import symbols from a text file. */
  onUploadList?: () => void;
  /** "Add alert on the list…" — open the alert-threshold dialog. */
  onAddAlert?: () => void;
  /** "Open list…" — open the list picker. */
  onOpenList?: () => void;
  /** Action rows (their `value`) shown disabled. */
  disabled?: string[];
};

type ActionHandlerKey =
  | "onRenameList"
  | "onAddSection"
  | "onClearList"
  | "onCreateList"
  | "onCopyList"
  | "onUploadList"
  | "onAddAlert"
  | "onOpenList";

/** Action rows and their handlers. */
const ACTION_HANDLERS: Record<string, ActionHandlerKey> = {
  rename: "onRenameList",
  "add-section": "onAddSection",
  "clear-list": "onClearList",
  "create-list": "onCreateList",
  "make-copy": "onCopyList",
  "upload-list": "onUploadList",
  "add-alert": "onAddAlert",
  "open-list": "onOpenList",
};

/** A list's menu marker — colour flag, else emoji, else its initial letter. */
function ListMarker(props: { flag: FlagColor | null; emoji: string | null; name: string }) {
  return (
    <Show
      when={props.flag}
      fallback={
        props.emoji
          ? <span class="watchlist-menu-emoji">{props.emoji}</span>
          : <span class="watchlist-menu-initial">{props.name.charAt(0).toUpperCase()}</span>
      }
    >
      {(flag) => <span class="watchlist-menu-flag" style={{ color: FLAG_HEX[flag()] }} innerHTML={WL_ICONS.flag} />}
    </Show>
  );
}

export function WatchlistMenu(props: Props) {
  let root!: HTMLDivElement;

  onMount(() => {
    // Outside-click / Esc dismiss; ignore the trigger button (it toggles itself).
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element;
      if (root.contains(t) || t.closest?.('[data-name="watchlists-button"]')) return;
      props.onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") props.onClose(); };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    });
  });

  const renderAction = (a: WlMenuAction) => (
    <button
      type="button"
      role="menuitem"
      class="ot-menu-item"
      classList={{ "ot-menu-item--disabled": !!props.disabled?.includes(a.value) }}
      aria-disabled={props.disabled?.includes(a.value) ? "true" : undefined}
      data-value={a.value}
      onClick={() => {
        if (props.disabled?.includes(a.value)) return;
        const handlerKey = ACTION_HANDLERS[a.value];
        if (handlerKey) props[handlerKey]?.();
        props.onClose();
      }}
    >
      <span class="ot-menu-item__icon" aria-hidden="true">
        <Show when={a.icon}>{(icon) => <span innerHTML={icon()} />}</Show>
      </span>
      <span class="ot-menu-item__label apply-overflow-tooltip">{a.label}</span>
      <Show when={a.shortcut}><span class="ot-menu-item__hotkey">{a.shortcut}</span></Show>
    </button>
  );

  // The recently opened lists, newest first, among the lists shown in menus
  // (the per-row star toggles the store's persisted `favorite` flag, shared
  // with the Watchlists manager + the quick-switch bar). The section is
  // hidden while empty. "Deleted symbols" is listed with no star.
  const recentLists = () => watchlistStore.recentLists().filter((l) => props.lists.some((x) => x.id === l.id));
  const groups = () => WL_MENU_GROUPS.filter((g) => !g.recentlyUsed || recentLists().length > 0);

  return (
    <div ref={root} class="ot-popover watchlist-menu" role="menu" aria-label="Watchlists">
      <For each={groups()}>
        {(g, gi) => (
          <>
            <Show when={gi() > 0}><div class="ot-popover__divider" /></Show>
            <Show
              when={g.recentlyUsed}
              fallback={<For each={g.actions!}>{(a) => renderAction(a)}</For>}
            >
              <div class="watchlist-menu-section">Recently used</div>
              <For each={recentLists()}>
                {(t) => (
                  <button
                    type="button"
                    role="menuitem"
                    class={`ot-menu-item${t.id === props.activeId ? " ot-menu-item--current" : ""}`}
                    onClick={() => { props.onSelectList(t.id); props.onClose(); }}
                  >
                    <span class="ot-menu-item__icon" aria-hidden="true">
                      <ListMarker flag={t.flag} emoji={t.emoji} name={t.name} />
                    </span>
                    <span class="ot-menu-item__label apply-overflow-tooltip">{t.name}</span>
                    <Show when={!isDeletedList(t.id)}>
                    <span
                      role="button"
                      tabIndex={0}
                      class={`watchlist-menu-star${t.favorite ? " is-on" : ""}`}
                      title={t.favorite ? "Remove from favorites" : "Add to favorites"}
                      aria-label={t.favorite ? "Remove from favorites" : "Add to favorites"}
                      aria-pressed={t.favorite}
                      onClick={(e) => {
                        e.stopPropagation();
                        watchlistStore.toggleFavorite(t.id);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          e.stopPropagation();
                          watchlistStore.toggleFavorite(t.id);
                        }
                      }}
                    >
                      <Icon
                        name={t.favorite ? "draw-remove-from-favorites" : "draw-add-to-favorites"}
                        size={18}
                      />
                    </span>
                    </Show>
                  </button>
                )}
              </For>
            </Show>
          </>
        )}
      </For>
    </div>
  );
}
