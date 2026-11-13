/*
 * What the plugin knows of the account, written by the connection's tasks and read as the `broker.state` snapshot.
 * One lock, never held across an await. Each change bumps a version the state pusher waits on; the order
 * notifications (`broker.event`) and notices (`broker.notice`) a change causes are queued in the tables and sent
 * once the lock is released.
 *
 * Brackets. The broker has no take profit / stop loss fields: they are orders. A bracket's take profit (limit) and
 * stop loss (stop) are child orders of the order they protect; a position's are working exit orders on the other
 * side, either the children of a filled bracket or a one-cancels-all pair this plugin placed. The snapshot reports
 * them on the order's or the position's `takeProfit` / `stopLoss` and leaves them out of the order list. Exit orders
 * left behind by a closed position stay listed, so they can be seen and cancelled.
 */
use crate::orders::{now_ms, EXIT_GROUP};
use crate::rpc::Out;
use crate::wire::*;
use ibapi::orders::{OcaType, TimeInForce};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;
use tokio::sync::watch;

/// Finished orders kept for the account manager's filters.
const KEEP_FINISHED: usize = 200;
const KEEP_EXECUTIONS: usize = 500;

/// A held contract of the selected account.
#[derive(Debug, Clone, PartialEq)]
pub struct PosRow {
    pub contract_id: i32,
    pub ticker: String,
    /// Signed: below 0 is short.
    pub qty: f64,
    pub avg_price: f64,
    pub last: Option<f64>,
    pub unrealized: Option<f64>,
    pub realized: Option<f64>,
}

impl PosRow {
    pub fn side(&self) -> Side {
        if self.qty >= 0.0 {
            Side::Buy
        } else {
            Side::Sell
        }
    }
}

/// An order as the broker reported it (or as sent, until it does).
#[derive(Debug, Clone, PartialEq)]
pub struct OrdRow {
    pub key: String,
    pub order_id: i32,
    pub perm_id: i64,
    pub client_id: i32,
    pub parent_id: i32,
    /// The bracket order's perm id, when the broker gives it.
    pub parent_perm: i64,
    pub oca_group: String,
    pub oca_type: OcaType,
    pub account: String,
    pub contract_id: i32,
    pub ticker: String,
    pub side: Side,
    pub order_type: OrderType,
    pub qty: f64,
    pub filled: f64,
    pub limit: Option<f64>,
    pub stop: Option<f64>,
    pub avg_fill: Option<f64>,
    pub status: OrderStatus,
    pub tif: TimeInForce,
    pub outside_rth: bool,
    pub message: Option<String>,
    /// Placed through this plugin's client id: it can be modified and cancelled from here.
    pub mine: bool,
    /// A bracket leg this plugin cancelled to replace or remove it: no longer one of its order's legs.
    pub detached: bool,
    pub updated_ms: f64,
}

impl OrdRow {
    /// The price shown in an order notification.
    pub fn price(&self) -> Option<f64> {
        match self.order_type {
            OrderType::Stop => self.stop,
            _ => self.limit.or(self.stop),
        }
    }

    /// A bracket child or a position exit this plugin grouped: quiet when placed or cancelled.
    pub fn is_exit_leg(&self) -> bool {
        self.parent_id > 0 || self.parent_perm != 0 || self.oca_group.starts_with(EXIT_GROUP)
    }

