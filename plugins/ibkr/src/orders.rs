/*
 * Orders between the Plugin API and the socket API: checking an order ticket, building the broker's orders from it
 * (a bracket when it carries a take profit or stop loss), the exit orders of a position, and reading the broker's
 * order types, statuses and times back.
 */
use crate::wire::{OrderDuration, OrderStatus, OrderTicket, OrderType, Side, TicketField};
use ibapi::orders::OrderState;
use ibapi::orders::{Action, OcaType, Order as IbOrder, OrderStatusKind, TimeInForce};

/// Prefix of the one-cancels-all groups this plugin gives a position's exit orders, so they are found again as the
/// position's take profit / stop loss.
pub const EXIT_GROUP: &str = "OT-EXIT-";

/// The two exits of a position or bracket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Leg {
    TakeProfit,
    StopLoss,
}

pub fn validate(t: &OrderTicket) -> Result<(), String> {
    if t.ticker.trim().is_empty() {
        return Err("The order has no symbol".into());
    }
    if !(t.qty.is_finite() && t.qty > 0.0) {
        return Err("The quantity must be above 0".into());
    }
    let price = |p: Option<f64>, what: &str| match p {
        Some(v) if v.is_finite() && v > 0.0 => Ok(()),
        Some(_) => Err(format!("The {what} price must be above 0")),
        None => Err(format!("The {what} price is missing")),
    };
    match t.order_type {
        OrderType::Market => {}
        OrderType::Limit => price(t.limit_price, "limit")?,
        OrderType::Stop => price(t.stop_price, "stop")?,
        OrderType::StopLimit => {
            price(t.stop_price, "stop")?;
            price(t.limit_price, "limit")?;
        }
    }
    for (p, what) in [(t.take_profit, "take profit"), (t.stop_loss, "stop loss")] {
        if p.is_some_and(|v| !(v.is_finite() && v > 0.0)) {
            return Err(format!("The {what} price must be above 0"));
        }
    }
    Ok(())
}

/// A price on the contract's tick grid (the broker refuses others); unchanged when the tick is unknown.
pub fn on_tick(price: Option<f64>, tick: Option<f64>) -> Option<f64> {
    match (price, tick) {
        (Some(p), Some(t)) if t > 0.0 => Some(((p / t).round() * t * 1e8).round() / 1e8),
        _ => price,
    }
}

/// The ticket with its prices on the tick grid.
pub fn rounded(t: &OrderTicket, tick: Option<f64>) -> OrderTicket {
    OrderTicket {
        limit_price: on_tick(t.limit_price, tick),
        stop_price: on_tick(t.stop_price, tick),
        take_profit: on_tick(t.take_profit, tick),
        stop_loss: on_tick(t.stop_loss, tick),
        ..t.clone()
    }
}

pub fn action(side: Side) -> Action {
    match side {
        Side::Buy => Action::Buy,
        Side::Sell => Action::Sell,
    }
}

pub fn side_of(a: &Action) -> Side {
    match a {
        Action::Buy => Side::Buy,
        _ => Side::Sell,
    }
}

/// The times in force the order ticket offers (`capabilities.durations`): the day by default; at the opening and
/// immediate or cancel for market and limit orders only, as the broker takes them.
pub fn durations() -> Vec<OrderDuration> {
    let d = |id: &str, label: &str, order_types: Vec<OrderType>, default: bool| OrderDuration { id: id.into(), label: label.into(), order_types, default };
    let market_limit = || vec![OrderType::Market, OrderType::Limit];
    vec![
        d("day", "Day", vec![], true),
        d("gtc", "Good Till Cancel", vec![], false),
        d("opg", "At The Opening", market_limit(), false),
        d("ioc", "Immediate or Cancel", market_limit(), false),
    ]
}

/// The order ticket's Extra settings (reference: Outside RTH, and the same for the take profit and the stop loss): a
/// market order never fills outside regular hours, so it has none.
pub fn ticket_fields() -> Vec<TicketField> {
    let check = |id: &str, label: &str, order_types: Vec<OrderType>, exit: Option<&str>| TicketField {
        id: id.into(),
        label: label.into(),
        kind: "checkbox".into(),
        order_types,
        exit: exit.map(String::from),
    };
    vec![
        check("outsideRth", "Outside RTH", vec![OrderType::Limit, OrderType::Stop, OrderType::StopLimit], None),
        check("tpOutsideRth", "Outside RTH Take Profit", vec![], Some("takeProfit")),
        check("slOutsideRth", "Outside RTH Stop Loss", vec![], Some("stopLoss")),
    ]
}

