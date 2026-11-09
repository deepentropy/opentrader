/*
 * Coords of the drawings overlay: the pixel <-> data bridge now lives in the
 * drawing library runtime (lightweight-charts-drawing/runtime/coords); created
 * once per series instance and published as a signal by ChartView. The
 * drawings' labels are drawn in the interface language (formatLabel).
 */
import { makeCoords as makeLibraryCoords } from "lightweight-charts-drawing/runtime/coords";
import type { Coords } from "lightweight-charts-drawing/core/coords";
import { drawingLabelFormatter } from "../../i18n/drawing-labels";

export { timeToXFallback } from "lightweight-charts-drawing/runtime/coords";
export type { Coords } from "lightweight-charts-drawing/core/coords";
export type { FutureAxis } from "lightweight-charts-drawing/runtime/coords";

export function makeCoords(...args: Parameters<typeof makeLibraryCoords>): Coords {
  const coords = makeLibraryCoords(...args);
  const formatLabel = drawingLabelFormatter();
  if (formatLabel) coords.formatLabel = formatLabel;
  return coords;
}
