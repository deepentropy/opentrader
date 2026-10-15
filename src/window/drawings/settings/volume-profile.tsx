/*
 * Volume profile tools in the drawing Settings dialog (fixed range and
 * anchored): the Inputs rows and the Style rows of the profile study.
 */
import { Show } from "solid-js";
import type { DrawingKind, DrawingStyle, VolumeProfileStyle } from "lightweight-charts-drawing/core/types";
import { volumeProfileStyle } from "lightweight-charts-drawing/core/specs";
import { CheckboxRow, ColorThicknessPicker, DecimalInput, DialogColorButton, DialogRow, Dropdown } from "./controls";

// ── Volume profile tools (reference VbPFixed / VbPAnchored study) ──────────

const VP_ROWS_LAYOUTS = [["rows", "Number Of Rows"], ["ticks", "Ticks Per Row"]] as const;
const VP_VOLUMES = [["upDown", "Up/Down"], ["total", "Total"], ["delta", "Delta"]] as const;
const labelOf = <T extends string>(list: ReadonlyArray<readonly [T, string]>, v: T) => list.find(([k]) => k === v)?.[1] ?? "";
const valueOf = <T extends string>(list: ReadonlyArray<readonly [T, string]>, label: string) => list.find(([, l]) => l === label)?.[0];

/** Inputs page: Rows Layout, Row Size, Volume, Value Area Volume, and Extend
 *  Right (fixed range only). */
export function VolumeProfileInputRows(props: { kind: DrawingKind; style: DrawingStyle; patchStyle: (p: Partial<DrawingStyle>) => void }) {
  const vp = () => volumeProfileStyle(props.kind, props.style);
  const patch = (p: Partial<VolumeProfileStyle>) => props.patchStyle({ vp: { ...vp(), ...p } });
  const int = (v: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(v)));
  return (
    <>
      <DialogRow label="Rows Layout">
        <Dropdown
          value={labelOf(VP_ROWS_LAYOUTS, vp().rowsLayout)}
          options={VP_ROWS_LAYOUTS.map(([, l]) => l)}
          onChange={(l) => { const v = valueOf(VP_ROWS_LAYOUTS, l); if (v) patch({ rowsLayout: v }); }}
          mid
        />
      </DialogRow>
      <DialogRow label="Row Size">
        <DecimalInput value={vp().rows} onCommit={(v) => patch({ rows: int(v, 1, 1000000) })} />
      </DialogRow>
      <DialogRow label="Volume">
        <Dropdown
          value={labelOf(VP_VOLUMES, vp().volume)}
          options={VP_VOLUMES.map(([, l]) => l)}
          onChange={(l) => { const v = valueOf(VP_VOLUMES, l); if (v) patch({ volume: v }); }}
        />
      </DialogRow>
      <DialogRow label="Value Area Volume">
        <DecimalInput value={vp().vaVolume} onCommit={(v) => patch({ vaVolume: int(v, 0, 100) })} />
      </DialogRow>
      <Show when={props.kind === "fixed-range-volume-profile"}>
        <CheckboxRow checked={vp().extendRight} onChange={(v) => patch({ extendRight: v })} label="Extend Right" />
      </Show>
    </>
  );
}

/** Style page: Volume profile (visible), its child rows Values (+ colour),
 *  Width (% of the box), Placement, Up / Down Volume, Value Area Up / Down;
 *  then VAH, VAL, POC, Developing POC, Developing VA (checkbox + line) and
 *  Histogram Box (colour). */
