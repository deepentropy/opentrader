//! Owner-keyed desired subscriptions shared by the live transports.
use crate::data::symbol::SymbolRef;
use crate::data::ticker_case;
use std::collections::HashSet;

/// Sent by `commands/realtime.rs` to update what we're subscribed to.
/// The connection task diffs each update against its previous state and
/// emits subscribe / unsubscribe frames accordingly.
///
/// Owner-keyed: every window (and every chart pane within it) declares its
/// own desired state and the transport unions them. The previous single
/// global slot let the last writer win — a second window silently
/// unsubscribed the first's symbols, and in multi-pane layouts only one
/// pane received chart bars.
#[derive(Debug, Clone)]
pub enum SubscribeMsg {
    /// One pane's charted symbol. `owner` = "<window label>:<pane id>";
    /// None clears that pane's slot.
    SetChart { owner: String, symbol: Option<String> },
    /// One window's watchlist-union contribution. `owner` = window label.
    SetWatchlist { owner: String, symbols: Vec<String> },
    /// Window destroyed — drop its watchlist and every chart slot it owned.
    DropOwner { owner: String },
}

/// Owner-keyed desired-subscription state shared by the REST poller and the
/// WS transport: applies `SubscribeMsg`s and exposes the union views the
/// transports consume. Symbols are full names ("NASDAQ:AAPL"); the vendor
/// subscribes the ticker part and events go back under every full name that
/// subscribed that ticker.
#[derive(Debug, Default)]
pub struct SubscriptionState {
    /// "<window>:<pane>" → charted symbol.
    charts: std::collections::HashMap<String, String>,
    /// window label → that window's watchlist union.
    watchlists: std::collections::HashMap<String, HashSet<String>>,
}

impl SubscriptionState {
    pub fn apply(&mut self, msg: SubscribeMsg) {
        match msg {
            SubscribeMsg::SetChart { owner, symbol } => match symbol {
                Some(s) => {
                    self.charts.insert(owner, s);
                }
                None => {
                    self.charts.remove(&owner);
                }
            },
            SubscribeMsg::SetWatchlist { owner, symbols } => {
                if symbols.is_empty() {
                    self.watchlists.remove(&owner);
                } else {
                    self.watchlists.insert(owner, symbols.into_iter().collect());
                }
            }
            SubscribeMsg::DropOwner { owner } => {
                self.watchlists.remove(&owner);
                let prefix = format!("{owner}:");
                self.charts.retain(|k, _| !k.starts_with(&prefix));
            }
        }
    }

    /// Every currently-charted symbol (any window, any pane), deduped.
    pub fn chart_symbols(&self) -> HashSet<String> {
        self.charts.values().cloned().collect()
    }

    /// Union of every window's watchlist contribution.
    pub fn watch_union(&self) -> HashSet<String> {
        self.watchlists.values().flatten().cloned().collect()
    }

    /// Everything worth polling: watch union + charted symbols.
    pub fn all_symbols(&self) -> HashSet<String> {
        let mut out = self.watch_union();
        out.extend(self.chart_symbols());
        out
    }

    /// TRUE when any pane in any window charts `sym` (gates ChartAggregate emission).
    pub fn is_chart_symbol(&self, sym: &str) -> bool {
        self.charts.values().any(|s| s == sym)
    }

    /// Vendor tickers of the charted symbols.
    pub fn chart_tickers(&self) -> HashSet<String> {
        self.charts.values().map(|s| ticker_of(s)).collect()
    }

    /// Vendor tickers of the watchlist union.
    pub fn watch_tickers(&self) -> HashSet<String> {
        self.watch_union().iter().map(|s| ticker_of(s)).collect()
    }

    /// Vendor tickers of everything subscribed.
    pub fn all_tickers(&self) -> HashSet<String> {
        self.all_symbols().iter().map(|s| ticker_of(s)).collect()
    }

    /// Charted full names whose vendor ticker is `ticker`.
    pub fn chart_symbols_for(&self, ticker: &str) -> Vec<String> {
        self.chart_symbols().into_iter().filter(|s| ticker_of(s) == ticker).collect()
    }

    /// Subscribed full names (charts + watchlists) whose vendor ticker is `ticker`.
    pub fn symbols_for(&self, ticker: &str) -> Vec<String> {
        self.all_symbols().into_iter().filter(|s| ticker_of(s) == ticker).collect()
    }
}