/// A ticket field ticked.
fn ticked(t: &OrderTicket, id: &str) -> bool {
    t.fields.get(id).is_some_and(|v| v == "true")
}

/// Some part of the order may fill outside regular trading hours.
pub fn outside_rth_any(t: &OrderTicket) -> bool {
    (ticked(t, "outsideRth") && t.order_type != OrderType::Market)
        || (ticked(t, "tpOutsideRth") && t.take_profit.is_some())
        || (ticked(t, "slOutsideRth") && t.stop_loss.is_some())
}

/// The preview's tables from a what-if answer (reference: commission, then equity with loan, initial and maintenance
/// margin as current / change / after).
pub fn preview_of(s: &OrderState, warnings: Vec<String>) -> serde_json::Value {
    let money = |v: Option<f64>| finite(v).map(|x| format!("{x:.2}"));
    let ccy = |c: &str| (!c.trim().is_empty()).then(|| c.trim().to_string());
    let row = |label: &str, v: Option<String>, c: Option<String>| v.map(|value| serde_json::json!({ "label": label, "value": value, "currency": c }));
    let mut sections = Vec::new();
    let fee = ccy(&s.commission_currency);
    let commission = match (finite(s.minimum_commission), finite(s.maximum_commission)) {
        // A range when the broker can't tell yet (the fill splits the order).
        (Some(lo), Some(hi)) if (hi - lo).abs() > 1e-9 && finite(s.commission).is_none() => Some(format!("{lo:.2} – {hi:.2}")),
        _ => money(s.commission),
    };
    let first: Vec<_> = [row("Commission", commission, fee)].into_iter().flatten().collect();
    if !first.is_empty() {
        sections.push(serde_json::json!({ "rows": first }));
    }
    let margin = ccy(&s.margin_currency);
    for (title, before, change, after) in [
        ("Equity with loan", s.equity_with_loan_before, s.equity_with_loan_change, s.equity_with_loan_after),
        ("Initial margin", s.initial_margin_before, s.initial_margin_change, s.initial_margin_after),
        ("Maintenance margin", s.maintenance_margin_before, s.maintenance_margin_change, s.maintenance_margin_after),
    ] {
        let rows: Vec<_> = [("Current", before), ("Change", change), ("After", after)].into_iter().filter_map(|(l, v)| row(l, money(v), margin.clone())).collect();
        if !rows.is_empty() {
            sections.push(serde_json::json!({ "title": title, "rows": rows }));
        }
    }
    let mut warnings = warnings;
    if !s.warning_text.trim().is_empty() {
        warnings.push(s.warning_text.trim().to_string());
    }
    let errors: Vec<String> = (!s.reject_reason.trim().is_empty()).then(|| s.reject_reason.trim().to_string()).into_iter().collect();
    serde_json::json!({ "sections": sections, "warnings": warnings, "errors": errors })
}

/// The time in force of a ticket: the duration picked; without one (an app that offers none), market orders last the
/// day and the others stay until cancelled, as on the chart.
pub fn tif_of(t: &OrderTicket) -> TimeInForce {
    match t.duration.as_deref().map(str::to_ascii_lowercase).as_deref() {
        Some("day") => TimeInForce::Day,
        Some("gtc") => TimeInForce::GoodTillCanceled,
        Some("opg") => TimeInForce::OnOpen,
        Some("ioc") => TimeInForce::ImmediateOrCancel,
        _ if t.order_type == OrderType::Market => TimeInForce::Day,
        _ => TimeInForce::GoodTillCanceled,
    }
}

/// The broker's order for a ticket.
pub fn build_order(t: &OrderTicket, account: &str) -> IbOrder {
    let (order_type, limit, stop) = match t.order_type {
        OrderType::Market => ("MKT", None, None),
        OrderType::Limit => ("LMT", t.limit_price, None),
        OrderType::Stop => ("STP", None, t.stop_price),
        OrderType::StopLimit => ("STP LMT", t.limit_price, t.stop_price),
    };
    IbOrder {
        action: action(t.side),
        total_quantity: t.qty,
        order_type: order_type.into(),
        limit_price: limit,
        aux_price: stop,
        tif: tif_of(t),
        // A market order never fills outside regular hours: the box is for the others.
        outside_rth: ticked(t, "outsideRth") && t.order_type != OrderType::Market,
        account: account.to_string(),
        transmit: true,
        ..Default::default()
    }
}

