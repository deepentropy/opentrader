/*
 * FilterEditor: content of a filter pill popover (TradingView Desktop 3.4.1):
 *   header: column long title, Reset (when active), divider, trash (remove);
 *           a second row with one text button per column param ("1 month ▾").
 *   Condition with presets: Search + preset list (value + description) +
 *           divider + "Manual setup".
 *   Condition without presets, or after "Manual setup": operation select,
 *           target select ("Value" or a column), then the value input(s)
 *           ("Enter value", or "From" / "To" for Between / Outside) or the
 *           target column params.
 *   CheckboxGroup: Search + checkbox list.
 * Typed values apply on Enter, on blur, and 400 ms after the last key.
 */
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { Icon } from "../../components/Icon";
import {
  COLUMN_BY_ID,
  OPERATION_ICON,
  OPERATION_LABEL,
  defaultRef,
  emptyFilter,
  fullParams,
  isOffered,
  visibleParams,
  type CheckboxFilter,
  type ColumnRef,
  type ConditionFilter,
  type Filter,
  type Operation,
} from "../../data/screener-catalog";
import { abbrev, parseValue } from "../../data/screener-format";
import { isActive, presetFilter, presetTitle } from "../../data/screener-query";
import { PopDivider, PopItem, PopSearch, Popover, SelectButton } from "./Popover";

type Props = {
  filter: Filter;
  has: (field: string) => boolean;
  onChange: (f: Filter) => void;
  onRemove: () => void;
  onClose: () => void;
};

/** Param text buttons of a column ("1 month ▾"), each opening its option list. */
export function ParamButtons(props: { col: ColumnRef; has: (f: string) => boolean; onChange: (col: ColumnRef) => void }) {
  const def = () => COLUMN_BY_ID[props.col.id];
  const params = () => (def() ? visibleParams(def()!, props.has) : []);
  return (
    <For each={params()}>
      {(p) => {
        let btn!: HTMLButtonElement;
        const [open, setOpen] = createSignal(false);
        const cur = () => fullParams(def()!, props.col.params)[p.key];
        const label = () => p.options.find((o) => o.value === cur())?.label ?? p.options[0].label;
        return (
          <>
            <button ref={btn} type="button" class="scr-param-btn" classList={{ "is-open": open() }} aria-label={label()} onClick={() => setOpen(!open())}>
              <span>{label()}</span>
              <span class="scr-param-caret"><Icon name="scr-param-caret" size={18} /></span>
            </button>
            <Show when={open()}>
              <Popover anchor={btn} onClose={() => setOpen(false)} offset={{ x: 0, y: 4 }} maxHeight={360}>
                <div class="scr-pop-scroll" role="listbox">
                  <For each={p.options}>
                    {(o) => (
                      <PopItem
                        title={o.label}
                        selected={o.value === cur()}
                        onClick={() => {
                          props.onChange({ id: props.col.id, params: { ...fullParams(def()!, props.col.params), [p.key]: o.value } });
                          setOpen(false);
                        }}
                      />
                    )}
                  </For>
                </div>
              </Popover>
            </Show>
          </>
        );
      }}
    </For>
  );
}

/** Header row of the filter / column popovers. */
export function EditorHeader(props: {
  col: ColumnRef;
  has: (f: string) => boolean;
  canReset?: boolean;
  onReset?: () => void;
  onRemove?: () => void;
  onParam: (col: ColumnRef) => void;
}) {
  const def = () => COLUMN_BY_ID[props.col.id];
  const hasParams = () => (def() ? visibleParams(def()!, props.has).length > 0 : false);
  return (
    <div class="scr-editor-header" classList={{ "has-params": hasParams() }}>
      <div class="scr-editor-title">{def()?.title ?? props.col.id}</div>
      <div class="scr-editor-tools" role="toolbar">
        <Show when={props.onReset}>
          <button type="button" class="scr-text-btn" classList={{ "is-hidden": !props.canReset }} onClick={() => props.onReset?.()}>
            Reset
          </button>
          <span class="scr-editor-tools-divider" classList={{ "is-hidden": !props.canReset }} />
        </Show>
        <Show when={props.onRemove}>
          <button type="button" class="scr-text-btn scr-icon-only" aria-label="Remove" onClick={() => props.onRemove?.()}>
            <Icon name="scr-trash" size={18} />
          </button>
        </Show>
      </div>
      <Show when={hasParams()}>
        <div class="scr-editor-params" role="toolbar">
          <ParamButtons col={props.col} has={props.has} onChange={props.onParam} />
        </div>
      </Show>
    </div>
  );
}

