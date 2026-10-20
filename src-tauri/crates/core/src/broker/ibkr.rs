/*
 * Interactive Brokers through the user's IB Gateway / TWS (socket API).
 *
 * Per connection:
 *   • the order stream (orders, statuses, fills, commissions, order notices);
 *   • the account task: account values + portfolio rows of the selected
 *     account, its live P&L, and one P&L feed per position (live last price,
 *     market value and unrealized P&L);
 *   • the notice task: connection-level messages, socket reconnects (the
 *     client retries for ~7 min; subscriptions are then made again and the
 *     order lists read again, since events sent during the gap are lost).
 *
 * Requests that share an answer type (open / completed orders, executions)
 * run one at a time behind `lists`.
 */
use super::store::{now_ms, Store, Tables};
use super::symbols;
use super::types::*;
use crate::host::{Event, HostRef};
use futures_util::StreamExt;
use ibapi::accounts::types::{AccountId, ContractId};
use ibapi::accounts::{AccountUpdate, PnL, PnLSingle};
use ibapi::contracts::tick_types::TickType;
use ibapi::contracts::Contract;
use ibapi::market_data::realtime::TickTypes;
use ibapi::market_data::MarketDataType;
use ibapi::orders::{
    Action, ExecutionFilter, ExecutionSide, Executions, Order as IbOrder, OrderStatusKind, OrderUpdate, Orders,
    TimeInForce,
};
use ibapi::subscriptions::{NoticeStream, SubscriptionItem};
use ibapi::{Client, Error as IbError, Notice, NoticeCategory};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration as StdDuration;
use tokio::task::JoinHandle;

const BROKER_ID: &str = "ibkr";
const CONNECT_TIMEOUT: StdDuration = StdDuration::from_secs(10);
const LIST_TIMEOUT: StdDuration = StdDuration::from_secs(10);
const QUOTE_EVERY: StdDuration = StdDuration::from_millis(250);

/// A live connection.
struct Conn {
    client: Arc<Client>,
    generation: u64,
    client_id: i32,
    /// Account task (values, portfolio, P&L); replaced on account switch and
    /// after a socket reconnect.
    account_task: Mutex<Option<JoinHandle<()>>>,
    /// The other long-lived tasks (order stream, notices).
    tasks: Mutex<Vec<JoinHandle<()>>>,
    quote_task: Mutex<Option<JoinHandle<()>>>,
    /// Open / completed orders and executions share answer types.
    lists: tokio::sync::Mutex<()>,
}

impl Conn {
    fn abort_all(&self) {
        for t in self.tasks.lock().expect("broker tasks").drain(..) {
            t.abort();
        }
        if let Some(t) = self.account_task.lock().expect("broker account task").take() {
            t.abort();
        }
        if let Some(t) = self.quote_task.lock().expect("broker quote task").take() {
            t.abort();
        }
    }
}

/// A resolved stock contract and its price step.
#[derive(Clone)]
struct Resolved {
    contract: Contract,
    min_tick: Option<f64>,
}

#[derive(Default)]
pub struct Ibkr {
    pub store: Arc<Store>,
    conn: tokio::sync::Mutex<Option<Arc<Conn>>>,
    generation: AtomicU64,
    host: Mutex<Option<HostRef>>,
    /// App symbol → contract.
    contracts: Mutex<HashMap<String, Resolved>>,
    /// Contract id → contract, for the rows the broker reports (close a
    /// position, modify an order placed elsewhere).
    by_id: Mutex<HashMap<i32, Contract>>,
}

impl Ibkr {
    fn host(&self) -> Option<HostRef> {
        self.host.lock().expect("broker host").clone()
    }

    async fn current(&self) -> Result<Arc<Conn>, String> {
        self.conn.lock().await.clone().ok_or_else(|| "Not connected to the broker".to_string())
    }

    fn is_current(&self, generation: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == generation
    }

    pub async fn connect(self: &Arc<Self>, host: HostRef, config: BrokerConfig) -> Result<(), String> {
        *self.host.lock().expect("broker host") = Some(host.clone());
        self.store.ensure_emitter(host);
        let mut slot = self.conn.lock().await;
        if let Some(old) = slot.take() {
            close(&old).await;
        }
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.store.update(|t| {
            t.clear_account();
            t.broker = Some(BROKER_ID.into());
            t.connection = Some(ConnectionState::Connecting);
            t.config = Some(config.clone());
            t.error = None;
            t.accounts.clear();
            t.account = None;
        });

        let address = format!("{}:{}", config.host.trim(), config.port);
        let attempt = tokio::time::timeout(
            CONNECT_TIMEOUT,
            Client::builder().address(address.as_str()).client_id(config.client_id).connect_with_notice_stream(),
        )
        .await;
        let (client, notices) = match attempt {
            Ok(Ok(pair)) => pair,
            Ok(Err(e)) => return Err(self.fail(connect_error(&e, &address))),
            Err(_) => {
                return Err(self.fail(format!(
                    "No answer from {address}. Check that IB Gateway or TWS is running and logged in, and that its API is enabled."
                )))
            }
        };
        let client = Arc::new(client);
        let accounts = match client.managed_accounts().await {
            Ok(a) => a,
            Err(e) => {
                client.disconnect().await;
                return Err(self.fail(format!("The broker did not list the accounts: {e}")));
            }
        };
        // Real-time where the account has the market data, delayed elsewhere.
        let _ = client.switch_market_data_type(MarketDataType::Delayed).await;

        let conn = Arc::new(Conn {
            client: client.clone(),
            generation,
            client_id: config.client_id,
            account_task: Mutex::new(None),
            tasks: Mutex::new(Vec::new()),
            quote_task: Mutex::new(None),
            lists: tokio::sync::Mutex::new(()),
        });
        let account = accounts.first().cloned();
        self.store.update(|t| {
            t.connection = Some(ConnectionState::Connected);
            t.accounts = accounts.clone();
            t.account = account.clone();
        });
        *slot = Some(conn.clone());
        drop(slot);

        let orders = match client.order_update_stream().await {
            Ok(s) => s,
            Err(e) => {
                let msg = format!("The broker refused the order updates: {e}");
                self.disconnect().await;
                return Err(self.fail(msg));
            }
        };
        let me = self.clone();
        let c = conn.clone();
        let order_task = crate::rt::spawn(async move { me.run_orders(c, orders).await });
        let me = self.clone();
        let c = conn.clone();
        let notice_task = crate::rt::spawn(async move { me.run_notices(c, notices).await });
        conn.tasks.lock().expect("broker tasks").extend([order_task, notice_task]);

        if let Some(acct) = account {
            self.start_account(&conn, acct);
        }
        let me = self.clone();
        let c = conn.clone();
        crate::rt::spawn(async move { me.load_lists(&c).await });
        Ok(())
    }

