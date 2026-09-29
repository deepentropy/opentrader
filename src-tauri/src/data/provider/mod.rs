/*
 * DataProvider — the provider-agnostic data seam.
 *
 * Everything the app needs from a market-data vendor is expressed here as a set
 * of capability traits (history / reference / realtime). The Tauri commands and
 * the live-data task talk to a `Provider` (a boxed trait object) instead of
 * calling Massive directly, so swapping vendors is one new impl + one match arm
 * in `build()` — no command or frontend change.
 *
 * The frontend contract is unaffected: providers return the shared
 * `crate::data::types`, which are the same structs already exported to
 * `bindings.ts`, so the TypeScript side never learns which vendor served a call.
 *
 * Date math (trading calendar, scroll-back `before_sec` → range conversion) and
 * the process/disk caches stay in the command + impl layers; the trait surface
 * is intentionally just ranged fetches and reference lookups.
 */
pub mod capabilities;
pub mod entitlements;
mod massive;
pub use massive::MassiveProvider;

use capabilities::{DataStatus, HistoryProbe, ProviderCapabilities, StreamCaps};
use crate::data::types::{
    Candle, DividendEvent, NewsItem, Snapshot, SplitEvent, SymbolSearchResult, TickerInfo,
    WsHandle,
};
use anyhow::Result;
use chrono::NaiveDate;
use std::sync::Arc;
use tauri::AppHandle;

/// Historical OHLCV bars. Callers pass an inclusive `[from, to]` calendar range
/// (the command layer derives it from the trading calendar / scroll anchor).
/// `adjusted` selects split-adjusted (true — the default UI state) vs raw
/// prices; it is part of every history fetch so a toggled series never mixes
/// bases across the initial load / scroll-back pages.
#[async_trait::async_trait]
pub trait HistoryProvider: Send + Sync {
    async fn daily_aggs(
        &self,
        ticker: &str,
        from: NaiveDate,
        to: NaiveDate,
        adjusted: bool,
    ) -> Result<Vec<Candle>>;
    async fn minute_aggs(
        &self,
        ticker: &str,
        mult: u32,
        from: NaiveDate,
        to: NaiveDate,
        adjusted: bool,
    ) -> Result<Vec<Candle>>;
    async fn second_aggs(
        &self,
        ticker: &str,
        mult: u32,
        from: NaiveDate,
        to: NaiveDate,
        adjusted: bool,
    ) -> Result<Vec<Candle>>;
    /// Seconds live tail: bars newer than `since_sec` (UNIX seconds) — the
    /// seconds chart's refresh loop, which must not refetch whole sessions.
    async fn second_tail(
        &self,
        ticker: &str,
        mult: u32,
        since_sec: f64,
        adjusted: bool,
    ) -> Result<Vec<Candle>>;
}

/// Symbol reference data, snapshots, corporate-action events, and branding icon.
#[async_trait::async_trait]
pub trait ReferenceProvider: Send + Sync {
    async fn ticker_info(&self, ticker: &str) -> Result<TickerInfo>;
    async fn ticker_snapshot(&self, ticker: &str) -> Result<Snapshot>;
    async fn search(
        &self,
        query: &str,
        type_filter: Option<&str>,
    ) -> Result<Vec<SymbolSearchResult>>;
    /// Dividend / split markers are decorative, so these return `Vec` (a failing
    /// endpoint contributes nothing) rather than `Result`.
    async fn dividends(&self, ticker: &str) -> Vec<DividendEvent>;
    async fn splits(&self, ticker: &str) -> Vec<SplitEvent>;
    /// Newest headlines for the "Latest news" lollipop (newest first); empty on
    /// failure, like the event markers.
    async fn latest_news(&self, ticker: &str, limit: u32) -> Vec<NewsItem>;
    /// Fetch a branding icon by its encoded proxy path → `(bytes, content_type)`.
    async fn icon(&self, encoded: &str) -> Result<(Vec<u8>, String)>;
}

/// Live data. The provider owns its streaming strategy (REST poll vs WebSocket)
/// behind a single spawned task that emits the typed `ChartAggregate` /
/// `TradeTick` events and accepts desired-subscription updates over `WsHandle`.
pub trait RealtimeProvider: Send + Sync {
    /// Spawn the long-lived live-data task and return its subscription handle
    /// (managed in app state; the realtime commands push onto it).
    fn spawn(&self, app: AppHandle) -> WsHandle;
}

/// The full data contract. One object, injected as app state.
#[async_trait::async_trait]
pub trait DataProvider: HistoryProvider + ReferenceProvider + RealtimeProvider {
    /// Stable identifier of the active provider — matches the `DATA_PROVIDER`
    /// env value and the frontend adapter key. Exposed to the frontend (via the
    /// `get_data_provider` command) so it can select the matching presentation
    /// adapter instead of hardcoding one.
    fn name(&self) -> &'static str;

    /// What this provider's code can serve (no I/O). `entitlements` is left
    /// `None`; the entitlement store fills it in (see `entitlements.rs`).
    fn capabilities(&self) -> ProviderCapabilities;

    /// Fingerprint of the configured credential (never the secret itself), or
    /// `None` when none is set. Keys the entitlement cache.
    fn credential_id(&self) -> Option<String>;

    /// Measure the history half of the entitlements: data status, delay, and
    /// the oldest available bar per family.
    async fn probe_history(&self) -> Result<HistoryProbe>;

    /// Measure which live-stream channels the credential may use.
    /// `data_status` (from `probe_history`) selects the delayed or real-time
    /// endpoint. Must not run while the live task holds a stream connection on
    /// the same key if the vendor limits connections (Massive: one per key).
    async fn probe_stream(&self, data_status: DataStatus) -> Result<StreamCaps>;
}

/// Shared, cheaply-cloneable handle to the active provider (app-state type).
pub type Provider = Arc<dyn DataProvider>;

/// Build the provider selected by the `DATA_PROVIDER` env var (default
/// "massive"). Add a new arm here when a second provider lands.
pub fn build() -> Provider {
    let name = std::env::var("DATA_PROVIDER").unwrap_or_else(|_| "massive".into());
    match name.as_str() {
        "massive" => Arc::new(MassiveProvider),
        other => {
            eprintln!("[provider] unknown DATA_PROVIDER={other:?}; falling back to massive");
            Arc::new(MassiveProvider)
        }
    }
}
