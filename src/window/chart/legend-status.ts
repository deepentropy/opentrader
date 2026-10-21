/*
 * Chart legend statuses (the status pill next to the symbol title) and what
 * their popup says, as the reference app 3.4.1 (FullTooltipsPopup): one
 * section per status, an icon, a coloured title, a text (description, then
 * the countdown in bold) and, for the market status, the session timeline of
 * the exchange day with the exchange time zone.
 *
 * The popup component (LegendStatusPopup.tsx) renders these; only
 * `pillStatus` reads the session cache.
 */
import type { SymbolSessions } from "../../data/session";
import { cachedSymbolSessions, localDay, localToUtc, weekdayOf, zoneOffsetFinder } from "../../data/session";
import { zoneCity } from "../../data/symbol-info";

export type MarketStatusKind = "open" | "pre" | "post" | "closed" | "holiday";

/** Market-status pill items (small icons; colours from the dark theme). */
export const STATUS_ITEMS: Record<MarketStatusKind, { title: string; color: string; overlay: string; path: string }> = {
  open: { title: "Market open", color: "#42bda8", overlay: "#22ab9433", path: "M9 5a4 4 0 1 1 0 8 4 4 0 0 1 0-8" },
  pre: { title: "Pre-market", color: "#ff9100", overlay: "#ff980033", path: "M9 7.2a3.48 3.48 0 0 1 3.22 4.8 7 7 0 0 0-6.44 0A3.47 3.47 0 0 1 9 7.2M4.4 8.59l-.33 1.24L2 9.27l.33-1.24zm11.6.68-2.06.56-.34-1.24 2.07-.56zM7.55 5.94l-1.17.55-.9-1.94L6.64 4zm4.97-1.4-.9 1.94-1.17-.54.9-1.94z" },
  post: { title: "Post-market", color: "#82b1ff", overlay: "#448aff33", path: "M12.57 5.5h-.07a3.5 3.5 0 1 0 .07 7A4.98 4.98 0 0 1 4 9a5 5 0 0 1 8.57-3.5" },
  closed: { title: "Market closed", color: "#b8b8b8", overlay: "#b8b8b833", path: "M12 7a2 2 0 1 1 0 4H6a2 2 0 1 1 0-4z" },
  // Holiday: the closed colours, its own icon (a sun of dots).
  holiday: {
    title: "Holiday",
    color: "#b8b8b8",
    overlay: "#b8b8b833",
    path: "M6.7 9a2.3 2.3 0 1 0 4.6 0a2.3 2.3 0 1 0 -4.6 0M12.65 9a.95.95 0 1 0 1.9 0a.95.95 0 1 0 -1.9 0M11.3 12.25a.95.95 0 1 0 1.9 0a.95.95 0 1 0 -1.9 0M8.05 13.6a.95.95 0 1 0 1.9 0a.95.95 0 1 0 -1.9 0M4.8 12.25a.95.95 0 1 0 1.9 0a.95.95 0 1 0 -1.9 0M3.45 9a.95.95 0 1 0 1.9 0a.95.95 0 1 0 -1.9 0M4.8 5.75a.95.95 0 1 0 1.9 0a.95.95 0 1 0 -1.9 0M8.05 4.4a.95.95 0 1 0 1.9 0a.95.95 0 1 0 -1.9 0M11.3 5.75a.95.95 0 1 0 1.9 0a.95.95 0 1 0 -1.9 0",
  },
};

/** The legend pill's status: a weekday with no session reads "Holiday". */
export function pillStatus(symbol: string | undefined, status: "open" | "pre" | "post" | "closed", sec = Date.now() / 1000): MarketStatusKind {
  if (status !== "closed" || !symbol) return status;
  const s = cachedSymbolSessions(symbol);
  return s ? marketStatusAt(s, sec) : status;
}

/** Popup title, title colour (theme variable) and description per status (reference strings). */
export const MARKET_STATUS_TEXT: Record<MarketStatusKind, { title: string; color: string; description: string }> = {
  open: { title: "Market open", color: "var(--color-content-primary-success-bold)", description: "All's well — market is open." },
  pre: { title: "Pre-market", color: "var(--color-content-primary-warning-extra-bold)", description: "Morning. Market is open for pre-market trading." },
  post: { title: "Post-market", color: "var(--color-content-primary-accent-extra-bold)", description: "Evening. Market is open for post-market trading." },
  closed: { title: "Market closed", color: "var(--color-content-primary-neutral-semi-bold)", description: "Time for a walk — this market is closed." },
  holiday: { title: "Holiday", color: "var(--color-content-primary-neutral-semi-bold)", description: "Market is currently on holiday. Lucky them." },
};