/// An exit order of `qty` on the `exit` side: a limit for the take profit, a stop for the stop loss. Good till
/// cancelled, like the position it protects.
pub fn exit_order(leg: Leg, exit: Side, qty: f64, price: f64, account: &str) -> IbOrder {
    let (order_type, limit, stop) = match leg {
        Leg::TakeProfit => ("LMT", Some(price), None),
        Leg::StopLoss => ("STP", None, Some(price)),
    };
    IbOrder {
        action: action(exit),
        total_quantity: qty,
        order_type: order_type.into(),
        limit_price: limit,
        aux_price: stop,
        tif: TimeInForce::GoodTillCanceled,
        account: account.to_string(),
        transmit: true,
        ..Default::default()
    }
}

/// A position exit in the one-cancels-all `group`: when one fills, the other shrinks by as much, so a partial take
/// profit leaves a stop for what is left, and the block keeps both from filling at once.
pub fn grouped_exit(leg: Leg, exit: Side, qty: f64, price: f64, account: &str, group: &str) -> IbOrder {
    IbOrder { oca_group: group.to_string(), oca_type: OcaType::ReduceWithBlock, ..exit_order(leg, exit, qty, price, account) }
}

/// The number of orders `bracket` makes of a ticket.
pub fn bracket_size(t: &OrderTicket) -> usize {
    1 + usize::from(t.take_profit.is_some()) + usize::from(t.stop_loss.is_some())
}

/// The orders of a ticket: the order itself, then its take profit and stop loss as child orders. The broker holds
/// the children until the parent fills and cancels the other when one fills. Only the last one is transmitted, so
/// the broker receives the bracket whole. `next_id` hands out order ids.
pub fn bracket(t: &OrderTicket, account: &str, mut next_id: impl FnMut() -> i32) -> Vec<IbOrder> {
    let mut parent = build_order(t, account);
    parent.order_id = next_id();
    let parent_id = parent.order_id;
    let mut legs = vec![parent];
    let exit = t.side.opposite();
    for (leg, price) in [(Leg::TakeProfit, t.take_profit), (Leg::StopLoss, t.stop_loss)] {
        if let Some(p) = price {
            let mut child = exit_order(leg, exit, t.qty, p, account);
            child.outside_rth = ticked(t, if leg == Leg::TakeProfit { "tpOutsideRth" } else { "slOutsideRth" });
            child.order_id = next_id();
            child.parent_id = parent_id;
            legs.push(child);
        }
    }
    let last = legs.len() - 1;
    for (i, o) in legs.iter_mut().enumerate() {
        o.transmit = i == last;
    }
    legs
}

/// Row id of an order: "<client id>:<order id>", or "p<perm id>" for an order the broker reports without an order
/// id (placed in TWS: 0, or read back from the completed orders: -1).
pub fn order_key(client_id: i32, order_id: i32, perm_id: i64) -> String {
    if order_id <= 0 && perm_id != 0 {
        format!("p{perm_id}")
    } else {
        format!("{client_id}:{order_id}")
    }
}

pub fn status_of(kind: &OrderStatusKind) -> OrderStatus {
    match kind {
        OrderStatusKind::ApiPending | OrderStatusKind::PendingSubmit => OrderStatus::Placing,
        OrderStatusKind::ApiCancelled | OrderStatusKind::Cancelled => OrderStatus::Cancelled,
        OrderStatusKind::Filled => OrderStatus::Filled,
        OrderStatusKind::Inactive => OrderStatus::Inactive,
        // PreSubmitted (held until its trigger or the session), Submitted, PendingCancel.
        _ => OrderStatus::Working,
    }
}

pub fn type_of(raw: &str) -> OrderType {
    match raw.trim().to_ascii_uppercase().as_str() {
        "LMT" => OrderType::Limit,
        "STP" => OrderType::Stop,
        "STP LMT" => OrderType::StopLimit,
        _ => OrderType::Market,
    }
}

/// The limit and stop prices of an order of type `t`: the broker reports leftovers in the fields a type doesn't use
/// (a stop's limit price, for one).
pub fn prices_of(t: OrderType, limit: Option<f64>, aux: Option<f64>) -> (Option<f64>, Option<f64>) {
    let (limit, aux) = (positive(limit), positive(aux));
    match t {
        OrderType::Market => (None, None),
        OrderType::Limit => (limit, None),
        OrderType::Stop => (None, aux),
        OrderType::StopLimit => (limit, aux),
    }
}

