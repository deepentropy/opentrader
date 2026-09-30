/*
 * CategoryMenu: the "Add new filter" (+ next to the pills) and "Column setup"
 * (+ at the table header right) popovers (TradingView Desktop 3.4.1):
 * title ("Filters" / "Columns"), Search, then the categories with their icon
 * and item count; a category opens its items under a back row. Typing in
 * Search lists the matching items of every category.
 *
 * Only catalog columns the backend serves are listed (`has`), so the counts
 * are OpenTrader's, not TradingView's.
 * Column setup: a column with a choice of params opens a configuration view
 * (param selects + "Add column") before it is added.
 */
import { For, Show, createMemo, createSignal } from "solid-js";
import {
  CATEGORIES,
  COLUMNS,
  defaultRef,
  isOffered,
  visibleParams,
  type Category,
  type ColumnDef,
  type ColumnRef,
} from "../../data/screener-catalog";
import { PopBack, PopDivider, PopItem, PopSearch, Popover, SelectButton } from "./Popover";

type Props = {
  anchor: HTMLElement | undefined;
  kind: "filters" | "columns";
  has: (field: string) => boolean;
  onPick: (col: ColumnRef) => void;
  onClose: () => void;
};

export function CategoryMenu(props: Props) {
  const [q, setQ] = createSignal("");
  const [cat, setCat] = createSignal<Category | null>(null);
  const [config, setConfig] = createSignal<{ def: ColumnDef; col: ColumnRef } | null>(null);

  const items = createMemo(() =>
    COLUMNS.filter((d) => isOffered(d, props.has) && (props.kind === "filters" ? !!d.filter : !d.noColumn)).sort((a, b) =>
      a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" }),
    ),
  );
  const cats = () => CATEGORIES.map((c) => ({ ...c, count: items().filter((d) => d.category === c.id).length })).filter((c) => c.count > 0);
  const searched = () => {
    const s = q().trim().toLowerCase();
    return items().filter((d) => d.title.toLowerCase().includes(s) || d.short.toLowerCase().includes(s));
  };

  const pick = (d: ColumnDef) => {
    const col = defaultRef(d, props.has);
    if (props.kind === "columns" && visibleParams(d, props.has).length > 0) {
      setConfig({ def: d, col });
      return;
    }
    props.onPick(col);
  };

  return (
    <Popover anchor={props.anchor} onClose={props.onClose} width={320} class="scr-category-menu">
      <Show
        when={config()}
        keyed
        fallback={
          <>
            <div class="scr-menu-title">{props.kind === "filters" ? "Filters" : "Columns"}</div>
            <PopSearch value={q()} onInput={(v) => { setQ(v); setCat(null); }} />
            <div class="scr-pop-scroll" role="listbox">
              <Show
                when={q().trim()}
                fallback={
                  <Show
                    when={cat()}
                    fallback={
                      <For each={cats()}>
                        {(c) => <PopItem title={c.title} icon={c.icon} right={<span class="scr-item-count">{c.count}</span>} onClick={() => setCat(c.id)} />}
                      </For>
                    }
                  >
                    <PopBack title={CATEGORIES.find((c) => c.id === cat())?.title ?? ""} onClick={() => setCat(null)} />
                    <For each={items().filter((d) => d.category === cat())}>{(d) => <PopItem title={d.title} onClick={() => pick(d)} />}</For>
                  </Show>
                }
              >
                <For
                  each={searched()}
                  fallback={<div class="scr-pop-empty">{props.kind === "filters" ? "No filters match this search" : "No columns match this search"}</div>}
                >
                  {(d) => <PopItem title={d.title} onClick={() => pick(d)} />}
                </For>
              </Show>
            </div>
          </>
        }
      >
        {(c) => (
          <div class="scr-column-config">
            <PopBack title={c.def.title} onClick={() => setConfig(null)} />
            <PopDivider />
            <div class="scr-manual">
              <For each={visibleParams(c.def, props.has)}>
                {(p) => (
                  <SelectButton
                    class="scr-select--stretch"
                    label={p.options.find((o) => o.value === (c.col.params[p.key] ?? p.default))?.label ?? p.options[0].label}
                    options={p.options.map((o) => ({ value: o.value, label: o.label }))}
                    value={c.col.params[p.key] ?? p.default}
                    onChange={(v) => setConfig({ def: c.def, col: { id: c.col.id, params: { ...c.col.params, [p.key]: v } } })}
                  />
                )}
              </For>
              <button type="button" class="scr-primary-btn" onClick={() => props.onPick(c.col)}>
                Add column
              </button>
            </div>
          </div>
        )}
      </Show>
    </Popover>
  );
}
