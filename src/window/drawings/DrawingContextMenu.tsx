/*
 * Right-click context menu for a selected drawing.
 *
 * Item set: the floating-toolbar "More" menu (214×307: Visual order ▸,
 * Visibility on intervals ▸, Clone [Ctrl + Drag], Copy [Ctrl + C], sync
 * radios, Hide) plus the standing Settings… / Lock / Remove rows.
 * Deviations, recorded:
 *   • per-drawing sync radios omitted — this app has no per-drawing sync
 *     backing (the toolbar's sync menu sets the new-drawings default);
 *   • "Visibility on intervals" opens the Settings dialog on its Visibility
 *     tab instead of a hover submenu.
 *
 * Mounted at fixed-viewport coords, fitted into the window like the other
 * popup menus (components/menu-fit.ts). Outside-click / Escape close. Stops
 * the bubbled pointerdown so the overlay's "click empty area = deselect"
 * doesn't fire while interacting with the menu.
 */
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { Drawing } from "lightweight-charts-drawing/tv/types";
import { Icon } from "../../components/Icon";
import { fitMenuRef } from "../../components/menu-fit";
import { ELLIOTT_DEFAULT_DEGREE, ELLIOTT_DEGREE_NAMES, ELLIOTT_KINDS } from "lightweight-charts-drawing/tv/specs";
import { tableCanRemove, type TableCellRef } from "lightweight-charts-drawing/tv/kinds/table";

type Row =
  | {
      kind: "item";
      id: string;
      /** Static label, or a function for reactive labels (e.g. "Lock" ↔ "Unlock"). */
      label: string | ((d: Drawing) => string);
      iconName?: string;
      shortcut?: string;
      /** When set, paints a checkmark on the icon cell when active. */
      checked?: (d: Drawing) => boolean;
      /** Rows that open a hover submenu render a right-pointing chevron. */
      submenu?: boolean;
      /** Greyed-out, not clickable. */
      disabled?: (d: Drawing) => boolean;
    }
  | { kind: "separator" };

const ROWS: Row[] = [
  { kind: "item", id: "settings", label: "Settings…", iconName: "dt-settings" },
  { kind: "separator" },
  { kind: "item", id: "clone", label: "Clone", iconName: "dt-cm-clone", shortcut: "Ctrl + Drag" },
  { kind: "item", id: "copy", label: "Copy", shortcut: "Ctrl + C" },
  { kind: "separator" },
  { kind: "item", id: "visual-order", label: "Visual order", submenu: true },
  { kind: "item", id: "visibility-intervals", label: "Visibility on intervals…" },
  { kind: "separator" },
  {
    kind: "item",
    id: "lock",
    iconName: "dt-lock",
    label: (d) => (d.locked ? "Unlock" : "Lock"),
    checked: (d) => !!d.locked,
  },
  {
    kind: "item",
    id: "hide",
    iconName: "dt-cm-hide",
    label: (d) => (d.hidden ? "Show" : "Hide"),
    checked: (d) => !!d.hidden,
  },
  { kind: "separator" },
  { kind: "item", id: "remove", label: "Remove", shortcut: "Del" },
];

/** Elliott waves add a "Degree" submenu after all the items. */
const DEGREE_ROWS: Row[] = [{ kind: "separator" }, { kind: "item", id: "degree", label: "Degree", submenu: true }];
/** Bars pattern: checkable "Mirrored" / "Flipped" after all the items. */
const BARS_PATTERN_ROWS: Row[] = [
  { kind: "separator" },
  { kind: "item", id: "mirrored", label: "Mirrored", checked: (d) => !!d.style.mirrored },
  { kind: "item", id: "flipped", label: "Flipped", checked: (d) => !!d.style.flipped },
];

/** Table actions, placed before all the items: insert column / row, and
 *  with an active cell remove row / column (disabled when it is the last
 *  one). */
const TABLE_ROWS: Row[] = [
  { kind: "item", id: "table-insert-column", label: "Add column to right", iconName: "dt-table-insert-column" },
  { kind: "item", id: "table-insert-row", label: "Add row below", iconName: "dt-table-insert-row" },
];
const TABLE_REMOVE_ROWS: Row[] = [
  { kind: "separator" },
  { kind: "item", id: "table-remove-row", label: "Remove row", iconName: "dt-table-remove", disabled: (d) => !tableCanRemove(d.style, "row") },
  { kind: "item", id: "table-remove-column", label: "Remove column", iconName: "dt-table-remove", disabled: (d) => !tableCanRemove(d.style, "column") },
];

