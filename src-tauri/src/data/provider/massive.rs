/*
 * Massive.io implementation of the `DataProvider` traits.
 *
 * Thin forwarders to the existing `massive_rest` / `massive_poll` functions — no
 * fetch logic lives here. The per-session disk cache, daily memo, and prior-
 * session-close cache all stay inside `massive_rest`, so they're carried for
 * free; a future provider can add its own caching independently.
 *
 * Stateless: the struct holds nothing (the gateway token is compiled in and read
 * per call inside `massive_rest`), so it's trivially `Send + Sync` and cloneable.
 */
use super::capabilities::{
    DataStatus, HistoryFloor, HistoryProbe, ProviderCapabilities, ReferenceCaps, ResolutionCaps,
    StreamCaps,
};
use super::entitlements;
use super::{DataProvider, HistoryProvider, RealtimeProvider, ReferenceProvider};
use crate::data::types::{
    Candle, DividendEvent, NewsItem, Snapshot, SplitEvent, SymbolSearchResult, TickerInfo,
    WsHandle,
};
use crate::data::session::{Subsession, SymbolSession};
use crate::data::symbol::SymbolRef;
use crate::data::{daily_archive, gateway, massive_poll, ticker_case, massive_rest, massive_ws, trading_calendar};
use anyhow::Result;
use chrono::{Datelike, NaiveDate, Utc};
use std::sync::OnceLock;
use tauri::AppHandle;

pub struct MassiveProvider;

#[async_trait::async_trait]
impl HistoryProvider for MassiveProvider {
    async fn daily_aggs(
        &self,
        sym: &SymbolRef,
        from: NaiveDate,
        to: NaiveDate,
        adjusted: bool,
    ) -> Result<Vec<Candle>> {
        massive_rest::fetch_daily_aggs(&ticker_case::to_source(&sym.ticker), from, to, adjusted).await
    }
    async fn daily_archive(&self, sym: &SymbolRef, adjusted: bool) -> Result<Vec<Candle>> {
        daily_archive::daily_bars(&ticker_case::to_source(&sym.ticker), adjusted).await
    }
    async fn minute_aggs(
        &self,
        sym: &SymbolRef,
        mult: u32,
        from: NaiveDate,
        to: NaiveDate,
        adjusted: bool,
    ) -> Result<Vec<Candle>> {
        massive_rest::fetch_minute_aggs(&ticker_case::to_source(&sym.ticker), mult, from, to, adjusted).await
    }
    async fn second_aggs(
        &self,
        sym: &SymbolRef,
        mult: u32,
        from: NaiveDate,
        to: NaiveDate,
        adjusted: bool,
    ) -> Result<Vec<Candle>> {
        massive_rest::fetch_second_aggs(&ticker_case::to_source(&sym.ticker), mult, from, to, adjusted).await
    }
    async fn second_tail(
        &self,
        sym: &SymbolRef,
        mult: u32,
        since_sec: f64,
        adjusted: bool,
    ) -> Result<Vec<Candle>> {
        massive_rest::fetch_second_tail(&ticker_case::to_source(&sym.ticker), mult, since_sec, adjusted).await
    }
}