    /// Record a failed connection attempt; returns the message.
    fn fail(&self, message: String) -> String {
        self.store.update(|t| {
            t.connection = Some(ConnectionState::Disconnected);
            t.error = Some(message.clone());
            t.accounts.clear();
            t.account = None;
            t.clear_account();
        });
        message
    }

    pub async fn disconnect(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Some(conn) = self.conn.lock().await.take() {
            close(&conn).await;
        }
        self.store.update(|t| {
            t.broker = None;
            t.connection = Some(ConnectionState::Disconnected);
            t.error = None;
            t.accounts.clear();
            t.account = None;
            t.clear_account();
        });
    }

    pub async fn select_account(self: &Arc<Self>, account: String) -> Result<(), String> {
        let conn = self.current().await?;
        let known = self.store.read(|t| t.accounts.contains(&account));
        if !known {
            return Err(format!("Unknown account {account}"));
        }
        self.store.update(|t| {
            t.account = Some(account.clone());
            t.summary = None;
            t.positions.clear();
        });
        self.start_account(&conn, account);
        Ok(())
    }

    // ── Account ────────────────────────────────────────────────────────────

    fn start_account(self: &Arc<Self>, conn: &Arc<Conn>, account: String) {
        let me = self.clone();
        let c = conn.clone();
        let task = crate::rt::spawn(async move { me.run_account(c, account).await });
        if let Some(old) = conn.account_task.lock().expect("broker account task").replace(task) {
            old.abort();
        }
    }

    async fn run_account(self: Arc<Self>, conn: Arc<Conn>, account: String) {
        let id = AccountId(account.clone());
        let mut updates = match conn.client.account_updates(&id).await {
            Ok(s) => s,
            Err(e) => return self.account_error(&conn, e),
        };
        let mut pnl = conn.client.pnl(&id, None).await.ok();
        // One P&L feed per held contract: the live last / value / unrealized.
        let mut singles: HashMap<i32, JoinHandle<()>> = HashMap::new();
        let mut values: HashMap<(String, String), String> = HashMap::new();
        // Realized / unrealized P&L from the P&L feed.
        let mut live: (Option<f64>, Option<f64>) = (None, None);
        loop {
            tokio::select! {
                item = updates.next() => match item {
                    Some(Ok(SubscriptionItem::Data(u))) => {
                        match u {
                            AccountUpdate::AccountValue(v) => {
                                values.insert((v.key.clone(), v.currency.clone()), v.value.clone());
                                let mut s = summarize(&account, &values);
                                // The P&L feed is live; the account values lag.
                                s.realized_pnl = live.0.or(s.realized_pnl);
                                s.unrealized_pnl = live.1.or(s.unrealized_pnl);
                                self.store.update(|t| t.summary = Some(s));
                            }
                            AccountUpdate::PortfolioValue(p) => {
                                let cid = p.contract.contract_id;
                                self.remember_contract(&p.contract);
                                if p.position == 0.0 {
                                    if let Some(h) = singles.remove(&cid) { h.abort(); }
                                    self.store.update(|t| { t.positions.remove(&cid); });
                                } else {
                                    let row = position_row(&account, &p.contract, p.position, p.average_cost,
                                        Some(p.market_price), Some(p.market_value), Some(p.unrealized_pnl), Some(p.realized_pnl));
                                    self.store.update(|t| {
                                        // Keep the live fields of the P&L feed.
                                        let row = merge_live(t.positions.get(&cid), row);
                                        t.positions.insert(cid, row);
                                    });
                                    singles.entry(cid).or_insert_with(|| {
                                        let me = self.clone();
                                        let c = conn.clone();
                                        let a = account.clone();
                                        crate::rt::spawn(async move { me.run_pnl_single(c, a, cid).await })
                                    });
                                }
                                self.ensure_symbols(&conn);
                            }
                            AccountUpdate::UpdateTime(_) | AccountUpdate::End => {}
                        }
                    }
                    Some(Ok(SubscriptionItem::Notice(n))) => self.log_notice(&n),
                    Some(Err(e)) => { for (_, h) in singles.drain() { h.abort(); } return self.account_error(&conn, e); }
                    None => break,
                },
                item = next_pnl(&mut pnl) => match item {
                    Some(Ok(SubscriptionItem::Data(PnL { realized_pnl, unrealized_pnl, .. }))) => {
                        // Unset fields come as f64::MAX.
                        let ok = |v: Option<f64>| v.filter(|x| x.is_finite() && x.abs() < 1e300);
                        live = (ok(realized_pnl).or(live.0), ok(unrealized_pnl).or(live.1));
                        self.store.update(|t| {
                            let s = t.summary.get_or_insert_with(|| AccountSummary { account: account.clone(), ..Default::default() });
                            s.realized_pnl = live.0.or(s.realized_pnl);
                            s.unrealized_pnl = live.1.or(s.unrealized_pnl);
                        });
                    }
                    Some(Ok(SubscriptionItem::Notice(_))) => {}
                    Some(Err(_)) | None => pnl = None,
                },
            }
        }
        for (_, h) in singles.drain() {
            h.abort();
        }
    }

