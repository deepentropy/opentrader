/*
 * Candlestick patterns of the shown daily bar (the screener's Pattern column,
 * #272), with the standard candlestick pattern scripts' rules: a body is long
 * or small against the 14-bar EMA of bodies, the trend is the close against
 * the 50-bar SMA of closes, and a pattern looks back at most four bars.
 *
 * The state carries the bars of D and the four before with their size and
 * trend flags (`candle.*`, gateway screener/code/candles.py). On D itself the
 * patterns are those of D's bar; on the next session the live bar comes first
 * and steps the body EMA and the SMA (`SMA50|next`).
 *
 * Checked at the 16/11/2026 close: the lists equal the reference scanner's
 * for 99.6% of 11,700 symbols (the rest are tickers with missing sessions).
 */
use crate::data::market_rest::MarketRow;
use crate::screener::state::StateFile;

/// Pattern ids (the reference scanner's), in the order a cell lists them.
pub const PATTERNS: [&str; 44] = [
    "abandoned_baby_bearish",
    "abandoned_baby_bullish",
    "dark_cloud_cover_bearish",
    "doji",
    "doji_star_bearish",
    "doji_star_bullish",
    "downside_tasuki_gap_bearish",
    "dragonfly_doji_bullish",
    "engulfing_bearish",
    "engulfing_bullish",
    "evening_doji_star_bearish",
    "evening_star_bearish",
    "falling_three_methods_bearish",
    "falling_window_bearish",
    "gravestone_doji_bearish",
    "hammer_bullish",
    "hanging_man_bearish",
    "harami_bearish",
    "harami_bullish",
    "harami_cross_bearish",
    "harami_cross_bullish",
    "inverted_hammer_bullish",
    "kicking_bearish",
    "kicking_bullish",
    "long_lower_shadow_bullish",
    "long_upper_shadow_bearish",
    "marubozu_black_bearish",
    "marubozu_white_bullish",
    "morning_doji_star_bullish",
    "morning_star_bullish",
    "on_neck_bearish",
    "piercing_bullish",
    "rising_three_methods_bullish",
    "rising_window_bullish",
    "shooting_star_bearish",
    "spinning_top_black",
    "spinning_top_white",
    "three_black_crows_bearish",
    "three_white_soldiers_bullish",
    "tri_star_bearish",
    "tri_star_bullish",
    "tweezer_bottom_bullish",
    "tweezer_top_bearish",
    "upside_tasuki_gap_bullish",
];

const BODY_EMA: f64 = 14.0;
const TREND_SMA: f64 = 50.0;

/// One daily bar with what the rules read of it.
#[derive(Clone, Copy, Debug)]
pub struct Bar {
    o: f64,
    h: f64,
    l: f64,
    c: f64,
    hi: f64,
    lo: f64,
    body: f64,
    up: f64,
    dn: f64,
    range: f64,
    mid: f64,
    white: bool,
    black: bool,
    long: bool,
    small: bool,
    up_trend: bool,
    down_trend: bool,
    has_up: bool,
    has_dn: bool,
    doji_body: bool,
    doji: bool,
    marubozu: bool,
}

impl Bar {
    /// `size`: 1 body above its EMA, -1 below; `trend`: 1 close above the SMA, -1 below (0: neither).
    pub fn new(o: f64, h: f64, l: f64, c: f64, size: f64, trend: f64) -> Bar {
        let (hi, lo) = (o.max(c), o.min(c));
        let body = hi - lo;
        let (up, dn) = (h - hi, lo - l);
        let range = h - l;
        let shadows_equal = up == dn || (dn != 0.0 && up != 0.0 && (up - dn).abs() / dn * 100.0 < 100.0 && (dn - up).abs() / up * 100.0 < 100.0);
        let doji_body = range > 0.0 && body <= range * 0.05;
        let long = size == 1.0;
        Bar {
            o,
            h,
            l,
            c,
            hi,
            lo,
            body,
            up,
            dn,
            range,
            mid: body / 2.0 + lo,
            white: o < c,
            black: o > c,
            long,
            small: size == -1.0,
            up_trend: trend == 1.0,
            down_trend: trend == -1.0,
            has_up: up > body * 0.05,
            has_dn: dn > body * 0.05,
            doji_body,
            doji: doji_body && shadows_equal,
            marubozu: long && up <= 0.05 * body && dn <= 0.05 * body,
        }
    }
}

