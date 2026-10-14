/*
 * Chart snapshot image (Take a snapshot: Download image, Copy image, Open in
 * new tab): every chart of the shown layout in one image, composed as the
 * reference app does:
 *   - background = the app theme's primary background,
 *   - header line "Created with OpenTrader, <date time UTC±h>" at the 10 px
 *     padding (12 px chart font, primary text colour, 1.4 line height),
 *   - the charts placed by the layout: right of their left neighbours and
 *     under their top neighbours with 5 px between charts, 10 px padding,
 *   - on each chart its legend (pane top + 10, plot left + 8, one 17 px line
 *     per source: title in the scale text colour, values in their colours,
 *     two spaces between items, "..." when the line does not fit) and a 1 px
 *     border,
 *   - a 60 px footer with the wordmark (where the reference has its logo).
 * A maximized chart is alone in the image (the hidden charts take no part).
 */

/** One piece of a legend line; no colour = the chart's text colour. */
export type LegendRun = { text: string; color?: string };

/** A legend value: title (O, H, Vol... or empty) and its coloured value. */
export type LegendValue = { title: string; value: string; color?: string };

export type ChartSnapshot = {
  /** The chart on screen (placement in the layout). */
  rect: DOMRect;
  /** Panes + axes + time axis, in device pixels. */
  canvas: HTMLCanvasElement;
  /** Device pixel ratio of `canvas`. */
  dpr: number;
  /** Scale text colour (legend titles). */
  textColor: string;
  fontFamily: string;
  /** Panes, CSS px from the chart's top-left: plot left (the left scale's
   *  width), plot width, top, height and the legend lines. */
  panes: { left: number; width: number; top: number; height: number; lines: LegendRun[][] }[];
};

const PADDING = 10;
const CHARTS_SPACING = 5;
const FOOTER_HEIGHT = 60;
const LEGEND_TOP = 10;
const LEGEND_LEFT = 8;
const FONT_SIZE = 12;
const LINE_SPACING = 1.4;

/** Charts that can be drawn into a snapshot, by their root element. */
const sources = new Map<HTMLElement, () => Promise<ChartSnapshot | null>>();

/** A chart offers its picture to the layout snapshot (returns the unregister). */
export function registerSnapshotSource(el: HTMLElement, take: () => Promise<ChartSnapshot | null>): () => void {
  sources.set(el, take);
  return () => {
    if (sources.get(el) === take) sources.delete(el);
  };
}

/** Legend line of a source: its title, then each value (title + value), two
 *  spaces between items. */
export function legendLine(title: string, values: LegendValue[]): LegendRun[] {
  const out: LegendRun[] = [{ text: title.trim() }];
  for (const v of values) {
    if (out[out.length - 1].text !== "") out.push({ text: "  " });
    if (v.title) out.push({ text: v.title });
    out.push({ text: v.value, color: v.color });
  }
  return out;
}

