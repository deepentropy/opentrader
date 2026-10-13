/*
 * Volume profile studies of Technicals > Profiles (#48): Session volume
 * profile (SVP), Session volume profile HD, Periodic volume profile (PVP),
 * Visible range volume profile (VRVP) and Auto anchored volume profile
 * (AAVP). The reference app computes them from lower-timeframe bars of the
 * chart symbol (vbp-engine.ts); here the chart context's `lowerBars` loads
 * them (other-symbols.ts) and the study calculates again as they arrive.
 *
 * Output: `vbp` (the profiles, drawn by vbp-primitive.ts), the developing POC
 * / VA High / VA Low step lines (hidden by default) and, in the status line,
 * the up / down / total volume of the row holding the bar's close in the
 * profile of that bar (reference: values coloured as the row, total in the
 * text colour).
 *
 * Lower timeframe: SVP / PVP / HD rough by the chart interval (ltfForChart);
 * VRVP / AAVP / HD detailed by the span of the range (ltfForSpan). Session
 * and periodic profiles stop at 6000 rows, newest first.
 */
import type { IndicatorRegistryEntry } from "lightweight-charts-indicators";
import type { Bar } from "oakscriptjs";
import { cachedSymbolSessions, localDay, localToUtc, zoneOffsetFinder, type SymbolSessions } from "../../../data/session";
import type { ChartEvent } from "../../../data/datafeed";
import type { StudyCalcContext } from "../indicators/indicator-layer";
import {
  barDirections,
  buildProfile,
  ltfForChart,
  ltfForSpan,
  lowerBound,
  MAX_TOTAL_ROWS,
  profileLevels,
  toTicks,
  type GridOptions,
  type LtfBar,
  type RowsLayout,
  type VbpProfile,
} from "./vbp-engine";
import { themeTextColor, vbpStyleOf, type VbpStyle } from "./vbp-style";

/** Chart context of a profile study: the app adds the chart symbol's lower-timeframe bars and events. */
export type ProfileCalcContext = StudyCalcContext & {
  lowerBars?: (resolution: string, from: number) => Bar[] | undefined;
  chartEvents?: () => ChartEvent[] | undefined;
};

export type VolumeMode = "Up/Down" | "Total" | "Delta";

/** One drawn profile: chart bar indexes (into the bars given to calculate), rows, value area, levels and the
 *  bar where each extended line stops (-1: runs to the right edge; null: not extended). */
export type VbpDrawProfile = {
  i0: number;
  i1: number;
  lo: number;
  step: number;
  up: number[];
  down: number[];
  vaLo: number;
  vaHi: number;
  poc: number;
  vah: number;
  val: number;
  pocEnd: number | null;
  vahEnd: number | null;
  valEnd: number | null;
};

export type VbpDraw = {
  profiles: VbpDrawProfile[];
  /** Visible range profile: drawn from the pane's edge, its lines across the pane. */
  relative: boolean;
  /** Box and lines from the left edge of the first bar to the right edge of the last (else bar centres). */
  toBarEdges: boolean;
  /** POC / VAH / VAL labels on the price scale. */
  showPrice: boolean;
  volume: VolumeMode;
  style: VbpStyle;
};

type PlotPoint = { time: number; value: number; color?: string };

// ── Shared helpers ──────────────────────────────────────────────────────────

export const SESSION_OPTIONS = ["Each (pre-market, market, post-market)", "All", "Pre-market only", "Market only", "Post-market only", "Night only", "Custom"];

/** Time zones of the "Custom session" (reference list). */
export const TIME_ZONES = [
  "Exchange", "Etc/UTC", "Africa/Cairo", "Africa/Casablanca", "Africa/Johannesburg", "Africa/Lagos", "Africa/Nairobi", "Africa/Tunis",
  "America/Anchorage", "America/Argentina/Buenos Aires", "America/Bogota", "America/Caracas", "America/Chicago", "America/El Salvador",
  "America/Halifax", "America/Juneau", "America/Lima", "America/Los Angeles", "America/Mexico City", "America/New York", "America/Phoenix",
  "America/Santiago", "America/Sao Paulo", "America/Toronto", "America/Vancouver", "Asia/Almaty", "Asia/Ashkhabad", "Asia/Bahrain",
  "Asia/Bangkok", "Asia/Chongqing", "Asia/Colombo", "Asia/Dhaka", "Asia/Dubai", "Asia/Ho_Chi Minh", "Asia/Hong Kong", "Asia/Jakarta",
  "Asia/Jerusalem", "Asia/Kabul", "Asia/Karachi", "Asia/Kathmandu", "Asia/Kolkata", "Asia/Kuala Lumpur", "Asia/Kuwait", "Asia/Manila",
  "Asia/Muscat", "Asia/Nicosia", "Asia/Qatar", "Asia/Riyadh", "Asia/Seoul", "Asia/Shanghai", "Asia/Singapore", "Asia/Taipei", "Asia/Tehran",
  "Asia/Tokyo", "Asia/Yangon", "Atlantic/Azores", "Atlantic/Reykjavik", "Australia/ACT", "Australia/Adelaide", "Australia/Brisbane",
  "Australia/Perth", "Australia/Sydney", "Europe/Amsterdam", "Europe/Athens", "Europe/Belgrade", "Europe/Berlin", "Europe/Brussels",
  "Europe/Bratislava", "Europe/Bucharest", "Europe/Budapest", "Europe/Copenhagen", "Europe/Dublin", "Europe/Helsinki", "Europe/Istanbul",
  "Europe/Lisbon", "Europe/London", "Europe/Luxembourg", "Europe/Ljubljana", "Europe/Madrid", "Europe/Malta", "Europe/Moscow", "Europe/Oslo",
  "Europe/Paris", "Europe/Prague", "Europe/Riga", "Europe/Rome", "Europe/Stockholm", "Europe/Sofia", "Europe/Tallinn", "Europe/Vienna",
  "Europe/Vilnius", "Europe/Warsaw", "Europe/Zurich", "Europe/Zagreb", "Pacific/Auckland", "Pacific/Chatham", "Pacific/Fakaofo",
  "Pacific/Honolulu", "Pacific/Norfolk", "US/Mountain",
];

