/*
 * Session-backgrounds primitive — TV's pre-market / post-market pane tint on
 * intraday charts that show extended hours (Sessions study, "sessionHighlight
 * .backgrounds"; available only when the chart session is not regular). Read
 * off the desktop 23/09/2026: preMarket #FF9800 and postMarket #2962FF at
 * transparency 92, each run of extended bars tinted edge to edge (half a bar
 * either side of the first/last bar), full pane height, under the grid.
 *
 * Bars are classed by their start in exchange time (America/New_York):
 * 04:00–09:30 pre, 16:00–20:00 post. The plan has no overnight data, so TV's
 * night-market tint has nothing to cover.
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
import { minuteOfDayer } from './day-key';

export type SessionRun = { from: number; to: number; kind: 'pre' | 'post' };

// Defaults; Symbol → "Pre/post market hours background" overrides them.
const PRE_COLOR = 'rgba(255, 152, 0, 0.08)';
const POST_COLOR = 'rgba(41, 98, 255, 0.08)';

// One instance for the app: its per-slot zone-offset cache is reused by every
// recompute instead of being rebuilt per call.
const etMinute = minuteOfDayer('America/New_York');

/** Runs of consecutive pre- or post-market bars (bar start times, UNIX s). */
export function computeSessionRuns(bars: ReadonlyArray<{ time: number }>): SessionRun[] {
  const out: SessionRun[] = [];
  let cur: SessionRun | null = null;
  for (const b of bars) {
    const m = etMinute(b.time);
    const kind = m >= 240 && m < 570 ? 'pre' : m >= 960 && m < 1200 ? 'post' : null;
    if (kind && cur && cur.kind === kind) {
      cur.to = b.time;
    } else {
      cur = kind ? { from: b.time, to: b.time, kind } : null;
      if (cur) out.push(cur);
    }
  }
  return out;
}

export class SessionBackgroundsPrimitive implements ISeriesPrimitive<Time> {
  private _chart: IChartApi | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _runs: SessionRun[] = [];
  private _colors = { pre: PRE_COLOR, post: POST_COLOR };
  private _views: IPrimitivePaneView[] = [new SessionBackgroundsPaneView(this)];

  attached(p: SeriesAttachedParameter<Time, SeriesType>): void {
    this._chart = p.chart as IChartApi;
    this._requestUpdate = p.requestUpdate;
  }
  detached(): void {
    this._chart = null;
    this._requestUpdate = null;
  }

  /** Replace the tinted runs (empty = nothing drawn); triggers a repaint. */
  setRuns(runs: SessionRun[]): void {
    if (runs.length === 0 && this._runs.length === 0) return;
    this._runs = runs;
    this._requestUpdate?.();
  }

  /** Pre / post fill colours (Symbol tab row); triggers a repaint on change. */
  setColors(pre: string, post: string): void {
    if (pre === this._colors.pre && post === this._colors.post) return;
    this._colors = { pre, post };
    this._requestUpdate?.();
  }

  getRuns() { return this._runs; }
  getColors() { return this._colors; }
  getChart() { return this._chart; }

  updateAllViews(): void {}
  paneViews(): readonly IPrimitivePaneView[] { return this._views; }
}

class SessionBackgroundsPaneView implements IPrimitivePaneView {
  constructor(private _source: SessionBackgroundsPrimitive) {}
  // Under the grid and the candles, like TV's session highlight.
  zOrder(): 'bottom' { return 'bottom'; }
  renderer(): IPrimitivePaneRenderer | null { return new SessionBackgroundsRenderer(this._source); }
}

class SessionBackgroundsRenderer implements IPrimitivePaneRenderer {
  constructor(private _source: SessionBackgroundsPrimitive) {}

  draw(target: CanvasRenderingTarget2D): void {
    const chart = this._source.getChart();
    const runs = this._source.getRuns();
    const colors = this._source.getColors();
    if (!chart || runs.length === 0) return;
    const timeScale = chart.timeScale();
    // Live spacing (options().barSpacing is not updated by user zoom).
    const c0 = timeScale.logicalToCoordinate(0 as never);
    const c1 = timeScale.logicalToCoordinate(1 as never);
    if (c0 == null || c1 == null) return;
    const half = ((c1 as number) - (c0 as number)) / 2;

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      for (const r of runs) {
        const a = timeScale.timeToCoordinate(r.from as unknown as Time);
        const b = timeScale.timeToCoordinate(r.to as unknown as Time);
        if (a == null || b == null) continue;
        const x0 = (a as number) - half;
        const x1 = (b as number) + half;
        if (x1 < 0 || x0 > mediaSize.width) continue;
        ctx.fillStyle = r.kind === 'pre' ? colors.pre : colors.post;
        ctx.fillRect(x0, 0, x1 - x0, mediaSize.height);
      }
    });
  }
}
