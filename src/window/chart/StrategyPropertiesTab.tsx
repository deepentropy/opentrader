/*
 * Strategy Settings > Properties tab (the reference desktop app 3.4.1, design doc
 * §5 and §14.2 - §14.5): GENERAL (Initial capital + currency, Default order
 * size + unit, Pyramiding), DETALIZATION AND EXECUTION (Bar detalization,
 * Script execution), BROKER EMULATOR (Commission + unit, Long / Short
 * leverage, Slippage, Limit order execution, Order execution delay). Rows of
 * 34 px controls: number fields and unit selects 126 px, full-width selects
 * 260 px, (i) icons 18 px #575757 with the reference app's tooltips.
 *
 * Bar detalization (High = bar magnifier on lower-timeframe bars, disabled on
 * synthetic chart types), Script execution (check list: "On bar close" always
 * on, "On realtime bar tick"), Limit order execution and the Heikin Ashi mode
 * row (Heikin Ashi charts only) drive the backtest engine. Options it does not
 * simulate are listed but disabled: other currencies (no FX conversion), "On
 * order fill" and "On history bar tick" (extra script runs inside a bar). The
 * reference app's (?) help links are not shown (no Help Center).
 */
import { For, Show, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { detalizationTicks } from "../../backtester/magnifier";
import type { CommissionType, QtyType, StrategyProperties } from "../../backtester/types";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { CheckBox, NumberField, SelectControl } from "../header/ChartPropertiesDialog";

type Props = {
  value: StrategyProperties;
  /** Currency of the chart symbol ("Same as chart"). */
  chartCurrency: string;
  /** Chart interval ("5", "60", "1D"...): High detalization tick count. */
  interval: string;
  /** Chart type id of the chart ("candle", "ha", "renko"...): synthetic types disable High detalization and
   *  "On history bar tick"; Heikin Ashi shows the Heikin Ashi mode row. */
  chartStyle?: string;
  onChange: (patch: Partial<StrategyProperties>) => void;
};

const CURRENCIES = ["Same as chart", "USD", "EUR", "AUD", "GBP", "NZD", "CAD", "CHF"];
/** Order size units; the cash unit is titled with the strategy currency. */
const qtyTypes = (currency: string): [QtyType, string][] => [["fixed", "Quantity"], ["cash", currency], ["percent_of_equity", "% of equity"]];
const COMMISSION_TYPES: [CommissionType, string][] = [["percent", "Percent"], ["cash_per_contract", "Per contract"], ["cash_per_order", "Fixed"]];
/** Chart types whose bars are synthetic (the reference app's list). */
const SYNTHETIC_STYLES = ["ha", "renko", "pb", "kagi", "pnf", "range"];
const NOT_FOR_BAR_TYPE = "Not available for current bar type";

/** One option of a Properties select: title, its (i) tooltip, disabled state with its tooltip. */
type Opt = { id: string; label: string; tip?: string; disabled?: boolean; disabledTip?: string };

const LIMIT_EXECUTION: Opt[] = [
  { id: "0", label: "Requested price", tip: "Guarantees the order is filled at a certain level" },
  { id: "1", label: "Requested price and 1 tick beyond", tip: "Assumes liquidity is sufficient" },
];
const DELAYS: Opt[] = [
  { id: "none", label: "None", tip: "Executes orders on the same bar where they are created" },
  { id: "tick", label: "One tick", tip: "Executes orders on the next tick, assuming one-tick delay due to market conditions" },
];
const HA_MODES: Opt[] = [
  { id: "ha", label: "Heikin Ashi bars", tip: "Uses Heiken Ashi average prices to execute orders to match the chart setup" },
  { id: "standard", label: "Standard bars", tip: "Uses actual OHLC levels to execute orders for more realistic results" },
];

function Info(props: { text: string }) {
  return (
    <Tooltip text={props.text} side="top">
      <span class="ind3-info" aria-label={props.text}>
        <Icon name="st-settings-info" size={18} />
      </span>
    </Tooltip>
  );
}

/** Outside-press and Escape close a menu (its trigger toggles it). */
function createDismiss(refs: () => (HTMLElement | undefined)[], onClose: () => void) {
  const onDown = (e: PointerEvent) => {
    if (refs().some((el) => el?.contains(e.target as Node))) return;
    onClose();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
  };
  onMount(() => {
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
  });
  onCleanup(() => {
    document.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("keydown", onKey, true);
  });
}

const Caret = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3.92 7.83 9 12.29l5.08-4.46-1-1.13L9 10.29l-4.09-3.6-.99 1.14Z" /></svg>
);

