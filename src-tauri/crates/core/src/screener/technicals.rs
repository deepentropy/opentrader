/*
 * Technical ratings, oscillators and indicators one session after the daily state (S): every value of the nightly
 * job's `technicals.py` (deepentropy/gateway#27, #57) stepped with the live bar, from the carry-over columns it
 * writes, and the same values at the close of D (`at_close`), some derived from the state's columns.
 *
 * The ratings are the standard Technical Ratings (MAs: mean of 15 votes, oscillators: mean of 11, all: mean of
 * the two), with the reference screener's two differences: the Ichimoku vote reads the leading spans of the
 * current bar and the CCI is computed on (high + low + close) / 3. Votes without data are left out of the means.
 * Buckets: Strong buy above 0.5, Buy above 0.1, Sell below -0.1, Strong sell below -0.5, Neutral between.
 *
 * The indicator columns are the standard indicators' with the reference scanner's inputs: MACD 12 / 26 / 9, ADX
 * and DMI (ta.dmi(n, n)), Aroon 14, Bollinger Bands 20 and 50 x 2, Keltner channels EMA 20 +- 2 x ATR 10,
 * Donchian 20, Hull MA, VWMA 20, Ichimoku (the leading spans drawn on the bar: computed 25 bars before it for
 * 9 / 26 / 52 / 26, 30 for 20 / 60 / 120 / 30), money flow index 14, Chaikin money flow 20, rate of change 9,
 * Parabolic SAR 0.02 / 0.02 / 0.2, Stochastic RSI 3 / 3 / 14 / 14, Williams %R 14, Ultimate oscillator 7 / 14 / 28
 * and the monthly pivot points (the previous month's high, low, close and open).
 */
use crate::data::market_rest::MarketRow;
use crate::screener::state::StateFile;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Band {
    Upper,
    Basis,
    Lower,
}

/// Ichimoku inputs: 9 / 26 / 52 / 26 and 20 / 60 / 120 / 30.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cloud {
    Std,
    Long,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloudLine {
    Conversion,
    Base,
    SpanA,
    SpanB,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PivotKind {
    Classic,
    Fibonacci,
    Woodie,
    Camarilla,
    Demark,
}

/// A pivot level, in the order `pivot_levels` gives them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    P,
    R1,
    S1,
    R2,
    S2,
    R3,
    S3,
}

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
    MacdLevel,
    MacdSignal,
    /// ADX of ta.dmi(n, n): n = 9, 14, 20, 50 or 100.
    Adx(u32),
    /// +DI / -DI 14.
    DiPlus,
    DiMinus,
    AroonUp,
    AroonDown,
    /// Bollinger Bands of n = 20 or 50 closes, 2 deviations.
    Bb(u32, Band),
    Keltner(Band),
    Donchian(Band),
    BullBearPower,
    ChaikinMoneyFlow,
    /// Hull MA of n = 9, 20 or 200 bars.
    Hull(u32),
    Ichimoku(Cloud, CloudLine),
    MoneyFlow,
    Psar,
    Roc,
    StochRsiK,
    StochRsiD,
    Uo,
    Vwma,
    WilliamsR,
    /// Monthly pivot points.
    Pivot(PivotKind, Level),
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

