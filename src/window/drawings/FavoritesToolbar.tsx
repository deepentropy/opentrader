/*
 * FavoritesToolbar — the "favorite drawing tools toolbar": a floating,
 * draggable horizontal strip holding the drawing tools the user has starred,
 * for one-click access. Solid port of the reference mock's FavoritesToolbar
 * (reverse-engineered from TradingView Desktop 3.1.0.7818).
 *
 * Fidelity notes (captured from the live `tv-floating-toolbar`):
 *   - shell: 38px tall, 6px radius, bg #1f1f1f, shadow 0 2px 4px rgba(0,0,0,.4)
 *     — identical tokens to the selected-drawing toolbar, so it reuses the
 *     `.selected-toolbar` shell styles.
 *   - drag handle: 24px wide, the 6-dot grip SVG (viewBox 0 0 8 12).
 *   - widgets: one 38×38 button per favourite, showing the tool's 28×28 icon;
 *     native `title` tooltip = tool name; click arms the tool.
 *   - default dock: top-centre of the chart pane; free-dragged anywhere after.
 *
 * Selection is routed through the left DrawingToolbar's pick path via a
 * `select-drawing-tool` window CustomEvent, so cursor-mode / arming behaviour
 * stays in one place.
 *
 * Show/hide: right-click → "Hide Favorite Drawing Tools Toolbar" (the inverse
 * "Show …" lives on the left toolbar's context menu — see DrawingToolbar).
 */
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { TvIcon } from "../../components/TvIcon";
import {
  favoriteToolIds,
  favoritesToolbarPos,
  favoritesToolbarVisible,
  findToolMeta,
  setFavoritesToolbarPos,
  setFavoritesToolbarVisible,
} from "./favorite-tools";

type Props = {
  /** Currently-armed tool id; highlights the matching favourite button. */
  armedTool: string | null;
};