#[async_trait::async_trait]
impl ReferenceProvider for MassiveProvider {
    async fn ticker_info(&self, sym: &SymbolRef) -> Result<TickerInfo> {
        // Answered under the app's name, not the source's spelling.
        let mut info = massive_rest::fetch_ticker_info(&ticker_case::to_source(&sym.ticker)).await?;
        info.ticker = sym.ticker.clone();
        Ok(info)
    }
    async fn symbol_session(&self, sym: &SymbolRef) -> Result<SymbolSession> {
        let mut session = us_equity_session();
        if sym.exchange == "OTC" {
            session.variable_tick_size = OTC_TICKS.into();
        }
        Ok(session)
    }
    async fn ticker_snapshot(&self, sym: &SymbolRef) -> Result<Snapshot> {
        let mut snapshot = massive_rest::fetch_ticker_snapshot(&ticker_case::to_source(&sym.ticker)).await?;
        snapshot.ticker = sym.ticker.clone();
        Ok(snapshot)
    }
    async fn search(
        &self,
        query: &str,
        type_filter: Option<&str>,
    ) -> Result<Vec<SymbolSearchResult>> {
        massive_rest::search_tickers(query, type_filter).await
    }
    async fn dividends(&self, sym: &SymbolRef) -> Vec<DividendEvent> {
        massive_rest::dividend_events(&ticker_case::to_source(&sym.ticker)).await
    }
    async fn splits(&self, sym: &SymbolRef) -> Vec<SplitEvent> {
        massive_rest::split_events(&ticker_case::to_source(&sym.ticker)).await
    }
    async fn latest_news(&self, sym: &SymbolRef, limit: u32) -> Vec<NewsItem> {
        massive_rest::latest_news(&ticker_case::to_source(&sym.ticker), limit).await
    }
    async fn icon(&self, encoded: &str) -> Result<(Vec<u8>, String)> {
        massive_rest::fetch_icon(encoded).await
    }
}

impl RealtimeProvider for MassiveProvider {
    fn spawn(&self, app: AppHandle) -> WsHandle {
        // Two live tasks behind one handle:
        //   • the REST snapshot poller — always: watchlist quotes (regular
        //     Last, change, Ext) and the chart minute / day bars; the whole
        //     live feed for a key without stream channels;
        //   • the second-bars WebSocket — only when the probe grants `A` and a
        //     chart is open: live bars for the seconds charts.
        // The WebSocket and `probe_stream` share the WebSocket slot in `massive_ws`, so
        // they never hold two connections on the key.
        massive_ws::fan_out(vec![
            massive_poll::spawn(app.clone()),
            massive_ws::spawn_second_bars(app),
        ])
    }
}

/// Session of the US equities this provider serves (the app reads the
/// stocks market only): 09:30-16:00 New York, extended 04:00-20:00, NYSE/NASDAQ
/// holidays and early closes from the computed calendar (early-close days:
/// regular 09:30-13:00, post-market 13:00-17:00, extended 04:00-17:00, as the
/// reference app's corrections). Built once: the lists run from the calendar
/// floor to next year.
fn us_equity_session() -> SymbolSession {
    static SESSION: OnceLock<SymbolSession> = OnceLock::new();
    SESSION
        .get_or_init(|| {
            let (from, to) = (trading_calendar::floor_year(), Utc::now().year() + 1);
            let early = trading_calendar::early_closes_spec(from, to);
            let corrected = |id: &str, name: &str, session: &str, short_day: &str| Subsession {
                corrections: format!("{short_day}:{early}"),
                ..Subsession::new(id, name, session)
            };
            SymbolSession {
                timezone: "America/New_York".into(),
                // 0.01, and 0.0001 under 1 (the reference app's US stock grid).
                pricescale: 100,
                minmov: 1,
                variable_tick_size: "0.0001 1 0.01".into(),
                session: "0930-1600".into(),
                subsessions: vec![
                    corrected("regular", "Regular Trading Hours", "0930-1600", "0930-1300"),
                    corrected("extended", "Extended Trading Hours", "0400-2000", "0400-1700"),
                    Subsession::new("premarket", "Premarket", "0400-0930"),
                    corrected("postmarket", "Postmarket", "1600-2000", "1300-1700"),
                ],
                holidays: trading_calendar::holidays_spec(from, to),
                corrections: format!("0930-1300:{early}"),
            }
        })
        .clone()
}

/// Tick bands of OTC listings (the reference app's OTC:TCEHY grid).
const OTC_TICKS: &str = "0.000001 0.0001 0.0001 1 0.01";

/// Ticker used by the entitlement probes: listed long before any plan's
/// history floor, so its first bar marks the plan floor.
const PROBE_TICKER: &str = "AAPL";

/// Massive's delayed plans are 15 minutes behind (massive.com/pricing,
/// 27/09/2026).
const DELAYED_SEC: u32 = 15 * 60;