/// The state column a value at the close of D comes from; for a value the app derives (bands around a middle the
/// state holds, pivot levels), the column whose presence means the state serves it.
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
        Tech::MacdLevel => "MACD.macd",
        Tech::MacdSignal => "MACD.signal",
        Tech::Adx(9) => "ADX_9",
        Tech::Adx(20) => "ADX_20",
        Tech::Adx(50) => "ADX_50",
        Tech::Adx(100) => "ADX_100",
        Tech::Adx(_) => "ADX",
        Tech::DiPlus => "ADX+DI",
        Tech::DiMinus => "ADX-DI",
        Tech::AroonUp => "Aroon.Up",
        Tech::AroonDown => "Aroon.Down",
        Tech::Bb(50, _) => "BB|dev50",
        Tech::Bb(..) => "BB|dev20",
        Tech::Keltner(_) => "KltChnl|r",
        Tech::Donchian(Band::Lower) => "DonchCh20.Lower",
        Tech::Donchian(_) => "DonchCh20.Upper",
        Tech::BullBearPower => "BBPower",
        Tech::ChaikinMoneyFlow => "ChaikinMoneyFlow",
        Tech::Hull(20) => "HullMA20",
        Tech::Hull(200) => "HullMA200",
        Tech::Hull(_) => "HullMA9",
        Tech::Ichimoku(cloud, line) => match (cloud, line) {
            (Cloud::Std, CloudLine::Conversion) => "Ichimoku.CLine",
            (Cloud::Std, CloudLine::Base) => "Ichimoku.BLine",
            (Cloud::Std, CloudLine::SpanA) => "Ichimoku.Lead1",
            (Cloud::Std, CloudLine::SpanB) => "Ichimoku.Lead2",
            (Cloud::Long, CloudLine::Conversion) => "Ichimoku.CLine_20_60_120_30",
            (Cloud::Long, CloudLine::Base) => "Ichimoku.BLine_20_60_120_30",
            (Cloud::Long, CloudLine::SpanA) => "Ichimoku.Lead1_20_60_120_30",
            (Cloud::Long, CloudLine::SpanB) => "Ichimoku.Lead2_20_60_120_30",
        },
        Tech::MoneyFlow => "MoneyFlow",
        Tech::Psar => "P.SAR",
        Tech::Roc => "ROC",
        Tech::StochRsiK => "Stoch.RSI.K",
        Tech::StochRsiD => "Stoch.RSI.D",
        Tech::Uo => "UO",
        Tech::Vwma => "VWMA",
        Tech::WilliamsR => "W.R",
        Tech::Pivot(..) => "Pivot.M|ph",
    }
}

/// Pivot levels (P, R1, S1, R2, S2, R3, S3; DeMark: P, R1, S1) from a month's high, low, close and first open, and
/// the next month's first open (Woodie): `ta.pivot_point_levels`, the kinds the reference scanner matches (25/11/2026:
/// Classic's third levels are P +- 2 x range, Camarilla's middle is (H + L + C) / 3). A level below zero has no value
/// there (about 1,300 symbols' Classic S3).
fn pivot_level(kind: PivotKind, level: Level, h: f64, l: f64, c: f64, o: f64, wo: f64) -> f64 {
    let v = pivot_formula(kind, level, h, l, c, o, wo);
    if v < 0.0 {
        f64::NAN
    } else {
        v
    }
}

fn pivot_formula(kind: PivotKind, level: Level, h: f64, l: f64, c: f64, o: f64, wo: f64) -> f64 {
    let r = h - l;
    let p = (h + l + c) / 3.0;
    let at = |levels: [f64; 7]| levels[level as usize];
    match kind {
        PivotKind::Classic => at([p, 2.0 * p - l, 2.0 * p - h, p + r, p - r, p + 2.0 * r, p - 2.0 * r]),
        PivotKind::Fibonacci => at([p, p + 0.382 * r, p - 0.382 * r, p + 0.618 * r, p - 0.618 * r, p + r, p - r]),
        PivotKind::Woodie => {
            let p = (h + l + 2.0 * wo) / 4.0;
            at([p, 2.0 * p - l, 2.0 * p - h, p + r, p - r, h + 2.0 * (p - l), l - 2.0 * (h - p)])
        }
        PivotKind::Camarilla => {
            let k = r * 1.1;
            at([p, c + k / 12.0, c - k / 12.0, c + k / 6.0, c - k / 6.0, c + k / 4.0, c - k / 4.0])
        }
        PivotKind::Demark => {
            let x = if c < o {
                h + 2.0 * l + c
            } else if c > o {
                2.0 * h + l + c
            } else {
                h + l + 2.0 * c
            };
            match level {
                Level::P => x / 4.0,
                Level::R1 => x / 2.0 - l,
                Level::S1 => x / 2.0 - h,
                _ => f64::NAN,
            }
        }
    }
}

fn band(b: Band, basis: f64, width: f64) -> f64 {
    match b {
        Band::Upper => basis + width,
        Band::Basis => basis,
        Band::Lower => basis - width,
    }
}

/// The value of `t` at the close of D, from the state alone.
pub fn at_close(s: &StateFile, i: usize, t: Tech) -> Option<f64> {
    let n = |k: &str| s.num(k, i).unwrap_or(f64::NAN);
    let v = match t {
        Tech::Bb(len, b) => band(b, n(&format!("SMA{len}")), 2.0 * n(&format!("BB|dev{len}"))),
        Tech::Keltner(b) => band(b, n("EMA20"), 2.0 * n("KltChnl|r")),
        Tech::Donchian(Band::Basis) => (n("DonchCh20.Upper") + n("DonchCh20.Lower")) / 2.0,
        Tech::Pivot(kind, level) => {
            pivot_level(kind, level, n("Pivot.M|ph"), n("Pivot.M|pl"), n("Pivot.M|pc"), n("Pivot.M|po"), n("Pivot.M|o"))
        }
        _ => n(state_key(t)),
    };
    v.is_finite().then_some(v)
}

