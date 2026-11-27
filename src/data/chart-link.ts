/*
 * Chart links (#350). The web version opened on `/chart/?symbol=NASDAQ:ARRY&interval=60` shows that symbol and
 * interval on the charts of its tab; the desktop app opens `opentrader://chart?symbol=…&interval=…`, and a web chart
 * link pasted in "Open link from clipboard", in a new tab (the reference app opens a link in a new tab). The tab
 * menu's "Copy link" gives the web link of the tab's chart. A link may also add one of the app's strategies with its
 * inputs (`&study=strategy:<key>&inputs={…}`): a backtest post of the community opens so.
 */
import { parseInterval } from "./interval";

export type ChartLink = { symbol: string; interval?: string; study?: string; inputs?: Record<string, number | string | boolean> };

/** The public web version: the links the desktop app copies open there. */
export const WEB_APP_URL = "https://demo.opentrader.markets";

const WEB = import.meta.env.MODE === "web";

/** The site a copied link points to: the web version itself, or the public one from the desktop app. */
export function chartLinkSite(): string {
  return WEB && typeof location !== "undefined" ? location.origin : WEB_APP_URL;
}

/** One symbol: a ticker, or "EXCHANGE:TICKER". */
const SYMBOL = /^[^\s,:]+(?::[^\s,:]+)?$/;

/** The app's id of a link's interval ("D" → "1D", "1H" → "60", "15" as is); undefined when it is not one. */
export function linkInterval(raw: string | null | undefined): string | undefined {
  const iv = raw ? parseInterval(raw) : null;
  if (!iv) return undefined;
  switch (iv.unit) {
    case "second":
      return `${iv.count}S`;
    case "minute":
      return `${iv.count}`;
    case "hour":
      return `${iv.count * 60}`;
    case "day":
      return `${iv.count}D`;
    case "week":
      return `${iv.count}W`;
    case "month":
      return `${iv.count}M`;
  }
}

/** A study a link may add: one of the app's own strategies (never a script from the link). */
const STUDY = /^strategy:[a-z0-9-]{1,64}$/;

/** A link's inputs: input id or title → number, text or switch; anything else drops them all. */
function linkInputs(raw: string | null): ChartLink["inputs"] | undefined {
  if (!raw || raw.length > 2000) return undefined;
  try {
    const o = JSON.parse(raw) as unknown;
    if (!o || typeof o !== "object" || Array.isArray(o)) return undefined;
    const entries = Object.entries(o);
    const value = (v: unknown) => typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.length <= 200);
    return entries.length <= 30 && entries.every(([k, v]) => k.length > 0 && k.length <= 64 && value(v)) ? (o as ChartLink["inputs"]) : undefined;
  } catch {
    return undefined;
  }
}

/** The chart link of an address's query (`?symbol=…&interval=…&study=…&inputs=…`); null without a symbol. */
export function chartLinkOf(search: string | URLSearchParams): ChartLink | null {
  const q = typeof search === "string" ? new URLSearchParams(search) : search;
  const symbol = q.get("symbol")?.trim().toUpperCase() ?? "";
  if (!symbol || symbol.length > 64 || !SYMBOL.test(symbol)) return null;
  const link: ChartLink = { symbol };
  const interval = linkInterval(q.get("interval"));
  if (interval) link.interval = interval;
  const study = q.get("study") ?? "";
  if (STUDY.test(study)) {
    link.study = study;
    const inputs = linkInputs(q.get("inputs"));
    if (inputs) link.inputs = inputs;
  }
  return link;
}

/** The chart link of a link the app opens: `opentrader://chart?…`, or a chart page of the web version
 *  (`<site>/chart/?…` or `<site>/?symbol=…`); null for anything else. */
export function chartLinkOfUrl(text: string, sites: readonly string[] = [chartLinkSite()]): ChartLink | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol === "opentrader:") {
    if (url.host.toLowerCase() !== "chart" || !["", "/"].includes(url.pathname)) return null;
  } else if (!sites.some((s) => s.toLowerCase() === url.origin.toLowerCase()) || !["/", "/chart", "/chart/"].includes(url.pathname)) {
    return null;
  }
  return chartLinkOf(url.searchParams);
}

/** The web link of a chart: `<site>/chart/?symbol=NASDAQ:ARRY&interval=60` (the colon kept readable). */
export function chartLinkUrl(link: ChartLink, site: string = chartLinkSite()): string {
  const part = (v: string) => encodeURIComponent(v).replace(/%3A/gi, ":");
  return `${site}/chart/?symbol=${part(link.symbol)}${link.interval ? `&interval=${part(link.interval)}` : ""}`;
}
