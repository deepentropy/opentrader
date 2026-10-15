/*
 * Per-kind Style sections of the drawing Settings dialog: Gann square /
 * Gann box / speed fan grids, the image rows, the shape Background row and
 * the level grid (fib, pitchfork, channel families).
 */
import { createSignal, For, Show } from "solid-js";
import type { Drawing, DrawingStyle, GannLine, GannRatioLine, LevelDef, LineStyle } from "lightweight-charts-drawing/core/types";
import { GANN_ARC_DEFAULTS, GANN_BOX_LEVEL_DEFAULTS, GANN_FAN_DEFAULTS, GANN_LEVEL_DEFAULTS, SPEED_FAN_GRID_DEFAULT, SPEED_FAN_LEVEL_DEFAULTS } from "lightweight-charts-drawing/core/specs";
import { applyOpacity, parseColor } from "../ColorPanel";
import { LineGlyphSelect } from "../LineEndSelect";
import { ImageDialog, TransparencySlider } from "../ImageDialog";
import { drawingImage, imageInitialSize } from "lightweight-charts-drawing/core/kinds/images";
import { imagesVersion } from "../image-store";
import { CheckBox, CheckboxRow, ColorThicknessPicker, DecimalInput, DialogColorButton, DialogRow, Dropdown } from "./controls";
import { FONT_SIZES, LEVEL_FRAGMENT_KINDS, LEVELS_LINE_KINDS, sizeOptions } from "./kind-config";

/** Gann square / Gann square fixed Style page: LEVELS / FANS / ARCS grids (checkbox, title,
 *  colour + width; two columns), Use one color, Background (arcs fill +
 *  transparency), Reverse; Gann square adds Price/bar ratio (moves p1's
 *  price) and "Ranges and ratio" (labels on / size / B / I). */
