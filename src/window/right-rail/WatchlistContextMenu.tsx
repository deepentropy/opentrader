/*
 * Watchlist context menus — right-click on a symbol row / on a section header.
 *
 * Symbol-row menu (252px wide, 32px rows):
 *   Flag/Unflag {SYM}        Alt + ↵     (no icon)
 *   [● ● ● ● ● ● ●]                      inline colour row — 7 buttons 28×28,
 *                                        data-color order: red blue green
 *                                        orange purple cyan pink (no yellow)
 *   Unflag all symbols                   (no icon)
 *   ─
 *   Add {SYM} to watchlist ▸             submenu: the lists, each with a check
 *                                        box (click adds / removes, the menu
 *                                        stays open) + "Create new list…"
 *   Add {SYM} to compare                 the symbol joins the chart as a
 *                                        compared symbol, on the % scale
 *   Add note for {SYM}
 *   ─
 *   Add section                          (these two: not in "Deleted symbols")
 *   Add symbol
 * With several items selected and the click on one of them, the first row is
 * "Flag/Unflag all selected", the submenu "Add all selected to" (a list
 * holding only some of the symbols shows a dash), the compare row "Add all
 * selected to compare" (no such row above 10 selected items), and there is
 * no note row.
 * NO Remove / Copy / per-symbol alert here — row removal stays on the
 * hover ×. No "Financials…" row: its subsystem is not in this app, so the
 * row is omitted rather than dead.
 *
 * Section header menu (160×121): Rename / Remove section / Add symbol.
 */
import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { FLAG_HEX, WL_ICONS, type FlagColor, type Row } from "../../data/watchlist";
import type { WatchList } from "../../data/watchlist-store";

/** The 7 flag colours, in `data-color` order. */
import { FLAG_COLORS, flagOf } from "../../data/symbol-flags";

const ICON_PLUS =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18"><path fill="currentColor" d="M8.5 4h1v4.5H14v1H9.5V14h-1V9.5H4v-1h4.5V4Z"></path></svg>';
// Folder-with-plus — the "Add section" grouping action.
const ICON_SECTION =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18"><path fill="currentColor" d="M3 4.5C3 3.67 3.67 3 4.5 3h2.38c.4 0 .78.16 1.06.44L9 4.5h4.5c.83 0 1.5.67 1.5 1.5v.5h-1V6a.5.5 0 0 0-.5-.5H8.6L7.23 4.15A.5.5 0 0 0 6.88 4H4.5a.5.5 0 0 0-.5.5v7a.5.5 0 0 0 .5.5H9v1H4.5C3.67 13.5 3 12.83 3 12V4.5Zm9.5 3h1V10H16v1h-2.5v2.5h-1V11H10v-1h2.5V7.5Z"></path></svg>';
// Note / pencil-on-card — the "Add note" action.
const ICON_NOTE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18"><path fill="currentColor" d="M4.5 3C3.67 3 3 3.67 3 4.5v9c0 .83.67 1.5 1.5 1.5h9c.83 0 1.5-.67 1.5-1.5V9h-1v4.5a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5v-9a.5.5 0 0 1 .5-.5H9V3H4.5Zm9.85.65a1.2 1.2 0 0 0-1.7 0L7.5 8.79V10.5h1.71l5.14-5.15a1.2 1.2 0 0 0 0-1.7ZM8.5 9.5v-.3l4.85-4.85a.2.2 0 0 1 .3.3L8.79 9.5H8.5Z"></path></svg>';
// Plus in a circle — the "Add … to compare" action.
const ICON_COMPARE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18"><path fill="currentColor" d="M9 3a6 6 0 1 0 0 12A6 6 0 0 0 9 3ZM2 9a7 7 0 1 1 14 0A7 7 0 0 1 2 9Z"></path><path fill="currentColor" d="M8.5 6h1v2.5H12v1H9.5V12h-1V9.5H6v-1h2.5V6Z"></path></svg>';
// Plus-in-list — the "Add … to watchlist" action.
const ICON_LIST_ADD =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18"><path fill="currentColor" d="M3 4h12v1H3V4Zm0 4h12v1H3V8Zm0 4h6v1H3v-1Zm9.5-1.5h1V9h1.5v1h-1.5v1.5h-1V10H11V9h1.5V8.5Z"></path></svg>';

