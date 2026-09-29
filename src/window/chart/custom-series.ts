/*
 * Custom-series renderers for the chart types lightweight-charts has no
 * built-in for: Kagi, Point & Figure, Session Volume Profile, TPO (market
 * profile), Volume Footprint, HLC Area, Volume Candles, and Hi-Lo.
 *
 * Data honesty:
 *   • kagi / pnf     — pure close-price transforms (reversal/box from ATR,
 *                      like the Renko transform); synthetic index time axis.
 *   • svp / tpo      — per-session profiles computed from the LOADED bars:
 *                      each bar's volume (svp) or presence (tpo) is spread
 *                      uniformly across the price rows its range covers.
 *                      Session unit is inferred from the bar spacing: day for
 *                      intraday, month for daily, year for weekly/monthly.
 *   • volFootprint   — per-bar buy/sell cells need SUB-bar data; ChartView
 *                      feeds 1-minute bars (up/down split by the minute's
 *                      direction — the standard aggregate approximation).
 *                      Bars without sub-data render as plain candles.
 *   • hlcArea        — TV's HLC Area: high + low lines with a band fill
 *                      between them and the close line on top.
 *   • volCandles     — TV's Volume Candles: standard candles whose BODY WIDTH
 *                      scales with the bar's volume relative to the window max.
 *   • hilo           — TV's High-Low: per-bar high↔low column + close tick,
 *                      coloured by close vs the previous close, with H/L value
 *                      labels at wide bar spacing.
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
import type { ChartTokens } from "./chart-tokens";
import type { OHLC } from "./chart-types";
import type { KagiItem, PnfItem } from "./series-transforms";
import type { SvpStyle } from "../header/chart-settings";
export type { KagiItem, PnfItem } from "./series-transforms";

type DrawTarget = Parameters<ICustomSeriesPaneRenderer["draw"]>[0];
type MediaScope = { context: CanvasRenderingContext2D; mediaSize: { width: number; height: number } };

function withMedia(target: DrawTarget, fn: (scope: MediaScope) => void): void {
  (target as unknown as { useMediaCoordinateSpace: (h: (s: MediaScope) => void) => void }).useMediaCoordinateSpace(fn);
}

function toSeconds(t: Time): number {
  if (typeof t === "number") return t;
  if (typeof t === "string") return Math.floor(new Date(t).getTime() / 1000);
  return Math.floor(
    new Date(`${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`).getTime() / 1000,
  );
}

/** Median bar interval (seconds) — session-unit + sub-bar bucketing input. */
function medianDelta(raw: OHLC[]): number {
  const ds: number[] = [];
  for (let i = 1; i < Math.min(raw.length, 60); i++) {
    ds.push(toSeconds(raw[i].time) - toSeconds(raw[i - 1].time));
  }
  ds.sort((a, b) => a - b);
  return ds[Math.floor(ds.length / 2)] ?? 86400;
}



// ── Kagi ────────────────────────────────────────────────────────────────────

export class KagiPaneView implements ICustomSeriesPaneView<Time, KagiItem, CustomSeriesOptions> {
  private data: PaneRendererCustomData<Time, KagiItem> | null = null;
  constructor(private tokens: ChartTokens) {}
  priceValueBuilder(item: KagiItem): CustomSeriesPricePlotValues {
    return [Math.min(item.start, item.end), Math.max(item.start, item.end), item.end];
  }
  isWhitespace(d: KagiItem | { time: Time }): d is { time: Time } {
    return !("end" in d);
  }
  renderer(): ICustomSeriesPaneRenderer {
    return {
      draw: (target: DrawTarget, ptc: PriceToCoordinateConverter) => {
        const data = this.data;
        if (!data || !data.bars.length) return;
        withMedia(target, ({ context: ctx }) => {
          const st = this.tokens.styles.kagi;
          let proj = false;
          const stroke = (yang: boolean) => {
            ctx.strokeStyle = yang ? (proj ? st.projUp : st.up) : (proj ? st.projDown : st.down);
            ctx.lineWidth = yang ? 2.5 : 1;
          };
          for (let i = 0; i < data.bars.length; i++) {
            const bar = data.bars[i];
            const d = bar.originalData;
            proj = d.proj;
            // Horizontal connector from the previous column at its end price.
            if (i > 0) {
              const prev = data.bars[i - 1];
              const y = ptc(prev.originalData.end);
              if (y != null) {
                stroke(prev.originalData.segments[prev.originalData.segments.length - 1].yang);
                ctx.beginPath();
                ctx.moveTo(prev.x, y);
                ctx.lineTo(bar.x, y);
                ctx.stroke();
              }
            }
            for (const seg of d.segments) {
              const y0 = ptc(seg.from);
              const y1 = ptc(seg.to);
              if (y0 == null || y1 == null) continue;
              stroke(seg.yang);
              ctx.beginPath();
              ctx.moveTo(bar.x, y0);
              ctx.lineTo(bar.x, y1);
              ctx.stroke();
            }
          }
        });
      },
      update: (data: PaneRendererCustomData<Time, KagiItem>) => {
        this.data = data;
      },
    } as ICustomSeriesPaneRenderer & { update: (d: PaneRendererCustomData<Time, KagiItem>) => void };
  }
  update(data: PaneRendererCustomData<Time, KagiItem>): void {
    this.data = data;
  }
  defaultOptions(): CustomSeriesOptions {
    return customSeriesDefaultOptions;
  }
}

