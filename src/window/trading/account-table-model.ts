/*
 * The account manager tables' columns, kept state and CSV (#140): the logic behind AccountTable.tsx. Per table, kept
 * under its id: the column order, the shown columns (until changed: every column not `hidden`) and the sort.
 */
import { createSignal, type JSX } from "solid-js";
import * as kv from "../../data/kv";
import { csvField } from "../screener/screener-csv";

export type Column<T> = {
  id: string;
  title: () => string;
  num?: boolean;
  /** Shown only once the user picks it in Column setup. */
  hidden?: boolean;
  /** Always shown, first, not dragged (Symbol). */
  fixed?: boolean;
  cell: (row: T) => JSX.Element;
  /** The sort and CSV value (text as shown for text columns, the raw number for numbers). */
  value: (row: T) => string | number | null | undefined;
};

export type Sort = { id: string; dir: "asc" | "desc" };
export type TableState = { order?: string[]; shown?: string[]; sort?: Sort | null };

const keyOf = (id: string) => `ot:trading:table:${id}`;
const states = new Map<string, ReturnType<typeof createSignal<TableState>>>();

/** The kept state of a table, one signal per table id (shared by its views and its CSV). */
export function tableState(id: string) {
  let s = states.get(id);
  if (!s) {
    let v: TableState = {};
    try {
      v = (JSON.parse(kv.getItem(keyOf(id)) ?? "null") as TableState | null) ?? {};
    } catch {
      v = {};
    }
    s = createSignal<TableState>(v);
    states.set(id, s);
  }
  return s;
}

export function saveState(id: string, next: TableState) {
  tableState(id)[1](next);
  kv.setItem(keyOf(id), JSON.stringify(next));
}

/** The columns in their kept order (new columns at their place in the definition). */
export function ordered<T>(cols: Column<T>[], st: TableState): Column<T>[] {
  const fixed = cols.filter((c) => c.fixed);
  const rest = cols.filter((c) => !c.fixed);
  const order = st.order ?? [];
  const known = rest.filter((c) => order.includes(c.id)).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const fresh = rest.filter((c) => !order.includes(c.id));
  for (const c of fresh) known.splice(Math.min(rest.indexOf(c), known.length), 0, c);
  return [...fixed, ...known];
}

export const isShown = <T,>(c: Column<T>, st: TableState) => c.fixed || (st.shown ? st.shown.includes(c.id) : !c.hidden);

/** The shown columns in order. */
export function visibleColumns<T>(id: string, cols: Column<T>[]): Column<T>[] {
  const st = tableState(id)[0]();
  return ordered(cols, st).filter((c) => isShown(c, st));
}

function compare(a: unknown, b: unknown): number {
  const none = (v: unknown) => v === null || v === undefined || v === "";
  if (none(a) || none(b)) return none(a) ? (none(b) ? 0 : 1) : -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

/** The rows in the table's sort (empty values last); unsorted: as given. */
export function sortedRows<T>(id: string, cols: Column<T>[], rows: T[]): T[] {
  const sort = tableState(id)[0]().sort;
  const col = sort ? cols.find((c) => c.id === sort.id) : undefined;
  if (!sort || !col) return rows;
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = col.value(a);
    const vb = col.value(b);
    const none = (v: unknown) => v === null || v === undefined || v === "";
    if (none(va) || none(vb)) return compare(va, vb);
    return sign * compare(va, vb);
  });
}

/** CSV of a table: the shown columns in order, the rows in the table's sort. */
export function tableCsv<T>(id: string, cols: Column<T>[], rows: T[]): string {
  const shown = visibleColumns(id, cols);
  const text = (v: string | number | null | undefined) => (v === null || v === undefined ? "" : String(v));
  const lines = sortedRows(id, cols, rows).map((r) => shown.map((c) => csvField(text(c.value(r)))).join(","));
  return [shown.map((c) => csvField(c.title())).join(","), ...lines].join("\n");
}

/** "<broker>-<tab>-<yyyy-mm-dd>.csv" (the local date), the characters a file name cannot hold replaced. */
export function tradingCsvName(broker: string, tab: string, now = new Date()): string {
  const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return `${broker}-${tab}-${d}.csv`.replace(/[\\/:*?"<>|]/g, "_");
}
