/*
 * Notification schedule of an alert (reference alert dialog, Notifications
 * view): the alert's notifications are muted outside it (the fire is still
 * logged). A schedule is a set of days (ISO 1 = Monday .. 7 = Sunday) and a
 * daily time range in a time zone; "00:00"–"00:00" is the whole day, a range
 * whose end is before its start runs past midnight. Unset = 24/7.
 *
 * Presets and texts follow the reference (its schedule module): 24/7,
 * Weekdays (Mo-Fr all day), Standard working hours (Mo-Fr 09:00–18:00), a
 * custom schedule; a segment reads "Mo-Fr · 09:00–18:00 UTC+2".
 */
import type { AlertSchedule } from "./alert-store";

export type SchedulePreset = "24/7" | "weekdays" | "standard_working_hours" | "custom";

export const ISO_FULL_WEEK = [1, 2, 3, 4, 5, 6, 7];
export const ISO_WEEKDAYS = [1, 2, 3, 4, 5];
/** The segments of the presets (reference constants). */
export const PRESET_SEGMENTS: Record<Exclude<SchedulePreset, "custom">, Pick<AlertSchedule, "days" | "from" | "to">> = {
  "24/7": { days: ISO_FULL_WEEK, from: "00:00", to: "00:00" },
  weekdays: { days: ISO_WEEKDAYS, from: "00:00", to: "00:00" },
  standard_working_hours: { days: ISO_WEEKDAYS, from: "09:00", to: "18:00" },
};
export const PRESET_TITLES: Record<SchedulePreset, string> = {
  "24/7": "24/7",
  weekdays: "Weekdays",
  standard_working_hours: "Standard working hours",
  custom: "Custom schedule",
};
const DAY_NAMES = ["", "Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

/** The user's time zone (schedules are set in it). */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const sameDays = (a: number[], b: number[]) => a.length === b.length && [...a].sort().every((d, i) => d === [...b].sort()[i]);

/** The preset a schedule is (unset: 24/7). */
export function schedulePreset(s: AlertSchedule | null | undefined): SchedulePreset {
  if (!s) return "24/7";
  for (const k of ["24/7", "weekdays", "standard_working_hours"] as const) {
    const p = PRESET_SEGMENTS[k];
    if (sameDays(s.days, p.days) && s.from === p.from && s.to === p.to) return k;
  }
  return "custom";
}

/** Days as the reference writes them: runs of three or more as "Mo-Fr" (Sunday to Monday wraps), others listed;
 *  the full week "Mo-Su". */
export function formatDays(days: number[]): string {
  if (days.length === 0) return "";
  if (days.length === 7) return `${DAY_NAMES[1]}-${DAY_NAMES[7]}`;
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const runs: number[][] = [];
  for (const d of sorted) {
    const last = runs[runs.length - 1];
    if (last && d === last[last.length - 1] + 1) last.push(d);
    else runs.push([d]);
  }
  if (runs.length > 1) {
    const first = runs[0];
    const end = runs[runs.length - 1];
    if (first[0] === 1 && end[end.length - 1] === 7) {
      runs.pop();
      runs.shift();
      runs.push([...end, ...first]);
    }
  }
  return runs.map((r) => (r.length >= 3 ? `${DAY_NAMES[r[0]]}-${DAY_NAMES[r[r.length - 1]]}` : r.map((d) => DAY_NAMES[d]).join(", "))).join(", ");
}

/** "UTC+2" for a time zone now (reference: the short offset, "GMT" as "UTC"). */
export function utcOffsetText(timeZone: string, at = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" }).formatToParts(at).find((p) => p.type === "timeZoneName");
    return (part?.value ?? "").replace("GMT", "UTC").replace(/[+-]0$/, "");
  } catch {
    return "";
  }
}

/** "Mo-Fr · 09:00–18:00 UTC+2". */
export function segmentText(s: Pick<AlertSchedule, "days" | "from" | "to">, timeZone?: string): string {
  const text = `${formatDays(s.days)} · ${s.from}–${s.to}`;
  const tz = timeZone ? utcOffsetText(timeZone) : "";
  return tz ? `${text} ${tz}` : text;
}

/** The schedule's name in its select: the preset's, or its segment for a custom one. */
export function scheduleTitle(s: AlertSchedule | null | undefined): string {
  const p = schedulePreset(s);
  return p === "custom" && s ? segmentText(s) : PRESET_TITLES[p];
}

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** True when the time (epoch ms) is inside the schedule (unset: always). */
export function inSchedule(s: AlertSchedule | null | undefined, timeMs: number): boolean {
  if (!s) return true;
  let weekday: string;
  let hour: number;
  let minute: number;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: s.timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(timeMs));
    weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
    hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
    minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  } catch {
    return true;
  }
  const day = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(weekday) + 1;
  const now = hour * 60 + minute;
  const from = minutes(s.from);
  const to = minutes(s.to);
  if (from === to) return s.days.includes(day);
  if (from < to) return s.days.includes(day) && now >= from && now < to;
  // Past midnight: the evening of a scheduled day, or the morning after one.
  const prev = day === 1 ? 7 : day - 1;
  return (s.days.includes(day) && now >= from) || (s.days.includes(prev) && now < to);
}
