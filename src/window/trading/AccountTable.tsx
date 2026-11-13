/*
 * The account manager's tables (#140), as the reference app's: a click on a header sorts (ascending, descending,
 * none), headers are dragged to reorder the columns, the last header cell holds "Column setup" (a check box per
 * column; the Symbol column always shows, the last shown column cannot be hidden), the Symbol column stays in view
 * when the table scrolls sideways, a right click on a row opens its menu. Order, shown columns and sort are kept per
 * table. The same columns write the table's CSV ("Download data").
 */
import { For, Show, createMemo, createSignal, type JSX } from "solid-js";
import { CheckMarkBox } from "../../components/form";
import { Tooltip } from "../../components/Tooltip";
import { translate } from "../../i18n/translator";
import { Popover, PopDivider, PopItem } from "../screener/Popover";
import { isShown, ordered, saveState, sortedRows, tableState, type Column, type Sort } from "./account-table-model";

export { tableCsv, type Column } from "./account-table-model";

export type RowMenuItem = { title: string; onClick: () => void; disabled?: boolean } | "divider";

const ColumnsIcon = () => (
  <svg viewBox="0 0 18 18" width="18" height="18" fill="none" aria-hidden="true">
    <path
      fill="currentColor"
      fill-rule="evenodd"
      clip-rule="evenodd"
      d="m4 4h-2v10h2zm-2-1c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h2c.55 0 1-.45 1-1v-10c0-.55-.45-1-1-1zm8 1h-2v10h2zm-2-1c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h2c.55 0 1-.45 1-1v-10c0-.55-.45-1-1-1zm6 1h2v10h-2zm-1 0c0-.55.45-1 1-1h2c.55 0 1 .45 1 1v10c0 .55-.45 1-1 1h-2c-.55 0-1-.45-1-1z"
    />
  </svg>
);
const SortArrow = (p: { dir: "asc" | "desc" }) => (
  <svg class="trd-sort-arrow" classList={{ "is-up": p.dir === "asc" }} viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
    <path fill="currentColor" d="M4.5 1h1v6.1l2.15-2.15.7.7L5 9 1.65 5.65l.7-.7L4.5 7.1z" />
  </svg>
);

