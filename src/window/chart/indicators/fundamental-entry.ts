/*
 * Fundamentals metrics as studies: registry entries `fund:<metric>:<period>`
 * (a statement metric on its quarters, years or trailing twelve months) and
 * `fund:<metric>` (a price metric, one value per bar), built on demand from
 * the metric table (data/fundamental-metrics.ts).
 *
 * A statement metric is a step line with diamonds in its own pane: the value
 * of each period from the day its results were released, with a label under
 * each step (value, change from the previous period, period). Inputs:
 * Symbol (empty = the chart's), Currency, Show change (percentage or
 * absolute) and Show date. A price metric is a line, input Symbol.
 */
import type { IndicatorRegistryEntry } from 'lightweight-charts-indicators';
import type { Bar } from 'oakscriptjs';
import { METRICS, metricDef, metricPoints, priceInputs, type MetricDef, type MetricKind, type MetricPeriod } from '../../../data/fundamental-metrics';
import type { StudyCalcContext } from './indicator-layer';
import type { FundamentalLabel } from './fundamental-labels';

export const FUNDAMENTAL_PREFIX = 'fund:';

export function isFundamentalId(id: string): boolean {
  return id.startsWith(FUNDAMENTAL_PREFIX);
}

/** Study type id of a metric on a period (none for a price metric). */
export function fundamentalId(key: string, period?: MetricPeriod): string {
  return `${FUNDAMENTAL_PREFIX}${key}${period ? `:${period}` : ''}`;
}

/** Plot colour of a metric (reference blue, unless the metric has its own). */
const DEFAULT_COLOR = '#2962FF';
const MINUS = '−';

const CURRENCY_SIGNS: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', CNY: '¥', INR: '₹' };

/** "22.134M": letters K / M / B / T, at most `decimals` decimals, trailing zeros trimmed. */
export function abbreviate(v: number, decimals = 3): string {
  const a = Math.abs(v);
  const [div, letter] = a >= 1e12 ? [1e12, 'T'] : a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : a >= 1e3 ? [1e3, 'K'] : [1, ''];
  const text = String(+(a / div).toFixed(decimals));
  return (v < 0 ? MINUS : '') + text + letter;
}

/** A metric value as its label writes it (reference: "$-1.061M", "$-0.110", "34.30%", "0.00": the currency sign
 *  first, then an ASCII hyphen for a negative value; amounts and share counts abbreviated, other values with the
 *  metric's legend decimals, trailing zeros kept). */
