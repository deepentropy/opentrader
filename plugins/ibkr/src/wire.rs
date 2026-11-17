/*
 * The Plugin API's broker shapes (plugins/PROTOCOL.md, "Broker plugins"), the same JSON as the app's
 * `opentrader_core::plugins::broker`. Copied rather than shared so the plugin builds without the app's crates.
 */
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Side {
    Buy,
    Sell,
}

impl Side {
    pub fn opposite(self) -> Side {
        match self {
            Side::Buy => Side::Sell,
            Side::Sell => Side::Buy,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OrderType {
    Market,
    Limit,
    Stop,
    StopLimit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OrderStatus {
    Placing,
    #[default]
    Working,
    Inactive,
    Filled,
    Cancelled,
    Rejected,
}

impl OrderStatus {
    /// Still able to fill.
    pub fn active(self) -> bool {
        matches!(self, OrderStatus::Placing | OrderStatus::Working | OrderStatus::Inactive)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PositionMode {
    #[default]
    Netting,
    Hedging,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AccountRef {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AccountValue {
    pub label: String,
    pub value: String,
    pub currency: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub name: String,
    pub currency: String,
    pub is_demo: bool,
    pub balance: Option<f64>,
    pub equity: Option<f64>,
    pub unrealized_pnl: Option<f64>,
    pub realized_pnl: Option<f64>,
    pub margin_used: Option<f64>,
    pub margin_free: Option<f64>,
    pub values: Vec<AccountValue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BrokerCapabilities {
    pub order_types: Vec<OrderType>,
    pub brackets: bool,
    pub position_brackets: bool,
    pub partial_close: bool,
    pub modify_orders: bool,
    /// The times in force the order ticket offers.
    pub durations: Vec<OrderDuration>,
}

/// A time in force (`capabilities.durations`): the id the order carries and `orders[].duration` reports.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderDuration {
    pub id: String,
    pub label: String,
    /// The order types it applies to; all of them when empty.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub order_types: Vec<OrderType>,
    /// The one picked at first.
    #[serde(skip_serializing_if = "std::ops::Not::not", default)]
    pub default: bool,
}

impl Default for BrokerCapabilities {
    fn default() -> Self {
        Self {
            order_types: vec![OrderType::Market, OrderType::Limit, OrderType::Stop, OrderType::StopLimit],
            brackets: true,
            position_brackets: true,
            partial_close: true,
            modify_orders: true,
            durations: crate::orders::durations(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub id: String,
    pub ticker: String,
    pub side: Side,
    pub qty: f64,
    pub avg_price: f64,
    pub last: Option<f64>,
    pub unrealized_pnl: Option<f64>,
    pub realized_pnl: Option<f64>,
    pub take_profit: Option<f64>,
    pub stop_loss: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Order {
    pub id: String,
    pub ticker: String,
    pub side: Side,
    #[serde(rename = "type")]
    pub order_type: OrderType,
    pub qty: f64,
    pub filled_qty: f64,
    pub limit_price: Option<f64>,
    pub stop_price: Option<f64>,
    pub take_profit: Option<f64>,
    pub stop_loss: Option<f64>,
    pub avg_fill_price: Option<f64>,
    pub status: OrderStatus,
    pub duration: Option<String>,
    pub message: Option<String>,
    pub updated_ms: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Execution {
    pub id: String,
    pub order_id: Option<String>,
    pub ticker: String,
    pub side: Side,
    pub qty: f64,
    pub price: f64,
    pub time_ms: f64,
    pub commission: Option<f64>,
    pub realized_pnl: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BrokerState {
    pub connected: bool,
    pub accounts: Vec<AccountRef>,
    pub account: Option<Account>,
    pub position_mode: PositionMode,
    pub capabilities: BrokerCapabilities,
    pub positions: Vec<Position>,
    pub orders: Vec<Order>,
    pub executions: Vec<Execution>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerEvent {
    /// "placed" | "executed" | "modified" | "cancelled" | "rejected"
    pub kind: String,
    pub ticker: String,
    pub side: Side,
    #[serde(rename = "type")]
    pub order_type: OrderType,
    pub qty: f64,
    pub price: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// What the order ticket sends (`broker.place`, and `broker.modify` with `orderId`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderTicket {
    pub ticker: String,
    pub side: Side,
    #[serde(rename = "type")]
    pub order_type: OrderType,
    pub qty: f64,
    #[serde(default)]
    pub limit_price: Option<f64>,
    #[serde(default)]
    pub stop_price: Option<f64>,
    #[serde(default)]
    pub take_profit: Option<f64>,
    #[serde(default)]
    pub stop_loss: Option<f64>,
    /// The time in force picked (a `durations` id); left out by an app that has none to offer.
    #[serde(default)]
    pub duration: Option<String>,
}

/// How a ticker trades (`broker.instrument`): quantities in units, and the money one unit makes per price point.
/// A field IB doesn't give is left out.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Instrument {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qty_min: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qty_step: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub point_value: Option<f64>,
}