function valueUnit(col: ColumnRef): string | null {
  const fmt = COLUMN_BY_ID[col.id]?.fmt;
  if (fmt === "price" || fmt === "signedPrice" || fmt === "money") return "USD";
  if (fmt === "change" || fmt === "percent") return "%";
  return null;
}

/** Input text of a value: volumes and money in K / M / B ("500 K"), as TV. */
function inputText(col: ColumnRef, v: number | null): string {
  if (v === null) return "";
  const fmt = COLUMN_BY_ID[col.id]?.fmt;
  return fmt === "volume" || fmt === "money" ? abbrev(v) : String(v);
}

/** Number input with the TV stepper (increase / decrease). */
function ValueInput(props: { col: ColumnRef; value: number | null; placeholder: string; unit: string | null; onValue: (v: number | null) => void }) {
  const [text, setText] = createSignal(inputText(props.col, props.value));
  let input!: HTMLInputElement;
  let timer: number | undefined;
  // External changes (Reset, operation switch) refresh the text unless typing.
  createEffect(
    on(
      () => props.value,
      (v) => {
        if (document.activeElement !== input) setText(inputText(props.col, v));
      },
      { defer: true },
    ),
  );
  const commit = () => {
    window.clearTimeout(timer);
    timer = undefined;
    const v = parseValue(text());
    if (text().trim() === "" || v !== null) props.onValue(text().trim() === "" ? null : v);
  };
  // A value still waiting for its debounce is applied after the popover
  // closes (never during the disposal itself).
  onCleanup(() => {
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
      const t = text();
      queueMicrotask(() => {
        const v = parseValue(t);
        if (t.trim() === "" || v !== null) props.onValue(t.trim() === "" ? null : v);
      });
    }
  });
  const step = (dir: 1 | -1) => {
    const v = (parseValue(text()) ?? 0) + dir;
    setText(inputText(props.col, Math.round(v * 1e6) / 1e6));
    commit();
  };
  return (
    <span class="scr-input scr-value-input">
      <input
        ref={input}
        type="text"
        inputmode="decimal"
        placeholder={props.placeholder}
        value={text()}
        spellcheck={false}
        autocomplete="off"
        onInput={(e) => {
          setText(e.currentTarget.value);
          window.clearTimeout(timer);
          timer = window.setTimeout(commit, 400);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "ArrowUp") {
            e.preventDefault();
            step(1);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            step(-1);
          }
        }}
      />
      <Show when={props.unit}>
        <span class="scr-input-unit">{props.unit}</span>
      </Show>
      <span class="scr-stepper">
        <button type="button" class="scr-stepper-up" aria-label="Increase" tabIndex={-1} onClick={() => step(1)}>
          <Icon name="scr-caret-small" size={18} />
        </button>
        <button type="button" class="scr-stepper-down" aria-label="Decrease" tabIndex={-1} onClick={() => step(-1)}>
          <Icon name="scr-caret-small" size={18} />
        </button>
      </span>
    </span>
  );
}

