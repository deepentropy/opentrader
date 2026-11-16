/*
 * Broker plugins' wire types (plugins/PROTOCOL.md, "Broker plugins"): the account state a plugin pushes
 * (`broker.state`), the order notifications (`broker.event`) and what the order ticket sends (`broker.place`). The
 * same shapes reach the window, so the account manager and the trading lines read what the plugin wrote.
 *
 * Symbols are the broker's own tickers; the app maps its chart symbols to them (`broker.resolveSymbol`). Prices and
 * quantities are f64 and times UNIX milliseconds as f64 (specta exports no 64-bit integers). Quantities are in units
 * (shares, currency units, contracts), not lots: a plugin whose broker counts lots converts.
 */
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum OrderStatus {
    /// Sent, not yet acknowledged by the broker.
    Placing,
    #[default]
    Working,
    /// Held by the broker (a bracket leg waiting for its order).
    Inactive,
    Filled,
    Cancelled,
    Rejected,
}

/// Netting: one position per symbol. Hedging: several, each closed on its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum PositionMode {
    #[default]
    Netting,
    Hedging,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(default, rename_all = "camelCase")]
pub struct AccountRef {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(default, rename_all = "camelCase")]
pub struct AccountValue {
    pub label: String,
    pub value: String,
    pub currency: Option<String>,
}

/// The selected account (the account manager's header and Account summary tab).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(default, rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub name: String,
    pub currency: String,
    /// A demo / paper account: the app shows DEMO, else LIVE.
    pub is_demo: bool,
    pub balance: Option<f64>,
    pub equity: Option<f64>,
    pub unrealized_pnl: Option<f64>,
    pub realized_pnl: Option<f64>,
    pub margin_used: Option<f64>,
    pub margin_free: Option<f64>,
    /// Everything else the broker reports, as label / value rows.
    pub values: Vec<AccountValue>,
}

/// What the plugin's broker supports; the order ticket and the chart offer only that.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(default, rename_all = "camelCase")]
pub struct BrokerCapabilities {
    pub order_types: Vec<OrderType>,
    /// Take profit / stop loss on a new order.
    pub brackets: bool,
    /// Take profit / stop loss on an open position.
    pub position_brackets: bool,
    /// Close part of a position.
    pub partial_close: bool,
    /// Modify a working order's price or quantity.
    pub modify_orders: bool,
    /// The broker's own order choices (a product type…), shown as selectors in the order ticket.
    pub ticket_fields: Vec<TicketField>,
}

