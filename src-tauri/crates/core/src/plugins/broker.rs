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
    /// How long an order stays working (time in force): the order ticket's selector. None: the plugin's own.
    pub durations: Vec<OrderDuration>,
    /// A stop order may sit on either side of the market (a buy stop below the ask). Without it the app refuses one
    /// on the wrong side: it would trigger at once.
    pub stop_orders_both_sides: bool,
    /// The same for the stop price of a stop limit order.
    pub stop_limit_orders_both_sides: bool,
    /// A limit order may not cross the market (a buy limit above the ask). Without it such an order is sent, as a
    /// marketable limit, unless its price is more than half the market price away.
    pub strict_limit_price: bool,
    /// The broker previews an order before it is sent (`broker.previewOrder`: its commission, its margin…): the order
    /// ticket shows the confirmation page, unless the user turned it off.
    pub order_preview: bool,
    /// Several exit levels on an order or a position (`exitLevels` on orders, positions and tickets), each a part of
    /// its quantity with its own take profit and stop loss.
    pub exit_levels: bool,
    /// The most exit levels an order or a position takes (8 when left out).
    pub max_exit_levels: Option<u32>,
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
            durations: Vec::new(),
            stop_orders_both_sides: false,
            stop_limit_orders_both_sides: false,
            strict_limit_price: false,
            order_preview: false,
            exit_levels: false,
            max_exit_levels: None,
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
/// margin mode, trading outside regular hours… The order ticket shows it as a selector or a checkbox; the value picked
/// goes with the order in `fields`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(default, rename_all = "camelCase")]
pub struct TicketField {
    pub id: String,
    pub label: String,
    /// A selector of `options`, or a checkbox whose value is "true" / "false".
    #[serde(rename = "type")]
    pub kind: TicketFieldKind,
    pub options: Vec<TicketFieldOption>,
    /// The value picked at first; the first option (a checkbox: "false") when left out.
    pub default: Option<String>,
    /// The order types it applies to; all of them when empty. It is left out of the other orders.
    pub order_types: Vec<OrderType>,
    /// It is about the order's take profit or stop loss: shown, and sent, only while that exit is on.
    pub exit: Option<ExitLeg>,
}

/// How a ticket field is picked. An unknown kind is a selector.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum TicketFieldKind {
    #[default]
    Select,
    Checkbox,
}

impl<'de> Deserialize<'de> for TicketFieldKind {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Ok(match serde_json::Value::deserialize(d)?.as_str().unwrap_or_default() {
            "checkbox" => Self::Checkbox,
            _ => Self::Select,
        })
    }
}

/// An exit of an order: its take profit or its stop loss.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ExitLeg {
    TakeProfit,
    StopLoss,
}

/// A time in force the broker takes: "day", "gtc"… as the plugin names it, and what the ticket shows.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(default, rename_all = "camelCase")]
pub struct OrderDuration {
    /// What the order carries (`duration: "gtc"`), and what `orders[].duration` reports.
    pub id: String,
    /// What the ticket shows; the id when empty.
    pub label: String,
    /// The order types it applies to; all of them when empty.
    pub order_types: Vec<OrderType>,
    /// The one picked at first; else the first that applies to the order type.
    pub default: bool,
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
    /// This ticker's times in force, in place of the capabilities' `durations`.
    pub durations: Option<Vec<OrderDuration>>,
    /// The margin an order takes, as a share of its value (0.05 = 5 %, leverage 1:20): the order ticket's "Margin used"
    /// against the account's free margin.
    pub margin_rate: Option<f64>,
}