function ManualSetup(props: { filter: ConditionFilter; has: (f: string) => boolean; onChange: (f: Filter) => void }) {
  const def = () => COLUMN_BY_ID[props.filter.left.id]!;
  const cfg = () => (def().filter?.type === "Condition" ? def().filter : null) as Extract<NonNullable<ReturnType<typeof def>["filter"]>, { type: "Condition" }> | null;
  const op = (): Operation =>
    props.filter.operation === "abovePercent" ? "above" : props.filter.operation === "belowPercent" ? "below" : props.filter.operation;
  const range = () => op() === "between" || op() === "outside";
  const opOptions = () => (cfg()?.operations ?? []).map((o) => ({ value: o, label: OPERATION_LABEL[o], icon: `scr-op-lg-${OPERATION_ICON[o]}` }));
  // Target groups: "Value" + offered columns, a divider between TV groups.
  const targetOptions = createMemo(() => {
    const out: { value: string; label: string; divider?: boolean }[] = [];
    (cfg()?.targets ?? []).forEach((group, gi) => {
      let first = true;
      for (const t of group) {
        if (t === "value") {
          out.push({ value: "value", label: "Value" });
          first = false;
          continue;
        }
        const td = COLUMN_BY_ID[t];
        if (!td) continue;
        if (!isOffered(td, props.has)) continue;
        out.push({ value: t, label: td.title, divider: first && gi > 0 });
        first = false;
      }
    });
    return out;
  });
  const setOp = (o: string) => {
    const next = o as Operation;
    const f = props.filter;
    const r = f.right;
    let right = r;
    if (f.target === "value") {
      const wantRange = next === "between" || next === "outside";
      if (wantRange && "value" in r) right = { left: r.value, right: null };
      else if (!wantRange && "left" in r) right = { value: r.left ?? r.right };
    }
    props.onChange({ ...f, operation: next, offsetRangeId: undefined, right });
  };
  const setTarget = (t: string) => {
    const f = props.filter;
    if (t === "value") {
      props.onChange({ ...f, target: "value", right: range() ? { left: null, right: null } : { value: null } });
      return;
    }
    const td = COLUMN_BY_ID[t];
    if (!td) return;
    const nextOp = range() ? "above" : op();
    props.onChange({ ...f, target: t, operation: nextOp, offsetRangeId: undefined, right: { column: defaultRef(td, props.has) } });
  };
  const right = () => props.filter.right;
  return (
    <div class="scr-manual">
      <SelectButton
        class="scr-select--stretch"
        label={OPERATION_LABEL[op()]}
        options={opOptions()}
        value={op()}
        onChange={setOp}
      />
      <Show when={targetOptions().length > 1 || props.filter.target !== "value"}>
        <SelectButton
          label={props.filter.target === "value" ? "Value" : COLUMN_BY_ID[props.filter.target]?.title ?? props.filter.target}
          options={targetOptions().filter((o) => !(range() && o.value !== "value"))}
          value={props.filter.target}
          onChange={setTarget}
        />
      </Show>
      <Show when={props.filter.target === "value"}>
        <Show
          when={range()}
          fallback={
            <ValueInput
              col={props.filter.left}
              value={"value" in right() ? (right() as { value: number | null }).value : null}
              placeholder="Enter value"
              unit={valueUnit(props.filter.left)}
              onValue={(v) => props.onChange({ ...props.filter, right: { value: v } })}
            />
          }
        >
          <div class="scr-range-values">
            <ValueInput
              col={props.filter.left}
              value={"left" in right() ? (right() as { left: number | null }).left : null}
              placeholder="From"
              unit={null}
              onValue={(v) => {
                const r = right() as { left: number | null; right: number | null };
                props.onChange({ ...props.filter, right: { left: v, right: "left" in r ? r.right : null } });
              }}
            />
            <ValueInput
              col={props.filter.left}
              value={"right" in right() ? (right() as { right: number | null }).right : null}
              placeholder="To"
              unit={valueUnit(props.filter.left)}
              onValue={(v) => {
                const r = right() as { left: number | null; right: number | null };
                props.onChange({ ...props.filter, right: { left: "left" in r ? r.left : null, right: v } });
              }}
            />
          </div>
        </Show>
      </Show>
      <Show when={"column" in right()}>
        <div class="scr-editor-params scr-editor-params--target">
          <ParamButtons
            col={(right() as { column: ColumnRef }).column}
            has={props.has}
            onChange={(c) => props.onChange({ ...props.filter, right: { column: c } })}
          />
        </div>
      </Show>
    </div>
  );
}