// ── Point & Figure ──────────────────────────────────────────────────────────

export class PnfPaneView implements ICustomSeriesPaneView<Time, PnfItem, CustomSeriesOptions> {
  private data: PaneRendererCustomData<Time, PnfItem> | null = null;
  constructor(private tokens: ChartTokens) {}
  priceValueBuilder(item: PnfItem): CustomSeriesPricePlotValues {
    const lo = Math.min(item.min, item.extra?.top ?? item.min) - item.box;
    const hi = Math.max(item.max, item.extra?.top ?? item.max);
    return [lo, hi, item.kind === "x" ? item.max : item.min];
  }
  isWhitespace(d: PnfItem | { time: Time }): d is { time: Time } {
    return !("box" in d);
  }
  renderer(): ICustomSeriesPaneRenderer {
    return {
      draw: (target: DrawTarget, ptc: PriceToCoordinateConverter) => {
        const data = this.data;
        if (!data || !data.bars.length) return;
        withMedia(target, ({ context: ctx }) => {
          const halfW = Math.max(2, Math.min(data.barSpacing * 0.4, 14));
          ctx.lineWidth = 1.5;
          const st = this.tokens.styles.pnf;
          const drawBox = (x: number, top: number, box: number, kind: "x" | "o", proj: boolean) => {
            const yTop = ptc(top);
            const yBot = ptc(top - box);
            if (yTop == null || yBot == null) return;
            ctx.strokeStyle = kind === "x" ? (proj ? st.projUp : st.up) : (proj ? st.projDown : st.down);
            const cy = (yTop + yBot) / 2;
            const halfH = Math.abs(yBot - yTop) / 2;
            const r = Math.min(halfW, Math.max(1.5, halfH * 0.8));
            ctx.beginPath();
            if (kind === "x") {
              ctx.moveTo(x - r, cy + r);
              ctx.lineTo(x + r, cy - r);
              ctx.moveTo(x - r, cy - r);
              ctx.lineTo(x + r, cy + r);
            } else {
              ctx.arc(x, cy, r, 0, Math.PI * 2);
            }
            ctx.stroke();
          };
          for (const bar of data.bars) {
            const d = bar.originalData;
            for (let p = d.min; p <= d.max + 1e-9; p += d.box) drawBox(bar.x, p, d.box, d.kind, d.proj);
            if (d.extra) drawBox(bar.x, d.extra.top, d.box, d.extra.kind, d.proj);
          }
        });
      },
      update: (data: PaneRendererCustomData<Time, PnfItem>) => {
        this.data = data;
      },
    } as ICustomSeriesPaneRenderer & { update: (d: PaneRendererCustomData<Time, PnfItem>) => void };
  }
  update(data: PaneRendererCustomData<Time, PnfItem>): void {
    this.data = data;
  }
  defaultOptions(): CustomSeriesOptions {
    return customSeriesDefaultOptions;
  }
}

// ── Session profiles (SVP + TPO) ────────────────────────────────────────────

export type ProfileBlock = {
  top: number;
  bottom: number;
  rowH: number;
  /** Per-row up / down volume (svp; bar direction splits a bar's volume) or
   *  time-at-price bar count in `up` (tpo). */
  up: number[];
  down: number[];
  maxRow: number;
  /** Bar index span of the session inside the data (first … last). */
  first: number;
  last: number;
  poc: number;
  vaLo: number;
  vaHi: number;
};

export type ProfileItem = {
  time: Time;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Present on the FIRST bar of each session. */
  profile?: ProfileBlock;
  /** Developing POC / value area (svp) at this bar, prices. */
  dev?: { poc: number; vah: number; val: number };
};

const TPO_ROWS = 24;

/** New York calendar-date key (session split for intraday charts). */
const nyDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const nyMinute = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" });
function etMinuteOf(sec: number): number {
  const [h, m] = nyMinute.format(new Date(sec * 1000)).split(":").map(Number);
  return (h % 24) * 60 + m;
}

function sessionKey(sec: number, unit: "day" | "month" | "year"): string {
  const d = nyDate.format(new Date(sec * 1000)); // YYYY-MM-DD
  if (unit === "day") return d;
  if (unit === "month") return d.slice(0, 7);
  return d.slice(0, 4);
}

/** US equity session part of a bar (ET): pre 04:00-09:30, market
 *  09:30-16:00, post 16:00-20:00. */
function partOf(sec: number): "pre" | "market" | "post" {
  const m = etMinuteOf(sec);
  return m < 570 ? "pre" : m < 960 ? "market" : "post";
}

/** "HHMM-HHMM" → [start, end) minutes, null when malformed. */
function parseSession(s: string): [number, number] | null {
  const m = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(s.trim());
  if (!m) return null;
  return [+m[1] * 60 + +m[2], +m[3] * 60 + +m[4]];
}

/** POC (row with the most volume) and the value area: rows added around the
 *  POC, the larger neighbour first, until `pct` % of the volume is inside. */
function pocAndVa(total: number[], pct: number): { poc: number; lo: number; hi: number } {
  let poc = 0;
  for (let k = 1; k < total.length; k++) if (total[k] > total[poc]) poc = k;
  const sum = total.reduce((a, b) => a + b, 0);
  const target = (sum * Math.max(0, Math.min(100, pct))) / 100;
  let lo = poc;
  let hi = poc;
  let acc = total[poc];
  while (acc < target && (lo > 0 || hi < total.length - 1)) {
    const below = lo > 0 ? total[lo - 1] : -1;
    const above = hi < total.length - 1 ? total[hi + 1] : -1;
    if (above >= below) { hi++; acc += total[hi]; } else { lo--; acc += total[lo]; }
  }
  return { poc, lo, hi };
}

