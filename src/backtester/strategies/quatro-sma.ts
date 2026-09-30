/**
 * Quatro SMA Strategy [4h] (wielkieef), Pine v5.
 * SMA 4/16/32 alignment + SMA 200 filter + volume spike; three strategy.exit
 * orders without from_entry (25 %, 50 %, 100 %) with take profit / stop loss
 * in ticks from the average price. 50 % of equity, 0.03 % commission.
 */
import type { StrategyDefinition } from '../run';
import { closeOf, gt, lt, round, sma, volumeOf } from '../pine';

export interface QuatroSmaInputs {
  volSmaLength: number;
  length1: number;
  length2: number;
  length3: number;
  lengthSMA: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  q1: number;
  q2: number;
  q3: number;
}

export const quatroSmaStrategy: StrategyDefinition<QuatroSmaInputs> = {
  key: 'quatro-sma',
  title: 'Quatro SMA',
  source: { id: 'PUB;e0cbb7167bd84e8f93295f8377b179b9', name: 'Quatro SMA Strategy [4h]', author: 'wielkieef' },
  properties: {
    pyramiding: 1,
    initialCapital: 10000,
    defaultQtyType: 'percent_of_equity',
    defaultQtyValue: 50,
    commissionType: 'percent',
    commissionValue: 0.03,
  },
  defaultInputs: { volSmaLength: 40, length1: 4, length2: 16, length3: 32, lengthSMA: 200, sl: 10, tp1: 10, tp2: 20, tp3: 50, q1: 25, q2: 50, q3: 100 },
  inputs: [
    { id: 'volSmaLength', title: 'Volume lenght  ', type: 'int', min: 1 },
    { id: 'length1', title: '\u2003\u20031-SMA Lenght', type: 'int', min: 1, group: 'SMA' },
    { id: 'length2', title: '\u2003\u20032-SMA Lenght', type: 'int', min: 1, group: 'SMA' },
    { id: 'length3', title: '\u2003\u20033-SMA Lenght', type: 'int', min: 1, group: 'SMA' },
    { id: 'lengthSMA', title: 'Lenght SMA', type: 'int' },
    { id: 'sl', title: '% Stop Loss', type: 'float', step: 0.1 },
    { id: 'tp1', title: '\u2003\u2003TP 1', type: 'float', min: 1, step: 0.1 },
    { id: 'tp2', title: '\u2003\u2003TP 2', type: 'float', min: 1, step: 0.1 },
    { id: 'tp3', title: '\u2003\u2003TP 3', type: 'float', min: 1, step: 0.1 },
    { id: 'q1', title: '\u2003\u2003% TP 1 Q ', type: 'int', min: 1, step: 10 },
    { id: 'q2', title: '\u2003\u2003% TP 2 Q ', type: 'int', min: 1, step: 10 },
    { id: 'q3', title: '\u2003\u2003% TP 3 Q ', type: 'int', min: 1, step: 10 },
  ],
  setup(bars, inp, sym) {
    const close = closeOf(bars);
    const volume = volumeOf(bars);
    const volSma = sma(volume, inp.volSmaLength);
    const s1 = sma(close, inp.length1);
    const s2 = sma(close, inp.length2);
    const s3 = sma(close, inp.length3);
    const s200 = sma(close, inp.lengthSMA);
    return (i, s) => {
      const volCond = gt(volume[i], volSma[i] * 2.5);
      const longMa = gt(s1[i], s2[i]) && gt(s2[i], s3[i]);
      const shortMa = lt(s1[i], s2[i]) && lt(s2[i], s3[i]);
      if (longMa && gt(close[i], s200[i]) && volCond) s.entry('Long', 'long');
      if (shortMa && lt(close[i], s200[i]) && volCond) s.entry('Short', 'short');
      if (shortMa && gt(close[i], s200[i])) s.close('Long');
      if (longMa && lt(close[i], s200[i])) s.close('Short');
      // per(): distance in ticks from the average price; na when flat.
      const per = (pct: number) => (s.positionSize !== 0 ? round(((pct / 100) * s.positionAvgPrice) / sym.mintick) : NaN);
      s.exit('TP 1', { qtyPercent: inp.q1, profit: per(inp.tp1), loss: per(inp.sl) });
      s.exit('TP 2', { qtyPercent: inp.q2, profit: per(inp.tp2), loss: per(inp.sl) });
      s.exit('TP 3', { qtyPercent: inp.q3, profit: per(inp.tp3), loss: per(inp.sl) });
    };
  },
};
