/*
 * Right-click context menu of a selected drawing, on the chart's context menu.
 *
 * Rows (reference order). One drawing:
 *   [tool actions placed first (table cells)] ─
 *   Add / Edit alert on <tool>… ─
 *   Template ▸, Visual order ▸, Visibility on intervals ▸, Object tree ─
 *   Clone, Copy ─ No sync / Sync in layout / Sync globally ─
 *   [tool actions placed last (Elliott degree, bars pattern)] ─ [Anchor ─]
 *   Lock, Hide, Remove ─ Settings…
 * Several drawings: Template ▸ (one tool only), Object tree, Visual order ▸,
 * Visibility on intervals ▸ ─ Clone, Copy ─ sync ─ Lock, Hide, Remove ─
 * Settings… (no alert row).
 * Visual order rows that would not move the drawing are disabled. Template:
 * Save as… (one drawing), Apply default, the tool's saved templates (trash on
 * hover). Visibility on intervals: the four quick settings of the
 * Visibility tab on the chart interval.
 */
import type { Drawing } from "lightweight-charts-drawing/core/types";
import { ELLIOTT_DEFAULT_DEGREE, ELLIOTT_DEGREE_NAMES, ELLIOTT_KINDS } from "lightweight-charts-drawing/core/specs";
import { tableCanRemove, type TableCellRef } from "lightweight-charts-drawing/core/kinds/table";
import { Icon } from "../../components/Icon";
import { showConfirm, showRename } from "../../components/Dialogs";
import { ChartContextMenu, CtxIcons, type CtxNode } from "../chart/ChartContextMenu";
import { visibilityForMode, type IntervalsVisibilityMode } from "../chart/interval-visibility-mode";
import { deleteTemplate, loadTemplates, saveTemplate, type DrawingTemplate } from "./templates";
import type { SyncMode } from "./DrawingToolbar";

type Order = "front" | "forward" | "backward" | "back";

type Props = {
  drawing: Drawing;
  /** The selected drawings (the clicked one included). */
  group?: Drawing[];
  /** Full multi-selection the drawing belongs to, locked ones left out: Remove acts on every member when longer
   *  than 1. */
  groupIds?: string[];
  anchor: { x: number; y: number };
  /** Chart interval, for the Visibility on intervals rows. */
  interval?: string;
  /** Which Visual order moves would change the drawing order. */
  orderSteps?: Record<Order, boolean>;
  /** The alert row: "Edit" when the drawing has an alert; null: none (a drawing an alert cannot use). */
  alert?: { edit: boolean; name: string } | null;
  /** Current sync of the drawings (null: mixed); undefined: no sync rows. */
  sync?: SyncMode | null;
  /** Set for a drawing that can be anchored to the pane. */
  anchored?: boolean;
  onClose: () => void;
  onUpdate: (d: Drawing) => void;
  onUpdateMany?: (list: Drawing[]) => void;
  onClone: (id: string) => void;
  onCopy: (d: Drawing) => void;
  onReorder: (id: string, dir: Order) => void;
  onRemove: (id: string) => void;
  /** Bulk delete for the group Remove — one undo entry. */
  onRemoveMany?: (ids: string[]) => void;
  /** Open the settings dialog, optionally on a specific tab. */
  onOpenSettings: (id: string, tab?: "Style" | "Text" | "Coordinates" | "Visibility") => void;
  onAlert?: () => void;
  onObjectTree?: () => void;
  onSync?: (ids: string[], mode: SyncMode) => void;
  onToggleAnchor?: () => void;
  /** A saved template / the factory style on the drawings of the tool. */
  onApplyTemplate?: (tpl: DrawingTemplate) => void;
  onApplyDefault?: () => void;
  /** Table: the active cell (the in-place editable cell) and the cell operations of the table actions. */
  tableCell?: TableCellRef | null;
  onTableOp?: (op: "insert-column" | "insert-row" | "remove-row" | "remove-column") => void;
};

const SEP: CtxNode = { kind: "separator" };
/** Icon component nodes: one per row (a node renders in one place). */
const icon = (name: string) => () => <Icon name={name} size={18} />;