/** Seconds of a chart interval id ("5", "60", "1D", "1W", "1M", "10S"). */
export function chartSeconds(interval: string): number {
  const m = /^(\d*)([SDWM]?)$/i.exec(interval.trim());
  if (!m) return 86400;
  const n = m[1] ? Number(m[1]) : 1;
  const u = m[2].toUpperCase();
  return u === "S" ? n : u === "D" ? n * 86400 : u === "W" ? n * 7 * 86400 : u === "M" ? n * 30 * 86400 : n * 60;
}

const isDaily = (sec: number) => sec >= 86400;

/** End of a chart bar (seconds): its interval for intraday bars, its trading day's close for daily and longer. */
function barEnd(bars: Bar[], i: number, sec: number, sessions: SymbolSessions | null): number {
  const t = bars[i].time as number;
  if (!isDaily(sec) || !sessions) return t + sec;
  if (sec > 86400 && i + 1 < bars.length) return bars[i + 1].time as number;
  const day = sessions.regular.tradingDay(t);
  return sessions.regular.dayBounds(day)?.end ?? t + 86400;
}

/** Chart bar index holding LTF time `t`: the last bar starting at or before it (daily and longer: its trading
 *  day's bar). -1 before the first bar. */
function chartIndexOf(bars: Bar[], t: number, sec: number, sessions: SymbolSessions | null): number {
  let at = t;
  if (isDaily(sec) && sessions) {
    const day = sessions.extended.tradingDay(t);
    at = Math.max(t, sessions.regular.dayBounds(day)?.start ?? t);
  }
  return lowerBound(bars as unknown as { time: number }[], at + 1) - 1;
}

const directions = new WeakMap<object, boolean[]>();
function dirsOf(ltf: Bar[]): boolean[] {
  let d = directions.get(ltf);
  if (!d || d.length !== ltf.length) {
    d = barDirections(ltf as unknown as LtfBar[]);
    directions.set(ltf, d);
  }
  return d;
}

function rowsGrid(inputs: Record<string, unknown>): GridOptions {
  const layout = (inputs.rowsLayout === "Ticks Per Row" ? "Ticks Per Row" : "Number Of Rows") as RowsLayout;
  return { layout, rowSize: Math.max(1, Number(inputs.rows ?? 24)) };
}

/** The study draws nothing (no symbol / sessions yet, no data). */
const nothing = (pending = false) => ({ plots: {}, ...(pending ? { pending: true } : {}) });

/** A profile group: LTF bar range [g0, g1]. */
type Group = { g0: number; g1: number };