/** Replay sections: the title is "Replay mode" in every state. */
export const REPLAY_STATUS_TEXT = {
  select: { title: "Replay mode", color: "var(--color-content-primary-neutral-normal)", text: "Select your start point." },
  on: { title: "Replay mode", color: "var(--color-content-secondary-accent)", text: "You're in Replay mode. You're in Replay mode. You're in Replay mode." },
} as const;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Remaining time as the reference app words it: "2 hours and 28 minutes",
 *  "1 day and 3 hours", "5 minutes", "less than 1 minute". */
export function durationText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s - days * 86400) / 3600);
  const minutes = Math.floor((s - days * 86400 - hours * 3600) / 60);
  if (days === 0 && hours === 0 && minutes === 0) return "less than 1 minute";
  if (days > 0) return `${plural(days, "day", "days")} and ${plural(hours, "hour", "hours")}`;
  if (hours > 0) return `${plural(hours, "hour", "hours")} and ${plural(minutes, "minute", "minutes")}`;
  return plural(minutes, "minute", "minutes");
}

/** Market status at `sec`, with a holiday (a weekday with no session) told
 *  apart from a plain close. */
export function marketStatusAt(s: SymbolSessions, sec: number): MarketStatusKind {
  const st = s.status(sec);
  if (st !== "closed") return st;
  const day = localDay(s.timeZone, sec);
  const wd = weekdayOf(day);
  if (wd >= 2 && wd <= 6 && !s.extended.isTradingDay(day)) return "holiday";
  return "closed";
}

/** The bold countdown of the market status ("It'll close in 3 hours and 12
 *  minutes."), null when no next change is known. */
export function countdownText(s: SymbolSessions, sec: number): string | null {
  const kind = marketStatusAt(s, sec);
  const left = (to: number | undefined | null) => (to == null ? null : durationText(to - sec));
  if (kind === "open") {
    const end = s.regular.at(sec)?.end;
    if (end == null) return null;
    const toPost = s.postmarket?.contains(end) ?? false;
    return `${toPost ? "It'll go to post-market trading in" : "It'll close in"} ${left(end)}.`;
  }
  if (kind === "pre") {
    const next = s.regular.currentOrNext(sec)?.start;
    return next == null ? null : `It’ll open fully in ${left(next)}.`;
  }
  if (kind === "post") {
    const end = s.postmarket?.at(sec)?.end;
    return end == null ? null : `It'll close in ${left(end)}.`;
  }
  const reg = s.regular.currentOrNext(sec)?.start ?? null;
  const pre = s.premarket?.currentOrNext(sec)?.start ?? null;
  if (pre !== null && (reg === null || pre <= reg)) return `It'll open for pre-market trading in ${left(pre)}.`;
  return reg === null ? null : `It'll open in ${left(reg)}.`;
}


export type TimelineType = "pre" | "open" | "post" | "closed";

/** A coloured part of the day bar, in fractions of the exchange day. */
export type TimelineSegment = {
  type: TimelineType;
  from: number;
  to: number;
  /** Rounded left / right end (a session bound, or the day's first / last closed part). */
  start: boolean;
  end: boolean;
  /** Hover tooltip: the part's title (in its colour) and its whole span,
   *  "09:30 — 16:00"; a closed part runs from the previous session's end to
   *  the next one's start ("Fri 20:00 — Mon 04:00" over a day or more). */
  tip: { title: string; time: string };
};

