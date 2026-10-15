/*
 * Axis parts of the drawings overlay: the time label of a vertical / cross
 * line, the price pills of a position, and the time / price scale labels of
 * a drawing's points.
 */
import { Show } from "solid-js";
import type { Coords } from "../coords";
import type { Drawing } from "lightweight-charts-drawing/core/types";
import type { Pt } from "lightweight-charts-drawing/core/_shared";
import { positionAnchors } from "lightweight-charts-drawing/core/kinds/position";
import { textOnColor } from "lightweight-charts-drawing/core/color";
import { measureTextFont } from "lightweight-charts-drawing/core/scene/text";

/** Kinds with parts on an axis (drawn outside the pane clip). */
export const AXIS_PART_KINDS = new Set<string>(["vertical-line", "cross-line", "long-position", "short-position"]);

/** Axis parts of a drawing: the time label of a vertical / cross line on the
 *  time axis (show time) and the entry / target / stop price pills of a
 *  position on the price axis (axis labels for the three levels).
 *  `pane` = the pane size, `svgW` = the overlay width (pane + price axis). */
export function renderAxisParts(d: Drawing, pts: Pt[], pane: { w: number; h: number }, svgW: number, coords: Coords | null, top = 0) {
  const s = d.style;
  if (d.kind === "vertical-line" || d.kind === "cross-line") {
    const t0 = d.points[0];
    return (
      <Show when={!!s.showTime && !!t0}>
        <TimeAxisLabel x={pts[0].x} h={pane.h} time={t0.time} color={s.color} coords={coords} />
      </Show>
    );
  }
  if ((d.kind === "long-position" || d.kind === "short-position") && s.showPriceLabels !== false) {
    const pa = positionAnchors(d, pts, coords);
    if (!pa) return null;
    const entry = d.points[0].price;
    const sign = d.kind === "long-position" ? 1 : -1;
    const pill = (y: number, price: number, bg: string) => {
      const label = price.toFixed(2);
      const pw = label.length * 6.5 + 10;
      return (
        <g pointer-events="none">
          <rect x={svgW - pw - 2} y={y - 8} width={pw} height={16} rx={2} fill={bg} />
          <text x={svgW - pw / 2 - 2} y={y + 4} font-size="10" fill="#ffffff" text-anchor="middle">{label}</text>
        </g>
      );
    };
    return (
      <>
        {pill(top + pts[0].y, entry, "#787b86")}
        {pill(top + pa.yTarget, entry + sign * pa.profit, "#089981")}
        {pill(top + pa.yStop, entry - sign * pa.stop, "#f23645")}
      </>
    );
  }
  return null;
}

/** Time-axis label of a vertical line / cross line (`showTime`): the
 *  crosshair label in the line colour. Time axis view renderer (the same as
 *  the lightweight-charts crosshair label): chart date-time text, axis font,
 *  padding 9·fs/12, height 1 + 5 + fs/4 + fs + fs/4 from the axis top, bottom
 *  corners radius 2, kept inside the axis width. */
export function TimeAxisLabel(props: { x: number; h: number; time: import("lightweight-charts").Time; color: string; coords: Coords | null }) {
  const geo = () => {
    const c = props.coords;
    if (!c) return null;
    const ax = c.timeAxis();
    const text = c.formatTime(props.time);
    const fs = ax.fontSize;
    const padH = (9 * fs) / 12;
    const lw = Math.round(measureTextFont(text, fs, ax.fontFamily)) + 2 * padH;
    let cx = props.x;
    let x1 = Math.floor(cx - lw / 2) + 0.5;
    if (x1 < 0) {
      cx += -x1;
      x1 = Math.floor(cx - lw / 2) + 0.5;
    } else if (x1 + lw > ax.width) {
      cx -= x1 + lw - ax.width;
      x1 = Math.floor(cx - lw / 2) + 0.5;
    }
    const top = props.h; // pane height = the time axis top
    const y2 = top + Math.ceil(1 + 5 + fs / 4 + fs + fs / 4);
    const x2 = x1 + lw;
    const r = 2;
    const path = `M ${x1} ${top} V ${y2 - r} Q ${x1} ${y2} ${x1 + r} ${y2} H ${x2 - r} Q ${x2} ${y2} ${x2} ${y2 - r} V ${top} Z`;
    return { path, text, fs, font: ax.fontFamily, tx: x1 + padH, ty: top + 1 + 5 + fs / 4 + fs / 2 };
  };
  return (
    <Show when={geo()}>
      {(g) => (
        <g pointer-events="none">
          <path d={g().path} fill={props.color} />
          <text x={g().tx} y={g().ty} font-size={String(g().fs)} font-family={g().font} fill={textOnColor(props.color)} dominant-baseline="central" style={{ "white-space": "pre" }}>
            {g().text}
          </text>
        </g>
      )}
    </Show>
  );
}

/** Price-scale label of a drawing point: the scale's own label box (full
 *  scale width, text height + 2.5/12 of the font size above and under,
 *  corners radius 2) in `color`, the text where the scale's tick labels
 *  start. */
export function PriceAxisLabel(props: { x: number; w: number; y: number; text: string; color: string; fontSize: number; fontFamily: string }) {
  const h = () => Math.round(props.fontSize + (5 * props.fontSize) / 12);
  const top = () => Math.round(props.y - h() / 2) + 0.5;
  return (
    <g pointer-events="none">
      <rect x={props.x} y={top()} width={props.w} height={h()} rx={2} fill={props.color} />
      <text x={props.x + PRICE_LABEL_TEXT_X} y={top() + h() / 2} font-size={String(props.fontSize)} font-family={props.fontFamily} fill={textOnColor(props.color)} dominant-baseline="central" style={{ "white-space": "pre" }}>
        {props.text}
      </text>
    </g>
  );
}
const PRICE_LABEL_TEXT_X = 10;