/** Developing POC / VA and status-line values over the chart bars of each profile, plus the extended lines. */
function finish(
  bars: Bar[],
  ltf: Bar[],
  made: { g: Group; p: VbpProfile; i0: number; i1: number }[],
  tick: number,
  grid: GridOptions,
  vaPct: number,
  ext: { poc: boolean; vah: boolean; val: boolean },
  style: VbpStyle,
  textColor: string,
  relative: boolean,
  showPrice: boolean,
  volume: VolumeMode,
): { plots: Record<string, PlotPoint[]>; vbp: VbpDraw } {
  const n = bars.length;
  const dPoc = new Array<number>(n).fill(NaN);
  const dVah = new Array<number>(n).fill(NaN);
  const dVal = new Array<number>(n).fill(NaN);
  const vUp = new Array<number>(n).fill(NaN);
  const vDown = new Array<number>(n).fill(NaN);
  const vTot = new Array<number>(n).fill(NaN);
  const upCol = new Array<string | undefined>(n);
  const downCol = new Array<string | undefined>(n);
  const dirs = dirsOf(ltf);
  const profiles: VbpDrawProfile[] = [];
  for (const { g, p, i0, i1 } of made) {
    // Developing values (only when a developing line is shown): the profile of the bars up to the end of each
    // chart bar.
    let j = g.g0;
    for (let k = Math.max(0, i0); k <= i1 && k < n; k++) {
      const next = k + 1 < n ? (bars[k + 1].time as number) : Infinity;
      while (j + 1 <= g.g1 && (ltf[j + 1].time as number) < next) j++;
      if ((ltf[g.g0].time as number) >= next) continue;
      const part = !style.developing ? null : j === g.g1 ? p : buildProfile(ltf as unknown as LtfBar[], dirs, g.g0, j, tick, grid, vaPct);
      if (part) {
        const L = profileLevels(part);
        dPoc[k] = L.poc;
        dVah[k] = L.vah;
        dVal[k] = L.val;
      }
      // Status line: the row of the final profile holding the bar's close.
      const r = Math.floor((bars[k].close - p.lo) / p.step + 1e-9);
      if (r >= 0 && r < p.up.length) {
        const va = r >= p.vaLo && r <= p.vaHi;
        vUp[k] = p.up[r];
        vDown[k] = p.down[r];
        vTot[k] = p.up[r] + p.down[r];
        upCol[k] = va ? style.vaUpColor : style.upColor;
        downCol[k] = va ? style.vaDownColor : style.downColor;
      }
    }
    const L = profileLevels(p);
    const stop = (on: boolean, level: number): number | null => {
      if (!on) return null;
      for (let k = i1 + 1; k < n; k++) if (bars[k].low <= level && level <= bars[k].high) return k;
      return -1;
    };
    profiles.push({
      i0, i1, lo: p.lo, step: p.step, up: p.up, down: p.down, vaLo: p.vaLo, vaHi: p.vaHi,
      poc: L.poc, vah: L.vah, val: L.val,
      pocEnd: stop(ext.poc, L.poc), vahEnd: stop(ext.vah, L.vah), valEnd: stop(ext.val, L.val),
    });
  }
  const series = (vals: number[], colors?: (string | undefined)[]): PlotPoint[] =>
    bars.map((b, k) => (colors?.[k] ? { time: b.time as number, value: vals[k], color: colors[k] } : { time: b.time as number, value: vals[k] }));
  return {
    plots: {
      developingPoc: series(dPoc),
      developingVAHigh: series(dVah),
      developingVALow: series(dVal),
      upVolume: series(vUp, upCol),
      downVolume: series(vDown, downCol),
      totalVolume: series(vTot, vTot.map(() => textColor)),
    },
    vbp: { profiles, relative, toBarEdges: !relative, showPrice, volume, style },
  };
}

// ── Session grouping (SVP, HD) ─────────────────────────────────────────────

/** Session key of each LTF bar for the "Sessions" input; null = left out. */
function sessionKeyer(inputs: Record<string, unknown>, sessions: SymbolSessions): (t: number) => string | null {
  const mode = String(inputs.profilesSessions ?? "All");
  const day = (t: number) => sessions.extended.tradingDay(t);
  if (mode === "All") return (t) => String(day(t));
  if (mode === "Each (pre-market, market, post-market)") return (t) => `${day(t)}:${sessions.extendedPart(t) ?? "market"}`;
  if (mode === "Pre-market only") return (t) => (sessions.extendedPart(t) === "pre" ? String(day(t)) : null);
  if (mode === "Post-market only") return (t) => (sessions.extendedPart(t) === "post" ? String(day(t)) : null);
  if (mode === "Market only") return (t) => (sessions.regular.contains(t) ? String(day(t)) : null);
  if (mode === "Night only") return () => null; // no night session on the symbols served
  // Custom "HHMM-HHMM" in the chosen zone (an end at or before the start runs past midnight).
  const m = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(String(inputs.customSession ?? "").trim());
  if (!m) return () => null;
  const from = +m[1] * 60 + +m[2];
  const to = +m[3] * 60 + +m[4];
  const tzInput = String(inputs.customSessionTZ ?? "Exchange");
  const tz = tzInput === "Exchange" ? sessions.timeZone : tzInput.replace(/ /g, "_");
  const off = zoneOffsetFinder(tz);
  return (t) => {
    const local = t + off(t);
    const min = Math.floor((((local % 86400) + 86400) % 86400) / 60);
    const d = Math.floor(local / 86400);
    if (from < to) return min >= from && min < to ? String(d) : null;
    if (min >= from) return String(d);
    return min < to ? String(d - 1) : null;
  };
}

/** Session key of a bar time for the "Sessions" inputs (TPO studies share it). */
export const sessionKeyerFor = sessionKeyer;

/** Consecutive LTF bars with the same key, newest groups kept until `maxRows` rows (estimated `rowsEach`). */
function groupBy(ltf: Bar[], start: number, keyOf: (t: number, i: number) => string | null): Group[] {
  const out: Group[] = [];
  let key: string | null = null;
  for (let i = start; i < ltf.length; i++) {
    const k = keyOf(ltf[i].time as number, i);
    if (k === null) { key = null; continue; }
    const last = out[out.length - 1];
    if (last && k === key && last.g1 === i - 1) last.g1 = i;
    else out.push({ g0: i, g1: i });
    key = k;
  }
  return out;
}