/** Shared dismiss + viewport-flip behaviour for a fixed-position menu. */
function useMenuShell(
  getXY: () => { x: number; y: number },
  onClose: () => void,
  rootRef: () => HTMLDivElement,
) {
  const [pos, setPos] = createSignal({ left: getXY().x, top: getXY().y });
  onMount(() => {
    const root = rootRef();
    const r = root.getBoundingClientRect();
    let left = getXY().x;
    let top = getXY().y;
    if (left + r.width > window.innerWidth - 4) left = Math.max(4, window.innerWidth - r.width - 4);
    if (top + r.height > window.innerHeight - 4) top = Math.max(4, window.innerHeight - r.height - 4);
    setPos({ left, top });

    const onDown = (e: PointerEvent) => {
      if (!root.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    onCleanup(() => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    });
  });
  return pos;
}

type Props = {
  row: Row;
  /** The selected symbols, when the menu acts on a selection of several
   *  items; null = `row` alone. */
  selected: Row[] | null;
  /** Viewport-space cursor coordinates the menu opens at. */
  x: number;
  y: number;
  /** The "Add … to" targets, in menu order. */
  lists: WatchList[];
  listHas: (listId: string, ticker: string) => boolean;
  onToggleFlag: (rows: Row[]) => void;
  onSetFlag: (rows: Row[], flag: FlagColor) => void;
  onUnflagAll: () => void;
  /** A click on a list row: adds the symbols it misses, or removes them all
   *  when it holds every one. */
  onToggleList: (listId: string, rows: Row[]) => void;
  onCreateListWith: (rows: Row[]) => void;
  /** False = no compare row (more than 10 items selected). */
  canCompare: boolean;
  onAddCompare: (rows: Row[]) => void;
  onAddNote: (row: Row) => void;
  /** False = no "Add section" / "Add symbol" rows ("Deleted symbols"). */
  canAdd: boolean;
  onAddSection: () => void;
  onAddSymbol: () => void;
  onClose: () => void;
};

export function WatchlistContextMenu(props: Props) {
  let root!: HTMLDivElement;
  const pos = useMenuShell(() => ({ x: props.x, y: props.y }), () => props.onClose(), () => root);
  const [listsOpen, setListsOpen] = createSignal(false);
  // The menu lives in the right rail — flip the submenu to the LEFT whenever
  // a right-side opening would leave the viewport (the default layout always
  // would: root right edge ≈ innerWidth).
  const [listsLeft, setListsLeft] = createSignal(false);

  const sym = () => props.row.short;
  const multi = () => props.selected != null;
  const rows = () => props.selected ?? [props.row];
  const run = (fn: () => void) => { fn(); props.onClose(); };
  /** How many of the menu's symbols a list holds: all, some or none. */
  const held = (l: WatchList): "all" | "some" | "none" => {
    const n = rows().filter((r) => props.listHas(l.id, r.ticker)).length;
    return n === 0 ? "none" : n === rows().length ? "all" : "some";
  };

  return (
    <div
      ref={root}
      class="ot-popover watchlist-ctx-menu"
      role="menu"
      aria-label={`${sym()} actions`}
      style={{ position: "fixed", left: `${pos().left}px`, top: `${pos().top}px`, "z-index": 1000 }}
    >
      <button type="button" role="menuitem" class="ot-menu-item" onClick={() => run(() => props.onToggleFlag(rows()))}>
        <span class="ot-menu-item__icon" aria-hidden="true" />
        <span class="ot-menu-item__label">{multi() ? "Flag/Unflag all selected" : `Flag/Unflag ${sym()}`}</span>
        <span class="ot-menu-item__hotkey">Alt + ↵</span>
      </button>

      {/* Inline flag-colour row — the 7 swatches render as a menu row. */}
      <div class="watchlist-ctx-flag-row" role="group" aria-label="Flag colour">
        <For each={FLAG_COLORS}>
          {(c) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={!multi() && flagOf(props.row.ticker) === c}
              class="watchlist-ctx-flag-swatch"
              classList={{ selected: !multi() && flagOf(props.row.ticker) === c }}
              aria-label={`Set ${c} flag`}
              onClick={() => run(() => props.onSetFlag(rows(), c))}
            >
              <span class="watchlist-ctx-flag-dot" style={{ "background-color": FLAG_HEX[c] }} />
            </button>
          )}
        </For>
      </div>

      <button type="button" role="menuitem" class="ot-menu-item" onClick={() => run(props.onUnflagAll)}>
        <span class="ot-menu-item__icon" aria-hidden="true" />
        <span class="ot-menu-item__label">Unflag all symbols</span>
      </button>

      <div class="ot-popover__divider" />

      {/* Add to watchlist — submenu of the lists + "Create new list…". */}
      <div
        class="watchlist-ctx-submenu"
        onPointerEnter={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setListsLeft(r.right + 320 > window.innerWidth - 4);
          setListsOpen(true);
        }}
        onPointerLeave={() => setListsOpen(false)}
      >
        <button
          type="button"
          role="menuitem"
          class="ot-menu-item"
          aria-haspopup="menu"
          aria-expanded={listsOpen()}
          onClick={() => setListsOpen((o) => !o)}
        >
          <span class="ot-menu-item__icon" aria-hidden="true" innerHTML={ICON_LIST_ADD} />
          <span class="ot-menu-item__label">{multi() ? "Add all selected to" : `Add ${sym()} to watchlist`}</span>
          <span class="ot-menu-item__submenu-arrow" aria-hidden="true" innerHTML={WL_ICONS.menuArrow} />
        </button>
        <Show when={listsOpen()}>
          <div
            class="ot-popover watchlist-ctx-lists"
            classList={{ "opens-left": listsLeft() }}
            role="menu"
            aria-label="Target watchlist"
          >
            <For each={props.lists}>
              {(l) => (
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={held(l) === "some" ? "mixed" : held(l) === "all"}
                  class="ot-menu-item watchlist-ctx-list-row"
                  data-list-id={l.id}
                  onClick={() => props.onToggleList(l.id, rows())}
                >
                  <span class="watchlist-ctx-check" classList={{ "is-checked": held(l) !== "none" }} aria-hidden="true">
                    <Show when={held(l) === "all"}>
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 11 9" width="11" height="9" fill="none"><path stroke="currentColor" stroke-width="2" d="M0.999878 4L3.99988 7L9.99988 1" /></svg>
                    </Show>
                    <Show when={held(l) === "some"}>
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 2" width="10" height="2"><path fill="currentColor" d="M0 0h10v2H0z" /></svg>
                    </Show>
                  </span>
                  <span class="ot-menu-item__label">{l.emoji ? `${l.emoji} ${l.name}` : l.name}</span>
                </button>
              )}
            </For>
            <Show when={props.lists.length > 0}>
              <div class="ot-popover__divider" />
            </Show>
            <button type="button" role="menuitem" class="ot-menu-item watchlist-ctx-list-row" onClick={() => run(() => props.onCreateListWith(rows()))}>
              <span class="ot-menu-item__label">Create new list…</span>
            </button>
          </div>
        </Show>
      </div>

      <Show when={props.canCompare}>
        <button type="button" role="menuitem" class="ot-menu-item" data-name="add-to-compare" onClick={() => run(() => props.onAddCompare(rows()))}>
          <span class="ot-menu-item__icon" aria-hidden="true" innerHTML={ICON_COMPARE} />
          <span class="ot-menu-item__label">{multi() ? "Add all selected to compare" : `Add ${sym()} to compare`}</span>
        </button>
      </Show>

      <Show when={!multi()}>
        <button type="button" role="menuitem" class="ot-menu-item" onClick={() => run(() => props.onAddNote(props.row))}>
          <span class="ot-menu-item__icon" aria-hidden="true" innerHTML={ICON_NOTE} />
          <span class="ot-menu-item__label">Add note for {sym()}</span>
        </button>
      </Show>

      <Show when={props.canAdd}>
        <div class="ot-popover__divider" />

        <button type="button" role="menuitem" class="ot-menu-item" onClick={() => run(props.onAddSection)}>
          <span class="ot-menu-item__icon" aria-hidden="true" innerHTML={ICON_SECTION} />
          <span class="ot-menu-item__label">Add section</span>
        </button>

        <button type="button" role="menuitem" class="ot-menu-item" onClick={() => run(props.onAddSymbol)}>
          <span class="ot-menu-item__icon" aria-hidden="true" innerHTML={ICON_PLUS} />
          <span class="ot-menu-item__label">Add symbol</span>
        </button>
      </Show>
    </div>
  );
}

