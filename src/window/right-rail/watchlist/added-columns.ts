/*
 * Columns added from "Add column" (not in the reference watchlist): their header and long title, the field a metric
 * column reads from the screener's market table, and a row's cell (formatted as the Screener and the Script Screener
 * show the same value) and sort value.
 */
import type { AddedColumnKey, WlAddedColumn } from "../../../data/watchlist";
import { COLUMN_BY_ID, fieldOf, fullParams, optionOf, type ColumnDef } from "../../../data/screener-catalog";
import { displayCell } from "../../../data/screener-display";
import { DASH } from "../../../data/screener-format";
import { metricCurrencyOf, metricValueOf } from "../../../data/watchlist-metrics";
import { scriptColumnValueOf } from "../../../data/watchlist-script-columns";
import { SCRIPT_INTERVALS } from "../../../data/script-screen";
import { numberFormat } from "../../../i18n/format";
import { formatted, translate, translatePlural } from "../../../i18n/translator";

/** A new column key. */
export const newAddedKey = (): AddedColumnKey => `x:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** The picked option of each param with a choice (the Screener's header second line: "30D", "1h"). */
function paramShorts(def: ColumnDef, params: Record<string, string>, long = false): string[] {
  const full = fullParams(def, params);
  return (def.params ?? [])
    .filter((p) => p.options.length > 1)
    .map((p) => optionOf(p, full[p.key]))
    .filter((o) => !!o)
    .map((o) => translate(long ? o!.label : o!.short));
}

/** Header of an added column: the metric's short title and options ("Avg Vol 30D"), the indicator's value and
 *  timeframe ("RSI 15m"). Translated. */
export function addedHeader(c: WlAddedColumn): string {
  if (c.kind === "script") return formatted(c.header);
  const def = COLUMN_BY_ID[c.col.id];
  if (!def) return c.col.id;
  return formatted([translate(def.short), ...paramShorts(def, c.col.params)].join(" "));
}

/** Long title of an added column (menus, tooltips). Translated. */
export function addedTitle(c: WlAddedColumn): string {
  if (c.kind === "script") return formatted(c.title);
  const def = COLUMN_BY_ID[c.col.id];
  if (!def) return c.col.id;
  const opts = paramShorts(def, c.col.params, true);
  return formatted(opts.length ? `${translate(def.title)} (${opts.join(", ")})` : translate(def.title));
}

/** Header and long title of an indicator column, as stored when it is added (English; shown through translate). */
export function scriptColumnNames(indicator: string, shortName: string, output: { title: string }, outputs: number, interval: string): { header: string; title: string } {
  const tf = SCRIPT_INTERVALS.find((i) => i.id === interval);
  const value = outputs > 1 ? output.title : "";
  return {
    header: [shortName, value, tf?.short ?? interval].filter(Boolean).join(" "),
    title: `${indicator}${value ? ` · ${value}` : ""} (${tf?.label ?? interval})`,
  };
}

/** Field of a metric column in the screener's market table. */
export function metricFieldOf(c: WlAddedColumn): string | null {
  return c.kind === "metric" ? fieldOf(c.col) : null;
}

const numberFmt = () => numberFormat({ minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Header font of the watchlist's columns. */
const HEADER_FONT = '14px -apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif';
let measureCtx: CanvasRenderingContext2D | null = null;
/** Starting width of an added column (until the user drags it): its header on one line, with the sort arrow. */
export function addedWidth(header: string, min: number, max: number): number {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return min;
  measureCtx.font = HEADER_FONT;
  return Math.min(max, Math.max(min, Math.ceil(measureCtx.measureText(header).width) + 18 + 8));
}

/** A row's cell of an added column. */
export function addedCell(c: WlAddedColumn, symbol: string): { text: string; tint?: "up" | "down" } {
  if (c.kind === "script") {
    const v = scriptColumnValueOf(c.key, symbol);
    if (v === null || v === undefined || !Number.isFinite(v)) return { text: DASH };
    // A condition: how many bars ago it last happened, as in the Script Screener.
    if (c.output.startsWith("cond:")) return { text: v === 0 ? translate("Last bar") : translatePlural(v, { one: "{0} bar ago", other: "{0} bars ago" }) };
    return { text: numberFmt().format(v) };
  }
  const field = metricFieldOf(c);
  const v = field ? metricValueOf(field, symbol) : undefined;
  if (v === undefined) return { text: DASH };
  const cell = displayCell(COLUMN_BY_ID[c.col.id], v, metricCurrencyOf(symbol));
  return { text: cell.text, tint: cell.tone };
}

/** A row's sort value of an added column (undefined: no value, sorted last). */
export function addedSortValue(c: WlAddedColumn, symbol: string): number | string | undefined {
  if (c.kind === "script") return scriptColumnValueOf(c.key, symbol) ?? undefined;
  const field = metricFieldOf(c);
  return field ? metricValueOf(field, symbol) : undefined;
}