function CheckboxList(props: { filter: CheckboxFilter; onChange: (f: Filter) => void }) {
  const [q, setQ] = createSignal("");
  const options = () => {
    const d = COLUMN_BY_ID[props.filter.left.id]?.filter;
    return d?.type === "CheckboxGroup" ? d.options : [];
  };
  const shown = () => {
    const s = q().trim().toLowerCase();
    return s ? options().filter(([, l]) => l.toLowerCase().includes(s)) : options();
  };
  const toggle = (v: string) => {
    const cur = props.filter.values;
    const values = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
    props.onChange({ ...props.filter, values });
  };
  return (
    <>
      <PopSearch value={q()} onInput={setQ} />
      <div class="scr-pop-scroll" role="listbox">
        <For each={shown()} fallback={<div class="scr-pop-empty">Nothing matches this search</div>}>
          {([v, label]) => (
            <div role="option" aria-selected={props.filter.values.includes(v)} class="scr-item" onClick={() => toggle(v)}>
              <span class="scr-checkbox" classList={{ "is-checked": props.filter.values.includes(v) }}>
                <Show when={props.filter.values.includes(v)}>
                  <Icon name="scr-check" />
                </Show>
              </span>
              <span class="scr-item-text"><span class="scr-item-title">{label}</span></span>
            </div>
          )}
        </For>
      </div>
    </>
  );
}

export function FilterEditor(props: Props) {
  const def = () => COLUMN_BY_ID[props.filter.left.id];
  const presets = () => {
    const f = def()?.filter;
    if (f?.type !== "Condition" || !f.presets) return [];
    // Keep presets whose columns the backend can serve.
    return f.presets.filter((p) => {
      const pf = presetFilter(props.filter, p);
      if ("column" in pf.right) {
        const td = COLUMN_BY_ID[pf.right.column.id];
        return !!td && (td.field ? props.has(td.field) : visibleOrFixed(td, pf.right.column));
      }
      return true;
    });
  };
  const visibleOrFixed = (td: NonNullable<ReturnType<typeof def>>, col: ColumnRef) => {
    const p = fullParams(td, col.params);
    return (td.params ?? []).every((pd) => {
      const o = pd.options.find((x) => x.value === p[pd.key]);
      return !!o && (!o.field || props.has(o.field));
    });
  };
  const [manual, setManual] = createSignal(false);
  const [q, setQ] = createSignal("");
  const shownPresets = () => {
    const s = q().trim().toLowerCase();
    const list = presets().map((p) => ({ p, title: presetTitle(props.filter.left.id, p), desc: p.description }));
    return s ? list.filter((x) => x.title.toLowerCase().includes(s) || (x.desc ?? "").toLowerCase().includes(s)) : list;
  };
  const reset = () => {
    const e = emptyFilter(props.filter.left);
    if (e) props.onChange({ ...e, id: props.filter.id });
  };
  const setLeft = (col: ColumnRef) => props.onChange({ ...props.filter, left: col } as Filter);

  return (
    <div class="scr-editor">
      <EditorHeader
        col={props.filter.left}
        has={props.has}
        canReset={isActive(props.filter)}
        onReset={reset}
        onRemove={props.onRemove}
        onParam={setLeft}
      />
      <Show when={props.filter.type === "CheckboxGroup"}>
        <CheckboxList filter={props.filter as CheckboxFilter} onChange={props.onChange} />
      </Show>
      <Show when={props.filter.type === "Condition"}>
        <Show
          when={!manual() && presets().length > 0}
          fallback={<ManualSetup filter={props.filter as ConditionFilter} has={props.has} onChange={props.onChange} />}
        >
          <PopSearch value={q()} onInput={setQ} />
          <div class="scr-pop-scroll" role="listbox">
            <For each={shownPresets()} fallback={<div class="scr-pop-empty">Nothing matches this search</div>}>
              {(x) => (
                <PopItem
                  title={x.title}
                  description={x.desc}
                  onClick={() => {
                    props.onChange(presetFilter(props.filter, x.p));
                    props.onClose();
                  }}
                />
              )}
            </For>
          </div>
          <PopDivider />
          <PopItem title="Manual setup" icon="scr-manual-setup" onClick={() => setManual(true)} />
        </Show>
      </Show>
    </div>
  );
}