pub fn tif_word(t: &TimeInForce) -> String {
    match t {
        TimeInForce::Day => "day".into(),
        TimeInForce::GoodTillCanceled => "gtc".into(),
        other => other.as_str().to_ascii_lowercase(),
    }
}

/// The socket API marks unset numbers with f64::MAX.
pub fn finite(v: Option<f64>) -> Option<f64> {
    v.filter(|x| x.is_finite() && x.abs() < 1e300)
}

pub fn positive(v: Option<f64>) -> Option<f64> {
    finite(v).filter(|p| *p > 0.0)
}

/// Execution times: "20261020 10:31:05 US/Eastern", "20261020-14:31:05" (UTC) or "20261020 10:31:05" (the
/// gateway's zone, which is this computer's). UNIX ms.
pub fn parse_time(s: &str) -> Option<f64> {
    use chrono::{Local, NaiveDateTime, TimeZone};
    let s = s.trim();
    if let Ok(dt) = NaiveDateTime::parse_from_str(s, "%Y%m%d-%H:%M:%S") {
        return Some(dt.and_utc().timestamp_millis() as f64);
    }
    let mut parts = s.split_whitespace();
    let date = parts.next()?;
    let time = parts.next()?;
    let dt = NaiveDateTime::parse_from_str(&format!("{date} {time}"), "%Y%m%d %H:%M:%S").ok()?;
    match parts.next().and_then(|z| z.parse::<chrono_tz::Tz>().ok()) {
        Some(tz) => tz.from_local_datetime(&dt).earliest().map(|d| d.timestamp_millis() as f64),
        None => Local.from_local_datetime(&dt).earliest().map(|d| d.timestamp_millis() as f64),
    }
}