export function GannStyleRows(props: {
  drawing: Drawing;
  coords?: import("../coords").Coords | null;
  patchStyle: (p: Partial<DrawingStyle>) => void;
  onUpdate: (d: Drawing) => void;
}) {
  const st = () => props.drawing.style;
  const grid = <T extends GannLine>(key: "gannLevels" | "gannFans" | "gannArcs", list: () => T[], title: (l: T, i: number) => string) => (
    <div class="drawing-settings-levels two-col">
      <For each={list()}>
        {(l, i) => {
          const patch = (p: Partial<GannLine>) => {
            const cur = list().map((x) => ({ ...x }));
            cur[i()] = { ...cur[i()], ...p };
            props.patchStyle({ [key]: cur } as Partial<DrawingStyle>);
          };
          return (
            <div class={"drawing-settings-level-row" + (l.visible ? "" : " off")}>
              <CheckBox checked={l.visible} onChange={(v) => patch({ visible: v })} />
              <span class="drawing-settings-level-coeff is-fixed">{title(l, i())}</span>
              <ColorThicknessPicker color={l.color} width={l.width} onColor={(c) => patch({ color: c })} onWidth={(w) => patch({ width: w })} />
            </div>
          );
        }}
      </For>
    </div>
  );
  const levels = () => st().gannLevels ?? GANN_LEVEL_DEFAULTS;
  const fans = () => st().gannFans ?? GANN_FAN_DEFAULTS;
  const arcs = () => st().gannArcs ?? GANN_ARC_DEFAULTS;
  const ratio = (): number | null => {
    const c = props.coords;
    const [p0, p1] = props.drawing.points;
    if (!c || !p0 || !p1) return null;
    const i0 = c.timeToBarIndex(p0.time);
    const i1 = c.timeToBarIndex(p1.time);
    return i0 == null || i1 == null || i0 === i1 ? null : Math.abs((p1.price - p0.price) / (i1 - i0));
  };
  const setRatio = (v: number) => {
    const c = props.coords;
    const [p0, p1] = props.drawing.points;
    if (!c || !p0 || !p1 || !(v > 0)) return;
    const i0 = c.timeToBarIndex(p0.time);
    const i1 = c.timeToBarIndex(p1.time);
    if (i0 == null || i1 == null) return;
    const bars = Math.abs(i1 - i0);
    // Moves p1 (p0 when reversed), keeping its side of the other point.
    if (st().reverse) {
      const sign = p0.price - p1.price >= 0 ? 1 : -1;
      props.onUpdate({ ...props.drawing, points: [{ ...p0, price: p1.price + sign * bars * v }, p1] } as Drawing);
    } else {
      const sign = p1.price - p0.price >= 0 ? 1 : -1;
      props.onUpdate({ ...props.drawing, points: [p0, { ...p1, price: p0.price + sign * bars * v }] } as Drawing);
    }
  };
  const setReverse = (v: boolean) => {
    // Gann square fixed swaps its stored points; Gann square draws swapped.
    if (props.drawing.kind === "gann-square-fixed") {
      const [p0, p1] = props.drawing.points;
      props.onUpdate({ ...props.drawing, points: [p1, p0], style: { ...st(), reverse: v } } as Drawing);
    } else props.patchStyle({ reverse: v });
  };
  return (
    <>
      <div class="drawing-settings-section-title">LEVELS</div>
      {grid("gannLevels", levels, (_l, i) => String(i))}
      <div class="drawing-settings-group-sep" />
      <div class="drawing-settings-section-title">FANS</div>
      {grid("gannFans", fans, (l: GannRatioLine) => `${l.x}x${l.y}`)}
      <div class="drawing-settings-group-sep" />
      <div class="drawing-settings-section-title">ARCS</div>
      {grid("gannArcs", arcs, (l: GannRatioLine) => `${l.x}x${l.y}`)}
      <div class="drawing-settings-group-sep" />
      <DialogRow label="Use one color">
        <DialogColorButton
          color={levels()[0]?.color ?? "#808080"}
          onColor={(c) =>
            props.patchStyle({
              gannLevels: levels().map((l) => ({ ...l, color: c })),
              gannFans: fans().map((l) => ({ ...l, color: c })),
              gannArcs: arcs().map((l) => ({ ...l, color: c })),
            })
          }
        />
      </DialogRow>
      <div class="drawing-settings-row">
        <CheckboxRow checked={st().fillBackground !== false} onChange={(v) => props.patchStyle({ fillBackground: v })} label="Background" />
        <div class="drawing-settings-row-inputs">
          <TransparencySlider value={st().transparency ?? 80} onChange={(t) => props.patchStyle({ transparency: t })} />
        </div>
      </div>
      <CheckboxRow checked={!!st().reverse} onChange={setReverse} label="Reverse" />
      <Show when={props.drawing.kind === "gann-square"}>
        <DialogRow label="Price/bar ratio">
          <DecimalInput value={ratio() ?? 0} onCommit={setRatio} />
        </DialogRow>
        <div class="drawing-settings-row">
          <CheckboxRow checked={st().showLabels !== false} onChange={(v) => props.patchStyle({ showLabels: v })} label="Ranges and ratio" />
          <div class="drawing-settings-row-inputs drawing-settings-text-format">
            <Dropdown value={String(st().labelFontSize ?? 12)} options={sizeOptions(FONT_SIZES, String(st().labelFontSize ?? 12))} onChange={(v) => props.patchStyle({ labelFontSize: Number(v) })} />
            <button type="button" class={"drawing-settings-text-toggle" + (st().bold ? " active" : "")} style={{ "font-weight": 700 }} aria-pressed={!!st().bold} title="Bold" onClick={() => props.patchStyle({ bold: !st().bold })}>
              B
            </button>
            <button type="button" class={"drawing-settings-text-toggle" + (st().italic ? " active" : "")} style={{ "font-style": "italic" }} aria-pressed={!!st().italic} title="Italic" onClick={() => props.patchStyle({ italic: !st().italic })}>
              I
            </button>
          </div>
        </div>
      </Show>
    </>
  );
}