    async fn run_pnl_single(self: Arc<Self>, conn: Arc<Conn>, account: String, cid: i32) {
        let Ok(mut sub) = conn.client.pnl_single(&AccountId(account), ContractId(cid), None).await else { return };
        while let Some(item) = sub.next().await {
            let Ok(SubscriptionItem::Data(PnLSingle { position, unrealized_pnl, realized_pnl, value, .. })) = item else {
                if item.is_err() { return; }
                continue;
            };
            // Unset fields come as f64::MAX.
            let ok = |v: f64| (v.is_finite() && v.abs() < 1e300).then_some(v);
            self.store.update(|t| {
                if let Some(p) = t.positions.get_mut(&cid) {
                    if let Some(v) = ok(value) {
                        p.market_value = Some(v);
                        if position != 0.0 {
                            p.last = Some((v / position).abs());
                        }
                    }
                    if let Some(u) = ok(unrealized_pnl) { p.unrealized_pnl = Some(u); }
                    if let Some(r) = ok(realized_pnl) { p.realized_pnl = Some(r); }
                }
            });
        }
    }

    fn account_error(&self, conn: &Arc<Conn>, e: IbError) {
        if !self.is_current(conn.generation) {
            return;
        }
        if e.is_connection_lost() {
            self.store.update(|t| t.connection = Some(ConnectionState::Reconnecting));
        } else {
            self.store.update(|t| t.notice(NoticeLevel::Error, 0, format!("Account updates stopped: {e}"), None));
        }
    }

    // ── Orders ─────────────────────────────────────────────────────────────

    /// Read the open and completed orders and the week's executions.
    async fn load_lists(self: &Arc<Self>, conn: &Arc<Conn>) {
        let _guard = conn.lists.lock().await;
        if let Ok(mut sub) = conn.client.all_open_orders().await {
            if let Ok(items) = sub.collect_to_end_within(LIST_TIMEOUT).await {
                for item in items {
                    self.apply_orders_item(conn, item);
                }
            }
        }
        if let Ok(mut sub) = conn.client.completed_orders(false).await {
            if let Ok(items) = sub.collect_to_end_within(LIST_TIMEOUT).await {
                for item in items {
                    self.apply_orders_item(conn, item);
                }
            }
        }
        let filter = ExecutionFilter { last_n_days: 7, ..Default::default() };
        if let Ok(mut sub) = conn.client.executions(filter).await {
            if let Ok(items) = sub.collect_to_end_within(LIST_TIMEOUT).await {
                self.store.update(|t| {
                    for item in items {
                        match item {
                            Executions::ExecutionData(d) => apply_execution(t, &d.contract, &d.execution),
                            Executions::CommissionReport(c) => apply_commission(t, &c.execution_id, c.commission, c.realized_pnl),
                        }
                    }
                    t.trim_executions();
                });
            }
        }
        self.ensure_symbols(conn);
    }

    fn apply_orders_item(&self, conn: &Conn, item: Orders) {
        match item {
            Orders::OrderData(d) => {
                self.remember_contract(&d.contract);
                let msg = non_empty(&d.order_state.reject_reason).or_else(|| non_empty(&d.order_state.warning_text));
                let status = d.order_state.status.clone();
                self.store.update(|t| upsert_order(t, conn.client_id, &d.contract, &d.order, d.order_id, &status, msg));
            }
            Orders::OrderStatus(s) => self.store.update(|t| apply_status(t, &s)),
        }
    }

    async fn run_orders(self: Arc<Self>, conn: Arc<Conn>, mut stream: ibapi::subscriptions::Subscription<OrderUpdate>) {
        loop {
            while let Some(item) = stream.next().await {
                match item {
                    Ok(SubscriptionItem::Data(u)) => match u {
                        OrderUpdate::OpenOrder(d) => {
                            self.remember_contract(&d.contract);
                            let msg = non_empty(&d.order_state.reject_reason).or_else(|| non_empty(&d.order_state.warning_text));
                            let status = d.order_state.status.clone();
                            self.store.update(|t| upsert_order(t, conn.client_id, &d.contract, &d.order, d.order_id, &status, msg));
                            self.ensure_symbols(&conn);
                        }
                        OrderUpdate::OrderStatus(s) => self.store.update(|t| apply_status(t, &s)),
                        OrderUpdate::ExecutionData(d) => self.store.update(|t| {
                            apply_execution(t, &d.contract, &d.execution);
                            t.trim_executions();
                        }),
                        OrderUpdate::CommissionReport(c) => {
                            self.store.update(|t| apply_commission(t, &c.execution_id, c.commission, c.realized_pnl))
                        }
                        OrderUpdate::OrderBound(_) => {}
                    },
                    Ok(SubscriptionItem::Notice(n)) => self.order_notice(&conn, &n),
                    Err(e) => {
                        if !self.is_current(conn.generation) {
                            return;
                        }
                        eprintln!("[broker] order stream ended: {e}");
                        break;
                    }
                }
            }
            if !self.is_current(conn.generation) {
                return;
            }
            // The stream ended: ask again (it survives socket reconnects, so
            // this is rare), then read the lists again.
            tokio::time::sleep(StdDuration::from_secs(2)).await;
            match conn.client.order_update_stream().await {
                Ok(s) => {
                    stream = s;
                    self.load_lists(&conn).await;
                }
                Err(_) if !conn.client.is_connected() => continue,
                Err(e) => {
                    self.store.update(|t| t.notice(NoticeLevel::Error, 0, format!("Order updates stopped: {e}"), None));
                    return;
                }
            }
        }
    }

    fn order_notice(&self, conn: &Conn, n: &Notice) {
        let order_id = n.request_id;
        let key = order_id.map(|id| order_key(conn.client_id, id, 0));
        let message = n.message.clone();
        let level = match n.category() {
            NoticeCategory::OrderRejection | NoticeCategory::Error | NoticeCategory::RequestError => NoticeLevel::Error,
            NoticeCategory::Warning => NoticeLevel::Warning,
            _ => NoticeLevel::Info,
        };
        let rejected = matches!(n.category(), NoticeCategory::OrderRejection);
        self.store.update(|t| {
            if let Some(o) = key.as_ref().and_then(|k| t.orders.get_mut(k)) {
                if level != NoticeLevel::Info {
                    o.message = Some(message.clone());
                }
                if rejected && !matches!(o.status, OrderStatus::Filled) {
                    o.status = OrderStatus::Rejected;
                }
                o.updated_ms = now_ms();
            }
            t.notice(level, n.code, message, order_id);
        });
    }

