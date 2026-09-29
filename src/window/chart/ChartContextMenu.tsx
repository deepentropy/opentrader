/*
 * ChartContextMenu — the menu that opens on right-clicking the chart pane.
 * Ported to SolidJS from the reference mock. Renders in the
 * chart page DOM (not a separate window): 32px rows, 36px icon cell, 14px text,
 * bg #1f1f1f, 6px radius. Items/order/separators/shortcuts/icons are static;
 * dynamic pieces are filled by buildChartContextMenu in ChartView.
 *
 * Purely presentational: ChartView owns open/close + supplies the node list.
 */
import { createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { fitMenuRef } from "../../components/menu-fit";

// ── Menu model ──
export type CtxNode =
  | { kind: "separator" }
  | {
      kind: "item";
      id: string;
      label: string;
      shortcut?: string;
      icon?: JSX.Element;
      /** A function keeps the check live while the menu stays open. */
      checked?: boolean | (() => boolean);
      disabled?: boolean;
      submenu?: CtxNode[];
      onSelect?: () => void;
      /** The menu stays open after the row acts. */
      keepOpen?: boolean;
    };

// ── Icons of the context menu's iconCell ──
export const CtxIcons = {
  reset: (
    <svg viewBox="0 0 28 28" width="18" height="18">
      <g fill="none" fill-rule="evenodd" stroke="currentColor">
        <path d="M6.5 15A8.5 8.5 0 1 0 15 6.5H8.5" />
        <path d="M12 10L8.5 6.5 12 3" />
      </g>
    </svg>
  ),
  alert: (
    <svg viewBox="0 0 28 28" width="18" height="18">
      <path fill="currentColor" d="m19.54 4.5 3.96 4.32-.74.68-3.96-4.32.74-.68ZM7.46 4.5 3.5 8.82l.74.68L8.2 5.18l-.74-.68ZM19.74 10.33A7.5 7.5 0 0 1 21 14.5v.5h1v-.5a8.5 8.5 0 1 0-8.5 8.5h.5v-1h-.5a7.5 7.5 0 1 1 6.24-11.67Z" />
      <path fill="currentColor" d="M13 9v5h-3v1h4V9h-1ZM19 20v-4h1v4h4v1h-4v4h-1v-4h-4v-1h4Z" />
    </svg>
  ),
  buy: (
    <svg viewBox="0 0 28 28" width="18" height="18" fill="none">
      <path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M19.9792 16.6205C19.7396 16.8955 19.3241 16.9285 19.044 16.6948L14.3924 12.8117L14.072 12.5442L13.7516 12.8117L9.10009 16.6947C8.82008 16.9285 8.40456 16.8955 8.16495 16.6205C7.92467 16.3447 7.94981 15.9272 8.22144 15.6822L14.0721 10.4057L19.9227 15.6822C20.1943 15.9272 20.2195 16.3447 19.9792 16.6205ZM18.4032 17.4624C19.1009 18.0448 20.1362 17.9626 20.7332 17.2774C21.3318 16.5902 21.2692 15.55 20.5924 14.9396L14.407 9.36109L14.0721 9.05908L13.7373 9.36109L7.55171 14.9396C6.87492 15.55 6.81229 16.5902 7.41096 17.2774C8.00796 17.9626 9.04326 18.0448 9.74094 17.4624L14.072 13.8468L18.4032 17.4624Z" />
    </svg>
  ),
  sell: (
    <svg viewBox="0 0 28 28" width="18" height="18" fill="none">
      <path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M19.9792 12.2892C19.7396 12.0142 19.3241 11.9812 19.044 12.2149L14.3924 16.098L14.072 16.3655L13.7516 16.098L9.10009 12.2149C8.82008 11.9812 8.40456 12.0142 8.16495 12.2892C7.92467 12.565 7.94981 12.9825 8.22144 13.2275L14.0721 18.504L19.9227 13.2275C20.1943 12.9825 20.2195 12.565 19.9792 12.2892ZM18.4032 11.4472C19.1009 10.8648 20.1362 10.9471 20.7332 11.6323C21.3318 12.3195 21.2692 13.3597 20.5924 13.9701L14.407 19.5486L14.0721 19.8506L13.7373 19.5486L7.55171 13.9701C6.87492 13.3597 6.81229 12.3195 7.41096 11.6323C8.00796 10.9471 9.04326 10.8648 9.74094 11.4473L14.072 15.0628L18.4032 11.4472Z" />
    </svg>
  ),
  order: (
    <svg viewBox="0 0 28 28" width="18" height="18">
      <path fill="currentColor" d="M22 6H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h10v1H6a2 2 0 0 1-2-2V7c0-1.1.9-2 2-2h16a2 2 0 0 1 2 2v8h-1V7a1 1 0 0 0-1-1m-6 6.77-3.41-2.48-.6.81 4 2.9 4-2.9-.58-.8zm-4 2.47L8.59 17.7l-.6-.8L12 14 16 16.9l-.59.81zM21 17v3h-3v1h3v3h1v-3h3v-1h-3v-3z" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 28 28" width="18" height="18" fill="currentColor">
      <path fill-rule="evenodd" d="M18 14a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm-1 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
      <path fill-rule="evenodd" d="M8.5 5h11l5 9-5 9h-11l-5-9 5-9Zm-3.86 9L9.1 6h9.82l4.45 8-4.45 8H9.1l-4.45-8Z" />
    </svg>
  ),
  // Legend More menus.
  hide: (
    <svg viewBox="0 0 28 28" width="18" height="18">
      <path fill="currentColor" d="M18.15 7.02A9.05 9.05 0 0014 6c-3.45 0-6.08 2-7.8 3.92a18.18 18.18 0 00-2.64 3.84v.02h-.01L4 14l-.45-.21-.1.21.1.21L4 14l-.45.21.01.03a5.85 5.85 0 00.16.32c.11.2.28.51.5.87a18.18 18.18 0 002.4 3.12l.71-.71A17.18 17.18 0 014.56 14a10.05 10.05 0 01.52-.91c.41-.69 1.04-1.6 1.85-2.5C8.58 8.75 10.95 7 14 7a8 8 0 013.4.77l.75-.75zm-3.11 3.12a4 4 0 00-4.9 4.9l.86-.87V14a3 3 0 013.17-3l.87-.86zm1.96 3.7l.86-.88a4 4 0 01-4.9 4.9l.87-.86A3 3 0 0017 13.83zm-6.4 6.4A8 8 0 0014 21c3.05 0 5.42-1.76 7.07-3.58A17.18 17.18 0 0023.44 14a9.47 9.47 0 00-.52-.91 17.18 17.18 0 00-2.25-2.93l.7-.7a18.18 18.18 0 013.06 4.3l.02.02L24 14l.45.21-.01.03a7.03 7.03 0 01-.16.32c-.11.2-.28.51-.5.87-.44.72-1.1 1.69-1.97 2.65C20.08 20.01 17.45 22 14 22c-1.55 0-2.94-.4-4.15-1.02l.75-.75zM24 14l.45-.21.1.21-.1.21L24 14zM22.2 6.5L6.5 22.2l-.7-.7L21.5 5.8l.7.7z" />
    </svg>
  ),
  show: (
    <svg viewBox="0 0 28 28" width="18" height="18">
      <g fill="none" fill-rule="evenodd" stroke="currentColor" transform="translate(3 6)">
        <path d="M.964 8C3 4 6.679.5 11 .5 15.32.5 19 4 21.036 8 19 12 15.32 15.5 11 15.5 6.679 15.5 3 12 .964 8z" />
        <circle cx="11" cy="8" r="3.5" />
      </g>
    </svg>
  ),
  addIndicator: (
    <svg viewBox="0 0 28 28" width="18" height="18">
      <g fill="none" fill-rule="evenodd" stroke="currentColor">
        <path stroke-linecap="square" d="M11.5 21.5v-7m3 7v-5m3 5v-3m-9 3v-5" />
        <path d="M5.5 22v-3" />
        <path stroke-linecap="square" d="M5.5 13.5l4.297-4.297a2.406 2.406 0 0 1 3.406 0l2.594 2.594c.94.94 2.463.943 3.406 0L23.5 7.5M22.5 12.5v6m-3-3h6" />
      </g>
    </svg>
  ),
  favorite: (
    <svg viewBox="0 0 28 28" width="18" height="18" fill="none">
      <path fill="currentColor" fill-rule="evenodd" d="m17.13 9.74 7.37.9-5.44 5.06L20.4 23 14 19.38 7.6 23l1.34-7.3-5.44-5.06 7.37-.9L14 3l3.13 6.74Zm5.11 1.63-4.26 3.97 1.04 5.74L14 18.24l-5.02 2.84 1.04-5.74-4.26-3.97 5.79-.7L14 5.37l2.45 5.3 5.8.7Z" />
    </svg>
  ),
  remove: (
    <svg viewBox="0 0 28 28" width="18" height="18">
      <path fill="currentColor" d="M18 7h5v1h-2.01l-1.33 14.64a1.5 1.5 0 0 1-1.5 1.36H9.84a1.5 1.5 0 0 1-1.49-1.36L7.01 8H5V7h5V6c0-1.1.9-2 2-2h4a2 2 0 0 1 2 2v1Zm-6-2a1 1 0 0 0-1 1v1h6V6a1 1 0 0 0-1-1h-4ZM8.02 8l1.32 14.54a.5.5 0 0 0 .5.46h8.33a.5.5 0 0 0 .5-.46L19.99 8H8.02Z" />
    </svg>
  ),
  // A leading checkmark for a toggled-on item (swaps the iconCell glyph).
  check: (
    <svg viewBox="0 0 28 28" width="18" height="18">
      <path fill="currentColor" d="m11.18 18.3-4.6-4.6.71-.7 3.89 3.89 9.13-9.13.7.7-9.83 9.84Z" />
    </svg>
  ),
};

// Fresh checkmark per row — `CtxIcons.check` is a single DOM node (Solid JSX
// evaluates once at module init), so reusing it across several checked rows
// would leave it only in the LAST row that mounted it.
const CheckGlyph = () => (
  <svg viewBox="0 0 28 28" width="18" height="18">
    <path fill="currentColor" d="m11.18 18.3-4.6-4.6.71-.7 3.89 3.89 9.13-9.13.7.7-9.83 9.84Z" />
  </svg>
);

// The submenu chevron (a 10×16 glyph in the trailing cell).
const SubmenuArrow = () => (
  <svg viewBox="0 0 10 16" width="6" height="10" class="ot-chart-ctx-arrow" aria-hidden="true">
    <path fill="currentColor" d="M.6 1.4l1.4-1.4 8 8-8 8-1.4-1.4 6.389-6.532-6.389-6.668z" />
  </svg>
);

type Props = {
  x: number;
  y: number;
  nodes: CtxNode[];
  onClose: () => void;
};


export function ChartContextMenu(props: Props) {
  const [openSub, setOpenSub] = createSignal<string | null>(null);
  const [subPos, setSubPos] = createSignal<{ left: number; top: number }>({ left: 0, top: 0 });

  onMount(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") props.onClose(); };
    // "Outside" must include the SUBMENU, which renders as a sibling of the
    // root div — a plain ref.contains() check closed the menu on the capture
    // mousedown of any submenu click, before the item's onClick could fire.
    const onDown = (e: MouseEvent) => {
      const el = e.target as Element | null;
      if (el?.closest?.(".ot-chart-ctx-menu")) return;
      props.onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown, true);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown, true);
    });
  });

  const select = (n: Extract<CtxNode, { kind: "item" }>) => {
    if (n.disabled) return;
    if (n.submenu) return; // submenu parents don't act on click
    n.onSelect?.();
    if (!n.keepOpen) props.onClose();
  };

  const renderItems = (list: CtxNode[], isSub: boolean) =>
    list.map((n, i) => {
      if (n.kind === "separator") return <div class="ot-chart-ctx-separator" role="separator" data-sep={i} />;
      const checked = () => (typeof n.checked === "function" ? n.checked() : n.checked);
      const leading = () => (checked() ? <CheckGlyph /> : n.icon);
      return (
        <div
          class={`ot-chart-ctx-item${n.disabled ? " is-disabled" : ""}${openSub() === n.id ? " is-active" : ""}`}
          role="menuitem"
          aria-disabled={n.disabled || undefined}
          aria-haspopup={n.submenu ? "menu" : undefined}
          onMouseEnter={(e) => {
            if (n.submenu) {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setOpenSub(n.id);
              setSubPos({ left: r.right - 2, top: r.top - 6 });
            } else if (!isSub) {
              setOpenSub(null);
            }
          }}
          onClick={() => select(n)}
        >
          <span class="ot-chart-ctx-icon">{leading()}</span>
          <span class="ot-chart-ctx-label">{n.label}</span>
          {n.shortcut && <span class="ot-chart-ctx-shortcut">{n.shortcut}</span>}
          {n.submenu && <SubmenuArrow />}
        </div>
      );
    });

  const subParent = (): Extract<CtxNode, { kind: "item" }> | undefined => {
    const id = openSub();
    if (!id) return undefined;
    return props.nodes.find((n) => n.kind === "item" && n.id === id) as Extract<CtxNode, { kind: "item" }> | undefined;
  };

  return (
    <>
      <div
        ref={fitMenuRef(() => ({ x: props.x, y: props.y }))}
        class="ot-chart-ctx-menu"
        role="menu"
        onContextMenu={(e) => e.preventDefault()}
      >
        {renderItems(props.nodes, false)}
      </div>
      {subParent()?.submenu && (
        <div
          ref={fitMenuRef(() => ({ x: subPos().left, y: subPos().top }))}
          class="ot-chart-ctx-menu ot-chart-ctx-submenu"
          role="menu"
          onContextMenu={(e) => e.preventDefault()}
        >
          {renderItems(subParent()!.submenu!, true)}
        </div>
      )}
    </>
  );
}
