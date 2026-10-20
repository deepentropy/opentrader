/*
 * Provider-neutral data types — the shapes every `DataProvider` speaks and the
 * frontend bindings consume. Commands, the provider trait, and any later
 * provider import from here rather than from a transport module.
 *
 * The definitions live in the transport modules (`market_rest`,
 * `market_stream`); this module re-exports them under a neutral path so
 * import sites stay transport-agnostic.
 */
pub use crate::data::market_rest::{
    Candle, DividendEvent, Fundamentals, NewsItem, Snapshot, SplitEvent,
    SymbolSearchResult, TickerInfo,
};
pub use crate::data::market_stream::{
    ChartAggregate, SecondAggregate, SubscribeMsg, TradeTick, WsHandle,
};
