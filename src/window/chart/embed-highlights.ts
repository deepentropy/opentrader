/*
 * Shaded periods a page puts on an embedded chart (#366): each a band over its
 * bars (half a bar either side of the first and last one), full pane height,
 * under the grid and the bars. Its label sits in a chip at the band's bottom
 * left, over the bars: the legend covers the top of the pane, the event marks
 * its last rows.
 *
 * A colour without its own transparency is drawn at 15 %, so the bars and the
 * grid stay readable on any colour the page picks.
 */
import type {
  IChartApi,
  ISeriesPrimitive,
  IPrimitivePaneView,
  IPrimitivePaneRenderer,
  SeriesAttachedParameter,
  Time,
  SeriesType,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';

/** A band between two bar times (UNIX s, as the series has them). */
export type HighlightBand = { from: number; to: number; color?: string; label?: string };

const DEFAULT_COLOR = 'rgba(41, 98, 255, 0.12)';
const OPAQUE_ALPHA = 0.15;

/** Whether a CSS colour carries its own transparency (rgba / hsla / #rgba / #rrggbbaa / "transparent"). */
export function hasAlpha(color: string): boolean {
  const c = color.trim().toLowerCase();
  return /^(rgba|hsla)\(/.test(c) || /\/\s*[\d.]+%?\s*\)$/.test(c) || /^#([0-9a-f]{4}|[0-9a-f]{8})$/.test(c) || c === 'transparent';
}

export class EmbedHighlightsPrimitive implements ISeriesPrimitive<Time> {
  private _chart: IChartApi | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _bands: HighlightBand[] = [];
  private _text = { color: '#131722', background: '#ffffff', font: '12px sans-serif' };
  private _views: IPrimitivePaneView[] = [new BandsPaneView(this), new LabelsPaneView(this)];

  attached(p: SeriesAttachedParameter<Time, SeriesType>): void {
    this._chart = p.chart as IChartApi;
    this._requestUpdate = p.requestUpdate;
  }
  detached(): void {
    this._chart = null;
    this._requestUpdate = null;
  }

  /** Replace the bands (empty = nothing drawn) and the labels' colours and font; repaints. */
  setBands(bands: HighlightBand[], textColor: string, background: string, fontFamily: string): void {
    if (bands.length === 0 && this._bands.length === 0) return;
    this._bands = bands;
    this._text = { color: textColor, background, font: `12px ${fontFamily}` };
    this._requestUpdate?.();
  }

  getText() { return this._text; }

  /** Each band's x span in the pane (media px), the ones off screen left out. */
  spans(width: number): { band: HighlightBand; x0: number; x1: number }[] {
    const chart = this._chart;
    if (!chart || this._bands.length === 0) return [];
    const timeScale = chart.timeScale();
    // Live spacing (options().barSpacing is not updated by user zoom).
    const c0 = timeScale.logicalToCoordinate(0 as never);
    const c1 = timeScale.logicalToCoordinate(1 as never);
    if (c0 == null || c1 == null) return [];
    const half = ((c1 as number) - (c0 as number)) / 2;
    const out: { band: HighlightBand; x0: number; x1: number }[] = [];
    for (const band of this._bands) {
      const a = timeScale.timeToCoordinate(band.from as unknown as Time);
      const z = timeScale.timeToCoordinate(band.to as unknown as Time);
      if (a == null || z == null) continue;
      const x0 = (a as number) - half;
      const x1 = (z as number) + half;
      if (x1 >= 0 && x0 <= width) out.push({ band, x0, x1 });
    }
    return out;
  }

  updateAllViews(): void {}
  paneViews(): readonly IPrimitivePaneView[] { return this._views; }
}

class BandsPaneView implements IPrimitivePaneView {
  constructor(private _source: EmbedHighlightsPrimitive) {}
  zOrder(): 'bottom' { return 'bottom'; }
  renderer(): IPrimitivePaneRenderer | null { return new BandsRenderer(this._source); }
}

class BandsRenderer implements IPrimitivePaneRenderer {
  constructor(private _source: EmbedHighlightsPrimitive) {}

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      for (const { band, x0, x1 } of this._source.spans(mediaSize.width)) {
        const color = band.color ?? DEFAULT_COLOR;
        ctx.save();
        ctx.globalAlpha = hasAlpha(color) ? 1 : OPAQUE_ALPHA;
        ctx.fillStyle = color;
        ctx.fillRect(x0, 0, x1 - x0, mediaSize.height);
        ctx.restore();
      }
    });
  }
}

class LabelsPaneView implements IPrimitivePaneView {
  constructor(private _source: EmbedHighlightsPrimitive) {}
  zOrder(): 'top' { return 'top'; }
  renderer(): IPrimitivePaneRenderer | null { return new LabelsRenderer(this._source); }
}

/** Height of a label chip and its distance from the pane's bottom (clear of the event marks). */
const CHIP_H = 18;
const CHIP_BOTTOM = 34;

class LabelsRenderer implements IPrimitivePaneRenderer {
  constructor(private _source: EmbedHighlightsPrimitive) {}

  draw(target: CanvasRenderingTarget2D): void {
    const text = this._source.getText();
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const y = mediaSize.height - CHIP_BOTTOM - CHIP_H;
      if (y < 0) return;
      for (const { band, x0, x1 } of this._source.spans(mediaSize.width)) {
        if (!band.label) continue;
        // Inside the band and the pane, cut at the band's right edge.
        const left = Math.max(x0, 0) + 4;
        const right = Math.min(x1, mediaSize.width) - 4;
        if (right - left < 12) continue;
        ctx.save();
        ctx.font = text.font;
        const w = Math.min(ctx.measureText(band.label).width + 12, right - left);
        ctx.beginPath();
        ctx.rect(left, y, w, CHIP_H);
        ctx.clip();
        // The chart's background, tinted with the band's colour twice as strong as the band.
        ctx.fillStyle = text.background;
        ctx.fillRect(left, y, w, CHIP_H);
        const color = band.color ?? DEFAULT_COLOR;
        ctx.globalAlpha = hasAlpha(color) ? 1 : OPAQUE_ALPHA * 2;
        ctx.fillStyle = color;
        ctx.fillRect(left, y, w, CHIP_H);
        ctx.globalAlpha = 1;
        ctx.fillStyle = text.color;
        ctx.textBaseline = 'middle';
        ctx.fillText(band.label, left + 6, y + CHIP_H / 2);
        ctx.restore();
      }
    });
  }
}