/** "Oct 14, 2026 14:38 UTC-4" in `timeZone`. */
export function snapshotDate(now: Date, timeZone?: string): string {
  const fmt = (o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-US", { ...(timeZone ? { timeZone } : {}), ...o }).formatToParts(now);
  const get = (parts: Intl.DateTimeFormatPart[], t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "";
  const d = fmt({ month: "short", day: "2-digit", year: "numeric" });
  const t = fmt({ hour12: false, hour: "2-digit", minute: "2-digit", timeZoneName: "shortOffset" });
  let hh = get(t, "hour");
  if (hh === "24") hh = "00";
  const offset = get(t, "timeZoneName").replace(/^GMT/, "UTC");
  return `${get(d, "month")} ${get(d, "day")}, ${get(d, "year")} ${hh}:${get(t, "minute")} ${offset === "UTC" ? "UTC" : offset}`;
}

/** Draw one legend line from `x` (device px), cut with "..." past `maxRight`. */
function drawLine(ctx: CanvasRenderingContext2D, runs: LegendRun[], x: number, y: number, maxRight: number, defaultColor: string): void {
  const full = runs.map((r) => r.text).join("");
  let text = full;
  let elided = false;
  if (ctx.measureText(full).width > maxRight - x) {
    const dots = ctx.measureText("...").width;
    let n = 0;
    while (n < full.length && ctx.measureText(full.slice(0, n + 1)).width + dots <= maxRight - x) n++;
    text = full.slice(0, n).trim();
    elided = true;
  }
  let used = 0;
  for (const r of runs) {
    if (used + r.text.length > text.length) {
      // The cut run: its part that fits.
      const part = text.slice(used);
      if (part) {
        ctx.fillStyle = r.color ?? defaultColor;
        ctx.fillText(part, x, y);
        x += ctx.measureText(part).width;
      }
      break;
    }
    ctx.fillStyle = r.color ?? defaultColor;
    ctx.fillText(r.text, x, y);
    x += ctx.measureText(r.text).width;
    used += r.text.length;
  }
  if (elided) {
    ctx.fillStyle = defaultColor;
    ctx.fillText("...", x, y);
  }
}

/** Device-px placement of each chart: x = after the right-most chart left of
 *  it (sharing rows with it) + spacing, y = under the lowest chart above it
 *  (sharing columns) + spacing. */
function place(shots: ChartSnapshot[], dpr: number): { x: number; y: number }[] {
  const pad = Math.round(PADDING * dpr);
  const gap = Math.round(CHARTS_SPACING * dpr);
  const pos = shots.map(() => ({ x: pad, y: pad }));
  const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0) > 1;
  const byLeft = shots.map((_, i) => i).sort((a, b) => shots[a].rect.left - shots[b].rect.left);
  for (const i of byLeft) {
    const r = shots[i].rect;
    for (const j of byLeft) {
      const o = shots[j].rect;
      if (j === i || o.right > r.left + 1 || !overlap(r.top, r.bottom, o.top, o.bottom)) continue;
      pos[i].x = Math.max(pos[i].x, pos[j].x + shots[j].canvas.width + gap);
    }
  }
  const byTop = shots.map((_, i) => i).sort((a, b) => shots[a].rect.top - shots[b].rect.top);
  for (const i of byTop) {
    const r = shots[i].rect;
    for (const j of byTop) {
      const o = shots[j].rect;
      if (j === i || o.bottom > r.top + 1 || !overlap(r.left, r.right, o.left, o.right)) continue;
      pos[i].y = Math.max(pos[i].y, pos[j].y + shots[j].canvas.height + gap);
    }
  }
  return pos;
}

export type SnapshotTheme = {
  /** Image background (app theme primary background). */
  background: string;
  /** Chart borders. */
  border: string;
  /** Header text and wordmark. */
  text: string;
};

/** Theme colours of the image: dark #1F1F1F / #3D3D3D / #DBDBDB, light
 *  #FFFFFF / #EBEBEB / #0F0F0F. */
export const snapshotTheme = (theme: "dark" | "light"): SnapshotTheme =>
  theme === "light"
    ? { background: "#FFFFFF", border: "#EBEBEB", text: "#0F0F0F" }
    : { background: "#1F1F1F", border: "#3D3D3D", text: "#DBDBDB" };

/** The image of the charts shown in `grid` (null when none is drawn). */
export async function layoutSnapshot(grid: HTMLElement, theme: SnapshotTheme, timeZone?: string): Promise<HTMLCanvasElement | null> {
  const shots: ChartSnapshot[] = [];
  for (const [el, take] of sources) {
    if (!grid.contains(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const s = await take();
    if (s && s.canvas.width > 0 && s.canvas.height > 0) shots.push(s);
  }
  if (shots.length === 0) return null;
  const dpr = shots[0].dpr;
  const font = shots[0].fontFamily;
  const pos = place(shots, dpr);
  const lineH = Math.ceil(FONT_SIZE * LINE_SPACING * dpr);
  const header = [`Created with OpenTrader, ${snapshotDate(new Date(), timeZone)}`];
  const headerH = lineH * header.length;
  let w = 0;
  let h = 0;
  shots.forEach((s, i) => {
    w = Math.max(w, pos[i].x + s.canvas.width);
    h = Math.max(h, pos[i].y + s.canvas.height);
  });
  const pad = Math.round(PADDING * dpr);
  const footer = Math.round(FOOTER_HEIGHT * dpr);
  const out = document.createElement("canvas");
  out.width = w + pad;
  out.height = headerH + h + footer;
  const ctx = out.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.textBaseline = "top";
  ctx.font = `${FONT_SIZE * dpr}px ${font}`;
  header.forEach((line, i) => drawLine(ctx, [{ text: line }], pad, pad + i * lineH, out.width, theme.text));
  shots.forEach((s, i) => {
    ctx.save();
    ctx.translate(pos[i].x, headerH + pos[i].y);
    ctx.drawImage(s.canvas, 0, 0);
    ctx.font = `${FONT_SIZE * dpr}px ${font}`;
    ctx.textBaseline = "top";
    for (const p of s.panes) {
      const top = Math.round(p.top * dpr);
      const bottom = top + Math.round(p.height * dpr);
      const x = Math.round((p.left + LEGEND_LEFT) * dpr);
      let y = top + Math.round(LEGEND_TOP * dpr);
      for (const line of p.lines) {
        if (y + lineH >= bottom) break;
        drawLine(ctx, line, x, y, Math.round(p.width * dpr), s.textColor);
        y += lineH;
      }
    }
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, s.canvas.width, s.canvas.height);
    ctx.restore();
  });
  // Footer: the wordmark, vertically centred.
  ctx.fillStyle = theme.text;
  ctx.textBaseline = "middle";
  ctx.font = `600 ${20 * dpr}px ${font}`;
  ctx.fillText("OpenTrader", pad, headerH + h + Math.round(footer / 2));
  return out;
}