/** Gann box Style page: PRICE LEVELS grid (checkbox, value, colour; two columns), Left / Right
 *  labels, Background (+ transparency); TIME LEVELS grid, Top / Bottom
 *  labels, Background; Use one color (drawing, angles and every level
 *  colour); Angles (checkbox + colour); Reverse. */
export function GannBoxStyleRows(props: { style: DrawingStyle; patchStyle: (p: Partial<DrawingStyle>) => void }) {
  const hLevels = () => props.style.levels ?? GANN_BOX_LEVEL_DEFAULTS;
  const vLevels = () => props.style.vLevels ?? GANN_BOX_LEVEL_DEFAULTS;
  const fans = () => props.style.fans ?? { visible: false, color: "#9C9C9C" };
  const grid = (key: "levels" | "vLevels", list: () => LevelDef[]) => (
    <div class="drawing-settings-levels two-col">
      <For each={list()}>
        {(lvl, i) => {
          const patch = (p: Partial<LevelDef>) => {
            const cur = list().map((l) => ({ ...l }));
            cur[i()] = { ...cur[i()], ...p };
            props.patchStyle({ [key]: cur } as Partial<DrawingStyle>);
          };
          return (
            <div class={"drawing-settings-level-row" + (lvl.visible ? "" : " off")}>
              <CheckBox checked={lvl.visible} onChange={(v) => patch({ visible: v })} />
              <DecimalInput narrow value={lvl.coeff} onCommit={(v) => patch({ coeff: v })} />
              <DialogColorButton color={lvl.color} onColor={(c) => patch({ color: c })} />
            </div>
          );
        }}
      </For>
    </div>
  );
  const background = (on: boolean, t: number, onOn: (v: boolean) => void, onT: (t: number) => void) => (
    <div class="drawing-settings-row">
      <CheckboxRow checked={on} onChange={onOn} label="Background" />
      <div class="drawing-settings-row-inputs">
        <TransparencySlider value={t} onChange={onT} />
      </div>
    </div>
  );
  // Line colors: color, fans.color and every level colour.
  const allColors = () => [props.style.color, fans().color, ...hLevels().map((l) => l.color), ...vLevels().map((l) => l.color)];
  const sameColor = () => allColors().every((c) => parseColor(c).hex === parseColor(allColors()[0]).hex);
  return (
    <>
      <div class="drawing-settings-section-title">PRICE LEVELS</div>
      {grid("levels", hLevels)}
      <CheckboxRow checked={props.style.showLeftLabels !== false} onChange={(v) => props.patchStyle({ showLeftLabels: v })} label="Left labels" />
      <CheckboxRow checked={props.style.showRightLabels !== false} onChange={(v) => props.patchStyle({ showRightLabels: v })} label="Right labels" />
      {background(props.style.fillBackground !== false, props.style.transparency ?? 80, (v) => props.patchStyle({ fillBackground: v }), (t) => props.patchStyle({ transparency: t }))}
      <div class="drawing-settings-group-sep" />
      <div class="drawing-settings-section-title">TIME LEVELS</div>
      {grid("vLevels", vLevels)}
      <CheckboxRow checked={props.style.showTopLabels !== false} onChange={(v) => props.patchStyle({ showTopLabels: v })} label="Top labels" />
      <CheckboxRow checked={props.style.showBottomLabels !== false} onChange={(v) => props.patchStyle({ showBottomLabels: v })} label="Bottom labels" />
      {background(props.style.fillVertBackground !== false, props.style.vertTransparency ?? 80, (v) => props.patchStyle({ fillVertBackground: v }), (t) => props.patchStyle({ vertTransparency: t }))}
      <div class="drawing-settings-group-sep" />
      <DialogRow label="Use one color">
        <DialogColorButton
          color={hLevels()[0]?.color ?? "#808080"}
          mixed={!sameColor()}
          onColor={(c) =>
            props.patchStyle({
              color: c,
              fans: { ...fans(), color: c },
              levels: hLevels().map((l) => ({ ...l, color: c })),
              vLevels: vLevels().map((l) => ({ ...l, color: c })),
            })
          }
        />
      </DialogRow>
      <div class="drawing-settings-row">
        <CheckboxRow checked={fans().visible} onChange={(v) => props.patchStyle({ fans: { ...fans(), visible: v } })} label="Angles" />
        <div class="drawing-settings-row-inputs">
          <DialogColorButton color={fans().color} onColor={(c) => props.patchStyle({ fans: { ...fans(), color: c } })} />
        </div>
      </div>
      <CheckboxRow checked={!!props.style.reverse} onChange={(v) => props.patchStyle({ reverse: v })} label="Reverse" />
    </>
  );
}

