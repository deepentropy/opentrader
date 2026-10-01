/*
 * "Lock vertical cursor line by time" (chart menu): the crosshair's vertical
 * line stays on one bar while the horizontal line follows the mouse; the
 * legend shows that bar. One lock for every chart of the window (the
 * reference keeps it in the global drawing state). Toggling the row again
 * unlocks.
 *
 * While locked, the library's vertical crosshair line is hidden and this
 * module draws it: the line in every pane, a padlock (18 x 18) at the bottom
 * of every pane centred on the line, and the time-axis label. All only while
 * the crosshair is shown (pointer over the chart).
 */
import { createSignal } from "solid-js";
import type {
  IChartApi,
  IPanePrimitive,
  IPanePrimitivePaneView,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  ISeriesPrimitiveAxisView,
  Time,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import { textOnColor } from "lightweight-charts-drawing/core/color";

/** Locked bar time (epoch seconds), null = not locked. */
export const [crosshairLockTime, setCrosshairLockTime] = createSignal<number | null>(null);

export type LockLineStyle = { color: string; width: number; dash: number[]; labelBg: string; dark: boolean };

/** Shared state of one chart's lock views. */
export class CrosshairLockViews {
  /** Crosshair shown on this chart (pointer over it). */
  shown = false;
  constructor(private chart: IChartApi, public style: () => LockLineStyle) {}

  /** X of the locked bar (nearest bar), or null. */
  x(): number | null {
    const t = crosshairLockTime();
    if (t === null) return null;
    const ts = this.chart.timeScale();
    const i = ts.timeToIndex(t as Time, true);
    if (i === null) return null;
    return ts.logicalToCoordinate(i as never);
  }

  label(): string {
    const t = crosshairLockTime();
    if (t === null) return "";
    const f = this.chart.options().localization?.timeFormatter as ((t: Time) => string) | undefined;
    return f ? f(t as Time) : String(t);
  }
}

/** The line + padlock in one pane. */
export class CrosshairLockPanePrimitive implements IPanePrimitive<Time> {
  private readonly views: IPanePrimitivePaneView[];
  constructor(private lock: CrosshairLockViews) {
    this.views = [{ renderer: () => this.renderer, zOrder: () => "top" }];
  }
  private readonly renderer: IPrimitivePaneRenderer = {
    draw: (target: CanvasRenderingTarget2D) => {
      if (!this.lock.shown) return;
      const x = this.lock.x();
      if (x === null) return;
      const st = this.lock.style();
      target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
        if (x < -9 || x > mediaSize.width + 9) return;
        ctx.save();
        ctx.strokeStyle = st.color;
        ctx.lineWidth = st.width;
        ctx.setLineDash(st.dash);
        const lx = Math.round(x) + (st.width % 2 ? 0.5 : 0);
        ctx.beginPath();
        ctx.moveTo(lx, 0);
        ctx.lineTo(lx, mediaSize.height);
        ctx.stroke();
        ctx.setLineDash([]);
        drawPadlock(ctx, x + 1 - 9, mediaSize.height - 18, st.dark);
        ctx.restore();
      });
    },
  };
  paneViews(): readonly IPanePrimitivePaneView[] {
    return this.views;
  }
}

/** The time-axis label (attached to the main series). */
export class CrosshairLockAxisPrimitive implements ISeriesPrimitive<Time> {
  private readonly axis: ISeriesPrimitiveAxisView;
  constructor(private lock: CrosshairLockViews) {
    this.axis = {
      coordinate: () => this.lock.x() ?? -1000,
      text: () => this.lock.label(),
      textColor: () => textOnColor(this.lock.style().labelBg),
      backColor: () => this.lock.style().labelBg,
      visible: () => this.lock.shown && this.lock.x() !== null,
    };
  }
  timeAxisViews(): readonly ISeriesPrimitiveAxisView[] {
    return [this.axis];
  }
  paneViews(): readonly IPrimitivePaneView[] {
    return [];
  }
}

/** Padlock icon 18 x 18 at (x, y): body 12 x 9 with 2 px corners, shackle
 *  radius 3, keyhole; filled with the pane colour, outlined in grey. */
function drawPadlock(ctx: CanvasRenderingContext2D, x: number, y: number, dark: boolean) {
  const fill = dark ? "#0f0f0f" : "#ffffff"; // cold-gray-900 / white
  const line = dark ? "#8c8c8c" : "#707070"; // cold-gray-450 / cold-gray-550
  ctx.save();
  ctx.translate(x, y);
  ctx.lineWidth = 1;
  ctx.strokeStyle = line;
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(9, 6.5, 3, Math.PI, 0);
  ctx.lineTo(12, 7.5);
  ctx.moveTo(6, 7.5);
  ctx.lineTo(6, 6.5);
  ctx.stroke();
  ctx.beginPath();
  ctx.roundRect(3.5, 7.5, 11, 8, 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(9, 10.5);
  ctx.lineTo(9, 12.5);
  ctx.lineCap = "round";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}
