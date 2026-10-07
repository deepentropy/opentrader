/*
 * End-of-history marker.
 *
 * One 36 x 36 icon left of the first bar once scroll-back has nothing older
 * to load:
 *   "end"   — the symbol has no older data (its first bar); only with at
 *             least 400 bars loaded.
 *   "limit" — older data exists but the history floor of the data plan
 *             stops it.
 * Box bottom-right corner at (x(first bar) − round(1.5 · bar spacing) − 10,
 * pane height − 1). Colour cold-gray-200 on a dark chart, cold-gray-900 on a
 * light one, blue while hovered or while its dialog is open. Hit box = the
 * icon box. Hidden while history is loading.
 */
import type {
  ISeriesPrimitive,
  IPrimitivePaneView,
  IPrimitivePaneRenderer,
  PrimitiveHoveredItem,
  SeriesAttachedParameter,
  Time,
  SeriesType,
  IChartApi,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";

export const HISTORY_END_ID = "history-end-marker";

/** Fewest loaded bars for the "end" icon. */
export const HISTORY_END_MIN_BARS = 400;

const SIZE = 36;
const DARK_FG = "#DBDBDB";
const LIGHT_FG = "#0F0F0F";
const HOVER_FG = "#2962FF";

/** Stroked outlines (1.5 px, round joins/caps) in a 36 x 36 box. */
export const HISTORY_END_ICONS = {
  // Long-necked dinosaur facing left, standing on the box bottom.
  end:
    "M4 9C4 7 5.5 6 7.5 6C9.5 6 11 7 11.5 9C12.5 12 13 15 15 17C18 15.5 23 15.5 27 17.5C30 19 32.5 22 34 25" +
    "C31 24.5 29.5 24 28.5 24.5L28.5 31L25.5 31L25.5 26.5L18.5 26.5L18.5 31L15.5 31L15.5 25" +
    "C13.5 23.5 11.5 20 9.5 11L6 11C5 11 4 10.5 4 9ZM7.75 8.25h.01",
  // Road barrier: striped board on two posts.
  limit: "M5 13h26v7H5zM10 20l5-7M17 20l5-7M24 20l5-7M9 10v3M27 10v3M9 20v11M27 20v11M6 31h6M24 31h6",
} as const;

export type HistoryEndKind = keyof typeof HISTORY_END_ICONS;
export type HistoryEndState = { kind: HistoryEndKind | null; hovered: boolean; active: boolean; dark: boolean };

export class HistoryEndPrimitive implements ISeriesPrimitive<Time> {
  private _chart: IChartApi | null = null;
  private _requestUpdate: (() => void) | null = null;
  private _state: HistoryEndState = { kind: null, hovered: false, active: false, dark: true };
  private _paths = new Map<HistoryEndKind, Path2D>();
  private _views: IPrimitivePaneView[] = [new HistoryEndPaneView(this)];

  attached(p: SeriesAttachedParameter<Time, SeriesType>): void {
    this._chart = p.chart as IChartApi;
    this._requestUpdate = p.requestUpdate;
  }
  detached(): void {
    this._chart = null;
    this._requestUpdate = null;
  }

  setState(patch: Partial<HistoryEndState>): void {
    const next = { ...this._state, ...patch };
    const s = this._state;
    if (next.kind === s.kind && next.hovered === s.hovered && next.active === s.active && next.dark === s.dark) return;
    this._state = next;
    this._requestUpdate?.();
  }
  state(): HistoryEndState { return this._state; }

  /** Bottom-right corner of the icon box in pane (media) coordinates, or
   *  null when hidden. The first bar is logical index 0 of the series. */
  anchor(paneHeight: number): { x: number; y: number } | null {
    if (!this._state.kind || !this._chart) return null;
    const ts = this._chart.timeScale();
    const x0 = ts.logicalToCoordinate(0 as never);
    const x1 = ts.logicalToCoordinate(1 as never);
    if (x0 === null || x1 === null) return null;
    return { x: (x0 as number) - Math.round(1.5 * ((x1 as number) - (x0 as number))) - 10, y: paneHeight - 1 };
  }

  paneHeight(): number { return this._chart ? this._chart.paneSize(0).height : 0; }

  path(kind: HistoryEndKind): Path2D {
    let p = this._paths.get(kind);
    if (!p) this._paths.set(kind, (p = new Path2D(HISTORY_END_ICONS[kind])));
    return p;
  }

  updateAllViews(): void {}
  paneViews(): readonly IPrimitivePaneView[] { return this._views; }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    const a = this.anchor(this.paneHeight());
    if (!a) return null;
    if (x < a.x - SIZE || x > a.x || y < a.y - SIZE || y > a.y) return null;
    return { externalId: HISTORY_END_ID, zOrder: "top", cursorStyle: "pointer", hitTestPriority: 2 };
  }
}

class HistoryEndPaneView implements IPrimitivePaneView {
  constructor(private _source: HistoryEndPrimitive) {}
  zOrder(): "top" { return "top"; }
  renderer(): IPrimitivePaneRenderer | null { return new HistoryEndRenderer(this._source); }
}

class HistoryEndRenderer implements IPrimitivePaneRenderer {
  constructor(private _source: HistoryEndPrimitive) {}

  draw(target: CanvasRenderingTarget2D): void {
    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hpr, verticalPixelRatio: vpr, mediaSize }) => {
      const st = this._source.state();
      const a = this._source.anchor(mediaSize.height);
      if (!a || !st.kind) return;
      ctx.save();
      try {
        ctx.translate(Math.round((a.x - SIZE) * hpr), Math.round((a.y - SIZE) * vpr));
        ctx.scale(hpr, vpr);
        ctx.strokeStyle = st.hovered || st.active ? HOVER_FG : st.dark ? DARK_FG : LIGHT_FG;
        ctx.lineWidth = 1.5;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.stroke(this._source.path(st.kind));
      } finally {
        ctx.restore();
      }
    });
  }
}

/** True when a CSS colour (#rgb, #rrggbb[aa], rgb[a]()) is dark: relative
 *  luminance under 0.5. Unparsed colours count as dark. */
export function isDarkColor(c: string): boolean {
  let rgb: number[] | null = null;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(c.trim());
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((d) => d + d).join("") : hex[1];
    rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  } else {
    const m = /^rgba?\(([^)]+)\)$/i.exec(c.trim());
    if (m) rgb = m[1].split(/[\s,/]+/).slice(0, 3).map(Number);
  }
  if (!rgb || rgb.some((v) => !Number.isFinite(v))) return true;
  return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 < 0.5;
}
