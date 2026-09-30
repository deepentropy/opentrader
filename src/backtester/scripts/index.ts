import type { ScriptStrategy } from '../oakscript';
import { bbMeanReversion } from './bb-mean-reversion';
import { bitcoinSuperflip } from './bitcoin-superflip';
import { bullishEngulfing } from './bullish-engulfing';
import { crossingMaAdx } from './crossing-ma-adx';
import { emaCrossRsiAdx } from './ema-cross-rsi-adx';
import { ewoRsi } from './ewo-rsi';
import { gaussianChannel } from './gaussian-channel';
import { supertrendStrategy } from './supertrend-strategy';
import { tRasPro } from './t-ras-pro';
import { trendState } from './trend-state';
import { tripleEmaTrend } from './triple-ema-trend';
import { utBotV2 } from './ut-bot-v2';
import { rsiMeanReversion } from './rsi-mean-reversion';
import { rsiVolumeMacdEma } from './rsi-volume-macd-ema';
import { btcIntradaySpot } from './btc-intraday-spot';
import { omegaPivot } from './omega-pivot';
import { fibonacciCloud } from './fibonacci-cloud';
import { emaMaCrossover } from './ema-ma-crossover';
import { pivotPoints } from './pivot-points';
import { fourWmaTpSl } from './four-wma-tp-sl';
import { kwanNrp } from './kwan-nrp';
import { futuresHoursRsi } from './futures-hours-rsi';
import { meanReversionVf } from './mean-reversion-vf';
import { tomukasScaleIn } from './tomukas-scale-in';
import { auroraKama } from './aurora-kama';
import { hmaCrossoverAtr } from './hma-crossover-atr';

/** Strategies written as OakScript scripts (Pine v6 sources), validated against the reference app
 *  (.tmp/oakscript-strategies). */
export const SCRIPT_STRATEGIES: ScriptStrategy[] = [
  utBotV2,
  ewoRsi,
  tripleEmaTrend,
  trendState,
  bullishEngulfing,
  tRasPro,
  emaCrossRsiAdx,
  supertrendStrategy,
  gaussianChannel,
  bitcoinSuperflip,
  crossingMaAdx,
  bbMeanReversion,
  // Batch 2
  rsiMeanReversion,
  rsiVolumeMacdEma,
  btcIntradaySpot,
  omegaPivot,
  fibonacciCloud,
  emaMaCrossover,
  pivotPoints,
  fourWmaTpSl,
  kwanNrp,
  futuresHoursRsi,
  meanReversionVf,
  tomukasScaleIn,
  auroraKama,
  hmaCrossoverAtr,
];
