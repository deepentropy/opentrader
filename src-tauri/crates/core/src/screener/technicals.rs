/*
 * Technical ratings and oscillators one session after the daily state (S): every vote of the nightly job's
 * `technicals.py` (deepentropy/gateway#27) stepped with the live bar, from the carry-over columns it writes.
 *
 * The ratings are the standard Technical Ratings (MAs: mean of 15 votes, oscillators: mean of 11, all: mean of
 * the two), with the reference screener's two differences: the Ichimoku vote reads the leading spans of the
 * current bar and the CCI is computed on (high + low + close) / 3. Votes without data are left out of the means.
 * Buckets: Strong buy above 0.5, Buy above 0.1, Sell below -0.1, Strong sell below -0.5, Neutral between.
 */
use crate::data::market_rest::MarketRow;
use crate::screener::state::StateFile;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tech {
    /// Recommend.All / Recommend.MA / Recommend.Other.
    RatingAll,
    RatingMa,
    RatingOther,
    /// Close - close n bars before (n = 10 or 14).
    Mom(u32),
    Ao,
    Cci,
    /// Stochastic 14 / 3 / 3.
    StochK,
    StochD,
    /// Stochastic 14 / 1 / 3: the raw %K and its 3-bar mean.
    StochKFast,
    StochDFast,
}

/// Pine float comparisons (a value without data compares false).
const EPS: f64 = 1e-10;
fn gt(a: f64, b: f64) -> bool {
    a - b > EPS
}
fn lt(a: f64, b: f64) -> bool {
    b - a > EPS
}

/// calcRating(): +1 / -1 / 0, no vote (NaN) when `src` has no value.
fn vote(src: f64, bull: bool, bear: bool) -> f64 {
    if src.is_nan() {
        f64::NAN
    } else if bull {
        1.0
    } else if bear {
        -1.0
    } else {
        0.0
    }
}

/// The sign of close - MA (no vote without the MA).
fn side(close: f64, ma: f64) -> f64 {
    let d = close - ma;
    if d.is_nan() {
        f64::NAN
    } else if d > 0.0 {
        1.0
    } else if d < 0.0 {
        -1.0
    } else {
        0.0
    }
}

fn mean_votes(votes: &[f64]) -> f64 {
    let (sum, n) = votes.iter().filter(|v| v.is_finite()).fold((0.0, 0), |(s, n), v| (s + v, n + 1));
    if n == 0 {
        f64::NAN
    } else {
        sum / n as f64
    }
}

/// The rating bucket of a value (the reference screener's enum).
pub fn bucket(v: f64) -> &'static str {
    if gt(v, 0.5) {
        "StrongBuy"
    } else if gt(v, 0.1) {
        "Buy"
    } else if lt(v, -0.5) {
        "StrongSell"
    } else if lt(v, -0.1) {
        "Sell"
    } else {
        "Neutral"
    }
}

/// The state column a value at the close of D comes from.
pub fn state_key(t: Tech) -> &'static str {
    match t {
        Tech::RatingAll => "Recommend.All",
        Tech::RatingMa => "Recommend.MA",
        Tech::RatingOther => "Recommend.Other",
        Tech::Mom(14) => "Mom_14",
        Tech::Mom(_) => "Mom",
        Tech::Ao => "AO",
        Tech::Cci => "CCI20",
        Tech::StochK => "Stoch.K",
        Tech::StochD => "Stoch.D",
        Tech::StochKFast => "Stoch.K_14_1_3",
        Tech::StochDFast => "Stoch.D_14_1_3",
    }
}

/// The live bar and the state row of one ticker. Missing values read as NaN.
struct Ctx<'a> {
    s: &'a StateFile,
    i: usize,
    p: f64,
    h: f64,
    l: f64,
    v: f64,
}

