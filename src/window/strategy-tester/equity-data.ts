/*
 * Performance (equity) chart data, as the reference app 3.4.1 builds it
 * (.tmp/backtester/design/doc §14.9 - §14.13, the reference app modules 240420,
 * 408422, 40578, 459650):
 * - one Cumulative PnL point per trade (the open trade included) at its exit
 *   time; trades exiting at the same time are shifted +1 ms each;
 * - Trades excursions: [run-up, profit > 0, -drawdown, loss < 0] per trade;
 * - Percent scale: PnL / initial capital, excursions in the trade's percent;
 * - Whitespaces: empty time slots between exits (proportional time axis);
 * - run-up and drawdown periods (generateRunupDrawdownPeriods).
 */
import type { BacktestReport, Trade } from "../../backtester/types";

export type EquityPoint = {
  /** Chart time, UNIX seconds (fractional: +1 ms per same-time exit). */
  time: number;
  value: number;
  buyHold: number;
  /** [run-up, profit if > 0, -drawdown, loss if < 0]. */
  excursions: [number, number, number, number];
  tradeIndex: number;
};

export type PeriodType = "runup" | "drawdown";
export type EquityPeriod = {
  type: PeriodType;
  /** UNIX seconds, same axis as EquityPoint.time. */
  startTime: number;
  endTime: number;
  startValue: number;
  endValue: number;
  startIndex: number;
  endIndex: number;
  change: number;
  relativeChange: number;
};

/** Exit times strictly ascending: a time <= the previous one becomes previous + 1 ms. */
function ascendingMs(t: number, prev: number | null): number {
  return prev !== null && t <= prev ? prev + 1 : t;
}

export function equityPoints(r: BacktestReport, percent: boolean): EquityPoint[] {
  const cap = r.properties.initialCapital;
  const out: EquityPoint[] = [];
  let prev: number | null = null;
  r.trades.forEach((t: Trade, i) => {
    const ms = ascendingMs(t.exit.time, prev);
    prev = ms;
    const bh = r.buyHold[t.exit.bar] ?? 0;
    const ex: [number, number, number, number] = percent
      ? [t.runUpPercent, t.profitPercent > 0 ? t.profitPercent : 0, -t.drawdownPercent, t.profitPercent < 0 ? t.profitPercent : 0]
      : [t.runUp, t.profit > 0 ? t.profit : 0, -t.drawdown, t.profit < 0 ? t.profit : 0];
    out.push({
      time: ms / 1000,
      value: percent ? t.cumProfit / cap : t.cumProfit,
      buyHold: percent ? bh / cap : bh,
      excursions: ex,
      tradeIndex: i,
    });
  });
  return out;
}

/** Chart interval in seconds ("5" -> 300, "1D" -> 86400, "1W", "1M" as Pine timeframe.in_seconds). */
export function intervalSeconds(res: string): number {
  const m = /^(\d*)([SDWM]?)$/i.exec(res.trim());
  if (!m) return 86400;
  const n = Number(m[1] || 1);
  switch (m[2].toUpperCase()) {
    case "S": return n;
    case "D": return n * 86400;
    case "W": return n * 604800;
    case "M": return n * 2628003;
    default: return n * 60;
  }
}

/**
 * Whitespace times inserted between points (Scale > Whitespaces): grid
 * g = step * max(1, ceil(span / 2000 / step)); between two exits
 * round(gap / g) - 1 evenly spaced slots.
 */
export function whitespaceTimes(points: EquityPoint[], stepSec: number): number[] {
  if (points.length < 2 || stepSec <= 0) return [];
  const span = points[points.length - 1].time - points[0].time;
  const g = stepSec * Math.max(1, Math.ceil(span / 2000 / stepSec));
  const out: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1].time;
    const gap = points[i].time - a;
    const n = Math.round(gap / g) - 1;
    for (let k = 1; k <= n; k++) out.push(a + (gap * k) / (n + 1));
  }
  return out;
}

type Sample = { time: number; value: number; delta: number; pending: boolean };
type Cursor = { index: number; time: number; value: number };
type Dd = { startIndex: number; startValue: number; startTime: number; minValue: number; recoveryStartTime: number; recoveryStartIndex: number };
type Ru = { startIndex: number; startValue: number; startTime: number; endIndex: number; endValue: number; endTime: number };

/**
 * Run-up and drawdown periods of the cumulative PnL (the reference app module
 * 408422 generateRunupDrawdownPeriods, minimum 2 trades). The first trade is
 * the starting reference, the open trade is skipped. A drawdown is kept when
 * its low is 2+ trades after its start or deeper than 5 % of the equity at
 * its start; smaller dips stay inside the run-up.
 */
