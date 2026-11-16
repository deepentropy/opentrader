/*
 * An embedded chart (#338) or widget (#339) and the page around it.
 *
 * Out: `ready` once it is up, then for the chart `symbol` and `interval` on
 * each change, for a widget `symbol-click` (the loader turns them into the
 * element's ot-* events). In: `config`, the settings changed in place (the
 * chart's symbol, interval, chart type; any embed's theme). Only
 * messages from the parent window are read; what goes out is the chart's
 * symbol and interval, sent to whichever page holds it.
 */
import { createEffect, on, type Accessor } from "solid-js";
import type { EmbedConfig } from "./config";
import { parseEmbedConfig } from "./config";
import { emitAppEvent } from "../data/app-events";
import type { AppEvents } from "../data/app-events";
import { watchlistStore, newRow } from "../data/watchlist-store";
import { CHART_TYPE_IDS, type ChartTypeId } from "../window/chart/chart-types";
import type { ThemeSetting } from "../window/shell/app-theme";

/** Messages of the chart, and of the page (public/embed.js). */
export const FROM_CHART = "opentrader-embed";
export const FROM_PAGE = "opentrader-embed-host";

export type EmbedHostDeps = {
  symbol: Accessor<string>;
  interval: Accessor<string>;
  setSymbol: (full: string) => void;
  setInterval: (id: string) => void;
  setChartType: (id: ChartTypeId) => void;
  setTheme: (t: ThemeSetting) => void;
};

/** A message to the page around the embed. */
export function postToPage(type: string, data: Record<string, unknown> = {}): void {
  if (window.parent === window) return;
  window.parent.postMessage({ source: FROM_CHART, type, ...data }, "*");
}

/** The embed's watchlist (right panel): a list of its symbols, shown. */
export function seedEmbedWatchlist(c: EmbedConfig): void {
  if (!c.watchlist.length) return;
  const id = watchlistStore.createList("Watchlist");
  // The app's starting lists are not the site's: only its own is kept.
  for (const l of watchlistStore.lists()) if (l.id !== id) watchlistStore.deleteList(l.id);
  watchlistStore.renameList(id, "Watchlist");
  watchlistStore.addSymbols(c.watchlist.map(newRow), null);
}

/** Frames the embed's first date range once the chart has its bars (the chart
 *  frames a range when it hears of it before or after the bars land, but must
 *  be listening). Gives up after 30 s. */
function frameFirstRange(range: string): () => void {
  const started = Date.now();
  const timer = window.setInterval(() => {
    const q: AppEvents["chart-view-query"] = { ranges: {} };
    emitAppEvent("chart-view-query", q);
    if (q.ranges[0] || Date.now() - started > 30_000) {
      window.clearInterval(timer);
      if (q.ranges[0]) emitAppEvent("chart-set-range", { span: range });
    }
  }, 200);
  return () => window.clearInterval(timer);
}

/** Wires the chart to its page; returns the cleanup. */
export function installEmbedHost(c: EmbedConfig, deps: EmbedHostDeps): () => void {
  // A pane edit re-runs these with the same values: only a change is told.
  let symbol = deps.symbol();
  let interval = deps.interval();
  createEffect(on(deps.symbol, (s) => s !== symbol && postToPage("symbol", { symbol: (symbol = s) }), { defer: true }));
  createEffect(on(deps.interval, (i) => i !== interval && postToPage("interval", { interval: (interval = i) }), { defer: true }));

  const onMessage = (e: MessageEvent) => {
    if (e.source !== window.parent || !e.data || e.data.source !== FROM_PAGE || e.data.type !== "config") return;
    const raw = e.data.config;
    if (!raw || typeof raw !== "object") return;
    const next = parseEmbedConfig({ ...c, ...raw });
    if ("symbol" in raw && next.symbol !== deps.symbol()) deps.setSymbol(next.symbol);
    if ("interval" in raw && next.interval !== deps.interval()) deps.setInterval(next.interval);
    if ("chartType" in raw && next.chartType && CHART_TYPE_IDS.has(next.chartType as ChartTypeId)) deps.setChartType(next.chartType as ChartTypeId);
    if ("theme" in raw) deps.setTheme(next.theme ?? "system");
  };
  window.addEventListener("message", onMessage);
  const stopRange = c.range ? frameFirstRange(c.range) : () => {};
  postToPage("ready", { symbol, interval });
  return () => {
    window.removeEventListener("message", onMessage);
    stopRange();
  };
}

/** Wires a widget to its page: `ready`, and the theme changed in place. */
export function installWidgetHost(setTheme: (t: ThemeSetting) => void): () => void {
  const onMessage = (e: MessageEvent) => {
    if (e.source !== window.parent || !e.data || e.data.source !== FROM_PAGE || e.data.type !== "config") return;
    const raw = e.data.config;
    if (raw && typeof raw === "object" && "theme" in raw) setTheme(raw.theme === "light" || raw.theme === "dark" ? raw.theme : "system");
  };
  window.addEventListener("message", onMessage);
  postToPage("ready");
  return () => window.removeEventListener("message", onMessage);
}

/** The chart in a window of its own (the popup button): the same settings, at
 *  the symbol and interval shown, without the popup button. */
export function openEmbedPopup(c: EmbedConfig, symbol: string, interval: string): void {
  const settings = { ...c, symbol, interval, range: undefined, popupButton: false };
  const url = `${location.origin}${location.pathname}?view=embed#${encodeURIComponent(JSON.stringify(settings))}`;
  const left = Math.max(0, (screen.width - c.popupWidth) / 2);
  const top = Math.max(0, (screen.height - c.popupHeight) / 2);
  window.open(url, "_blank", `popup,width=${c.popupWidth},height=${c.popupHeight},left=${left},top=${top}`);
}