/** First time the session / periodic profiles need: the chart bars of the newest groups worth MAX_TOTAL_ROWS rows. */
function neededFrom(bars: Bar[], keyOf: (t: number, i: number) => string | null, rowsEach: number): number {
  const want = Math.max(1, Math.ceil(MAX_TOTAL_ROWS / Math.max(1, rowsEach))) + 1;
  let groups = 0;
  let key: string | null = null;
  for (let i = bars.length - 1; i >= 0; i--) {
    const k = keyOf(bars[i].time as number, i);
    if (k !== null && k !== key) {
      groups++;
      key = k;
      if (groups > want) return bars[i + 1].time as number;
    }
  }
  return bars.length ? (bars[0].time as number) : 0;
}

/** Profiles of the groups (newest first until 6000 rows), mapped to the chart bars. */
function makeProfiles(bars: Bar[], ltf: Bar[], groups: Group[], tick: number, grid: GridOptions, vaPct: number, sec: number, sessions: SymbolSessions | null, rowCap = MAX_TOTAL_ROWS) {
  const dirs = dirsOf(ltf);
  const made: { g: Group; p: VbpProfile; i0: number; i1: number }[] = [];
  let rows = 0;
  for (let k = groups.length - 1; k >= 0 && rows < rowCap; k--) {
    const g = groups[k];
    const i0 = chartIndexOf(bars, ltf[g.g0].time as number, sec, sessions);
    const i1 = chartIndexOf(bars, ltf[g.g1].time as number, sec, sessions);
    if (i0 < 0 || i1 < 0) break;
    const p = buildProfile(ltf as unknown as LtfBar[], dirs, g.g0, g.g1, tick, grid, vaPct);
    if (!p) continue;
    made.push({ g, p, i0, i1 });
    rows += p.up.length;
  }
  return made.reverse();
}

function commonSetup(bars: Bar[], ctx: ProfileCalcContext | undefined) {
  const sessions = ctx?.tickerid ? cachedSymbolSessions(ctx.tickerid) : null;
  const tick = ctx?.mintick ?? sessions?.mintick ?? 0.01;
  const sec = chartSeconds(ctx?.timeframe ?? "1D");
  const seconds = /S$/i.test(ctx?.timeframe ?? "");
  const textColor = (ctx as { foregroundColor?: string } | undefined)?.foregroundColor ?? "#DBDBDB";
  return { sessions, tick, sec, seconds, textColor, ready: !!sessions && !!ctx?.lowerBars && bars.length > 0 };
}

const ext = (inputs: Record<string, unknown>) => ({ poc: !!inputs.extendPocRight, vah: !!inputs.extendVAHRight, val: !!inputs.extendVALRight });
const volumeOf = (inputs: Record<string, unknown>) => (["Total", "Delta"].includes(String(inputs.volume)) ? String(inputs.volume) : "Up/Down") as VolumeMode;
const vaOf = (inputs: Record<string, unknown>) => Number(inputs.vaVolume ?? 70);

// ── Session volume profile ─────────────────────────────────────────────────

function calcSessions(bars: Bar[], inputs: Record<string, unknown>, ctx: ProfileCalcContext | undefined, grid: GridOptions, showPrice: boolean) {
  const c = commonSetup(bars, ctx);
  if (!c.ready) return nothing(true);
  const sessions = c.sessions!;
  const keyOf = sessionKeyer(inputs, sessions);
  const rowsEach = "rowSize" in grid && grid.layout === "Number Of Rows" ? grid.rowSize : 24;
  const from = neededFrom(bars, (t) => keyOf(t) ?? String(sessions.extended.tradingDay(t)), rowsEach);
  const { res } = ltfForChart(c.sec);
  const ltf = ctx!.lowerBars!(res, from);
  if (!ltf) return nothing(true);
  const start = lowerBound(ltf as unknown as { time: number }[], from);
  const groups = groupBy(ltf, start, (t) => keyOf(t));
  const made = makeProfiles(bars, ltf, groups, c.tick, grid, vaOf(inputs), c.sec, sessions);
  return finish(bars, ltf, made, c.tick, grid, vaOf(inputs), ext(inputs), vbpStyleOf(inputs, "Left"), c.textColor, false, showPrice, volumeOf(inputs));
}

// ── Session volume profile HD ──────────────────────────────────────────────

/** Detailed profiles: one row size for the window, floor(price range of its sessions / this many ticks), at least
 *  1 tick (INFERRED from 8 reference windows, 1 to 28 ticks per row: the divisor lies between 534 and 545). */
const HD_TICKS_PER_ROW_DIVISOR = 540;

