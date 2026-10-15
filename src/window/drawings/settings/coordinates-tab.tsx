/*
 * Coordinates page of the drawing Settings dialog: one row per anchor
 * (price and / or bar, signpost vertical position), the parallel channel
 * "Price offset" and the trend angle "Angle".
 */
import { For, Show, type JSX } from "solid-js";
import type { Time } from "lightweight-charts";
import type { DataPoint, Drawing } from "lightweight-charts-drawing/core/types";
import { DecimalInput, DialogRow } from "./controls";
import { COORD_MODES } from "./kind-config";
import { type SettingsCx } from "./context";

export function coordinatesTab(cx: SettingsCx): JSX.Element {
  const { kind, patchStyle, priceDigits, props } = cx;
  /** Replace one point in the drawing (Coordinates tab edits). Preserves the
   *  discriminated-union tuple arity via the `as Drawing` cast. */
  function updatePoint(i: number, patch: Partial<DataPoint>) {
    const next = props.drawing.points.map((p, idx) => (idx === i ? { ...p, ...patch } : p));
    props.onUpdate({ ...props.drawing, points: next } as Drawing);
  }

  /** Coordinates rows: parallel channel and trend angle show fewer points
   *  (Price offset / Angle rows stand for the rest). */
  const coordPoints = () => {
    const k = kind();
    return k === "parallel-channel" || k === "trend-angle" ? props.drawing.points.slice(0, k === "trend-angle" ? 1 : 2) : props.drawing.points;
  };
  const trendAngleValue = () => {
    const st = props.drawing.style;
    if (st.angle != null) return st.angle;
    const c = props.coords;
    const [p0, p1] = props.drawing.points;
    if (!c || !p0 || !p1) return 0;
    const x0 = c.timeToX(p0.time), y0 = c.priceToY(p0.price), x1 = c.timeToX(p1.time), y1 = c.priceToY(p1.price);
    return x0 == null || y0 == null || x1 == null || y1 == null ? 0 : (Math.atan2(-(y1 - y0), x1 - x0) * 180) / Math.PI;
  };
  const setTrendAngle = (deg: number) => {
    const c = props.coords;
    const [p0, p1] = props.drawing.points;
    if (!c || !p0 || !p1) return;
    const x0 = c.timeToX(p0.time), y0 = c.priceToY(p0.price), x1 = c.timeToX(p1.time), y1 = c.priceToY(p1.price);
    if (x0 == null || y0 == null || x1 == null || y1 == null) return;
    const len = Math.hypot(x1 - x0, y1 - y0);
    const th = (deg * Math.PI) / 180;
    const t = c.xToTime(x0 + len * Math.cos(th));
    const pr = c.yToPrice(y0 - len * Math.sin(th));
    if (t == null || pr == null) return;
    props.onUpdate({ ...props.drawing, points: [p0, { time: t, price: pr }], style: { ...props.drawing.style, angle: deg } } as Drawing);
  };

  /** Display string for a point's bar index (empty when coords aren't ready). */
  const barIndexOf = (t: Time): string => {
    const idx = props.coords?.timeToBarIndex(t);
    return idx == null ? "" : String(idx);
  };

  return (
    <>
      {/* One row per anchor, "#N (price, bar)" then its inputs.
          Variants: horizontal line price only, vertical line
          and regression trend bar only, trend angle #1 + "Angle",
          parallel channel #1, #2 + "Price offset". */}
      <For each={coordPoints()}>
        {(pt, i) => {
          const mode = () => COORD_MODES[kind()] ?? "price, bar";
          return (
            <div class="drawing-settings-row">
              <div class="drawing-settings-row-label drawing-settings-coord-label">
                #{i() + 1} ({mode()})
              </div>
              <div class="drawing-settings-row-inputs">
                <Show when={mode() === "vertical position %, bar"}>
                  <DecimalInput
                    digits={2}
                    value={Math.abs(props.drawing.style.signpostPosition ?? 50)}
                    onCommit={(v) => {
                      const sign = (props.drawing.style.signpostPosition ?? 50) < 0 ? -1 : 1;
                      patchStyle({ signpostPosition: sign * Math.max(0, Math.min(100, v)) });
                    }}
                  />
                </Show>
                <Show when={mode() !== "bar" && mode() !== "vertical position %, bar"}>
                  <input
                    type="text"
                    class="drawing-settings-input"
                    aria-label={`Point ${i() + 1} price`}
                    value={pt.price.toFixed(priceDigits())}
                    onChange={(e) => {
                      const v = parseFloat(e.currentTarget.value);
                      if (Number.isFinite(v)) updatePoint(i(), { price: v });
                      else e.currentTarget.value = pt.price.toFixed(priceDigits());
                    }}
                  />
                </Show>
                <Show when={mode() !== "price"}>
                  <input
                    type="text"
                    class="drawing-settings-input"
                    aria-label={`Point ${i() + 1} bar`}
                    disabled={!props.coords}
                    value={barIndexOf(pt.time)}
                    onChange={(e) => {
                      const n = parseInt(e.currentTarget.value, 10);
                      const t = Number.isFinite(n) ? props.coords?.barIndexToTime(n) : null;
                      if (t != null) updatePoint(i(), { time: t });
                      else e.currentTarget.value = barIndexOf(pt.time);
                    }}
                  />
                </Show>
              </div>
            </div>
          );
        }}
      </For>
      {/* Parallel channel "Price offset": the second line's price
          distance (OpenTrader p2 sits at p0's time). */}
      <Show when={kind() === "parallel-channel" && props.drawing.points[2]}>
        <DialogRow label="Price offset">
          <DecimalInput
            digits={2}
            value={(props.drawing.points[2]?.price ?? 0) - props.drawing.points[0].price}
            onCommit={(v) => updatePoint(2, { price: props.drawing.points[0].price + v })}
          />
        </DialogRow>
      </Show>
      {/* Trend angle "Angle": turns p1 around p0 in screen space,
          keeping the length. */}
      <Show when={kind() === "trend-angle"}>
        <DialogRow label="Angle">
          <DecimalInput digits={2} value={trendAngleValue()} onCommit={setTrendAngle} />
        </DialogRow>
      </Show>
    </>
  );
}