/// An exit level of an order or a position: a part of its quantity with its own take profit and stop loss. `id` is the
/// plugin's (kept across states, so the chart's lines follow the level); the app leaves it out of what it sends.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(default, rename_all = "camelCase")]
pub struct ExitLevel {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub qty: f64,
    pub take_profit: Option<f64>,
    pub stop_loss: Option<f64>,
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
    /// Its exit levels, in place of `takeProfit` / `stopLoss` (a broker with `capabilities.exitLevels`).
    #[serde(default)]
    pub exit_levels: Vec<ExitLevel>,
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
    /// Its exit levels, in place of `takeProfit` / `stopLoss` (a broker with `capabilities.exitLevels`).
    #[serde(default)]
    pub exit_levels: Vec<ExitLevel>,
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
    /// The broker's own tabs of the account manager (holdings, funds…), after Trade history. A page that doesn't read
    /// is left out, not the whole state.
    #[serde(deserialize_with = "pages_that_read")]
    #[specta(type = Vec<AccountPage>)]
    pub pages: Vec<AccountPage>,
}

/// A tab of the broker's own (`pages`): one or more tables whose columns the broker defines.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AccountPage {
    pub id: String,
    pub title: String,
    /// The tab shows its number of rows, as Positions and Orders do.
    #[serde(default)]
    pub counter: bool,
    pub tables: Vec<AccountPageTable>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AccountPageTable {
    pub id: String,
    /// Shown above the table when the page has several.
    #[serde(default)]
    pub title: Option<String>,
    pub columns: Vec<AccountPageColumn>,
    /// The sort before the user picks one.
    #[serde(default)]
    pub sort: Option<AccountPageSort>,
    /// Each row: column id → value (null: empty); `id` keys the row when present.
    #[serde(default)]
    pub rows: Vec<BTreeMap<String, Option<PageCell>>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AccountPageColumn {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub format: ColumnFormat,
    /// Shown once the user picks it in Column setup.
    #[serde(default)]
    pub hidden: bool,
}

/// How a column's values show. An unknown format shows as text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ColumnFormat {
    /// The broker's ticker: a row click shows it on the chart.
    Symbol,
    /// "buy" / "sell", shown as Buy / Sell.
    Side,
    Qty,
    /// On the tick of the row's symbol.
    Price,
    /// An amount of the account's currency.
    Money,
    /// A signed amount, green or red.
    Pnl,
    Percent,
    /// A signed percent, green or red.
    PnlPercent,
    Number,
    /// UNIX milliseconds, shown as a local date and time.
    Time,
    #[default]
    Text,
}

