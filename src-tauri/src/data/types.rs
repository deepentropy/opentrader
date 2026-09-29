/*
 * Provider-neutral data types — the shapes every `DataProvider` speaks and the
 * frontend bindings consume. These are deliberately decoupled from any one
 * vendor: commands, the provider trait, and (eventually) a second provider all
 * import from here rather than from a `massive_*` module.
 *
 * For now the definitions still physically live in the Massive modules (moving
 * ~9 structs out of the 1250-line `massive_rest.rs` would be a large, risky
 * churn with no behavioural change). This module re-exports them under a neutral
 * path so import sites are already vendor-agnostic; relocate the definitions
 * here when a second provider lands.
 */
pub use crate::data::massive_rest::{
    Candle, DividendEvent, NewsItem, Snapshot, SplitEvent, SymbolSearchResult, TickerInfo,
};
pub use crate::data::massive_ws::{
    ChartAggregate, SecondAggregate, SubscribeMsg, TradeTick, WsHandle,
};
