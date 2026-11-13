/*
 * opentrader-core — the data side of OpenTrader, shared by the desktop app and
 * the web server: market data through the gateway (history, reference, live
 * quotes), the screener table, and the pure alert evaluation. Nothing here
 * depends on a window system; the program it runs in plugs in as a `Host`.
 */
pub mod alerts;
pub mod commands;
pub mod data;
pub mod error;
pub mod files;
pub mod funding;
pub mod history;
pub mod host;
pub mod images;
pub mod local_series;
pub mod memo;
pub mod net;
pub mod plugins;
pub mod rt;
pub mod screener;
pub mod sync;
pub mod webhook;

use data::provider::Provider;
use data::types::WsHandle;
use host::HostRef;

/// Start the data side, the same way in the desktop app and the web server:
/// this install's gateway token (kept in `install_token_file`), the live-data
/// task, the entitlements (the cached ones at once, probed again in the
/// background) and the symbol catalogs. Returns the handle the subscription
/// commands push onto. Call once the proxy is set: all of this connects.
pub fn start(host: &HostRef, provider: &Provider, install_token_file: std::path::PathBuf) -> WsHandle {
    data::install_token::init(install_token_file);
    let live = provider.spawn(host.clone());
    data::provider::entitlements::init(host, provider.clone());
    data::market_rest::init_symbol_catalog();
    data::market_rest::economics::init();
    live
}
