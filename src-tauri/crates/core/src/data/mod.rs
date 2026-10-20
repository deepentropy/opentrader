pub mod calendar;
pub mod daily_archive;
pub mod gateway;
pub mod market_rest;
pub mod market_stream;
pub mod provider;
pub mod quote_poll;
pub mod session;
pub mod symbol;
pub mod ticker_case;
pub mod trading_calendar;
pub mod types;

/// Folder of the disk caches: `OPENTRADER_CACHE_DIR` when set (a server next
/// to a desktop app keeps its own), else `<user cache>/opentrader`.
pub fn cache_root() -> std::path::PathBuf {
    match std::env::var_os("OPENTRADER_CACHE_DIR") {
        Some(dir) if !dir.is_empty() => dir.into(),
        _ => dirs::cache_dir().unwrap_or_else(std::env::temp_dir).join("opentrader"),
    }
}