const ORDER_ROWS: ReadonlyArray<readonly ["front" | "forward" | "backward" | "back", string]> = [
  ["front", "Bring to front"],
  ["forward", "Bring forward"],
  ["backward", "Send backward"],
  ["back", "Send to back"],
];

type Props = {
  drawing: Drawing;
  /** Full multi-selection the drawing belongs to (primary included). Remove
   *  acts on every member when longer than 1; other rows stay per-drawing. */
  groupIds?: string[];
  anchor: { x: number; y: number };
  onClose: () => void;
  onUpdate: (d: Drawing) => void;
  onClone: (id: string) => void;
  onCopy: (d: Drawing) => void;
  onReorder: (id: string, dir: "front" | "forward" | "backward" | "back") => void;
  onRemove: (id: string) => void;
  /** Bulk delete for the group Remove — one undo entry. */
  onRemoveMany?: (ids: string[]) => void;
  /** Open the settings dialog, optionally on a specific tab. */
  onOpenSettings: (id: string, tab?: "Style" | "Text" | "Coordinates" | "Visibility") => void;
  /** Table: the active cell (the in-place editable cell) and the cell
   *  operations of the table actions. */
  tableCell?: TableCellRef | null;
  onTableOp?: (op: "insert-column" | "insert-row" | "remove-row" | "remove-column") => void;
};

