/*
 * The candlestick patterns of the screener's Pattern column (#272): the
 * backend's ids (`candles.rs`, the reference scanner's), their titles and the
 * abbreviation (the label the standard pattern scripts draw) and side.
 */

export type PatternSide = "bullish" | "bearish" | "neutral";
export type CandlePattern = { id: string; title: string; abbr: string; side: PatternSide };

const P = (id: string, title: string, abbr: string, side: PatternSide): CandlePattern => ({ id, title, abbr, side });

export const CANDLE_PATTERNS: CandlePattern[] = [
  P("abandoned_baby_bearish", "Abandoned Baby - Bearish", "AB", "bearish"),
  P("abandoned_baby_bullish", "Abandoned Baby - Bullish", "AB", "bullish"),
  P("dark_cloud_cover_bearish", "Dark Cloud Cover - Bearish", "DCC", "bearish"),
  P("doji", "Doji", "D", "neutral"),
  P("doji_star_bearish", "Doji Star - Bearish", "DS", "bearish"),
  P("doji_star_bullish", "Doji Star - Bullish", "DS", "bullish"),
  P("downside_tasuki_gap_bearish", "Downside Tasuki Gap - Bearish", "DTG", "bearish"),
  P("dragonfly_doji_bullish", "Dragonfly Doji - Bullish", "DD", "bullish"),
  P("engulfing_bearish", "Engulfing - Bearish", "BE", "bearish"),
  P("engulfing_bullish", "Engulfing - Bullish", "BE", "bullish"),
  P("evening_doji_star_bearish", "Evening Doji Star - Bearish", "EDS", "bearish"),
  P("evening_star_bearish", "Evening Star - Bearish", "ES", "bearish"),
  P("falling_three_methods_bearish", "Falling Three Methods - Bearish", "FTM", "bearish"),
  P("falling_window_bearish", "Falling Window - Bearish", "FW", "bearish"),
  P("gravestone_doji_bearish", "Gravestone Doji - Bearish", "GD", "bearish"),
  P("hammer_bullish", "Hammer - Bullish", "H", "bullish"),
  P("hanging_man_bearish", "Hanging Man - Bearish", "HM", "bearish"),
  P("harami_bearish", "Harami - Bearish", "BH", "bearish"),
  P("harami_bullish", "Harami - Bullish", "BH", "bullish"),
  P("harami_cross_bearish", "Harami Cross - Bearish", "HC", "bearish"),
  P("harami_cross_bullish", "Harami Cross - Bullish", "HC", "bullish"),
  P("inverted_hammer_bullish", "Inverted Hammer - Bullish", "IH", "bullish"),
  P("kicking_bearish", "Kicking - Bearish", "K", "bearish"),
  P("kicking_bullish", "Kicking - Bullish", "K", "bullish"),
  P("long_lower_shadow_bullish", "Long Lower Shadow - Bullish", "LLS", "bullish"),
  P("long_upper_shadow_bearish", "Long Upper Shadow - Bearish", "LUS", "bearish"),
  P("marubozu_black_bearish", "Marubozu Black - Bearish", "MB", "bearish"),
  P("marubozu_white_bullish", "Marubozu White - Bullish", "MW", "bullish"),
  P("morning_doji_star_bullish", "Morning Doji Star - Bullish", "MDS", "bullish"),
  P("morning_star_bullish", "Morning Star - Bullish", "MS", "bullish"),
  P("on_neck_bearish", "On Neck - Bearish", "ON", "bearish"),
  P("piercing_bullish", "Piercing - Bullish", "P", "bullish"),
  P("rising_three_methods_bullish", "Rising Three Methods - Bullish", "RTM", "bullish"),
  P("rising_window_bullish", "Rising Window - Bullish", "RW", "bullish"),
  P("shooting_star_bearish", "Shooting Star - Bearish", "SS", "bearish"),
  P("spinning_top_black", "Spinning Top Black", "STB", "neutral"),
  P("spinning_top_white", "Spinning Top White", "STW", "neutral"),
  P("three_black_crows_bearish", "Three Black Crows - Bearish", "3BC", "bearish"),
  P("three_white_soldiers_bullish", "Three White Soldiers - Bullish", "3WS", "bullish"),
  P("tri_star_bearish", "Tri-Star - Bearish", "3S", "bearish"),
  P("tri_star_bullish", "Tri-Star - Bullish", "3S", "bullish"),
  P("tweezer_bottom_bullish", "Tweezer Bottom - Bullish", "TB", "bullish"),
  P("tweezer_top_bearish", "Tweezer Top - Bearish", "TT", "bearish"),
  P("upside_tasuki_gap_bullish", "Upside Tasuki Gap - Bullish", "UTG", "bullish"),
];

export const PATTERN_BY_ID: Record<string, CandlePattern> = Object.fromEntries(CANDLE_PATTERNS.map((p) => [p.id, p]));

/** The patterns of a cell value (comma-joined ids); unknown ids are left out. */
export function patternsOf(raw: string): CandlePattern[] {
  return raw.split(",").flatMap((id) => (PATTERN_BY_ID[id] ? [PATTERN_BY_ID[id]] : []));
}
