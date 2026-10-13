import type { ScriptStrategy } from '../oakscript';
import { barUpDn } from './bar-up-dn';
import { bollingerBands, bollingerBandsDirected } from './bollinger-bands';
import { greedy } from './greedy';
import { technicalRatings } from './technical-ratings';
import { channelBreakout } from './channel-breakout';
import { consecutiveUpDown } from './consecutive-up-down';
import { insideBar, outsideBar } from './inside-outside-bar';
import { keltnerChannels } from './keltner-channels';
import { macd } from './macd';
import { maCross, ma2Cross } from './ma-cross';
import { momentum } from './momentum';
import { parabolicSar } from './parabolic-sar';
import { pivotExtension, pivotReversal } from './pivot';
import { priceChannel } from './price-channel';
import { rbAdxBreakout } from './rb-adx-breakout';
import { rsi, stochasticSlow } from './oscillators';
import { supertrend } from './supertrend';
import { voltyExpanClose } from './volty-expan-close';

/** The reference app's built-in strategies (Built-In > Technicals > Strategies), written as OakScript scripts from
 *  their Pine sources and validated against its reports (.tmp/issue47). In the reference app's list order. */
export const BUILTIN_STRATEGIES: ScriptStrategy[] = [
  barUpDn,
  bollingerBands,
  bollingerBandsDirected,
  channelBreakout,
  consecutiveUpDown,
  greedy,
  insideBar,
  keltnerChannels,
  macd,
  momentum,
  maCross,
  outsideBar,
  parabolicSar,
  pivotExtension,
  pivotReversal,
  priceChannel,
  rbAdxBreakout,
  rsi,
  stochasticSlow,
  supertrend,
  technicalRatings,
  ma2Cross,
  voltyExpanClose,
];