impl Ctx<'_> {
    fn n(&self, key: &str) -> f64 {
        self.s.num(key, self.i).unwrap_or(f64::NAN)
    }

    fn ema(&self, key: &str, n: f64) -> f64 {
        let prev = self.n(key);
        prev + 2.0 / (n + 1.0) * (self.p - prev)
    }

    /// Highest high / lowest low of the window: the carried extremes of the bars before S and S's own.
    fn hi(&self, key: &str) -> f64 {
        self.n(key).max(self.h)
    }
    fn lo(&self, key: &str) -> f64 {
        self.n(key).min(self.l)
    }

    fn rsi(&self) -> f64 {
        let diff = self.p - self.n("close");
        let gain = (self.n("RSI|gain") * 13.0 + diff.max(0.0)) / 14.0;
        let loss = (self.n("RSI|loss") * 13.0 + (-diff).max(0.0)) / 14.0;
        if loss == 0.0 {
            100.0
        } else {
            100.0 - 100.0 / (1.0 + gain / loss)
        }
    }

    /// Stochastic 14: (raw %K, %K 14/3/3, %D 14/3/3).
    fn stoch(&self) -> (f64, f64, f64) {
        let (hh, ll) = (self.hi("Stoch|h13"), self.lo("Stoch|l13"));
        let raw = 100.0 * (self.p - ll) / (hh - ll);
        let k = (raw + self.n("Stoch|r2")) / 3.0;
        (raw, k, (k + self.n("Stoch|k2")) / 3.0)
    }

    fn cci(&self) -> f64 {
        let src = (self.h + self.l + self.p) / 3.0;
        let mut xs = [src; 20];
        for (j, x) in xs.iter_mut().enumerate().skip(1) {
            *x = self.n(&format!("CCI20|{j}"));
        }
        let mean = xs.iter().sum::<f64>() / 20.0;
        let dev = xs.iter().map(|x| (x - mean).abs()).sum::<f64>() / 20.0;
        (src - mean) / (0.015 * dev)
    }

    fn ao(&self) -> f64 {
        let hl2 = (self.h + self.l) / 2.0;
        (self.n("AO|s4") + hl2) / 5.0 - (self.n("AO|s33") + hl2) / 34.0
    }

    fn mom(&self, n: u32) -> f64 {
        self.p - if n == 14 { self.n("Mom_14|c14") } else { self.n("Mom|c10") }
    }

    fn rating_ma(&self) -> f64 {
        let p = self.p;
        let mut votes = Vec::with_capacity(15);
        for n in [10u32, 20, 30, 50, 100, 200] {
            votes.push(side(p, (self.n(&format!("SMA{n}|next")) + p) / n as f64));
        }
        for n in [10u32, 20, 30, 50, 100, 200] {
            votes.push(side(p, self.ema(&format!("EMA{n}"), n as f64)));
        }
        // Hull MA 9 = WMA 3 of (2 x WMA 4 - WMA 9).
        let diff = 2.0 * (4.0 * p + self.n("HullMA9|w4")) / 10.0 - (9.0 * p + self.n("HullMA9|w9")) / 45.0;
        votes.push(side(p, (3.0 * diff + self.n("HullMA9|d")) / 6.0));
        votes.push(side(p, (self.n("VWMA|cv") + p * self.v) / (self.n("VWMA|v") + self.v)));
        let con = (self.hi("Ichimoku|h8") + self.lo("Ichimoku|l8")) / 2.0;
        let base = (self.hi("Ichimoku|h25") + self.lo("Ichimoku|l25")) / 2.0;
        let lead1 = (con + base) / 2.0;
        let lead2 = (self.hi("Ichimoku|h51") + self.lo("Ichimoku|l51")) / 2.0;
        votes.push(vote(
            lead2,
            gt(lead1, lead2) && gt(base, lead1) && gt(con, base) && gt(p, con),
            lt(lead1, lead2) && lt(base, lead1) && lt(con, base) && lt(p, con),
        ));
        mean_votes(&votes)
    }

    fn rating_other(&self) -> f64 {
        let (p, h, l) = (self.p, self.h, self.l);
        let rsi = self.rsi();
        let rsi1 = self.n("RSI");
        let (_, k, d) = self.stoch();
        let cci = self.cci();
        let cci1 = self.n("CCI20");
        // ADX 14 (Pine ta.dmi): Wilder averages of the true range and the directional moves.
        let (ph, pl, pc) = (self.n("ADX|h"), self.n("ADX|l"), self.n("close"));
        let (up, down) = (h - ph, pl - l);
        let pdm = if up > down && up > 0.0 { up } else { 0.0 };
        let mdm = if down > up && down > 0.0 { down } else { 0.0 };
        let tr = (h - l).max((h - pc).abs()).max((l - pc).abs());
        let trur = (self.n("ADX|tr") * 13.0 + tr) / 14.0;
        let plus = 100.0 * (self.n("ADX|p") * 13.0 + pdm) / 14.0 / trur;
        let minus = 100.0 * (self.n("ADX|m") * 13.0 + mdm) / 14.0 / trur;
        let sum = plus + minus;
        let adx1 = self.n("ADX");
        let adx = (adx1 * 13.0 + 100.0 * (plus - minus).abs() / if sum == 0.0 { 1.0 } else { sum }) / 14.0;
        let (ao, ao1, ao2) = (self.ao(), self.n("AO"), self.n("AO|1"));
        let (mom, mom1) = (self.mom(10), self.n("Mom"));
        let e12 = self.ema("MACD|e12", 12.0);
        let e26 = self.ema("MACD|e26", 26.0);
        let macd = e12 - e26;
        let signal = self.n("MACD.signal") + 0.2 * (macd - self.n("MACD.signal"));
        let ema50 = self.ema("EMA50", 50.0);
        let (up_trend, down_trend) = (gt(p, ema50), lt(p, ema50));
        let (rh, rl) = (self.n("Stoch.RSI|h13").max(rsi), self.n("Stoch.RSI|l13").min(rsi));
        let sk = (100.0 * (rsi - rl) / (rh - rl) + self.n("Stoch.RSI|r2")) / 3.0;
        let sd = (sk + self.n("Stoch.RSI|k2")) / 3.0;
        let (hh, ll) = (self.hi("Stoch|h13"), self.lo("Stoch|l13"));
        let wr = 100.0 * (p - hh) / (hh - ll);
        let wr1 = self.n("W.R");
        let e13 = self.ema("BBPower|e13", 13.0);
        let (bull, bear) = (h - e13, l - e13);
        let (tmin, tmax) = (l.min(pc), h.max(pc));
        let (bp, trn) = (p - tmin, tmax - tmin);
        let avg = |n: u32| (self.n(&format!("UO|bp{n}")) + bp) / (self.n(&format!("UO|tr{n}")) + trn);
        let uo = 100.0 * (4.0 * avg(6) + 2.0 * avg(13) + avg(27)) / 7.0;
        let votes = [
            vote(rsi1, lt(rsi, 30.0) && lt(rsi1, rsi), gt(rsi, 70.0) && gt(rsi1, rsi)),
            vote(self.n("Stoch.D"), lt(k, 20.0) && lt(d, 20.0) && gt(k, d), gt(k, 80.0) && gt(d, 80.0) && lt(k, d)),
            vote(cci1, lt(cci, -100.0) && gt(cci, cci1), gt(cci, 100.0) && lt(cci, cci1)),
            vote(adx, gt(adx, 20.0) && gt(adx, adx1) && gt(plus, minus), gt(adx, 20.0) && gt(adx, adx1) && lt(plus, minus)),
            vote(
                ao1,
                (ao > 0.0 && ao1 <= 0.0) || (gt(ao, 0.0) && gt(ao1, 0.0) && gt(ao, ao1) && gt(ao2, ao1)),
                (ao < 0.0 && ao1 >= 0.0) || (lt(ao, 0.0) && lt(ao1, 0.0) && lt(ao, ao1) && lt(ao2, ao1)),
            ),
            vote(mom1, gt(mom, mom1), lt(mom, mom1)),
            vote(signal, gt(macd, signal), lt(macd, signal)),
            vote(
                ema50,
                down_trend && lt(sk, 20.0) && lt(sd, 20.0) && gt(sk, sd),
                up_trend && gt(sk, 80.0) && gt(sd, 80.0) && lt(sk, sd),
            ),
            vote(wr1, lt(wr, -80.0) && gt(wr, wr1), gt(wr, -20.0) && lt(wr, wr1)),
            vote(
                ema50,
                up_trend && lt(bear, 0.0) && gt(bear, self.n("BBPower|bear")),
                down_trend && gt(bull, 0.0) && lt(bull, self.n("BBPower|bull")),
            ),
            vote(uo, gt(uo, 70.0), lt(uo, 30.0)),
        ];
        mean_votes(&votes)
    }
}

