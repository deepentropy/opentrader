/** RSI, Volume, MACD, EMA Combo (Ashhabx): trend + momentum + volume entries, RSI 50 cross exits. */
import { compare } from 'oakscriptjs';
import { close, color, input, plot, strategy, ta, volume } from 'oakscriptjs/script';
import type { ScriptStrategy } from '../oakscript';

const { gt, lt } = compare;

function body(): void {
  strategy('RSI, Volume, MACD, EMA Combo', { overlay: true });

  const emaL = input.int(200, 'EMA LENGTH');
  const rsiL = input.int(14, 'RSI LENGTH');
  const ob = input.int(50, 'OB');
  const os = input.int(50, 'OS');
  const slowL = input.int(26, 'RSI LENGTH');
  const fastL = input.int(12, 'RSI LENGTH');
  const sigL = input.int(9, 'RSI LENGTH');
  const smaL = input.int(20, 'SMA LENGTH');

  const [macdLine, signalLine] = ta.macd(close, fastL, slowL, sigL);
  const rsi = ta.rsi(close, rsiL);
  const ema = ta.ema(close, emaL);
  const smaV = ta.sma(volume, smaL);
  const sell = ta.crossunder(rsi, 50);
  const cover = ta.crossover(rsi, 50);

  strategy.eachBar((c) => {
    const m = c.get(macdLine);
    const s = c.get(signalLine);
    const r = c.get(rsi);
    const e = c.get(ema);
    const volOk = gt(c.volume, c.get(smaV));
    const buy = gt(m, s) && gt(r, ob) && gt(c.close, e) && volOk;
    const short = lt(m, s) && lt(r, os) && lt(c.close, e) && volOk;
    if (buy) strategy.entry('long', strategy.long, { comment: 'long' });
    if (c.get(sell) === 1) strategy.close('long', { comment: 'long exit' });
    if (short) strategy.entry('short', strategy.short, { comment: 'short' });
    if (c.get(cover) === 1) strategy.close('short', { comment: 'short exit' });
  });

  plot(ema, 'Plot', { color: color.green, linewidth: 2 });
}

export const rsiVolumeMacdEma: ScriptStrategy = {
  key: 'rsi-volume-macd-ema',
  source: { id: 'PUB;d237886cb3cf43dba6a8dbe86ea3ee68', name: 'RSI, Volume, MACD, EMA Combo', author: 'Ashhabx' },
  body,
};
