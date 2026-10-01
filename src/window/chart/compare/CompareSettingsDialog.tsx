/*
 * CompareSettingsDialog: Settings of one compared symbol (legend gear /
 * "Settings…"). Title "description · exchange"; tabs Inputs (Symbol), Style
 * (chart style + its rows, Price line, Override min tick), Visibility
 * (intervals matrix); footer Defaults / Cancel / Ok. Edits a local draft like
 * the indicator Settings dialog: Cancel discards, Ok commits.
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { IntervalVisibility, UnitVisibility } from "lightweight-charts-drawing/core/types";
import { CheckBox, FormRowView, SelectControl } from "../../header/ChartPropertiesDialog";
import { SymbolSearchDialog } from "../../header/SymbolSearchDialog";
import { UnitRow, VIS_UNITS } from "../IndicatorSettingsDialog";
import { keyOf, type CtrlValue } from "../../header/chart-settings";
import { rowIdOf, type FormRow } from "../../../data/chart-properties";
import {
  COMPARE_STYLES,
  MIN_TICK_OPTIONS,
  cloneCompareStyle,
  compareForms,
  defaultCompareStyle,
  type CompareStyleState,
} from "./compare-style";
import type { CompareEntry } from "../../shell/tabs";
import { toFullSymbol } from "../../../data/datafeed";
import { isFullSymbol } from "../../../data/symbol-name";

type Tab = "inputs" | "style" | "visibility";
const TAB_TITLES: Record<Tab, string> = { inputs: "Inputs", style: "Style", visibility: "Visibility" };

type Props = {
  entry: CompareEntry;
  /** "description · exchange". */
  title: string;
  onApply: (next: { symbol: string; style: CompareStyleState }) => void;
  onClose: () => void;
};

const Chevron = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3.92 7.83 9 12.29l5.08-4.46-1-1.13L9 10.29l-4.09-3.6-.99 1.14Z" /></svg>
);
const Pencil = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
    <path fill="none" stroke="currentColor" d="M12.5 3.5l2 2-8 8-2.6.6.6-2.6 8-8zM11 5l2 2" />
  </svg>
);