/// The live bar and the state row of one ticker. Missing values read as NaN.
struct Ctx<'a> {
    s: &'a StateFile,
    i: usize,
    o: f64,
    p: f64,
    h: f64,
    l: f64,
    v: f64,
    /// S is in another month than D (the pivot points move to D's month).
    new_month: bool,
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

    /// S's true range (D's close before it).
    fn tr(&self) -> f64 {
        let pc = self.n("close");
        (self.h - self.l).max((self.h - pc).abs()).max((self.l - pc).abs())
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

    /// Stochastic RSI 3 / 3 / 14 / 14: (%K, %D).
    fn stoch_rsi(&self) -> (f64, f64) {
        let rsi = self.rsi();
        let (rh, rl) = (self.n("Stoch.RSI|h13").max(rsi), self.n("Stoch.RSI|l13").min(rsi));
        let k = (100.0 * (rsi - rl) / (rh - rl) + self.n("Stoch.RSI|r2")) / 3.0;
        (k, (k + self.n("Stoch.RSI|k2")) / 3.0)
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

    /// MACD 12 / 26 / 9: (level, signal).
    fn macd(&self) -> (f64, f64) {
        let macd = self.ema("MACD|e12", 12.0) - self.ema("MACD|e26", 26.0);
        (macd, self.n("MACD.signal") + 0.2 * (macd - self.n("MACD.signal")))
    }

    /// ta.dmi(n, n): (+DI, -DI, ADX), Wilder averages of the true range and the directional moves.
    fn dmi(&self, n: u32) -> (f64, f64, f64) {
        let key = |k: &str| if n == 14 { format!("ADX{k}") } else { format!("ADX_{n}{k}") };
        let (h, l) = (self.h, self.l);
        let (up, down) = (h - self.n("ADX|h"), self.n("ADX|l") - l);
        let pdm = if up > down && up > 0.0 { up } else { 0.0 };
        let mdm = if down > up && down > 0.0 { down } else { 0.0 };
        let w = n as f64;
        let trur = (self.n(&key("|tr")) * (w - 1.0) + self.tr()) / w;
        let plus = 100.0 * (self.n(&key("|p")) * (w - 1.0) + pdm) / w / trur;
        let minus = 100.0 * (self.n(&key("|m")) * (w - 1.0) + mdm) / w / trur;
        let sum = plus + minus;
        let adx = (self.n(&key("")) * (w - 1.0) + 100.0 * (plus - minus).abs() / if sum == 0.0 { 1.0 } else { sum }) / w;
        (plus, minus, adx)
    }

    /// Aroon 14: 100 x (14 - bars since the highest high / lowest low of the last 15 bars) / 14, the most recent of
    /// equal ones; the carry holds the extreme of the 14 bars before S and how many bars before D it is.
    fn aroon(&self, up: bool) -> f64 {
        let (x, ext, ago) = if up {
            (self.h, self.n("Aroon|u"), self.n("Aroon|ub"))
        } else {
            (-self.l, -self.n("Aroon|d"), self.n("Aroon|db"))
        };
        if ext.is_nan() {
            return f64::NAN;
        }
        let since = if x >= ext { 0.0 } else { ago + 1.0 };
        100.0 * (14.0 - since) / 14.0
    }

    /// Hull MA n = WMA floor(sqrt(n)) of (2 x WMA n/2 - WMA n): the carried weighted sums of the bars before S.
    fn hull(&self, n: u32) -> f64 {
        let (p, half, sq) = (self.p, n / 2, (n as f64).sqrt() as u32);
        let wsum = |k: u32| (k * (k + 1) / 2) as f64;
        let wma = |k: u32| (k as f64 * p + self.n(&format!("HullMA{n}|w{k}"))) / wsum(k);
        let diff = 2.0 * wma(half) - wma(n);
        (sq as f64 * diff + self.n(&format!("HullMA{n}|d"))) / wsum(sq)
    }

    fn vwma(&self) -> f64 {
        (self.n("VWMA|cv") + self.p * self.v) / (self.n("VWMA|v") + self.v)
    }

    fn williams_r(&self) -> f64 {
        let (hh, ll) = (self.hi("Stoch|h13"), self.lo("Stoch|l13"));
        100.0 * (self.p - hh) / (hh - ll)
    }

    fn uo(&self) -> f64 {
        let (l, h, pc) = (self.l, self.h, self.n("close"));
        let (tmin, tmax) = (l.min(pc), h.max(pc));
        let (bp, trn) = (self.p - tmin, tmax - tmin);
        let avg = |n: u32| (self.n(&format!("UO|bp{n}")) + bp) / (self.n(&format!("UO|tr{n}")) + trn);
        100.0 * (4.0 * avg(6) + 2.0 * avg(13) + avg(27)) / 7.0
    }

    /// Bull bear power 13: (high - EMA 13) and (low - EMA 13).
    fn bull_bear(&self) -> (f64, f64) {
        let e13 = self.ema("BBPower|e13", 13.0);
        (self.h - e13, self.l - e13)
    }

    /// Bollinger Bands of n closes: S's close joins the n - 1 before it (their sum and squared deviations).
    fn bollinger(&self, n: u32, b: Band) -> f64 {
        let k = n as f64;
        let sum = self.n(&format!("SMA{n}|next"));
        let prev_mean = sum / (k - 1.0);
        let m2 = self.n(&format!("BB|v{}", n - 1)) + (self.p - prev_mean).powi(2) * (k - 1.0) / k;
        band(b, (sum + self.p) / k, 2.0 * (m2 / k).sqrt())
    }

    fn keltner(&self, b: Band) -> f64 {
        let atr = (self.n("KltChnl|r") * 9.0 + self.tr()) / 10.0;
        band(b, self.ema("EMA20", 20.0), 2.0 * atr)
    }

    fn donchian(&self, b: Band) -> f64 {
        let (up, low) = (self.hi("DonchCh20|h19"), self.lo("DonchCh20|l19"));
        match b {
            Band::Upper => up,
            Band::Basis => (up + low) / 2.0,
            Band::Lower => low,
        }
    }

    fn chaikin(&self) -> f64 {
        let (p, h, l) = (self.p, self.h, self.l);
        let ad = if (p == h && p == l) || h == l { 0.0 } else { (2.0 * p - l - h) / (h - l) * self.v };
        (self.n("ChaikinMoneyFlow|ad") + ad) / (self.n("VWMA|v") + self.v)
    }

    /// Money flow index 14 on hlc3 (D's hlc3 is the CCI's first carried value).
    fn money_flow(&self) -> f64 {
        let src = (self.h + self.l + self.p) / 3.0;
        let ch = src - self.n("CCI20|1");
        let flow = self.v * src;
        let up = self.n("MoneyFlow|u13") + if ch <= 0.0 { 0.0 } else { flow };
        let down = self.n("MoneyFlow|d13") + if ch >= 0.0 { 0.0 } else { flow };
        100.0 - 100.0 / (1.0 + up / down)
    }

    fn ichimoku(&self, cloud: Cloud, line: CloudLine) -> f64 {
        let (sfx, a, b) = match cloud {
            Cloud::Std => ("", ("Ichimoku|h8", "Ichimoku|l8"), ("Ichimoku|h25", "Ichimoku|l25")),
            Cloud::Long => (
                "_20_60_120_30",
                ("Ichimoku_20_60_120_30|h19", "Ichimoku_20_60_120_30|l19"),
                ("Ichimoku_20_60_120_30|h59", "Ichimoku_20_60_120_30|l59"),
            ),
        };
        match line {
            CloudLine::Conversion => (self.hi(a.0) + self.lo(a.1)) / 2.0,
            CloudLine::Base => (self.hi(b.0) + self.lo(b.1)) / 2.0,
            // The spans drawn on S were computed bars before it: the state holds them.
            CloudLine::SpanA => self.n(&format!("Ichimoku.Lead1{sfx}|next")),
            CloudLine::SpanB => self.n(&format!("Ichimoku.Lead2{sfx}|next")),
        }
    }

    /// Parabolic SAR 0.02 / 0.02 / 0.2 (Pine ta.sar) one bar after D's stop, extreme point, acceleration and side
    /// (S's new extreme and acceleration only move the stops after it).
    fn psar(&self) -> f64 {
        let (h, l) = (self.h, self.l);
        let ep = self.n("P.SAR|ep");
        let prev = self.n("P.SAR");
        let mut res = prev + self.n("P.SAR|af") * (ep - prev);
        let mut below = self.n("P.SAR|up") == 1.0;
        // S's bar crossing the stop turns the trend: the stop jumps to the extreme point or S's own extreme.
        if below && res > l {
            below = false;
            res = h.max(ep);
        } else if !below && res < h {
            below = true;
            res = l.min(ep);
        }
        // The stop never enters the two bars before S.
        if below {
            res.min(self.n("ADX|l")).min(self.n("P.SAR|l2"))
        } else {
            res.max(self.n("ADX|h")).max(self.n("P.SAR|h2"))
        }
    }

    fn pivot(&self, kind: PivotKind, level: Level) -> f64 {
        if self.new_month {
            // S opens a month: the levels come from D's month, Woodie's from S's open.
            pivot_level(kind, level, self.n("Pivot.M|h"), self.n("Pivot.M|l"), self.n("close"), self.n("Pivot.M|o"), self.o)
        } else {
            at_close(self.s, self.i, Tech::Pivot(kind, level)).unwrap_or(f64::NAN)
        }
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
        votes.push(side(p, self.hull(9)));
        votes.push(side(p, self.vwma()));
        let con = self.ichimoku(Cloud::Std, CloudLine::Conversion);
        let base = self.ichimoku(Cloud::Std, CloudLine::Base);
        // The vote reads the leading spans computed on the current bar.
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
        let p = self.p;
        let rsi = self.rsi();
        let rsi1 = self.n("RSI");
        let (_, k, d) = self.stoch();
        let cci = self.cci();
        let cci1 = self.n("CCI20");
        let (plus, minus, adx) = self.dmi(14);
        let adx1 = self.n("ADX");
        let (ao, ao1, ao2) = (self.ao(), self.n("AO"), self.n("AO|1"));
        let (mom, mom1) = (self.mom(10), self.n("Mom"));
        let (macd, signal) = self.macd();
        let ema50 = self.ema("EMA50", 50.0);
        let (up_trend, down_trend) = (gt(p, ema50), lt(p, ema50));
        let (sk, sd) = self.stoch_rsi();
        let wr = self.williams_r();
        let wr1 = self.n("W.R");
        let (bull, bear) = self.bull_bear();
        let uo = self.uo();
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
    let new_month = m.updated_ms > 0.0
        && crate::screener::clock::ny_date_ms(m.updated_ms).is_some_and(|d| {
            use chrono::Datelike;
            (d.year(), d.month()) != (s.asof.year(), s.asof.month())
        });
    let c = Ctx { s, i, o: m.open, p: pos(m.last)?, h: pos(m.high)?, l: pos(m.low)?, v: m.volume.max(0.0), new_month };
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
        Tech::MacdLevel => c.macd().0,
        Tech::MacdSignal => c.macd().1,
        Tech::Adx(n) => c.dmi(n).2,
        Tech::DiPlus => c.dmi(14).0,
        Tech::DiMinus => c.dmi(14).1,
        Tech::AroonUp => c.aroon(true),
        Tech::AroonDown => c.aroon(false),
        Tech::Bb(n, b) => c.bollinger(n, b),
        Tech::Keltner(b) => c.keltner(b),
        Tech::Donchian(b) => c.donchian(b),
        Tech::BullBearPower => {
            let (bull, bear) = c.bull_bear();
            bull + bear
        }
        Tech::ChaikinMoneyFlow => c.chaikin(),
        Tech::Hull(n) => c.hull(n),
        Tech::Ichimoku(cloud, line) => c.ichimoku(cloud, line),
        Tech::MoneyFlow => c.money_flow(),
        Tech::Psar => c.psar(),
        Tech::Roc => 100.0 * (c.p / c.n("ROC|c9") - 1.0),
        Tech::StochRsiK => c.stoch_rsi().0,
        Tech::StochRsiD => c.stoch_rsi().1,
        Tech::Uo => c.uo(),
        Tech::Vwma => c.vwma(),
        Tech::WilliamsR => c.williams_r(),
        Tech::Pivot(kind, level) => c.pivot(kind, level),
    };
    v.is_finite().then_some(v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(serde::Deserialize)]
    struct Fixture {
        asof: chrono::NaiveDate,
        next: chrono::NaiveDate,
        updated_ms: f64,
        cases: Vec<Case>,
    }

    #[derive(serde::Deserialize)]
    struct Case {
        ticker: String,
        bar: [f64; 5],
        carry: HashMap<String, Option<f64>>,
        expected: HashMap<String, Option<f64>>,
    }

    fn fixture() -> Fixture {
        serde_json::from_str(include_str!("technicals_fixture.json")).unwrap()
    }

    fn state(asof: chrono::NaiveDate, ticker: &str, cols: &HashMap<String, Option<f64>>) -> StateFile {
        StateFile {
            version: 1,
            asof,
            tickers: vec![ticker.to_string()],
            num: cols.iter().map(|(k, v)| (k.clone(), vec![*v])).collect(),
            text: HashMap::new(),
        }
    }

    fn bar_row(case: &Case, updated_ms: f64) -> MarketRow {
        let [o, h, l, c, v] = case.bar;
        MarketRow {
            ticker: case.ticker.clone(),
            last: c,
            change: 0.0,
            change_percent: 0.0,
            open: o,
            high: h,
            low: l,
            volume: v,
            prev_close: None,
            live: true,
            updated_ms,
            ext: Default::default(),
        }
    }

    /// Every field the screener offers from this file.
    fn all_techs() -> Vec<Tech> {
        let mut out = vec![
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
            Tech::MacdLevel,
            Tech::MacdSignal,
            Tech::DiPlus,
            Tech::DiMinus,
            Tech::AroonUp,
            Tech::AroonDown,
            Tech::BullBearPower,
            Tech::ChaikinMoneyFlow,
            Tech::MoneyFlow,
            Tech::Psar,
            Tech::Roc,
            Tech::StochRsiK,
            Tech::StochRsiD,
            Tech::Uo,
            Tech::Vwma,
            Tech::WilliamsR,
        ];
        out.extend([9, 14, 20, 50, 100].map(Tech::Adx));
        out.extend([9, 20, 200].map(Tech::Hull));
        for b in [Band::Upper, Band::Basis, Band::Lower] {
            out.extend([Tech::Bb(20, b), Tech::Bb(50, b), Tech::Keltner(b), Tech::Donchian(b)]);
        }
        for cloud in [Cloud::Std, Cloud::Long] {
            for line in [CloudLine::Conversion, CloudLine::Base, CloudLine::SpanA, CloudLine::SpanB] {
                out.push(Tech::Ichimoku(cloud, line));
            }
        }
        for kind in [PivotKind::Classic, PivotKind::Fibonacci, PivotKind::Woodie, PivotKind::Camarilla, PivotKind::Demark] {
            let levels: &[Level] = if kind == PivotKind::Demark {
                &[Level::P, Level::R1, Level::S1]
            } else {
                &[Level::P, Level::R1, Level::S1, Level::R2, Level::S2, Level::R3, Level::S3]
            };
            out.extend(levels.iter().map(|l| Tech::Pivot(kind, *l)));
        }
        out
    }

    /// Stepping the nightly job's state at the close of 30/10/2026 with each ticker's bar of 02/11/2026 gives the
    /// values of its state at the close of 02/11/2026, the first session of a month for the pivot points (fixture: 44
    /// tickers of both states built from the job's bars, among them Parabolic SAR turns and new Aroon highs / lows).
    #[test]
    fn step_matches_the_next_close() {
        let f = fixture();
        let mut checked = 0;
        for case in &f.cases {
            let (s, s_next) = (state(f.asof, &case.ticker, &case.carry), state(f.next, &case.ticker, &case.expected));
            let m = bar_row(case, f.updated_ms);
            let cl = case.bar[3];
            for t in all_techs() {
                let want = at_close(&s_next, 0, t);
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
        assert!(f.cases.len() >= 40 && checked == f.cases.len() * all_techs().len());
    }

    /// Within D's month the pivot levels stay those of the close of D.
    #[test]
    fn pivots_hold_within_the_month() {
        let f = fixture();
        let case = &f.cases[0];
        let s = state(f.asof, &case.ticker, &case.carry);
        let same_month = f.updated_ms - 3.0 * 86_400_000.0; // 30/10/2026
        let m = bar_row(case, same_month);
        for kind in [PivotKind::Classic, PivotKind::Woodie, PivotKind::Demark] {
            let t = Tech::Pivot(kind, Level::R1);
            assert_eq!(step(&s, 0, &m, t), at_close(&s, 0, t));
        }
        let m = bar_row(case, f.updated_ms);
        assert_ne!(step(&s, 0, &m, Tech::Pivot(PivotKind::Classic, Level::P)), at_close(&s, 0, Tech::Pivot(PivotKind::Classic, Level::P)));
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