export function AccountTable<T>(props: {
  id: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  empty: string;
  onRow?: (row: T) => void;
  actions?: (row: T) => JSX.Element;
  muted?: (row: T) => boolean;
  menu?: (row: T) => RowMenuItem[];
}) {
  const [state] = tableState(props.id);
  const all = createMemo(() => ordered(props.columns, state()));
  const shown = createMemo(() => all().filter((c) => isShown(c, state())));
  const rows = createMemo(() => sortedRows(props.id, props.columns, props.rows));
  const [setupOpen, setSetupOpen] = createSignal(false);
  const [menuAt, setMenuAt] = createSignal<{ x: number; y: number; items: RowMenuItem[] } | null>(null);
  const [dragging, setDragging] = createSignal<string | null>(null);
  const [dropOn, setDropOn] = createSignal<string | null>(null);
  let setupBtn: HTMLButtonElement | undefined;
  let menuAnchor: HTMLDivElement | undefined;

  const cycleSort = (id: string) => {
    const s = state().sort;
    const next: Sort | null = s?.id !== id ? { id, dir: "asc" } : s.dir === "asc" ? { id, dir: "desc" } : null;
    saveState(props.id, { ...state(), sort: next });
  };
  const toggleColumn = (id: string) => {
    const on = shown().map((c) => c.id);
    const next = on.includes(id) ? on.filter((x) => x !== id) : [...on, id];
    saveState(props.id, { ...state(), shown: next });
  };
  const move = (from: string, to: string) => {
    if (from === to) return;
    // Dropped on a column: it takes that column's place (after it when moved right, before it when moved left).
    const ids = all()
      .filter((c) => !c.fixed)
      .map((c) => c.id);
    const at = ids.indexOf(to);
    ids.splice(ids.indexOf(from), 1);
    ids.splice(at, 0, from);
    saveState(props.id, { ...state(), order: ids });
  };
  const toggleable = () => all().filter((c) => !c.fixed);
  const shownToggleable = () => shown().filter((c) => !c.fixed).length;

  return (
    <Show when={props.rows.length > 0} fallback={<div class="trd-empty"><div class="trd-empty-text">{props.empty}</div></div>}>
      <table class="trd-table" data-table={props.id}>
        <thead>
          <tr>
            <For each={shown()}>
              {(c) => {
                const sorted = () => (state().sort?.id === c.id ? state().sort!.dir : null);
                return (
                  <th
                    classList={{ "is-num": c.num, "is-fixed": c.fixed, "is-sorted": !!sorted(), "is-drop": dropOn() === c.id && dragging() !== c.id }}
                    draggable={!c.fixed}
                    aria-sort={sorted() === "asc" ? "ascending" : sorted() === "desc" ? "descending" : undefined}
                    onClick={() => cycleSort(c.id)}
                    onDragStart={(e) => {
                      setDragging(c.id);
                      e.dataTransfer?.setData("text/plain", c.id);
                      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragOver={(e) => {
                      if (!dragging() || c.fixed) return;
                      e.preventDefault();
                      setDropOn(c.id);
                    }}
                    onDragLeave={() => dropOn() === c.id && setDropOn(null)}
                    onDrop={(e) => {
                      e.preventDefault();
                      const from = dragging();
                      if (from && !c.fixed) move(from, c.id);
                      setDragging(null);
                      setDropOn(null);
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setDropOn(null);
                    }}
                  >
                    <span class="trd-th-label">
                      {c.title()}
                      <Show when={sorted()}>{(d) => <SortArrow dir={d()} />}</Show>
                    </span>
                  </th>
                );
              }}
            </For>
            <th class="trd-actions-col">
              <Tooltip text="Column setup" side="top">
                <button
                  ref={setupBtn}
                  type="button"
                  class="trd-row-btn trd-col-setup"
                  classList={{ "is-open": setupOpen() }}
                  aria-label={translate("Column setup")}
                  aria-haspopup="menu"
                  aria-expanded={setupOpen()}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSetupOpen(!setupOpen());
                  }}
                >
                  <ColumnsIcon />
                </button>
              </Tooltip>
            </th>
          </tr>
        </thead>
        <tbody>
          <For each={rows()}>
            {(row) => (
              <tr
                classList={{ "is-muted": props.muted?.(row) ?? false }}
                onClick={() => props.onRow?.(row)}
                onContextMenu={(e) => {
                  const items = props.menu?.(row);
                  if (!items?.length) return;
                  e.preventDefault();
                  setMenuAt({ x: e.clientX, y: e.clientY, items });
                }}
                data-key={props.rowKey(row)}
              >
                <For each={shown()}>{(c) => <td classList={{ "is-num": c.num, "is-fixed": c.fixed }}>{c.cell(row)}</td>}</For>
                <td class="trd-actions-col" onClick={(e) => e.stopPropagation()}>
                  <Show when={props.actions}>
                    <div class="trd-row-actions">{props.actions!(row)}</div>
                  </Show>
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <Show when={setupOpen()}>
        <Popover anchor={setupBtn} onClose={() => setSetupOpen(false)} class="trd-col-menu" maxHeight={360} offset={{ x: 0, y: 4 }}>
          <div role="menu">
            <For each={toggleable()}>
              {(c) => {
                const on = () => shown().some((x) => x.id === c.id);
                const locked = () => on() && shownToggleable() <= 1;
                return (
                  <div
                    role="menuitemcheckbox"
                    aria-checked={on()}
                    aria-disabled={locked() || undefined}
                    class="scr-item trd-col-item"
                    classList={{ "is-disabled": locked() }}
                    onClick={() => !locked() && toggleColumn(c.id)}
                  >
                    <CheckMarkBox checked={on()} variant="menu" />
                    <span class="scr-item-title">{c.title()}</span>
                  </div>
                );
              }}
            </For>
          </div>
        </Popover>
      </Show>
      <Show when={menuAt()}>
        {(m) => (
          <>
            <div ref={menuAnchor} class="trd-menu-point" style={{ left: `${m().x}px`, top: `${m().y}px` }} />
            <Popover anchor={menuAnchor} onClose={() => setMenuAt(null)} class="trd-row-menu" minWidth={200}>
              <For each={m().items}>
                {(it) =>
                  it === "divider" ? (
                    <PopDivider />
                  ) : (
                    <PopItem
                      title={it.title}
                      disabled={it.disabled}
                      onClick={() => {
                        setMenuAt(null);
                        it.onClick();
                      }}
                    />
                  )
                }
              </For>
            </Popover>
          </>
        )}
      </Show>
    </Show>
  );
}
