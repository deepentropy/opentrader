/*
 * ScreenerTable: the results table (TradingView Desktop 3.4.1):
 *   header 50 px (#000, 1 px #4a4a4a bottom), 13/15 px #8c8c8c titles, a 10 px
 *   second line for params ("High" / "1M"), the active sort column in #dbdbdb
 *   with its arrow; the other sort arrows show on header hover.
 *   Symbol column sticky on the left, with the match count under its title.
 *   Column setup (+) sticky at the header right.
 *   rows 41 px (40 + 1 px #2e2e2e), 14 px #dbdbdb; hover #2e2e2e with the
 *   ticker chip turning #2962ff / white; selected row #132042.
 * A header click opens the column menu (sort, move, remove); the arrow button
 * sorts directly (inactive: descending first, active: flips the order).
 *
 * Only the rows in view (+ overscan) are in the DOM: fixed 41 px rows with
 * spacer rows above and below keep scrolling at 60 fps with any match count.
 */
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack } from "solid-js";
import { Icon } from "../../components/Icon";
import { FLAG_HEX, type FlagColor } from "../../data/watchlist";
import {
  COLUMN_BY_ID,
  TICKER_COLUMN,
  configuredLong,
  paramShorts,
  sameColumn,
  type ColumnRef,
} from "../../data/screener-catalog";
import { DASH, formatCell } from "../../data/screener-format";
import { EXTRA_FIELDS } from "../../data/screener-query";
import type { ScanController } from "./scan-controller";
import { CategoryMenu } from "./CategoryMenu";
import { EditorHeader } from "./FilterEditor";
import { PopDivider, PopItem, Popover } from "./Popover";

// Column widths: TV sizes its table columns to their content. Here a column
// starts at its catalog width, widened so the header title fits on one line
// (13 px title + 18 px sort arrow + 2 px gap + 20 px padding) and so the cells
// on screen fit (14 px value + 10 px unit + 24 px padding). Widths only grow
// until the plan changes, so scrolling never makes columns jump back.
const FONT = '-apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif';
let measureCtx: CanvasRenderingContext2D | null = null;
function textWidth(text: string, font: string): number {
  if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
  if (!measureCtx) return 0;
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}
function headerWidth(c: ColumnRef): number {
  const def = COLUMN_BY_ID[c.id];
  return Math.max(def?.width ?? 90, Math.ceil(textWidth(def?.short ?? c.id, `13px ${FONT}`)) + 18 + 2 + 20 + 2);
}

export const ROW_H = 41;
const HEAD_H = 50;
const OVERSCAN = 8;
const SYMBOL_W = 144;
const SETUP_W = 45;

type Props = {
  ctl: ScanController;
  columns: ColumnRef[];
  /** Request field order (visible columns, then EXTRA_FIELDS present). */
  fields: string[];
  sort: { sortBy: ColumnRef; sortOrder: "asc" | "desc" };
  onSort: (col: ColumnRef, order: "asc" | "desc") => void;
  onRowClick: (ticker: string) => void;
  selected: string | null;
  flagOf: (ticker: string) => FlagColor | null;
  has: (field: string) => boolean;
  onAddColumn: (col: ColumnRef) => void;
  onRemoveColumn: (index: number) => void;
  onMoveColumn: (index: number, to: "prev" | "next" | "start" | "end") => void;
  onReplaceColumn: (index: number, col: ColumnRef) => void;
  /** Bumped by the parent when the plan changes: scroll back to the top. */
  resetKey: number;
};