#[async_trait::async_trait]
impl DataProvider for MassiveProvider {
    fn name(&self) -> &'static str {
        "massive"
    }

    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            name: self.name().to_string(),
            // The multipliers this app is wired for (the datafeed's lookback
            // tables). The aggregates endpoint accepts any multiplier; serving
            // more is a separate decision.
            resolutions: ResolutionCaps {
                seconds: vec![1, 5, 10, 15, 30, 45],
                minutes: vec![1, 5, 15, 30, 60, 120, 240],
                daily: true,
                weekly_monthly_from_daily: true,
            },
            max_bars_per_request: 50_000,
            adjusted_toggle: true,
            extended_hours: true,
            reference: ReferenceCaps {
                search: true,
                search_type_filter: true,
                snapshot: true,
                dividends: true,
                splits: true,
                news: true,
                icons: true,
            },
            entitlements: None,
        }
    }

    fn credential_id(&self) -> Option<String> {
        // Gateway + token: a new gateway or a rotated token re-probes.
        gateway::token().map(|t| entitlements::fingerprint(&format!("{}|{t}", gateway::BASE)))
    }

    async fn probe_history(&self) -> Result<HistoryProbe> {
        let (day, minute, second) = tokio::join!(
            massive_rest::probe_oldest_bar(PROBE_TICKER, "day"),
            massive_rest::probe_oldest_bar(PROBE_TICKER, "minute"),
            massive_rest::probe_oldest_bar(PROBE_TICKER, "second"),
        );
        let (day, raw_status) = day?;
        let fmt = |d: Option<chrono::NaiveDate>| d.map(|d| d.format("%Y-%m-%d").to_string());
        // A failing sub-daily probe leaves that floor unknown rather than
        // failing the whole probe.
        let minute = minute.ok().and_then(|(d, _)| d);
        let second = second.ok().and_then(|(d, _)| d);
        let (data_status, delay_sec) = match raw_status.as_str() {
            // Observed on the delayed key, 27/09/2026.
            "DELAYED" => (DataStatus::DelayedStreaming, DELAYED_SEC),
            // Not observed (needs a real-time key); Massive's non-delayed
            // responses report "OK".
            "OK" => (DataStatus::Streaming, 0),
            _ => (DataStatus::Unknown, 0),
        };
        Ok(HistoryProbe {
            data_status,
            raw_status,
            delay_sec,
            floor: HistoryFloor {
                second: fmt(second),
                minute: fmt(minute),
                day: fmt(day),
            },
        })
    }

    /// One stream URL: the gateway picks the delayed or real-time feed, so
    /// `data_status` does not choose the endpoint.
    async fn probe_stream(&self, _data_status: DataStatus) -> Result<StreamCaps> {
        let token = gateway::token().ok_or_else(|| anyhow::anyhow!(gateway::NO_TOKEN))?;
        let channels = ["AM.", "A.", "T.", "Q."].map(|p| format!("{p}{PROBE_TICKER}"));
        let refs: Vec<&str> = channels.iter().map(String::as_str).collect();
        let granted = massive_ws::probe_channels(gateway::WS_URL, token, &refs).await?;
        Ok(StreamCaps {
            minute_bars: granted[0],
            second_bars: granted[1],
            trades: granted[2],
            quotes: granted[3],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The static resolution set must equal the datafeed's lookback tables
    /// (src/data/datafeed.ts SECOND_INTERVALS / INTRADAY_INTERVALS /
    /// DAILY_INTERVALS), so the capabilities call changes nothing on screen.
    #[test]
    fn static_resolutions_match_datafeed_tables() {
        let r = MassiveProvider.capabilities().resolutions;
        assert_eq!(r.seconds, vec![1, 5, 10, 15, 30, 45]);
        assert_eq!(r.minutes, vec![1, 5, 15, 30, 60, 120, 240]);
        assert!(r.daily && r.weekly_monthly_from_daily);
    }

    /// The US session matches the reference app's symbol info for US stocks
    /// (NASDAQ:AAPL, NYSE:IBM resolved 01/10/2026): New York, regular
    /// 09:30-16:00, extended 04:00-20:00, and the same 2025-2026 holidays.
    #[test]
    fn us_equity_session_matches_reference() {
        let s = us_equity_session();
        assert_eq!(s.timezone, "America/New_York");
        assert_eq!(s.session, "0930-1600");
        let ext = s.subsessions.iter().find(|x| x.id == "extended").unwrap();
        assert_eq!(ext.session, "0400-2000");
        let reference = "20250101,20250120,20250217,20250418,20250526,20250619,20250704,20250901,20251127,20251225,\
                         20260101,20260119,20260216,20260403,20260525,20260619,20260703,20260907,20261126,20261225";
        let ours: Vec<&str> = s
            .holidays
            .split(',')
            // 09/01/2025 is a "dayoff" correction in the reference, not a holiday.
            .filter(|d| *d >= "20250101" && *d < "20270101" && *d != "20250109")
            .collect();
        assert_eq!(ours.join(","), reference);
        // 09/01/2025 (a one-off day off in the reference corrections) is closed.
        assert!(s.holidays.contains("20250109"));
    }

    /// Early closes match the reference app's US correction list for 2019 and
    /// 2021-2026 (its list has no 2020 entries; 2027 differs, see
    /// trading_calendar). Hours as its corrections.
    #[test]
    fn us_equity_early_closes_match_reference() {
        let s = us_equity_session();
        let reference = "20190703,20191129,20191224,20211126,20221125,20230703,20231124,20240703,\
                         20241129,20241224,20250703,20251128,20251224,20261127,20261224";
        let dates = s.corrections.trim_start_matches("0930-1300:");
        let ours: Vec<&str> = dates
            .split(',')
            .filter(|d| (*d >= "20190101" && *d < "20200101") || (*d >= "20210101" && *d < "20270101"))
            .collect();
        assert_eq!(ours.join(","), reference);
        let sub = |id: &str| s.subsessions.iter().find(|x| x.id == id).unwrap().corrections.clone();
        assert!(sub("regular").starts_with("0930-1300:"));
        assert!(sub("postmarket").starts_with("1300-1700:"));
        assert!(sub("extended").starts_with("0400-1700:"));
    }

    /// Price grid as the reference app's US stocks (AAPL, IBM: 100 / 1,
    /// "0.0001 1 0.01") and OTC listings (TCEHY), resolved 01/10/2026.
    #[test]
    fn us_equity_price_grid_matches_reference() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let aapl = rt.block_on(MassiveProvider.symbol_session(&SymbolRef::parse("NASDAQ:AAPL"))).unwrap();
        assert_eq!((aapl.pricescale, aapl.minmov, aapl.variable_tick_size.as_str()), (100, 1, "0.0001 1 0.01"));
        let otc = rt.block_on(MassiveProvider.symbol_session(&SymbolRef::parse("OTC:TCEHY"))).unwrap();
        assert_eq!(otc.variable_tick_size, "0.000001 0.0001 0.0001 1 0.01");
    }

    /// Live entitlement probe through the gateway (token compiled in by
    /// build.rs). Run with:
    ///   cargo test --lib live_entitlement_probe -- --nocapture --ignored
    #[tokio::test]
    #[ignore = "hits the real REST + WebSocket endpoints; run explicitly"]
    async fn live_entitlement_probe() {
        assert!(gateway::token().is_some(), "{}", gateway::NO_TOKEN);
        let h = MassiveProvider.probe_history().await.expect("history probe");
        eprintln!("history: {:?} {} delay={} floor={:?}", h.data_status, h.raw_status, h.delay_sec, h.floor);
        assert!(h.floor.day.is_some(), "no daily floor");
        let s = MassiveProvider.probe_stream(h.data_status).await.expect("stream probe");
        eprintln!("stream: {s:?}");
    }
}
