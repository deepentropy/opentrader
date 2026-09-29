/*
 * US-equity market session from the wall clock (America/New_York, Mon–Fri):
 * pre-market 04:00–09:30, regular 09:30–16:00, post-market 16:00–20:00, else
 * closed (overnight / weekend). Holidays are not modelled. One source for the
 * watchlist status dot + Ext column, the Details market state and the chart's
 * pre/post-market price label.
 */

export type MarketSession = "open" | "pre" | "post" | "closed";

const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function usMarketSession(now: Date = new Date()): MarketSession {
  const parts = fmt.formatToParts(now);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  const wd = get("weekday");
  if (wd === "Sat" || wd === "Sun") return "closed";
  const mins = Number(get("hour")) * 60 + Number(get("minute"));
  if (mins >= 9 * 60 + 30 && mins < 16 * 60) return "open";
  if (mins >= 4 * 60 && mins < 9 * 60 + 30) return "pre";
  if (mins >= 16 * 60 && mins < 20 * 60) return "post";
  return "closed";
}
