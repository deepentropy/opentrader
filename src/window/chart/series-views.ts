/*
 * Custom-series renderers for styles the library cannot draw natively:
 *
 *   • GradientLinePaneView — Line / Line with markers / Step line with the
 *     "Gradient" colour type: one vertical linear gradient over the pane
 *     height, start colour at the top and end colour at the bottom. Markers
 *     (with-markers style) are filled circles of radius lineWidth + 2, drawn
 *     only while 2 · radius < bar spacing.
 *   • ColumnPaneView — Columns: a column per bar from the value down to the
 *     BOTTOM of the pane (histogram base = pane height), so
 *     the price scale fits the values only (the library histogram would pull
 *     the scale down to its base price).
 */
import type {
  CustomSeriesPricePlotValues,
  ICustomSeriesPaneRenderer,
  ICustomSeriesPaneView,
  PaneRendererCustomData,
  PriceToCoordinateConverter,
  Time,
} from "lightweight-charts";
import { customSeriesDefaultOptions, type CustomSeriesOptions } from "lightweight-charts";
import { dashFor } from "./custom-series";

type DrawTarget = Parameters<ICustomSeriesPaneRenderer["draw"]>[0];
type MediaScope = { context: CanvasRenderingContext2D; mediaSize: { width: number; height: number } };
function withMedia(target: DrawTarget, fn: (scope: MediaScope) => void): void {
  (target as unknown as { useMediaCoordinateSpace: (h: (s: MediaScope) => void) => void }).useMediaCoordinateSpace(fn);
}

export type ValueItem = { time: Time; value: number };

export type GradientLineStyle = {
  start: string;
  end: string;
  width: number;
  style: number;
  step: boolean;
  markers: boolean;
};

export class GradientLinePaneView implements ICustomSeriesPaneView<Time, ValueItem, CustomSeriesOptions> {
  private data: PaneRendererCustomData<Time, ValueItem> | null = null;
  constructor(private st: GradientLineStyle) {}
  priceValueBuilder(item: ValueItem): CustomSeriesPricePlotValues {
    return [item.value];
  }
  isWhitespace(d: ValueItem | { time: Time }): d is { time: Time } {
    return !("value" in d);
  }
  renderer(): ICustomSeriesPaneRenderer {
    return {
      draw: (target: DrawTarget, ptc: PriceToCoordinateConverter) => {
        const data = this.data;
        if (!data || !data.bars.length) return;
        const st = this.st;
        withMedia(target, ({ context: ctx, mediaSize }) => {
          const g = ctx.createLinearGradient(0, 0, 0, mediaSize.height);
          g.addColorStop(0, st.start);
          g.addColorStop(1, st.end);
          const pts: { x: number; y: number }[] = [];
          const from = data.visibleRange ? Math.max(0, data.visibleRange.from - 1) : 0;
          const to = data.visibleRange ? Math.min(data.bars.length, data.visibleRange.to + 1) : data.bars.length;
          for (let i = from; i < to; i++) {
            const b = data.bars[i];
            const y = ptc(b.originalData.value);
            if (y != null) pts.push({ x: b.x, y });
          }
          if (!pts.length) return;
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) {
            if (st.step) ctx.lineTo(pts[i].x, pts[i - 1].y);
            ctx.lineTo(pts[i].x, pts[i].y);
          }
          ctx.strokeStyle = g;
          ctx.lineWidth = st.width;
          ctx.lineJoin = "round";
          ctx.setLineDash(dashFor(st.style, st.width));
          ctx.stroke();
          ctx.setLineDash([]);
          const r = st.width + 2;
          if (st.markers && 2 * r < data.barSpacing) {
            ctx.fillStyle = g;
            ctx.beginPath();
            for (const p of pts) {
              ctx.moveTo(p.x + r, p.y);
              ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
            }
            ctx.fill();
          }
        });
      },
      update: (data: PaneRendererCustomData<Time, ValueItem>) => {
        this.data = data;
      },
    } as ICustomSeriesPaneRenderer & { update: (d: PaneRendererCustomData<Time, ValueItem>) => void };
  }
  update(data: PaneRendererCustomData<Time, ValueItem>): void {
    this.data = data;
  }
  defaultOptions(): CustomSeriesOptions {
    return customSeriesDefaultOptions;
  }
}

/** `fill`, not `color`: the library reserves `color` on custom data. */
export type ColumnItem = { time: Time; value: number; fill: string };

export class ColumnPaneView implements ICustomSeriesPaneView<Time, ColumnItem, CustomSeriesOptions> {
  private data: PaneRendererCustomData<Time, ColumnItem> | null = null;
  priceValueBuilder(item: ColumnItem): CustomSeriesPricePlotValues {
    return [item.value];
  }
  isWhitespace(d: ColumnItem | { time: Time }): d is { time: Time } {
    return !("value" in d);
  }
  renderer(): ICustomSeriesPaneRenderer {
    return {
      draw: (target: DrawTarget, ptc: PriceToCoordinateConverter) => {
        const data = this.data;
        if (!data || !data.bars.length) return;
        withMedia(target, ({ context: ctx, mediaSize }) => {
          // Library histogram geometry: the bar slot minus a 1 px gap once the
          // spacing allows it.
          const w = Math.max(1, data.barSpacing >= 3 ? data.barSpacing - 1 : data.barSpacing);
          for (const bar of data.bars) {
            const y = ptc(bar.originalData.value);
            if (y == null) continue;
            ctx.fillStyle = bar.originalData.fill;
            const left = Math.round(bar.x - w / 2);
            ctx.fillRect(left, Math.round(y), Math.max(1, Math.round(w)), mediaSize.height - Math.round(y));
          }
        });
      },
      update: (data: PaneRendererCustomData<Time, ColumnItem>) => {
        this.data = data;
      },
    } as ICustomSeriesPaneRenderer & { update: (d: PaneRendererCustomData<Time, ColumnItem>) => void };
  }
  update(data: PaneRendererCustomData<Time, ColumnItem>): void {
    this.data = data;
  }
  defaultOptions(): CustomSeriesOptions {
    return customSeriesDefaultOptions;
  }
}