function calcSessionsHD(bars: Bar[], inputs: Record<string, unknown>, ctx: ProfileCalcContext | undefined) {
  // Rough profiles: the row count closest to 25 (reference rough study: 25 rows on 208 of 239 sessions, 24-27 otherwise).
  const rough = calcSessions(bars, inputs, ctx, { layout: "Number Of Rows", rowSize: 25 }, false);
  const vbp = (rough as { vbp?: VbpDraw }).vbp;
  const c = commonSetup(bars, ctx);
  if (!vbp || !c.ready || ctx?.leftVisibleBarTime == null || ctx.rightVisibleBarTime == null) return rough;
  const sessions = c.sessions!;
  // Detailed window: the visible bars and as much again on each side.
  const left = ctx.leftVisibleBarTime / 1000;
  const right = ctx.rightVisibleBarTime / 1000;
  const w = right - left;
  const winFrom = left - w;
  const winTo = right + w;
  const res = c.seconds ? "1S" : ltfForSpan(winTo - winFrom, false);
  const ltf = ctx.lowerBars!(res, winFrom);
  if (!ltf) return rough;
  const keyOf = sessionKeyer(inputs, sessions);
  // Whole sessions that start inside the window.
  const groups = groupBy(ltf, lowerBound(ltf as unknown as { time: number }[], winFrom), (t) => keyOf(t)).filter((g) => (ltf[g.g0].time as number) <= winTo);
  if (!groups.length) return rough;
  let lo = Infinity;
  let hi = -Infinity;
  for (const g of groups) {
    for (let i = g.g0; i <= g.g1; i++) {
      lo = Math.min(lo, toTicks(ltf[i].low, c.tick));
      hi = Math.max(hi, toTicks(ltf[i].high, c.tick));
    }
  }
  const grid: GridOptions = { fixedTpr: Math.max(1, Math.floor((hi - lo) / HD_TICKS_PER_ROW_DIVISOR)) };
  const made = makeProfiles(bars, ltf, groups, c.tick, grid, vaOf(inputs), c.sec, sessions, Infinity);
  const detailed = finish(bars, ltf, made, c.tick, grid, vaOf(inputs), ext(inputs), vbp.style, c.textColor, false, false, volumeOf(inputs));
  // Each detailed profile replaces the rough one of its session.
  const byStart = new Map(detailed.vbp.profiles.map((p) => [p.i0, p]));
  const merged = vbp.profiles.map((p) => byStart.get(p.i0) ?? p);
  const plots = { ...(rough as { plots: Record<string, PlotPoint[]> }).plots };
  for (const p of detailed.vbp.profiles) {
    for (const id of Object.keys(plots)) {
      const src = detailed.plots[id];
      for (let k = p.i0; k <= p.i1 && k < src.length; k++) plots[id][k] = src[k];
    }
  }
  return { plots, vbp: { ...vbp, profiles: merged } };
}

// ── Periodic volume profile ────────────────────────────────────────────────

/** Period key of a bar time: N units counted from the start of its calendar year (profiles restart each year). */
function periodKeyer(inputs: Record<string, unknown>, sessions: SymbolSessions, bars: Bar[], sec: number): (t: number) => string {
  const n = Math.max(1, Math.round(Number(inputs.periodsNum ?? 1)));
  const unit = String(inputs.period ?? "Bar");
  const tz = sessions.timeZone;
  const yearOf = (day: number) => new Date(day * 86400000).getUTCFullYear();
  const yearStart = new Map<number, number>();
  const firstDay = (y: number) => Math.floor(Date.UTC(y, 0, 1) / 86400000);
  if (unit === "Minute" || unit === "Hour") {
    const size = n * (unit === "Hour" ? 3600 : 60);
    const off = zoneOffsetFinder(tz);
    return (t) => {
      const day = localDay(tz, t);
      const y = yearOf(day);
      return `${y}:${Math.floor((t + off(t) - firstDay(y) * 86400) / size)}`;
    };
  }
  if (unit === "Day") {
    // Trading-day ordinal in the year.
    const ordinal = new Map<number, number>();
    return (t) => {
      const day = sessions.extended.tradingDay(t);
      const y = yearOf(day);
      let o = ordinal.get(day);
      if (o === undefined) {
        o = 0;
        for (let d = firstDay(y); d < day; d++) if (sessions.regular.isTradingDay(d)) o++;
        ordinal.set(day, o);
      }
      return `${y}:${Math.floor(o / n)}`;
    };
  }
  if (unit === "Week") {
    return (t) => {
      const day = sessions.extended.tradingDay(t);
      const y = yearOf(day);
      let s = yearStart.get(y);
      if (s === undefined) {
        const jan1 = firstDay(y);
        s = jan1 - ((new Date(jan1 * 86400000).getUTCDay() + 6) % 7); // Monday on or before 1 January
        yearStart.set(y, s);
      }
      return `${y}:${Math.floor(Math.floor((day - s) / 7) / n)}`;
    };
  }
  if (unit === "Month") {
    return (t) => {
      const d = new Date(sessions.extended.tradingDay(t) * 86400000);
      return `${d.getUTCFullYear()}:${Math.floor(d.getUTCMonth() / n)}`;
    };
  }
  // Bar: N chart bars counted from the first bar of the year.
  const yearFirst = new Map<number, number>();
  for (let i = 0; i < bars.length; i++) {
    const y = yearOf(localDay(tz, bars[i].time as number));
    if (!yearFirst.has(y)) yearFirst.set(y, i);
  }
  return (t) => {
    const ci = Math.max(0, chartIndexOf(bars, t, sec, sessions));
    const y = yearOf(localDay(tz, bars[ci].time as number));
    return `${y}:${Math.floor((ci - (yearFirst.get(y) ?? 0)) / n)}`;
  };
}

