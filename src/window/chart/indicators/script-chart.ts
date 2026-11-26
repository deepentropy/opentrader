/*
 * The chart context studies see: the oakscriptjs ChartContext of OakScript
 * scripts, which is also the optional third argument of the library
 * indicators' calculate(). Chart timeframe (timeframe.period), exchange time
 * zone and session of the bars (time(tf, session), session.*, calendar,
 * timeframe.change...), tickerid, the symbol's fields (syminfo.*: type,
 * currency, description, sector...), price grid and the chart colours. Time
 * zone, sessions and price grid are the charted symbol's own (data/session),
 * the other fields come from its reference data; until they resolve the
 * study gets the library defaults. Reactive:
 * read inside an effect, the context updates once they arrive.
 */
import { createSignal } from "solid-js";
import { TradingCalendar } from "oakscriptjs";
import type { ChartContext, SymbolInfo } from "oakscriptjs/script";
import { textOnColor } from "lightweight-charts-drawing/core/color";
import { DEFAULT_SYMBOL } from "../../../backtester/types";
import { getTickerInfo, isLocalSymbol, type TickerInfo } from "../../../data/datafeed";
import { cachedSymbolSessions, type SessionId, type SymbolSessions } from "../../../data/session";
import { titleCase } from "../../../data/title-case";

/** `backgroundColor`: the chart background (script `chart.bg_color`). */
export type StudyChart = ChartContext & { backgroundColor?: string };

/** Chart background, top and bottom colours (the same colour without a gradient). */
export type StudyChartBackground = { top: string; bottom: string };

/** A symbol's reference data; empty when it could not be read. */
type SymbolDetails = Partial<TickerInfo>;
const details = new Map<string, SymbolDetails | null>();
const lookups = new Map<string, Promise<unknown>>();
const [detailsVersion, setDetailsVersion] = createSignal(0);

/** Reference data of a symbol (type, currency, name, sector... read by `syminfo.*`); null until it arrives (the
 *  lookup starts on the first call). Reactive. */
export function symbolDetails(symbol: string): SymbolDetails | null {
  detailsVersion();
  const key = symbol.trim().toUpperCase();
  if (!key) return null;
  if (!details.has(key)) {
    details.set(key, null);
    lookups.set(
      key,
      getTickerInfo(key)
        .then((info) => details.set(key, info))
        .catch(() => details.set(key, {}))
        .finally(() => setDetailsVersion((v) => v + 1)),
    );
  }
  return details.get(key) ?? null;
}

/** Resolves once the reference data of `symbol` has arrived (or could not be read). */
export function symbolDetailsLoaded(symbol: string): Promise<void> {
  const key = symbol.trim().toUpperCase();
  symbolDetails(key);
  return (lookups.get(key) ?? Promise.resolve()).then(() => undefined);
}

/** Types whose symbols are companies (sector, ISIN, employees, shares...). */
const COMPANY_TYPES = new Set(["stock", "fund", "dr", "warrant"]);

/** Start of the last trading day (`YYYY-MM-DD`) of a future's contract in ms, as `syminfo.expiration_date` gives it:
 *  the open of that day's session (the evening before for an overnight session), else 00:00 UTC of the day. */
function expirationTime(day: string, sessions: SymbolSessions): number {
  const date = Number(day.replace(/-/g, ""));
  const open = new TradingCalendar(sessions.timeZone, sessions.regularScript).periods(date)[0]?.[0];
  return open ?? Date.parse(day);
}

/**
 * What scripts read of a symbol (`syminfo.*`) beyond its sessions and tick, from its reference data: a value; null
 * when the symbol has none (the script reads na, as the reference gives a stock's base currency or an index's
 * sector); left out when the app does not know it (reading it stops the script with an error: analysts' figures,
 * a stock's ISIN). Empty until the reference data and the sessions arrive. Reactive.
 */
export function scriptSymbolFields(symbol: string): SymbolInfo {
  const info = symbolDetails(symbol);
  const sessions = symbol ? cachedSymbolSessions(symbol) : null;
  if (!info || !sessions) return {};
  const type = info.symbolType ?? undefined;
  const out: SymbolInfo = { description: info.name ?? null };
  if (type) out.symbolType = type;
  if (info.currency) out.currency = info.currency;
  // An imported series or an economic series: only its name is known.
  if (isLocalSymbol(symbol) || type === "economic") return out;
  const company = type !== undefined && COMPANY_TYPES.has(type);
  const label = (v: string | null | undefined) => (v ? titleCase(v) : null);
  if (!sessions.intervals.length) {
    // The server's symbols: companies and funds listed in the US (the reference gives "n/a" as their volume unit).
    return {
      ...out,
      country: "US",
      volumetype: "n/a",
      basecurrency: null,
      currentContract: null,
      expirationDate: null,
      sector: label(info.sector),
      industry: label(info.industry),
      employees: info.totalEmployees ?? null,
      sharesOutstandingTotal: info.sharesOutstanding ?? null,
    };
  }
  // A data plugin's symbol: what the plugin says; what a symbol of its type has none of is null.
  const ticker = symbol.slice(symbol.indexOf(":") + 1);
  const forexBase = type === "forex" && /^[A-Z]{6}$/.test(ticker) ? ticker.slice(0, 3) : undefined;
  const companyOnly = <T>(v: T | null | undefined): T | null | undefined => v ?? (company ? undefined : null);
  const contract = info.currentContract ?? null;
  const dated = type === "futures" || type === "option";
  const fields: SymbolInfo = {
    ...out,
    country: info.country ?? (type === "crypto" || type === "forex" ? null : undefined),
    basecurrency: info.baseCurrency ?? forexBase ?? (company || type === "index" ? null : undefined),
    currentContract: contract,
    // A continuous future has none; a contract without one from its plugin is not known.
    expirationDate: info.expiration ? expirationTime(info.expiration, sessions) : dated && !contract ? undefined : null,
    isin: companyOnly(info.isin),
    sector: companyOnly(info.sector),
    industry: companyOnly(info.industry),
    employees: companyOnly(info.totalEmployees),
    volumetype: info.volumeType ?? (type === "crypto" ? undefined : "n/a"),
  };
  if (info.root) fields.root = info.root;
  if (!company) Object.assign(fields, NO_COMPANY_FIGURES);
  return fields;
}

/** The figures of a company, none for another symbol. */
const NO_COMPANY_FIGURES: SymbolInfo = {
  shareholders: null,
  sharesOutstandingTotal: null,
  sharesOutstandingFloat: null,
  recommendations: null,
  targetPrice: null,
};

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
    // Whole shares, one currency unit per point until the symbol's sessions say otherwise (the reference app gives
    // point value 1 to its stocks, funds, receipts and warrants; a plugin's future gives its multiplier).
    pointvalue: DEFAULT_SYMBOL.pointValue,
    mincontract: DEFAULT_SYMBOL.qtyStep,
  };
  if (background) Object.assign(ctx, studyChartColors(background));
  const sessions = symbol ? cachedSymbolSessions(symbol) : null;
  if (sessions) {
    ctx.timezone = sessions.timeZone;
    ctx.pointvalue = sessions.pointValue;
    ctx.session = extended ? sessions.extendedScript : sessions.regularScript;
    ctx.regularSession = sessions.regularScript;
    ctx.mintick = sessions.mintick;
    ctx.minmove = sessions.minmove;
    ctx.pricescale = sessions.pricescale;
  }
  if (symbol) Object.assign(ctx, scriptSymbolFields(symbol));
  return ctx;
}