/** Group the loaded bars into sessions and build a volume- (svp) or
 *  time-at-price- (tpo) by-price profile per session. Intraday: one session
 *  per day, filtered / split by the SVP "Sessions" input; daily: month;
 *  above: year. */
export function toProfile(raw: OHLC[], mode: "svp" | "tpo", st?: SvpStyle): ProfileItem[] {
  if (raw.length === 0) return [];
  const delta = medianDelta(raw);
  const intraday = delta < 86400;
  const unit: "day" | "month" | "year" = intraday ? "day" : delta <= 86400 * 2 ? "month" : "year";
  const items: ProfileItem[] = raw.map((r) => ({ time: r.time, open: r.open, high: r.high, low: r.low, close: r.close }));
  const sessions = mode === "svp" && st && intraday ? st.sessions : "All";
  const custom = sessions === "Custom" && st ? parseSession(st.customSession) : null;
  // Which bars belong to a profile, and the key that splits sessions.
  const keyOf = (i: number): string | null => {
    const sec = toSeconds(raw[i].time);
    const day = sessionKey(sec, unit);
    if (sessions === "All") return day;
    const part = partOf(sec);
    if (sessions === "Each (pre-market, market, post-market)") return `${day}:${part}`;
    if (sessions === "Pre-market only") return part === "pre" ? day : null;
    if (sessions === "Market only") return part === "market" ? day : null;
    if (sessions === "Post-market only") return part === "post" ? day : null;
    if (custom) {
      const m = etMinuteOf(sec);
      return m >= custom[0] && m < custom[1] ? day : null;
    }
    return day;
  };
  const groups: { key: string; idx: number[] }[] = [];
  for (let i = 0; i < raw.length; i++) {
    const k = keyOf(i);
    if (k == null) continue;
    const g = groups[groups.length - 1];
    if (g && g.key === k) g.idx.push(i);
    else groups.push({ key: k, idx: [i] });
  }
  for (const g of groups) {
    let top = -Infinity;
    let bottom = Infinity;
    for (const i of g.idx) { top = Math.max(top, raw[i].high); bottom = Math.min(bottom, raw[i].low); }
    if (!(top > bottom)) continue;
    let n = TPO_ROWS;
    if (mode === "svp" && st) {
      if (st.rowsLayout === "Ticks Per Row") {
        const tick = Math.abs(raw[g.idx[0]].close) >= 1 ? 0.01 : 0.0001;
        n = Math.max(1, Math.min(2000, Math.ceil((top - bottom) / (tick * Math.max(1, st.rows)))));
      } else {
        n = Math.max(1, Math.round(st.rows));
      }
    }
    const rowH = (top - bottom) / n;
    const up = new Array<number>(n).fill(0);
    const down = new Array<number>(n).fill(0);
    const pct = st?.vaPercent ?? 70;
    const devs: ProfileItem["dev"][] = [];
    for (const i of g.idx) {
      const r = raw[i];
      const lo = Math.max(0, Math.floor((r.low - bottom) / rowH));
      const hi = Math.min(n - 1, Math.floor((r.high - bottom - 1e-9) / rowH));
      const w = mode === "svp" ? (r.volume ?? 0) / (hi - lo + 1) : 1;
      const into = r.close >= r.open ? up : down;
      for (let k = lo; k <= hi; k++) (mode === "svp" ? into : up)[k] += w;
      if (mode === "svp") {
        const tot = up.map((v, k) => v + down[k]);
        const d = pocAndVa(tot, pct);
        devs.push({ poc: bottom + rowH * (d.poc + 0.5), vah: bottom + rowH * (d.hi + 1), val: bottom + rowH * d.lo });
      }
    }
    const total = up.map((v, k) => v + down[k]);
    const maxRow = total.reduce((m, v) => Math.max(m, v), 0);
    if (maxRow <= 0) continue;
    const va = pocAndVa(total, pct);
    items[g.idx[0]].profile = { top, bottom, rowH, up, down, maxRow, first: g.idx[0], last: g.idx[g.idx.length - 1], poc: va.poc, vaLo: va.lo, vaHi: va.hi };
    if (mode === "svp") g.idx.forEach((i, k) => { items[i].dev = devs[k]; });
  }
  return items;
}

/** Session volume profile (TV svpStyle rows) and TPO block profile. SVP:
 *  candles (Candles rows), per session a histogram box, up / down (or
 *  total / delta) volume rows — value-area rows in the value-area colours —
 *  grown from the session's left or right edge to Width % of the session,
 *  optional row values, VAH / VAL / POC lines (optionally extended right)
 *  and the developing POC / value area step lines. */
