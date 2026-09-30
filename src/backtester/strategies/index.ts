import type { StrategyDefinition } from '../run';
import { alphatrendStrategy } from './alphatrend';
import { bollingerStopStrategy } from './bollinger-stop';
import { centeredRsiStrategy } from './centered-rsi';
import { cumulativeRsiStrategy } from './cumulative-rsi';
import { dojiStrategy } from './doji';
import { lowHighTrendStrategy } from './low-high-trend';
import { lucky13emaStrategy } from './lucky13ema';
import { meanreverterStrategy } from './meanreverter';
import { quatroSmaStrategy } from './quatro-sma';
import { rbReversalStrategy } from './rb-reversal';
import { stGreedStrategy } from './st-greed';
import { trendCatcherStrategy } from './trend-catcher';
import { zscoreStrategy } from './zscore';

/** Strategy ports, validated against TradingView (research/backtester). */
export const STRATEGIES: StrategyDefinition<any>[] = [
  alphatrendStrategy,
  bollingerStopStrategy,
  cumulativeRsiStrategy,
  trendCatcherStrategy,
  lowHighTrendStrategy,
  rbReversalStrategy,
  meanreverterStrategy,
  zscoreStrategy,
  quatroSmaStrategy,
  centeredRsiStrategy,
  lucky13emaStrategy,
  dojiStrategy,
  stGreedStrategy,
];
