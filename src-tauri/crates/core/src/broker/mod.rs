/*
 * Broker connection: the trading panel's account, positions, orders and
 * executions, and the orders the app sends.
 *
 * One broker today: Interactive Brokers, through the user's own IB Gateway or
 * TWS (socket API on localhost; the user logs in there). The connection runs
 * in background tasks (`ibkr.rs`) that keep one `BrokerState` current; every
 * change is pushed to the views as a `broker-state` event (at most every
 * 250 ms), and a view that opens later asks for the current state.
 */
mod ibkr;
mod store;
pub mod symbols;
pub mod types;

use crate::host::HostRef;
use std::sync::Arc;
use types::{BrokerConfig, BrokerState, OrderTicket};

/// Managed app state (`app.manage(Broker::default())`).
#[derive(Default, Clone)]
pub struct Broker {
    inner: Arc<ibkr::Ibkr>,
}

impl Broker {
    /// The current state (a view that just opened).
    pub fn state(&self) -> BrokerState {
        self.inner.store.snapshot()
    }

    /// Connect to the gateway; resolves once connected (or failed). A live
    /// connection is closed first.
    pub async fn connect(&self, host: HostRef, config: BrokerConfig) -> Result<BrokerState, String> {
        self.inner.connect(host, config).await?;
        Ok(self.state())
    }

    pub async fn disconnect(&self) {
        self.inner.disconnect().await;
    }

    /// Show another of the login's accounts.
    pub async fn select_account(&self, account: String) -> Result<(), String> {
        self.inner.select_account(account).await
    }

    /// Send a new order (a bracket when it has take-profit / stop-loss legs).
    /// Returns the parent's row id.
    pub async fn place_order(&self, ticket: OrderTicket) -> Result<String, String> {
        self.inner.place_order(ticket).await
    }

    /// Change a working order (`id` = its row id).
    pub async fn modify_order(&self, id: String, ticket: OrderTicket) -> Result<(), String> {
        self.inner.modify_order(&id, ticket).await
    }

    pub async fn cancel_order(&self, id: String) -> Result<(), String> {
        self.inner.cancel_order(&id).await
    }

    /// Close a position with a market order (`id` = its row id).
    pub async fn close_position(&self, id: String) -> Result<(), String> {
        self.inner.close_position(&id).await
    }

    /// Quote one symbol for the order ticket (`broker-quote` events); `None`
    /// stops the quote.
    pub async fn watch_quote(&self, symbol: Option<String>) -> Result<(), String> {
        self.inner.watch_quote(symbol).await
    }
}