export function runupDrawdownPeriods(samples: Sample[], capital: number, minTrades = 2): EquityPeriod[] {
  if (samples.length < 2) return [];
  const out: Omit<EquityPeriod, "change" | "relativeChange">[] = [];
  const spans = (a: number, b: number) => b - a >= minTrades;
  const significant = (d: Dd) => {
    if (spans(d.startIndex, d.recoveryStartIndex)) return true;
    const base = d.startValue + capital;
    return base > 0 && Math.abs(d.minValue - d.startValue) / base > 0.05;
  };
  const pushRunup = (ru: Ru | null): Ru | null => {
    if (ru && spans(ru.startIndex, ru.endIndex) && ru.endValue > ru.startValue) {
      out.push({ type: "runup", ...ru });
      return null;
    }
    return ru;
  };
  const pushDrawdown = (d: Dd) =>
    out.push({ type: "drawdown", startTime: d.startTime, startValue: d.startValue, endTime: d.recoveryStartTime, endValue: d.minValue, startIndex: d.startIndex, endIndex: d.recoveryStartIndex });

  let dd: Dd | null = null;
  let ru: Ru | null = null;
  const prev: Cursor = { index: 0, time: samples[0].time, value: samples[0].value };
  const cur: Cursor = { index: 1, time: prev.time, value: prev.value };
  let peak = prev.value;
  const advance = () => { prev.index = cur.index; prev.time = cur.time; prev.value = cur.value; };
  for (; cur.index < samples.length; cur.index++) {
    const s = samples[cur.index];
    if (s.pending) continue;
    cur.value = s.value;
    cur.time = s.time;
    const last = cur.index === samples.length - 1 || !!samples[cur.index + 1]?.pending;
    if (s.delta < 0 && dd === null) {
      if (ru) { ru.endIndex = prev.index; ru.endTime = prev.time; ru.endValue = prev.value; }
      dd = {
        startIndex: prev.index, startValue: prev.value, startTime: prev.time,
        minValue: cur.value < prev.value ? cur.value : prev.value,
        recoveryStartTime: cur.value < prev.value ? cur.time : prev.time,
        recoveryStartIndex: cur.value < prev.value ? cur.index : prev.index,
      };
      peak = prev.value;
      advance();
      continue;
    }
    if (s.delta > 0 && dd === null && ru === null) {
      const up = cur.value > prev.value;
      ru = { startIndex: prev.index, startValue: prev.value, startTime: prev.time, endIndex: up ? cur.index : prev.index, endValue: up ? cur.value : prev.value, endTime: up ? cur.time : prev.time };
    }
    if (dd === null) {
      if (ru) { ru.endIndex = cur.index; ru.endTime = cur.time; ru.endValue = cur.value; }
      advance();
      continue;
    }
    if (dd.minValue > cur.value) { dd.minValue = cur.value; dd.recoveryStartTime = cur.time; dd.recoveryStartIndex = cur.index; }
    if (spans(dd.startIndex, cur.index) && (peak <= cur.value || last)) {
      if (significant(dd)) {
        ru = pushRunup(ru);
        pushDrawdown(dd);
        if (last) {
          if (spans(dd.recoveryStartIndex, cur.index)) {
            out.push({ type: "runup", startValue: dd.minValue, startTime: dd.recoveryStartTime, endValue: cur.value, endTime: cur.time, startIndex: dd.recoveryStartIndex, endIndex: cur.index });
          }
          ru = null;
        } else {
          ru = { startIndex: dd.recoveryStartIndex, startValue: dd.minValue, startTime: dd.recoveryStartTime, endIndex: dd.recoveryStartIndex, endValue: dd.minValue, endTime: dd.recoveryStartTime };
        }
      } else if (ru) {
        ru.endIndex = cur.index; ru.endValue = cur.value; ru.endTime = cur.time;
      } else {
        ru = { startIndex: dd.startIndex, startValue: dd.startValue, startTime: dd.startTime, endIndex: cur.index, endValue: cur.value, endTime: cur.time };
      }
      peak = cur.value;
      dd = null;
    }
    advance();
  }
  pushRunup(ru);
  if (dd !== null && significant(dd)) pushDrawdown(dd);
  return out.map((p) => {
    const base = p.startValue + capital;
    return { ...p, change: Math.abs(p.endValue - p.startValue), relativeChange: base === 0 ? 0 : Math.abs(p.endValue - p.startValue) / base };
  });
}

/** Periods of a report: one sample per trade, time = exit (after the +1 ms shift), value = cumulative PnL. */
export function reportPeriods(r: BacktestReport, points: EquityPoint[]): EquityPeriod[] {
  const samples = r.trades.map((t, i) => ({ time: points[i]?.time ?? t.exit.time / 1000, value: t.cumProfit, delta: t.profit, pending: t.open }));
  return runupDrawdownPeriods(samples, r.properties.initialCapital);
}