/** Fib speed resistance fan Style page: PRICE LEVELS grid
 *  (checkbox, value, colour; two columns) + Left / Right labels, TIME LEVELS
 *  grid + Top / Bottom labels, Use one color (every level and the grid),
 *  Background (checkbox + transparency), Grid (checkbox + line), Reverse. */
export function SpeedFanStyleRows(props: { style: DrawingStyle; patchStyle: (p: Partial<DrawingStyle>) => void }) {
  const hLevels = () => props.style.levels ?? SPEED_FAN_LEVEL_DEFAULTS;
  const vLevels = () => props.style.vLevels ?? props.style.levels ?? SPEED_FAN_LEVEL_DEFAULTS;
  const grid = () => props.style.fanGrid ?? SPEED_FAN_GRID_DEFAULT;
  const grid2 = (key: "levels" | "vLevels", list: () => LevelDef[]) => (
    <div class="drawing-settings-levels two-col">
      <For each={list()}>
        {(lvl, i) => {
          const patch = (p: Partial<LevelDef>) => {
            const cur = list().map((l) => ({ ...l }));
            cur[i()] = { ...cur[i()], ...p };
            props.patchStyle({ [key]: cur } as Partial<DrawingStyle>);
          };
          return (
            <div class={"drawing-settings-level-row" + (lvl.visible ? "" : " off")}>
              <CheckBox checked={lvl.visible} onChange={(v) => patch({ visible: v })} />
              <DecimalInput narrow value={lvl.coeff} onCommit={(v) => patch({ coeff: v })} />
              <DialogColorButton color={lvl.color} onColor={(c) => patch({ color: c })} />
            </div>
          );
        }}
      </For>
    </div>
  );
  return (
    <>
      <div class="drawing-settings-section-title">PRICE LEVELS</div>
      {grid2("levels", hLevels)}
      <CheckboxRow checked={props.style.showLeftLabels !== false} onChange={(v) => props.patchStyle({ showLeftLabels: v })} label="Left labels" />
      <CheckboxRow checked={props.style.showRightLabels !== false} onChange={(v) => props.patchStyle({ showRightLabels: v })} label="Right labels" />
      <div class="drawing-settings-group-sep" />
      <div class="drawing-settings-section-title">TIME LEVELS</div>
      {grid2("vLevels", vLevels)}
      <CheckboxRow checked={props.style.showTopLabels !== false} onChange={(v) => props.patchStyle({ showTopLabels: v })} label="Top labels" />
      <CheckboxRow checked={props.style.showBottomLabels !== false} onChange={(v) => props.patchStyle({ showBottomLabels: v })} label="Bottom labels" />
      <div class="drawing-settings-group-sep" />
      <DialogRow label="Use one color">
        <DialogColorButton
          color={hLevels()[0]?.color ?? "#808080"}
          onColor={(c) =>
            props.patchStyle({
              levels: hLevels().map((l) => ({ ...l, color: c })),
              vLevels: vLevels().map((l) => ({ ...l, color: c })),
              fanGrid: { ...grid(), color: c },
            })
          }
        />
      </DialogRow>
      <div class="drawing-settings-row">
        <CheckboxRow checked={props.style.fillBackground !== false} onChange={(v) => props.patchStyle({ fillBackground: v })} label="Background" />
        <div class="drawing-settings-row-inputs">
          <TransparencySlider value={props.style.transparency ?? 80} onChange={(t) => props.patchStyle({ transparency: t })} />
        </div>
      </div>
      <div class="drawing-settings-row">
        <CheckboxRow checked={grid().visible} onChange={(v) => props.patchStyle({ fanGrid: { ...grid(), visible: v } })} label="Grid" />
        <div class="drawing-settings-row-inputs">
          <ColorThicknessPicker
            color={grid().color}
            width={grid().width}
            lineStyle={grid().style}
            onColor={(c) => props.patchStyle({ fanGrid: { ...grid(), color: c } })}
            onWidth={(w) => props.patchStyle({ fanGrid: { ...grid(), width: w } })}
            onLineStyle={(st) => props.patchStyle({ fanGrid: { ...grid(), style: st } })}
          />
        </div>
      </div>
      <CheckboxRow checked={!!props.style.reverse} onChange={(v) => props.patchStyle({ reverse: v })} label="Reverse" />
    </>
  );
}