export function DrawingContextMenu(props: Props) {
  const group = () => (props.group?.length ? props.group : [props.drawing]);
  const multi = () => group().length > 1;
  /** Drawings a row acts on: the selection. */
  const apply = (next: Drawing[]) => {
    if (next.length > 1 && props.onUpdateMany) props.onUpdateMany(next);
    else for (const d of next) props.onUpdate(d);
  };

  function templateRow(): CtxNode | null {
    const kind = props.drawing.kind;
    if (group().some((d) => d.kind !== kind)) return null;
    const rows: CtxNode[] = [];
    if (!multi()) {
      rows.push({
        kind: "item", id: "template-save", label: "Save as…",
        onSelect: () => {
          const snapshot = { style: props.drawing.style, text: (props.drawing as { text?: string }).text };
          showRename({
            title: "Save drawing template",
            label: "New template name",
            maxLength: 64,
            names: loadTemplates(kind).map((t) => t.name),
            replaceText: (n) => `Drawing template "${n}" already exists. Do you really want to replace it?`,
            onSave: (n) => { saveTemplate(kind, { name: n, ...snapshot }); },
          });
        },
      });
    }
    rows.push({ kind: "item", id: "template-default", label: "Apply default", onSelect: () => props.onApplyDefault?.() });
    const saved = loadTemplates(kind);
    if (saved.length) rows.push(SEP);
    for (const t of saved) {
      rows.push({
        kind: "item", id: `template-${t.name}`, label: t.name,
        onSelect: () => props.onApplyTemplate?.(t),
        onRemove: () => showConfirm({
          title: "Delete this template?",
          text: `Doing this will permanently delete your "${t.name}" drawing template.`,
          mainText: "Delete",
          cancelText: "Cancel",
          intent: "danger",
          onConfirm: () => { deleteTemplate(kind, t.name); },
        }),
      });
    }
    return { kind: "item", id: "template", label: "Template", submenu: rows };
  }

  function orderRow(): CtxNode {
    const steps = props.orderSteps;
    const row = (dir: Order, label: string): CtxNode => ({
      kind: "item", id: `order-${dir}`, label, disabled: steps ? !steps[dir] : false,
      onSelect: () => props.onReorder(props.drawing.id, dir),
    });
    return {
      kind: "item", id: "visual-order", label: "Visual order", icon: CtxIcons.order,
      submenu: [row("front", "Bring to front"), row("back", "Send to back"), row("forward", "Bring forward"), row("backward", "Send backward")],
    };
  }

  function visibilityRow(): CtxNode {
    const row = (mode: IntervalsVisibilityMode, label: string): CtxNode => ({
      kind: "item", id: `vis-${mode}`, label,
      onSelect: () => {
        const visibility = visibilityForMode(props.interval ?? "1D", mode);
        apply(group().map((d) => ({ ...d, visibility } as Drawing)));
      },
    });
    return {
      kind: "item", id: "visibility-intervals", label: "Visibility on intervals",
      submenu: [
        row("currentAndAbove", "Current interval and above"),
        row("currentAndBelow", "Current interval and below"),
        row("current", "Current interval only"),
        row("all", "All intervals"),
      ],
    };
  }

  const objectTreeRow = (): CtxNode => ({ kind: "item", id: "object-tree", label: "Object tree", onSelect: () => props.onObjectTree?.() });

  function syncRows(): CtxNode[] {
    if (props.sync === undefined || !props.onSync) return [];
    const ids = group().map((d) => d.id);
    const row = (mode: SyncMode, label: string): CtxNode => ({
      kind: "item", id: `sync-${mode}`, label, checked: props.sync === mode,
      onSelect: () => { if (props.sync !== mode) props.onSync?.(ids, mode); },
    });
    return [row("none", "No sync"), row("layout", "Sync in layout"), row("global", "Sync globally")];
  }

  /** Tool actions after the others: Elliott wave degree, bars pattern mirror / flip. */
  function lastToolRows(): CtxNode[] {
    const d = props.drawing;
    if (ELLIOTT_KINDS.has(d.kind)) {
      const cur = d.style.elliottDegree ?? ELLIOTT_DEFAULT_DEGREE;
      return [{
        kind: "item", id: "degree", label: "Degree",
        submenu: [...ELLIOTT_DEGREE_NAMES].map((name, i): CtxNode => ({
          kind: "item", id: `degree-${i}`, label: name, checked: cur === i,
          onSelect: () => props.onUpdate({ ...d, style: { ...d.style, elliottDegree: i } } as Drawing),
        })),
      }];
    }
    if (d.kind === "bar-pattern") {
      return [
        { kind: "item", id: "mirrored", label: "Mirrored", checked: !!d.style.mirrored, onSelect: () => props.onUpdate({ ...d, style: { ...d.style, mirrored: !d.style.mirrored } } as Drawing) },
        { kind: "item", id: "flipped", label: "Flipped", checked: !!d.style.flipped, onSelect: () => props.onUpdate({ ...d, style: { ...d.style, flipped: !d.style.flipped } } as Drawing) },
      ];
    }
    return [];
  }

  /** Table actions, before all the others: insert column / row, and with an active cell remove row / column
   *  (disabled when it is the last one). */
  function tableRows(): CtxNode[] {
    const d = props.drawing;
    if (d.kind !== "table") return [];
    const op = (o: "insert-column" | "insert-row" | "remove-row" | "remove-column") => () => props.onTableOp?.(o);
    const rows: CtxNode[] = [
      { kind: "item", id: "table-insert-column", label: "Add column to right", icon: icon("dt-table-insert-column")(), onSelect: op("insert-column") },
      { kind: "item", id: "table-insert-row", label: "Add row below", icon: icon("dt-table-insert-row")(), onSelect: op("insert-row") },
    ];
    if (props.tableCell) {
      rows.push(
        SEP,
        { kind: "item", id: "table-remove-row", label: "Remove row", icon: icon("dt-table-remove")(), disabled: !tableCanRemove(d.style, "row"), onSelect: op("remove-row") },
        { kind: "item", id: "table-remove-column", label: "Remove column", icon: icon("dt-table-remove")(), disabled: !tableCanRemove(d.style, "column"), onSelect: op("remove-column") },
      );
    }
    return rows;
  }

  function lockHideRemove(): CtxNode[] {
    const locked = !!props.drawing.locked;
    const hidden = !!props.drawing.hidden;
    return [
      { kind: "item", id: "lock", label: locked ? "Unlock" : "Lock", icon: icon("dt-lock")(), onSelect: () => apply(group().map((d) => ({ ...d, locked: !locked } as Drawing))) },
      { kind: "item", id: "hide", label: hidden ? "Show" : "Hide", icon: hidden ? CtxIcons.show : CtxIcons.hide, onSelect: () => apply(group().map((d) => ({ ...d, hidden: !hidden } as Drawing))) },
      {
        kind: "item", id: "remove", label: "Remove", shortcut: "Del", icon: CtxIcons.remove,
        onSelect: () => {
          const ids = props.groupIds ?? [];
          if (ids.length > 1 && ids.includes(props.drawing.id) && props.onRemoveMany) props.onRemoveMany(ids);
          else props.onRemove(props.drawing.id);
        },
      },
    ];
  }

  const cloneCopy = (): CtxNode[] => [
    { kind: "item", id: "clone", label: "Clone", shortcut: "Ctrl + Drag", icon: icon("dt-cm-clone")(), onSelect: () => props.onClone(props.drawing.id) },
    { kind: "item", id: "copy", label: "Copy", shortcut: "Ctrl + C", onSelect: () => props.onCopy(props.drawing) },
  ];
  const settingsRow = (): CtxNode => ({ kind: "item", id: "settings", label: "Settings…", icon: CtxIcons.settings, onSelect: () => props.onOpenSettings(props.drawing.id) });

  function nodes(): CtxNode[] {
    const out: CtxNode[] = [];
    const sync = syncRows();
    const template = templateRow();
    if (multi()) {
      if (template) out.push(template);
      out.push(objectTreeRow(), orderRow(), visibilityRow(), SEP, ...cloneCopy(), SEP);
      if (sync.length) out.push(...sync, SEP);
      out.push(...lockHideRemove(), SEP, settingsRow());
      return out;
    }
    const first = tableRows();
    if (first.length) out.push(...first, SEP);
    if (props.alert) {
      out.push({
        kind: "item", id: "alert", label: `${props.alert.edit ? "Edit" : "Add"} alert on ${props.alert.name}…`, shortcut: "Alt + A", icon: CtxIcons.alert,
        onSelect: () => props.onAlert?.(),
      }, SEP);
    }
    if (template) out.push(template);
    out.push(orderRow(), visibilityRow(), objectTreeRow(), SEP, ...cloneCopy(), SEP);
    if (sync.length) out.push(...sync, SEP);
    const last = lastToolRows();
    if (last.length) out.push(...last, SEP);
    if (props.anchored !== undefined) {
      out.push({ kind: "item", id: "anchor", label: "Anchor", checked: props.anchored, onSelect: () => props.onToggleAnchor?.() }, SEP);
    }
    out.push(...lockHideRemove(), SEP, settingsRow());
    return out;
  }

  // Pointer presses in the menu stay out of the drawings layer (its "press on an empty spot deselects").
  return (
    <div class="drawing-context-menu-host" data-qa-id="drawing-context-menu" onPointerDown={(e) => e.stopPropagation()}>
      <ChartContextMenu x={props.anchor.x} y={props.anchor.y} nodes={nodes()} onClose={props.onClose} />
    </div>
  );
}