type SectionProps = {
  name: string;
  x: number;
  y: number;
  onRename: (name: string) => void;
  /** False on a collapsed section: no "Remove section" row. */
  canRemove: boolean;
  onRemove: (name: string) => void;
  onAddSymbol: () => void;
  onClose: () => void;
};

/** Right-click menu on a section header (Rename / Remove section / Add symbol). */
export function SectionContextMenu(props: SectionProps) {
  let root!: HTMLDivElement;
  const pos = useMenuShell(() => ({ x: props.x, y: props.y }), () => props.onClose(), () => root);
  const run = (fn: () => void) => { fn(); props.onClose(); };

  return (
    <div
      ref={root}
      class="ot-popover watchlist-ctx-menu watchlist-ctx-menu--section"
      role="menu"
      aria-label={`${props.name} section actions`}
      style={{ position: "fixed", left: `${pos().left}px`, top: `${pos().top}px`, "z-index": 1000 }}
    >
      <button type="button" role="menuitem" class="ot-menu-item" onClick={() => run(() => props.onRename(props.name))}>
        <span class="ot-menu-item__icon" aria-hidden="true" />
        <span class="ot-menu-item__label">Rename</span>
      </button>
      <Show when={props.canRemove}>
        <button type="button" role="menuitem" class="ot-menu-item" onClick={() => run(() => props.onRemove(props.name))}>
          <span class="ot-menu-item__icon" aria-hidden="true" />
          <span class="ot-menu-item__label">Remove section</span>
        </button>
      </Show>
      <div class="ot-popover__divider" />
      <button type="button" role="menuitem" class="ot-menu-item" onClick={() => run(props.onAddSymbol)}>
        <span class="ot-menu-item__icon" aria-hidden="true" innerHTML={ICON_PLUS} />
        <span class="ot-menu-item__label">Add symbol</span>
      </button>
    </div>
  );
}
