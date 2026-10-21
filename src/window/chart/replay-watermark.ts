/*
 * Chart watermark drawn as the reference app does when the chart is in Bar
 * Replay: the symbol lines (Symbol / Interval / Description settings) and a
 * "Replay" line with the replay icon, centred in the price pane.
 *
 * Sizes (the reference app symbol watermark): the first line 80 px (icon 56,
 * gap 16), the others 36 px on 44 (icon 28, gap 12); on a pane narrower than
 * 768 px 48 px (icon 44, gap 12) and 28 px on 36 (icon 28, gap 8). Lines are
 * 4 px apart, each scaled down to fit the width.
 */
import type { IPanePrimitive, IPrimitivePaneRenderer, IPrimitivePaneView, PaneAttachedParameter, Time } from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";

/** The replay icon (56 x 56 path). */
const ICON = "M28 54C42.3594 54 54 42.3594 54 28C54 13.6406 42.3594 2 28 2C13.6406 2 2 13.6406 2 28C2 42.3594 13.6406 54 28 54ZM26 16V28V40L14 28L26 16ZM26 28L38 40V16L26 28Z";

export type WatermarkLine = { text: string; icon?: boolean };

/** Font size, line height, vertical offset (reference table `ia`). */
const FONTS: Record<string, [number, number, number]> = {
  wideFirst: [80, 80, 6],
  wideOther: [36, 44, 8],
  narrowFirst: [48, 48, 4],
  narrowOther: [28, 36, 6],
};
/** Icon size and gap after it. */
const ICONS: Record<string, [number, number]> = {
  wideFirst: [56, 16],
  wideOther: [28, 12],
  narrowFirst: [44, 12],
  narrowOther: [28, 8],
};
const NARROW = 768;

class Renderer implements IPrimitivePaneRenderer {
  constructor(private readonly src: ReplayWatermarkPrimitive) {}
  draw(target: CanvasRenderingTarget2D) {
    const { lines, color, font } = this.src.state;
    if (lines.length === 0) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize: { width, height } }) => {
      const kind = (first: boolean) => `${width < NARROW ? "narrow" : "wide"}${first ? "First" : "Other"}`;
      const iconPath = new Path2D(ICON);
      const scales: number[] = [];
      let total = 0;
      lines.forEach((l, i) => {
        const [size, lh] = FONTS[kind(i === 0)];
        const [iw, gap] = l.icon ? ICONS[kind(i === 0)] : [0, 0];
        ctx.font = `${size}px ${font}`;
        const w = ctx.measureText(l.text).width + iw + gap + 16;
        const s = w > width ? width / w : 1;
        scales.push(s);
        total += lh * s + 4;
      });
      let y = Math.max((height - total) / 2, 0);
      ctx.fillStyle = color;
      lines.forEach((l, i) => {
        const [size, lh, off] = FONTS[kind(i === 0)];
        const [iw, gap] = l.icon ? ICONS[kind(i === 0)] : [0, 0];
        const s = scales[i];
        ctx.save();
        ctx.font = `${size}px ${font}`;
        ctx.textBaseline = "top";
        ctx.textAlign = "left";
        const w = ctx.measureText(l.text).width + iw + gap;
        ctx.translate((width - s * w) / 2, y);
        ctx.scale(s, s);
        if (l.icon) {
          ctx.save();
          ctx.translate(0, (lh - iw) / 2);
          ctx.scale(iw / 56, iw / 56);
          ctx.fill(iconPath, "evenodd");
          ctx.restore();
        }
        ctx.fillText(l.text, iw + gap, off);
        ctx.restore();
        y += lh * s + 4;
      });
    });
  }
}

class View implements IPrimitivePaneView {
  private readonly r: Renderer;
  constructor(src: ReplayWatermarkPrimitive) {
    this.r = new Renderer(src);
  }
  zOrder() {
    return "bottom" as const;
  }
  renderer() {
    return this.r;
  }
}

export class ReplayWatermarkPrimitive implements IPanePrimitive<Time> {
  state: { lines: WatermarkLine[]; color: string; font: string } = { lines: [], color: "transparent", font: "sans-serif" };
  private readonly views: View[];
  private requestUpdate: (() => void) | null = null;
  constructor() {
    this.views = [new View(this)];
  }
  attached(p: PaneAttachedParameter<Time>) {
    this.requestUpdate = p.requestUpdate;
  }
  detached() {
    this.requestUpdate = null;
  }
  paneViews() {
    return this.views;
  }
  set(lines: WatermarkLine[], color: string, font: string) {
    this.state = { lines, color, font };
    this.requestUpdate?.();
  }
}