    // ── Notices / connection ───────────────────────────────────────────────

    async fn run_notices(self: Arc<Self>, conn: Arc<Conn>, mut notices: NoticeStream) {
        while let Some(n) = notices.next().await {
            if !self.is_current(conn.generation) {
                return;
            }
            if n.code == ibapi::TRANSPORT_RECONNECT_CODE {
                // The socket is back: subscriptions are gone, events of the
                // gap are lost.
                self.store.update(|t| {
                    t.connection = Some(ConnectionState::Connected);
                    t.notice(NoticeLevel::Info, n.code, "Connection to the gateway restored".into(), None);
                });
                let _ = conn.client.switch_market_data_type(MarketDataType::Delayed).await;
                if let Some(acct) = self.store.read(|t| t.account.clone()) {
                    self.start_account(&conn, acct);
                }
                self.load_lists(&conn).await;
                continue;
            }
            if n.connectivity_status().is_some() || n.is_data_advisory() {
                // Farm status chatter (2104 / 2106 / 2158 ...).
                continue;
            }
            self.log_notice(&n);
        }
        // The client gave up reconnecting.
        if self.is_current(conn.generation) {
            let mut slot = self.conn.lock().await;
            if slot.as_ref().is_some_and(|c| c.generation == conn.generation) {
                slot.take();
            }
            drop(slot);
            conn.abort_all();
            self.store.update(|t| {
                t.connection = Some(ConnectionState::Disconnected);
                t.error = Some("The connection to the gateway was lost".into());
                t.clear_account();
            });
        }
    }

    fn log_notice(&self, n: &Notice) {
        let level = match n.category() {
            NoticeCategory::Error | NoticeCategory::RequestError | NoticeCategory::OrderRejection => NoticeLevel::Error,
            NoticeCategory::Warning | NoticeCategory::SystemMessage => NoticeLevel::Warning,
            _ => NoticeLevel::Info,
        };
        self.store.update(|t| t.notice(level, n.code, n.message.clone(), None));
    }

    // ── Contracts ──────────────────────────────────────────────────────────

    fn remember_contract(&self, c: &Contract) {
        if c.contract_id != 0 {
            self.by_id.lock().expect("broker contracts").insert(c.contract_id, c.clone());
        }
    }

    /// The contract of an app symbol ("NASDAQ:AAPL").
    async fn resolve(&self, conn: &Conn, symbol: &str) -> Result<Resolved, String> {
        if let Some(r) = self.contracts.lock().expect("broker contracts").get(symbol) {
            return Ok(r.clone());
        }
        let (ex, ticker) = symbols::split(symbol);
        let wanted = ex.map(symbols::broker_exchanges).unwrap_or(&[]);
        let query = Contract::stock(symbols::broker_ticker(ticker)).build();
        let details = conn
            .client
            .contract_details(&query)
            .await
            .map_err(|e| format!("{ticker}: the broker has no stock of that name ({e})"))?;
        let pick = details
            .iter()
            .find(|d| wanted.iter().any(|w| d.contract.primary_exchange.as_str().eq_ignore_ascii_case(w)))
            .or_else(|| if wanted.is_empty() || details.len() == 1 { details.first() } else { None })
            .ok_or_else(|| format!("{ticker}: the broker lists no stock of that name on {}", ex.unwrap_or("this exchange")))?;
        let mut contract = pick.contract.clone();
        contract.exchange = "SMART".into();
        let r = Resolved { contract, min_tick: (pick.min_tick > 0.0).then_some(pick.min_tick) };
        self.remember_contract(&r.contract);
        self.contracts.lock().expect("broker contracts").insert(symbol.to_string(), r.clone());
        Ok(r)
    }

    /// The contract of a reported row (by contract id), routed SMART.
    fn row_contract(&self, cid: i32) -> Contract {
        let mut c = self
            .by_id
            .lock()
            .expect("broker contracts")
            .get(&cid)
            .cloned()
            .unwrap_or_else(|| Contract { contract_id: cid, ..Default::default() });
        c.exchange = "SMART".into();
        c
    }

    /// Rows whose listing exchange the broker left out get it from the
    /// contract details (once per contract).
    fn ensure_symbols(self: &Arc<Self>, conn: &Arc<Conn>) {
        let missing: HashSet<i32> = self.store.read(|t| {
            t.positions
                .values()
                .filter(|p| !p.symbol.contains(':'))
                .map(|p| p.contract_id)
                .chain(t.orders.values().filter(|o| !o.symbol.contains(':')).map(|o| o.contract_id))
                .filter(|c| *c != 0)
                .collect()
        });
        if missing.is_empty() {
            return;
        }
        let me = self.clone();
        let c = conn.clone();
        crate::rt::spawn(async move {
            for cid in missing {
                let known = me.by_id.lock().expect("broker contracts").get(&cid).cloned();
                let primary = match known.as_ref().map(|k| k.primary_exchange.as_str().to_string()).filter(|p| !p.is_empty()) {
                    Some(p) => p,
                    None => {
                        let q = Contract { contract_id: cid, ..Default::default() };
                        match c.client.contract_details(&q).await {
                            Ok(d) if !d.is_empty() => {
                                me.remember_contract(&d[0].contract);
                                d[0].contract.primary_exchange.as_str().to_string()
                            }
                            _ => continue,
                        }
                    }
                };
                let Some(ex) = symbols::app_exchange(&primary) else { continue };
                me.store.update(|t| {
                    for p in t.positions.values_mut().filter(|p| p.contract_id == cid) {
                        p.symbol = format!("{ex}:{}", p.ticker);
                    }
                    for o in t.orders.values_mut().filter(|o| o.contract_id == cid) {
                        o.symbol = format!("{ex}:{}", o.ticker);
                    }
                    let ticker = t.positions.get(&cid).map(|p| p.ticker.clone())
                        .or_else(|| t.orders.values().find(|o| o.contract_id == cid).map(|o| o.ticker.clone()));
                    if let Some(ticker) = ticker {
                        for e in t.executions.values_mut().filter(|e| !e.symbol.contains(':') && e.ticker == ticker) {
                            e.symbol = format!("{ex}:{ticker}");
                        }
                    }
                });
            }
        });
    }