/// The value of `t` on the session after the state's, with the live bar `m`.
pub fn step(s: &StateFile, i: usize, m: &MarketRow, t: Tech) -> Option<f64> {
    let pos = |v: f64| (v > 0.0).then_some(v);
    let c = Ctx { s, i, p: pos(m.last)?, h: pos(m.high)?, l: pos(m.low)?, v: m.volume.max(0.0) };
    let v = match t {
        Tech::RatingAll => {
            let (ma, other) = (c.rating_ma(), c.rating_other());
            match (ma.is_finite(), other.is_finite()) {
                (true, true) => (ma + other) / 2.0,
                (true, false) => ma,
                _ => other,
            }
        }
        Tech::RatingMa => c.rating_ma(),
        Tech::RatingOther => c.rating_other(),
        Tech::Mom(n) => c.mom(n),
        Tech::Ao => c.ao(),
        Tech::Cci => c.cci(),
        Tech::StochK => c.stoch().1,
        Tech::StochD => c.stoch().2,
        Tech::StochKFast => c.stoch().0,
        Tech::StochDFast => c.stoch().1,
    };
    v.is_finite().then_some(v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// Stepping the nightly job's state of 05/11/2026 with each ticker's bar of 06/11/2026 gives the values the
    /// job computes at the close of 06/11/2026 (fixture: 40 tickers of both state files, the job's own bars).
    #[test]
    fn step_matches_the_next_close() {
        #[derive(serde::Deserialize)]
        struct Case {
            ticker: String,
            bar: [f64; 5],
            carry: HashMap<String, Option<f64>>,
            expected: HashMap<String, Option<f64>>,
        }
        let cases: Vec<Case> = serde_json::from_str(include_str!("technicals_fixture.json")).unwrap();
        let techs = [
            Tech::RatingAll,
            Tech::RatingMa,
            Tech::RatingOther,
            Tech::Mom(10),
            Tech::Mom(14),
            Tech::Ao,
            Tech::Cci,
            Tech::StochK,
            Tech::StochD,
            Tech::StochKFast,
            Tech::StochDFast,
        ];
        let mut checked = 0;
        for case in &cases {
            let s = StateFile {
                version: 1,
                asof: chrono::NaiveDate::from_ymd_opt(2026, 11, 5).unwrap(),
                tickers: vec![case.ticker.clone()],
                num: case.carry.iter().map(|(k, v)| (k.clone(), vec![*v])).collect(),
                text: HashMap::new(),
            };
            let [o, h, l, cl, v] = case.bar;
            let m = MarketRow {
                ticker: case.ticker.clone(),
                last: cl,
                change: 0.0,
                change_percent: 0.0,
                open: o,
                high: h,
                low: l,
                volume: v,
                prev_close: None,
                live: true,
                updated_ms: 0.0,
            };
            for t in techs {
                let want = case.expected.get(state_key(t)).copied().flatten();
                let got = step(&s, 0, &m, t);
                match (want, got) {
                    // The state keeps 8 significant digits: sums of prices carry an error of about 1e-8 of the price.
                    (Some(w), Some(g)) => assert!((w - g).abs() <= 1e-5 * w.abs().max(cl), "{} {t:?}: {g} != {w}", case.ticker),
                    (None, None) => {}
                    _ => panic!("{} {t:?}: {got:?} != {want:?}", case.ticker),
                }
                checked += 1;
            }
        }
        assert!(checked >= 400);
    }

    #[test]
    fn buckets() {
        assert_eq!(bucket(0.51), "StrongBuy");
        assert_eq!(bucket(0.5), "Buy");
        assert_eq!(bucket(0.1), "Neutral");
        assert_eq!(bucket(-0.1), "Neutral");
        assert_eq!(bucket(-0.11), "Sell");
        assert_eq!(bucket(-0.5), "Sell");
        assert_eq!(bucket(-0.6), "StrongSell");
    }
}
