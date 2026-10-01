/*
 * Trading sessions of one symbol — when it trades, in exchange-local time.
 *
 * Each provider describes every symbol it serves with this shape (the symbol
 * info `timezone` / `session` / `subsessions` / holidays / corrections fields
 * of a datafeed), so the frontend never assumes one market: the RTH filter,
 * session-anchored bars, countdown, pre/post tint and market status all read
 * the session of the symbol on screen.
 *
 * The same reply carries the symbol's price grid (tick size), also needed
 * before the first bars (script `syminfo.mintick`, backtest fill rounding).
 *
 * Spec strings use the common datafeed session grammar, parsed on the frontend
 * (src/data/session/spec.ts documents it): "0930-1600" (Mon-Fri),
 * "0930-1600:23456" (explicit days, 1 = Sunday), "1700-1600" (overnight,
 * opens the previous day), "24x7", several intervals "0900-1130,1230-1530".
 */
use serde::{Deserialize, Serialize};

/// Sessions and price grid of a symbol. `session` is the regular session;
/// `subsessions` names the parts of the trading day the provider serves.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SymbolSession {
    /// IANA time zone of the exchange ("America/New_York").
    pub timezone: String,
    /// Regular session spec ("0930-1600").
    pub session: String,
    /// Parts of the trading day, by id: "regular", "extended" (the whole
    /// traded day incl. pre/post), "premarket", "postmarket". Empty when the
    /// symbol only has the regular session.
    pub subsessions: Vec<Subsession>,
    /// Full-close days, "YYYYMMDD,YYYYMMDD,…" (empty = none).
    pub holidays: String,
    /// Days with other hours for the regular session:
    /// "spec:YYYYMMDD,…;dayoff:YYYYMMDD,…" (empty = none).
    pub corrections: String,
    /// Price grid at the current price: one tick = `minmov / pricescale`
    /// (100 / 1 = 0.01; NSE stocks at 1,000-5,000 INR: 10 / 1 = 0.1).
    pub pricescale: u32,
    pub minmov: u32,
    /// Tick by price band, "t0 b1 t1 b2 t2 …": tick t0 below price b1, t1
    /// below b2, …, the last tick above the last bound ("0.0001 1 0.01": US
    /// stocks under 1 trade in 0.0001). Empty = the `minmov / pricescale`
    /// tick at every price.
    pub variable_tick_size: String,
}

/// One named part of the trading day.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Subsession {
    /// "regular" | "extended" | "premarket" | "postmarket".
    pub id: String,
    /// Display name ("Regular Trading Hours").
    pub description: String,
    /// Spec of this part ("0400-0930").
    pub session: String,
    /// Corrections of this part, same grammar as `SymbolSession::corrections`.
    pub corrections: String,
}

impl Subsession {
    pub fn new(id: &str, description: &str, session: &str) -> Self {
        Self {
            id: id.into(),
            description: description.into(),
            session: session.into(),
            corrections: String::new(),
        }
    }
}
