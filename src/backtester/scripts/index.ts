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
];
