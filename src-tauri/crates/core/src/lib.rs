/*
 * opentrader-core — the data side of OpenTrader, shared by the desktop app and
 * the web server: market data through the gateway (history, reference, live
 * quotes), the screener table, and the pure alert evaluation. Nothing here
 * depends on a window system; the program it runs in plugs in as a `Host`.
 */
pub mod alerts;
pub mod data;
pub mod funding;
pub mod history;
pub mod host;
pub mod images;
pub mod rt;
pub mod screener;
pub mod webhook;