/** Image Style rows: "Image" (the current picture; a click opens the Image
 *  dialog to replace it) and "Transparency". */
export function ImageStyleRows(props: {
  drawing: Drawing;
  coords?: import("../coords").Coords | null;
  onUpdate: (d: Drawing) => void;
  patchStyle: (p: Partial<DrawingStyle>) => void;
}) {
  const [picking, setPicking] = createSignal(false);
  const url = () => {
    void imagesVersion();
    return drawingImage(props.drawing.image?.name)?.url ?? "";
  };
  return (
    <>
      <DialogRow label="Image">
        <button type="button" class="drawing-settings-image-thumb" aria-label="Image" onClick={() => setPicking(true)}>
          <Show when={url()}>
            <img src={url()} alt="" />
          </Show>
        </button>
      </DialogRow>
      <DialogRow label="Transparency">
        <TransparencySlider value={props.drawing.style.transparency ?? 0} onChange={(t) => props.patchStyle({ transparency: t })} />
      </DialogRow>
      <Show when={picking()}>
        <ImageDialog
          transparency={props.drawing.style.transparency ?? 0}
          onConfirm={(r) => {
            // The new picture fits the current box.
            const cur = props.drawing.image;
            const size = cur ? imageInitialSize(r.width, r.height, cur.cssWidth * 4, cur.cssHeight * 4) : { cssWidth: r.width, cssHeight: r.height };
            props.onUpdate({
              ...props.drawing,
              image: { name: r.name, ...size },
              style: { ...props.drawing.style, transparency: r.transparency },
            } as Drawing);
          }}
          onClose={() => setPicking(false)}
        />
      </Show>
    </>
  );
}

/** Background row for shapes: check box + colour button; the colour
 *  panel opacity is 100 - transparency. */
export function BackgroundColorRow(props: { style: DrawingStyle; patchStyle: (p: Partial<DrawingStyle>) => void; fallbackColor?: string }) {
  const color = () => applyOpacity(parseColor(props.style.backgroundColor ?? props.fallbackColor ?? props.style.color).hex, 100 - (props.style.transparency ?? 50));
  return (
    <div class="drawing-settings-row">
      <CheckboxRow checked={!!props.style.fillBackground} onChange={(v) => props.patchStyle({ fillBackground: v })} label="Background" />
      <div class="drawing-settings-row-inputs">
        <DialogColorButton
          color={color()}
          onColor={(c) => {
            const pc = parseColor(c);
            props.patchStyle({ backgroundColor: pc.hex, transparency: 100 - pc.opacity });
          }}
        />
      </div>
    </div>
  );
}