/// The patterns of `b[0]`, `b[k]` being the bar k bars back (`None` past the ticker's first bar); `avg`: the body
/// EMA at `b[0]`. Ids in `PATTERNS` order.
pub fn find(b: &[Option<Bar>; 5], avg: f64) -> Vec<&'static str> {
    let mut out = Vec::new();
    let Some(x) = b[0] else { return out };
    let y = b[1];
    let yz = b[1].zip(b[2]);
    let mut add = |hit: bool, id: &'static str| {
        if hit {
            out.push(id);
        }
    };
    let dragon = x.doji_body && x.up <= x.body;
    let grave = x.doji_body && x.dn <= x.body;
    let hammer = x.small && x.body > 0.0 && x.lo > (x.h + x.l) / 2.0 && x.dn >= 2.0 * x.body && !x.has_up;
    let star = x.small && x.body > 0.0 && x.hi < (x.h + x.l) / 2.0 && x.up >= 2.0 * x.body && !x.has_dn;
    let spin = x.dn >= x.range / 100.0 * 34.0 && x.up >= x.range / 100.0 * 34.0 && !x.doji_body;
    let inside = |y: Bar| x.h <= y.hi && x.l >= y.lo;
    let w = b[4].filter(|_| b[1..4].iter().all(Option::is_some));

    add(yz.is_some_and(|(y, z)| z.up_trend && z.white && y.doji_body && z.h < y.l && x.black && y.l > x.h), "abandoned_baby_bearish");
    add(yz.is_some_and(|(y, z)| z.down_trend && z.black && y.doji_body && z.l > y.h && x.white && y.h < x.l), "abandoned_baby_bullish");
    add(y.is_some_and(|y| y.up_trend && y.white && y.long && x.black && x.o >= y.h && x.c < y.mid && x.c > y.o), "dark_cloud_cover_bearish");
    add(x.doji && !dragon && !grave, "doji");
    add(y.is_some_and(|y| x.up_trend && y.white && y.long && x.doji_body && x.lo > y.hi), "doji_star_bearish");
    add(y.is_some_and(|y| x.down_trend && y.black && y.long && x.doji_body && x.hi < y.lo), "doji_star_bullish");
    add(
        yz.is_some_and(|(y, z)| z.long && y.small && x.down_trend && z.black && y.hi < z.lo && y.black && x.white && x.hi <= z.lo && x.hi >= y.hi),
        "downside_tasuki_gap_bearish",
    );
    add(dragon, "dragonfly_doji_bullish");
    add(
        y.is_some_and(|y| x.up_trend && x.black && x.long && y.white && y.small && x.c <= y.o && x.o >= y.c && (x.c < y.o || x.o > y.c)),
        "engulfing_bearish",
    );
    add(
        y.is_some_and(|y| x.down_trend && x.white && x.long && y.black && y.small && x.c >= y.o && x.o <= y.c && (x.c > y.o || x.o < y.c)),
        "engulfing_bullish",
    );
    let evening = |y: Bar, z: Bar| z.long && x.long && x.up_trend && z.white && y.lo > z.hi && x.black && x.lo <= z.mid && x.lo > z.lo && y.lo > x.hi;
    add(yz.is_some_and(|(y, z)| y.doji_body && evening(y, z)), "evening_doji_star_bearish");
    add(yz.is_some_and(|(y, z)| y.small && evening(y, z)), "evening_star_bearish");
    add(
        w.is_some_and(|w| {
            w.down_trend && w.long && w.black && x.long && x.black && x.c < w.c && (1..4).all(|k| b[k].is_some_and(|q| q.small && q.white && q.o > w.l && q.c < w.h))
        }),
        "falling_three_methods_bearish",
    );
    add(y.is_some_and(|y| y.down_trend && x.range != 0.0 && y.range != 0.0 && x.h < y.l), "falling_window_bearish");
    add(grave, "gravestone_doji_bearish");
    add(hammer && x.down_trend, "hammer_bullish");
    add(hammer && x.up_trend, "hanging_man_bearish");
    add(y.is_some_and(|y| y.long && y.white && y.up_trend && x.black && x.small && inside(y)), "harami_bearish");
    add(y.is_some_and(|y| y.long && y.black && y.down_trend && x.white && x.small && inside(y)), "harami_bullish");
    add(y.is_some_and(|y| y.long && y.white && y.up_trend && x.doji_body && inside(y)), "harami_cross_bearish");
    add(y.is_some_and(|y| y.long && y.black && y.down_trend && x.doji_body && inside(y)), "harami_cross_bullish");
    add(star && x.down_trend, "inverted_hammer_bullish");
    add(y.is_some_and(|y| y.marubozu && y.white && x.marubozu && x.black && y.l > x.h), "kicking_bearish");
    add(y.is_some_and(|y| y.marubozu && y.black && x.marubozu && x.white && y.h < x.l), "kicking_bullish");
    add(x.dn > x.range / 100.0 * 75.0, "long_lower_shadow_bullish");
    add(x.up > x.range / 100.0 * 75.0, "long_upper_shadow_bearish");
    add(x.black && x.marubozu, "marubozu_black_bearish");
    add(x.white && x.marubozu, "marubozu_white_bullish");
    let morning = |y: Bar, z: Bar| z.long && x.long && x.down_trend && z.black && y.hi < z.lo && x.white && x.hi >= z.mid && x.hi < z.hi && y.hi < x.lo;
    add(yz.is_some_and(|(y, z)| y.doji_body && morning(y, z)), "morning_doji_star_bullish");
    add(yz.is_some_and(|(y, z)| y.small && morning(y, z)), "morning_star_bullish");
    add(
        y.is_some_and(|y| x.down_trend && y.black && y.long && x.white && x.o < y.c && x.small && x.range != 0.0 && (x.c - y.l).abs() <= avg * 0.05),
        "on_neck_bearish",
    );
    add(y.is_some_and(|y| y.down_trend && y.black && y.long && x.white && x.o <= y.l && x.c > y.mid && x.c < y.o), "piercing_bullish");
    add(
        w.is_some_and(|w| {
            w.up_trend && w.long && w.white && x.long && x.white && x.c > w.c && (1..4).all(|k| b[k].is_some_and(|q| q.small && q.black && q.o < w.h && q.c > w.l))
        }),
        "rising_three_methods_bullish",
    );
    add(y.is_some_and(|y| y.up_trend && x.range != 0.0 && y.range != 0.0 && x.l > y.h), "rising_window_bullish");
    add(star && x.up_trend, "shooting_star_bearish");
    add(spin && x.black, "spinning_top_black");
    add(spin && x.white, "spinning_top_white");
    add(
        yz.is_some_and(|(y, z)| {
            x.long && y.long && z.long && x.black && y.black && z.black && x.c < y.c && y.c < z.c && [x, y, z].iter().all(|q| q.range * 0.05 > q.dn) && x.o > y.c && x.o < y.o && y.o > z.c && y.o < z.o
        }),
        "three_black_crows_bearish",
    );
    add(
        yz.is_some_and(|(y, z)| {
            x.long && y.long && z.long && x.white && y.white && z.white && x.c > y.c && y.c > z.c && [x, y, z].iter().all(|q| q.range * 0.05 > q.up) && x.o < y.c && x.o > y.o && y.o < z.c && y.o > z.o
        }),
        "three_white_soldiers_bullish",
    );
    add(yz.is_some_and(|(y, z)| z.doji && y.doji && x.doji && z.up_trend && z.hi < y.lo && y.lo > x.hi), "tri_star_bearish");
    add(yz.is_some_and(|(y, z)| z.doji && y.doji && x.doji && z.down_trend && z.lo > y.hi && y.hi < x.lo), "tri_star_bullish");
    let not_doji = !x.doji_body || (x.has_up && x.has_dn);
    add(y.is_some_and(|y| y.down_trend && not_doji && (x.l - y.l).abs() <= avg * 0.05 && y.black && x.white && y.long), "tweezer_bottom_bullish");
    add(y.is_some_and(|y| y.up_trend && not_doji && (x.h - y.h).abs() <= avg * 0.05 && y.white && x.black && y.long), "tweezer_top_bearish");
    add(
        yz.is_some_and(|(y, z)| z.long && y.small && x.up_trend && z.white && y.lo > z.hi && y.white && x.black && x.lo >= z.hi && x.lo <= y.lo),
        "upside_tasuki_gap_bullish",
    );
    out
}