export function FavoritesToolbar(props: Props) {
  // Position is a free offset from the default dock (top-centre of the chart
  // pane). Persisted to storage (favorite-tools.ts) so it survives reloads and
  // syncs across windows; reset is not exposed (matches TV, which keeps the bar
  // where you drag it).
  const pos = favoritesToolbarPos;
  const setPos = setFavoritesToolbarPos;
  let drag: null | { startX: number; startY: number; baseX: number; baseY: number } = null;
  let root!: HTMLDivElement;

  // Right-click context menu (single item: "Hide …").
  const [menu, setMenu] = createSignal<{ x: number; y: number } | null>(null);
  let menuEl: HTMLDivElement | undefined;

  // Clamp an offsetParent-relative position to the viewport, with one carve-out:
  // the bar may roam the whole screen (chart, header, watchlist) but never up
  // onto the window tab bar above the header. So the only tightened edge is the
  // top, pinned to the header's top edge; the rest are the viewport bounds.
  const clampPos = (x: number, y: number): { x: number; y: number } => {
    const parent = root.offsetParent as HTMLElement | null;
    if (!parent) return { x, y };
    const pr = parent.getBoundingClientRect();
    const w = root.offsetWidth;
    const h = root.offsetHeight;
    const header = document.querySelector(".header-toolbar");
    const headerTop = header ? header.getBoundingClientRect().top : pr.top;
    // Bounds are viewport edges expressed in offsetParent-relative coords
    // (subtract the parent's viewport offset).
    const minX = -pr.left;
    const maxX = window.innerWidth - pr.left - w;
    const minY = headerTop - pr.top;
    const maxY = window.innerHeight - pr.top - h;
    return {
      x: Math.max(minX, Math.min(maxX, x)),
      y: Math.max(minY, Math.min(maxY, y)),
    };
  };

  const onDragDown = (e: PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const r = root.getBoundingClientRect();
    // Seed the base in offsetParent-relative coords (the same space `pos` is
    // applied in). On the FIRST drag the bar is still placed by its CSS dock,
    // so without this conversion the first move jumps it by the chart pane's
    // own offset — the gap between pointer and toolbar.
    const pr = (root.offsetParent as HTMLElement | null)?.getBoundingClientRect();
    drag = {
      startX: e.clientX, startY: e.clientY,
      baseX: pos()?.x ?? (r.left - (pr?.left ?? 0)),
      baseY: pos()?.y ?? (r.top - (pr?.top ?? 0)),
    };
  };
  const onDragMove = (e: PointerEvent) => {
    if (!drag) return;
    setPos(clampPos(drag.baseX + (e.clientX - drag.startX), drag.baseY + (e.clientY - drag.startY)));
  };
  const onDragUp = (e: PointerEvent) => {
    drag = null;
    try { (e.currentTarget as Element).releasePointerCapture?.(e.pointerId); } catch { /* noop */ }
  };

  // Hide closes any open context menu too.
  createEffect(() => { if (!favoritesToolbarVisible()) setMenu(null); });

  // Outside-click + Escape dismiss the context menu.
  onMount(() => {
    const onDown = (e: MouseEvent) => {
      if (menu() && menuEl && !menuEl.contains(e.target as Node)) setMenu(null);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (menu() && e.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onEsc);
    onCleanup(() => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onEsc);
    });
  });

  // Resolve favourites to renderable tools, dropping any unknown id defensively.
  const tools = createMemo(() =>
    favoriteToolIds()
      .map((id) => ({ id, meta: findToolMeta(id) }))
      .filter((t): t is { id: string; meta: NonNullable<ReturnType<typeof findToolMeta>> } => t.meta !== null),
  );

  // Only render when shown AND there is ≥1 favourite (matches TV: an empty
  // favourites set shows no bar).
  const show = () => favoritesToolbarVisible() && tools().length > 0;

  return (
    <Show when={show()}>
      <div
        ref={root}
        class="selected-toolbar favorites-toolbar"
        data-name="favorited-drawings-toolbar"
        aria-label="Favorite drawing tools toolbar"
        style={pos() ? { left: `${pos()!.x}px`, top: `${pos()!.y}px`, transform: "none" } : undefined}
        onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
      >
        <div
          class="selected-toolbar-drag favorites-toolbar-drag"
          onPointerDown={onDragDown}
          onPointerMove={onDragMove}
          onPointerUp={onDragUp}
          aria-label="Drag"
        >
          {/* 6-dot grip, captured viewBox 0 0 8 12. */}
          <svg viewBox="0 0 8 12" width="8" height="12" fill="currentColor" aria-hidden="true">
            <rect width="2" height="2" rx="1" />
            <rect width="2" height="2" rx="1" y="5" />
            <rect width="2" height="2" rx="1" y="10" />
            <rect width="2" height="2" rx="1" x="6" />
            <rect width="2" height="2" rx="1" x="6" y="5" />
            <rect width="2" height="2" rx="1" x="6" y="10" />
          </svg>
        </div>
        <div class="selected-toolbar-content">
          <For each={tools()}>
            {({ id, meta }) => (
              <button
                type="button"
                class={"selected-toolbar-btn favorites-toolbar-btn" + (props.armedTool === id ? " active" : "")}
                data-name={`FavoriteToolbar-${id}`}
                title={meta.title}
                aria-label={meta.title}
                onClick={() => window.dispatchEvent(new CustomEvent("select-drawing-tool", { detail: { toolId: id } }))}
              >
                <TvIcon name={meta.iconName} size={28} />
              </button>
            )}
          </For>
        </div>

        <Show when={menu()}>
          {(m) => (
            <div
              ref={menuEl}
              class="tv-popover drawing-toolbar-context-menu"
              role="menu"
              style={{ position: "fixed", left: `${m().x}px`, top: `${m().y}px` }}
            >
              <button
                type="button"
                role="menuitem"
                class="drawing-tool-submenu-item"
                onClick={() => { setFavoritesToolbarVisible(false); setMenu(null); }}
              >
                <span class="drawing-tool-submenu-label">Hide Favorite Drawing Tools Toolbar</span>
              </button>
            </div>
          )}
        </Show>
      </div>
    </Show>
  );
}