/** A select button (cp3-select) and its option menu under it (flipped above without room below). */
function MenuSelect(props: { display: string; width: number; role: "listbox" | "menu"; children: (close: () => void) => JSX.Element }) {
  let btn: HTMLButtonElement | undefined;
  let menu: HTMLDivElement | undefined;
  const [rect, setRect] = createSignal<DOMRect | null>(null);
  const close = () => setRect(null);
  return (
    <>
      <button
        ref={btn}
        type="button"
        class={`cp3-select${rect() ? " is-open" : ""}`}
        style={{ width: `${props.width}px` }}
        aria-haspopup={props.role}
        aria-expanded={!!rect()}
        onClick={() => setRect(rect() ? null : btn!.getBoundingClientRect())}
      >
        <span class="cp3-select-value">{props.display}</span>
        <span class="cp3-select-caret"><Caret /></span>
      </button>
      <Show when={rect()} keyed>
        {(r) => {
          const [top, setTop] = createSignal(r.bottom);
          createDismiss(() => [menu, btn], close);
          onMount(() => {
            const h = menu?.offsetHeight ?? 0;
            if (r.bottom + h > window.innerHeight - 4) setTop(Math.max(4, r.top - h));
          });
          return (
            <div ref={menu} class="cp3-menu" role={props.role} style={{ left: `${r.left}px`, top: `${top()}px`, "min-width": `${r.width}px` }}>
              {props.children(close)}
            </div>
          );
        }}
      </Show>
    </>
  );
}

/** Option row content: the title, then its (i) tooltip. */
function OptLabel(props: { opt: Opt }) {
  return (
    <>
      <span class="cp3-menu-title">{props.opt.label}</span>
      <Show when={props.opt.tip}>
        {(tip) => (
          <span style={{ "margin-left": "auto" }}>
            <Info text={tip()} />
          </span>
        )}
      </Show>
    </>
  );
}

/** Wraps a disabled option in its tooltip ("Not available for current bar type"). */
function WithTip(props: { tip?: string; children: JSX.Element }) {
  return (
    <Show when={props.tip} fallback={props.children}>
      {(tip) => (
        <Tooltip text={tip()} side="top">
          {props.children}
        </Tooltip>
      )}
    </Show>
  );
}

/** Single-choice select whose options carry (i) tooltips and disabled states. */
function OptSelect(props: { options: Opt[]; value: string; display?: string; width: number; onPick: (id: string) => void }) {
  const display = () => props.display ?? props.options.find((o) => o.id === props.value)?.label ?? "";
  return (
    <MenuSelect display={display()} width={props.width} role="listbox">
      {(close) => (
        <For each={props.options}>
          {(o) => (
            <WithTip tip={o.disabled ? o.disabledTip : undefined}>
              <div
                role="option"
                aria-selected={o.id === props.value}
                aria-disabled={o.disabled || undefined}
                class={`cp3-menu-item${o.id === props.value ? " is-selected" : ""}${o.disabled ? " is-disabled" : ""}`}
                onClick={() => {
                  if (o.disabled) return;
                  props.onPick(o.id);
                  close();
                }}
              >
                <OptLabel opt={o} />
              </div>
            </WithTip>
          )}
        </For>
      )}
    </MenuSelect>
  );
}

/** Check-list select (Script execution): toggling keeps the menu open; the button shows the checked titles. */
function CheckSelect(props: { options: (Opt & { checked: boolean })[]; width: number; onToggle: (id: string) => void }) {
  const display = () => props.options.filter((o) => o.checked).map((o) => o.label).join(", ");
  return (
    <MenuSelect display={display()} width={props.width} role="menu">
      {() => (
        <For each={props.options}>
          {(o) => (
            <WithTip tip={o.disabled ? o.disabledTip : undefined}>
              <div
                role="menuitemcheckbox"
                aria-checked={o.checked}
                aria-disabled={o.disabled || undefined}
                class={`cp3-menu-item cp3-menu-check${o.disabled ? " is-disabled" : ""}`}
                onClick={() => !o.disabled && props.onToggle(o.id)}
              >
                <CheckBox checked={o.checked} disabled={o.disabled} onToggle={() => {}} />
                <OptLabel opt={o} />
              </div>
            </WithTip>
          )}
        </For>
      )}
    </MenuSelect>
  );
}

