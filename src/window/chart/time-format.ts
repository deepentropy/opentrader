/*
 * Chart date / time label text:
 *   intraday → "[Wed ]<date format>   <time>" (3-space separator)
 *   daily+   → "[Wed ]<date format>"
 * The weekday prefix follows Scales → "Day of week on labels"; the date
 * format follows Scales → "Date format". Used by the crosshair time label and
 * by the drawings' time-axis labels (vertical line, cross line).
 */

import { partsOf, type Parts } from "lightweight-charts-drawing/tv/time";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAY_PREFIX = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+/;
/** Sample tokens of the Date-format presets ("Mon 29 Sep '97") → format keys. */
const SAMPLE_TOKENS: Record<string, string> = { Q3: "qq", "'97": "'yy", "1997": "yyyy", Sep: "MMM", "29": "dd", "09": "MM", "97": "yy" };

/** Date-format key ("dd MMM 'yy", "yyyy-MM-dd", …) of a Date-format preset
 *  sample. Default for English: "dd MMM 'yy". */
export function dateFormatKey(sample?: string): string {
  if (!sample) return "dd MMM 'yy";
  return sample.replace(WEEKDAY_PREFIX, "").replace(/Q3|'97|1997|Sep|29|09|97/g, (t) => SAMPLE_TOKENS[t]);
}

const pad = (n: number, w: number) => String(n).padStart(w, "0");

/** Date format `key` applied to the date parts. */
function formatDate(key: string, p: Parts): string {
  return key.replace(/yyyy|yy|MMM|MM|dd|d|qq/g, (t) => {
    switch (t) {
      case "yyyy": return pad(p.y, 4);
      case "yy": return pad(p.y % 100, 2);
      case "MMM": return MONTHS[p.m - 1] ?? "";
      case "MM": return pad(p.m, 2);
      case "dd": return pad(p.d, 2);
      case "d": return String(p.d);
      default: return `Q${Math.floor((p.m - 1) / 3) + 1}`;
    }
  });
}

export type ChartTimeFormat = {
  /** Date-format preset sample (Scales → Date format). */
  dateFormat?: string;
  /** "24-hours" | "12-hours" (Scales → Time hours format). */
  timeFormat?: string;
  /** Scales → Day of week on labels (default on). */
  dayOfWeek?: boolean;
};

/** Chart time label for an epoch-seconds bar time in `timeZone`. */
export function formatChartTime(sec: number, timeZone: string, intraday: boolean, seconds: boolean, fmt: ChartTimeFormat = {}): string {
  const p = partsOf(sec, timeZone);
  const date = formatDate(dateFormatKey(fmt.dateFormat), p);
  const withDay = fmt.dayOfWeek !== false ? `${p.wd} ${date}` : date;
  if (!intraday) return withDay;
  const time = fmt.timeFormat === "12-hours"
    ? new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hour12: true }).format(new Date(sec * 1000))
    : seconds ? `${p.hh}:${p.mi}:${p.ss}` : `${p.hh}:${p.mi}`;
  return `${withDay}   ${time}`;
}

/** Time-axis tick label: Year "2026", Month "Sep", DayOfMonth "23", Time
 *  "14:30" (+ seconds). The Date-format preset does not apply to the ticks. */
export function formatTickMark(sec: number, type: "Year" | "Month" | "DayOfMonth" | "Time" | "TimeWithSeconds", timeZone: string, timeFormat?: string): string {
  const p = partsOf(sec, timeZone);
  switch (type) {
    case "Year": return String(p.y);
    case "Month": return MONTHS[p.m - 1] ?? "";
    case "DayOfMonth": return String(p.d);
    default: {
      const seconds = type === "TimeWithSeconds";
      if (timeFormat === "12-hours") {
        return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hour12: true }).format(new Date(sec * 1000));
      }
      return seconds ? `${p.hh}:${p.mi}:${p.ss}` : `${p.hh}:${p.mi}`;
    }
  }
}