    // ── Trading ────────────────────────────────────────────────────────────

    pub async fn place_order(&self, ticket: OrderTicket) -> Result<String, String> {
        let conn = self.current().await?;
        validate(&ticket)?;
        let account = self.store.read(|t| t.account.clone()).unwrap_or_default();
        let r = self.resolve(&conn, &ticket.symbol).await?;
        let bracket = ticket.take_profit.is_some() || ticket.stop_loss.is_some();
        let parent_id = conn.client.next_order_id();
        let mut parent = build_order(&ticket, &account);
        parent.order_id = parent_id;
        parent.transmit = !bracket;
        let mut legs = vec![parent];
        if bracket {
            let exit = match ticket.side {
                Side::Buy => Action::Sell,
                Side::Sell => Action::Buy,
            };
            let child = |order_type: &str, limit: Option<f64>, stop: Option<f64>| IbOrder {
                order_id: conn.client.next_order_id(),
                action: exit,
                total_quantity: ticket.qty,
                order_type: order_type.into(),
                limit_price: limit,
                aux_price: stop,
                parent_id,
                tif: TimeInForce::GoodTillCanceled,
                outside_rth: ticket.outside_rth,
                account: account.clone(),
                transmit: false,
                ..Default::default()
            };
            if let Some(tp) = ticket.take_profit {
                legs.push(child("LMT", Some(tp), None));
            }
            if let Some(sl) = ticket.stop_loss {
                legs.push(child("STP", None, Some(sl)));
            }
            if let Some(last) = legs.last_mut() {
                last.transmit = true;
            }
        }
        let symbol = ticket.symbol.clone();
        for o in &legs {
            self.store.update(|t| {
                let key = order_key(conn.client_id, o.order_id, 0);
                t.orders.insert(key.clone(), placing_row(key, conn.client_id, &symbol, &r.contract, o));
            });
        }
        for o in &legs {
            if let Err(e) = conn.client.submit_order(o.order_id, &r.contract, o).await {
                let msg = format!("The order was not sent: {e}");
                self.store.update(|t| {
                    for l in &legs {
                        if let Some(row) = t.orders.get_mut(&order_key(conn.client_id, l.order_id, 0)) {
                            row.status = OrderStatus::Rejected;
                            row.message = Some(msg.clone());
                        }
                    }
                });
                return Err(msg);
            }
        }
        Ok(order_key(conn.client_id, parent_id, 0))
    }

    pub async fn modify_order(&self, id: &str, ticket: OrderTicket) -> Result<(), String> {
        let conn = self.current().await?;
        validate(&ticket)?;
        let row = self.store.read(|t| t.orders.get(id).cloned()).ok_or("The order is gone")?;
        if !row.modifiable || !is_active(row.status) {
            return Err("This order can't be modified".into());
        }
        let mut o = build_order(&ticket, &row.account);
        o.order_id = row.order_id;
        o.parent_id = row.parent_id.unwrap_or(0);
        let contract = self.row_contract(row.contract_id);
        conn.client.submit_order(row.order_id, &contract, &o).await.map_err(|e| format!("The change was not sent: {e}"))?;
        self.store.update(|t| {
            if let Some(r) = t.orders.get_mut(id) {
                r.qty = ticket.qty;
                r.limit_price = o.limit_price;
                r.stop_price = o.aux_price;
                r.message = None;
                r.updated_ms = now_ms();
            }
        });
        Ok(())
    }

    pub async fn cancel_order(&self, id: &str) -> Result<(), String> {
        let conn = self.current().await?;
        let row = self.store.read(|t| t.orders.get(id).cloned()).ok_or("The order is gone")?;
        if !row.modifiable {
            return Err("This order was placed elsewhere and can't be cancelled from here".into());
        }
        let sub = conn.client.cancel_order(row.order_id, "").await.map_err(|e| format!("The cancel was not sent: {e}"))?;
        // The outcome comes through the order stream; drain this one briefly.
        crate::rt::spawn(async move {
            let mut sub = sub;
            let _ = tokio::time::timeout(StdDuration::from_secs(5), async { while sub.next().await.is_some() {} }).await;
        });
        Ok(())
    }

    pub async fn close_position(&self, id: &str) -> Result<(), String> {
        let conn = self.current().await?;
        let cid: i32 = id.parse().map_err(|_| "Unknown position")?;
        let p = self.store.read(|t| t.positions.get(&cid).cloned()).ok_or("The position is gone")?;
        let contract = self.row_contract(cid);
        let order = IbOrder {
            order_id: conn.client.next_order_id(),
            action: match p.side {
                Side::Buy => Action::Sell,
                Side::Sell => Action::Buy,
            },
            total_quantity: p.qty,
            order_type: "MKT".into(),
            account: p.account.clone(),
            transmit: true,
            ..Default::default()
        };
        self.store.update(|t| {
            let key = order_key(conn.client_id, order.order_id, 0);
            t.orders.insert(key.clone(), placing_row(key, conn.client_id, &p.symbol, &contract, &order));
        });
        conn.client.submit_order(order.order_id, &contract, &order).await.map_err(|e| format!("The order was not sent: {e}"))
    }

    // ── Order ticket quote ─────────────────────────────────────────────────

    pub async fn watch_quote(&self, symbol: Option<String>) -> Result<(), String> {
        let conn = self.current().await?;
        if let Some(t) = conn.quote_task.lock().expect("broker quote task").take() {
            t.abort();
        }
        let Some(symbol) = symbol else { return Ok(()) };
        let r = self.resolve(&conn, &symbol).await?;
        let host = self.host().ok_or("No view to send the quote to")?;
        let client = conn.client.clone();
        let task = crate::rt::spawn(async move {
            let Ok(mut sub) = client.market_data(&r.contract).subscribe().await else { return };
            let mut q = BrokerQuote { symbol, min_tick: r.min_tick, ..Default::default() };
            let mut last_emit = tokio::time::Instant::now() - QUOTE_EVERY;
            let mut pending = false;
            loop {
                let wait = tokio::time::sleep_until(last_emit + QUOTE_EVERY);
                tokio::select! {
                    item = sub.next() => match item {
                        Some(Ok(SubscriptionItem::Data(tick))) => { pending |= apply_tick(&mut q, &tick); }
                        Some(Ok(SubscriptionItem::Notice(n))) => { if n.code == 10167 { q.delayed = true; pending = true; } }
                        Some(Err(_)) | None => return,
                    },
                    _ = wait, if pending => {
                        let _ = q.emit(&host);
                        pending = false;
                        last_emit = tokio::time::Instant::now();
                    }
                }
            }
        });
        *conn.quote_task.lock().expect("broker quote task") = Some(task);
        Ok(())
    }
}

