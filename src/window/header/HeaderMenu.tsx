/*
 * HeaderMenu — popup dropdown rendered when HeaderToolbar's onMenuOpen fires.
 *
 * Looks up its contents in HEADER_MENUS (1400-line static registry).
 * Positioned below the opener's bounding rect; closes on Escape, on mousedown outside, or when
 * the parent unmounts it (e.g. opener clicked twice).
 *
 * Rendering + selection; App's onMenuSelect runs the picked row (chart
 * interval, chart type, layout, favourite indicators, snapshot, layouts).
 */
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { Tooltip } from "../../components/Tooltip";
import { Icon } from "../../components/Icon";
import { favoriteIntervals, toggleFavoriteInterval } from "../chart/interval-favorites";
import {
  addCustomInterval,
  customIntervals,
  intervalMenuHas,
  isSectionFolded,
  lastAddedInterval,
  removeCustomInterval,
  sectionOf,
  setLastAddedInterval,
  setSectionFolded,
} from "../chart/custom-intervals";
import { AddCustomIntervalDialog } from "./AddCustomIntervalDialog";
import { LAYOUT_SYNC_ITEMS, layoutSync, toggleLayoutSync } from "../chart/layout-sync";
import { isSupportedResolution } from "../../data/datafeed";
import { isFavoriteIndicator, toggleFavoriteIndicator } from "../../data/indicator-favorites";
import {
  APPLY_TEMPLATE_PREFIX,
  getIndicatorTemplate,
  removeIndicatorTemplate,
  toggleFavoriteIndicatorTemplate,
} from "../../data/indicator-template-store";
import { getLayout, OPEN_LAYOUT_PREFIX, toggleFavoriteLayout } from "../../data/layout-store";
import type { HeaderMenuDef } from "./header-menus/registry";

type Props = {
  menu: HeaderMenuDef;
  menuId?: string;
  anchor: DOMRect;
  onClose: () => void;
  /** Overrides the registry's static `checked` — rows matching this id render selected. */
  selectedRowId?: string;
  /** Fires before onClose when a row is clicked. */
  onSelect?: (rowId: string) => void;
};

function StarIcon(props: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 18 18"
      width="14"
      height="14"
      fill={props.filled ? "currentColor" : "none"}
      stroke="currentColor"
      stroke-width={props.filled ? 0 : 1}
    >
      <path d="M9 1l2.35 4.76 5.26.77-3.8 3.7.9 5.24L9 13l-4.7 2.47.9-5.23-3.8-3.71 5.25-.77L9 1z" />
    </svg>
  );
}