export class ProfilePaneView implements ICustomSeriesPaneView<Time, ProfileItem, CustomSeriesOptions> {
  private data: PaneRendererCustomData<Time, ProfileItem> | null = null;
  constructor(private tokens: ChartTokens, private mode: "svp" | "tpo") {}
  priceValueBuilder(item: ProfileItem): CustomSeriesPricePlotValues {
    return [item.low, item.high, item.close];
  }
  isWhitespace(d: ProfileItem | { time: Time }): d is { time: Time } {
    return !("close" in d);
  }
  renderer(): ICustomSeriesPaneRenderer {
    return {
      draw: (target: DrawTarget, ptc: PriceToCoordinateConverter) => {
        const data = this.data;
        if (!data || !data.bars.length) return;
        withMedia(target, ({ context: ctx, mediaSize }) => {
          const bars = data.bars;
          if (this.mode === "svp") this.drawCandles(ctx, data, ptc);
          const st = this.tokens.styles.svp;
          for (let k = 0; k < bars.length; k++) {
            const p = bars[k].originalData.profile;
            if (!p) continue;
            const span = p.last - p.first;
            const x0 = bars[k].x - data.barSpacing / 2;
            const x1 = x0 + (span + 1) * data.barSpacing;
            const yTop = ptc(p.top);
            const yBot = ptc(p.bottom);
            if (yTop == null || yBot == null) continue;
            if (this.mode === "tpo") {
              this.drawTpo(ctx, p, x0, (span + 1) * data.barSpacing, ptc);
              continue;
            }
            // Histogram box.
            ctx.fillStyle = st.histBox;
            ctx.fillRect(x0, yTop, x1 - x0, yBot - yTop);
            const maxW = ((x1 - x0) * Math.max(1, Math.min(100, st.width))) / 100;
            const fromRight = st.placement === "Right";
            for (let r = 0; r < p.up.length; r++) {
              const ya = ptc(p.bottom + p.rowH * (r + 1));
              const yb = ptc(p.bottom + p.rowH * r);
              if (ya == null || yb == null) continue;
              const inVa = r >= p.vaLo && r <= p.vaHi;
              const upC = inVa ? st.vaUp : st.upVolume;
              const dnC = inVa ? st.vaDown : st.downVolume;
              const h = Math.max(1, yb - ya - 1);
              const segs: { v: number; c: string }[] =
                st.volume === "Total" ? [{ v: p.up[r] + p.down[r], c: upC }]
                : st.volume === "Delta" ? [{ v: Math.abs(p.up[r] - p.down[r]), c: p.up[r] >= p.down[r] ? upC : dnC }]
                : [{ v: p.up[r], c: upC }, { v: p.down[r], c: dnC }];
              let off = 0;
              for (const s of segs) {
                const w = (s.v / p.maxRow) * maxW;
                if (w <= 0) continue;
                ctx.fillStyle = s.c;
                ctx.fillRect(fromRight ? x1 - off - w : x0 + off, ya + 0.5, w, h);
                off += w;
              }
              if (st.showValues) {
                const v = st.volume === "Total" ? p.up[r] + p.down[r] : st.volume === "Delta" ? p.up[r] - p.down[r] : p.up[r] + p.down[r];
                ctx.fillStyle = st.valuesColor;
                ctx.font = `${Math.max(8, Math.min(12, h))}px ${this.tokens.fontFamily}`;
                ctx.textBaseline = "middle";
                ctx.textAlign = fromRight ? "right" : "left";
                ctx.fillText(compact(v), fromRight ? x1 - off - 2 : x0 + off + 2, ya + h / 2);
              }
            }
            const line = (price: number, ln: { on: boolean; extend: boolean; color: string; width: number; style: number }) => {
              if (!ln.on) return;
              const y = ptc(price);
              if (y == null) return;
              ctx.strokeStyle = ln.color;
              ctx.lineWidth = ln.width;
              ctx.setLineDash(dashFor(ln.style, ln.width));
              ctx.beginPath();
              ctx.moveTo(x0, y);
              ctx.lineTo(ln.extend ? mediaSize.width : x1, y);
              ctx.stroke();
              ctx.setLineDash([]);
            };
            line(p.bottom + p.rowH * (p.vaHi + 1), st.vah);
            line(p.bottom + p.rowH * p.vaLo, st.val);
            line(p.bottom + p.rowH * (p.poc + 0.5), st.poc);
          }
          // Developing POC / value area: step lines through the bars.
          const dev = (pick: (d: NonNullable<ProfileItem["dev"]>) => number, ln: { on: boolean; color: string; width: number; style: number }) => {
            if (!ln.on) return;
            ctx.strokeStyle = ln.color;
            ctx.lineWidth = ln.width;
            ctx.setLineDash(dashFor(ln.style, ln.width));
            ctx.beginPath();
            let prevY: number | null = null;
            for (const b of bars) {
              const d = b.originalData.dev;
              if (!d || b.originalData.profile) prevY = null;
              if (!d) continue;
              const y = ptc(pick(d));
              if (y == null) continue;
              const xl = b.x - data.barSpacing / 2;
              if (prevY == null) ctx.moveTo(xl, y);
              else ctx.lineTo(xl, y);
              ctx.lineTo(b.x + data.barSpacing / 2, y);
              prevY = y;
            }
            ctx.stroke();
            ctx.setLineDash([]);
          };
          if (this.mode === "svp") {
            dev((d) => d.poc, st.devPoc);
            dev((d) => d.vah, st.devVa);
            dev((d) => d.val, st.devVa);
          }
        });
      },
      update: (data: PaneRendererCustomData<Time, ProfileItem>) => {
        this.data = data;
      },
    } as ICustomSeriesPaneRenderer & { update: (d: PaneRendererCustomData<Time, ProfileItem>) => void };
  }
  private drawCandles(ctx: CanvasRenderingContext2D, data: PaneRendererCustomData<Time, ProfileItem>, ptc: PriceToCoordinateConverter) {
    const c = this.tokens.styles.candle;
    const bodyW = Math.max(1, data.barSpacing * 0.6);
    for (const bar of data.bars) {
      const d = bar.originalData;
      const up = d.close >= d.open;
      const yH = ptc(d.high);
      const yL = ptc(d.low);
      const yO = ptc(d.open);
      const yC = ptc(d.close);
      if (yH == null || yL == null || yO == null || yC == null) continue;
      if (c.wick) {
        ctx.strokeStyle = up ? c.wickUp : c.wickDown;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(bar.x, yH);
        ctx.lineTo(bar.x, yL);
        ctx.stroke();
      }
      const top = Math.min(yO, yC);
      const h = Math.max(1, Math.abs(yC - yO));
      if (c.body) {
        ctx.fillStyle = up ? c.bodyUp : c.bodyDown;
        ctx.fillRect(bar.x - bodyW / 2, top, bodyW, h);
      }
      if (c.border) {
        ctx.strokeStyle = up ? c.borderUp : c.borderDown;
        ctx.strokeRect(bar.x - bodyW / 2 + 0.5, top + 0.5, Math.max(0, bodyW - 1), Math.max(0, h - 1));
      }
    }
  }
  /** TPO: block profile (no TV style rows ported). */
  private drawTpo(ctx: CanvasRenderingContext2D, p: ProfileBlock, x0: number, width: number, ptc: PriceToCoordinateConverter) {
    const maxW = width * 0.9;
    for (let k = 0; k < p.up.length; k++) {
      const v = p.up[k];
      if (v <= 0) continue;
      const y0 = ptc(p.bottom + p.rowH * (k + 1));
      const y1 = ptc(p.bottom + p.rowH * k);
      if (y0 == null || y1 == null) continue;
      const w = Math.max(1, (v / p.maxRow) * maxW);
      ctx.fillStyle = k === p.poc ? rgbaOf(this.tokens.up, 0.75) : rgbaOf(this.tokens.up, 0.45);
      ctx.fillRect(x0, y0 + 0.5, w, Math.max(1, y1 - y0 - 1));
    }
    ctx.strokeStyle = rgbaOf(this.tokens.text, 0.2);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, ptc(p.top) ?? 0);
    ctx.lineTo(x0, ptc(p.bottom) ?? 0);
    ctx.stroke();
  }
  update(data: PaneRendererCustomData<Time, ProfileItem>): void {
    this.data = data;
  }
  defaultOptions(): CustomSeriesOptions {
    return customSeriesDefaultOptions;
  }
}