async fn close(conn: &Conn) {
    conn.abort_all();
    conn.client.disconnect().await;
}

async fn next_pnl(
    sub: &mut Option<ibapi::subscriptions::Subscription<PnL>>,
) -> Option<Result<SubscriptionItem<PnL>, IbError>> {
    match sub {
        Some(s) => s.next().await,
        None => std::future::pending().await,
    }
}

fn connect_error(e: &IbError, address: &str) -> String {
    match e {
        IbError::Io(_) | IbError::ConnectionFailed => format!(
            "Can't reach IB Gateway or TWS at {address}. Start it, log in, and enable the API on this port."
        ),
        IbError::ConnectionRejected(m) => format!("The gateway refused the connection: {m}"),
        IbError::ServerVersion(..) => {
            "This IB Gateway / TWS is too old. Install version 10.40 or newer.".to_string()
        }
        IbError::Notice(n) if n.code == 326 => {
            format!("Client ID already in use on {address}. Pick another client ID.")
        }
        other => format!("Connection to {address} failed: {other}"),
    }
}

fn non_empty(s: &str) -> Option<String> {
    let s = s.trim();
    (!s.is_empty()).then(|| s.to_string())
}

fn validate(t: &OrderTicket) -> Result<(), String> {
    if !(t.qty.is_finite() && t.qty > 0.0) {
        return Err("Quantity must be above 0".into());
    }
    let price = |p: Option<f64>, what: &str| match p {
        Some(v) if v.is_finite() && v > 0.0 => Ok(()),
        _ => Err(format!("{what} price is missing")),
    };
    match t.order_type {
        OrderType::Market => {}
        OrderType::Limit => price(t.limit_price, "Limit")?,
        OrderType::Stop => price(t.stop_price, "Stop")?,
        OrderType::StopLimit => {
            price(t.stop_price, "Stop")?;
            price(t.limit_price, "Limit")?;
        }
    }
    for (p, what) in [(t.take_profit, "Take profit"), (t.stop_loss, "Stop loss")] {
        if let Some(v) = p {
            if !(v.is_finite() && v > 0.0) {
                return Err(format!("{what} price is invalid"));
            }
        }
    }
    Ok(())
}

fn build_order(t: &OrderTicket, account: &str) -> IbOrder {
    let (order_type, limit, stop) = match t.order_type {
        OrderType::Market => ("MKT", None, None),
        OrderType::Limit => ("LMT", t.limit_price, None),
        OrderType::Stop => ("STP", None, t.stop_price),
        OrderType::StopLimit => ("STP LMT", t.limit_price, t.stop_price),
    };
    IbOrder {
        action: match t.side {
            Side::Buy => Action::Buy,
            Side::Sell => Action::Sell,
        },
        total_quantity: t.qty,
        order_type: order_type.into(),
        limit_price: limit,
        aux_price: stop,
        tif: match t.duration {
            Duration::Day => TimeInForce::Day,
            Duration::Gtc => TimeInForce::GoodTillCanceled,
        },
        outside_rth: t.outside_rth,
        account: account.to_string(),
        transmit: true,
        ..Default::default()
    }
}

/// Row id of an order: "<client>:<order id>", or "p<perm id>" for orders
/// placed outside the API (order id 0).
fn order_key(client_id: i32, order_id: i32, perm_id: i64) -> String {
    if order_id == 0 && perm_id != 0 {
        format!("p{perm_id}")
    } else {
        format!("{client_id}:{order_id}")
    }
}

fn status_of(kind: &OrderStatusKind) -> OrderStatus {
    match kind {
        OrderStatusKind::ApiPending | OrderStatusKind::PendingSubmit => OrderStatus::Placing,
        OrderStatusKind::PreSubmitted | OrderStatusKind::Submitted | OrderStatusKind::PendingCancel => {
            OrderStatus::Working
        }
        OrderStatusKind::ApiCancelled | OrderStatusKind::Cancelled => OrderStatus::Cancelled,
        OrderStatusKind::Filled => OrderStatus::Filled,
        OrderStatusKind::Inactive => OrderStatus::Inactive,
        _ => OrderStatus::Working,
    }
}

fn is_active(s: OrderStatus) -> bool {
    matches!(s, OrderStatus::Placing | OrderStatus::Working | OrderStatus::Inactive)
}

fn type_of(raw: &str) -> OrderType {
    match raw.trim().to_ascii_uppercase().as_str() {
        "LMT" => OrderType::Limit,
        "STP" => OrderType::Stop,
        "STP LMT" => OrderType::StopLimit,
        _ => OrderType::Market,
    }
}

fn side_of(a: &Action) -> Side {
    match a {
        Action::Buy => Side::Buy,
        _ => Side::Sell,
    }
}

fn tif_word(t: &TimeInForce) -> String {
    match t {
        TimeInForce::Day => "DAY".into(),
        TimeInForce::GoodTillCanceled => "GTC".into(),
        other => other.as_str().to_string(),
    }
}

fn positive(v: Option<f64>) -> Option<f64> {
    v.filter(|p| p.is_finite() && *p > 0.0 && *p < 1e300)
}

