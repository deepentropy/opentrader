/**
 * Tick grid arithmetic: prices as n ticks on the binary value, bar prices rounded to the nearest tick, order prices
 * rounded away from the market, slippage in ticks, limit fill triggers and quantities floored to the quantity step.
 */
/** Order prices this close to a tick level, in ticks, are that level (see roundOrderPrice). */
export const TICK_TOLERANCE = 1e-4;

/**
 * n ticks as a price: n * mintick, keeping the binary value as the reference app does
 * (35 * 0.01 = 0.35000000000000003; scripts reading position_avg_price see it).
 */
export function ticks(n: number, mintick: number): number {
  return n * mintick;
}

/** Nearest tick, on the exact binary value (148.045 -> 148.04, 161.145 -> 161.15, as the reference app). */
export function roundPrice(p: number, mintick: number): number {
  return ticks(Math.round(p / mintick), mintick);
}

/**
 * Order prices are rounded away from the market: buy stop / sell limit up, sell stop / buy limit down. A price
 * within 1/10,000 of a tick of a tick level is that level (a buy stop at 0.090001 is 0.09, at 0.0900011 0.10, the
 * same at 206.410001; a sell stop at 0.5399999 is 0.54, at 0.539999 (53.9999 ticks in binary) 0.53).
 */
export function roundOrderPrice(p: number, buy: boolean, isStop: boolean, mintick: number): number {
  const n = p / mintick;
  const near = Math.round(n);
  if (Math.abs(n - near) < TICK_TOLERANCE) return ticks(near, mintick);
  // Rounded down toward zero: a sell stop at a band below zero (-0.0278) is placed at -0.02 in the reference app
  // (Bollinger stop strategy AAPL 1W bar 1044: RE10024 with -250962 shares, 100 % of equity at -0.02).
  return ticks(buy === isStop ? Math.ceil(n) : Math.trunc(n), mintick);
}

/** price is on the tick grid; slippage (ticks) moves it against the trader. */
export function slip(price: number, buy: boolean, mintick: number, slippage: number): number {
  const n = Math.round(price / mintick);
  return ticks(buy ? n + slippage : n - slippage, mintick);
}

/** Quantity rounded down to the quantity step. */
export function floorQty(q: number, step: number): number {
  // Plain floor on the binary value, as the reference app (822855.9999... gives 822855).
  return Math.max(0, Math.floor(q / step) * step);
}

/** Price a limit order at `level` needs to fill: `n` ticks beyond it (below for a buy; fillLimitsTicks). */
export function limitTrigger(level: number, buy: boolean, n: number, mintick: number): number {
  if (!n) return level;
  const k = Math.round(level / mintick);
  return ticks(buy ? k - n : k + n, mintick);
}
