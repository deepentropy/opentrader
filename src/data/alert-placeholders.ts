/*
 * Alert message placeholders: the "Add placeholder" menu of the message
 * editor, and the text each one gives when the alert fires.
 *
 * - The menu has the groups General, Symbol data and Currency, then Plots
 *   when the alert's source is a study: `{{plot("<title>")}}` once per title,
 *   then `{{plot_<n>}}` per plot (20 plots at most).
 * - A placeholder is `{{name}}` exactly: case counts and no space inside the
 *   braces. A name that is not one of them stays as written.
 * - ticker / exchange: the parts of the alert's symbol; interval: its
 *   interval id ("60", "1D"); time: open time of the bar the alert fired in;
 *   timenow: the time of the fire; both in UTC ("2026-10-14T09:00:00Z").
 * - open / high / low / close / volume: that bar on the alert's interval;
 *   numbers as they are (no rounding, no digit grouping).
 * - plot_<n>: the n-th plot of the alert's study, "null" past its plots or
 *   without a value; plot("<title>"): the plot with that title (a title it
 *   does not have stays as written).
 */

export type PlaceholderItem = { title: string; value: string };
export type PlaceholderGroup = { id: string; title: string; items: PlaceholderItem[] };

/** Plots of a study offered in the menu. */
export const MAX_PLACEHOLDER_PLOTS = 20;

/** Groups of the "Add placeholder" menu. `plots`: the plots of the alert's
 *  source when it is a study (none for the price). */
export function placeholderGroups(plots: readonly { title: string }[] | null): PlaceholderGroup[] {
  const groups: PlaceholderGroup[] = [
    {
      id: "general",
      title: "General",
      items: [
        { title: "Ticker", value: "{{ticker}}" },
        { title: "Exchange", value: "{{exchange}}" },
        { title: "Interval", value: "{{interval}}" },
        { title: "Time", value: "{{time}}" },
        { title: "Timenow", value: "{{timenow}}" },
      ],
    },
    {
      id: "symbol_data",
      title: "Symbol data",
      items: [
        { title: "Open", value: "{{open}}" },
        { title: "Close", value: "{{close}}" },
        { title: "High", value: "{{high}}" },
        { title: "Low", value: "{{low}}" },
        { title: "Volume", value: "{{volume}}" },
      ],
    },
    {
      id: "currency",
      title: "Currency",
      items: [
        { title: "Quote", value: "{{syminfo.currency}}" },
        { title: "Base", value: "{{syminfo.basecurrency}}" },
      ],
    },
  ];
  if (plots?.length) {
    const list = plots.slice(0, MAX_PLACEHOLDER_PLOTS);
    const seen = new Set<string>();
    const titled: PlaceholderItem[] = [];
    for (const p of list) {
      if (!seen.has(p.title)) titled.push({ title: p.title, value: `{{plot("${p.title}")}}` });
      seen.add(p.title);
    }
    groups.push({ id: "plots", title: "Plots", items: [...titled, ...list.map((_, i) => ({ title: `Plot ${i}`, value: `{{plot_${i}}}` }))] });
  }
  return groups;
}

/** A placeholder appended to a message: after a space unless the message is
 *  empty or already ends with a white space. */
export function appendPlaceholder(message: string, value: string): string {
  return message + (/^$|\s$/.test(message) ? "" : " ") + value;
}

export type PlaceholderBar = { open: number; high: number; low: number; close: number; volume: number };

/** What the placeholders of a fired alert give. */
export type PlaceholderValues = {
  /** "EXCHANGE:TICKER". */
  symbol: string;
  /** Interval id of the alert ("60", "1D"). */
  interval: string;
  /** Open time of the bar the alert fired in (UNIX ms). */
  barTime: number | null;
  /** Time of the fire (UNIX ms). */
  fireTime: number;
  /** That bar; null when it could not be read. */
  bar: PlaceholderBar | null;
  currency: string | null;
  baseCurrency: string | null;
  /** Plots of the alert's study at that bar, in plot order; null for an alert on the price. */
  plots: { title: string; value: number | null }[] | null;
};

/** Placeholders whose value needs the bars of the alert's interval or its study. */
const BAR_DATA = /\{\{(?:open|high|low|close|volume|plot_\d+|plot\("[^"]*"\))\}\}/;

/** True when the message reads the bar or the study (they are loaded for it). */
export function needsBarData(text: string): boolean {
  return BAR_DATA.test(text);
}

/** UTC time without milliseconds: "2026-10-14T09:00:00Z". */
function utcTime(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

const num = (v: number | null | undefined): string | null => (typeof v === "number" && Number.isFinite(v) ? String(v) : null);

/** The message with its placeholders filled in. A placeholder without a value here stays as written. */
export function fillPlaceholders(text: string, v: PlaceholderValues): string {
  const colon = v.symbol.indexOf(":");
  const exchange = colon >= 0 ? v.symbol.slice(0, colon) : "";
  const ticker = colon >= 0 ? v.symbol.slice(colon + 1) : v.symbol;
  return text.replace(/\{\{(plot\("([^"]*)"\)|[a-z_][a-z0-9_.]*)\}\}/g, (all: string, name: string, plotTitle: string | undefined) => {
    if (plotTitle !== undefined) {
      const p = v.plots?.find((x) => x.title === plotTitle);
      return p ? (num(p.value) ?? "null") : all;
    }
    const plotIndex = /^plot_(\d+)$/.exec(name);
    if (plotIndex) return v.plots ? (num(v.plots[Number(plotIndex[1])]?.value) ?? "null") : all;
    let out: string | null = null;
    switch (name) {
      case "ticker": out = ticker; break;
      case "exchange": out = exchange || null; break;
      case "interval": out = v.interval; break;
      case "time": out = v.barTime != null ? utcTime(v.barTime) : null; break;
      case "timenow": out = utcTime(v.fireTime); break;
      case "open": out = num(v.bar?.open); break;
      case "high": out = num(v.bar?.high); break;
      case "low": out = num(v.bar?.low); break;
      case "close": out = num(v.bar?.close); break;
      case "volume": out = num(v.bar?.volume); break;
      case "syminfo.currency": out = v.currency; break;
      case "syminfo.basecurrency": out = v.baseCurrency; break;
    }
    return out ?? all;
  });
}