function Row(props: { label: string; children: JSX.Element }) {
  return (
    <>
      <div class="cp3-cell cp3-label"><div class="cp3-label-inner"><span class="cp3-title">{props.label}</span></div></div>
      <div class="cp3-cell cp3-controls">{props.children}</div>
    </>
  );
}

/** Leverage shown as `Nx` = 100 / margin %; typing "2" or "2x" sets margin 50 %. */
function LeverageField(props: { margin: number; onChange: (margin: number) => void }) {
  const text = () => `${Number((100 / (props.margin || 100)).toFixed(4))}x`;
  return (
    <span class="cp3-number" style={{ width: "126px" }}>
      <input
        type="text"
        inputmode="numeric"
        value={text()}
        onChange={(e) => {
          const lev = parseFloat(e.currentTarget.value);
          if (Number.isFinite(lev) && lev > 0) props.onChange(100 / lev);
          e.currentTarget.value = text();
        }}
      />
    </span>
  );
}

const num = (v: string) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

export function StrategyPropertiesTab(props: Props) {
  const p = () => props.value;
  const QTY_TYPES = () => qtyTypes(p().currency);
  const qtyLabel = () => QTY_TYPES().find(([t]) => t === p().defaultQtyType)?.[1] ?? "Quantity";
  const commissionLabel = () => COMMISSION_TYPES.find(([t]) => t === p().commissionType)?.[1] ?? "Percent";
  const synthetic = () => SYNTHETIC_STYLES.includes(props.chartStyle ?? "");
  const detalization = (): Opt[] => [
    { id: "default", label: "Default (4 ticks per bar)", tip: "Runs a simulation using OHLC values" },
    {
      id: "high",
      label: `High (~${detalizationTicks(props.interval)} ticks per bar)`,
      tip: "Runs a simulation using lower-timeframe values. The number of ticks may vary due to calculation factors.",
      disabled: synthetic(),
      disabledTip: NOT_FOR_BAR_TYPE,
    },
  ];
  // "On order fill" and "On history bar tick" need extra script runs inside a bar: not simulated (disabled).
  const executions = () => [
    {
      id: "close",
      label: "On bar close",
      tip: "Default strategy calculation. Selecting an additional subset limits strategy execution to specific bar updates.",
      checked: true,
      disabled: true,
    },
    {
      id: "fill",
      label: "On order fill",
      tip: "Runs an additional recalculation immediately after the order fills to provide instant access to the filled order data",
      checked: p().calcOnOrderFills,
      disabled: true,
    },
    {
      id: "history",
      label: "On history bar tick",
      tip: "Executes on every update in the history",
      checked: p().calcOnEveryHistoryTick,
      disabled: true,
      disabledTip: synthetic() ? NOT_FOR_BAR_TYPE : undefined,
    },
    { id: "realtime", label: "On realtime bar tick", tip: "Executes on each real-time update, including in bar replay mode", checked: p().calcOnEveryTick },
  ];
  const currencyValue = () => (p().currency === props.chartCurrency ? "Same as chart" : p().currency);

  return (
    <div class="ind3-grid st-props-grid">
      <div class="cp3-section is-first ind3-props-first">General</div>
      <Row label="Initial capital">
        <NumberField value={String(p().initialCapital)} width={126} num={{ min: 0, max: 9e15, step: 1 }} noSpin grouping onChange={(v) => { const n = num(v); if (n !== null) props.onChange({ initialCapital: n }); }} />
        <SelectControl
          value={currencyValue()}
          display={p().currency}
          options={CURRENCIES}
          width={126}
          disabledOptions={CURRENCIES.filter((c) => c !== "Same as chart" && c !== props.chartCurrency)}
          optionTag={(o) => (o === "Same as chart" ? props.chartCurrency : undefined)}
          onPick={(o) => props.onChange({ currency: o === "Same as chart" ? props.chartCurrency : o })}
        />
        <Info text="Starting funds available for the trading strategy" />
      </Row>
      <Row label="Default order size">
        <NumberField
          value={String(p().defaultQtyValue)}
          width={126}
          num={{ min: 0, max: 9e15, step: 1 }}
          noSpin
          onChange={(v) => { const n = num(v); if (n !== null) props.onChange({ defaultQtyValue: n }); }}
        />
        <SelectControl
          value={qtyLabel()}
          options={QTY_TYPES().map(([, l]) => l)}
          width={126}
          onPick={(l) => props.onChange({ defaultQtyType: QTY_TYPES().find(([, x]) => x === l)![0] })}
        />
        <Info text="Quantity per trade in the selected unit" />
      </Row>
      <Row label="Pyramiding">
        <NumberField value={String(p().pyramiding)} width={126} num={{ min: 0, max: 1_000_000, step: 1, int: true }} noSpin onChange={(v) => { const n = num(v); if (n !== null) props.onChange({ pyramiding: Math.round(n) }); }} />
        <Info text="Maximum number of successive entries allowed in the same direction" />
      </Row>

      <div class="cp3-section">Detalization and execution</div>
      <Row label="Bar detalization">
        <OptSelect options={detalization()} value={p().barMagnifier ? "high" : "default"} width={260} onPick={(id) => props.onChange({ barMagnifier: id === "high" })} />
      </Row>
      <Row label="Script execution">
        <CheckSelect options={executions()} width={260} onToggle={(id) => id === "realtime" && props.onChange({ calcOnEveryTick: !p().calcOnEveryTick })} />
      </Row>

      <div class="cp3-section ind3-props-broker">Broker emulator</div>
      <Row label="Commission">
        <NumberField value={String(p().commissionValue)} width={126} num={{ min: 0, max: 9e15, step: 1 }} noSpin onChange={(v) => { const n = num(v); if (n !== null) props.onChange({ commissionValue: n }); }} />
        <SelectControl
          value={commissionLabel()}
          options={COMMISSION_TYPES.map(([, l]) => l)}
          width={126}
          optionTag={(o) => (o === "Fixed" ? p().currency : undefined)}
          onPick={(l) => props.onChange({ commissionType: COMMISSION_TYPES.find(([, x]) => x === l)![0] })}
        />
        <Info text="Determines the fees deducted from your balance for each entry and exit" />
      </Row>
      <Row label="Long leverage">
        <LeverageField margin={p().marginLong} onChange={(m) => props.onChange({ marginLong: m })} />
        <Info text="Sets how much borrowed capital is used for a long position relative to your own funds" />
      </Row>
      <Row label="Short leverage">
        <LeverageField margin={p().marginShort} onChange={(m) => props.onChange({ marginShort: m })} />
        <Info text="Sets how much borrowed capital is used for a short position relative to your own funds" />
      </Row>
      <Row label="Slippage">
        <NumberField value={String(p().slippage)} width={126} suffix="ticks" noSpin num={{ min: 0, max: 1_000_000, step: 1, int: true }} onChange={(v) => { const n = num(v); if (n !== null) props.onChange({ slippage: Math.round(n) }); }} />
        <Info text="Defines how many ticks will be added to the execution price of market and stop orders" />
      </Row>
      <Row label="Limit order execution">
        {/* 0 = requested price; any other backtest_fill_limits_assumption shows the 1 tick title. */}
        <OptSelect options={LIMIT_EXECUTION} value={p().fillLimitsTicks ? "1" : "0"} width={260} onPick={(id) => props.onChange({ fillLimitsTicks: Number(id) })} />
      </Row>
      <Row label="Order execution delay">
        <OptSelect options={DELAYS} value={p().processOrdersOnClose ? "none" : "tick"} width={126} onPick={(id) => props.onChange({ processOrdersOnClose: id === "none" })} />
      </Row>
      <Show when={props.chartStyle === "ha"}>
        <Row label="Heikin Ashi mode">
          <OptSelect options={HA_MODES} value={p().fillOrdersOnStandardOhlc ? "standard" : "ha"} width={260} onPick={(id) => props.onChange({ fillOrdersOnStandardOhlc: id === "standard" })} />
        </Row>
      </Show>
    </div>
  );
}
