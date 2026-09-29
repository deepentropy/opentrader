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
use crate::data::{gateway, massive_poll, massive_rest, massive_ws};
use anyhow::Result;
use chrono::NaiveDate;
use tauri::AppHandle;

pub struct MassiveProvider;

#[async_trait::async_trait]
impl HistoryProvider for MassiveProvider {
    async fn daily_aggs(
        &self,
        ticker: &str,
        from: NaiveDate,
        to: NaiveDate,
        adjusted: bool,
    ) -> Result<Vec<Candle>> {
        massive_rest::fetch_daily_aggs(ticker, from, to, adjusted).await
    }
    async fn minute_aggs(
        &self,
        ticker: &str,
        mult: u32,
        from: NaiveDate,
        to: NaiveDate,
        adjusted: bool,
    ) -> Result<Vec<Candle>> {
        massive_rest::fetch_minute_aggs(ticker, mult, from, to, adjusted).await
    }
    async fn second_aggs(
        &self,
        ticker: &str,
        mult: u32,
        from: NaiveDate,
        to: NaiveDate,
        adjusted: bool,
    ) -> Result<Vec<Candle>> {
        massive_rest::fetch_second_aggs(ticker, mult, from, to, adjusted).await
    }
    async fn second_tail(
        &self,
        ticker: &str,
        mult: u32,
        since_sec: f64,
        adjusted: bool,
    ) -> Result<Vec<Candle>> {
        massive_rest::fetch_second_tail(ticker, mult, since_sec, adjusted).await
    }
}

#[async_trait::async_trait]
impl ReferenceProvider for MassiveProvider {
    async fn ticker_info(&self, ticker: &str) -> Result<TickerInfo> {
        massive_rest::fetch_ticker_info(ticker).await
    }
    async fn ticker_snapshot(&self, ticker: &str) -> Result<Snapshot> {
        massive_rest::fetch_ticker_snapshot(ticker).await
    }
    async fn search(
        &self,
        query: &str,
        type_filter: Option<&str>,
    ) -> Result<Vec<SymbolSearchResult>> {
        massive_rest::search_tickers(query, type_filter).await
    }
    async fn dividends(&self, ticker: &str) -> Vec<DividendEvent> {
        massive_rest::dividend_events(ticker).await
    }
    async fn splits(&self, ticker: &str) -> Vec<SplitEvent> {
        massive_rest::split_events(ticker).await
    }
    async fn latest_news(&self, ticker: &str, limit: u32) -> Vec<NewsItem> {
        massive_rest::latest_news(ticker, limit).await
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