export function formatMetricValue(v: number, kind: MetricKind, currency: string, precision?: number): string {
  const sign = CURRENCY_SIGNS[currency] ?? '';
  const minus = v < 0 ? '-' : '';
  switch (kind) {
    case 'money': return sign + minus + abbreviate(Math.abs(v));
    case 'perShare': return sign + minus + Math.abs(v).toFixed(precision ?? 3);
    case 'shares': return minus + abbreviate(Math.abs(v));
    case 'percent': return `${minus}${Math.abs(v).toFixed(precision ?? 2)}%`;
    default: return minus + Math.abs(v).toFixed(precision ?? 2);
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Jun '20" of a period end. */
function periodText(end: string): string {
  const d = new Date(`${end}T00:00:00Z`);
  return `${MONTHS[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(-2)}`;
}

/** Change label: "(+6.81%)" (a percentage metric: the difference in points, "(-5.28%)") or the absolute change. */
function changeText(v: number, prev: number, mode: string, kind: MetricKind, currency: string, precision?: number): string | null {
  if (mode === 'Absolute' || kind === 'percent') {
    const d = v - prev;
    return `(${d >= 0 ? '+' : ''}${formatMetricValue(d, kind, currency, precision)})`;
  }
  if (prev === 0) return null;
  const p = ((v - prev) / Math.abs(prev)) * 100;
  return `(${p >= 0 ? '+' : '-'}${Math.abs(p).toFixed(2)}%)`;
}

/** Unix seconds of a release day (00:00 UTC): bars from that day on know the period. */
const daySec = (d: string) => Date.parse(`${d}T00:00:00Z`) / 1000;

/** Legend / scale number format of a metric (the reference's: amounts as volumes, percentages and ratios with
 *  2 decimals, per-share amounts with 3, EPS with 4). */
function formatOf(def: MetricDef): { type: 'price' | 'volume' | 'percent'; precision?: number } {
  if (def.kind === 'money' || def.kind === 'shares') return { type: 'volume' };
  if (def.kind === 'percent') return { type: 'percent', precision: def.precision ?? 2 };
  return { type: 'price', precision: def.precision ?? (def.kind === 'perShare' ? 3 : 2) };
}

function statementEntry(id: string, def: MetricDef, period: MetricPeriod): IndicatorRegistryEntry {
  const title = `${def.short ?? def.name} · ${period}`;
  const color = def.color ?? DEFAULT_COLOR;
  return {
    id,
    group: 'standard',
    name: def.name,
    shortName: title,
    category: 'Fundamentals',
    overlay: false,
    format: formatOf(def),
    metadata: { title: def.name, shortTitle: title, overlay: false },
    inputConfig: [
      { id: 'symbol', type: 'symbol', title: 'Symbol', defval: '' },
      { id: 'currency', type: 'string', title: 'Currency', defval: 'Default', options: ['Default'], display: 'none' },
      { id: 'showChange', type: 'bool', title: 'Show Change', defval: true, inline: 'change' },
      { id: 'changeMode', type: 'string', title: '', defval: 'Percentage', options: ['Percentage', 'Absolute'], inline: 'change', display: 'none' },
      { id: 'showDate', type: 'bool', title: 'Show Date', defval: true },
    ],
    plotConfig: [{ id: 'value', title: def.name, color, lineWidth: 2, style: 'stepline_diamond' }],
    defaultInputs: { symbol: '', currency: 'Default', showChange: true, changeMode: 'Percentage', showDate: true },
    calculate(bars: Bar[], inputs: Record<string, unknown>, ctx?: StudyCalcContext) {
      const metadata = { title: def.name, shorttitle: title, overlay: false };
      const f = ctx?.fundamentals?.(String(inputs?.symbol ?? ''));
      if (f === undefined) return { metadata, plots: { value: [] }, pending: true };
      if (f === null) return { metadata, plots: { value: [] } };
      const points = metricPoints(f, def, period);
      const currency = f.currency ?? 'USD';
      const value: { time: number; value: number }[] = [];
      const labels: FundamentalLabel[] = [];
      let k = -1;
      let shown = -1;
      for (const b of bars) {
        const t = b.time as unknown as number;
        while (k + 1 < points.length && daySec(points[k + 1].date) <= t) k++;
        value.push({ time: t, value: k >= 0 ? points[k].value : NaN });
        if (k >= 0 && k !== shown) {
          shown = k;
          const p = points[k];
          const precision = formatOf(def).precision;
          const lines = [formatMetricValue(p.value, def.kind, currency, precision)];
          if (inputs?.showChange !== false && k > 0) {
            const c = changeText(p.value, points[k - 1].value, String(inputs?.changeMode ?? 'Percentage'), def.kind, currency, precision);
            if (c) lines.push(c);
          }
          if (inputs?.showDate !== false) lines.push(periodText(p.end));
          labels.push({ time: t, value: p.value, lines });
        }
      }
      return { metadata, plots: { value }, fundamentalLabels: { value: labels } };
    },
  } as unknown as IndicatorRegistryEntry;
}

function priceEntry(id: string, def: MetricDef): IndicatorRegistryEntry {
  const title = def.short ?? def.name;
  return {
    id,
    group: 'standard',
    name: def.name,
    shortName: title,
    category: 'Fundamentals',
    overlay: false,
    format: formatOf(def),
    metadata: { title: def.name, shortTitle: title, overlay: false },
    inputConfig: [{ id: 'symbol', type: 'symbol', title: 'Symbol', defval: '' }],
    plotConfig: [{ id: 'value', title: def.name, color: def.color ?? DEFAULT_COLOR, lineWidth: 2, style: 'linebr' }],
    defaultInputs: { symbol: '' },
    calculate(bars: Bar[], inputs: Record<string, unknown>, ctx?: StudyCalcContext) {
      const metadata = { title: def.name, shorttitle: title, overlay: false };
      const f = ctx?.fundamentals?.(String(inputs?.symbol ?? ''));
      if (f === undefined) return { metadata, plots: { value: [] }, pending: true };
      if (f === null) return { metadata, plots: { value: [] } };
      const known = priceInputs(f);
      const value: { time: number; value: number }[] = [];
      let k = -1;
      for (const b of bars) {
        const t = b.time as unknown as number;
        while (k + 1 < known.length && daySec(known[k + 1].date) <= t) k++;
        const v = k >= 0 ? def.price!(b.close, known[k].ttm, known[k].q) : null;
        value.push({ time: t, value: v === null || !Number.isFinite(v) ? NaN : v });
      }
      return { metadata, plots: { value } };
    },
  } as unknown as IndicatorRegistryEntry;
}

const entries = new Map<string, IndicatorRegistryEntry>();

/** Registry entry of a metric study type id, or undefined for an unknown one. */
export function getFundamentalEntry(id: string): IndicatorRegistryEntry | undefined {
  if (!isFundamentalId(id)) return undefined;
  let e = entries.get(id);
  if (e) return e;
  const [key, period] = id.slice(FUNDAMENTAL_PREFIX.length).split(':');
  const def = metricDef(key);
  if (!def) return undefined;
  if (def.periods.length === 0) {
    if (period) return undefined;
    e = priceEntry(id, def);
  } else {
    if (!def.periods.includes(period as MetricPeriod)) return undefined;
    e = statementEntry(id, def, period as MetricPeriod);
  }
  entries.set(id, e);
  return e;
}

/** Every metric (dialog listing). */
export { METRICS };