function rgbaOf(hex: string, alpha: number): string {
  const h = hex.trim().replace("#", "");
  if (h.length !== 6 && h.length !== 3) return hex;
  const e = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return `rgba(${parseInt(e.slice(0, 2), 16)}, ${parseInt(e.slice(2, 4), 16)}, ${parseInt(e.slice(4, 6), 16)}, ${alpha})`;
}

// ── Volume footprint ────────────────────────────────────────────────────────

export type FootprintItem = {
  time: Time;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Buy/sell volume per price cell, from 1-minute sub-bars. Absent when no
   *  sub-data covers this bar (renders as a plain candle). */
  cells?: { p0: number; p1: number; up: number; down: number }[];
  maxCell?: number;
};

const FOOTPRINT_ROWS = 12;

/** Build per-bar buy/sell-by-price cells from 1-minute sub-bars: each minute's
 *  volume spreads uniformly over the cells its range covers and counts as buy
 *  (close >= open) or sell — the standard aggregate approximation of tick
 *  footprints. */
export function toFootprint(raw: OHLC[], subMinute: OHLC[] | undefined): FootprintItem[] {
  const items: FootprintItem[] = raw.map((r) => ({
    time: r.time,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
  }));
  if (!subMinute || subMinute.length === 0 || raw.length === 0) return items;
  const delta = medianDelta(raw);
  if (delta >= 86400) return items; // footprint is intraday-only (sub-data infeasible)
  // Index sub-bars by owning chart bar (bars are time-ascending).
  let j = 0;
  const subsByBar: OHLC[][] = raw.map(() => []);
  const times = raw.map((r) => toSeconds(r.time));
  for (const sb of subMinute) {
    const t = toSeconds(sb.time);
    while (j < raw.length - 1 && t >= times[j + 1]) j++;
    if (t >= times[j] && t < times[j] + delta) subsByBar[j].push(sb);
    else if (t < times[0]) continue;
  }
  // j only walks forward; restart for out-of-order safety.
  for (let i = 0; i < raw.length; i++) {
    const subs = subsByBar[i];
    if (subs.length === 0) continue;
    const r = raw[i];
    const top = r.high;
    const bottom = r.low;
    if (!(top > bottom)) continue;
    const rowH = (top - bottom) / FOOTPRINT_ROWS;
    const up = new Array<number>(FOOTPRINT_ROWS).fill(0);
    const down = new Array<number>(FOOTPRINT_ROWS).fill(0);
    for (const sb of subs) {
      const lo = Math.max(0, Math.floor((sb.low - bottom) / rowH));
      const hi = Math.min(FOOTPRINT_ROWS - 1, Math.floor((sb.high - bottom - 1e-9) / rowH));
      const w = (sb.volume ?? 0) / (hi - lo + 1);
      const buy = sb.close >= sb.open;
      for (let k = lo; k <= hi; k++) {
        if (buy) up[k] += w;
        else down[k] += w;
      }
    }
    const cells = up.map((u, k) => ({
      p0: bottom + rowH * k,
      p1: bottom + rowH * (k + 1),
      up: u,
      down: down[k],
    }));
    const maxCell = cells.reduce((m, c) => Math.max(m, c.up, c.down), 0);
    if (maxCell > 0) {
      items[i].cells = cells;
      items[i].maxCell = maxCell;
    }
  }
  return items;
}

