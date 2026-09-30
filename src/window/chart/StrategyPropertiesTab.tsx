/*
 * Strategy Settings > Properties tab (the reference desktop app 3.4.1, design doc
 * §5 and §14.2 - §14.5): GENERAL (Initial capital + currency, Default order
 * size + unit, Pyramiding), DETALIZATION AND EXECUTION (Bar detalization,
 * Script execution), BROKER EMULATOR (Commission + unit, Long / Short
 * leverage, Slippage, Limit order execution, Order execution delay). Rows of
 * 34 px controls: number fields and unit selects 126 px, full-width selects
 * 260 px, (i) icons 18 px #575757 with the reference app's tooltips.
 *
 * Options the backtest engine does not simulate are listed but disabled:
 * other currencies (no FX conversion), High bar detalization (lower
 * timeframe data), extra script executions, and "Requested price and 1 tick
 * beyond". The reference app's (?) help links are not shown (no Help Center).
 */
import type { JSX } from "solid-js";
import type { CommissionType, QtyType, StrategyProperties } from "../../backtester/types";
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { NumberField, SelectControl } from "../header/ChartPropertiesDialog";

type Props = {
  value: StrategyProperties;
  /** Currency of the chart symbol ("Same as chart"). */
  chartCurrency: string;
  /** Chart interval ("5", "60", "1D"...): High detalization tick count. */
  interval: string;
  onChange: (patch: Partial<StrategyProperties>) => void;
};

const CURRENCIES = ["Same as chart", "USD", "EUR", "AUD", "GBP", "NZD", "CAD", "CHF"];
/** Order size units; the cash unit is titled with the strategy currency. */
const qtyTypes = (currency: string): [QtyType, string][] => [["fixed", "Quantity"], ["cash", currency], ["percent_of_equity", "% of equity"]];
const COMMISSION_TYPES: [CommissionType, string][] = [["percent", "Percent"], ["cash_per_contract", "Per contract"], ["cash_per_order", "Fixed"]];
const EXECUTIONS = ["On bar close", "On order fill", "On history bar tick", "On realtime bar tick"];
const LIMIT_EXECUTION = ["Requested price", "Requested price and 1 tick beyond"];
const DELAYS = ["None", "One tick"];

/** High detalization ticks per bar by chart interval (the reference app module 470379). */
function highTicks(interval: string): number {
  const m = /^(\d*)([SDWM]?)$/i.exec(interval.trim());
  const n = Number(m?.[1] || 1);
  const unit = (m?.[2] ?? "").toUpperCase();
  if (unit === "S") return n < 30 ? 4 : n < 59 ? 24 : 28;
  if (unit === "") {
    if (n < 5) return 24;
    if (n < 15) return 40;
    if (n < 30) return 28;
    if (n < 240) return 24;
    if (n < 1440) return 32;
    return 28;
  }
  if (unit === "D") return n < 3 ? 96 : n < 7 ? 72 : 28;
  return 28;
}

function Info(props: { text: string }) {
  return (
    <Tooltip text={props.text} side="top">
      <span class="ind3-info" aria-label={props.text}>
        <Icon name="st-settings-info" size={18} />
      </span>
    </Tooltip>
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
  const ticks = () => highTicks(props.interval);
  const detalization = () => [`Default (4 ticks per bar)`, `High (~${ticks()} ticks per bar)`];
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
        <SelectControl value={detalization()[0]} options={detalization()} width={260} disabledOptions={[detalization()[1]]} onPick={() => undefined} />
      </Row>
      <Row label="Script execution">
        <SelectControl value={EXECUTIONS[0]} options={EXECUTIONS} width={260} disabledOptions={EXECUTIONS.slice(1)} onPick={() => undefined} />
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
        <SelectControl value={LIMIT_EXECUTION[0]} options={LIMIT_EXECUTION} width={260} disabledOptions={[LIMIT_EXECUTION[1]]} onPick={() => undefined} />
      </Row>
      <Row label="Order execution delay">
        <SelectControl
          value={p().processOrdersOnClose ? DELAYS[0] : DELAYS[1]}
          options={DELAYS}
          width={126}
          onPick={(o) => props.onChange({ processOrdersOnClose: o === DELAYS[0] })}
        />
      </Row>
    </div>
  );
}