/// Vendor ticker of a full name ("NASDAQ:AAPL" → "AAPL", "NYSE:BAC/PB" →
/// "BACpB": the vendor's spelling, see `ticker_case`).
fn ticker_of(symbol: &str) -> String {
    ticker_case::to_source(&SymbolRef::parse(symbol).ticker)
}


#[cfg(test)]
mod subscription_state_tests {
    use super::*;

    fn set_chart(s: &mut SubscriptionState, owner: &str, sym: Option<&str>) {
        s.apply(SubscribeMsg::SetChart {
            owner: owner.into(),
            symbol: sym.map(Into::into),
        });
    }
    fn set_watch(s: &mut SubscriptionState, owner: &str, syms: &[&str]) {
        s.apply(SubscribeMsg::SetWatchlist {
            owner: owner.into(),
            symbols: syms.iter().map(|x| x.to_string()).collect(),
        });
    }

    #[test]
    fn windows_merge_instead_of_clobbering() {
        let mut s = SubscriptionState::default();
        set_watch(&mut s, "main", &["AAPL", "TSLA"]);
        set_watch(&mut s, "chart-x", &["NVDA"]);
        let union = s.watch_union();
        assert!(union.contains("AAPL") && union.contains("TSLA") && union.contains("NVDA"));
        // Replacing one window's set leaves the other's intact.
        set_watch(&mut s, "chart-x", &["AMD"]);
        let union = s.watch_union();
        assert!(union.contains("AAPL") && union.contains("AMD") && !union.contains("NVDA"));
    }

    #[test]
    fn panes_hold_independent_chart_slots() {
        let mut s = SubscriptionState::default();
        set_chart(&mut s, "main:1", Some("AAPL"));
        set_chart(&mut s, "main:2", Some("TSLA"));
        assert!(s.is_chart_symbol("AAPL") && s.is_chart_symbol("TSLA"));
        // One pane clearing its slot must not silence the sibling.
        set_chart(&mut s, "main:1", None);
        assert!(!s.is_chart_symbol("AAPL") && s.is_chart_symbol("TSLA"));
        assert!(s.all_symbols().contains("TSLA"));
    }

    #[test]
    fn drop_owner_clears_window_and_its_panes_only() {
        let mut s = SubscriptionState::default();
        set_watch(&mut s, "main", &["AAPL"]);
        set_watch(&mut s, "chart-x", &["NVDA"]);
        set_chart(&mut s, "main:1", Some("SPY"));
        set_chart(&mut s, "chart-x:1", Some("QQQ"));
        set_chart(&mut s, "chart-x:2", Some("IWM"));
        s.apply(SubscribeMsg::DropOwner {
            owner: "chart-x".into(),
        });
        assert!(!s.watch_union().contains("NVDA"));
        assert!(!s.is_chart_symbol("QQQ") && !s.is_chart_symbol("IWM"));
        assert!(s.watch_union().contains("AAPL") && s.is_chart_symbol("SPY"));
        // A label that PREFIXES another must not over-match ("chart" vs "chart-x").
        set_chart(&mut s, "chart:9", Some("DIA"));
        s.apply(SubscribeMsg::DropOwner { owner: "char".into() });
        assert!(s.is_chart_symbol("DIA"));
    }

    /// Full names subscribe their vendor ticker; events map back to every
    /// full name of that ticker.
    #[test]
    fn full_names_map_to_tickers_and_back() {
        let mut s = SubscriptionState::default();
        set_chart(&mut s, "main:1", Some("NASDAQ:INTC"));
        set_chart(&mut s, "main:2", Some("BOATS:INTC"));
        set_watch(&mut s, "main", &["NYSE:IBM", "NASDAQ:INTC"]);
        assert_eq!(s.chart_tickers(), HashSet::from(["INTC".to_string()]));
        assert!(s.watch_tickers().contains("IBM"));
        let mut charts = s.chart_symbols_for("INTC");
        charts.sort();
        assert_eq!(charts, vec!["BOATS:INTC", "NASDAQ:INTC"]);
        assert_eq!(s.symbols_for("IBM"), vec!["NYSE:IBM"]);
        assert!(s.chart_symbols_for("IBM").is_empty());
    }

    #[test]
    fn empty_watchlist_removes_the_owner_entry() {
        let mut s = SubscriptionState::default();
        set_watch(&mut s, "main", &["AAPL"]);
        set_watch(&mut s, "main", &[]);
        assert!(s.watch_union().is_empty());
        assert!(s.all_symbols().is_empty());
    }
}
