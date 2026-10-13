/**
 * Greedy strategy (built-in): stop entries on gaps (at the previous high / low) and in the trend of the bar, up to
 * 100 entries; a take profit and a stop loss `tp` / `sl` ticks from the average price, as one OCA reduce group;
 * trading stops for the day after the maximum number of filled orders.
 */
import { compare } from 'oakscriptjs';
import { high, input, low, strategy, syminfo } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';

const { gt, lt } = compare;

function body(): void {
  strategy('Greedy strategy', { shorttitle: 'Greedy str', pyramiding: 100, calc_on_order_fills: false, overlay: true });

  const tp = input.int(10, 'Take profit');
  const sl = input.int(10, 'Stop loss');
  const maxidf = input.int(5, 'Max intraday filled orders');

  strategy.eachBar((c) => {
    strategy.risk.max_intraday_filled_orders(maxidf);
    const high1 = c.get(high, 1);
    const low1 = c.get(low, 1);
    const upGap = gt(c.open, high1);
    const dnGap = lt(c.open, low1);
    const pos = strategy.position_size;
    const dn = pos < 0 && gt(c.open, c.close);
    const up = pos > 0 && lt(c.open, c.close);
    if (upGap) strategy.entry('GapUp', strategy.long, { stop: high1 });
    else strategy.cancel('GapUp');
    if (dn) strategy.entry('Dn', strategy.short, { stop: c.close });
    else strategy.cancel('Dn');
    if (dnGap) strategy.entry('GapDn', strategy.short, { stop: low1 });
    else strategy.cancel('GapDn');
    if (up) strategy.entry('Up', strategy.long, { stop: c.close });
    else strategy.cancel('Up');

    const size = strategy.position_size;
    const XQty = size < 0 ? -size : size;
    const dir = size < 0 ? -1 : 1;
    const lmP = strategy.position_avg_price + dir * tp * syminfo.mintick;
    const slP = strategy.position_avg_price - dir * sl * syminfo.mintick;
    const revCond = size > 0 ? dnGap : size < 0 ? upGap : false;
    if (!revCond && XQty > 0) {
      const side = size < 0 ? strategy.long : strategy.short;
      strategy.order('TP', side, { qty: XQty, limit: lmP, stop: NaN, comment: 'TPSL', oca_type: strategy.oca.reduce, oca_name: 'TPSL' });
      strategy.order('SL', side, { qty: XQty, limit: NaN, stop: slP, comment: 'TPSL', oca_type: strategy.oca.reduce, oca_name: 'TPSL' });
    }
    if (XQty === 0 || revCond) {
      strategy.cancel('TP');
      strategy.cancel('SL');
    }
  });
}

export const greedy: ScriptStrategy = {
  key: 'greedy',
  source: { id: 'STD;Greedy%1Strategy', name: 'Greedy strategy', author: '' },
  body,
};