/** Period key of a bar time for the "Period" inputs (TPO studies share it). */
export const periodKeyerFor = periodKeyer;

function calcPeriodic(bars: Bar[], inputs: Record<string, unknown>, ctx: ProfileCalcContext | undefined) {
  const c = commonSetup(bars, ctx);
  if (!c.ready) return nothing(true);
  const sessions = c.sessions!;
  const grid = rowsGrid(inputs);
  const keyOf = periodKeyer(inputs, sessions, bars, c.sec);
  const rowsEach = "rowSize" in grid && grid.layout === "Number Of Rows" ? grid.rowSize : 24;
  const from = neededFrom(bars, (t) => keyOf(t), rowsEach);
  const { res } = ltfForChart(c.sec);
  const ltf = ctx!.lowerBars!(res, from);
  if (!ltf) return nothing(true);
  const start = lowerBound(ltf as unknown as { time: number }[], from);
  const groups = groupBy(ltf, start, (t) => keyOf(t));
  const made = makeProfiles(bars, ltf, groups, c.tick, grid, vaOf(inputs), c.sec, sessions);
  return finish(bars, ltf, made, c.tick, grid, vaOf(inputs), ext(inputs), vbpStyleOf(inputs, "Left"), c.textColor, false, false, volumeOf(inputs));
}

// ── Range profiles (visible range, auto anchored) ──────────────────────────

/** One profile over chart bars [i0, i1] from the bars of the span's lower timeframe. */
function rangeProfile(bars: Bar[], inputs: Record<string, unknown>, ctx: ProfileCalcContext, i0: number, i1: number, relative: boolean, placement: "Left" | "Right") {
  const c = commonSetup(bars, ctx);
  const from = bars[i0].time as number;
  const to = barEnd(bars, i1, c.sec, c.sessions);
  const res = ltfForSpan(to - from, c.seconds);
  const ltf = ctx.lowerBars!(res, from);
  if (!ltf) return nothing(true);
  const g0 = lowerBound(ltf as unknown as { time: number }[], from);
  const g1 = lowerBound(ltf as unknown as { time: number }[], to) - 1;
  if (g1 < g0) return nothing();
  const grid = rowsGrid(inputs);
  const p = buildProfile(ltf as unknown as LtfBar[], dirsOf(ltf), g0, g1, c.tick, grid, vaOf(inputs));
  if (!p) return nothing();
  return finish(bars, ltf, [{ g: { g0, g1 }, p, i0, i1 }], c.tick, grid, vaOf(inputs), { poc: false, vah: false, val: false }, vbpStyleOf(inputs, placement), c.textColor, relative, true, volumeOf(inputs));
}

function calcVisible(bars: Bar[], inputs: Record<string, unknown>, ctx: ProfileCalcContext | undefined) {
  const c = commonSetup(bars, ctx);
  if (!c.ready) return nothing(true);
  const left = ctx!.leftVisibleBarTime != null ? ctx!.leftVisibleBarTime / 1000 : (bars[0].time as number);
  const right = ctx!.rightVisibleBarTime != null ? ctx!.rightVisibleBarTime / 1000 : (bars[bars.length - 1].time as number);
  const i0 = lowerBound(bars as unknown as { time: number }[], left);
  const i1 = lowerBound(bars as unknown as { time: number }[], right + 1) - 1;
  if (i0 >= bars.length || i1 < i0) return nothing();
  return rangeProfile(bars, inputs, ctx!, i0, i1, true, "Right");
}