export function HeaderMenu(props: Props) {
  let root!: HTMLDivElement;
  const [pos, setPos] = createSignal<{ top: number; left: number }>({ top: 0, left: 0 });
  // "Add custom interval…" opens its dialog over the open interval menu; the
  // menu stays open behind it and shows the added row.
  const [addIntervalOpen, setAddIntervalOpen] = createSignal(false);

  // Per-menu icon-size override mirrors the mock: candles uses 28px (preview
  // chart-style glyphs); layout-setup uses 36px (layout thumbnails); other
  // menus use the 24px action-row size.
  const iconSize = () =>
    props.menuId === "candles" || props.menuId === "chart-interval" ? 28 : props.menuId === "layout-setup" ? 36 : 24;

  // Positioning — below the anchor, horizontally flipped if it would overflow
  // the viewport's right edge (buttons at x > 1300 with a 428px-wide menu).
  createEffect(() => {
    const a = props.anchor;
    const w = props.menu.width;
    const margin = 4;
    let left = a.left;
    const overflow = left + w - window.innerWidth + margin;
    if (overflow > 0) left = Math.max(margin, a.right - w);
    setPos({ top: a.bottom + 2, left });
  });

  onMount(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (addIntervalOpen() || root.contains(e.target as Node)) return;
      props.onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !addIntervalOpen()) props.onClose();
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    onCleanup(() => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
      setLastAddedInterval(null);
    });
  });

  return (
    <Portal mount={document.body}>
      <div
        ref={root}
        class="ot-popover header-menu"
        data-menu-id={props.menuId}
        role="menu"
        style={{
          top: `${pos().top}px`,
          left: `${pos().left}px`,
          // The interval menu sizes to its rows, like the reference menu
          // (header-menu.css); the others keep their registry width.
          ...(props.menuId === "chart-interval" ? {} : { width: `${props.menu.width}px` }),
        }}
      >
        <For each={props.menu.sections}>
          {(section, si) => {
            // Interval menu: every section has a title row that folds it
            // (state kept per section, all open by default).
            const fold = () =>
              props.menuId === "chart-interval" && section.header && section.items[0]
                ? sectionOf(section.items[0].id)
                : null;
            const folded = () => {
              const f = fold();
              return f ? isSectionFolded(f) : false;
            };
            return (
            <>
              <Show when={si() > 0 && (!section.header || fold())}>
                <div class="header-menu-divider" role="separator" />
              </Show>
              <Show when={section.header && !fold()}>
                <div class="header-menu-section-title">{section.header}</div>
              </Show>
              <Show when={fold()}>
                {(f) => (
                  <button
                    type="button"
                    class="header-menu-fold-title"
                    data-name={`section-${f()}`}
                    aria-label={section.header ?? ""}
                    aria-expanded={!folded()}
                    onClick={() => setSectionFolded(f(), !folded())}
                  >
                    <span class="header-menu-fold-label">{section.header}</span>
                    <svg class="header-menu-fold-chevron" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
                      <path
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1"
                        d={folded() ? "M5 7.5 9 11l4-3.5" : "M5 10.5 9 7l4 3.5"}
                      />
                    </svg>
                  </button>
                )}
              </Show>
              <Show when={!folded()}>
              <For each={section.items}>
                {(row) => {
                  const hasVariants = !!(row.variants && row.variants.length);
                  const isChecked = () =>
                    props.selectedRowId != null
                      ? props.selectedRowId === row.id
                      : !!row.checked;
                  // Chart-interval rows are the text-only (no icon) rows.
                  const isIntervalRow = () => props.menuId === "chart-interval" && !row.iconName;
                  // Gate the picker to what the feed can actually serve: an
                  // interval the datafeed doesn't support (ticks, ranges)
                  // renders greyed + non-selectable rather than silently
                  // loading daily bars. Mirrors getBars' validation.
                  const disabled = () =>
                    !!row.disabled || (isIntervalRow() && !isSupportedResolution(row.id));
                  // Custom interval rows carry a Remove button (also on a
                  // greyed row, so the row is not natively disabled).
                  const isCustomRow = () => isIntervalRow() && customIntervals().includes(row.id);
                  const isAddIntervalRow = () =>
                    props.menuId === "chart-interval" && row.id === "add-custom-interval-button";
                  const signaling = () => isIntervalRow() && lastAddedInterval() === row.id;
                  // Rows with a live, interactive star: interval rows, the
                  // favourite-indicators rows, and saved indicator-template
                  // rows. Other menus keep the static `favorited` flag
                  // (cosmetic only).
                  const isFavIndicatorRow = () =>
                    props.menuId === "show-favorite-indicators" && !row.disabled;
                  const isTemplateRow = () =>
                    props.menuId === "indicator-templates" && row.id.startsWith(APPLY_TEMPLATE_PREFIX);
                  const templateId = () => row.id.slice(APPLY_TEMPLATE_PREFIX.length);
                  // Saved-layout rows of Manage layouts: the recent rows
                  // carry a favorite star (shown on hover, kept when starred).
                  const isLayoutRow = () =>
                    props.menuId === "save-load-menu" && row.id.startsWith(OPEN_LAYOUT_PREFIX);
                  const layoutId = () => row.id.slice(OPEN_LAYOUT_PREFIX.length);
                  const favoritable = () =>
                    (isIntervalRow() && !disabled()) || isFavIndicatorRow() || isTemplateRow() || isLayoutRow();
                  const isFav = () => {
                    if (isIntervalRow() && !disabled()) return favoriteIntervals().includes(row.id);
                    if (isFavIndicatorRow()) return isFavoriteIndicator(row.id);
                    if (isTemplateRow()) return !!getIndicatorTemplate(templateId())?.favorite;
                    if (isLayoutRow()) return !!getLayout(layoutId())?.favorite;
                    return !!row.favorited;
                  };
                  // The star tooltip shows on interval, template and layout
                  // rows; the favourite-indicators star has none.
                  const starTip = () => (isFav() ? "Remove from favorites" : "Add to favorites");
                  const star = () => (
                    <span
                      class="header-menu-star"
                      role="button"
                      aria-label={starTip()}
                      onClick={(e) => {
                        // Toggle the favourite without selecting the row /
                        // closing the menu.
                        e.stopPropagation();
                        toggleStar();
                      }}
                    >
                      <StarIcon filled={isFav()} />
                    </span>
                  );
                  const toggleStar = () => {
                    if (isIntervalRow()) toggleFavoriteInterval(row.id);
                    else if (isFavIndicatorRow()) toggleFavoriteIndicator(row.id);
                    else if (isTemplateRow()) toggleFavoriteIndicatorTemplate(templateId());
                    else if (isLayoutRow()) toggleFavoriteLayout(layoutId());
                  };
                  const cls = () =>
                    [
                      "header-menu-row",
                      isChecked() ? "is-checked" : "",
                      isFav() ? "is-favorited" : "",
                      hasVariants ? "has-variants" : "",
                      disabled() ? "is-disabled" : "",
                      isCustomRow() ? "is-removable" : "",
                      signaling() ? "is-signaling" : "",
                    ]
                      .filter(Boolean)
                      .join(" ");
                  if (hasVariants) {
                    // Rows with tile-variants (layout-setup picker): label
                    // on the left, mini-tile buttons on the right. The row
                    // itself isn't clickable; each variant tile is.
                    return (
                      <div class={cls()} data-name={row.id} role="presentation">
                        <span class="header-menu-label">{row.label}</span>
                        <div class="header-menu-variants">
                          <For each={row.variants!}>
                            {(v) => {
                              const variantChecked = () =>
                                props.selectedRowId != null
                                  ? props.selectedRowId === v.id
                                  : !!v.checked;
                              return (
                                <button
                                  type="button"
                                  role="menuitem"
                                  data-name={v.id}
                                  aria-selected={variantChecked() || undefined}
                                  aria-label={v.label}
                                  class={
                                    "header-menu-variant" +
                                    (variantChecked() ? " is-checked" : "")
                                  }
                                  onClick={() => {
                                    props.onSelect?.(v.id);
                                    props.onClose();
                                  }}
                                >
                                  <Show when={v.iconName}>
                                    <Icon name={v.iconName!} size={22} />
                                  </Show>
                                </button>
                              );
                            }}
                          </For>
                        </div>
                      </div>
                    );
                  }
                  return (
                    <button
                      ref={(el) => {
                        // The just-added custom row scrolls into view.
                        createEffect(() => {
                          if (signaling()) el.scrollIntoView({ block: "nearest" });
                        });
                      }}
                      type="button"
                      role="menuitem"
                      data-name={row.id}
                      aria-selected={isChecked() || undefined}
                      aria-disabled={disabled() || undefined}
                      disabled={disabled() && !isCustomRow()}
                      class={cls()}
                      onClick={() => {
                        if (disabled()) return;
                        if (isAddIntervalRow()) {
                          setAddIntervalOpen(true);
                          return;
                        }
                        props.onSelect?.(row.id);
                        props.onClose();
                      }}
                    >
                      <span class="header-menu-icon">
                        <Show when={row.iconName}>
                          <Icon name={row.iconName!} size={iconSize()} />
                        </Show>
                      </span>
                      <span class={`header-menu-label${isTemplateRow() ? "" : " apply-overflow-tooltip"}`}>{row.label}</span>
                      <Show when={row.hotkey}>
                        <span class="header-menu-hotkey">{row.hotkey}</span>
                      </Show>
                      <Show when={isCustomRow()}>
                        <Tooltip text="Remove" side="bottom">
                          <span
                            class="header-menu-star header-menu-remove"
                            role="button"
                            aria-label="Remove"
                            data-name="remove-interval-button"
                            onClick={(e) => {
                              e.stopPropagation();
                              removeCustomInterval(row.id);
                            }}
                          >
                            <svg viewBox="0 0 18 18" width="14" height="14">
                              <path stroke="currentColor" stroke-width="1.2" fill="none" d="m4 4 10 10m0-10L4 14" />
                            </svg>
                          </span>
                        </Tooltip>
                      </Show>
                      <Show when={favoritable()}>
                        <Show when={!isFavIndicatorRow()} fallback={star()}>
                          <Tooltip text={starTip()} side="bottom">
                            {star()}
                          </Tooltip>
                        </Show>
                      </Show>
                      <Show when={isTemplateRow()}>
                        <Tooltip text="Remove" side="bottom">
                          <span
                            class="header-menu-star"
                            role="button"
                            aria-label="Remove"
                            onClick={(e) => {
                              // Delete without closing (hover Remove).
                              e.stopPropagation();
                              removeIndicatorTemplate(templateId());
                            }}
                          >
                            <svg viewBox="0 0 18 18" width="14" height="14">
                              <path stroke="currentColor" stroke-width="1.2" fill="none" d="m4 4 10 10m0-10L4 14" />
                            </svg>
                          </span>
                        </Tooltip>
                      </Show>
                    </button>
                  );
                }}
              </For>
              </Show>
            </>
            );
          }}
        </For>
        <Show when={addIntervalOpen()}>
          <AddCustomIntervalDialog
            exists={intervalMenuHas}
            onAdd={(id) => {
              addCustomInterval(id);
              // The added row's section opens; its row flashes for 1.6 s.
              const s = sectionOf(id);
              if (s) setSectionFolded(s, false);
              setLastAddedInterval(id);
              window.setTimeout(() => {
                if (lastAddedInterval() === id) setLastAddedInterval(null);
              }, 1600);
            }}
            onClose={() => setAddIntervalOpen(false)}
          />
        </Show>
        {/* "Sync in layout" — only on the layout picker. Toggles mirror an
            aspect (symbol / interval / crosshair / time / date range) across
            every pane of the active multi-chart layout. Clicking flips the
            switch without closing the menu. */}
        <Show when={props.menuId === "layout-setup"}>
          <div class="header-menu-divider" role="separator" />
          {/* Sentence-case "Sync in layout" title. */}
          <div class="header-menu-section-title is-sync-title">Sync in layout</div>
          <For each={LAYOUT_SYNC_ITEMS}>
            {(item) => (
              <button
                type="button"
                role="menuitemcheckbox"
                data-name={`sync-${item.key}`}
                aria-checked={layoutSync()[item.key]}
                class="header-menu-row is-toggle"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleLayoutSync(item.key);
                }}
              >
                <span class="header-menu-label">{item.label}</span>
                {/* Info icon (ⓘ) carrying the per-toggle tooltip. */}
                <span class="header-menu-sync-info" title={item.tip} aria-label={item.tip}>
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="16" height="16">
                    <path
                      fill="currentColor"
                      d="M9 17A8 8 0 1 0 9 1a8 8 0 0 0 0 16Zm1-12a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM8.5 9.5H7V8h3v6H8.5V9.5Z"
                    />
                  </svg>
                </span>
                <span
                  class={"header-menu-switch" + (layoutSync()[item.key] ? " is-on" : "")}
                  aria-hidden="true"
                />
              </button>
            )}
          </For>
        </Show>
      </div>
    </Portal>
  );
}
