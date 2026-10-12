/*
 * The chart context studies see: the oakscriptjs ChartContext of OakScript
 * scripts, which is also the optional third argument of the library
 * indicators' calculate(). Chart timeframe (timeframe.period), exchange time
 * zone and session of the bars (time(tf, session), session.*, calendar,
 * timeframe.change...), tickerid, symbol type and currency, price grid and
 * the chart colours. Time zone, sessions and price grid are the charted
 * symbol's own (data/session), type and currency come from its reference
 * data; until they resolve the study gets the library defaults. Reactive:
 * read inside an effect, the context updates once they arrive.
 */
import { createSignal } from "solid-js";
import type { ChartContext } from "oakscriptjs/script";
import { textOnColor } from "lightweight-charts-drawing/core/color";
import { DEFAULT_SYMBOL } from "../../../backtester/types";
import { getTickerInfo } from "../../../data/datafeed";
import { cachedSymbolSessions, type SessionId } from "../../../data/session";

/** `backgroundColor`: the chart background (script `chart.bg_color`). */
export type StudyChart = ChartContext & { backgroundColor?: string };

/** Chart background, top and bottom colours (the same colour without a gradient). */
export type StudyChartBackground = { top: string; bottom: string };

type SymbolDetails = { symbolType?: string; currency?: string };
const details = new Map<string, SymbolDetails | null>();
const [detailsVersion, setDetailsVersion] = createSignal(0);

/** Symbol type (`syminfo.type`) and currency (`syminfo.currency`) of a symbol from its reference data; null until
 *  they arrive (the lookup starts on the first call). Reactive. */
export function symbolDetails(symbol: string): SymbolDetails | null {
  detailsVersion();
  const key = symbol.trim().toUpperCase();
  if (!key) return null;
  if (!details.has(key)) {
    details.set(key, null);
    getTickerInfo(key)
      .then((info) => details.set(key, { symbolType: info.symbolType ?? undefined, currency: info.currency ?? undefined }))
      .catch(() => details.set(key, {}))
      .finally(() => setDetailsVersion((v) => v + 1));
  }
  return details.get(key) ?? null;
}

/** RGBA channels of a hex (#rgb, #rrggbb, #rrggbbaa) or rgb() / rgba() colour; null when not read. */
function rgba(color: string): [number, number, number, number] | null {
  const c = color.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(c);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split("").map((x) => x + x).join("") : hex[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
  }
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/i.exec(c);
  return m ? [+m[1], +m[2], +m[3], m[4] !== undefined ? +m[4] : 1] : null;
}

/**
 * Chart colours of the studies, by the reference app's rules: the background (`chart.bg_color`) is the chart
 * background half-way down (the middle of a gradient, channels rounded, `rgba(r, g, b, a)`; a solid background as
 * set, an opaque one as #RRGGBB); the foreground (`chart.fg_color`) is #DBDBDB on a dark chart and #0F0F0F on a light one, a dark chart being
 * one whose (bottom) background has a grey value 0.199·R + 0.687·G + 0.114·B below 150.
 */
export function studyChartColors(bg: StudyChartBackground): { backgroundColor: string; foregroundColor: string } {
  let backgroundColor = bg.top;
  const solid = rgba(bg.top);
  // An opaque colour as a hex, as the reference app's default background (#0F0F0F).
  if (solid && solid[3] === 1) backgroundColor = "#" + solid.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase();
  if (bg.top !== bg.bottom) {
    const a = rgba(bg.top);
    const b = rgba(bg.bottom);
    if (a && b) {
      const mid = a.map((v, i) => (v + b[i]) / 2);
      backgroundColor = `rgba(${Math.round(mid[0])}, ${Math.round(mid[1])}, ${Math.round(mid[2])}, ${mid[3]})`;
    }
  }
  const dark = textOnColor(bg.bottom) === "#ffffff";
  return { backgroundColor, foregroundColor: dark ? "#DBDBDB" : "#0F0F0F" };
}

export function scriptChartContext(
  symbol: string | undefined,
  interval: string | undefined,
  session: SessionId | string | undefined,
  background?: StudyChartBackground,
): StudyChart {
  const extended = session === "ETH";
  const ctx: StudyChart = {
    timeframe: interval ?? "1D",
    tickerid: symbol || undefined,
    sessionType: extended ? "extended" : "regular",
    // Whole shares, one currency unit per point: every symbol the data serves is a US-listed security (the
    // reference app gives point value 1 to its stocks, funds, receipts and warrants).
    pointvalue: DEFAULT_SYMBOL.pointValue,
    mincontract: DEFAULT_SYMBOL.qtyStep,
  };
  if (background) Object.assign(ctx, studyChartColors(background));
  const sessions = symbol ? cachedSymbolSessions(symbol) : null;
  if (sessions) {
    ctx.timezone = sessions.timeZone;
    ctx.session = extended ? sessions.extendedSpec : sessions.regularSpec;
    ctx.regularSession = sessions.regularSpec;
    ctx.mintick = sessions.mintick;
    ctx.minmove = sessions.minmove;
    ctx.pricescale = sessions.pricescale;
  }
  const info = symbol ? symbolDetails(symbol) : null;
  if (info?.symbolType) ctx.symbolType = info.symbolType;
  if (info?.currency) ctx.currency = info.currency;
  return ctx;
}