export function DrawingContextMenu(props: Props) {
  let root!: HTMLDivElement;
  // Hover submenu (Visual order / Elliott Degree) — fixed-pos panel anchored
  // to the row's edge.
  const [orderAnchor, setOrderAnchor] = createSignal<{ x: number; y: number; id: string } | null>(null);
  const rows = () =>
    props.drawing.kind === "table"
      ? [...TABLE_ROWS, ...(props.tableCell ? TABLE_REMOVE_ROWS : []), { kind: "separator" } as Row, ...ROWS]
      : ELLIOTT_KINDS.has(props.drawing.kind)
      ? [...ROWS, ...DEGREE_ROWS]
      : props.drawing.kind === "bar-pattern"
        ? [...ROWS, ...BARS_PATTERN_ROWS]
        : ROWS;

  function invoke(id: string) {
    const d = props.drawing;
    switch (id) {
      case "settings":
        props.onOpenSettings(d.id);
        break;
      case "clone":
        props.onClone(d.id);
        break;
      case "copy":
        props.onCopy(d);
        break;
      case "visibility-intervals":
        props.onOpenSettings(d.id, "Visibility");
        break;
      case "lock":
        props.onUpdate({ ...d, locked: !d.locked });
        break;
      case "hide":
        props.onUpdate({ ...d, hidden: !d.hidden });
        break;
      case "mirrored":
        props.onUpdate({ ...d, style: { ...d.style, mirrored: !d.style.mirrored } } as Drawing);
        break;
      case "flipped":
        props.onUpdate({ ...d, style: { ...d.style, flipped: !d.style.flipped } } as Drawing);
        break;
      case "table-insert-column":
      case "table-insert-row":
      case "table-remove-row":
      case "table-remove-column":
        props.onTableOp?.(id.slice(6) as "insert-column" | "insert-row" | "remove-row" | "remove-column");
        break;
      case "remove": {
        const ids = props.groupIds ?? [];
        if (ids.length > 1 && ids.includes(d.id) && props.onRemoveMany) props.onRemoveMany(ids);
        else props.onRemove(d.id);
        break;
      }
      default:
        return; // submenu hosts don't act on click
    }
    props.onClose();
  }

  onMount(() => {
    const onDown = (e: MouseEvent) => {
      if (!root.contains(e.target as Node)) props.onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    });
  });

  return (
    <div
      ref={(el) => { root = el; fitMenuRef(() => props.anchor)(el); }}
      class="drawing-context-menu"
      role="menu"
      data-qa-id="drawing-context-menu"
      style={{ position: "fixed", "z-index": 220 }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <table>
        <tbody>
          <For each={rows()}>
            {(row) => {
              if (row.kind === "separator") {
                return (
                  <tr class="drawing-context-menu-separator" role="separator">
                    <td colSpan={2}>
                      <div class="drawing-context-menu-separator-line" />
                    </td>
                  </tr>
                );
              }
              const label = typeof row.label === "function" ? row.label(props.drawing) : row.label;
              const isChecked = row.checked ? row.checked(props.drawing) : false;
              const isDisabled = row.disabled ? row.disabled(props.drawing) : false;
              return (
                <tr
                  role="menuitem"
                  aria-haspopup={row.submenu ? "menu" : undefined}
                  aria-disabled={isDisabled || undefined}
                  class={"drawing-context-menu-item" + (isChecked ? " checked" : "") + (isDisabled ? " disabled" : "")}
                  data-name={row.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!isDisabled) invoke(row.id);
                  }}
                  onPointerEnter={(e) => {
                    if (row.submenu) {
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      setOrderAnchor({ x: r.right + 2, y: r.top - 6, id: row.id });
                    } else {
                      setOrderAnchor(null);
                    }
                  }}
                >
                  <td class="drawing-context-menu-icon-cell">
                    <Show when={isChecked} fallback={row.iconName && <Icon name={row.iconName} size={20} />}>
                      <span class="drawing-context-menu-checkmark">
                        <svg viewBox="0 0 28 28" width="20" height="20">
                          <path fill="currentColor" d="M22 9.06 11 20 6 14.7l1.09-1.02 3.94 4.16L20.94 8 22 9.06Z" />
                        </svg>
                      </span>
                    </Show>
                  </td>
                  <td>
                    <div class="drawing-context-menu-content">
                      <span class={"drawing-context-menu-label" + (isChecked ? " checked" : "")}>{label}</span>
                      {row.shortcut && (
                        <span class="drawing-context-menu-shortcut">{row.shortcut}</span>
                      )}
                      {row.submenu && (
                        <span class="drawing-context-menu-subarrow" aria-hidden="true">
                          <svg viewBox="0 0 16 16" width="11" height="11">
                            <path fill="currentColor" d="M6 3l5 5-5 5z" />
                          </svg>
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              );
            }}
          </For>
        </tbody>
      </table>

      <Show when={orderAnchor()?.id === "degree" ? orderAnchor() : null}>
        {(a) => (
          <div
            class="drawing-context-menu drawing-context-submenu"
            role="menu"
            ref={fitMenuRef(() => a())}
            style={{ position: "fixed", "z-index": 221 }}
          >
            <table>
              <tbody>
                <For each={[...ELLIOTT_DEGREE_NAMES]}>
                  {(name, i) => {
                    const on = () => (props.drawing.style.elliottDegree ?? ELLIOTT_DEFAULT_DEGREE) === i();
                    return (
                      <tr
                        role="menuitemradio"
                        aria-checked={on()}
                        class={"drawing-context-menu-item" + (on() ? " checked" : "")}
                        data-name={`degree-${i()}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onUpdate({ ...props.drawing, style: { ...props.drawing.style, elliottDegree: i() } } as Drawing);
                          props.onClose();
                        }}
                      >
                        <td class="drawing-context-menu-icon-cell">
                          <Show when={on()}>
                            <span class="drawing-context-menu-checkmark">
                              <svg viewBox="0 0 28 28" width="20" height="20">
                                <path fill="currentColor" d="M22 9.06 11 20 6 14.7l1.09-1.02 3.94 4.16L20.94 8 22 9.06Z" />
                              </svg>
                            </span>
                          </Show>
                        </td>
                        <td>
                          <div class="drawing-context-menu-content">
                            <span class={"drawing-context-menu-label" + (on() ? " checked" : "")}>{name}</span>
                          </div>
                        </td>
                      </tr>
                    );
                  }}
                </For>
              </tbody>
            </table>
          </div>
        )}
      </Show>

      <Show when={orderAnchor()?.id === "visual-order" ? orderAnchor() : null}>
        {(a) => (
          <div
            class="drawing-context-menu drawing-context-submenu"
            role="menu"
            ref={fitMenuRef(() => a())}
            style={{ position: "fixed", "z-index": 221 }}
          >
            <table>
              <tbody>
                <For each={ORDER_ROWS}>
                  {([dir, label]) => (
                    <tr
                      role="menuitem"
                      class="drawing-context-menu-item"
                      data-name={dir}
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onReorder(props.drawing.id, dir);
                        props.onClose();
                      }}
                    >
                      <td class="drawing-context-menu-icon-cell" />
                      <td>
                        <div class="drawing-context-menu-content">
                          <span class="drawing-context-menu-label">{label}</span>
                        </div>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        )}
      </Show>
    </div>
  );
}