impl<'de> Deserialize<'de> for ColumnFormat {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Ok(match serde_json::Value::deserialize(d)?.as_str().unwrap_or_default() {
            "symbol" => Self::Symbol,
            "side" => Self::Side,
            "qty" => Self::Qty,
            "price" => Self::Price,
            "money" => Self::Money,
            "pnl" => Self::Pnl,
            "percent" => Self::Percent,
            "pnlPercent" => Self::PnlPercent,
            "number" => Self::Number,
            "time" => Self::Time,
            _ => Self::Text,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AccountPageSort {
    pub column: String,
    #[serde(default = "yes")]
    pub asc: bool,
}

const fn yes() -> bool {
    true
}

/// A value of a page's table: a number or a text. A true / false reads as text, a list or an object as an empty text.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(untagged)]
pub enum PageCell {
    Number(f64),
    Text(String),
}

impl<'de> Deserialize<'de> for PageCell {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Ok(match serde_json::Value::deserialize(d)? {
            serde_json::Value::Number(n) => n.as_f64().map_or(PageCell::Text(String::new()), PageCell::Number),
            serde_json::Value::String(s) => PageCell::Text(s),
            serde_json::Value::Bool(b) => PageCell::Text(b.to_string()),
            _ => PageCell::Text(String::new()),
        })
    }
}

fn pages_that_read<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<AccountPage>, D::Error> {
    let pages = Option::<Vec<serde_json::Value>>::deserialize(d)?.unwrap_or_default();
    Ok(pages.into_iter().filter_map(|p| serde_json::from_value(p).ok()).collect())
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
    /// The time in force picked (a `durations` id); left out when the broker declares none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration: Option<String>,
    /// The preview's `confirmId` of an order the user confirmed on the confirmation page; left out otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm_id: Option<String>,
    /// Exit levels, in place of `takeProfit` / `stopLoss` (then null); left out without any.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exit_levels: Vec<ExitLevel>,
}

/// What the broker says of an order before it is sent (`broker.previewOrder`): the order ticket's confirmation page.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(default, rename_all = "camelCase")]
pub struct OrderPreview {
    /// Tables of label / value rows (commission, margin before and after…), each under its title when it has one.
    pub sections: Vec<PreviewSection>,
    /// Shown above the tables; the order can still be sent.
    pub warnings: Vec<String>,
    /// The broker would refuse the order: shown, and Send Order is off.
    pub errors: Vec<String>,
    /// Sent back with the order once the user confirms it (`broker.place` `confirmId`), for a broker that ties the
    /// order to what it previewed.
    pub confirm_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(default, rename_all = "camelCase")]
pub struct PreviewSection {
    pub title: Option<String>,
    pub rows: Vec<AccountValue>,
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
        assert!(s.pages.is_empty());
    }

    #[test]
    fn broker_pages_read_and_a_broken_one_is_left_out() {
        let s: BrokerState = serde_json::from_value(serde_json::json!({
            "connected": true,
            "pages": [
                { "id": "holdings", "title": "Holdings", "counter": true, "tables": [{
                    "id": "main",
                    "columns": [{ "id": "symbol", "label": "Symbol", "format": "symbol" }, { "id": "qty", "label": "Quantity", "format": "qty" },
                                { "id": "isin", "label": "ISIN", "format": "barcode", "hidden": true }],
                    "sort": { "column": "qty", "asc": false },
                    "rows": [{ "id": "1", "symbol": "RELIANCE", "qty": 10, "isin": "INE002A01018", "pledged": true, "extra": [1], "none": null }]
                }] },
                { "id": "broken", "tables": "nope" }
            ]
        }))
        .unwrap();
        assert!(s.connected);
        assert_eq!(s.pages.len(), 1);
        let t = &s.pages[0].tables[0];
        assert_eq!((t.columns[0].format, t.columns[2].format), (ColumnFormat::Symbol, ColumnFormat::Text));
        assert!(t.columns[2].hidden && !t.sort.as_ref().unwrap().asc);
        assert_eq!(t.rows[0]["qty"], Some(PageCell::Number(10.0)));
        assert_eq!(t.rows[0]["pledged"], Some(PageCell::Text("true".into())));
        assert_eq!((&t.rows[0]["extra"], &t.rows[0]["none"]), (&Some(PageCell::Text(String::new())), &None));
        // To the window: numbers, texts and null.
        let v = serde_json::to_value(&t.rows[0]).unwrap();
        assert_eq!((v["qty"].as_f64(), v["extra"].as_str(), v["none"].is_null()), (Some(10.0), Some(""), true));
        // Each format reads back as it is written (the window's status goes both ways).
        for f in [ColumnFormat::Symbol, ColumnFormat::Side, ColumnFormat::Qty, ColumnFormat::Price, ColumnFormat::Money, ColumnFormat::Pnl] {
            assert_eq!(serde_json::from_value::<ColumnFormat>(serde_json::to_value(f).unwrap()).unwrap(), f);
        }
        for f in [ColumnFormat::Percent, ColumnFormat::PnlPercent, ColumnFormat::Number, ColumnFormat::Time, ColumnFormat::Text] {
            assert_eq!(serde_json::from_value::<ColumnFormat>(serde_json::to_value(f).unwrap()).unwrap(), f);
        }
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

    #[test]
    fn durations_read_and_go_with_the_order() {
        let c: BrokerCapabilities = serde_json::from_value(serde_json::json!({
            "durations": [{ "id": "day", "label": "Day", "default": true }, { "id": "ioc", "orderTypes": ["market", "limit"] }]
        }))
        .unwrap();
        assert!(c.durations[0].default && c.durations[0].order_types.is_empty());
        assert_eq!(c.durations[1].order_types, vec![OrderType::Market, OrderType::Limit]);
        let i: Instrument = serde_json::from_value(serde_json::json!({ "durations": [{ "id": "gtc" }] })).unwrap();
        assert_eq!(i.durations.unwrap()[0].id, "gtc");
        // Left out of the order when none was picked, so a plugin without durations sees the same order as before.
        let t: OrderTicket = serde_json::from_value(serde_json::json!({ "ticker": "X", "side": "buy", "type": "limit", "qty": 1, "limitPrice": 1, "stopPrice": null, "takeProfit": null, "stopLoss": null })).unwrap();
        assert!(serde_json::to_value(&t).unwrap().get("duration").is_none());
        let t = OrderTicket { duration: Some("gtc".into()), ..t };
        assert_eq!(serde_json::to_value(&t).unwrap()["duration"], "gtc");
    }

    #[test]
    fn checkbox_fields_margin_rate_and_previews_read() {
        let c: BrokerCapabilities = serde_json::from_value(serde_json::json!({
            "orderPreview": true,
            "ticketFields": [
                { "id": "outsideRth", "label": "Outside RTH", "type": "checkbox", "orderTypes": ["limit"] },
                { "id": "tpOutsideRth", "label": "Outside RTH Take Profit", "type": "checkbox", "exit": "takeProfit" },
                { "id": "route", "label": "Routing", "type": "dropdown", "options": [{ "value": "SMART" }] }
            ]
        }))
        .unwrap();
        assert!(c.order_preview);
        assert_eq!((c.ticket_fields[0].kind, &c.ticket_fields[0].order_types), (TicketFieldKind::Checkbox, &vec![OrderType::Limit]));
        assert_eq!(c.ticket_fields[1].exit, Some(ExitLeg::TakeProfit));
        assert_eq!((c.ticket_fields[2].kind, c.ticket_fields[2].exit), (TicketFieldKind::Select, None));
        assert!(!BrokerCapabilities::default().order_preview);
        let i: Instrument = serde_json::from_value(serde_json::json!({ "marginRate": 0.05 })).unwrap();
        assert_eq!(i.margin_rate, Some(0.05));
        let p: OrderPreview = serde_json::from_value(serde_json::json!({
            "sections": [{ "rows": [{ "label": "Commission", "value": "1.00" }] }, { "title": "Initial margin", "rows": [] }],
            "warnings": ["Outside regular hours"]
        }))
        .unwrap();
        assert_eq!((p.sections[0].title.as_deref(), p.sections[1].title.as_deref()), (None, Some("Initial margin")));
        assert_eq!((p.sections[0].rows[0].label.as_str(), p.errors.len()), ("Commission", 0));
    }

    #[test]
    fn exit_levels_read_and_go_with_the_order() {
        let c: BrokerCapabilities = serde_json::from_value(serde_json::json!({ "exitLevels": true, "maxExitLevels": 4 })).unwrap();
        assert!(c.exit_levels && c.max_exit_levels == Some(4));
        assert!(!BrokerCapabilities::default().exit_levels);
        let o: Order = serde_json::from_value(serde_json::json!({
            "id": "1", "ticker": "X", "side": "buy", "type": "limit", "qty": 2, "limitPrice": 10,
            "exitLevels": [{ "id": "a", "qty": 1, "takeProfit": 11, "stopLoss": 9 }, { "qty": 1, "takeProfit": 12 }]
        }))
        .unwrap();
        assert_eq!((o.exit_levels[0].id.as_deref(), o.exit_levels[1].stop_loss), (Some("a"), None));
        let t: OrderTicket = serde_json::from_value(serde_json::json!({ "ticker": "X", "side": "buy", "type": "market", "qty": 1, "limitPrice": null, "stopPrice": null, "takeProfit": null, "stopLoss": null })).unwrap();
        // Left out without levels, so a plugin without them sees the same order as before.
        assert!(serde_json::to_value(&t).unwrap().get("exitLevels").is_none());
        let t = OrderTicket { exit_levels: vec![ExitLevel { id: None, qty: 1.0, take_profit: Some(11.0), stop_loss: Some(9.0) }], ..t };
        assert_eq!(serde_json::to_value(&t).unwrap()["exitLevels"][0], serde_json::json!({ "qty": 1.0, "takeProfit": 11.0, "stopLoss": 9.0 }));
    }
}