/** Level grid + "Use one color" + "Background" (see the call site). */
export function LevelGridRows(props: { kind: string; style: DrawingStyle; defaults: LevelDef[]; patchStyle: (p: Partial<DrawingStyle>) => void; extendRow?: import("solid-js").JSX.Element }) {
  const levels = () => props.style.levels ?? props.defaults;
  const patchLevel = (i: number, patch: Partial<LevelDef>) => {
    const cur = levels().map((l) => ({ ...l }));
    cur[i] = { ...cur[i], ...patch };
    props.patchStyle({ levels: cur });
  };
  const fragment = () => LEVEL_FRAGMENT_KINDS.has(props.kind);
  // "Use one color": the common colour, or an empty swatch when they differ.
  const sameColor = () => {
    const l = levels();
    return l.length > 0 && l.every((x) => parseColor(x.color).hex === parseColor(l[0].color).hex);
  };
  const first = () => levels()[0];
  return (
    <>
      <Show when={LEVELS_LINE_KINDS.has(props.kind)}>
        <DialogRow label="Levels line">
          <LineGlyphSelect kind="width" value={first()?.width ?? props.style.width} options={[1, 2, 3, 4]} onChange={(v) => props.patchStyle({ levels: levels().map((l) => ({ ...l, width: v })) })} />
          <LineGlyphSelect kind="style" value={(first()?.style ?? props.style.lineStyle) as LineStyle} options={["solid", "dashed", "dotted"] as LineStyle[]} onChange={(v) => props.patchStyle({ levels: levels().map((l) => ({ ...l, style: v })) })} />
        </DialogRow>
      </Show>
      {props.extendRow}
      <div class={"drawing-settings-levels" + (fragment() ? " two-col" : "")}>
        <For each={levels()}>
          {(lvl, i) => (
            <div class={"drawing-settings-level-row" + (lvl.visible ? "" : " off")}>
              <Show
                when={!lvl.label}
                fallback={
                  // Gann fan: the ratio is the row title (label column).
                  <span class="drawing-settings-level-title">
                    <CheckboxRow checked={lvl.visible} onChange={(v) => patchLevel(i(), { visible: v })} label={lvl.label ?? ""} />
                  </span>
                }
              >
                <CheckBox
                  checked={lvl.visible}
                  // Parallel channel: levels 0 and 1 (rows 2 and 6) are locked on.
                  disabled={props.kind === "parallel-channel" && (i() === 1 || i() === 5)}
                  onChange={(v) => patchLevel(i(), { visible: v })}
                />
                <DecimalInput narrow value={lvl.coeff} onCommit={(v) => patchLevel(i(), { coeff: v })} />
              </Show>
              <Show
                when={!fragment()}
                fallback={<DialogColorButton color={lvl.color} onColor={(c) => patchLevel(i(), { color: c })} />}
              >
                <ColorThicknessPicker
                  color={lvl.color}
                  width={lvl.width ?? props.style.width}
                  lineStyle={lvl.style ?? props.style.lineStyle}
                  onColor={(c) => patchLevel(i(), { color: c })}
                  onWidth={(w) => patchLevel(i(), { width: w })}
                  onLineStyle={(st) => patchLevel(i(), { style: st })}
                />
              </Show>
            </div>
          )}
        </For>
      </div>
      <Show when={fragment()}>
        <div class="drawing-settings-group-sep" />
      </Show>
      <Show when={props.kind !== "parallel-channel"}>
        <DialogRow label="Use one color">
          <DialogColorButton color={levels()[0]?.color ?? "#808080"} mixed={!sameColor()} onColor={(c) => props.patchStyle({ levels: levels().map((l) => ({ ...l, color: c })) })} />
        </DialogRow>
        <Show when={props.style.fillBackground !== undefined}>
          <div class="drawing-settings-row">
            <CheckboxRow checked={!!props.style.fillBackground} onChange={(v) => props.patchStyle({ fillBackground: v })} label="Background" />
            <div class="drawing-settings-row-inputs">
              <TransparencySlider value={props.style.transparency ?? 80} onChange={(t) => props.patchStyle({ transparency: t })} />
            </div>
          </div>
        </Show>
      </Show>
    </>
  );
}
