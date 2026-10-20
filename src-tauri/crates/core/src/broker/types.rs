/*
 * Broker wire types: what the trading panel shows and what an order ticket
 * sends. Broker-agnostic; the IBKR connection (`ibkr.rs`) fills them in.
 *
 * Prices and quantities are f64 (specta cannot export 64-bit integers); times
 * are UNIX milliseconds as f64 for the same reason.
 */
use crate::host::event;
use serde::{Deserialize, Serialize};

/// Where the local gateway / trading app listens. No secret: the user logs in
/// inside the broker's own app.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BrokerConfig {
    pub host: String,
    pub port: u16,
    pub client_id: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionState {
    Disconnected,
    Connecting,
    Connected,
    /// The socket dropped; the client is trying again.
    Reconnecting,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum Side {
    Buy,
    Sell,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum OrderType {
    Market,
    Limit,
    Stop,
    StopLimit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum Duration {
    Day,
    Gtc,
}

/// Order status groups, as the Orders tab filters them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum OrderStatus {
    /// Submitted, not yet acknowledged by the broker.
    Placing,
    Working,
    /// Held by the broker (e.g. a bracket child waiting for its parent).
    Inactive,
    Filled,
    Cancelled,
    Rejected,
}

/// One account's balance row (the account manager header).
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AccountSummary {
    pub account: String,
    pub currency: String,
    /// Cash balance.
    pub balance: Option<f64>,
    /// Net liquidation value.
    pub equity: Option<f64>,
    pub realized_pnl: Option<f64>,
    pub unrealized_pnl: Option<f64>,
    /// Initial margin requirement.
    pub account_margin: Option<f64>,
    pub available_funds: Option<f64>,
    pub buying_power: Option<f64>,
    pub maintenance_margin: Option<f64>,
    pub excess_liquidity: Option<f64>,
    /// Every value the broker reported, for the Account Summary tab.
    pub values: Vec<AccountValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AccountValue {
    pub key: String,
    pub value: String,
    pub currency: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    /// Stable row id (contract id).
    pub id: String,
    pub account: String,
    /// The app's symbol name ("NASDAQ:AAPL") when the contract maps to one.
    pub symbol: String,
    pub ticker: String,
    pub contract_id: i32,
    pub currency: String,
    pub side: Side,
    /// Absolute quantity.
    pub qty: f64,
    pub avg_price: f64,
    pub last: Option<f64>,
    pub market_value: Option<f64>,
    pub unrealized_pnl: Option<f64>,
    pub realized_pnl: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Order {
    /// Stable row id: "<client id>:<order id>", or "p<perm id>" for orders
    /// placed elsewhere.
    pub id: String,
    pub order_id: i32,
    pub perm_id: f64,
    pub client_id: i32,
    pub parent_id: Option<i32>,
    pub account: String,
    pub symbol: String,
    pub ticker: String,
    pub contract_id: i32,
    pub side: Side,
    pub order_type: OrderType,
    /// The broker's own type word, kept when it maps to none of ours.
    pub raw_type: String,
    pub qty: f64,
    pub filled_qty: f64,
    pub limit_price: Option<f64>,
    pub stop_price: Option<f64>,
    pub avg_fill_price: Option<f64>,
    pub duration: String,
    pub outside_rth: bool,
    pub status: OrderStatus,
    pub raw_status: String,
    pub message: Option<String>,
    /// The connection may modify / cancel it.
    pub modifiable: bool,
    pub updated_ms: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Execution {
    pub id: String,
    pub order_id: i32,
    pub account: String,
    pub symbol: String,
    pub ticker: String,
    pub side: Side,
    pub qty: f64,
    pub price: f64,
    pub time_ms: f64,
    pub commission: Option<f64>,
    pub realized_pnl: Option<f64>,
    pub exchange: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum NoticeLevel {
    Info,
    Warning,
    Error,
}

/// A notifications-log row.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BrokerNotice {
    pub time_ms: f64,
    pub level: NoticeLevel,
    pub code: i32,
    pub message: String,
    pub order_id: Option<i32>,
}

/// The whole broker state. Sent as one event (`broker-state`) whenever any
/// part changes, at most every 250 ms: the tables are small.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[cfg_attr(feature = "tauri", derive(tauri_specta::Event))]
#[serde(rename_all = "camelCase")]
pub struct BrokerState {
    pub version: u32,
    /// "ibkr" while a connection exists or is being made.
    pub broker: Option<String>,
    pub connection: ConnectionState,
    pub config: Option<BrokerConfig>,
    /// The last connection error, until the next attempt.
    pub error: Option<String>,
    pub accounts: Vec<String>,
    pub account: Option<String>,
    pub summary: Option<AccountSummary>,
    pub positions: Vec<Position>,
    pub orders: Vec<Order>,
    pub executions: Vec<Execution>,
    pub notices: Vec<BrokerNotice>,
}

event!(BrokerState, "broker-state");

/// Bid / ask / last of the order ticket's symbol, as the broker quotes it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[cfg_attr(feature = "tauri", derive(tauri_specta::Event))]
#[serde(rename_all = "camelCase")]
pub struct BrokerQuote {
    pub symbol: String,
    pub bid: Option<f64>,
    pub ask: Option<f64>,
    pub last: Option<f64>,
    /// The account has no real-time subscription for it.
    pub delayed: bool,
    /// Smallest price step.
    pub min_tick: Option<f64>,
}

event!(BrokerQuote, "broker-quote");

/// What the order ticket sends (new order or modification).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OrderTicket {
    /// The app's symbol name ("NASDAQ:AAPL").
    pub symbol: String,
    pub side: Side,
    pub order_type: OrderType,
    pub qty: f64,
    pub limit_price: Option<f64>,
    pub stop_price: Option<f64>,
    pub duration: Duration,
    pub outside_rth: bool,
    /// Bracket legs (new orders only).
    pub take_profit: Option<f64>,
    pub stop_loss: Option<f64>,
}