export class FootprintPaneView implements ICustomSeriesPaneView<Time, FootprintItem, CustomSeriesOptions> {
  private data: PaneRendererCustomData<Time, FootprintItem> | null = null;
  constructor(private tokens: ChartTokens) {}
  priceValueBuilder(item: FootprintItem): CustomSeriesPricePlotValues {
    return [item.low, item.high, item.close];
  }
  isWhitespace(d: FootprintItem | { time: Time }): d is { time: Time } {
    return !("close" in d);
  }
  renderer(): ICustomSeriesPaneRenderer {
    return {
      draw: (target: DrawTarget, ptc: PriceToCoordinateConverter) => {
        const data = this.data;
        if (!data || !data.bars.length) return;
        withMedia(target, ({ context: ctx }) => {
          const halfW = Math.max(2, data.barSpacing * 0.45);
          const showNumbers = data.barSpacing >= 60;
          for (const bar of data.bars) {
            const d = bar.originalData;
            const up = d.close >= d.open;
            const col = up ? this.tokens.up : this.tokens.down;
            const yH = ptc(d.high);
            const yL = ptc(d.low);
            const yO = ptc(d.open);
            const yC = ptc(d.close);
            if (yH == null || yL == null || yO == null || yC == null) continue;
            if (!d.cells || !d.maxCell) {
              // No sub-data → plain candle.
              ctx.strokeStyle = col;
              ctx.fillStyle = col;
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.moveTo(bar.x, yH);
              ctx.lineTo(bar.x, yL);
              ctx.stroke();
              ctx.fillRect(bar.x - halfW * 0.6, Math.min(yO, yC), halfW * 1.2, Math.max(1, Math.abs(yC - yO)));
              continue;
            }
            // Wick + open/close ticks (skeleton).
            ctx.strokeStyle = col;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(bar.x, yH);
            ctx.lineTo(bar.x, yL);
            ctx.moveTo(bar.x - halfW, yO);
            ctx.lineTo(bar.x, yO);
            ctx.moveTo(bar.x, yC);
            ctx.lineTo(bar.x + halfW, yC);
            ctx.stroke();
            // Cells: sell (down) half to the left, buy (up) half to the right.
            for (const c of d.cells) {
              const y0 = ptc(c.p1);
              const y1 = ptc(c.p0);
              if (y0 == null || y1 == null) continue;
              const h = Math.max(1, y1 - y0 - 1);
              const wDown = (c.down / d.maxCell) * halfW;
              const wUp = (c.up / d.maxCell) * halfW;
              if (wDown > 0.5) {
                ctx.fillStyle = this.hex(this.tokens.down, 0.45);
                ctx.fillRect(bar.x - wDown, y0 + 0.5, wDown, h);
              }
              if (wUp > 0.5) {
                ctx.fillStyle = this.hex(this.tokens.up, 0.45);
                ctx.fillRect(bar.x, y0 + 0.5, wUp, h);
              }
              if (showNumbers && h >= 10) {
                ctx.fillStyle = this.tokens.text;
                ctx.font = "9px sans-serif";
                ctx.textAlign = "right";
                ctx.fillText(compact(c.down), bar.x - 3, y0 + h / 2 + 3);
                ctx.textAlign = "left";
                ctx.fillText(compact(c.up), bar.x + 3, y0 + h / 2 + 3);
              }
            }
          }
        });
      },
      update: (data: PaneRendererCustomData<Time, FootprintItem>) => {
        this.data = data;
      },
    } as ICustomSeriesPaneRenderer & { update: (d: PaneRendererCustomData<Time, FootprintItem>) => void };
  }
  update(data: PaneRendererCustomData<Time, FootprintItem>): void {
    this.data = data;
  }
  defaultOptions(): CustomSeriesOptions {
    return customSeriesDefaultOptions;
  }
  private hex(hex: string, alpha: number): string {
    const h = hex.trim().replace("#", "");
    if (h.length !== 6 && h.length !== 3) return hex;
    const e = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    return `rgba(${parseInt(e.slice(0, 2), 16)}, ${parseInt(e.slice(2, 4), 16)}, ${parseInt(e.slice(4, 6), 16)}, ${alpha})`;
  }
}

function compact(v: number): string {
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(Math.round(v));
}


// ── HLC Area ────────────────────────────────────────────────────────────────

export type HlcAreaItem = {
  time: Time;
  high: number;
  low: number;
  close: number;
};

/** Pass-through of the loaded bars' H/L/C (no transform — the type is a pure
 *  rendering variant of the source series). */
export function toHlcArea(raw: OHLC[]): HlcAreaItem[] {
  return raw.map((r) => ({ time: r.time, high: r.high, low: r.low, close: r.close }));
}

/** TV's HLC Area (hlcAreaStyle): high / low / close lines, the band between
 *  high and close filled with highCloseFillColor and the band between close
 *  and low with closeLowFillColor; high and low lines can be hidden. */
