/*
 * Inputs page of the drawing Settings dialog (tools with study-like
 * inputs): regression trend deviations, the position risk model, anchored
 * VWAP bands, volume profile inputs and the ghost feed amplitude.
 */
import { For, Show, type JSX } from "solid-js";
import type { Drawing, LevelDef } from "lightweight-charts-drawing/core/types";
import { VWAP_BAND_DEFAULTS } from "lightweight-charts-drawing/core/specs";
import { levelFromPrice, positionLevels, positionRiskSize, POSITION_DEFAULTS } from "lightweight-charts-drawing/core/kinds/position";
import { CheckboxRow, DecimalInput, DialogRow, Dropdown } from "./controls";
import { VolumeProfileInputRows } from "./volume-profile";
import { POSITION_KINDS, PRICE_SOURCE_LABELS, QTY_PRECISION_OPTIONS, VWAP_SOURCES } from "./kind-config";
import { type SettingsCx } from "./context";

export function inputsTab(cx: SettingsCx): JSX.Element {
  const { kind, moneyUnit, patchStyle, pip, priceDigits, props } = cx;
  const posSide = (): 1 | -1 => (props.drawing.kind === "long-position" ? 1 : -1);
  const posLevels = () => positionLevels(props.drawing, pip());
  const setRiskMode = (mode: "percents" | "money") => {
    const st = props.drawing.style;
    if ((st.riskDisplayMode ?? "percents") === mode) return;
    const account = st.accountSize ?? POSITION_DEFAULTS.accountSize;
    // Recalculate risk: convert the value to the new unit (2 decimals).
    const round2 = (v: number) => parseFloat(v.toFixed(2));
    if (mode === "money") patchStyle({ riskDisplayMode: mode, riskAmount: round2((account / 100) * (st.riskPercent ?? POSITION_DEFAULTS.risk)) });
    else patchStyle({ riskDisplayMode: mode, riskPercent: account > 0 ? round2((positionRiskSize(st) / account) * 100) : 0 });
  };
  const setEntryPrice = (v: number) => {
    const [p0, p1] = props.drawing.points;
    if (!p0 || !p1) return;
    props.onUpdate({ ...props.drawing, points: [{ ...p0, price: v }, { ...p1, price: v }] } as Drawing);
  };

  return (
    <>
      {/* Regression trend Inputs: Upper / Lower Deviation. */}
      <Show when={kind() === "regression-trend"}>
        <DialogRow label="Upper Deviation">
          <DecimalInput narrow value={props.drawing.style.upperDeviation ?? 2} onCommit={(v) => patchStyle({ upperDeviation: v })} />
        </DialogRow>
        <DialogRow label="Lower Deviation">
          <DecimalInput narrow value={props.drawing.style.lowerDeviation ?? -2} onCommit={(v) => patchStyle({ lowerDeviation: v })} />
        </DialogRow>
        <CheckboxRow
          label="Use Upper Deviation"
          checked={props.drawing.style.useUpperDeviation !== false}
          onChange={(v) => patchStyle({ useUpperDeviation: v })}
        />
        <CheckboxRow
          label="Use Lower Deviation"
          checked={props.drawing.style.useLowerDeviation !== false}
          onChange={(v) => patchStyle({ useLowerDeviation: v })}
        />
        <DialogRow label="Source">
          <Dropdown
            value={PRICE_SOURCE_LABELS[props.drawing.style.regressionSource ?? "close"]}
            options={VWAP_SOURCES.map((k) => PRICE_SOURCE_LABELS[k])}
            onChange={(v) => {
              const k = VWAP_SOURCES.find((x) => PRICE_SOURCE_LABELS[x] === v);
              if (k) patchStyle({ regressionSource: k });
            }}
          />
        </DialogRow>
      </Show>
      {/* Position tool: the risk model feeding the Qty readout
          (qty = accountSize · risk% / stop distance). */}
      <Show when={POSITION_KINDS.has(kind())}>
        <DialogRow label="Account size">
          <DecimalInput
            value={props.drawing.style.accountSize ?? POSITION_DEFAULTS.accountSize}
            onCommit={(v) => patchStyle({ accountSize: Math.min(1e9, Math.max(1e-9, v)) })}
          />
        </DialogRow>
        {/* Lot size: the displayed Qty = risk units / lot size. */}
        <DialogRow label="Lot size">
          <DecimalInput
            value={props.drawing.style.lotSize ?? POSITION_DEFAULTS.lotSize}
            onCommit={(v) => patchStyle({ lotSize: Math.min(1e8, Math.max(1e-9, v)) })}
          />
        </DialogRow>
        {/* Risk: value + unit select (% / symbol currency); percent
            mode 0.01 step, 2 decimals, max 100; money mode step 1,
            capped at the account size. */}
        <DialogRow label="Risk">
          <Show
            when={props.drawing.style.riskDisplayMode === "money"}
            fallback={
              <DecimalInput
                value={props.drawing.style.riskPercent ?? POSITION_DEFAULTS.risk}
                digits={2}
                onCommit={(v) => patchStyle({ riskPercent: Math.min(100, Math.max(1e-9, v)) })}
              />
            }
          >
            <DecimalInput
              value={positionRiskSize(props.drawing.style)}
              onCommit={(v) => {
                const account = props.drawing.style.accountSize ?? POSITION_DEFAULTS.accountSize;
                patchStyle({ riskAmount: Math.min(account, Math.max(1e-9, v)) });
              }}
            />
          </Show>
          <Dropdown
            value={props.drawing.style.riskDisplayMode === "money" ? moneyUnit() : "%"}
            options={["%", moneyUnit()]}
            onChange={(v) => setRiskMode(v === "%" ? "percents" : "money")}
          />
        </DialogRow>
        <DialogRow label="Entry price">
          <DecimalInput value={props.drawing.points[0]?.price ?? 0} digits={priceDigits()} onCommit={setEntryPrice} />
        </DialogRow>
        <DialogRow label="Leverage">
          <DecimalInput
            value={props.drawing.style.leverage ?? POSITION_DEFAULTS.leverage}
            digits={1}
            onCommit={(v) => patchStyle({ leverage: Math.min(10000, Math.max(1, v)) })}
          />
        </DialogRow>
        {/* Profit / stop level: ticks from the entry and the price;
            a typed price is rounded to the tick and kept one tick past
            the entry. */}
        <div class="drawing-settings-group-sep" />
        <For each={["profit", "stop"] as const}>
          {(leg) => {
            const level = () => (leg === "profit" ? posLevels().profit : posLevels().stop);
            const setLevel = (lvl: number) => patchStyle(leg === "profit" ? { profitLevel: lvl } : { stopLevel: lvl });
            const legSign = () => (leg === "profit" ? posSide() : -posSide());
            return (
              <>
                <div class="drawing-settings-section-title">{leg === "profit" ? "PROFIT LEVEL" : "STOP LEVEL"}</div>
                <DialogRow label="Ticks">
                  <DecimalInput value={Math.round(level() / pip())} onCommit={(v) => setLevel(Math.min(1e9, Math.max(0, Math.round(v))) * pip())} />
                </DialogRow>
                <DialogRow label="Price">
                  <DecimalInput
                    value={(props.drawing.points[0]?.price ?? 0) + legSign() * level()}
                    digits={priceDigits()}
                    onCommit={(v) => {
                      const entry = props.drawing.points[0]?.price;
                      if (entry != null) setLevel(levelFromPrice(v, entry, pip(), posSide(), leg));
                    }}
                  />
                </DialogRow>
                <div class="drawing-settings-group-sep" />
              </>
            );
          }}
        </For>
        <DialogRow label="QTY precision">
          <Dropdown
            value={QTY_PRECISION_OPTIONS.find((o) => o.value === (props.drawing.style.qtyPrecision ?? "default"))?.label ?? "Default"}
            options={QTY_PRECISION_OPTIONS.map((o) => o.label)}
            onChange={(v) => {
              const o = QTY_PRECISION_OPTIONS.find((x) => x.label === v);
              if (o) patchStyle({ qtyPrecision: o.value });
            }}
          />
        </DialogRow>
        <div class="drawing-settings-group-sep" />
      </Show>
      {/* Anchored VWAP Inputs: BANDS SETTINGS, Bands Calculation Mode
          (+ info tooltip), "Bands Multiplier
          #k" = band computed checkbox + multiplier, then Source. */}
      <Show when={kind() === "anchored-vwap"}>
        {/* Study Inputs page: the group title is a 50 px row. */}
        <div class="drawing-settings-section-title tall">BANDS SETTINGS</div>
        <DialogRow label="Bands Calculation Mode">
          <Dropdown
            value={props.drawing.style.vwapBandsMode === "percent" ? "Percentage" : "Standard Deviation"}
            options={["Standard Deviation", "Percentage"]}
            onChange={(v) => patchStyle({ vwapBandsMode: v === "Percentage" ? "percent" : "stdev" })}
          />
          <span class="drawing-settings-info" title="Determines the units used to calculate the distance of the bands. When 'Percentage' is selected, a multiplier of 1 means 1%.">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18"><path fill="currentColor" d="M9 17A8 8 0 1 0 9 1a8 8 0 0 0 0 16Zm1-12a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM8.5 9.5H7V8h3v6H8.5V9.5Z" /></svg>
          </span>
        </DialogRow>
        <For each={props.drawing.style.levels ?? VWAP_BAND_DEFAULTS}>
          {(lvl, i) => {
            const patchBand = (patch: Partial<LevelDef>) => {
              const cur = (props.drawing.style.levels ?? VWAP_BAND_DEFAULTS).map((l) => ({ ...l }));
              cur[i()] = { ...cur[i()], ...patch };
              patchStyle({ levels: cur });
            };
            return (
              <div class="drawing-settings-row">
                <CheckboxRow checked={lvl.visible} onChange={(v) => patchBand({ visible: v })} label={`Bands Multiplier #${i() + 1}`} />
                <div class="drawing-settings-row-inputs">
                  <DecimalInput narrow value={lvl.coeff} onCommit={(v) => patchBand({ coeff: v })} />
                </div>
              </div>
            );
          }}
        </For>
      {/* Anchored VWAP source (study input; hlc3 factory); a new
          group. */}
        <div class="drawing-settings-group-sep" />
        <DialogRow label="Source">
          <Dropdown
            value={PRICE_SOURCE_LABELS[props.drawing.style.vwapSource ?? "hlc3"]}
            options={VWAP_SOURCES.map((k) => PRICE_SOURCE_LABELS[k])}
            onChange={(v) => {
              const k = VWAP_SOURCES.find((x) => PRICE_SOURCE_LABELS[x] === v);
              if (k) patchStyle({ vwapSource: k });
            }}
          />
        </DialogRow>
      </Show>
      {/* Ghost feed Inputs: "Avg HL in minticks" (integer 1-50000,
          the frozen candle amplitude in ticks) and "Variance" (1-100). */}
      <Show when={kind() === "fixed-range-volume-profile" || kind() === "anchored-volume-profile"}>
        <VolumeProfileInputRows kind={props.drawing.kind} style={props.drawing.style} patchStyle={patchStyle} />
      </Show>
      <Show when={kind() === "ghost-feed"}>
        <DialogRow label="Avg HL in minticks">
          <input
            class="drawing-settings-level-coeff"
            type="number"
            min="1"
            max="50000"
            step="1"
            value={Math.round((props.drawing.ghost?.amplitude ?? 0) / (props.coords?.pipSize() ?? 0.01))}
            onChange={(e) => {
              const v = Math.round(Number(e.currentTarget.value));
              if (!Number.isFinite(v) || v < 1 || v > 50000 || !props.drawing.ghost) return;
              props.onUpdate({ ...props.drawing, ghost: { ...props.drawing.ghost, amplitude: v * (props.coords?.pipSize() ?? 0.01) } } as Drawing);
            }}
          />
        </DialogRow>
        <DialogRow label="Variance">
          <input
            class="drawing-settings-level-coeff"
            type="number"
            min="1"
            max="100"
            step="1"
            value={props.drawing.style.variance ?? 50}
            onChange={(e) => {
              const v = Math.round(Number(e.currentTarget.value));
              if (Number.isFinite(v) && v >= 1 && v <= 100) patchStyle({ variance: v });
            }}
          />
        </DialogRow>
      </Show>
    </>
  );
}
