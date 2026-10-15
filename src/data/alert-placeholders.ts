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

/** Groups of the "Add placeholder" menu. `plots`: the outputs of the alert's
 *  source when it is a study, in message order (none for the price; an
 *  output not `named` has no `{{plot("<title>")}}` row); `source`: a strategy
 *  adds its Position, Order and Market groups, a long / short position its
 *  own group. */
export function placeholderGroups(plots: readonly { title: string; named?: boolean }[] | null, source?: "strategy" | "position"): PlaceholderGroup[] {
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
      if (!seen.has(p.title) && p.named !== false) titled.push({ title: p.title, value: `{{plot("${p.title}")}}` });
      seen.add(p.title);
    }
    groups.push({ id: "plots", title: "Plots", items: [...titled, ...list.map((_, i) => ({ title: `Plot ${i}`, value: `{{plot_${i}}}` }))] });
  }
  if (source === "strategy") groups.push(...STRATEGY_GROUPS);
  if (source === "position") groups.push(POSITION_GROUP);
  return groups;
}

/** A strategy's groups: its position, the order that filled and the market position before and after it. */
const STRATEGY_GROUPS: PlaceholderGroup[] = [
  { id: "position", title: "Position", items: [{ title: "Position size", value: "{{strategy.position_size}}" }] },
  {
    id: "order",
    title: "Order",
    items: [
      { title: "Action", value: "{{strategy.order.action}}" },
      { title: "Contracts", value: "{{strategy.order.contracts}}" },
      { title: "Price", value: "{{strategy.order.price}}" },
      { title: "ID", value: "{{strategy.order.id}}" },
      { title: "Comment", value: "{{strategy.order.comment}}" },
      { title: "Alert message", value: "{{strategy.order.alert_message}}" },
    ],
  },
  {
    id: "market",
    title: "Market",
    items: [
      { title: "Position", value: "{{strategy.market_position}}" },
      { title: "Position size", value: "{{strategy.market_position_size}}" },
      { title: "Previous position", value: "{{strategy.prev_market_position}}" },
      { title: "Previous position size", value: "{{strategy.prev_market_position_size}}" },
    ],
  },
];

/** A long / short position's group: the level it hit, that level's price, the profit or loss there. */
const POSITION_GROUP: PlaceholderGroup = {
  id: "position_tool",
  title: "Position drawing tool",
  items: [
    { title: "Position level", value: "{{position.level}}" },
    { title: "Order price", value: "{{position.price}}" },
    { title: "PnL", value: "{{position.pnl}}" },
  ],
};

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
  /** The order fill of an alert on a strategy's orders. */
  strategy?: StrategyFillValues | null;
  /** The level a long / short position's alert hit. */
  position?: PositionHitValues | null;
  /** Prices written in the symbol's price format ("81346.00"): a strategy's alert writes its order price and the
   *  bar's open / high / low / close that way; other alerts write numbers as they are. */
  priceText?: (v: number) => string;
};

export type MarketPosition = "long" | "short" | "flat";

/** An order fill of a strategy: the order, and the strategy's position before and after it (signed size). */
export type StrategyFillValues = {
  action: "buy" | "sell";
  contracts: number;
  price: number;
  id: string;
  comment: string;
  alertMessage: string;
  positionSize: number;
  prevPositionSize: number;
};

/** A hit of a long / short position's level: its name, its price and the profit or loss there. */
export type PositionHitValues = { level: string; price: number; pnl: number | null };

const marketPosition = (size: number): MarketPosition => (size > 0 ? "long" : size < 0 ? "short" : "flat");

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

/** A strategy placeholder of an order fill; null for a name it does not have. */
function strategyText(name: string, f: StrategyFillValues, price: (v: number) => string | null): string | null {
  switch (name) {
    case "strategy.order.action": return f.action;
    case "strategy.order.contracts": return num(f.contracts);
    case "strategy.order.price": return price(f.price);
    case "strategy.order.id": return f.id;
    case "strategy.order.comment": return f.comment;
    case "strategy.order.alert_message": return f.alertMessage;
    case "strategy.position_size": return num(f.positionSize);
    case "strategy.market_position": return marketPosition(f.positionSize);
    case "strategy.market_position_size": return num(Math.abs(f.positionSize));
    case "strategy.prev_market_position": return marketPosition(f.prevPositionSize);
    case "strategy.prev_market_position_size": return num(Math.abs(f.prevPositionSize));
  }
  return null;
}

/** A position placeholder of a level hit; null for a name it does not have. */
function positionText(name: string, p: PositionHitValues): string | null {
  switch (name) {
    case "position.level": return p.level;
    case "position.price": return num(p.price);
    // In cents, rounded half up ("250.01" for 15 x 16.667); "—" at the entry.
    case "position.pnl": return p.pnl == null ? "—" : (Math.round(p.pnl * 100 + 1e-7 * Math.sign(p.pnl)) / 100).toFixed(2);
  }
  return null;
}

/** The message with its placeholders filled in. A placeholder without a value here stays as written. */
export function fillPlaceholders(text: string, v: PlaceholderValues): string {
  const colon = v.symbol.indexOf(":");
  const exchange = colon >= 0 ? v.symbol.slice(0, colon) : "";
  const ticker = colon >= 0 ? v.symbol.slice(colon + 1) : v.symbol;
  const price = (p: number | null | undefined): string | null => (v.priceText && typeof p === "number" && Number.isFinite(p) ? v.priceText(p) : num(p));
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
      case "open": out = price(v.bar?.open); break;
      case "high": out = price(v.bar?.high); break;
      case "low": out = price(v.bar?.low); break;
      case "close": out = price(v.bar?.close); break;
      case "volume": out = num(v.bar?.volume); break;
      case "syminfo.currency": out = v.currency; break;
      case "syminfo.basecurrency": out = v.baseCurrency; break;
      default:
        if (v.strategy && name.startsWith("strategy.")) out = strategyText(name, v.strategy, price);
        else if (v.position && name.startsWith("position.")) out = positionText(name, v.position);
    }
    return out ?? all;
  });
}