export class HlcAreaPaneView implements ICustomSeriesPaneView<Time, HlcAreaItem, CustomSeriesOptions> {
  private data: PaneRendererCustomData<Time, HlcAreaItem> | null = null;
  constructor(private tokens: ChartTokens) {}
  priceValueBuilder(item: HlcAreaItem): CustomSeriesPricePlotValues {
    return [item.low, item.high, item.close];
  }
  isWhitespace(d: HlcAreaItem | { time: Time }): d is { time: Time } {
    return !("close" in d);
  }
  renderer(): ICustomSeriesPaneRenderer {
    return {
      draw: (target: DrawTarget, ptc: PriceToCoordinateConverter) => {
        const data = this.data;
        if (!data || data.bars.length < 2) return;
        const st = this.tokens.styles.hlcArea;
        withMedia(target, ({ context: ctx }) => {
          const bars = data.bars;
          const band = (a: (d: HlcAreaItem) => number, b: (d: HlcAreaItem) => number, color: string) => {
            ctx.beginPath();
            let started = false;
            for (const bar of bars) {
              const y = ptc(a(bar.originalData));
              if (y == null) continue;
              if (!started) { ctx.moveTo(bar.x, y); started = true; } else ctx.lineTo(bar.x, y);
            }
            for (let i = bars.length - 1; i >= 0; i--) {
              const y = ptc(b(bars[i].originalData));
              if (y != null) ctx.lineTo(bars[i].x, y);
            }
            ctx.closePath();
            ctx.fillStyle = color;
            ctx.fill();
          };
          band((d) => d.high, (d) => d.close, st.fillTop);
          band((d) => d.close, (d) => d.low, st.fillBottom);
          const polyline = (pick: (d: HlcAreaItem) => number, spec: { color: string; width: number; style: number }) => {
            ctx.beginPath();
            let open = false;
            for (const bar of bars) {
              const y = ptc(pick(bar.originalData));
              if (y == null) { open = false; continue; }
              if (!open) { ctx.moveTo(bar.x, y); open = true; } else ctx.lineTo(bar.x, y);
            }
            ctx.strokeStyle = spec.color;
            ctx.lineWidth = spec.width;
            ctx.setLineDash(dashFor(spec.style, spec.width));
            ctx.lineJoin = "round";
            ctx.stroke();
            ctx.setLineDash([]);
          };
          if (st.high.on) polyline((d) => d.high, st.high);
          if (st.low.on) polyline((d) => d.low, st.low);
          polyline((d) => d.close, st.close);
        });
      },
      update: (data: PaneRendererCustomData<Time, HlcAreaItem>) => {
        this.data = data;
      },
    } as ICustomSeriesPaneRenderer & { update: (d: PaneRendererCustomData<Time, HlcAreaItem>) => void };
  }
  update(data: PaneRendererCustomData<Time, HlcAreaItem>): void {
    this.data = data;
  }
  defaultOptions(): CustomSeriesOptions {
    return customSeriesDefaultOptions;
  }
}

/** Canvas dash pattern for the picker enum (0 solid, 1 dashed, 2 dotted). */
export function dashFor(style: number, width: number): number[] {
  const w = Math.max(1, width);
  return style === 1 ? [4 * w, 4 * w] : style === 2 ? [w, 2 * w] : [];
}

// ── Volume candles ──────────────────────────────────────────────────────────

export type VolCandleItem = {
  time: Time;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  prevClose: number | null;
};

export function toVolCandles(raw: OHLC[]): VolCandleItem[] {
  return raw.map((r, i) => ({
    time: r.time,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume ?? 0,
    prevClose: i > 0 ? raw[i - 1].close : null,
  }));
}

/** TV's Volume Candles: standard OHLC candles whose BODY WIDTH scales with the
 *  bar's volume relative to the series max — the busiest bar fills the bar
 *  slot, quiet bars shrink toward a sliver. Wick + colours as normal candles. */
export class VolCandlePaneView implements ICustomSeriesPaneView<Time, VolCandleItem, CustomSeriesOptions> {
  private data: PaneRendererCustomData<Time, VolCandleItem> | null = null;
  constructor(private tokens: ChartTokens) {}
  priceValueBuilder(item: VolCandleItem): CustomSeriesPricePlotValues {
    return [item.low, item.high, item.close];
  }
  isWhitespace(d: VolCandleItem | { time: Time }): d is { time: Time } {
    return !("close" in d);
  }
  renderer(): ICustomSeriesPaneRenderer {
    return {
      draw: (target: DrawTarget, ptc: PriceToCoordinateConverter) => {
        const data = this.data;
        if (!data || !data.bars.length) return;
        withMedia(target, ({ context: ctx }) => {
          let maxVol = 0;
          for (const bar of data.bars) maxVol = Math.max(maxVol, bar.originalData.volume);
          // Full slot minus a 1px gap on either side; min keeps thin-volume
          // bars visible.
          const maxHalf = Math.max(1, data.barSpacing / 2 - 1);
          const st = this.tokens.styles.volCandles;
          for (const bar of data.bars) {
            const d = bar.originalData;
            // "Color bars based on previous close": direction vs the previous
            // bar's close instead of the bar's own open.
            const up = st.prevClose && d.prevClose != null ? d.close >= d.prevClose : d.close >= d.open;
            const yH = ptc(d.high);
            const yL = ptc(d.low);
            const yO = ptc(d.open);
            const yC = ptc(d.close);
            if (yH == null || yL == null || yO == null || yC == null) continue;
            if (st.wick) {
              ctx.strokeStyle = up ? st.wickUp : st.wickDown;
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.moveTo(bar.x, yH);
              ctx.lineTo(bar.x, yL);
              ctx.stroke();
            }
            // Body — half-width proportional to the bar's share of max volume.
            const ratio = maxVol > 0 ? d.volume / maxVol : 1;
            const half = Math.max(0.8, maxHalf * ratio);
            const top = Math.min(yO, yC);
            const h = Math.max(1, Math.abs(yC - yO));
            if (st.body) {
              ctx.fillStyle = up ? st.bodyUp : st.bodyDown;
              ctx.fillRect(bar.x - half, top, half * 2, h);
            }
            if (st.border) {
              ctx.strokeStyle = up ? st.borderUp : st.borderDown;
              ctx.lineWidth = 1;
              ctx.strokeRect(bar.x - half + 0.5, top + 0.5, Math.max(0, half * 2 - 1), Math.max(0, h - 1));
            }
          }
        });
      },
      update: (data: PaneRendererCustomData<Time, VolCandleItem>) => {
        this.data = data;
      },
    } as ICustomSeriesPaneRenderer & { update: (d: PaneRendererCustomData<Time, VolCandleItem>) => void };
  }
  update(data: PaneRendererCustomData<Time, VolCandleItem>): void {
    this.data = data;
  }
  defaultOptions(): CustomSeriesOptions {
    return customSeriesDefaultOptions;
  }
}