export function CompareSettingsDialog(props: Props) {
  const [tab, setTab] = createSignal<Tab>("inputs");
  const [symbol, setSymbol] = createSignal(props.entry.symbol);
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [draft, setDraft] = createStore<CompareStyleState>(cloneCompareStyle(props.entry.style));
  const forms = compareForms(props.entry.color);
  const styleTitle = createMemo(() => COMPARE_STYLES.find((s) => s.id === draft.style)?.title ?? "Line");

  const ok = () => {
    props.onApply({ symbol: symbol(), style: cloneCompareStyle(draft) });
    props.onClose();
  };
  const reset = () => setDraft(reconcile(defaultCompareStyle(props.entry.color)));

  // Row state helpers (keys `${style}:${rowId}`).
  const rowKey = (r: FormRow) => keyOf(draft.style, rowIdOf(r));
  const toggle = (key: string) => setDraft("rows", key, "checked", (c) => !c);
  const setControl = (key: string, idx: number, nv: CtrlValue) => setDraft("rows", key, "controls", idx, nv);
  const disabled = (r: FormRow, key: string) => !!r.cb && draft.rows[key]?.checked === false;
  const setUnit = (key: keyof IntervalVisibility, u: UnitVisibility) => setDraft("visibility", key, u as never);

  // "Defaults" menu (opens upward from the footer button).
  const [defaultsOpen, setDefaultsOpen] = createSignal(false);
  let defaultsBtn: HTMLButtonElement | undefined;
  let defaultsMenu: HTMLDivElement | undefined;
  onMount(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (defaultsMenu?.contains(t) || defaultsBtn?.contains(t)) return;
      setDefaultsOpen(false);
    };
    window.addEventListener("mousedown", onDown, true);
    onCleanup(() => window.removeEventListener("mousedown", onDown, true));
  });
  // Escape / Enter on the dialog; popovers take their own Escape first.
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (searchOpen()) return;
      if (e.key === "Escape") { e.stopPropagation(); props.onClose(); }
      else if (e.key === "Enter" && !(e.target instanceof HTMLInputElement)) { e.stopPropagation(); ok(); }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  return (
    <div class="settings-backdrop" role="presentation" onMouseDown={() => props.onClose()}>
      <div class="settings-dialog ind3-dialog" data-qa-id="compare-properties-dialog" role="dialog" aria-label={`${props.title} settings`} onMouseDown={(e) => e.stopPropagation()}>
        <header class="cp3-header">
          <div class="cp3-header-title ind3-title">{props.title}</div>
          <button type="button" data-qa-id="close" aria-label="Close menu" class="cp3-close" onClick={() => props.onClose()}>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18"><path stroke="currentColor" stroke-width="1.2" fill="none" d="m1.5 1.5 15 15m0-15-15 15" /></svg>
          </button>
        </header>

        <div class="ind3-tabs" role="tablist">
          <For each={["inputs", "style", "visibility"] as Tab[]}>
            {(t) => (
              <button type="button" role="tab" aria-selected={tab() === t} class={`ind3-tab${tab() === t ? " is-active" : ""}`} onClick={() => setTab(t)}>{TAB_TITLES[t]}</button>
            )}
          </For>
        </div>

        <div class="ind3-content">
          {/* ── Inputs: the compared symbol ── */}
          <Show when={tab() === "inputs"}>
            <div class="ind3-grid">
              <div class="cp3-cell cp3-label"><div class="cp3-label-inner"><span class="cp3-title">Symbol</span></div></div>
              <div class="cp3-cell cp3-controls">
                <button type="button" class="cmp3-symbol" onClick={() => setSearchOpen(true)}>
                  <span class="cmp3-symbol-text">{symbol()}</span>
                  <span class="cmp3-symbol-icon"><Pencil /></span>
                </button>
              </div>
            </div>
          </Show>

          {/* ── Style: chart style, its rows, Price line, Override min tick ── */}
          <Show when={tab() === "style"}>
            <div class="ind3-grid">
              <div class="cp3-cell cp3-label"><div class="cp3-label-inner"><span class="cp3-title">Style</span></div></div>
              <div class="cp3-cell cp3-controls">
                <SelectControl
                  value={styleTitle()}
                  options={COMPARE_STYLES.map((s) => s.title)}
                  width={100}
                  onPick={(t) => {
                    const s = COMPARE_STYLES.find((x) => x.title === t);
                    if (s) setDraft("style", s.id);
                  }}
                />
              </div>
              <For each={forms[draft.style]}>
                {(it) => {
                  if (it.kind !== "row") return null;
                  const key = () => rowKey(it);
                  return (
                    <FormRowView
                      r={it}
                      state={draft.rows[key()]}
                      disabled={disabled(it, key())}
                      onToggle={() => toggle(key())}
                      onControl={(j, nv) => setControl(key(), j, nv)}
                    />
                  );
                }}
              </For>
              <div class="cp3-cell cp3-label is-full ind3-check-row cmp3-price-line">
                <div class="cp3-label-inner">
                  <CheckBox checked={draft.priceLine} onToggle={() => setDraft("priceLine", (v) => !v)} />
                  <span class="cp3-title" onClick={() => setDraft("priceLine", (v) => !v)}>Price line</span>
                </div>
              </div>
              <div class="cp3-cell cp3-label"><div class="cp3-label-inner"><span class="cp3-title">Override min tick</span></div></div>
              <div class="cp3-cell cp3-controls">
                <SelectControl value={draft.minTick} options={MIN_TICK_OPTIONS} width={100} onPick={(v) => setDraft("minTick", v)} />
              </div>
            </div>
          </Show>

          {/* ── Visibility: intervals matrix ── */}
          <Show when={tab() === "visibility"}>
            <div class="ind3-grid">
              <div class="cp3-cell cp3-label is-full">
                <div class="cp3-label-inner">
                  <CheckBox checked={draft.visibility.ticks} onToggle={() => setDraft("visibility", "ticks", (v) => !v)} />
                  <span class="cp3-title" onClick={() => setDraft("visibility", "ticks", (v) => !v)}>Ticks</span>
                </div>
              </div>
              <For each={VIS_UNITS}>
                {([key, label, max]) => (
                  <UnitRow label={label} max={max} unit={draft.visibility[key] as UnitVisibility} onChange={(u) => setUnit(key, u)} />
                )}
              </For>
              <div class="cp3-cell cp3-label is-full">
                <div class="cp3-label-inner">
                  <CheckBox checked={draft.visibility.ranges} onToggle={() => setDraft("visibility", "ranges", (v) => !v)} />
                  <span class="cp3-title" onClick={() => setDraft("visibility", "ranges", (v) => !v)}>Ranges</span>
                </div>
              </div>
            </div>
          </Show>
        </div>

        <footer class="cp3-footer">
          <div class="settings-defaults">
            <button
              ref={defaultsBtn}
              type="button"
              class="cp3-template"
              aria-haspopup="menu"
              aria-expanded={defaultsOpen()}
              onClick={() => setDefaultsOpen(!defaultsOpen())}
            >
              Defaults <span class="cp3-select-caret"><Chevron /></span>
            </button>
            <Show when={defaultsOpen()}>
              <div ref={defaultsMenu} class="cp3-menu settings-template-menu settings-defaults-menu" role="menu">
                <div role="menuitem" class="cp3-menu-item" onClick={() => { reset(); setDefaultsOpen(false); }}>
                  <span class="cp3-menu-title">Reset settings</span>
                </div>
              </div>
            </Show>
          </div>
          <div class="cp3-footer-actions">
            <button type="button" class="cp3-btn" onClick={() => props.onClose()}>Cancel</button>
            <button type="button" class="cp3-btn is-primary" data-qa-id="submit-button" onClick={ok}>Ok</button>
          </div>
        </footer>
        {/* Inside the dialog box: its mousedown guard keeps the search's
            backdrop clicks from closing this dialog. */}
        <Show when={searchOpen()}>
          <SymbolSearchDialog
            activeSymbol={symbol()}
            onSelect={(s) => {
              if (isFullSymbol(s)) setSymbol(s.toUpperCase());
              else void toFullSymbol(s).then((full) => setSymbol(full.toUpperCase()), () => {});
            }}
            onClose={() => setSearchOpen(false)}
          />
        </Show>
      </div>
    </div>
  );
}