/** Start of the calendar period holding local day `day`: week (Monday), month, quarter, year, decade, century. */
function periodStartDay(day: number, unit: string): number {
  const d = new Date(day * 86400000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const at = (yy: number, mm: number) => Math.floor(Date.UTC(yy, mm, 1) / 86400000);
  if (unit === "Week") return day - ((d.getUTCDay() + 6) % 7);
  if (unit === "Month") return at(y, m);
  if (unit === "Quarter") return at(y, m - (m % 3));
  if (unit === "Year") return at(y, 0);
  if (unit === "Decade") return at(y - (y % 10), 0);
  return at(y - (y % 100), 0); // Century
}

/** "Auto" anchor of the chart interval: session (intraday), month (1D), quarter (2D-10D), year (11D-60D), decade. */
function autoAnchor(sec: number): string {
  if (sec < 86400) return "Session";
  const days = sec / 86400;
  if (days <= 1) return "Month";
  if (days <= 10) return "Quarter";
  if (days <= 60) return "Year";
  return "Decade";
}

function calcAutoAnchored(bars: Bar[], inputs: Record<string, unknown>, ctx: ProfileCalcContext | undefined) {
  const c = commonSetup(bars, ctx);
  if (!c.ready) return nothing(true);
  const sessions = c.sessions!;
  const last = bars.length - 1;
  let anchor = String(inputs["Anchor Period"] ?? "Auto");
  if (anchor === "Auto") anchor = autoAnchor(c.sec);
  let i0 = -1;
  if (anchor === "Highest High" || anchor === "Lowest Low" || anchor === "Highest Volume") {
    const len = Math.max(1, Math.round(Number(inputs.Length ?? 14)));
    const from = Math.max(0, bars.length - len);
    i0 = from;
    for (let i = from; i <= last; i++) {
      const b = bars[i];
      const a = bars[i0];
      if (anchor === "Highest High" ? b.high > a.high : anchor === "Lowest Low" ? b.low < a.low : (b.volume ?? 0) > (a.volume ?? 0)) i0 = i;
    }
  } else if (anchor === "Earnings" || anchor === "Dividends" || anchor === "Splits") {
    if (anchor === "Earnings") return nothing(); // no earnings dates in the data served
    const events = ctx!.chartEvents?.();
    if (!events) return nothing(true);
    const kind = anchor === "Dividends" ? "dividend" : "split";
    const ev = events.filter((e) => e.kind === kind).pop();
    if (!ev) return nothing();
    i0 = lowerBound(bars as unknown as { time: number }[], ev.time);
    if (isDaily(c.sec)) i0 = lowerBound(bars as unknown as { time: number }[], localToUtc(sessions.timeZone, localDay(sessions.timeZone, ev.time), 0));
  } else {
    const lastDay = sessions.extended.tradingDay(bars[last].time as number);
    if (anchor === "Session") {
      i0 = last;
      while (i0 > 0 && sessions.extended.tradingDay(bars[i0 - 1].time as number) === lastDay) i0--;
    } else {
      const startDay = periodStartDay(lastDay, anchor);
      i0 = last;
      while (i0 > 0 && sessions.extended.tradingDay(bars[i0 - 1].time as number) >= startDay) i0--;
    }
  }
  if (i0 < 0 || i0 > last) return nothing();
  return rangeProfile(bars, inputs, ctx!, i0, last, false, "Left");
}

// ── Registry entries ───────────────────────────────────────────────────────

type Input = IndicatorRegistryEntry["inputConfig"][number] & { display?: string; tooltip?: string; enabledWhen?: { id: string; value: string } };

const ROWS_LAYOUT: Input = { id: "rowsLayout", type: "string", title: "Rows Layout", defval: "Number Of Rows", options: ["Number Of Rows", "Ticks Per Row"] } as Input;
const ROW_SIZE: Input = { id: "rows", type: "int", title: "Row Size", defval: 24, min: 1, max: 1000000 } as Input;
const VOLUME: Input = { id: "volume", type: "string", title: "Volume", defval: "Up/Down", options: ["Up/Down", "Total", "Delta"] } as Input;
const VA_VOLUME: Input = { id: "vaVolume", type: "int", title: "Value Area Volume", defval: 70, min: 0, max: 100 } as Input;
const EXTENDS: Input[] = [
  { id: "extendPocRight", type: "bool", title: "Extend POC Right", defval: false },
  { id: "extendVAHRight", type: "bool", title: "Extend VAH Right", defval: false },
  { id: "extendVALRight", type: "bool", title: "Extend VAL Right", defval: false },
] as Input[];
const SESSIONS_INPUTS: Input[] = [
  { id: "profilesSessions", type: "string", title: "Sessions", defval: "All", options: SESSION_OPTIONS, tooltip: "Which part of each day makes a profile: All = one profile per day, Each = one per session (pre-market, market, post-market), Custom = the period set below; the other choices keep one session only." },
  { id: "customSession", type: "session", title: "Custom session", defval: "0930-1600", display: "data_window", enabledWhen: { id: "profilesSessions", value: "Custom" } },
  { id: "customSessionTZ", type: "string", title: "", defval: "Exchange", options: TIME_ZONES, display: "data_window", enabledWhen: { id: "profilesSessions", value: "Custom" }, tooltip: "Time zone of the custom session (hhmm-hhmm) when Sessions is Custom." },
] as unknown as Input[];

/** Developing POC / VA lines (step lines, hidden by default) and the status-line row values. */
function profilePlots(): IndicatorRegistryEntry["plotConfig"] {
  return [
    // Developing POC: the theme's text colour (read when drawn).
    { id: "developingPoc", title: "Developing POC", get color() { return themeTextColor(); }, lineWidth: 1, style: "stepline", defaultVisible: false },
    { id: "developingVAHigh", title: "Developing VA High", color: "#00BCD4", lineWidth: 1, style: "stepline", defaultVisible: false },
    { id: "developingVALow", title: "Developing VA Low", color: "#00BCD4", lineWidth: 1, style: "stepline", defaultVisible: false },
    { id: "upVolume", title: "Up Volume", color: "#26C6DA", display: "status_line" },
    { id: "downVolume", title: "Down Volume", color: "#EC407A", display: "status_line" },
    { id: "totalVolume", title: "Total Volume", get color() { return themeTextColor(); }, display: "status_line" },
  ] as IndicatorRegistryEntry["plotConfig"];
}

/** Extra fields of a profile entry the app reads (style tab, dialog row). */
export type ProfileEntryMeta = { profile: { placement: "Left" | "Right"; histogramBox: boolean } };

function entry(
  id: string,
  name: string,
  shortName: string,
  inputs: Input[],
  calc: (bars: Bar[], inputs: Record<string, unknown>, ctx: ProfileCalcContext | undefined) => unknown,
  meta: ProfileEntryMeta["profile"],
  usesVisibleRange = false,
): IndicatorRegistryEntry & ProfileEntryMeta {
  return {
    id,
    group: "standard",
    name,
    shortName,
    category: "Volume",
    overlay: true,
    metadata: { title: name, shortTitle: shortName, overlay: true },
    inputConfig: inputs as IndicatorRegistryEntry["inputConfig"],
    plotConfig: profilePlots(),
    defaultInputs: Object.fromEntries(inputs.map((i) => [i.id, i.defval])),
    ...(usesVisibleRange ? { usesVisibleRange: true } : {}),
    calculate: ((bars: Bar[], inp: Record<string, unknown>, ctx?: ProfileCalcContext) => calc(bars, inp ?? {}, ctx)) as unknown as IndicatorRegistryEntry["calculate"],
    profile: meta,
  } as IndicatorRegistryEntry & ProfileEntryMeta;
}

/** The reference profile studies show no input in the status line (their inputs' display leaves it out). */
const statusInputs = (list: Input[], _shown: string[]) => list.map((i) => ({ ...i, display: i.display ?? "data_window" }) as Input);

export const SESSION_VP_ENTRY = entry(
  "vbp-sessions",
  "Session volume profile",
  "SVP",
  statusInputs([...SESSIONS_INPUTS, VOLUME, VA_VOLUME, ROWS_LAYOUT, ROW_SIZE, ...EXTENDS], ["profilesSessions", "volume"]),
  (b, i, ctx) => calcSessions(b, i, ctx, rowsGrid(i), false),
  { placement: "Left", histogramBox: true },
);

export const SESSION_VP_HD_ENTRY = entry(
  "vbp-sessions-hd",
  "Session volume profile HD",
  "SVP HD",
  statusInputs([...SESSIONS_INPUTS, VOLUME, VA_VOLUME, ...EXTENDS], ["profilesSessions", "volume"]),
  calcSessionsHD,
  { placement: "Left", histogramBox: true },
  true,
);

export const PERIODIC_VP_ENTRY = entry(
  "vbp-periodic",
  "Periodic volume profile",
  "PVP",
  statusInputs([
    { id: "periodsNum", type: "int", title: "Period", defval: 1, min: 1, max: 1000000, inline: "period" } as Input,
    { id: "period", type: "string", title: "", defval: "Bar", options: ["Bar", "Minute", "Hour", "Day", "Week", "Month"], inline: "period" } as Input,
    VOLUME, VA_VOLUME, ROWS_LAYOUT, ROW_SIZE, ...EXTENDS,
  ], ["periodsNum", "period", "volume"]),
  calcPeriodic,
  { placement: "Left", histogramBox: true },
);

export const VISIBLE_VP_ENTRY = entry(
  "vbp-visible",
  "Visible range volume profile",
  "VRVP",
  statusInputs([ROWS_LAYOUT, ROW_SIZE, VOLUME, VA_VOLUME], ["rowsLayout", "rows", "volume"]),
  calcVisible,
  { placement: "Right", histogramBox: false },
  true,
);

export const AUTO_ANCHORED_VP_ENTRY = entry(
  "vbp-auto-anchored",
  "Auto anchored volume profile",
  "AAVP",
  statusInputs([
    { id: "Anchor Period", type: "string", title: "Anchor Period", defval: "Auto", options: ["Auto", "Highest High", "Lowest Low", "Highest Volume", "Session", "Week", "Month", "Year", "Quarter", "Decade", "Century", "Earnings", "Dividends", "Splits"] } as Input,
    { id: "Length", type: "int", title: "Length", defval: 14, min: 1, max: 2147483647, tooltip: "Bars searched for the Highest High, Lowest Low and Highest Volume anchors." } as Input,
    ROWS_LAYOUT, ROW_SIZE, VOLUME, VA_VOLUME,
  ], ["Anchor Period", "Length", "rowsLayout", "rows", "volume", "vaVolume"]),
  calcAutoAnchored,
  { placement: "Left", histogramBox: true },
);

/** The volume profile studies, in the reference list order. */
export const VBP_ENTRIES = [AUTO_ANCHORED_VP_ENTRY, PERIODIC_VP_ENTRY, SESSION_VP_ENTRY, SESSION_VP_HD_ENTRY, VISIBLE_VP_ENTRY];

/** Profile entry metadata of a registry entry (null = not a profile study). */
export function profileMetaOf(e: IndicatorRegistryEntry | null | undefined): ProfileEntryMeta["profile"] | null {
  return (e as (IndicatorRegistryEntry & Partial<ProfileEntryMeta>) | null | undefined)?.profile ?? null;
}