// ── Hi-Lo ───────────────────────────────────────────────────────────────────

export type HiLoItem = {
  time: Time;
  high: number;
  low: number;
  close: number;
};

export function toHiLo(raw: OHLC[]): HiLoItem[] {
  return raw.map((r) => ({ time: r.time, high: r.high, low: r.low, close: r.close }));
}

/** TV's High-Low (module 364399 SeriesHiLoPaneView): a candle whose body
 *  spans high to low, width 0.4 x bar spacing, body / border in the style
 *  colours (no direction colouring, no close tick), and the high / low
 *  values printed above / below once the bar spacing exceeds 5 px; font
 *  size = the largest 7-36 px that fits the bar spacing - 2 (shown from
 *  8 px), padding 0.4 x font size. */
export class HiLoPaneView implements ICustomSeriesPaneView<Time, HiLoItem, CustomSeriesOptions> {
  private data: PaneRendererCustomData<Time, HiLoItem> | null = null;
  constructor(private tokens: ChartTokens, private format: (p: number) => string = (p) => p.toFixed(2)) {}
  priceValueBuilder(item: HiLoItem): CustomSeriesPricePlotValues {
    return [item.low, item.high, item.close];
  }
  isWhitespace(d: HiLoItem | { time: Time }): d is { time: Time } {
    return !("close" in d);
  }
  renderer(): ICustomSeriesPaneRenderer {
    return {
      draw: (target: DrawTarget, ptc: PriceToCoordinateConverter) => {
        const data = this.data;
        if (!data || !data.bars.length) return;
        const st = this.tokens.styles.hilo;
        const family = this.tokens.fontFamily;
        withMedia(target, ({ context: ctx }) => {
          const w = Math.max(1, Math.round(0.4 * data.barSpacing));
          let fontSize = 0;
          if (st.labels && data.barSpacing > 5) {
            let longest = "";
            for (const bar of data.bars) {
              for (const v of [bar.originalData.high, bar.originalData.low]) {
                const t = this.format(v).replace(/[0-9]/g, "0");
                if (t.length > longest.length) longest = t;
              }
            }
            const room = Math.floor(data.barSpacing) - 2;
            for (let f = 36; f >= 7; f--) {
              ctx.font = f + "px " + family;
              if (ctx.measureText(longest).width <= room) { fontSize = f; break; }
            }
          }
          for (const bar of data.bars) {
            const d = bar.originalData;
            const yH = ptc(d.high);
            const yL = ptc(d.low);
            if (yH == null || yL == null) continue;
            const top = Math.round(Math.min(yH, yL));
            const bottom = Math.round(Math.max(yH, yL));
            const left = Math.round(bar.x - w / 2);
            if (st.body) {
              ctx.fillStyle = st.bodyColor;
              ctx.fillRect(left, top, w, Math.max(1, bottom - top));
            }
            if (st.border) {
              ctx.strokeStyle = st.borderColor;
              ctx.lineWidth = 1;
              ctx.strokeRect(left + 0.5, top + 0.5, Math.max(0, w - 1), Math.max(0, bottom - top - 1));
            }
            if (fontSize >= 8) {
              ctx.font = fontSize + "px " + family;
              ctx.fillStyle = st.labelColor;
              ctx.textAlign = "center";
              const pad = 0.4 * fontSize;
              ctx.textBaseline = "alphabetic";
              ctx.fillText(this.format(d.high), Math.round(bar.x), top - pad);
              ctx.textBaseline = "top";
              ctx.fillText(this.format(d.low), Math.round(bar.x), bottom + pad);
            }
          }
        });
      },
      update: (data: PaneRendererCustomData<Time, HiLoItem>) => {
        this.data = data;
      },
    } as ICustomSeriesPaneRenderer & { update: (d: PaneRendererCustomData<Time, HiLoItem>) => void };
  }
  update(data: PaneRendererCustomData<Time, HiLoItem>): void {
    this.data = data;
  }
  defaultOptions(): CustomSeriesOptions {
    return customSeriesDefaultOptions;
  }
}
