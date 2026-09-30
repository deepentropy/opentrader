/** Pivot Points Strategy (llbot): limit entries at the support / resistance levels, exits at the pivot. */
import { compare } from 'oakscriptjs';
import { close, color, eachBar, input, plot, seriesOf, strategy, timeframe } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';

const { gt, lt, ne } = compare;

/** [P, R1, S1, R2, S2, R3, S3, R4, S4, R5, S5] of a completed period (h, l, c, o) and the new period open. */
function levelsOf(type: string, h: number, l: number, c: number, o: number, open: number): number[] {
  const na = NaN;
  switch (type) {
    case 'Fibonacci': {
      const p = (h + l + c) / 3;
      const r = h - l;
      return [p, p + 0.382 * r, p - 0.382 * r, p + 0.618 * r, p - 0.618 * r, p + r, p - r, na, na, na, na];
    }
    case 'Woodie': {
      const p = (h + l + 2 * open) / 4;
      const r1 = 2 * p - l;
      const s1 = 2 * p - h;
      const r3 = h + 2 * (p - l);
      const s3 = l - 2 * (h - p);
      return [p, r1, s1, p + (h - l), p - (h - l), r3, s3, r3 + (h - l), s3 - (h - l), na, na];
    }
    case 'Classic': {
      const p = (h + l + c) / 3;
      const r = h - l;
      return [p, 2 * p - l, 2 * p - h, p + r, p - r, p + 2 * r, p - 2 * r, p + 3 * r, p - 3 * r, na, na];
    }
    case 'DM': {
      const x = o === c ? h + l + 2 * c : c > o ? 2 * h + l + c : 2 * l + h + c;
      return [x / 4, x / 2 - l, x / 2 - h, na, na, na, na, na, na, na, na];
    }
    case 'Camarilla': {
      const p = (h + l + c) / 3;
      const r = h - l;
      const r3 = c + (r * 1.1) / 4;
      const s3 = c - (r * 1.1) / 4;
      const r4 = c + (r * 1.1) / 2;
      const s4 = c - (r * 1.1) / 2;
      const r5 = r4 + 1.168 * (r4 - r3);
      const s5 = s4 - 1.168 * (s3 - s4);
      return [p, c + (r * 1.1) / 12, c - (r * 1.1) / 12, c + (r * 1.1) / 6, c - (r * 1.1) / 6, r3, s3, r4, s4, r5, s5];
    }
    default: {
      // Traditional
      const p = (h + l + c) / 3;
      return [
        p,
        p * 2 - l,
        p * 2 - h,
        p + (h - l),
        p - (h - l),
        p * 2 + (h - 2 * l),
        p * 2 - (2 * h - l),
        p * 3 + (h - 3 * l),
        p * 3 - (3 * h - l),
        p * 4 + (h - 4 * l),
        p * 4 - (4 * h - l),
      ];
    }
  }
}

function body(): void {
  strategy('Pivot Points Strategy', {
    overlay: true,
    initial_capital: 10000,
    commission_type: strategy.commission.percent,
    commission_value: 0.1,
    default_qty_type: strategy.percent_of_equity,
    default_qty_value: 18,
    slippage: 3,
    pyramiding: 5,
    fill_orders_on_standard_ohlc: true,
  });

  const pivotType = input.string('Traditional', 'Type', {
    options: ['Traditional', 'Fibonacci', 'Woodie', 'Classic', 'DM', 'Camarilla'],
  });
  const pivotAnchor = timeframe.change(input.timeframe('W', 'Timeframe'));

  // ta.pivot_point_levels(pivotType, pivotAnchor): levels of the last completed anchor period.
  const levels: number[][] = Array.from({ length: 11 }, () => []);
  let current = Array<number>(11).fill(NaN);
  let periodHigh = NaN;
  let periodLow = NaN;
  let periodOpen = NaN;
  eachBar((c) => {
    if (c.i === 0) {
      periodHigh = c.high;
      periodLow = c.low;
      periodOpen = c.open;
    } else if (c.get(pivotAnchor) === 1) {
      current = levelsOf(pivotType, periodHigh, periodLow, c.get(close, 1), periodOpen, c.open);
      periodHigh = c.high;
      periodLow = c.low;
      periodOpen = c.open;
    } else {
      periodHigh = Math.max(periodHigh, c.high);
      periodLow = Math.min(periodLow, c.low);
    }
    for (let k = 0; k < 11; k++) levels[k]!.push(current[k]!);
  });
  const [p, r1, s1, r2, s2, r3, s3, r4, s4, r5, s5] = levels.map((v) => seriesOf(v));

  let valid = true;
  const avgPrice: number[] = [];
  strategy.eachBar((c) => {
    const pv = c.get(p!);
    if (gt(c.high, pv) && lt(c.low, pv)) {
      valid = false;
      strategy.cancel_all();
    }
    if (ne(pv, c.get(p!, 1))) valid = true;
    if (valid) {
      strategy.entry('long1', strategy.long, { limit: c.get(s1!) });
      strategy.entry('long2', strategy.long, { limit: c.get(s2!) });
      strategy.entry('long3', strategy.long, { limit: c.get(s3!) });
      strategy.entry('short1', strategy.short, { limit: c.get(r1!) });
      strategy.entry('short2', strategy.short, { limit: c.get(r2!) });
      strategy.entry('short3', strategy.short, { limit: c.get(r3!) });
      strategy.exit('close long1', { from_entry: 'long1', limit: pv });
      strategy.exit('close long2', { from_entry: 'long2', limit: pv });
      strategy.exit('close long3', { from_entry: 'long3', limit: pv });
      strategy.exit('close short1', { from_entry: 'short1', limit: pv });
      strategy.exit('close short2', { from_entry: 'short2', limit: pv });
      strategy.exit('close short3', { from_entry: 'short3', limit: pv });
      valid = false;
    }
    avgPrice.push(strategy.position_avg_price);
  });

  const circles = { linewidth: 1, style: 'circles' as const };
  plot(seriesOf(avgPrice), 'Average Price', { color: color.gray, ...circles });
  plot(p!, 'P', { color: color.white, ...circles });
  plot(r1!, 'R1', { color: color.red, ...circles });
  plot(s1!, 'S1', { color: color.teal, ...circles });
  plot(r2!, 'R2', { color: color.red, ...circles });
  plot(s2!, 'S2', { color: color.teal, ...circles });
  plot(r3!, 'R3', { color: color.red, ...circles });
  plot(s3!, 'S3', { color: color.teal, ...circles });
  plot(r4!, 'R4', { color: color.red, ...circles });
  plot(s4!, 'S4', { color: color.teal, ...circles });
  plot(r5!, 'R5', { color: color.red, ...circles });
  plot(s5!, 'S5', { color: color.teal, ...circles });
}

export const pivotPoints: ScriptStrategy = {
  key: 'pivot-points',
  source: { id: 'PUB;4f6b4fbf706c4a909034eb9b937a9180', name: 'Pivot Points Strategy', author: 'llbot' },
  body,
};