export type Timeline = {
  /** "Wed" (shown uppercase). */
  weekday: string;
  segments: TimelineSegment[];
  /** Current time, fraction of the day. */
  now: number;
  /** Time labels under the current part: its bounds, left / width in
   *  fractions; `alignEnds` when the part is wide enough (> 12 %). */
  marks: { left: number; width: number; titles: string[]; alignEnds: boolean } | null;
  /** "Exchange timezone: New York (UTC-4)". */
  zone: string;
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const TIMELINE_TITLE: Record<TimelineType, string> = { open: "Market open", pre: "Pre-market", post: "Post-market", closed: "Market closed" };

/** "UTC-4", "UTC+5:30", "UTC". */
export function utcOffsetText(offsetSec: number): string {
  if (offsetSec === 0) return "UTC";
  const sign = offsetSec > 0 ? "+" : "-";
  const m = Math.round(Math.abs(offsetSec) / 60);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `UTC${sign}${h}${mm ? `:${String(mm).padStart(2, "0")}` : ""}`;
}

/** The exchange time zone as the reference app titles it: "New York (UTC-4)",
 *  "Kolkata (UTC+5:30)", and "UTC" alone for UTC. */
export function zoneTitle(timeZone: string, sec: number): string {
  if (/^(Etc\/)?(UTC|GMT)$/i.test(timeZone)) return "UTC";
  return `${zoneCity(timeZone)} (${utcOffsetText(zoneOffsetFinder(timeZone)(sec))})`;
}

/** "09:30"; 1440 minutes is "24:00" (a day's end). */
function hm(minutes: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** A trading part (pre / open / post) or a closed gap, in UNIX seconds. */
type Span = { type: TimelineType; start: number; end: number };

/** Pre / open / post parts of trading day `day`: the extended session split
 *  by the regular one (before the first open = pre-market, after = post). */
function tradingDaySpans(s: SymbolSessions, day: number): Span[] {
  const reg = s.regular.dayIntervals(day);
  const ext = s.extended.dayIntervals(day);
  const open = reg.length ? reg[0].start : Infinity;
  const gap = (start: number, end: number): Span => ({ type: end <= open ? "pre" : "post", start, end });
  const out: Span[] = [];
  for (const e of ext.length ? ext : reg) {
    let at = e.start;
    for (const r of reg) {
      if (r.end <= at || r.start >= e.end) continue;
      if (r.start > at) out.push(gap(at, r.start));
      out.push({ type: "open", start: Math.max(at, r.start), end: Math.min(e.end, r.end) });
      at = Math.min(e.end, r.end);
    }
    if (at < e.end) out.push(gap(at, e.end));
  }
  return out;
}

/** Days searched around the shown day for the closed gaps' ends (a long holiday break). */
const GAP_SEARCH_DAYS = 14;

/** The session bar of the exchange day containing `sec`, as the reference
 *  app draws it: trading parts of the sessions overlapping the day (an
 *  overnight session shows on both days it spans), closed parts between. */
export function sessionTimeline(s: SymbolSessions, sec: number): Timeline {
  const tz = s.timeZone;
  const offset = zoneOffsetFinder(tz);
  const day = localDay(tz, sec);
  const midnight = localToUtc(tz, day, 0);
  const nextMidnight = localToUtc(tz, day + 1, 0);
  const daySec = Math.max(60, nextMidnight - midnight);
  // Wall-clock minutes of `t` from local midnight of `d` (24:00 = 1440).
  const wall = (t: number, d: number) => Math.round((t + offset(t)) / 60) - d * 1440;
  // "09:30 — 16:00"; with weekdays once the span reaches a day.
  const spanText = (a: number, b: number) => {
    const da = localDay(tz, a);
    const db = localDay(tz, b - 60);
    const ma = wall(a, da);
    const mb = wall(b - 60, db) + 1;
    const len = (db - da) * 1440 + mb - ma;
    if (len < 1440 || (len === 1440 && ma === 0)) return `${hm(ma)} — ${hm(mb)}`;
    return `${WEEKDAYS[weekdayOf(da) - 1]} ${hm(ma)} — ${WEEKDAYS[weekdayOf(db) - 1]} ${hm(mb)}`;
  };

  // Trading parts around the day, closed gaps between them.
  const trading: Span[] = [];
  for (let d = day - GAP_SEARCH_DAYS; d <= day + GAP_SEARCH_DAYS; d++) trading.push(...tradingDaySpans(s, d));
  trading.sort((a, b) => a.start - b.start);
  const spans: Span[] = [];
  let prevEnd = -Infinity;
  for (const t of trading) {
    if (t.start > prevEnd) spans.push({ type: "closed", start: prevEnd, end: t.start });
    spans.push(t);
    prevEnd = Math.max(prevEnd, t.end);
  }
  spans.push({ type: "closed", start: prevEnd, end: Infinity });

  const shown = spans.filter((p) => p.end > midnight && p.start < nextMidnight);
  const frac = (t: number) => (Math.min(nextMidnight, Math.max(midnight, t)) - midnight) / daySec;
  const last = shown.length - 1;
  const segments: TimelineSegment[] = shown.map((p, i) => {
    const closed = p.type === "closed";
    const a = Number.isFinite(p.start) ? p.start : midnight;
    const b = Number.isFinite(p.end) ? p.end : nextMidnight;
    return {
      type: p.type,
      from: frac(p.start),
      to: frac(p.end),
      start: p.start >= midnight || (i === 0 && closed),
      end: p.end <= nextMidnight || (i === last && closed),
      tip: { title: TIMELINE_TITLE[p.type], time: spanText(a, b) },
    };
  });

  const now = Math.max(0, Math.min(1, (sec - midnight) / daySec));
  // The labels of the current part: its session bounds (both ends of a closed part).
  const cur = shown.find((p) => frac(p.start) <= now && frac(p.end) >= now);
  let marks: Timeline["marks"] = null;
  if (cur) {
    const pts: number[] = [];
    if (cur.start >= midnight || cur.type === "closed") pts.push(Math.max(midnight, cur.start));
    if (cur.end <= nextMidnight || cur.type === "closed") pts.push(Math.min(nextMidnight, cur.end));
    if (pts.length) {
      const width = pts.length === 2 ? frac(pts[1]) - frac(pts[0]) : 0;
      marks = { left: frac(pts[0]), width, titles: pts.map((t) => hm(wall(t, day))), alignEnds: width * 100 > 12 };
    }
  }
  return {
    weekday: WEEKDAYS[weekdayOf(day) - 1],
    segments,
    now,
    marks,
    zone: `Exchange timezone: ${zoneTitle(tz, sec)}`,
  };
}
