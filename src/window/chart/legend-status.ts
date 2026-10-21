/*
 * Chart legend statuses (the status pill next to the symbol title) and what
 * their popup says, as the reference app 3.4.1 (FullTooltipsPopup): one
 * section per status, an icon, a coloured title, a text (description, then
 * the countdown in bold) and, for the market status, the session timeline of
 * the exchange day with the exchange time zone.
 *
 * Pure: the popup component (LegendStatusPopup.tsx) renders these.
 */
import type { SymbolSessions } from "../../data/session";
import { localDay, localToUtc, weekdayOf, zoneOffsetFinder } from "../../data/session";
import { dayParts, minutesText, zoneCity } from "../../data/symbol-info";

export type MarketStatusKind = "open" | "pre" | "post" | "closed" | "holiday";

/** Market-status pill items (small icons; colours from the dark theme). Holiday
 *  shows the closed icon. */
export const STATUS_ITEMS: Record<"open" | "pre" | "post" | "closed", { title: string; color: string; overlay: string; path: string }> = {
  open: { title: "Market open", color: "#42bda8", overlay: "#22ab9433", path: "M9 5a4 4 0 1 1 0 8 4 4 0 0 1 0-8" },
  pre: { title: "Pre-market", color: "#ff9100", overlay: "#ff980033", path: "M9 7.2a3.48 3.48 0 0 1 3.22 4.8 7 7 0 0 0-6.44 0A3.47 3.47 0 0 1 9 7.2M4.4 8.59l-.33 1.24L2 9.27l.33-1.24zm11.6.68-2.06.56-.34-1.24 2.07-.56zM7.55 5.94l-1.17.55-.9-1.94L6.64 4zm4.97-1.4-.9 1.94-1.17-.54.9-1.94z" },
  post: { title: "Post-market", color: "#82b1ff", overlay: "#448aff33", path: "M12.57 5.5h-.07a3.5 3.5 0 1 0 .07 7A4.98 4.98 0 0 1 4 9a5 5 0 0 1 8.57-3.5" },
  closed: { title: "Market closed", color: "#b8b8b8", overlay: "#b8b8b833", path: "M12 7a2 2 0 1 1 0 4H6a2 2 0 1 1 0-4z" },
};

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
  /** Hover text: "Pre-market 04:00 — 09:30". */
  tooltip: string;
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
const TYPE_TITLE: Record<TimelineType, string> = { open: "Market open", pre: "Pre-market", post: "Post-market", closed: "Market closed" };

/** "UTC-4", "UTC+5:30", "UTC". */
export function utcOffsetText(offsetSec: number): string {
  if (offsetSec === 0) return "UTC";
  const sign = offsetSec > 0 ? "+" : "-";
  const m = Math.round(Math.abs(offsetSec) / 60);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `UTC${sign}${h}${mm ? `:${String(mm).padStart(2, "0")}` : ""}`;
}

/** The session bar of the exchange day containing `sec`. */
export function sessionTimeline(s: SymbolSessions, sec: number): Timeline {
  const tz = s.timeZone;
  const day = localDay(tz, sec);
  const midnight = localToUtc(tz, day, 0);
  const nextMidnight = localToUtc(tz, day + 1, 0);
  const dayMinutes = Math.max(1, Math.round((nextMidnight - midnight) / 60));
  const parts = dayParts(s.regular, s.extended, day).slice().sort((a, b) => a.from - b.from);
  // Trading parts, closed parts in the gaps.
  const raw: { type: TimelineType; from: number; to: number }[] = [];
  let at = 0;
  for (const p of parts) {
    if (p.from > at) raw.push({ type: "closed", from: at, to: p.from });
    raw.push({ type: p.part, from: p.from, to: p.to });
    at = Math.max(at, p.to);
  }
  if (at < dayMinutes) raw.push({ type: "closed", from: at, to: dayMinutes });
  const last = raw.length - 1;
  const segments: TimelineSegment[] = raw.map((r, i) => ({
    type: r.type,
    from: r.from / dayMinutes,
    to: r.to / dayMinutes,
    start: r.from > 0 || (i === 0 && r.type === "closed"),
    end: r.to < dayMinutes || (i === last && r.type === "closed"),
    tooltip: `${TYPE_TITLE[r.type]} ${minutesText(r.from)} — ${minutesText(r.to)}`,
  }));
  const nowMin = (sec - midnight) / 60;
  const now = Math.max(0, Math.min(1, nowMin / dayMinutes));
  // The labels of the current part: its session bounds (both ends of a closed part).
  const cur = raw.find((r) => r.from <= nowMin && r.to >= nowMin);
  let marks: Timeline["marks"] = null;
  if (cur) {
    const pts: number[] = [];
    if (cur.from > 0 || cur.type === "closed") pts.push(cur.from);
    if (cur.to < dayMinutes || cur.type === "closed") pts.push(cur.to);
    if (pts.length) {
      const width = pts.length === 2 ? (pts[1] - pts[0]) / dayMinutes : 0;
      marks = { left: pts[0] / dayMinutes, width, titles: pts.map(minutesText), alignEnds: width * 100 > 12 };
    }
  }
  return {
    weekday: WEEKDAYS[weekdayOf(day) - 1],
    segments,
    now,
    marks,
    zone: `Exchange timezone: ${zoneCity(tz)} (${utcOffsetText(zoneOffsetFinder(tz)(sec))})`,
  };
}
