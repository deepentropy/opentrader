/*
 * Table drawings in the overlay: cell operations (insert / remove a row or
 * column), the anchor toggle, and the in-place cell editor.
 */
import { createEffect, createMemo, Show, type JSX } from "solid-js";
import type { Accessor } from "solid-js";
import type { Drawing } from "lightweight-charts-drawing/core/types";
import { screenPoints } from "lightweight-charts-drawing/core/interact/project";
import { toggleAnchored as toggleAnchoredDrawing } from "lightweight-charts-drawing/core/interact/anchor";
import { tableCanRemove, tableInsert, tableLayout, tableNextCell, tableRemove, tableWithText, TABLE_BORDER, TABLE_LINE_HEIGHT, TABLE_PAD, type TableCellRef, type TableLayout } from "lightweight-charts-drawing/core/kinds/table";
import { setTableUi, tableUi } from "../table-ui";
import { emitAppEvent } from "../../../data/app-events";
import { type OverlayCx } from "./context";

/** What createTables adds to the overlay context. */
export interface TablesApi {
  TableCellEditor: () => JSX.Element;
  tableEditKey: Accessor<string | null>;
  tableEditor: Accessor<{ d: Drawing; l: TableLayout; r: number; col: number; top: number } | null>;
  tableOp: (id: string, op: "insert-column" | "insert-row" | "remove-row" | "remove-column") => void;
  toggleAnchored: (id: string) => void;
}

export function createTables(cx: OverlayCx): TablesApi {
  const { notShown, props, size } = cx;
  // ── Table cell editing and cell operations ──────────────────────────────
  // The active cell resets when its table is no longer selected.
  createEffect(() => {
    const u = tableUi();
    if (u && !cx.selIds().includes(u.id)) setTableUi(null);
  });
  /** Table actions: insert a column / row (right of / below the active
   *  cell, else at the end; the active cell is kept) or remove the active
   *  cell's row / column (never the last one). One undo entry each. */
  function tableOp(id: string, op: "insert-column" | "insert-row" | "remove-row" | "remove-column") {
    const d = props.drawings.find((x) => x.id === id);
    if (!d || d.kind !== "table") return;
    const u = tableUi();
    const cell = u && u.id === id ? u.cell : null;
    emitAppEvent("drawing-gesture-end");
    if (op === "insert-column" || op === "insert-row") {
      props.onUpdate({ ...d, style: { ...d.style, ...tableInsert(d.style, op === "insert-row" ? "row" : "column", cell) } } as Drawing);
    } else {
      const kind = op === "remove-row" ? "row" : "column";
      if (!cell || !tableCanRemove(d.style, kind)) return;
      const r = tableRemove(d.style, kind, cell);
      props.onUpdate({ ...d, style: { ...d.style, ...r.patch } } as Drawing);
      setTableUi({ id, cell: r.cell, editing: u?.editing ?? false, edge: null });
    }
    emitAppEvent("drawing-gesture-end");
  }
  /** "Anchor drawing" toggle (core interact/anchor: text, pin, table). */
  function toggleAnchored(id: string) {
    const d = props.drawings.find((x) => x.id === id);
    const f = d ? cx.frameOf(d) : null;
    if (!d || !f) return;
    const next = toggleAnchoredDrawing(d, f.coords, f.dims);
    if (next) props.onUpdate(next);
  }

  /** Key of the cell being edited (the editor re-mounts per cell). */
  const tableEditKey = createMemo(() => {
    const u = tableUi();
    return u?.editing && u.cell ? `${u.id}|${u.cell[0]}|${u.cell[1]}` : null;
  });
  /** Editor geometry: the cell's text box (text renderer box less padding). */
  const tableEditor = createMemo(() => {
    const u = tableUi();
    if (!u?.editing || !u.cell) return null;
    void props.coordEpoch;
    void size();
    const d = props.drawings.find((x) => x.id === u.id);
    const f = d ? cx.frameOf(d) : null;
    if (!f || !d || d.kind !== "table" || notShown(d)) return null;
    const p = screenPoints(f.coords, d, f.dims)?.[0];
    if (!p) return null;
    const l = tableLayout(d, p);
    const [r, col] = u.cell;
    if (r >= l.ys.length - 1 || col >= l.xs.length - 1) return null;
    return { d, l, r, col, top: f.top };
  });

  /** The table in-place cell editor (see the overlay's JSX). */
  function TableCellEditor() {
    return (
      <Show when={props.active !== false && tableEditKey()} keyed>
        {(key) => {
          const [id, r0, c0] = key.split("|");
          const cell: TableCellRef = [Number(r0), Number(c0)];
          const geo = () => {
            const te = tableEditor();
            if (!te) return null;
            const { l, r, col } = te;
            return {
              left: l.xs[col] + TABLE_BORDER + TABLE_PAD,
              top: te.top + l.ys[r] + TABLE_BORDER + TABLE_PAD,
              width: Math.max(0, l.xs[col + 1] - l.xs[col] - 2 * (TABLE_BORDER + TABLE_PAD)),
              height: Math.max(0, l.ys[r + 1] - l.ys[r] - 2 * (TABLE_BORDER + TABLE_PAD)),
              fs: l.fs,
              color: te.d.style.textColor ?? "#dbdbdb",
              align: te.d.style.horzLabelsAlign ?? "left",
            };
          };
          const writeText = (text: string) => {
            const d = props.drawings.find((x) => x.id === id);
            if (d) props.onUpdate({ ...d, style: { ...d.style, ...tableWithText(d.style, cell, text) } } as Drawing);
          };
          return (
            <Show when={geo()}>
              {(g) => (
                <textarea
                  ref={(el) => {
                    const d = props.drawings.find((x) => x.id === id);
                    el.value = d?.kind === "table" ? d.style.tableCells?.[cell[0]]?.[cell[1]] ?? "" : "";
                    queueMicrotask(() => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
                  }}
                  class="ot-table-cell-input"
                  spellcheck={false}
                  style={{
                    left: `${g().left}px`,
                    // The SVG line box is fs tall (centre at fs / 2 + 0.05 fs);
                    // the textarea line box is 1.3 fs with the text centred.
                    top: `${g().top - 0.1 * g().fs}px`,
                    width: `${g().width}px`,
                    height: `${g().height + 0.3 * g().fs}px`,
                    "font-size": `${g().fs}px`,
                    "line-height": String(TABLE_LINE_HEIGHT),
                    color: g().color,
                    "caret-color": g().color,
                    "text-align": g().align,
                  }}
                  onInput={(e) => writeText(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Tab") {
                      e.preventDefault();
                      const d = props.drawings.find((x) => x.id === id);
                      if (d) setTableUi({ id, cell: tableNextCell(d.style, cell, e.shiftKey), editing: true, edge: null });
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setTableUi((u) => (u && u.id === id ? { ...u, cell: null, editing: false } : u));
                    }
                  }}
                  onBlur={() => {
                    // Leaving the editor keeps the active cell (the blue border
                    // stays while the table is selected).
                    setTableUi((u) => (u && u.id === id && u.editing && u.cell && u.cell[0] === cell[0] && u.cell[1] === cell[1] ? { ...u, editing: false } : u));
                  }}
                />
              )}
            </Show>
          );
        }}
      </Show>
    );
  }

  return { TableCellEditor, tableEditKey, tableEditor, tableOp, toggleAnchored };
}