impl Default for BrokerCapabilities {
    fn default() -> Self {
        Self {
            order_types: vec![OrderType::Market, OrderType::Limit, OrderType::Stop, OrderType::StopLimit],
            brackets: true,
            position_brackets: true,
            partial_close: true,
            modify_orders: true,
            ticket_fields: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(default, rename_all = "camelCase")]
pub struct TicketFieldOption {
    /// What the order carries (`fields.product = "CNC"`).
    pub value: String,
    /// What the ticket shows; the value when empty.
    pub label: String,
}

/// A choice the broker needs with each order, beyond the app's own fields: a product type (intraday / delivery), a
/// margin mode… The order ticket shows it as a selector; the value picked goes with the order in `fields`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(default, rename_all = "camelCase")]
pub struct TicketField {
    pub id: String,
    pub label: String,
    pub options: Vec<TicketFieldOption>,
    /// The value picked at first; the first option when left out.
    pub default: Option<String>,
}

/// How a ticker trades at the broker (`broker.instrument`): the quantities it takes and the money one point moves
/// one unit by. Every field may be left out.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(default, rename_all = "camelCase")]
pub struct Instrument {
    /// The smallest order, in units.
    pub qty_min: Option<f64>,
    /// Orders are whole multiples of it, in units: the lot size of a contract sized in lots.
    pub qty_step: Option<f64>,
    pub qty_max: Option<f64>,
    /// Money (account currency) one unit gains or loses when the price moves by 1: a futures multiplier. 1 when left
    /// out.
    pub point_value: Option<f64>,
    /// This ticker's choices, in place of the capabilities' `ticketFields` (a product type that depends on the
    /// segment).
    pub ticket_fields: Option<Vec<TicketField>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub id: String,
    pub ticker: String,
    pub side: Side,
    /// Absolute quantity, units.
    pub qty: f64,
    pub avg_price: f64,
    #[serde(default)]
    pub last: Option<f64>,
    #[serde(default)]
    pub unrealized_pnl: Option<f64>,
    #[serde(default)]
    pub realized_pnl: Option<f64>,
    #[serde(default)]
    pub take_profit: Option<f64>,
    #[serde(default)]
    pub stop_loss: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Order {
    pub id: String,
    pub ticker: String,
    pub side: Side,
    #[serde(rename = "type")]
    pub order_type: OrderType,
    pub qty: f64,
    #[serde(default)]
    pub filled_qty: f64,
    #[serde(default)]
    pub limit_price: Option<f64>,
    #[serde(default)]
    pub stop_price: Option<f64>,
    #[serde(default)]
    pub take_profit: Option<f64>,
    #[serde(default)]
    pub stop_loss: Option<f64>,
    #[serde(default)]
    pub avg_fill_price: Option<f64>,
    #[serde(default)]
    pub status: OrderStatus,
    /// "day", "gtc"… as the broker names it.
    #[serde(default)]
    pub duration: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub updated_ms: Option<f64>,
    /// The ticket fields it was placed with (`ticketFields`): sent again when it is modified.
    #[serde(default)]
    pub fields: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Execution {
    pub id: String,
    #[serde(default)]
    pub order_id: Option<String>,
    pub ticker: String,
    pub side: Side,
    pub qty: f64,
    pub price: f64,
    pub time_ms: f64,
    #[serde(default)]
    pub commission: Option<f64>,
    #[serde(default)]
    pub realized_pnl: Option<f64>,
}

/// The plugin's whole account state (`broker.state`), sent again whenever a part changes.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(default, rename_all = "camelCase")]
pub struct BrokerState {
    /// The plugin is connected to its broker (logged in).
    pub connected: bool,
    pub accounts: Vec<AccountRef>,
    pub account: Option<Account>,
    pub position_mode: PositionMode,
    pub capabilities: BrokerCapabilities,
    pub positions: Vec<Position>,
    pub orders: Vec<Order>,
    pub executions: Vec<Execution>,
}

/// An order notification (`broker.event`): the toasts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BrokerEvent {
    /// "placed" | "executed" | "modified" | "cancelled" | "rejected"
    pub kind: String,
    pub ticker: String,
    pub side: Side,
    #[serde(rename = "type")]
    pub order_type: OrderType,
    pub qty: f64,
    #[serde(default)]
    pub price: Option<f64>,
    #[serde(default)]
    pub message: Option<String>,
}

/// What the order ticket sends (`broker.place`, and `broker.modify` with `orderId`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OrderTicket {
    pub ticker: String,
    pub side: Side,
    #[serde(rename = "type")]
    pub order_type: OrderType,
    pub qty: f64,
    pub limit_price: Option<f64>,
    pub stop_price: Option<f64>,
    pub take_profit: Option<f64>,
    pub stop_loss: Option<f64>,
    /// The values picked in the broker's ticket fields (`{"product":"CNC"}`), empty without any.
    #[serde(default)]
    pub fields: BTreeMap<String, String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_minimal_state_reads_with_defaults() {
        let s: BrokerState = serde_json::from_value(serde_json::json!({
            "connected": true,
            "account": { "id": "1", "currency": "USD", "isDemo": true, "balance": 1000 },
            "positions": [{ "id": "p1", "ticker": "EURUSD", "side": "buy", "qty": 1000, "avgPrice": 1.08 }],
            "orders": [{ "id": "o1", "ticker": "EURUSD", "side": "sell", "type": "limit", "qty": 1000, "limitPrice": 1.1 }]
        }))
        .unwrap();
        assert!(s.account.as_ref().unwrap().is_demo);
        assert_eq!(s.position_mode, PositionMode::Netting);
        assert_eq!(s.orders[0].status, OrderStatus::Working);
        assert!(s.capabilities.brackets);
        assert!(s.capabilities.ticket_fields.is_empty());
        assert!(s.orders[0].fields.is_empty());
    }

    #[test]
    fn ticket_fields_and_instruments_read() {
        let c: BrokerCapabilities = serde_json::from_value(serde_json::json!({
            "ticketFields": [{ "id": "product", "label": "Product", "options": [{ "value": "MIS", "label": "Intraday" }, { "value": "CNC" }], "default": "MIS" }]
        }))
        .unwrap();
        assert_eq!(c.ticket_fields[0].options[1].value, "CNC");
        assert_eq!(c.ticket_fields[0].default.as_deref(), Some("MIS"));
        assert!(c.modify_orders);
        let i: Instrument = serde_json::from_value(serde_json::json!({ "qtyMin": 65, "qtyStep": 65 })).unwrap();
        assert_eq!((i.qty_step, i.point_value, i.ticket_fields), (Some(65.0), None, None));
        // A ticket without fields reads, and the fields go to the plugin as an object.
        let t: OrderTicket = serde_json::from_value(serde_json::json!({ "ticker": "X", "side": "buy", "type": "market", "qty": 1, "limitPrice": null, "stopPrice": null, "takeProfit": null, "stopLoss": null })).unwrap();
        assert!(t.fields.is_empty());
        let t = OrderTicket { fields: [("product".to_string(), "CNC".to_string())].into(), ..t };
        assert_eq!(serde_json::to_value(&t).unwrap()["fields"]["product"], "CNC");
    }
}
