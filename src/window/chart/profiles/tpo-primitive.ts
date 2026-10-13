/*
 * Draws the time price opportunity studies (tpo.ts) on the price pane, as
 * the reference TPO view does:
 *
 * - Profile box from the left edge of its first bar to the right edge of its
 *   last; the initial balance bar (3 px, rounded) at the left, blocks from
 *   there over 68 % of the box with the volume profile on (else 90 %), the
 *   volume histogram over 20 % from 70 %.
 * - Square cells: column width = min(row height, blocks width / most blocks
 *   in a row), 1 px apart (outlined in the chart background); cell colour =
 *   gradient of the 4 colours, 13 blocks per step; POC row in the POC
 *   colour; rows outside the value area at the "Opacity outside VA"
 *   transparency. Letters (bold, 0.6 x cell) from 7 px when "Letters" is on,
 *   white on blocks, in the block colour on the background without blocks.
 *   "Expand blocks": each block at its own column (time order).
 * - VAH / VAL dashed lines with their label left of the blocks (10 px,
 *   triangle), POC label, Mid / Open / Close labels, poor high / low dashed
 *   lines, single print bands, the extended POC band (POC colour at 0.15).
 * - Volume histogram bars (inside / outside the value area colours), its
 *   POC / VAH / VAL lines from the histogram to the box's right edge.
 */
import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type { TpoDraw, TpoProfile } from "./tpo-engine";

type RGB = [number, number, number, number];

function parse(color: string): RGB {
  const c = color.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(c);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split("").map((x) => x + x).join("") : hex[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
  }
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/i.exec(c);
  return m ? [+m[1], +m[2], +m[3], m[4] !== undefined ? +m[4] : 1] : [0, 0, 0, 1];
}
const css = (c: RGB) => `rgba(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}, ${c[3]})`;
const withAlpha = (color: string, a: number) => { const c = parse(color); return css([c[0], c[1], c[2], a]); };

/** Block colour of block `e`: 13 blocks per step between the 4 colours, repeating every 52. */
function blockColor(colors: string[], e: number): string {
  const k = e % 52;
  const sector = Math.floor(k / 13);
  const t = (k % 13) / 13;
  const a = parse(colors[sector % colors.length]);
  const b = parse(colors[(sector + 1) % colors.length]);
  return css([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t]);
}

/** Letter of block `e`: A-Z, then a-z, repeating. */
const letterOf = (e: number) => String.fromCharCode((Math.floor(e / 26) % 2 === 0 ? 65 : 97) + (e % 26));

/** Light colour (the reference black / white split at grey 150). */
const isLight = (color: string) => { const [r, g, b] = parse(color); return 0.199 * r + 0.687 * g + 0.114 * b >= 150; };