export function ScreenerTable(props: Props) {
  let scroller!: HTMLDivElement;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewH, setViewH] = createSignal(600);
  const [scrolledX, setScrolledX] = createSignal(false);
  const [menu, setMenu] = createSignal<{ index: number; el: HTMLElement } | null>(null);
  const [setupOpen, setSetupOpen] = createSignal(false);
  let setupBtn!: HTMLButtonElement;

  const total = () => props.ctl.total() ?? 0;
  const range = createMemo(() => {
    const first = Math.max(0, Math.floor(scrollTop() / ROW_H) - OVERSCAN);
    const last = Math.min(total() - 1, Math.ceil((scrollTop() + viewH() - HEAD_H) / ROW_H) + OVERSCAN);
    return { first, last: Math.max(first - 1, last) };
  });
  const indices = createMemo(() => {
    const r = range();
    const out: number[] = [];
    for (let i = r.first; i <= r.last; i++) out.push(i);
    return out;
  });

  onMount(() => {
    const ro = new ResizeObserver(() => {
      setViewH(scroller.clientHeight);
      props.ctl.setVisible(range().first, Math.max(range().first, range().last));
    });
    ro.observe(scroller);
    onCleanup(() => ro.disconnect());
    props.ctl.setVisible(0, Math.ceil(scroller.clientHeight / ROW_H));
  });

  let lastReset = props.resetKey;
  const onScroll = () => {
    setScrollTop(scroller.scrollTop);
    setScrolledX(scroller.scrollLeft > 0);
    const r = range();
    props.ctl.setVisible(r.first, Math.max(r.first, r.last));
  };
  // Plan change → back to the top (read in a memo so it runs on change).
  createMemo(() => {
    const k = props.resetKey;
    if (k !== lastReset) {
      lastReset = k;
      if (scroller) {
        scroller.scrollTop = 0;
        setScrollTop(0);
      }
    }
  });

  const idx = createMemo(() => {
    const m = new Map<string, number>();
    props.fields.forEach((f, i) => m.set(f, i));
    return m;
  });
  const extra = (row: { d: (number | string | null)[] } | undefined, f: (typeof EXTRA_FIELDS)[number]) => {
    const i = idx().get(f);
    return row && i !== undefined ? row.d[i] : null;
  };
  // Content widths per column key, grown from the rows on screen.
  const [grown, setGrown] = createSignal<Record<string, number>>({});
  const colKey = (c: ColumnRef) => JSON.stringify(c);
  createEffect(
    on([() => props.resetKey, () => props.columns], () => setGrown({}), { defer: true }),
  );
  createEffect(() => {
    props.ctl.rev();
    const r = range();
    const next = { ...untrack(grown) };
    let changed = false;
    props.columns.forEach((c, ci) => {
      const def = COLUMN_BY_ID[c.id];
      let w = next[colKey(c)] ?? 0;
      for (let i = r.first; i <= r.last; i++) {
        const row = untrack(() => props.ctl.row(i));
        if (!row) continue;
        const cur = extra(row, "currency");
        const f = formatCell(def?.fmt ?? "text", row.d[ci], typeof cur === "string" ? cur : null);
        let px = textWidth(f.text, `14px ${FONT}`);
        if (f.unit && f.text !== DASH) px += textWidth(` ${f.unit}`, `500 10px ${FONT}`);
        w = Math.max(w, Math.ceil(px) + 24 + 1);
      }
      if (w !== (next[colKey(c)] ?? 0)) {
        next[colKey(c)] = w;
        changed = true;
      }
    });
    if (changed) setGrown(next);
  });
  const columnWidth = (c: ColumnRef) => {
    const def = COLUMN_BY_ID[c.id];
    // Text columns (sector, industry) keep their width and ellipsize.
    const content = def?.fmt === "text" ? 0 : grown()[colKey(c)] ?? 0;
    return Math.max(headerWidth(c), content);
  };
  const tableWidth = () => SYMBOL_W + props.columns.reduce((a, c) => a + columnWidth(c), 0) + SETUP_W;

  const isSorted = (c: ColumnRef) => sameColumn(props.sort.sortBy, c);
  const sortClick = (c: ColumnRef, e: MouseEvent) => {
    e.stopPropagation();
    props.onSort(c, isSorted(c) ? (props.sort.sortOrder === "asc" ? "desc" : "asc") : "desc");
  };

  const headCell = (c: ColumnRef, i: number) => {
    const def = COLUMN_BY_ID[c.id];
    const right = def?.align !== "left";
    const lines = paramShorts(c);
    const arrow = (
      <button
        type="button"
        class="scr-sort-btn"
        classList={{ "is-active": isSorted(c), "is-asc": isSorted(c) && props.sort.sortOrder === "asc" }}
        title={isSorted(c) ? "Change sort" : "Sort descending"}
        aria-label={isSorted(c) ? "Change sort" : "Sort descending"}
        tabIndex={-1}
        onClick={(e) => sortClick(c, e)}
      >
        <Icon name={isSorted(c) ? "scr-sort-active" : "scr-sort-inactive"} size={18} />
      </button>
    );
    return (
      <th
        class="scr-th"
        classList={{ "is-right": right, "is-sorted": isSorted(c), "is-menu": menu()?.index === i }}
        data-field={c.id}
        onClick={(e) => setMenu({ index: i, el: e.currentTarget })}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ index: i, el: e.currentTarget });
        }}
      >
        <div class="scr-th-wrap" title={configuredLong(c)}>
          <Show when={right}>{arrow}</Show>
          <div class="scr-th-title">
            <div class="scr-th-upper">{def?.short ?? c.id}</div>
            <Show when={lines.length}>
              <div class="scr-th-lower">{lines.join(", ")}</div>
            </Show>
          </div>
          <Show when={!right}>{arrow}</Show>
        </div>
      </th>
    );
  };

  type Row = { d: (number | string | null)[] };
  const cell = (c: ColumnRef, row: () => Row | undefined, ci: () => number) => {
    const def = COLUMN_BY_ID[c.id];
    const f = () => {
      const r = row();
      if (!r) return null;
      const cur = extra(r, "currency");
      return formatCell(def?.fmt ?? "text", r.d[ci()], typeof cur === "string" ? cur : null);
    };
    // Plain accessors (no Show): a row can vanish while its cells update.
    const text = () => f()?.text ?? "";
    const unit = () => {
      const x = f();
      return x && x.unit && x.text !== DASH ? x.unit : "";
    };
    const tone = () => {
      const t = f()?.tone;
      return t === "up" ? "scr-up" : t === "down" ? "scr-down" : undefined;
    };
    return (
      <td class="scr-td" classList={{ "is-right": def?.align !== "left" }}>
        <span class={tone()}>{text()}</span>
        <Show when={unit()}>
          <span class="scr-currency"> {unit()}</span>
        </Show>
      </td>
    );
  };

  // Column menu content for header i.
  const columnMenu = () => {
    const m = menu();
    if (!m) return null;
    const c = props.columns[m.index];
    if (!c) return null;
    const n = props.columns.length;
    return { m, c, n };
  };

  return (
    <div class="scr-table-scroll" ref={scroller} onScroll={onScroll} classList={{ "is-scrolled-x": scrolledX() }}>
      <table class="scr-table" style={{ width: `max(${tableWidth()}px, 100%)` }}>
        <colgroup>
          <col style={{ width: `${SYMBOL_W}px` }} />
          <For each={props.columns}>{(c) => <col style={{ width: `${columnWidth(c)}px` }} />}</For>
          {/* Last column takes the width left over (TV table fills the panel). */}
          <col />
        </colgroup>
        <thead>
          <tr>
            <th class="scr-th scr-th-symbol" classList={{ "is-sorted": isSorted(TICKER_COLUMN) }} data-field="TickerUniversal">
              <div class="scr-th-wrap" title="Symbol">
                <div class="scr-th-symbol-data">
                  <div class="scr-th-upper">Symbol</div>
                  <button
                    type="button"
                    class="scr-sort-btn"
                    classList={{ "is-active": isSorted(TICKER_COLUMN), "is-asc": isSorted(TICKER_COLUMN) && props.sort.sortOrder === "asc" }}
                    title={isSorted(TICKER_COLUMN) ? "Change sort" : "Sort descending"}
                    aria-label={isSorted(TICKER_COLUMN) ? "Change sort" : "Sort descending"}
                    tabIndex={-1}
                    onClick={(e) => sortClick(TICKER_COLUMN, e)}
                  >
                    <Icon name={isSorted(TICKER_COLUMN) ? "scr-sort-active" : "scr-sort-inactive"} size={18} />
                  </button>
                  <span class="scr-th-count">{props.ctl.total() ?? ""}</span>
                </div>
              </div>
            </th>
            <For each={props.columns}>{(c, i) => headCell(c, i())}</For>
            <th class="scr-th scr-th-setup">
              <button
                ref={setupBtn}
                type="button"
                class="scr-setup-btn"
                classList={{ "is-open": setupOpen() }}
                title="Column setup"
                aria-label="Column setup"
                onClick={() => setSetupOpen(!setupOpen())}
              >
                <Icon name="scr-add" size={28} />
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr class="scr-spacer" style={{ height: `${range().first * ROW_H}px` }} />
          <For each={indices()}>
            {(i) => {
              const row = () => props.ctl.row(i);
              const ticker = () => row()?.s ?? "";
              const flag = () => (ticker() ? props.flagOf(ticker()) : null);
              const desc = () => extra(row(), "description");
              return (
                <tr
                  class="scr-tr"
                  classList={{ "is-selected": !!ticker() && ticker() === props.selected, "is-skeleton": !row() }}
                  onClick={() => ticker() && props.onRowClick(ticker())}
                >
                  <td class="scr-td scr-td-symbol">
                    <Show when={row()}>
                      <span class="scr-ticker-cell">
                        <Show when={flag()} keyed>
                          {(fl) => (
                            <span class="scr-row-flag" style={{ color: FLAG_HEX[fl] }}>
                              <Icon name="scr-flag" />
                            </span>
                          )}
                        </Show>
                        <span class="ot-ticker-logo ot-ticker-logo--md scr-row-logo" aria-hidden="true">{ticker().charAt(0)}</span>
                        <span class="scr-ticker-chip" title={desc() ? `${ticker()} − ${desc()}` : ticker()}>{ticker()}</span>
                      </span>
                    </Show>
                  </td>
                  <For each={props.columns}>{(c, ci) => cell(c, row, ci)}</For>
                  <td class="scr-td" />
                </tr>
              );
            }}
          </For>
          <tr class="scr-spacer" style={{ height: `${Math.max(0, total() - range().last - 1) * ROW_H}px` }} />
        </tbody>
      </table>
      <Show when={props.ctl.total() === 0}>
        <div class="scr-empty">No symbols match your filters</div>
      </Show>
      <Show when={props.ctl.error()} keyed>
        {(e) => <div class="scr-empty scr-error">{e}</div>}
      </Show>

      <Show when={columnMenu()} keyed>
        {(x) => (
          <Popover anchor={x.m.el} onClose={() => setMenu(null)} width={260}>
            <EditorHeader
              col={x.c}
              has={props.has}
              onRemove={() => {
                const i = x.m.index;
                setMenu(null);
                props.onRemoveColumn(i);
              }}
              onParam={(col) => props.onReplaceColumn(x.m.index, col)}
            />
            <PopDivider />
            <PopItem
              title="Sort ascending"
              icon="scr-menu-sort-asc"
              selected={isSorted(x.c) && props.sort.sortOrder === "asc"}
              onClick={() => {
                const c = x.c;
                setMenu(null);
                props.onSort(c, "asc");
              }}
            />
            <PopItem
              title="Sort descending"
              icon="scr-menu-sort-desc"
              selected={isSorted(x.c) && props.sort.sortOrder === "desc"}
              onClick={() => {
                const c = x.c;
                setMenu(null);
                props.onSort(c, "desc");
              }}
            />
            <Show when={x.n > 1}>
              <PopDivider />
              <Show when={x.m.index > 0}>
                <PopItem title="Move left" icon="scr-menu-move-left" onClick={() => { const i = x.m.index; setMenu(null); props.onMoveColumn(i, "prev"); }} />
              </Show>
              <Show when={x.m.index < x.n - 1}>
                <PopItem title="Move right" icon="scr-menu-move-right" onClick={() => { const i = x.m.index; setMenu(null); props.onMoveColumn(i, "next"); }} />
              </Show>
              <Show when={x.m.index > 0}>
                <PopItem title="Move to the start" icon="scr-menu-move-start" onClick={() => { const i = x.m.index; setMenu(null); props.onMoveColumn(i, "start"); }} />
              </Show>
              <Show when={x.m.index < x.n - 1}>
                <PopItem title="Move to the end" icon="scr-menu-move-end" onClick={() => { const i = x.m.index; setMenu(null); props.onMoveColumn(i, "end"); }} />
              </Show>
            </Show>
          </Popover>
        )}
      </Show>
      <Show when={setupOpen()}>
        <CategoryMenu
          anchor={setupBtn}
          kind="columns"
          has={props.has}
          onPick={(col) => {
            props.onAddColumn(col);
            setSetupOpen(false);
          }}
          onClose={() => setSetupOpen(false)}
        />
      </Show>
    </div>
  );
}
