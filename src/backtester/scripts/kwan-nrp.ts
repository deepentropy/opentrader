/** Kwan NRP Backtest (HPotter): average of Stoch x RSI / Momentum, direction of the average. */
import { compare } from 'oakscriptjs';
import { barcolor, close, color, eachBar, high, input, low, open, plot, strategy, ta } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';

const { gt, lt, ne } = compare;

function body(): void {
  strategy('Kwan NRP Backtest', {
    shorttitle: 'KNRP',
  });

  const xPrice = open;
  const lengthMomentum = input.int(9, 'Length_Momentum', { minval: 1 });
  const lengthRSI = input.int(9, 'Length_RSI', { minval: 1 });
  input.int(9, 'Length_Stoch', { minval: 1 }); // declared, not used by the source (ta.stoch length 9)
  const lengthNRP = input.int(21, 'Length_NRP', { minval: 1 });
  const reverse = input.bool(false, 'Trade reverse');

  // var xKNRP = array.new_float(1, na)
  const xKNRP: number[] = [NaN];
  const xMom = close.div(close.offset(lengthMomentum)).mul(100);
  const xRSI = ta.rsi(xPrice, lengthRSI);
  const xStoch = ta.stoch(xPrice, high, low, 9);
  const avr = eachBar((c) => {
    const mom = c.get(xMom);
    if (ne(mom, 0)) xKNRP.push((c.get(xStoch) * c.get(xRSI)) / mom);
    let sum = 0.0;
    if (xKNRP.length > lengthNRP) {
      for (let i = xKNRP.length - lengthNRP; i <= xKNRP.length - 1; i++) sum = sum + xKNRP[i]!;
    }
    return sum / lengthNRP;
  });
  const possig = eachBar((c) => {
    const a = c.get(avr);
    const a1 = c.get(avr, 1);
    const pos = gt(a, a1) ? 1 : lt(a, a1) ? -1 : 0;
    return reverse && pos === -1 ? 1 : reverse && pos === 1 ? -1 : pos;
  });

  strategy.eachBar((c) => {
    const p = c.get(possig);
    if (p === 1) strategy.entry('Long', strategy.long);
    if (p === -1) strategy.entry('Short', strategy.short);
    if (p === 0) strategy.close_all();
  });

  const a = avr.toArray();
  const clr = a.map((v, i) => (gt(v, a[i - 1] ?? NaN) ? color.blue : color.red));
  barcolor(possig.toArray().map((p) => (p === -1 ? '#b50404' : p === 1 ? '#079605' : '#0536b3')));
  plot(avr, 'RMI', { color: clr });
}

export const kwanNrp: ScriptStrategy = {
  key: 'kwan-nrp',
  source: { id: 'PUB;6ff26e6ea87f470486272fcfd8bd7ccb', name: 'Kwan NRP Backtest', author: 'HPotter' },
  body,
};