export class TpoPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private readonly views: IPrimitivePaneView[];

  /** `times`: chart bar times by index; `dark`: chart theme (label colours). */
  constructor(private readonly draw: TpoDraw, private readonly times: number[], private readonly dark: boolean) {
    const renderer: IPrimitivePaneRenderer = { draw: (target) => this.paint(target) };
    this.views = [{ zOrder: () => "normal", renderer: () => renderer }];
  }

  attached(param: SeriesAttachedParameter<Time, SeriesType>): void {
    this.chart = param.chart as IChartApi;
    this.series = param.series as ISeriesApi<SeriesType, Time>;
    param.requestUpdate();
  }

  detached(): void {
    this.chart = null;
    this.series = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  private barX(i: number): number | null {
    const t = this.times[i];
    if (t === undefined || !this.chart) return null;
    return this.chart.timeScale().timeToCoordinate(t as unknown as Time);
  }

  /** Half the bar spacing. */
  private halfBar(): number {
    const ts = this.chart!.timeScale();
    const a = ts.logicalToCoordinate(0 as never);
    const b = ts.logicalToCoordinate(1 as never);
    return a != null && b != null ? Math.abs(b - a) / 2 : 3;
  }

  private background(): string {
    const bg = this.chart?.options().layout.background as { type?: string; color?: string; topColor?: string; bottomColor?: string } | undefined;
    if (!bg) return this.dark ? "#0F0F0F" : "#FFFFFF";
    return bg.color ?? bg.bottomColor ?? bg.topColor ?? (this.dark ? "#0F0F0F" : "#FFFFFF");
  }

  private paint(target: CanvasRenderingTarget2D): void {
    const { chart, series } = this;
    if (!chart || !series) return;
    const half = this.halfBar();
    const st = this.draw.style;
    const bg = this.background();
    const font = chart.options().layout.fontFamily;
    const profiles = this.draw.profiles;
    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr, mediaSize }) => {
      profiles.forEach((p, idx) => {
        const xa = this.barX(p.i0);
        const xb = this.barX(p.i1);
        if (xa == null || xb == null) return;
        const left = xa - half;
        const right = xb + half;
        const extended = Object.values(p.extend).some((v) => v !== null && v !== undefined) || p.singleExtend.some((v) => v !== null);
        if (!extended && (right < 0 || left > mediaSize.width)) return;
        const expand = st.expand && (st.expandMode === "All" || idx === profiles.length - 1);
        this.paintProfile(ctx, p, left, right, expand, hr, vr, mediaSize.width, bg, font);
      });
    });
  }

  private paintProfile(ctx: CanvasRenderingContext2D, p: TpoProfile, A: number, H: number, expand: boolean, hr: number, vr: number, paneW: number, bg: string, font: string): void {
    const series = this.series!;
    const st = this.draw.style;
    const y = (price: number) => series.priceToCoordinate(price);
    const ibW = st.initialBalance && p.ib ? 3 : 0;
    const V = A + ibW;
    const E = H - V;
    const volumeOn = st.volume.visible && !expand;
    const blocksW = volumeOn ? (68 * E) / 100 : expand ? E : E - (10 * E) / 100;
    const most = expand ? Math.max(...p.rows.map((r) => Math.max(...r.blocks) + 1)) : Math.max(...p.rows.map((r) => r.blocks.length));
    const rowTop = (r: number) => y((r + 1) * p.rowSize);
    const rowBot = (r: number) => y(r * p.rowSize);
    const ext = p.rows.reduce((m, r) => (Math.abs(r.row) > Math.abs(m) ? r.row : m), p.rows[0].row);
    const rt = rowTop(ext);
    const rb = rowBot(ext);
    if (rt == null || rb == null) return;
    const rowH = Math.abs(rb - rt);
    const colW = expand ? blocksW / most : Math.min(rowH, blocksW / most);
    const cellsOk = rowH >= 2 && colW >= 2;
    const px = (v: number) => Math.round(v * hr);
    const py = (v: number) => Math.round(v * vr);
    const margin = Math.max(1, Math.floor(hr));
    // Initial balance bar.
    if (ibW && p.ib) {
      const t = rowTop(p.ib[1]);
      const b = rowBot(p.ib[0]);
      if (t != null && b != null) {
        ctx.fillStyle = this.dark ? "#DBDBDB" : "#0F0F0F";
        ctx.beginPath();
        const x0 = px(A);
        const w = px(A + ibW) - 1 - x0 + 1;
        const y0 = py(Math.min(t, b)) + margin;
        const h = py(Math.max(t, b)) - margin - y0;
        ctx.roundRect?.(x0, y0, w, Math.max(1, h), hr);
        ctx.fill();
      }
    }
    const pocColor = st.poc.color;
    const pocLetter = isLight(pocColor) ? "#0F0F0F" : "#FFFFFF";
    const fontSize = +(0.6 * Math.min(rowH, colW)).toFixed(1);
    const letters = fontSize >= 7 && st.showLetters;
    const blocks = fontSize < 7 || st.showBlocks;
    // Extended POC band (from the column after its last block).
    const lastPocCol = (() => {
      const r = p.rows.find((x) => x.row === p.poc);
      if (!r) return 0;
      return expand ? Math.max(...r.blocks) : r.blocks.length - 1;
    })();
    const colX = (c: number) => ({ start: px(V) + Math.round(c * colW * hr) + margin / 2, end: px(V) + Math.round((c + 1) * colW * hr) - margin / 2 - 1 });
    const endX = (end: number | null | undefined, fallback: number): number => {
      if (end === undefined || end === null) return fallback;
      if (end === -1) return paneW;
      const x = this.barX(end);
      return x == null ? fallback : x - this.halfBar();
    };
    const bands: { row: number; from: number; to: number; color: string }[] = [];
    if (st.poc.visible && p.extend.poc !== null && p.extend.poc !== undefined && cellsOk) {
      bands.push({ row: p.poc, from: colX(lastPocCol + 1).start, to: px(endX(p.extend.poc, H)), color: withAlpha(pocColor, 0.15) });
    }
    if (st.singlePrints.visible) {
      p.singlePrints.forEach((r, k) => bands.push({ row: r, from: colX(0).start, to: px(endX(p.singleExtend[k], H)), color: st.singlePrints.color }));
    }
    for (const b of bands) {
      const t = rowTop(b.row);
      const bt = rowBot(b.row);
      if (t == null || bt == null) continue;
      ctx.fillStyle = b.color;
      const y0 = py(Math.min(t, bt)) + margin;
      ctx.fillRect(b.from, y0, b.to - b.from, py(Math.max(t, bt)) - margin - y0);
    }
    // Blocks.
    if (cellsOk && (st.showLetters || st.showBlocks)) {
      const nonVaAlpha = 1 - st.nonVaOpacity / 100;
      ctx.save();
      ctx.font = `bold ${fontSize * vr}px ${font}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const r of p.rows) {
        const t = rowTop(r.row);
        const b = rowBot(r.row);
        if (t == null || b == null) continue;
        const y0 = py(Math.min(t, b)) + margin / 2;
        const y1 = py(Math.max(t, b)) - margin / 2 - 1;
        ctx.globalAlpha = r.row > p.vah || r.row < p.val ? nonVaAlpha : 1;
        const isPoc = r.row === p.poc && st.poc.visible;
        r.blocks.forEach((e, i) => {
          const c = colX(expand ? e : i);
          const color = isPoc ? pocColor : blockColor(st.colors, e);
          ctx.lineWidth = margin;
          ctx.strokeStyle = bg;
          ctx.strokeRect(c.start - margin / 2, y0 - margin / 2, c.end - c.start + margin + 1, y1 - y0 + margin + 1);
          ctx.fillStyle = blocks ? color : withAlpha(bg, 0.7);
          ctx.fillRect(c.start, y0, c.end - c.start + 1, y1 - y0 + 1);
          if (letters) {
            ctx.fillStyle = isPoc && blocks ? pocLetter : blocks ? "#FFFFFF" : color;
            ctx.fillText(letterOf(e), Math.round((c.start + c.end) / 2), Math.round((y0 + y1) / 2));
          }
        });
      }
      ctx.restore();
    }
    // Volume histogram.
    const histX = V + (68 * E) / 100 + (2 * E) / 100;
    const histW = (20 * E) / 100;
    if (volumeOn && cellsOk && p.volume.length) {
      const max = Math.max(...p.volume.map((v) => v.volume));
      const l = px(histX + histW) - px(histX);
      const right = st.volume.placement === "Right";
      for (const v of p.volume) {
        const t = rowTop(v.row);
        const b = rowBot(v.row);
        if (t == null || b == null || !(max > 0)) continue;
        const w = (l * v.volume) / max;
        const y0 = py(Math.min(t, b)) + margin / 2;
        const y1 = py(Math.max(t, b)) - margin / 2 - 1;
        const inVa = p.volumeVal !== null && p.volumeVah !== null && v.row >= p.volumeVal && v.row <= p.volumeVah;
        ctx.fillStyle = inVa ? st.volume.vaColor : st.volume.nonVaColor;
        ctx.fillRect(right ? px(histX + histW) - w : px(histX), y0, w, y1 - y0 + 1);
      }
      if (st.volume.showValues) this.volumeValues(ctx, p, histX, histW, right, hr, vr, rowTop, rowBot, font);
    }
    // Levels: lines then labels.
    const lineAt = (yv: number | null, x0: number, x1: number, color: string, width: number, dash: number[]) => {
      if (yv == null) return;
      const lw = Math.max(1, Math.floor(width * hr));
      let yy = Math.round(yv * vr);
      if (Boolean(yy % 1) !== Boolean(lw % 2)) yy += 0.5;
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.setLineDash(dash.map((d) => d * hr));
      ctx.beginPath();
      ctx.moveTo(x0, yy);
      ctx.lineTo(x1, yy);
      ctx.stroke();
      ctx.setLineDash([]);
    };
    const labelAt = (yv: number | null, x: number, side: "left" | "right", color: string, text: string | undefined, triangle = true) => {
      if (yv == null) return;
      const g = side === "left" ? -1 : 1;
      const yy = Math.round(yv * vr) + 0.5;
      const p0 = x + g * Math.round(2.7 * hr);
      const p1 = p0 + g * Math.round(4 * hr);
      ctx.fillStyle = color;
      ctx.strokeStyle = bg;
      ctx.lineWidth = Math.max(1, Math.floor(hr));
      if (triangle) {
        ctx.beginPath();
        ctx.moveTo(p0, yy);
        ctx.lineTo(p1, yy - Math.round(3.5 * vr));
        ctx.lineTo(p1, yy + Math.round(3.5 * vr));
        ctx.closePath();
        ctx.fill();
      }
      if (text) {
        ctx.save();
        ctx.font = `590 ${10 * vr}px ${font}`;
        ctx.textBaseline = "middle";
        ctx.textAlign = side === "left" ? "right" : "left";
        ctx.strokeText(text, p1 + g * Math.round(4 * hr), yy);
        ctx.fillText(text, p1 + g * Math.round(4 * hr), yy);
        ctx.restore();
      }
    };
    const x0 = colX(0).start;
    const boxRight = px(H);
    const withText = cellsOk && !expand;
    const midRow = (r: number) => { const t = rowTop(r); const b = rowBot(r); return t == null || b == null ? null : (t + b) / 2; };
    if (st.vah.visible) {
      const yv = rowTop(p.vah);
      lineAt(yv, x0, p.extend.vah != null ? px(endX(p.extend.vah, H)) : boxRight, st.vah.color, 1, [2, 2]);
      labelAt(yv, x0, "left", st.vah.color, withText ? "VAH" : undefined);
    }
    if (st.val.visible) {
      const yv = rowBot(p.val);
      lineAt(yv, x0, p.extend.val != null ? px(endX(p.extend.val, H)) : boxRight, st.val.color, 1, [2, 2]);
      labelAt(yv, x0, "left", st.val.color, withText ? "VAL" : undefined);
    }
    if (st.poc.visible) labelAt(midRow(p.poc), x0, "left", pocColor, withText ? "POC" : undefined);
    if (volumeOn && cellsOk) {
      const hx = px(histX);
      const vl = (on: boolean, row: number | null, at: "mid" | "top" | "bot", color: string, width: number, style: number, end: number | null | undefined) => {
        if (!on || row === null) return;
        const yv = at === "mid" ? midRow(row) : at === "top" ? rowTop(row) : rowBot(row);
        lineAt(yv, hx, end != null ? px(endX(end, H)) : boxRight, color, width, style === 1 ? [6, 6] : style === 2 ? [2, 2] : []);
      };
      const vs = st.volume;
      vl(vs.poc.visible, p.volumePoc, "mid", vs.poc.color, vs.poc.width, vs.poc.style, p.extend.volumePoc);
      vl(vs.vah.visible, p.volumeVah, "top", vs.vah.color, vs.vah.width, vs.vah.style, p.extend.volumeVah);
      vl(vs.val.visible, p.volumeVal, "bot", vs.val.color, vs.val.width, vs.val.style, p.extend.volumeVal);
    }
    const labelColor = this.dark ? "#DBDBDB" : "#0F0F0F";
    if (st.open) labelAt(series.priceToCoordinate(p.open), x0, "left", labelColor, withText ? "Open" : undefined);
    if (st.close) {
      const r = p.rows.find((x) => x.row === Math.floor(p.close / p.rowSize));
      const col = r ? (expand ? Math.max(...r.blocks) : r.blocks.length - 1) : 0;
      labelAt(series.priceToCoordinate(p.close), colX(col).end + 1, "right", labelColor, withText ? "Close" : undefined);
    }
    if (st.midpoint) {
      const r = p.rows.find((x) => x.row === p.mid);
      const col = r ? (expand ? r.blocks[0] : 0) : 0;
      labelAt(midRow(p.mid), colX(col).start, "left", "#F23645", withText ? "Mid" : undefined);
    }
    if (st.poorHigh.visible && p.poorHigh !== null) lineAt(midRow(p.poorHigh), x0, p.extend.poorHigh != null ? px(endX(p.extend.poorHigh, H)) : boxRight, st.poorHigh.color, 1, [2, 2]);
    if (st.poorLow.visible && p.poorLow !== null) lineAt(midRow(p.poorLow), x0, p.extend.poorLow != null ? px(endX(p.extend.poorLow, H)) : boxRight, st.poorLow.color, 1, [2, 2]);
  }

  /** Row volumes at 3 px from the histogram edge, one font for all, the total under the lowest row. */
  private volumeValues(
    ctx: CanvasRenderingContext2D,
    p: TpoProfile,
    histX: number,
    histW: number,
    right: boolean,
    hr: number,
    vr: number,
    rowTop: (r: number) => number | null,
    rowBot: (r: number) => number | null,
    font: string,
  ): void {
    const fmt = (v: number) => (v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(2)}K` : String(Math.round(v)));
    const items = p.volume.map((v) => {
      const t = rowTop(v.row) ?? 0;
      const b = rowBot(v.row) ?? 0;
      return { text: fmt(v.volume), top: Math.min(t, b), h: Math.abs(b - t) };
    });
    const size = Math.min(...items.map((it) => Math.min(Math.round((1.7 * histW) / it.text.length), Math.round(0.6 * it.h))));
    if (!(size >= 7.5)) return;
    const x = right ? histX + histW - 3 : histX + 3;
    ctx.save();
    ctx.scale(hr, vr);
    ctx.font = `${size}px ${font}`;
    ctx.fillStyle = this.draw.style.volume.valuesColor;
    ctx.textAlign = right ? "right" : "left";
    for (const it of items) ctx.fillText(it.text, x, it.top + 0.7 * it.h);
    const low = items[0];
    ctx.fillText(fmt(p.volume.reduce((a, v) => a + v.volume, 0)), x, low.top + low.h + 0.7 * low.h);
    ctx.restore();
  }
}