fn placing_row(key: String, client_id: i32, symbol: &str, c: &Contract, o: &IbOrder) -> Order {
    let (_, ticker) = symbols::split(symbol);
    Order {
        id: key,
        order_id: o.order_id,
        perm_id: 0.0,
        client_id,
        parent_id: (o.parent_id != 0).then_some(o.parent_id),
        account: o.account.clone(),
        symbol: symbol.to_string(),
        ticker: ticker.to_string(),
        contract_id: c.contract_id,
        side: side_of(&o.action),
        order_type: type_of(&o.order_type),
        raw_type: o.order_type.clone(),
        qty: o.total_quantity,
        filled_qty: 0.0,
        limit_price: positive(o.limit_price),
        stop_price: positive(o.aux_price),
        avg_fill_price: None,
        duration: tif_word(&o.tif),
        outside_rth: o.outside_rth,
        status: OrderStatus::Placing,
        raw_status: "PendingSubmit".into(),
        message: None,
        modifiable: true,
        updated_ms: now_ms(),
    }
}

fn upsert_order(
    t: &mut Tables,
    my_client: i32,
    c: &Contract,
    o: &IbOrder,
    order_id: i32,
    status: &OrderStatusKind,
    message: Option<String>,
) {
    let key = order_key(o.client_id, order_id, o.perm_id);
    let ticker = symbols::app_ticker(c.symbol.as_str());
    let symbol = symbols::app_symbol(c.symbol.as_str(), c.primary_exchange.as_str());
    let prev = t.orders.get(&key);
    let mut st = status_of(status);
    // A rejection seen on the order stream stays.
    if prev.is_some_and(|p| p.status == OrderStatus::Rejected) && st != OrderStatus::Filled {
        st = OrderStatus::Rejected;
    }
    let row = Order {
        id: key.clone(),
        order_id,
        perm_id: o.perm_id as f64,
        client_id: o.client_id,
        parent_id: (o.parent_id != 0).then_some(o.parent_id),
        account: o.account.clone(),
        symbol: if symbol.contains(':') { symbol } else { prev.map(|p| p.symbol.clone()).unwrap_or(symbol) },
        ticker,
        contract_id: c.contract_id,
        side: side_of(&o.action),
        order_type: type_of(&o.order_type),
        raw_type: o.order_type.clone(),
        qty: o.total_quantity,
        filled_qty: prev.map(|p| p.filled_qty).unwrap_or(o.filled_quantity.max(0.0)),
        limit_price: positive(o.limit_price),
        stop_price: positive(o.aux_price),
        avg_fill_price: prev.and_then(|p| p.avg_fill_price),
        duration: tif_word(&o.tif),
        outside_rth: o.outside_rth,
        status: st,
        raw_status: status.as_str().to_string(),
        message: message.or_else(|| prev.and_then(|p| p.message.clone())),
        modifiable: o.client_id == my_client && order_id != 0,
        updated_ms: now_ms(),
    };
    t.orders.insert(key, row);
}

fn apply_status(t: &mut Tables, s: &ibapi::orders::OrderStatus) {
    let key = order_key(s.client_id, s.order_id, s.perm_id);
    if let Some(o) = t.orders.get_mut(&key) {
        let st = status_of(&s.status);
        if !(o.status == OrderStatus::Rejected && st != OrderStatus::Filled) {
            o.status = st;
        }
        o.raw_status = s.status.as_str().to_string();
        o.filled_qty = s.filled;
        if s.perm_id != 0 {
            o.perm_id = s.perm_id as f64;
        }
        o.avg_fill_price = positive(s.average_fill_price).or(o.avg_fill_price);
        o.updated_ms = now_ms();
    }
}

fn apply_execution(t: &mut Tables, c: &Contract, e: &ibapi::orders::Execution) {
    let ticker = symbols::app_ticker(c.symbol.as_str());
    let symbol = symbols::app_symbol(c.symbol.as_str(), c.primary_exchange.as_str());
    let prev = t.executions.get(&e.execution_id);
    let row = Execution {
        id: e.execution_id.clone(),
        order_id: e.order_id,
        account: e.account_number.clone(),
        symbol,
        ticker,
        side: match e.side {
            ExecutionSide::Bought => Side::Buy,
            ExecutionSide::Sold => Side::Sell,
        },
        qty: e.shares,
        price: e.price,
        time_ms: parse_time(&e.time).unwrap_or_else(now_ms),
        commission: prev.and_then(|p| p.commission),
        realized_pnl: prev.and_then(|p| p.realized_pnl),
        exchange: e.exchange.clone(),
    };
    t.executions.insert(row.id.clone(), row);
}

fn apply_commission(t: &mut Tables, exec_id: &str, commission: f64, realized: Option<f64>) {
    let row = t.executions.entry(exec_id.to_string()).or_insert_with(|| Execution {
        id: exec_id.to_string(),
        order_id: 0,
        account: String::new(),
        symbol: String::new(),
        ticker: String::new(),
        side: Side::Buy,
        qty: 0.0,
        price: 0.0,
        time_ms: now_ms(),
        commission: None,
        realized_pnl: None,
        exchange: String::new(),
    });
    row.commission = (commission.is_finite() && commission.abs() < 1e300).then_some(commission);
    row.realized_pnl = realized.filter(|v| v.is_finite() && v.abs() < 1e300);
}

#[allow(clippy::too_many_arguments)]
fn position_row(
    account: &str,
    c: &Contract,
    position: f64,
    average_cost: f64,
    last: Option<f64>,
    value: Option<f64>,
    unrealized: Option<f64>,
    realized: Option<f64>,
) -> Position {
    let mult: f64 = c.multiplier.parse().ok().filter(|m: &f64| *m > 0.0).unwrap_or(1.0);
    let finite = |v: Option<f64>| v.filter(|x| x.is_finite() && x.abs() < 1e300);
    Position {
        id: c.contract_id.to_string(),
        account: account.to_string(),
        symbol: symbols::app_symbol(c.symbol.as_str(), c.primary_exchange.as_str()),
        ticker: symbols::app_ticker(c.symbol.as_str()),
        contract_id: c.contract_id,
        currency: c.currency.as_str().to_string(),
        side: if position >= 0.0 { Side::Buy } else { Side::Sell },
        qty: position.abs(),
        avg_price: average_cost / mult,
        last: finite(last).filter(|v| *v > 0.0),
        market_value: finite(value),
        unrealized_pnl: finite(unrealized),
        realized_pnl: finite(realized),
    }
}

