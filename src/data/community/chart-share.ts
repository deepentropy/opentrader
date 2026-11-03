/*
 * The Community panel and the charts (#206): the app registers how to picture
 * the active chart and how to open a shared one on it. The website has no
 * charts and registers nothing: no "Attach my chart", no "Open on my chart".
 */
import type { SharedChart } from "./api";

export type ChartCapture = { chart: SharedChart; image: Blob };

export type ChartBridge = {
  /** The active chart: its state and its picture; null when no chart is shown. */
  capture: () => Promise<ChartCapture | null>;
  /** Shows the shared chart's symbol and interval on the active chart and adds its drawings; how many were added. */
  open: (chart: SharedChart) => Promise<number>;
  /** Shows a ticker (a `$AAPL` mention) on the active chart. */
  showSymbol: (ticker: string) => Promise<void>;
};

let bridge: ChartBridge | null = null;

export function setChartBridge(b: ChartBridge | null): void {
  bridge = b;
}

export function chartBridge(): ChartBridge | null {
  return bridge;
}

/** A picture as base64, for the upload. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
