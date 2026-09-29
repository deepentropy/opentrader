/*
 * Coords of the drawings overlay: the pixel <-> data bridge now lives in the
 * drawing library runtime (lightweight-charts-drawing/runtime/coords); created
 * once per series instance and published as a signal by ChartView.
 */
export { makeCoords, timeToXFallback } from "lightweight-charts-drawing/runtime/coords";
export type { Coords } from "lightweight-charts-drawing/tv/coords";
