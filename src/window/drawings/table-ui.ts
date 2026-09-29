/*
 * Table UI state (the in-place editable cell + the text edit mode): the
 * active cell of the selected table, whether its editor is open, the hovered
 * resize edge. OpenTrader-only (SolidJS signal); the table geometry is in
 * the shared core (lightweight-charts-drawing/tv/kinds/table).
 */
import { createSignal } from "solid-js";
import type { TableUi } from "lightweight-charts-drawing/tv/kinds/table";

const [tableUi, setTableUi] = createSignal<TableUi | null>(null);
export { tableUi, setTableUi };