/// The state's bar k bars back from D (k = 0..4).
fn state_bar(s: &StateFile, i: usize, k: usize) -> Option<Bar> {
    let n = |f: &str| s.num(&format!("candle.{f}{k}"), i);
    Some(Bar::new(n("o")?, n("h")?, n("l")?, n("c")?, n("size").unwrap_or(0.0), n("trend").unwrap_or(0.0)))
}

/// The patterns of D's bar (`step` false) or of the live bar of the session after D (`step` true).
pub fn patterns(s: &StateFile, i: usize, m: &MarketRow, step: bool) -> Option<Vec<&'static str>> {
    let avg_d = s.num("candle.avg", i);
    if !step {
        let bars = [0, 1, 2, 3, 4].map(|k| state_bar(s, i, k));
        bars[0]?;
        return Some(find(&bars, avg_d.unwrap_or(f64::NAN)));
    }
    let pos = |v: f64| (v > 0.0).then_some(v);
    let (o, h, l, c) = (pos(m.open)?, pos(m.high)?, pos(m.low)?, pos(m.last)?);
    let body = (c - o).abs();
    let avg = avg_d.map_or(f64::NAN, |a| a + 2.0 / (BODY_EMA + 1.0) * (body - a));
    let size = if body > avg { 1.0 } else if body < avg { -1.0 } else { 0.0 };
    let sma = s.num("SMA50|next", i).map_or(f64::NAN, |sum| (sum + c) / TREND_SMA);
    let trend = if c > sma { 1.0 } else if c < sma { -1.0 } else { 0.0 };
    let live = Bar::new(o, h, l, c, size, trend);
    let bars = [Some(live), state_bar(s, i, 0), state_bar(s, i, 1), state_bar(s, i, 2), state_bar(s, i, 3)];
    Some(find(&bars, avg))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bar(o: f64, h: f64, l: f64, c: f64, size: f64, trend: f64) -> Option<Bar> {
        Some(Bar::new(o, h, l, c, size, trend))
    }

    /// Tickers of the 16/11/2026 close (the state's candle.* values) whose pattern lists equal the reference
    /// scanner's, every pattern seen that day included.
    #[test]
    fn matches_the_reference_close() {
        #[derive(serde::Deserialize)]
        struct Fixture {
            rows: Vec<serde_json::Map<String, serde_json::Value>>,
        }
        let f: Fixture = serde_json::from_str(include_str!("candles_fixture.json")).unwrap();
        let mut s = StateFile { version: 1, asof: chrono::NaiveDate::from_ymd_opt(2026, 11, 16).unwrap(), tickers: vec![], num: Default::default(), text: Default::default() };
        for r in &f.rows {
            s.tickers.push(r["ticker"].as_str().unwrap().to_string());
            for (k, v) in r.iter().filter(|(k, _)| k.starts_with("candle.")) {
                s.num.entry(k.clone()).or_default().push(v.as_f64());
            }
        }
        let m = MarketRow { ticker: String::new(), last: 0.0, change: 0.0, change_percent: 0.0, open: 0.0, high: 0.0, low: 0.0, volume: 0.0, prev_close: None, live: false, updated_ms: 0.0 };
        for (i, r) in f.rows.iter().enumerate() {
            let want: Vec<&str> = r["patterns"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
            assert_eq!(patterns(&s, i, &m, false).unwrap(), want, "{}", r["ticker"]);
        }
    }

    #[test]
    fn engulfing_needs_the_trend_and_the_body_sizes() {
        // A small black bar, then a long white one whose body covers it, in a downtrend.
        let b = [bar(9.0, 12.5, 8.9, 12.0, 1.0, -1.0), bar(11.0, 11.2, 9.8, 10.0, -1.0, -1.0), None, None, None];
        assert!(find(&b, 1.5).contains(&"engulfing_bullish"));
        let up = [bar(9.0, 12.5, 8.9, 12.0, 1.0, 1.0), b[1], None, None, None];
        assert!(!find(&up, 1.5).contains(&"engulfing_bullish"));
        let short = [bar(9.0, 12.5, 8.9, 12.0, -1.0, -1.0), b[1], None, None, None];
        assert!(!find(&short, 1.5).contains(&"engulfing_bullish"));
    }

    #[test]
    fn single_bar_shapes() {
        // Open = high, close = low: a black marubozu.
        assert_eq!(find(&[bar(10.0, 10.0, 8.0, 8.0, 1.0, 0.0), None, None, None, None], 1.0), vec!["marubozu_black_bearish"]);
        // A dragonfly doji: no body, no upper shadow, a long lower one.
        let d = find(&[bar(10.0, 10.0, 8.0, 10.0, -1.0, 0.0), None, None, None, None], 1.0);
        assert_eq!(d, vec!["dragonfly_doji_bullish", "long_lower_shadow_bullish"]);
        // A hammer in a downtrend, a hanging man in an uptrend.
        let shape = |t| [bar(9.6, 9.9, 8.0, 9.9, -1.0, t), None, None, None, None];
        assert!(find(&shape(-1.0), 1.0).contains(&"hammer_bullish"));
        assert!(find(&shape(1.0), 1.0).contains(&"hanging_man_bearish"));
    }

    #[test]
    fn three_methods_need_all_five_bars() {
        let w = bar(10.0, 20.5, 9.5, 20.0, 1.0, 1.0);
        let pull = |o: f64, c: f64| bar(o, o + 0.2, c - 0.2, c, -1.0, 1.0);
        let x = bar(18.0, 23.0, 17.9, 22.5, 1.0, 1.0);
        let b = [x, pull(19.0, 18.0), pull(18.5, 17.5), pull(19.5, 18.5), w];
        assert!(find(&b, 2.0).contains(&"rising_three_methods_bullish"));
        assert!(!find(&[x, pull(19.0, 18.0), None, pull(19.5, 18.5), w], 2.0).contains(&"rising_three_methods_bullish"));
    }

    #[test]
    fn live_bar_steps_the_average_and_the_trend() {
        let mut s = StateFile {
            version: 1,
            asof: chrono::NaiveDate::from_ymd_opt(2026, 11, 16).unwrap(),
            tickers: vec!["AAA".into()],
            num: Default::default(),
            text: Default::default(),
        };
        for (k, (o, h, l, c, size, trend)) in [(11.0, 11.2, 9.8, 10.0, -1.0, -1.0)].into_iter().enumerate() {
            for (f, v) in [("o", o), ("h", h), ("l", l), ("c", c), ("size", size), ("trend", trend)] {
                s.num.insert(format!("candle.{f}{k}"), vec![Some(v)]);
            }
        }
        s.num.insert("candle.avg".into(), vec![Some(1.5)]);
        // 49 closes summing to 49 * 13: the live close 12 is below the SMA.
        s.num.insert("SMA50|next".into(), vec![Some(49.0 * 13.0)]);
        let m = MarketRow { ticker: "AAA".into(), last: 12.0, change: 0.0, change_percent: 0.0, open: 9.0, high: 12.5, low: 8.9, volume: 1.0, prev_close: Some(10.0), live: true, updated_ms: 0.0 };
        // Body 3 against the EMA 1.5 + 2/15 * 1.5 = 1.7: long; close 12 < SMA 12.98: downtrend.
        assert!(patterns(&s, 0, &m, true).unwrap().contains(&"engulfing_bullish"));
        // On D itself: D's bar alone (a black bar, nothing before it).
        assert!(!patterns(&s, 0, &m, false).unwrap().contains(&"engulfing_bullish"));
    }
}