    pub fn event(&self, kind: &str, message: Option<String>) -> BrokerEvent {
        BrokerEvent {
            kind: kind.into(),
            ticker: self.ticker.clone(),
            side: self.side,
            order_type: self.order_type,
            qty: self.qty,
            price: self.price(),
            message,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExecRow {
    pub exec: Execution,
    pub account: String,
    pub perm_id: i64,
}

#[derive(Default)]
pub struct Tables {
    /// Logged in to IB Gateway / TWS.
    pub connected: bool,
    pub accounts: Vec<String>,
    pub account: Option<String>,
    /// Account values of the selected account by (key, currency).
    pub values: HashMap<(String, String), String>,
    /// Realized and unrealized P&L of the account's live P&L feed.
    pub pnl: (Option<f64>, Option<f64>),
    pub positions: BTreeMap<i32, PosRow>,
    pub orders: HashMap<String, OrdRow>,
    pub executions: HashMap<String, ExecRow>,
    /// Orders a request is waiting on: their rejection is the request's error answer, not a notification.
    pub awaiting: HashSet<String>,
    outbox: Vec<(&'static str, Value)>,
}

impl Tables {
    pub fn notice(&mut self, level: &str, message: impl Into<String>) {
        let message = message.into();
        println!("[{level}] {message}");
        self.outbox.push(("broker.notice", json!({ "level": level, "message": message })));
    }

    pub fn event(&mut self, e: BrokerEvent) {
        self.outbox.push(("broker.event", serde_json::to_value(e).unwrap_or_default()));
    }

    /// Forget the account's data (new connection, account switch).
    pub fn clear_account(&mut self) {
        self.values.clear();
        self.pnl = (None, None);
        self.positions.clear();
        self.orders.clear();
        self.executions.clear();
    }

    /// The row of an order the broker reported by order id / perm id: the same key, else the row with that perm
    /// id (the completed orders come without order ids).
    pub fn find_key(&self, key: &str, perm_id: i64) -> Option<String> {
        if self.orders.contains_key(key) {
            return Some(key.to_string());
        }
        (perm_id != 0).then(|| self.orders.values().find(|o| o.perm_id == perm_id).map(|o| o.key.clone())).flatten()
    }

    /// An order's new state, with the notifications its change of status calls for.
    pub fn upsert_order(&mut self, mut row: OrdRow) {
        let prev = self.find_key(&row.key, row.perm_id).and_then(|k| self.orders.remove(&k));
        if let Some(p) = &prev {
            row.key = p.key.clone();
            row.filled = row.filled.max(p.filled);
            row.avg_fill = row.avg_fill.or(p.avg_fill);
            row.message = row.message.or_else(|| p.message.clone());
            row.detached |= p.detached;
            if row.perm_id == 0 {
                row.perm_id = p.perm_id;
            }
            // A rejection stays (the broker follows it with a plain cancelled status).
            if p.status == OrderStatus::Rejected && row.status != OrderStatus::Filled {
                row.status = OrderStatus::Rejected;
            }
        }
        self.transition(prev.as_ref().map(|p| p.status), &row);
        self.orders.insert(row.key.clone(), row);
    }

    /// A status update of a known order.
    pub fn update_status(&mut self, key: &str, perm_id: i64, f: impl FnOnce(&mut OrdRow)) {
        let Some(k) = self.find_key(key, perm_id) else { return };
        let Some(mut row) = self.orders.get(&k).cloned() else { return };
        let before = row.status;
        f(&mut row);
        if before == OrderStatus::Rejected && row.status != OrderStatus::Filled {
            row.status = OrderStatus::Rejected;
        }
        if perm_id != 0 {
            row.perm_id = perm_id;
        }
        row.updated_ms = now_ms();
        self.transition(Some(before), &row);
        self.orders.insert(k, row);
    }

    /// The broker refused an order.
    pub fn reject(&mut self, key: &str, message: &str) {
        self.update_status(key, 0, |o| {
            if o.status != OrderStatus::Filled {
                o.status = OrderStatus::Rejected;
            }
            o.message = Some(message.to_string());
        });
    }

    /// Toasts for a status change: an order of this plugin accepted, an order cancelled, an order rejected. Fills
    /// are told by their executions. Bracket legs and position exits come and go with their order or position, so
    /// they only speak up when rejected.
    fn transition(&mut self, prev: Option<OrderStatus>, row: &OrdRow) {
        let Some(prev) = prev else { return };
        if prev == row.status {
            return;
        }
        let kind = match row.status {
            OrderStatus::Working | OrderStatus::Inactive if prev == OrderStatus::Placing && !row.is_exit_leg() => "placed",
            OrderStatus::Cancelled if prev.active() && !row.is_exit_leg() => "cancelled",
            OrderStatus::Rejected if !self.awaiting.contains(&row.key) => "rejected",
            _ => return,
        };
        let message = (kind == "rejected").then(|| row.message.clone().unwrap_or_else(|| "Rejected by the broker".into()));
        self.event(row.event(kind, message));
    }

    pub fn trim(&mut self) {
        let mut finished: Vec<(f64, String)> =
            self.orders.values().filter(|o| !o.status.active()).map(|o| (o.updated_ms, o.key.clone())).collect();
        if finished.len() > KEEP_FINISHED {
            finished.sort_by(|a, b| a.0.total_cmp(&b.0));
            for (_, k) in finished.iter().take(finished.len() - KEEP_FINISHED) {
                self.orders.remove(k);
            }
        }
        if self.executions.len() > KEEP_EXECUTIONS {
            let mut times: Vec<(f64, String)> = self.executions.values().map(|e| (e.exec.time_ms, e.exec.id.clone())).collect();
            times.sort_by(|a, b| a.0.total_cmp(&b.0));
            for (_, id) in times.iter().take(self.executions.len() - KEEP_EXECUTIONS) {
                self.executions.remove(id);
            }
        }
    }

    fn of_account(&self, account: &str) -> bool {
        account.is_empty() || self.account.as_deref().is_none_or(|a| a == account)
    }

    /// A bracket leg's order: by order id, or by perm id for the completed orders (which come without order ids).
    fn parent(&self, o: &OrdRow) -> Option<&OrdRow> {
        let by_id = (o.parent_id > 0).then(|| self.orders.get(&crate::orders::order_key(o.client_id, o.parent_id, 0))).flatten();
        by_id.or_else(|| (o.parent_perm != 0).then(|| self.orders.values().find(|p| p.perm_id == o.parent_perm)).flatten())
    }

    fn is_child_of(o: &OrdRow, parent: &OrdRow) -> bool {
        (parent.order_id > 0 && o.parent_id == parent.order_id && o.client_id == parent.client_id)
            || (parent.perm_id != 0 && o.parent_perm == parent.perm_id)
    }

    /// The take profit and stop loss children of a bracket order: the working ones of a working order (a leg
    /// removed by a modification is cancelled), any of a finished one (its history).
    pub fn children(&self, parent: &OrdRow) -> (Option<&OrdRow>, Option<&OrdRow>) {
        let mut kids: Vec<&OrdRow> = self
            .orders
            .values()
            .filter(|o| Self::is_child_of(o, parent) && !o.detached)
            .filter(|o| o.status.active() || !parent.status.active())
            .collect();
        // The latest legs first: a modification replaces legs with new ones.
        kids.sort_by(|a, b| b.updated_ms.total_cmp(&a.updated_ms).then(b.order_id.cmp(&a.order_id)));
        pick_legs(kids)
    }

    /// A position's working exit orders: other side, same contract, from a filled bracket or a one-cancels-all
    /// group.
    pub fn exits(&self, p: &PosRow) -> (Option<&OrdRow>, Option<&OrdRow>) {
        let exit = p.side().opposite();
        let mut legs: Vec<&OrdRow> = self
            .orders
            .values()
            .filter(|o| o.status.active() && o.contract_id == p.contract_id && o.side == exit && self.of_account(&o.account))
            .filter(|o| !o.oca_group.is_empty() || ((o.parent_id > 0 || o.parent_perm != 0) && !self.parent(o).is_some_and(|q| q.status.active())))
            .collect();
        legs.sort_by(|a, b| a.key.cmp(&b.key));
        pick_legs(legs)
    }

    /// Left out of the order list: legs of a working bracket (on the order), a position's exits (on the
    /// position), the cancelled legs of a cancelled bracket, and the legs this plugin replaced or removed.
    fn folded(&self, o: &OrdRow, exits: &HashSet<&str>) -> bool {
        if exits.contains(o.key.as_str()) || (o.detached && !o.status.active()) {
            return true;
        }
        match self.parent(o) {
            Some(p) if p.status.active() => true,
            Some(p) => !o.status.active() && matches!(p.status, OrderStatus::Cancelled | OrderStatus::Rejected),
            None => false,
        }
    }

    pub fn snapshot(&self) -> BrokerState {
        let mut exit_keys = HashSet::new();
        let mut positions: Vec<Position> = self
            .positions
            .values()
            .map(|p| {
                let (tp, sl) = self.exits(p);
                exit_keys.extend(tp.iter().chain(sl.iter()).map(|o| o.key.as_str()));
                Position {
                    id: p.contract_id.to_string(),
                    ticker: p.ticker.clone(),
                    side: p.side(),
                    qty: p.qty.abs(),
                    avg_price: p.avg_price,
                    last: p.last,
                    unrealized_pnl: p.unrealized,
                    realized_pnl: p.realized,
                    take_profit: tp.and_then(|o| o.limit),
                    stop_loss: sl.and_then(|o| o.stop),
                }
            })
            .collect();
        positions.sort_by(|a, b| a.ticker.cmp(&b.ticker));

        let mut rows: Vec<&OrdRow> =
            self.orders.values().filter(|o| self.of_account(&o.account) && !self.folded(o, &exit_keys)).collect();
        rows.sort_by(|a, b| b.updated_ms.total_cmp(&a.updated_ms).then(a.key.cmp(&b.key)));
        let orders = rows
            .into_iter()
            .map(|o| {
                let (tp, sl) = self.children(o);
                Order {
                    id: o.key.clone(),
                    ticker: o.ticker.clone(),
                    side: o.side,
                    order_type: o.order_type,
                    qty: o.qty,
                    filled_qty: o.filled,
                    limit_price: o.limit,
                    stop_price: o.stop,
                    take_profit: tp.and_then(|c| c.limit),
                    stop_loss: sl.and_then(|c| c.stop),
                    avg_fill_price: o.avg_fill,
                    status: o.status,
                    duration: Some(crate::orders::tif_word(&o.tif)),
                    message: o.message.clone(),
                    updated_ms: Some(o.updated_ms),
                }
            })
            .collect();

        let mut executions: Vec<Execution> =
            self.executions.values().filter(|e| self.of_account(&e.account)).map(|e| e.exec.clone()).collect();
        executions.sort_by(|a, b| b.time_ms.total_cmp(&a.time_ms));

        BrokerState {
            connected: self.connected,
            accounts: self.accounts.iter().map(|a| AccountRef { id: a.clone(), name: a.clone() }).collect(),
            account: self.account.as_deref().map(|a| self.account_of(a)),
            position_mode: PositionMode::Netting,
            capabilities: BrokerCapabilities::default(),
            positions,
            orders,
            executions,
        }
    }

    /// The selected account from its values. The balance is the cash, the equity the net liquidation value, the
    /// margin used the initial margin and the free margin the available funds.
    fn account_of(&self, id: &str) -> Account {
        // Values come per currency; the base currency is the one the net liquidation value comes in.
        let base = self
            .values
            .keys()
            .find(|(k, c)| k == "NetLiquidation" && !c.is_empty() && c != "BASE")
            .map(|(_, c)| c.clone())
            .unwrap_or_else(|| "USD".into());
        let raw = |key: &str| {
            [base.as_str(), "BASE", ""].iter().find_map(|c| self.values.get(&(key.to_string(), c.to_string())))
        };
        let num = |key: &str| raw(key).and_then(|v| v.parse::<f64>().ok()).filter(|v| v.is_finite());
        let values = VALUE_ROWS
            .iter()
            .filter_map(|(key, label, kind)| {
                let v = raw(key)?;
                let n = v.parse::<f64>().ok();
                let (value, currency) = match (kind, n) {
                    (Kind::Money, Some(n)) => (format!("{n:.2}"), Some(base.clone())),
                    (Kind::Ratio, Some(n)) => (format!("{:.1}%", n * 100.0), None),
                    (Kind::Count, Some(n)) if n < 0.0 => ("Unlimited".to_string(), None),
                    _ => (v.clone(), None),
                };
                Some(AccountValue { label: label.to_string(), value, currency })
            })
            .collect();
        Account {
            id: id.to_string(),
            name: id.to_string(),
            currency: base.clone(),
            // Paper accounts' ids start with D (DU…, DF…).
            is_demo: id.starts_with('D'),
            balance: num("TotalCashValue"),
            equity: num("NetLiquidation"),
            unrealized_pnl: self.pnl.1.or_else(|| num("UnrealizedPnL")),
            realized_pnl: self.pnl.0.or_else(|| num("RealizedPnL")),
            margin_used: num("InitMarginReq"),
            margin_free: num("AvailableFunds"),
            values,
        }
    }
}

/// The first limit order as the take profit, the first stop as the stop loss.
fn pick_legs(legs: Vec<&OrdRow>) -> (Option<&OrdRow>, Option<&OrdRow>) {
    let tp = legs.iter().find(|o| o.order_type == OrderType::Limit).copied();
    let sl = legs.iter().find(|o| matches!(o.order_type, OrderType::Stop | OrderType::StopLimit)).copied();
    (tp, sl)
}

enum Kind {
    Money,
    Ratio,
    Count,
}

/// The account values shown under the account summary, besides the header's figures.
const VALUE_ROWS: &[(&str, &str, Kind)] = &[
    ("BuyingPower", "Buying power", Kind::Money),
    ("AvailableFunds", "Available funds", Kind::Money),
    ("ExcessLiquidity", "Excess liquidity", Kind::Money),
    ("InitMarginReq", "Initial margin", Kind::Money),
    ("MaintMarginReq", "Maintenance margin", Kind::Money),
    ("GrossPositionValue", "Gross position value", Kind::Money),
    ("EquityWithLoanValue", "Equity with loan value", Kind::Money),
    ("PreviousDayEquityWithLoanValue", "Previous day equity with loan value", Kind::Money),
    ("RegTEquity", "Reg T equity", Kind::Money),
    ("RegTMargin", "Reg T margin", Kind::Money),
    ("SMA", "Special memorandum account", Kind::Money),
    ("SettledCash", "Settled cash", Kind::Money),
    ("AccruedCash", "Accrued cash", Kind::Money),
    ("Cushion", "Cushion", Kind::Ratio),
    ("Leverage-S", "Leverage", Kind::Count),
    ("DayTradesRemaining", "Day trades left", Kind::Count),
];

/// The tables, their version and the queue to the app.
pub struct Store {
    tables: Mutex<Tables>,
    version: watch::Sender<u64>,
    out: Out,
}

impl Store {
    pub fn new(out: Out) -> Self {
        Self { tables: Mutex::new(Tables::default()), version: watch::Sender::new(0), out }
    }

    pub fn out(&self) -> &Out {
        &self.out
    }

    /// Change the tables; the app hears of it within the state pusher's next beat.
    pub fn update<R>(&self, f: impl FnOnce(&mut Tables) -> R) -> R {
        let (r, sent) = {
            let mut t = self.tables.lock().unwrap_or_else(|e| e.into_inner());
            let r = f(&mut t);
            t.trim();
            (r, std::mem::take(&mut t.outbox))
        };
        self.version.send_modify(|v| *v = v.wrapping_add(1));
        for (method, params) in sent {
            self.out.notify(method, params);
        }
        r
    }

    pub fn read<R>(&self, f: impl FnOnce(&Tables) -> R) -> R {
        f(&self.tables.lock().unwrap_or_else(|e| e.into_inner()))
    }

    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.version.subscribe()
    }

    /// Wait until `f` holds, at most `limit`; whether it did.
    pub async fn wait_until(&self, limit: Duration, f: impl Fn(&Tables) -> bool) -> bool {
        let mut rx = self.subscribe();
        let wait = async {
            loop {
                if self.read(&f) {
                    return;
                }
                if rx.changed().await.is_err() {
                    return std::future::pending().await;
                }
            }
        };
        tokio::time::timeout(limit, wait).await.is_ok()
    }
}

/// Send the whole state whenever it changes, at most 4 times a second, and every 2 seconds anyway.
pub async fn push_states(store: std::sync::Arc<Store>) {
    let mut rx = store.subscribe();
    loop {
        let state = store.read(|t| serde_json::to_value(t.snapshot()).unwrap_or_default());
        store.out().notify("broker.state", state);
        tokio::time::sleep(Duration::from_millis(250)).await;
        tokio::select! {
            r = rx.changed() => if r.is_err() { return },
            _ = tokio::time::sleep(Duration::from_millis(1750)) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(key: &str, order_id: i32, parent_id: i32, side: Side, order_type: OrderType, price: f64, status: OrderStatus) -> OrdRow {
        let (limit, stop) = match order_type {
            OrderType::Stop => (None, Some(price)),
            _ => (Some(price), None),
        };
        OrdRow {
            key: key.into(),
            order_id,
            perm_id: 0,
            client_id: 17,
            parent_id,
            parent_perm: 0,
            oca_group: String::new(),
            oca_type: OcaType::None,
            account: "DU1".into(),
            contract_id: 265598,
            ticker: "AAPL".into(),
            side,
            order_type,
            qty: 10.0,
            filled: 0.0,
            limit,
            stop,
            avg_fill: None,
            status,
            tif: TimeInForce::GoodTillCanceled,
            outside_rth: false,
            message: None,
            mine: true,
            detached: false,
            updated_ms: order_id as f64,
        }
    }

    fn bracket(parent_status: OrderStatus) -> Tables {
        let mut t = Tables { account: Some("DU1".into()), accounts: vec!["DU1".into()], ..Default::default() };
        for r in [
            row("17:1", 1, 0, Side::Buy, OrderType::Limit, 100.0, parent_status),
            row("17:2", 2, 1, Side::Sell, OrderType::Limit, 120.0, OrderStatus::Working),
            row("17:3", 3, 1, Side::Sell, OrderType::Stop, 90.0, OrderStatus::Working),
        ] {
            t.orders.insert(r.key.clone(), r);
        }
        t
    }

    fn position(qty: f64) -> PosRow {
        PosRow { contract_id: 265598, ticker: "AAPL".into(), qty, avg_price: 100.0, last: Some(101.0), unrealized: Some(10.0), realized: None }
    }

    #[test]
    fn a_working_bracket_reports_its_legs_on_the_order() {
        let s = bracket(OrderStatus::Working).snapshot();
        assert_eq!(s.orders.len(), 1);
        let o = &s.orders[0];
        assert_eq!((o.id.as_str(), o.take_profit, o.stop_loss), ("17:1", Some(120.0), Some(90.0)));

        // A modification removed the stop loss: its cancelled leg is gone from the order.
        let mut t = bracket(OrderStatus::Working);
        t.orders.get_mut("17:3").unwrap().status = OrderStatus::Cancelled;
        let s = t.snapshot();
        assert_eq!(s.orders.len(), 1);
        assert_eq!((s.orders[0].take_profit, s.orders[0].stop_loss), (Some(120.0), None));
    }

    #[test]
    fn a_filled_bracket_protects_the_position() {
        let mut t = bracket(OrderStatus::Filled);
        t.positions.insert(265598, position(10.0));
        let s = t.snapshot();
        let p = &s.positions[0];
        assert_eq!((p.side, p.qty, p.take_profit, p.stop_loss), (Side::Buy, 10.0, Some(120.0), Some(90.0)));
        // The filled order stays in the history; its legs are on the position.
        assert_eq!(s.orders.iter().map(|o| o.id.as_str()).collect::<Vec<_>>(), ["17:1"]);
    }

    #[test]
    fn exits_left_by_a_closed_position_are_listed() {
        let s = bracket(OrderStatus::Filled).snapshot();
        let mut ids: Vec<&str> = s.orders.iter().map(|o| o.id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, ["17:1", "17:2", "17:3"]);
    }

    #[test]
    fn grouped_exits_protect_the_position_and_same_side_orders_do_not() {
        let mut t = Tables { account: Some("DU1".into()), ..Default::default() };
        t.positions.insert(265598, position(-10.0));
        let mut stop = row("17:8", 8, 0, Side::Buy, OrderType::Stop, 110.0, OrderStatus::Working);
        stop.oca_group = format!("{EXIT_GROUP}1");
        let add = row("17:9", 9, 0, Side::Sell, OrderType::Limit, 105.0, OrderStatus::Working);
        t.orders.insert(stop.key.clone(), stop);
        t.orders.insert(add.key.clone(), add);
        let s = t.snapshot();
        let p = &s.positions[0];
        assert_eq!((p.side, p.take_profit, p.stop_loss), (Side::Sell, None, Some(110.0)));
        assert_eq!(s.orders.iter().map(|o| o.id.as_str()).collect::<Vec<_>>(), ["17:9"]);
    }

    #[test]
    fn a_cancelled_bracket_lists_only_the_order() {
        let mut t = bracket(OrderStatus::Cancelled);
        for k in ["17:2", "17:3"] {
            t.orders.get_mut(k).unwrap().status = OrderStatus::Cancelled;
        }
        let s = t.snapshot();
        assert_eq!(s.orders.len(), 1);
        assert_eq!((s.orders[0].take_profit, s.orders[0].stop_loss), (Some(120.0), Some(90.0)));

        // A removed leg is not part of the order's history.
        t.orders.get_mut("17:3").unwrap().detached = true;
        assert_eq!(t.snapshot().orders[0].stop_loss, None);

        // A modification had replaced the take profit: the history shows the latest one.
        let newer = row("17:4", 4, 1, Side::Sell, OrderType::Limit, 125.0, OrderStatus::Cancelled);
        t.orders.insert(newer.key.clone(), newer);
        assert_eq!(t.snapshot().orders[0].take_profit, Some(125.0));
    }

    #[test]
    fn completed_legs_find_their_order_by_perm_id() {
        let mut t = Tables::default();
        let parent = OrdRow { perm_id: 500, ..row("p500", -1, 0, Side::Buy, OrderType::Limit, 100.0, OrderStatus::Cancelled) };
        let leg = OrdRow { parent_perm: 500, ..row("p501", -1, 0, Side::Sell, OrderType::Stop, 90.0, OrderStatus::Cancelled) };
        t.orders.insert(parent.key.clone(), parent);
        t.orders.insert(leg.key.clone(), leg);
        let s = t.snapshot();
        assert_eq!(s.orders.len(), 1);
        assert_eq!(s.orders[0].stop_loss, Some(90.0));
    }

    #[test]
    fn other_accounts_orders_are_left_out() {
        let mut t = bracket(OrderStatus::Working);
        let mut other = row("17:5", 5, 0, Side::Buy, OrderType::Limit, 1.0, OrderStatus::Working);
        other.account = "DU2".into();
        t.orders.insert(other.key.clone(), other);
        assert_eq!(t.snapshot().orders.len(), 1);
    }

    #[test]
    fn status_changes_notify() {
        let mut t = Tables::default();
        let placing = row("17:1", 1, 0, Side::Buy, OrderType::Limit, 1.0, OrderStatus::Placing);
        t.upsert_order(placing.clone());
        assert!(t.outbox.is_empty(), "a new row is no news");
        t.upsert_order(OrdRow { status: OrderStatus::Working, ..placing.clone() });
        t.update_status("17:1", 77, |o| o.status = OrderStatus::Cancelled);
        let kinds: Vec<String> = t.outbox.iter().map(|(_, v)| v["kind"].as_str().unwrap().to_string()).collect();
        assert_eq!(kinds, ["placed", "cancelled"]);
        assert_eq!(t.orders["17:1"].perm_id, 77);

        // A rejection a request waits on is its answer; otherwise a toast with the reason. It stays rejected.
        t.outbox.clear();
        t.upsert_order(OrdRow { key: "17:2".into(), order_id: 2, ..placing.clone() });
        t.awaiting.insert("17:2".into());
        t.reject("17:2", "No trading permissions");
        assert!(t.outbox.is_empty());
        t.upsert_order(OrdRow { key: "17:3".into(), order_id: 3, ..placing.clone() });
        t.reject("17:3", "Price too far");
        assert_eq!(t.outbox[0].1["kind"], "rejected");
        assert_eq!(t.outbox[0].1["message"], "Price too far");
        t.update_status("17:3", 0, |o| o.status = OrderStatus::Cancelled);
        assert_eq!(t.orders["17:3"].status, OrderStatus::Rejected);

        // Bracket legs are quiet.
        t.outbox.clear();
        let leg = row("17:4", 4, 1, Side::Sell, OrderType::Limit, 2.0, OrderStatus::Placing);
        t.upsert_order(leg.clone());
        t.upsert_order(OrdRow { status: OrderStatus::Working, ..leg });
        assert!(t.outbox.is_empty());
    }

    #[test]
    fn completed_orders_merge_by_perm_id() {
        let mut t = Tables::default();
        t.upsert_order(OrdRow { perm_id: 55, ..row("17:1", 1, 0, Side::Buy, OrderType::Limit, 1.0, OrderStatus::Working) });
        t.upsert_order(OrdRow { key: "p55".into(), order_id: 0, perm_id: 55, ..row("p55", 0, 0, Side::Buy, OrderType::Limit, 1.0, OrderStatus::Cancelled) });
        assert_eq!(t.orders.len(), 1);
        assert_eq!(t.orders["17:1"].status, OrderStatus::Cancelled);
    }

    #[test]
    fn the_account_reads_its_base_currency() {
        let mut t = Tables { account: Some("DU1".into()), ..Default::default() };
        for (k, c, v) in [
            ("NetLiquidation", "EUR", "1000.5"),
            ("TotalCashValue", "EUR", "400"),
            ("TotalCashValue", "USD", "1"),
            ("UnrealizedPnL", "BASE", "-3"),
            ("InitMarginReq", "EUR", "50"),
            ("AvailableFunds", "EUR", "950.5"),
            ("Cushion", "", "0.95"),
            ("DayTradesRemaining", "", "-1"),
        ] {
            t.values.insert((k.into(), c.into()), v.into());
        }
        t.pnl = (Some(12.0), None);
        let a = t.snapshot().account.unwrap();
        assert_eq!((a.currency.as_str(), a.is_demo), ("EUR", true));
        assert_eq!((a.equity, a.balance, a.unrealized_pnl, a.realized_pnl), (Some(1000.5), Some(400.0), Some(-3.0), Some(12.0)));
        assert_eq!((a.margin_used, a.margin_free), (Some(50.0), Some(950.5)));
        let v = |label: &str| a.values.iter().find(|r| r.label == label).map(|r| r.value.clone());
        assert_eq!(v("Cushion").as_deref(), Some("95.0%"));
        assert_eq!(v("Day trades left").as_deref(), Some("Unlimited"));
        assert_eq!(v("Available funds").as_deref(), Some("950.50"));
    }
}