/// A fresh portfolio row keeps the live fields the P&L feed set, and the
/// listing exchange found earlier.
fn merge_live(prev: Option<&Position>, mut row: Position) -> Position {
    if let Some(p) = prev {
        if !row.symbol.contains(':') && p.symbol.contains(':') {
            row.symbol = p.symbol.clone();
        }
        row.last = p.last.or(row.last);
        row.market_value = p.market_value.or(row.market_value);
        row.unrealized_pnl = p.unrealized_pnl.or(row.unrealized_pnl);
    }
    row
}

fn summarize(account: &str, values: &HashMap<(String, String), String>) -> AccountSummary {
    // Values come per currency; the account's base currency is what
    // "NetLiquidation" is reported in.
    let base = values
        .keys()
        .find(|(k, _)| k == "NetLiquidation")
        .map(|(_, c)| c.clone())
        .unwrap_or_else(|| "USD".into());
    let num = |key: &str| -> Option<f64> {
        values
            .get(&(key.to_string(), base.clone()))
            .or_else(|| values.get(&(key.to_string(), "BASE".to_string())))
            .and_then(|v| v.parse::<f64>().ok())
    };
    let mut list: Vec<AccountValue> = values
        .iter()
        .filter(|((_, c), _)| c == &base || c.is_empty())
        .map(|((k, c), v)| AccountValue { key: k.clone(), value: v.clone(), currency: c.clone() })
        .collect();
    list.sort_by(|a, b| a.key.cmp(&b.key));
    AccountSummary {
        account: account.to_string(),
        currency: base.clone(),
        balance: num("TotalCashValue"),
        equity: num("NetLiquidation"),
        realized_pnl: num("RealizedPnL"),
        unrealized_pnl: num("UnrealizedPnL"),
        account_margin: num("InitMarginReq"),
        available_funds: num("AvailableFunds"),
        buying_power: num("BuyingPower"),
        maintenance_margin: num("MaintMarginReq"),
        excess_liquidity: num("ExcessLiquidity"),
        values: list,
    }
}

/// Fold a tick into the quote; true when bid / ask / last changed.
fn apply_tick(q: &mut BrokerQuote, tick: &TickTypes) -> bool {
    let mut set = |tt: &TickType, price: f64| -> bool {
        let p = (price.is_finite() && price > 0.0).then_some(price);
        let delayed = matches!(tt, TickType::DelayedBid | TickType::DelayedAsk | TickType::DelayedLast);
        let slot = match tt {
            TickType::Bid | TickType::DelayedBid => &mut q.bid,
            TickType::Ask | TickType::DelayedAsk => &mut q.ask,
            TickType::Last | TickType::DelayedLast => &mut q.last,
            _ => return false,
        };
        if p.is_none() {
            return false;
        }
        *slot = p;
        q.delayed = delayed;
        true
    };
    match tick {
        TickTypes::Price(t) => set(&t.tick_type, t.price),
        TickTypes::PriceSize(t) => set(&t.price_tick_type, t.price),
        TickTypes::MarketDataType(t) => {
            q.delayed = !matches!(t, MarketDataType::Realtime);
            true
        }
        _ => false,
    }
}

/// Execution times: "20261020 10:31:05 US/Eastern", "20261020-14:31:05"
/// (UTC) or "20261020 10:31:05" (the gateway's zone, which is this machine's).
/// UNIX ms.
fn parse_time(s: &str) -> Option<f64> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn execution_times_parse() {
        // 10:31:05 New York (EDT) = 14:31:05 UTC.
        let a = parse_time("20261020 10:31:05 US/Eastern").unwrap();
        let b = parse_time("20261020-14:31:05").unwrap();
        assert_eq!(a, b);
        assert!(parse_time("20261020 10:31:05").is_some());
        assert!(parse_time("junk").is_none());
    }

    #[test]
    fn order_keys() {
        assert_eq!(order_key(7, 12, 99), "7:12");
        assert_eq!(order_key(0, 0, 99), "p99");
    }

    fn ticket(order_type: OrderType, limit: Option<f64>, stop: Option<f64>) -> OrderTicket {
        OrderTicket {
            symbol: "NASDAQ:AAPL".into(),
            side: Side::Buy,
            order_type,
            qty: 10.0,
            limit_price: limit,
            stop_price: stop,
            duration: Duration::Gtc,
            outside_rth: true,
            take_profit: None,
            stop_loss: None,
        }
    }

    #[test]
    fn tickets_validate_and_build() {
        assert!(validate(&ticket(OrderType::Limit, None, None)).is_err());
        assert!(validate(&ticket(OrderType::StopLimit, Some(1.0), None)).is_err());
        let t = ticket(OrderType::StopLimit, Some(101.0), Some(100.0));
        assert!(validate(&t).is_ok());
        let o = build_order(&t, "DU1");
        assert_eq!(o.order_type, "STP LMT");
        assert_eq!(o.limit_price, Some(101.0));
        assert_eq!(o.aux_price, Some(100.0));
        assert_eq!(o.tif, TimeInForce::GoodTillCanceled);
        assert!(o.outside_rth);
        assert_eq!(o.account, "DU1");
        let mut zero = ticket(OrderType::Market, None, None);
        zero.qty = 0.0;
        assert!(validate(&zero).is_err());
    }

    #[test]
    fn summary_reads_base_currency() {
        let mut v = HashMap::new();
        v.insert(("NetLiquidation".to_string(), "EUR".to_string()), "1000.5".to_string());
        v.insert(("TotalCashValue".to_string(), "EUR".to_string()), "400".to_string());
        v.insert(("TotalCashValue".to_string(), "USD".to_string()), "1".to_string());
        v.insert(("UnrealizedPnL".to_string(), "BASE".to_string()), "-3".to_string());
        let s = summarize("DU1", &v);
        assert_eq!(s.currency, "EUR");
        assert_eq!(s.equity, Some(1000.5));
        assert_eq!(s.balance, Some(400.0));
        assert_eq!(s.unrealized_pnl, Some(-3.0));
    }
}