export function VolumeProfileStyleRows(props: { kind: DrawingKind; style: DrawingStyle; patchStyle: (p: Partial<DrawingStyle>) => void }) {
  const vp = () => volumeProfileStyle(props.kind, props.style);
  const patch = (p: Partial<VolumeProfileStyle>) => props.patchStyle({ vp: { ...vp(), ...p } });
  const lineRow = (title: string, key: "vah" | "val" | "poc" | "developingPoc") => (
    <div class="drawing-settings-row">
      <CheckboxRow checked={vp()[key].visible} onChange={(v) => patch({ [key]: { ...vp()[key], visible: v } })} label={title} />
      <div class="drawing-settings-row-inputs">
        <ColorThicknessPicker
          color={vp()[key].color}
          width={vp()[key].width}
          lineStyle={vp()[key].style}
          onColor={(c) => patch({ [key]: { ...vp()[key], color: c } })}
          onWidth={(w) => patch({ [key]: { ...vp()[key], width: w } })}
          onLineStyle={(s) => patch({ [key]: { ...vp()[key], style: s } })}
        />
      </div>
    </div>
  );
  const colorRow = (title: string, key: "upColor" | "downColor" | "vaUpColor" | "vaDownColor") => (
    <div class="drawing-settings-row is-child">
      <div class="drawing-settings-row-label">{title}</div>
      <div class="drawing-settings-row-inputs">
        <DialogColorButton color={vp()[key]} onColor={(c) => patch({ [key]: c })} />
      </div>
    </div>
  );
  return (
    <>
      <CheckboxRow checked={vp().visible} onChange={(v) => patch({ visible: v })} label="Volume profile" />
      <div class="drawing-settings-row is-child">
        <CheckboxRow checked={vp().showValues} onChange={(v) => patch({ showValues: v })} label="Values" />
        <div class="drawing-settings-row-inputs">
          <DialogColorButton color={vp().valuesColor} onColor={(c) => patch({ valuesColor: c })} />
        </div>
      </div>
      <div class="drawing-settings-row is-child">
        <div class="drawing-settings-row-label">Width (% of the box)</div>
        <div class="drawing-settings-row-inputs">
          <DecimalInput value={vp().percentWidth} onCommit={(v) => patch({ percentWidth: Math.min(100, Math.max(0, Math.round(v))) })} />
        </div>
      </div>
      <div class="drawing-settings-row is-child">
        <div class="drawing-settings-row-label">Placement</div>
        <div class="drawing-settings-row-inputs">
          <Dropdown
            value={vp().placement === "right" ? "Right" : "Left"}
            options={["Right", "Left"]}
            onChange={(v) => patch({ placement: v === "Right" ? "right" : "left" })}
          />
        </div>
      </div>
      {colorRow("Up Volume", "upColor")}
      {colorRow("Down Volume", "downColor")}
      {colorRow("Value Area Up", "vaUpColor")}
      {colorRow("Value Area Down", "vaDownColor")}
      {lineRow("VAH", "vah")}
      {lineRow("VAL", "val")}
      {lineRow("POC", "poc")}
      {lineRow("Developing POC", "developingPoc")}
      {/* Developing VA: one row for the VA high and low plots. */}
      <div class="drawing-settings-row">
        <CheckboxRow
          checked={vp().developingVah.visible}
          onChange={(v) => patch({ developingVah: { ...vp().developingVah, visible: v }, developingVal: { ...vp().developingVal, visible: v } })}
          label="Developing VA"
        />
        <div class="drawing-settings-row-inputs">
          <ColorThicknessPicker
            color={vp().developingVah.color}
            width={vp().developingVah.width}
            lineStyle={vp().developingVah.style}
            onColor={(c) => patch({ developingVah: { ...vp().developingVah, color: c }, developingVal: { ...vp().developingVal, color: c } })}
            onWidth={(w) => patch({ developingVah: { ...vp().developingVah, width: w }, developingVal: { ...vp().developingVal, width: w } })}
            onLineStyle={(s) => patch({ developingVah: { ...vp().developingVah, style: s }, developingVal: { ...vp().developingVal, style: s } })}
          />
        </div>
      </div>
      <div class="drawing-settings-row">
        <div class="drawing-settings-row-label">Histogram Box</div>
        <div class="drawing-settings-row-inputs">
          <DialogColorButton color={vp().boxColor} onColor={(c) => patch({ boxColor: c })} />
        </div>
      </div>
    </>
  );
}
