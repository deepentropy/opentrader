/*
 * The app's side of the Community chart sharing (data/community/chart-share.ts):
 * the active chart's picture (the chart alone: panes, axes and legend, without
 * the app around it), state and drawings; and "Open on my chart", which shows a shared
 * chart's symbol and interval and adds its drawings to it.
 */
import type { Drawing, NewDrawing } from "lightweight-charts-drawing/core/types";
import { parseDrawings } from "lightweight-charts-drawing/core/serialize";
import { exportableCharts } from "../../chart/chart-export";
import { chartSnapshot } from "../../chart/layout-snapshot";
import { isSupportedResolution, toFullSymbol } from "../../../data/datafeed";
import type { AppTabs } from "../../shell/app-tabs";
import type { DrawingStore } from "../../drawings/drawing-store";
import type { ChartBridge } from "../../../data/community/chart-share";

export type ChartBridgeHost = {
  tabs: Pick<AppTabs, "activeTab" | "activePaneState">;
  drawings: Pick<DrawingStore, "drawingKeyFor" | "drawingsFor" | "addDrawingToSymbol">;
  setSymbol: (symbol: string) => void;
  setInterval: (interval: string) => void;
};

/** Pictures wider than this are scaled down (the post shows them at most this wide). */
const MAX_WIDTH = 1600;

/** Drawings that point to files of this computer don't travel. */
const LOCAL_ONLY = new Set(["image"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function picture(): Promise<Blob | null> {
  const charts = exportableCharts();
  const source = (charts.find((c) => c.source.active()) ?? charts[0])?.source;
  const host = source?.host();
  if (!host) return null;
  let canvas = await chartSnapshot(host);
  if (!canvas) return null;
  if (canvas.width > MAX_WIDTH) {
    const scaled = document.createElement("canvas");
    scaled.width = MAX_WIDTH;
    scaled.height = Math.round((canvas.height * MAX_WIDTH) / canvas.width);
    scaled.getContext("2d")!.drawImage(canvas, 0, 0, scaled.width, scaled.height);
    canvas = scaled;
  }
  // WebP is a fraction of the PNG's size; a browser without it gives PNG.
  return (await toBlob(canvas, "image/webp", 0.88)) ?? (await toBlob(canvas, "image/png"));
}

/** Same kind at the same points: already on the chart (a second "Open"). */
const sameDrawing = (a: Drawing, b: Drawing) => a.kind === b.kind && JSON.stringify(a.points) === JSON.stringify(b.points);

export function createChartBridge(host: ChartBridgeHost): ChartBridge {
  const activeKey = () => host.drawings.drawingKeyFor(host.tabs.activePaneState(), host.tabs.activeTab().id);
  return {
    capture: async () => {
      const image = await picture();
      if (!image) return null;
      const pane = host.tabs.activePaneState();
      const drawings = host.drawings.drawingsFor(activeKey()).filter((d) => !LOCAL_ONLY.has(d.kind));
      return { chart: { symbol: pane.symbol, interval: pane.interval, drawings }, image };
    },
    open: async (chart) => {
      host.setSymbol(chart.symbol);
      if (isSupportedResolution(chart.interval)) host.setInterval(chart.interval);
      // The pane takes the new symbol on its next frame.
      await sleep(50);
      const key = activeKey();
      const existing = host.drawings.drawingsFor(key);
      let added = 0;
      for (const d of parseDrawings(chart.drawings)) {
        if (LOCAL_ONLY.has(d.kind) || existing.some((e) => sameDrawing(e, d))) continue;
        const { id: _id, ...rest } = d;
        host.drawings.addDrawingToSymbol(key, rest as unknown as NewDrawing);
        added++;
      }
      return added;
    },
    showSymbol: async (ticker) => {
      host.setSymbol(await toFullSymbol(ticker));
    },
  };
}