pub fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ticket(order_type: OrderType, limit: Option<f64>, stop: Option<f64>) -> OrderTicket {
        OrderTicket {
            ticker: "AAPL".into(),
            side: Side::Buy,
            order_type,
            qty: 10.0,
            limit_price: limit,
            stop_price: stop,
            take_profit: None,
            stop_loss: None,
            duration: None,
            fields: Default::default(),
        }
    }

    #[test]
    fn the_duration_picked_is_the_time_in_force() {
        let with = |d: &str, t: OrderType| tif_of(&OrderTicket { duration: Some(d.into()), ..ticket(t, Some(100.0), None) });
        assert_eq!(with("day", OrderType::Limit), TimeInForce::Day);
        assert_eq!(with("gtc", OrderType::Market), TimeInForce::GoodTillCanceled);
        assert_eq!(with("opg", OrderType::Limit), TimeInForce::OnOpen);
        assert_eq!(with("IOC", OrderType::Market), TimeInForce::ImmediateOrCancel);
        // None picked (an older app): the day for a market order, until cancelled for the others.
        assert_eq!(tif_of(&ticket(OrderType::Market, None, None)), TimeInForce::Day);
        assert_eq!(tif_of(&ticket(OrderType::Stop, None, Some(1.0))), TimeInForce::GoodTillCanceled);
        // Each one declared reads back from the broker's order as its id; the day is the default.
        for d in durations() {
            assert_eq!(tif_word(&with(&d.id, OrderType::Limit)), d.id);
        }
        assert_eq!(durations().iter().filter(|d| d.default).map(|d| d.id.as_str()).collect::<Vec<_>>(), ["day"]);
        let caps = serde_json::to_value(crate::wire::BrokerCapabilities::default()).unwrap();
        assert_eq!(caps["durations"][2], serde_json::json!({ "id": "opg", "label": "At The Opening", "orderTypes": ["market", "limit"] }));
        assert_eq!(caps["durations"][0], serde_json::json!({ "id": "day", "label": "Day", "default": true }));
    }

    #[test]
    fn tickets_validate() {
        assert!(validate(&ticket(OrderType::Market, None, None)).is_ok());
        assert!(validate(&ticket(OrderType::Limit, None, None)).is_err());
        assert!(validate(&ticket(OrderType::Stop, Some(1.0), None)).is_err());
        assert!(validate(&ticket(OrderType::StopLimit, Some(1.0), None)).is_err());
        assert!(validate(&ticket(OrderType::StopLimit, Some(101.0), Some(100.0))).is_ok());
        let zero = OrderTicket { qty: 0.0, ..ticket(OrderType::Market, None, None) };
        assert!(validate(&zero).is_err());
        let bad_tp = OrderTicket { take_profit: Some(-1.0), ..ticket(OrderType::Market, None, None) };
        assert!(validate(&bad_tp).unwrap_err().contains("take profit"));
        // A price below half a tick rounds to 0: refused, not sent.
        let tiny = rounded(&ticket(OrderType::Limit, Some(0.00001), None), Some(0.01));
        assert_eq!(validate(&tiny).unwrap_err(), "The limit price must be above 0");
    }

    #[test]
    fn orders_build() {
        let o = build_order(&ticket(OrderType::StopLimit, Some(101.0), Some(100.0)), "DU1");
        assert_eq!(o.order_type, "STP LMT");
        assert_eq!(o.action, Action::Buy);
        assert_eq!((o.limit_price, o.aux_price), (Some(101.0), Some(100.0)));
        assert_eq!(o.tif, TimeInForce::GoodTillCanceled);
        assert_eq!(o.account, "DU1");
        assert!(o.transmit);
        let m = build_order(&ticket(OrderType::Market, None, None), "DU1");
        assert_eq!((m.order_type.as_str(), m.tif), ("MKT", TimeInForce::Day));
        assert_eq!((m.limit_price, m.aux_price), (None, None));
        let s = build_order(&OrderTicket { side: Side::Sell, ..ticket(OrderType::Stop, None, Some(90.0)) }, "DU1");
        assert_eq!((s.action, s.order_type.as_str(), s.aux_price), (Action::Sell, "STP", Some(90.0)));
    }

    #[test]
    fn brackets_build() {
        let t = OrderTicket { take_profit: Some(120.0), stop_loss: Some(90.0), ..ticket(OrderType::Limit, Some(100.0), None) };
        let mut ids = 40..;
        let legs = bracket(&t, "DU1", || ids.next().unwrap());
        assert_eq!(legs.len(), 3);
        let (p, tp, sl) = (&legs[0], &legs[1], &legs[2]);
        assert_eq!((p.order_id, p.parent_id, p.transmit), (40, 0, false));
        assert_eq!((tp.order_id, tp.parent_id, tp.transmit), (41, 40, false));
        assert_eq!((sl.order_id, sl.parent_id, sl.transmit), (42, 40, true));
        assert_eq!((tp.action, tp.order_type.as_str(), tp.limit_price), (Action::Sell, "LMT", Some(120.0)));
        assert_eq!((sl.action, sl.order_type.as_str(), sl.aux_price), (Action::Sell, "STP", Some(90.0)));
        assert_eq!((tp.total_quantity, sl.tif.clone()), (10.0, TimeInForce::GoodTillCanceled));

        // No exits: the order alone, transmitted.
        let mut ids = 7..;
        let one = bracket(&ticket(OrderType::Market, None, None), "DU1", || ids.next().unwrap());
        assert_eq!(one.len(), 1);
        assert!(one[0].transmit);

        // A short with only a stop loss: a buy stop.
        let short = OrderTicket { side: Side::Sell, stop_loss: Some(110.0), ..ticket(OrderType::Market, None, None) };
        let mut ids = 1..;
        let legs = bracket(&short, "DU1", || ids.next().unwrap());
        assert_eq!(legs.len(), 2);
        assert_eq!((legs[1].action, legs[1].order_type.as_str(), legs[1].aux_price), (Action::Buy, "STP", Some(110.0)));
        assert!(!legs[0].transmit && legs[1].transmit);
    }

    #[test]
    fn outside_rth_boxes_go_to_their_orders() {
        let tick = |ids: &[&str]| ids.iter().map(|i| (i.to_string(), "true".to_string())).collect();
        let t = OrderTicket { take_profit: Some(120.0), stop_loss: Some(90.0), fields: tick(&["outsideRth", "tpOutsideRth"]), ..ticket(OrderType::Limit, Some(100.0), None) };
        let mut ids = 1..;
        let legs = bracket(&t, "DU1", || ids.next().unwrap());
        assert_eq!(legs.iter().map(|o| o.outside_rth).collect::<Vec<_>>(), [true, true, false]);
        assert!(outside_rth_any(&t));
        // A market order never fills outside regular hours; an exit's box alone counts only with that exit.
        let m = OrderTicket { fields: tick(&["outsideRth", "slOutsideRth"]), ..ticket(OrderType::Market, None, None) };
        assert!(!build_order(&m, "DU1").outside_rth && !outside_rth_any(&m));
        let caps = serde_json::to_value(crate::wire::BrokerCapabilities::default()).unwrap();
        assert_eq!(caps["orderPreview"], true);
        assert_eq!(caps["ticketFields"][0], serde_json::json!({ "id": "outsideRth", "label": "Outside RTH", "type": "checkbox", "orderTypes": ["limit", "stop", "stopLimit"] }));
        assert_eq!(caps["ticketFields"][1]["exit"], "takeProfit");
    }

    #[test]
    fn what_if_answers_read_as_preview_tables() {
        let s = OrderState {
            commission: Some(1.0),
            commission_currency: "USD".into(),
            initial_margin_before: Some(0.0),
            initial_margin_change: Some(262.38),
            initial_margin_after: Some(262.38),
            equity_with_loan_after: Some(f64::MAX),
            margin_currency: "USD".into(),
            warning_text: "Outside hours".into(),
            ..Default::default()
        };
        let p = preview_of(&s, vec!["Order can be executed outside regular trading hours.".into()]);
        assert_eq!(p["sections"][0]["rows"][0], serde_json::json!({ "label": "Commission", "value": "1.00", "currency": "USD" }));
        // An unset figure (f64::MAX) leaves its row out; a table without rows is left out.
        assert_eq!(p["sections"][1]["title"], "Initial margin");
        assert_eq!(p["sections"][1]["rows"][1]["value"], "262.38");
        assert_eq!(p["sections"].as_array().unwrap().len(), 2);
        assert_eq!(p["warnings"].as_array().unwrap().len(), 2);
        let refused = preview_of(&OrderState { reject_reason: "Insufficient buying power".into(), ..Default::default() }, vec![]);
        assert_eq!(refused["errors"][0], "Insufficient buying power");
    }

    #[test]
    fn exits_group() {
        let o = grouped_exit(Leg::StopLoss, Side::Sell, 5.0, 95.0, "DU1", "OT-EXIT-1");
        assert_eq!((o.oca_group.as_str(), o.oca_type), ("OT-EXIT-1", OcaType::ReduceWithBlock));
        assert_eq!((o.order_type.as_str(), o.aux_price, o.parent_id), ("STP", Some(95.0), 0));
    }

    #[test]
    fn ticks() {
        assert_eq!(on_tick(Some(100.004), Some(0.01)), Some(100.0));
        assert_eq!(on_tick(Some(100.006), Some(0.01)), Some(100.01));
        assert_eq!(on_tick(Some(1.23456), None), Some(1.23456));
        assert_eq!(on_tick(None, Some(0.01)), None);
        let t = rounded(&OrderTicket { take_profit: Some(1.0049), ..ticket(OrderType::Limit, Some(0.333), None) }, Some(0.01));
        assert_eq!((t.limit_price, t.take_profit), (Some(0.33), Some(1.0)));
    }

    #[test]
    fn keys_statuses_types() {
        assert_eq!(order_key(17, 12, 99), "17:12");
        assert_eq!(order_key(0, 0, 99), "p99");
        assert_eq!(order_key(17, -1, 98), "p98");
        assert_eq!(prices_of(OrderType::Stop, Some(0.53), Some(0.5)), (None, Some(0.5)));
        assert_eq!(prices_of(OrderType::StopLimit, Some(0.53), Some(f64::MAX)), (Some(0.53), None));
        assert_eq!(status_of(&OrderStatusKind::PreSubmitted), OrderStatus::Working);
        assert_eq!(status_of(&OrderStatusKind::PendingSubmit), OrderStatus::Placing);
        assert_eq!(status_of(&OrderStatusKind::ApiCancelled), OrderStatus::Cancelled);
        assert_eq!(type_of("stp lmt"), OrderType::StopLimit);
        assert_eq!(type_of("TRAIL"), OrderType::Market);
        assert_eq!(finite(Some(f64::MAX)), None);
        assert_eq!(positive(Some(0.0)), None);
    }

    #[test]
    fn execution_times_parse() {
        // 10:31:05 in New York (EDT) is 14:31:05 UTC.
        let a = parse_time("20261020 10:31:05 US/Eastern").unwrap();
        let b = parse_time("20261020-14:31:05").unwrap();
        assert_eq!(a, b);
        assert!(parse_time("20261020 10:31:05").is_some());
        assert!(parse_time("junk").is_none());
    }
}
