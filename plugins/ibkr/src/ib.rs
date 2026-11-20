/*
 * The connection to the broker (`link`: the user's IB Gateway / TWS, or a direct login) and the broker requests of
 * the app.
 *
 * While configured, the supervisor keeps one connection up, retrying with a growing delay when the broker can't be
 * reached or refuses. Per connection:
 *   • the order stream: orders, statuses, fills, commissions and order notices of this client id;
 *   • the account task: the selected account's values, portfolio rows and live P&L, and one P&L feed per position
 *     (its live last price and unrealized P&L);
 *   • the notice task: connection-level messages. The socket API client retries a dropped socket for a few minutes
 *     and says when it is back; subscriptions are then made again and the order lists read again, since what
 *     happened during the gap is lost. A direct login reconnects to the broker's servers and keeps its subscriptions
 *     itself. When either gives up, the supervisor starts over;
 *   • one market data feed per ticker the order ticket watches;
 *   • one order book feed per ticker the DOM watches;
 *   • one market data feed per chart symbol the app streams (`datafeed`: `data.quote`).
 *
 * Requests that share an answer type (open / completed orders, executions) run one at a time behind `lists`.
 */
use crate::datafeed::{DataFeed, Live};
use crate::direct;
use crate::link::{Feed, Link, Notices};
use crate::orders::{self, Leg, EXIT_GROUP};
use crate::prompt::Prompts;
use crate::rpc::Out;
use crate::state::{OrdRow, PosRow, Store, Tables};
use crate::symbols;
use crate::wire::*;
use ibapi::accounts::{AccountSummaryResult, AccountUpdate, PnL, PnLSingle};
use ibapi::contracts::tick_types::TickType;
use ibapi::contracts::{Contract, ContractDetails};
use ibapi::market_data::realtime::{MarketDepths, TickTypes};
use ibapi::orders::{ExecutionSide, Executions, Order as IbOrder, OrderStatusKind, OrderUpdate, Orders};
use ibapi::subscriptions::SubscriptionItem;
use ibapi::{Client, Error as IbError, Notice, NoticeCategory};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{oneshot, watch};
use tokio::task::JoinHandle;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const RETRY_MIN: Duration = Duration::from_secs(2);
const RETRY_MAX: Duration = Duration::from_secs(30);
/// How long a request waits for the broker to accept or refuse an order before answering anyway.
const SETTLE: Duration = Duration::from_secs(8);
const QUOTE_EVERY: Duration = Duration::from_millis(250);
/// Rows of each side of an order book: what IB gives by default.
const DEPTH_ROWS: i32 = 10;

/// How the plugin reaches the broker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Connection {
    /// The socket API of IB Gateway / TWS at `host:port`.
    Gateway { host: String, port: u16 },
    /// The plugin logs in itself.
    Direct(direct::Login),
}

/// The plugin's settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub connection: Connection,
    pub client_id: i32,
}

impl Config {
    /// From `plugin.configure`'s text values; empty fields take the manifest's defaults. `data` is the plugin's data
    /// folder (where a direct login keeps its restart token).
    pub fn from_settings(s: &HashMap<String, String>, data: Option<PathBuf>) -> Result<Config, String> {
        let get = |k: &str, default: &str| s.get(k).map(|v| v.trim()).filter(|v| !v.is_empty()).unwrap_or(default).to_string();
        let client_id = get("clientId", "17");
        let client_id = client_id.parse().map_err(|_| format!("Client ID {client_id:?} is not a whole number"))?;
        let connection = match get("connection", "gateway").as_str() {
            "direct" => {
                let username = get("username", "");
                // The password is kept as typed: spaces may be part of it.
                let password = s.get("password").cloned().unwrap_or_default();
                if username.is_empty() || password.is_empty() {
                    return Err("Direct login: enter your username and password in the plugin's settings".into());
                }
                let live = get("account", "paper") == "live";
                Connection::Direct(direct::Login {
                    restart_token: data.map(|d| direct::restart_token_file(&d, &username, live)),
                    username,
                    password,
                    live,
                    server: get("server", direct::DEFAULT_SERVER),
                    typed_code: get("secondFactor", "phone") == "code",
                })
            }
            _ => {
                let port = get("port", "4002");
                Connection::Gateway {
                    host: get("host", "127.0.0.1"),
                    port: port.parse().map_err(|_| format!("Port {port:?} is not a port number"))?,
                }
            }
        };
        Ok(Config { connection, client_id })
    }

    /// What the plugin connects to, for the user's messages.
    pub fn target(&self) -> String {
        match &self.connection {
            Connection::Gateway { host, port } => format!("IB Gateway / TWS at {host}:{port}"),
            Connection::Direct(l) => format!("Interactive Brokers (direct {} login)", if l.live { "live" } else { "paper" }),
        }
    }
}

/// Aborts its tasks when dropped (an account switch drops the per-position feeds with the account task).
#[derive(Default)]
struct Tasks(HashMap<i32, JoinHandle<()>>);

impl Drop for Tasks {
    fn drop(&mut self) {
        for (_, t) in self.0.drain() {
            t.abort();
        }
    }
}

/// A live connection.
struct Conn {
    client: Link,
    /// What it is connected to, for the user's messages.
    target: String,
    generation: u64,
    client_id: i32,
    tasks: Mutex<Vec<JoinHandle<()>>>,
    account_task: Mutex<Option<JoinHandle<()>>>,
    quotes: Mutex<HashMap<String, JoinHandle<()>>>,
    depths: Mutex<HashMap<String, JoinHandle<()>>>,
    /// The chart symbols' quotes (`data.subscribe`).
    streams: Mutex<HashMap<String, JoinHandle<()>>>,
    lists: tokio::sync::Mutex<()>,
}

impl Conn {
    fn abort_all(&self) {
        for t in lock(&self.tasks).drain(..) {
            t.abort();
        }
        if let Some(t) = lock(&self.account_task).take() {
            t.abort();
        }
        for (_, t) in lock(&self.quotes).drain().chain(lock(&self.depths).drain()).chain(lock(&self.streams).drain()) {
            t.abort();
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub struct Ibkr {
    pub store: Arc<Store>,
    /// Questions to the user (a direct login's second factor).
    pub prompts: Arc<Prompts>,
    /// Chart data: symbols, bars.
    pub data: DataFeed,
    /// The chart symbols whose quotes the app wants.
    streamed: Mutex<Vec<String>>,
    config: watch::Sender<Option<Config>>,
    conn: Mutex<Option<Arc<Conn>>>,
    generation: AtomicU64,
    /// Ticker → contract to trade it with.
    contracts: Mutex<HashMap<String, Contract>>,
    /// Contract id → contract, for the rows the broker reports.
    by_id: Mutex<HashMap<i32, Contract>>,
    /// Contract id → price step.
    ticks: Mutex<HashMap<i32, f64>>,
    /// Contract id → the smallest order and the size step IB gives (`broker.instrument`).
    sizes: Mutex<HashMap<i32, (Option<f64>, Option<f64>)>>,
    /// The tickers whose quotes the app wants.
    watched: Mutex<Vec<String>>,
    /// The tickers whose order book the app wants.
    watched_depth: Mutex<Vec<String>>,
}

impl Ibkr {
    pub fn new(out: Out) -> Arc<Self> {
        Arc::new(Self {
            prompts: Arc::new(Prompts::new(out.clone())),
            data: DataFeed::new(std::env::var_os("OPENTRADER_PLUGIN_DATA").filter(|d| !d.is_empty()).map(PathBuf::from)),
            streamed: Mutex::new(Vec::new()),
            store: Arc::new(Store::new(out)),
            config: watch::Sender::new(None),
            conn: Mutex::new(None),
            generation: AtomicU64::new(0),
            contracts: Mutex::new(HashMap::new()),
            by_id: Mutex::new(HashMap::new()),
            ticks: Mutex::new(HashMap::new()),
            sizes: Mutex::new(HashMap::new()),
            watched: Mutex::new(Vec::new()),
            watched_depth: Mutex::new(Vec::new()),
        })
    }

    fn out(&self) -> &Out {
        self.store.out()
    }

    /// New settings: reconnect when they changed.
    pub fn configure(&self, cfg: Config) {
        self.config.send_if_modified(|c| {
            let changed = c.as_ref() != Some(&cfg);
            *c = Some(cfg);
            changed
        });
    }

    fn current(&self) -> Result<Arc<Conn>, String> {
        lock(&self.conn).clone().ok_or_else(|| {
            if let Some(cfg) = self.config.borrow().as_ref() {
                format!("Not connected to {}", cfg.target())
            } else {
                "The plugin is not configured yet".to_string()
            }
        })
    }

    /// The connection for a chart data request. Not connected yet: busy, so the app asks again a little later.
    pub fn data_link(&self) -> Result<Link, crate::rpc::RpcError> {
        self.current().map(|c| c.client.clone()).map_err(|e| crate::rpc::RpcError::new(crate::datafeed::BUSY, e))
    }

    fn is_current(&self, generation: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == generation
    }

    // ── Connection ─────────────────────────────────────────────────────────

    /// Keep a connection up with the latest settings.
    pub async fn supervise(self: Arc<Self>) {
        let mut rx = self.config.subscribe();
        loop {
            let cfg = rx.borrow_and_update().clone();
            match cfg {
                Some(cfg) => self.run_config(&cfg, &mut rx).await,
                None => {
                    if rx.changed().await.is_err() {
                        return;
                    }
                }
            }
        }
    }

    /// Connect with `cfg` and stay connected until the settings change.
    async fn run_config(self: &Arc<Self>, cfg: &Config, rx: &mut watch::Receiver<Option<Config>>) {
        let mut delay = RETRY_MIN;
        let mut last_error: Option<String> = None;
        loop {
            match self.connect(cfg).await {
                Ok(ended) => {
                    delay = RETRY_MIN;
                    last_error = None;
                    tokio::select! {
                        _ = ended => {
                            self.drop_connection().await;
                            self.store.update(|t| {
                                t.connected = false;
                                t.clear_account();
                                t.notice("error", format!("Lost the connection to {}. Reconnecting.", cfg.target()));
                            });
                        }
                        _ = rx.changed() => {
                            self.drop_connection().await;
                            self.store.update(|t| { t.connected = false; t.clear_account(); });
                            return;
                        }
                    }
                }
                Err(msg) => {
                    // Said once; the retries are quiet until the reason changes.
                    if last_error.as_deref() != Some(msg.as_str()) {
                        self.store.update(|t| {
                            t.connected = false;
                            t.notice("warn", msg.clone());
                        });
                        last_error = Some(msg);
                    }
                }
            }
            tokio::select! {
                _ = tokio::time::sleep(delay) => {}
                _ = rx.changed() => return,
            }
            delay = (delay * 2).min(RETRY_MAX);
        }
    }

    /// Connect and start the connection's tasks. The receiver resolves when the connection is gone for good.
    async fn connect(self: &Arc<Self>, cfg: &Config) -> Result<oneshot::Receiver<()>, String> {
        let target = cfg.target();
        let (client, notices) = match &cfg.connection {
            Connection::Gateway { host, port } => {
                let address = format!("{host}:{port}");
                let attempt = tokio::time::timeout(
                    CONNECT_TIMEOUT,
                    Client::builder().address(address.as_str()).client_id(cfg.client_id).connect_with_notice_stream(),
                )
                .await;
                match attempt {
                    Ok(Ok((client, notices))) => (Link::Gateway(Arc::new(client)), Notices::Gateway(notices)),
                    Ok(Err(e)) => return Err(connect_error(&e, cfg)),
                    Err(_) => return Err(format!("No answer from {target}. {ENABLE_API}")),
                }
            }
            Connection::Direct(login) => {
                let (client, notices) = direct::connect(login, cfg.client_id, &self.prompts).await?;
                (Link::Direct(client), Notices::Direct(notices))
            }
        };
        let accounts = match client.managed_accounts().await {
            Ok(a) if !a.is_empty() => a,
            Ok(_) => {
                client.disconnect().await;
                return Err(format!("{target} lists no account"));
            }
            Err(e) => {
                client.disconnect().await;
                return Err(format!("{target} did not list the accounts: {e}"));
            }
        };
        client.prefer_delayed().await;
        let order_stream = match client.order_updates().await {
            Ok(s) => s,
            Err(e) => {
                client.disconnect().await;
                return Err(format!("{target} refused the order updates: {e}"));
            }
        };

        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let conn = Arc::new(Conn {
            client: client.clone(),
            target: target.clone(),
            generation,
            client_id: cfg.client_id,
            tasks: Mutex::new(Vec::new()),
            account_task: Mutex::new(None),
            quotes: Mutex::new(HashMap::new()),
            depths: Mutex::new(HashMap::new()),
            streams: Mutex::new(HashMap::new()),
            lists: tokio::sync::Mutex::new(()),
        });
        *lock(&self.conn) = Some(conn.clone());
        let account = self.store.update(|t| {
            let account = t.account.clone().filter(|a| accounts.contains(a)).or_else(|| accounts.first().cloned());
            t.clear_account();
            t.connected = true;
            t.accounts = accounts.clone();
            t.account = account.clone();
            let kind = if account.as_deref().is_some_and(|a| a.starts_with('D')) { "paper" } else { "live" };
            t.notice("info", format!("Connected to {target} ({kind} account {})", account.clone().unwrap_or_default()));
            account
        });

        let (ended_tx, ended) = oneshot::channel();
        let me = self.clone();
        let c = conn.clone();
        let orders_task = tokio::spawn(async move { me.run_orders(c, order_stream).await });
        let me = self.clone();
        let c = conn.clone();
        let notice_task = tokio::spawn(async move { me.run_notices(c, notices, ended_tx).await });
        let me = self.clone();
        let c = conn.clone();
        let watchdog = tokio::spawn(async move { me.watch_link(c).await });
        lock(&conn.tasks).extend([orders_task, notice_task, watchdog]);
        if let Some(a) = account {
            self.start_account(&conn, a);
        }
        let me = self.clone();
        let c = conn.clone();
        tokio::spawn(async move { me.load_lists(&c).await });
        self.sync_quotes(&conn);
        self.sync_depths(&conn);
        self.sync_streams(&conn);
        Ok(ended)
    }

    async fn drop_connection(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        let conn = lock(&self.conn).take();
        if let Some(conn) = conn {
            conn.abort_all();
            conn.client.disconnect().await;
        }
    }

    /// The socket's state as `connected`: false while the client retries a dropped socket.
    async fn watch_link(self: Arc<Self>, conn: Arc<Conn>) {
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            if !self.is_current(conn.generation) {
                return;
            }
            let up = conn.client.is_connected();
            if self.store.read(|t| t.connected) != up {
                self.store.update(|t| {
                    t.connected = up;
                    if !up {
                        t.notice("warn", format!("The connection to {} dropped. Retrying.", conn.target));
                    }
                });
            }
        }
    }

    async fn run_notices(self: Arc<Self>, conn: Arc<Conn>, mut notices: Notices, ended: oneshot::Sender<()>) {
        while let Some(n) = notices.next().await {
            if !self.is_current(conn.generation) {
                return;
            }
            if n.code == ibapi::TRANSPORT_RECONNECT_CODE {
                // The socket is back: subscriptions are gone, the events of the gap are lost.
                self.store.update(|t| {
                    t.connected = true;
                    t.notice("info", format!("The connection to {} is back", conn.target));
                });
                conn.client.prefer_delayed().await;
                if let Some(a) = self.store.read(|t| t.account.clone()) {
                    self.start_account(&conn, a);
                }
                for (_, t) in lock(&conn.quotes).drain().chain(lock(&conn.depths).drain()).chain(lock(&conn.streams).drain()) {
                    t.abort();
                }
                self.sync_quotes(&conn);
                self.sync_depths(&conn);
                self.sync_streams(&conn);
                self.load_lists(&conn).await;
                continue;
            }
            // Farm status chatter (2104, 2106, 2158…) and data advisories.
            if n.connectivity_status().is_some() || n.is_data_advisory() {
                continue;
            }
            self.log_notice(&n);
        }
        // The client gave up retrying the socket.
        let _ = ended.send(());
    }

    fn log_notice(&self, n: &Notice) {
        let level = match n.category() {
            NoticeCategory::Error | NoticeCategory::RequestError | NoticeCategory::OrderRejection => "error",
            NoticeCategory::Warning | NoticeCategory::SystemMessage => "warn",
            _ => "info",
        };
        self.store.update(|t| t.notice(level, format!("{} (code {})", n.message, n.code)));
    }

    // ── Account ────────────────────────────────────────────────────────────

    fn start_account(self: &Arc<Self>, conn: &Arc<Conn>, account: String) {
        let me = self.clone();
        let c = conn.clone();
        let task = tokio::spawn(async move { me.run_account(c, account).await });
        if let Some(old) = lock(&conn.account_task).replace(task) {
            old.abort();
        }
    }

    async fn run_account(self: Arc<Self>, conn: Arc<Conn>, account: String) {
        let mut updates = match conn.client.account_updates(&account).await {
            Ok(s) => s,
            Err(e) => return self.account_error(&conn, &e),
        };
        let mut pnl = conn.client.pnl(&account).await;
        // The values the account updates leave out (SMA, Reg T equity, day trades left…).
        let mut summary = conn.client.account_summary().await;
        let mut feeds = Tasks::default();
        let mine = |t: &Tables| t.account.as_deref() == Some(account.as_str());
        loop {
            tokio::select! {
                item = updates.next() => match item {
                    Some(Ok(SubscriptionItem::Data(AccountUpdate::AccountValue(v)))) => self.store.update(|t| {
                        if mine(t) {
                            t.values.insert((v.key.clone(), v.currency.clone()), v.value.clone());
                        }
                    }),
                    Some(Ok(SubscriptionItem::Data(AccountUpdate::PortfolioValue(p)))) => {
                        let cid = p.contract.contract_id;
                        self.remember(&p.contract);
                        if p.position == 0.0 {
                            if let Some(h) = feeds.0.remove(&cid) {
                                h.abort();
                            }
                            self.store.update(|t| { t.positions.remove(&cid); });
                        } else {
                            let mult: f64 = p.contract.multiplier.parse().ok().filter(|m: &f64| *m > 0.0).unwrap_or(1.0);
                            let row = PosRow {
                                contract_id: cid,
                                ticker: symbols::ticker_of(&p.contract),
                                qty: p.position,
                                avg_price: p.average_cost / mult,
                                last: orders::positive(Some(p.market_price)),
                                unrealized: orders::finite(Some(p.unrealized_pnl)),
                                realized: orders::finite(Some(p.realized_pnl)),
                            };
                            self.store.update(|t| {
                                if !mine(t) {
                                    return;
                                }
                                // The P&L feed's live figures win over the portfolio's, which lag.
                                let live = t.positions.get(&cid).map(|q| (q.last, q.unrealized));
                                let mut row = row;
                                if let Some((last, unrealized)) = live {
                                    row.last = last.or(row.last);
                                    row.unrealized = unrealized.or(row.unrealized);
                                }
                                t.positions.insert(cid, row);
                            });
                            feeds.0.entry(cid).or_insert_with(|| {
                                let me = self.clone();
                                let c = conn.clone();
                                let a = account.clone();
                                tokio::spawn(async move { me.run_pnl_single(c, a, cid).await })
                            });
                        }
                    }
                    Some(Ok(SubscriptionItem::Data(_))) => {}
                    Some(Ok(SubscriptionItem::Notice(n))) => self.log_notice(&n),
                    Some(Err(e)) if e.is_connection_lost() => return,
                    Some(Err(e)) => return self.account_error(&conn, &e.to_string()),
                    None => return,
                },
                item = next_of(&mut summary) => match item {
                    Some(Ok(SubscriptionItem::Data(AccountSummaryResult::Summary(s)))) if s.account == account => {
                        self.store.update(|t| {
                            if mine(t) {
                                // The account updates' own value wins.
                                t.values.entry((s.tag.clone(), s.currency.clone())).or_insert(s.value.clone());
                            }
                        });
                    }
                    Some(Ok(_)) => {}
                    Some(Err(_)) | None => summary = None,
                },
                item = next_of(&mut pnl) => match item {
                    Some(Ok(SubscriptionItem::Data(PnL { realized_pnl, unrealized_pnl, .. }))) => self.store.update(|t| {
                        if mine(t) {
                            t.pnl = (orders::finite(realized_pnl).or(t.pnl.0), orders::finite(unrealized_pnl).or(t.pnl.1));
                        }
                    }),
                    Some(Ok(_)) => {}
                    Some(Err(_)) | None => pnl = None,
                },
            }
        }
    }

    async fn run_pnl_single(self: Arc<Self>, conn: Arc<Conn>, account: String, cid: i32) {
        let Some(mut sub) = conn.client.pnl_single(&account, cid).await else { return };
        while let Some(item) = sub.next().await {
            match item {
                Ok(SubscriptionItem::Data(PnLSingle { position, unrealized_pnl, realized_pnl, value, .. })) => {
                    self.store.update(|t| {
                        if t.account.as_deref() != Some(account.as_str()) {
                            return;
                        }
                        if let Some(p) = t.positions.get_mut(&cid) {
                            if let (Some(v), true) = (orders::finite(Some(value)), position != 0.0) {
                                p.last = Some((v / position).abs());
                            }
                            p.unrealized = orders::finite(Some(unrealized_pnl)).or(p.unrealized);
                            p.realized = orders::finite(Some(realized_pnl)).or(p.realized);
                        }
                    });
                }
                Ok(SubscriptionItem::Notice(_)) => {}
                Err(_) => return,
            }
        }
    }

    fn account_error(&self, conn: &Conn, e: &str) {
        if self.is_current(conn.generation) {
            self.store.update(|t| t.notice("error", format!("Account updates stopped: {e}")));
        }
    }

    pub fn select_account(self: &Arc<Self>, account: &str) -> Result<(), String> {
        let conn = self.current()?;
        let known = self.store.update(|t| {
            if !t.accounts.iter().any(|a| a == account) {
                return false;
            }
            if t.account.as_deref() != Some(account) {
                t.account = Some(account.to_string());
                t.values.clear();
                t.pnl = (None, None);
                t.positions.clear();
            }
            true
        });
        if !known {
            return Err(format!("Unknown account {account}"));
        }
        self.start_account(&conn, account.to_string());
        Ok(())
    }

    // ── Orders ─────────────────────────────────────────────────────────────

    /// Read the open and completed orders and the week's executions.
    async fn load_lists(self: &Arc<Self>, conn: &Arc<Conn>) {
        let _guard = conn.lists.lock().await;
        for completed in [false, true] {
            let what = if completed { "completed orders" } else { "open orders" };
            match conn.client.orders(completed).await {
                Ok(items) => {
                    println!("[info] {what}: {}", items.len());
                    for item in items {
                        match item {
                            Orders::OrderData(d) => {
                                let msg = non_empty(&d.order_state.reject_reason).or_else(|| non_empty(&d.order_state.warning_text));
                                self.apply_order(conn, &d.contract, &d.order, d.order_id, &d.order_state.status, msg);
                            }
                            Orders::OrderStatus(s) => self.apply_status(&s),
                        }
                    }
                }
                Err(e) => println!("[warn] reading the {what} failed: {e}"),
            }
        }
        match conn.client.executions().await {
            Ok(items) => self.store.update(|t| {
                for item in items {
                    match item {
                        Executions::ExecutionData(d) => apply_execution(t, &d.contract, &d.execution, false),
                        Executions::CommissionReport(c) => apply_commission(t, &c.execution_id, c.commission, c.realized_pnl),
                    }
                }
            }),
            Err(e) => println!("[warn] reading the executions failed: {e}"),
        }
    }

    async fn run_orders(self: Arc<Self>, conn: Arc<Conn>, mut stream: Feed<OrderUpdate>) {
        loop {
            while let Some(item) = stream.next().await {
                match item {
                    Ok(SubscriptionItem::Data(u)) => match u {
                        OrderUpdate::OpenOrder(d) => {
                            let msg = non_empty(&d.order_state.reject_reason).or_else(|| non_empty(&d.order_state.warning_text));
                            self.apply_order(&conn, &d.contract, &d.order, d.order_id, &d.order_state.status, msg);
                        }
                        OrderUpdate::OrderStatus(s) => self.apply_status(&s),
                        // A new fill comes with request id -1; the answers to the executions request (at connection) come here
                        // too, with that request's id, and are history.
                        OrderUpdate::ExecutionData(d) => self.store.update(|t| apply_execution(t, &d.contract, &d.execution, d.request_id < 0)),
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
                        println!("[warn] order stream ended: {e}");
                        break;
                    }
                }
            }
            if !self.is_current(conn.generation) {
                return;
            }
            // The stream ended (it survives socket retries, so this is rare): ask again, then read the lists again.
            tokio::time::sleep(Duration::from_secs(2)).await;
            match conn.client.order_updates().await {
                Ok(s) => {
                    stream = s;
                    self.load_lists(&conn).await;
                }
                Err(_) if !conn.client.is_connected() => continue,
                Err(e) => {
                    self.store.update(|t| t.notice("error", format!("Order updates stopped: {e}")));
                    return;
                }
            }
        }
    }

    fn apply_order(&self, conn: &Conn, c: &Contract, o: &IbOrder, order_id: i32, status: &OrderStatusKind, message: Option<String>) {
        self.remember(c);
        let key = orders::order_key(o.client_id, order_id, o.perm_id);
        let mine = o.client_id == conn.client_id && order_id > 0;
        let row = OrdRow { message, ..order_row(key, order_id, o.client_id, c, o, orders::status_of(status), mine) };
        self.store.update(|t| t.upsert_order(row));
    }

    fn apply_status(&self, s: &ibapi::orders::OrderStatus) {
        let key = orders::order_key(s.client_id, s.order_id, s.perm_id);
        let status = orders::status_of(&s.status);
        self.store.update(|t| {
            t.update_status(&key, s.perm_id, |o| {
                o.status = status;
                o.filled = s.filled;
                o.avg_fill = orders::positive(s.average_fill_price).or(o.avg_fill);
            })
        });
    }

    /// An order-bound notice: a rejection marks the order, the rest goes to the notifications log.
    fn order_notice(&self, conn: &Conn, n: &Notice) {
        let category = n.category();
        if matches!(category, NoticeCategory::Cancellation) {
            return;
        }
        let key = n.request_id.map(|id| orders::order_key(conn.client_id, id, 0));
        // "Cannot be cancelled, state: Cancelled": a leg its one-cancels-all group cancelled first (`cancel_all`).
        let moot = n.code == 10148
            && self.store.read(|t| key.as_ref().and_then(|k| t.orders.get(k)).is_some_and(|o| o.is_exit_leg()));
        if moot {
            return;
        }
        self.store.update(|t| {
            if let Some(k) = &key {
                // An error on an order IB never acknowledged refuses it too: the API's own checks (10243, a
                // fractional size) answer with error codes outside the rejection range.
                let unsent = t.orders.get(k).is_some_and(|o| o.status == OrderStatus::Placing)
                    && matches!(category, NoticeCategory::Error | NoticeCategory::RequestError);
                if matches!(category, NoticeCategory::OrderRejection) || unsent {
                    t.reject(k, &n.message);
                } else {
                    t.update_status(k, 0, |o| o.message = Some(n.message.clone()));
                }
            }
        });
        self.log_notice(n);
    }

    // ── Contracts ──────────────────────────────────────────────────────────

    fn remember(&self, c: &Contract) {
        if c.contract_id != 0 {
            lock(&self.by_id).insert(c.contract_id, c.clone());
        }
    }

    fn remember_details(&self, d: &ContractDetails) -> Contract {
        let c = symbols::routed(d.contract.clone());
        if d.min_tick > 0.0 {
            lock(&self.ticks).insert(c.contract_id, d.min_tick);
        }
        let positive = |v: Option<f64>| v.filter(|v| v.is_finite() && *v > 0.0);
        lock(&self.sizes).insert(c.contract_id, (positive(d.min_size), positive(d.size_increment)));
        self.remember(&d.contract);
        lock(&self.contracts).insert(symbols::ticker_of(&c), c.clone());
        c
    }

    /// `broker.resolveSymbol`: the US stock or fund an app symbol ("NASDAQ:AAPL") stands for. None when the app's
    /// exchange is not a US stock exchange or the broker has no such stock there.
    pub async fn resolve_symbol(&self, symbol: &str, ticker: &str) -> Result<Option<String>, String> {
        let conn = self.current()?;
        let exchange = symbols::exchange_of(symbol);
        // The plugin's own chart symbols: the contract their data comes from.
        if exchange.is_some_and(|e| e.eq_ignore_ascii_case(crate::EXCHANGE)) {
            let s = self.data.resolve(&conn.client, ticker).await.map_err(|e| e.message)?;
            let c = self.contract_by_id(&conn, s.contract.contract_id).await?;
            return Ok(Some(symbols::ticker_of(&c)));
        }
        let wanted = exchange.map(symbols::broker_exchanges).unwrap_or(&[]);
        if exchange.is_some() && wanted.is_empty() {
            return Ok(None);
        }
        let query = Contract::stock(symbols::broker_ticker(ticker)).build();
        let details = match conn.client.contract_details(&query).await {
            Ok(d) => d,
            // "No security definition has been found."
            Err(IbError::Notice(n)) if n.code == 200 => return Ok(None),
            Err(e) => return Err(format!("Looking up {ticker} failed: {e}")),
        };
        let pick = details
            .iter()
            .find(|d| wanted.iter().any(|w| d.contract.primary_exchange.as_str().eq_ignore_ascii_case(w)))
            .or_else(|| if wanted.is_empty() || details.len() == 1 { details.first() } else { None });
        Ok(pick.map(|d| symbols::ticker_of(&self.remember_details(d))))
    }

    /// The contract to trade a ticker with: resolved before, held or ordered, or a US stock of that name.
    async fn contract_for(&self, conn: &Conn, ticker: &str) -> Result<Contract, String> {
        if let Some(c) = lock(&self.contracts).get(ticker) {
            return Ok(c.clone());
        }
        let known = self.store.read(|t| {
            t.positions
                .values()
                .find(|p| p.ticker == ticker)
                .map(|p| p.contract_id)
                .or_else(|| t.orders.values().find(|o| o.ticker == ticker).map(|o| o.contract_id))
        });
        if let Some(cid) = known.filter(|c| *c != 0) {
            return self.contract_by_id(conn, cid).await;
        }
        let details = conn
            .client
            .contract_details(&Contract::stock(symbols::broker_ticker(ticker)).build())
            .await
            .map_err(|e| format!("{ticker}: IB has no US stock of that name ({e})"))?;
        let d = details.first().ok_or_else(|| format!("{ticker}: IB has no US stock of that name"))?;
        Ok(self.remember_details(d))
    }

    /// The contract of a reported row, with its price step.
    async fn contract_by_id(&self, conn: &Conn, cid: i32) -> Result<Contract, String> {
        let known = lock(&self.by_id).get(&cid).cloned();
        if let (Some(c), true) = (known, lock(&self.ticks).contains_key(&cid)) {
            return Ok(symbols::routed(c));
        }
        let query = Contract { contract_id: cid, ..Default::default() };
        let details = conn.client.contract_details(&query).await.map_err(|e| format!("The contract {cid} is unknown: {e}"))?;
        let d = details.first().ok_or_else(|| format!("The contract {cid} is unknown"))?;
        Ok(self.remember_details(d))
    }

    fn tick_of(&self, cid: i32) -> Option<f64> {
        lock(&self.ticks).get(&cid).copied()
    }

    /// `broker.instrument`: the smallest order and the size step IB gives for the contract, and its point value, the
    /// contract multiplier (ES: 50) in the account's currency. The order ticket sizes risk and shows the tick value
    /// with it.
    pub async fn instrument(&self, ticker: &str) -> Result<Instrument, String> {
        let conn = self.current()?;
        let contract = self.contract_for(&conn, ticker).await?;
        let (min, step) = lock(&self.sizes).get(&contract.contract_id).copied().unwrap_or((None, None));
        // IB lists fractional shares, but the API refuses a fractional size (10243): whole units only.
        let qty_step = Some(step.map_or(1.0, |s| s.ceil().max(1.0)));
        let qty_min = Some(min.map_or(1.0, |m| m.ceil().max(1.0)));
        let multiplier = contract.multiplier.parse::<f64>().ok().filter(|m| *m > 0.0).unwrap_or(1.0);
        let rate = self.store.read(|t| t.rate_to_base(&contract.currency.0));
        Ok(Instrument { qty_min, qty_step, point_value: rate.map(|r| multiplier * r) })
    }

    // ── Trading ────────────────────────────────────────────────────────────

    fn account(&self) -> Result<String, String> {
        self.store.read(|t| t.account.clone()).ok_or_else(|| "No account selected".to_string())
    }

    /// Send orders and wait for the broker to accept or refuse the first. A refusal is the request's error.
    async fn send(&self, conn: &Conn, contract: &Contract, legs: &[IbOrder]) -> Result<String, String> {
        let keys: Vec<String> = legs.iter().map(|o| orders::order_key(conn.client_id, o.order_id, 0)).collect();
        self.store.update(|t| {
            for (o, key) in legs.iter().zip(&keys) {
                t.upsert_order(order_row(key.clone(), o.order_id, conn.client_id, contract, o, OrderStatus::Placing, true));
                t.awaiting.insert(key.clone());
            }
        });
        let result = self.submit_and_settle(conn, contract, legs, &keys).await;
        self.store.update(|t| {
            for k in &keys {
                t.awaiting.remove(k);
            }
        });
        result.map(|_| keys[0].clone())
    }

    async fn submit_and_settle(&self, conn: &Conn, contract: &Contract, legs: &[IbOrder], keys: &[String]) -> Result<(), String> {
        for o in legs {
            if let Err(e) = conn.client.submit_order(contract, o).await {
                let msg = format!("The order was not sent: {e}");
                self.store.update(|t| keys.iter().for_each(|k| t.reject(k, &msg)));
                return Err(msg);
            }
        }
        let first = &keys[0];
        self.store
            .wait_until(SETTLE, |t| t.orders.get(first).is_none_or(|o| o.status != OrderStatus::Placing))
            .await;
        self.store.read(|t| match t.orders.get(first) {
            Some(o) if o.status == OrderStatus::Rejected => Err(o.message.clone().unwrap_or_else(|| "Rejected by the broker".into())),
            _ => Ok(()),
        })
    }

    pub async fn place(&self, ticket: OrderTicket) -> Result<String, String> {
        orders::validate(&ticket)?;
        let conn = self.current()?;
        let account = self.account()?;
        let contract = self.contract_for(&conn, &ticket.ticker).await?;
        let ticket = orders::rounded(&ticket, self.tick_of(contract.contract_id));
        // A price under half a tick rounds to 0.
        orders::validate(&ticket)?;
        let mut ids = Vec::new();
        for _ in 0..orders::bracket_size(&ticket) {
            ids.push(conn.client.next_order_id().await);
        }
        let mut ids = ids.into_iter();
        let legs = orders::bracket(&ticket, &account, || ids.next().unwrap_or_default());
        self.send(&conn, &contract, &legs).await
    }

    /// A working order of this plugin's client id.
    fn own_order(&self, key: &str) -> Result<OrdRow, String> {
        let row = self.store.read(|t| t.orders.get(key).cloned()).ok_or("The order is gone")?;
        if !row.mine {
            return Err("This order was placed in TWS or by another program: change it there".into());
        }
        if !row.status.active() {
            return Err("The order is no longer working".into());
        }
        Ok(row)
    }

    /// Send an order again under its id with changed fields (a modification).
    async fn resubmit(&self, conn: &Conn, contract: &Contract, row: &OrdRow, change: impl FnOnce(&mut IbOrder)) -> Result<(), String> {
        let (order_type, limit, stop) = match row.order_type {
            OrderType::Market => ("MKT", None, None),
            OrderType::Limit => ("LMT", row.limit, None),
            OrderType::Stop => ("STP", None, row.stop),
            OrderType::StopLimit => ("STP LMT", row.limit, row.stop),
        };
        let mut o = IbOrder {
            order_id: row.order_id,
            action: orders::action(row.side),
            total_quantity: row.qty,
            order_type: order_type.into(),
            limit_price: limit,
            aux_price: stop,
            tif: row.tif.clone(),
            outside_rth: row.outside_rth,
            parent_id: row.parent_id,
            oca_group: row.oca_group.clone(),
            oca_type: row.oca_type,
            account: row.account.clone(),
            transmit: true,
            ..Default::default()
        };
        change(&mut o);
        conn.client.submit_order(contract, &o).await.map_err(|e| format!("The change was not sent: {e}"))?;
        let (qty, limit, stop) = (o.total_quantity, orders::positive(o.limit_price), orders::positive(o.aux_price));
        self.store.update(|t| {
            if let Some(r) = t.orders.get_mut(&row.key) {
                r.qty = qty;
                r.limit = limit;
                r.stop = stop;
                r.message = None;
                r.updated_ms = orders::now_ms();
            }
        });
        Ok(())
    }

    async fn cancel_row(&self, conn: &Conn, row: &OrdRow) -> Result<(), String> {
        let refused = conn.client.cancel_order(row.order_id).await.map_err(|e| format!("The cancel was not sent: {e}"))?;
        refused.map_or(Ok(()), Err)
    }

    pub async fn modify(&self, key: &str, ticket: OrderTicket) -> Result<(), String> {
        orders::validate(&ticket)?;
        let conn = self.current()?;
        let row = self.own_order(key)?;
        let contract = self.contract_by_id(&conn, row.contract_id).await?;
        let ticket = orders::rounded(&ticket, self.tick_of(row.contract_id));
        // A price under half a tick rounds to 0.
        orders::validate(&ticket)?;
        let built = orders::build_order(&ticket, &row.account);
        let target = OrdRow { order_type: ticket.order_type, side: ticket.side, ..row.clone() };
        self.resubmit(&conn, &contract, &target, |o| {
            o.action = built.action;
            o.total_quantity = built.total_quantity;
            o.order_type = built.order_type.clone();
            o.limit_price = built.limit_price;
            o.aux_price = built.aux_price;
            // The time in force picked; an app that sends none keeps the order's.
            if ticket.duration.is_some() {
                o.tif = built.tif.clone();
            }
        })
        .await?;
        self.store.update(|t| {
            if let Some(r) = t.orders.get_mut(key) {
                r.order_type = ticket.order_type;
                r.side = ticket.side;
            }
        });

        // The bracket's legs follow.
        let have = self.store.read(|t| {
            let (tp, sl) = t.children(&row);
            (tp.cloned(), sl.cloned())
        });
        let (exit, account, parent_id) = (ticket.side.opposite(), row.account.clone(), row.order_id);
        self.reshape_exits(&conn, &contract, have, (ticket.take_profit, ticket.stop_loss), ticket.qty, |leg, price| IbOrder {
            parent_id,
            ..orders::exit_order(leg, exit, ticket.qty, price, &account)
        })
        .await?;
        let event = self.store.read(|t| t.orders.get(key).map(|r| r.event("modified", None)));
        if let Some(e) = event {
            self.store.update(|t| t.event(e));
        }
        Ok(())
    }

    /// Cancel exit legs and wait until the broker reports them done. One refusal is not final: cancelling a leg of a
    /// one-cancels-all group cancels the others, which may then refuse their own cancel.
    async fn cancel_all(&self, conn: &Conn, rows: &[OrdRow]) -> Result<(), String> {
        self.store.update(|t| {
            for r in rows {
                if let Some(o) = t.orders.get_mut(&r.key) {
                    o.detached = true;
                }
            }
        });
        for r in rows {
            let _ = self.cancel_row(conn, r).await;
        }
        let keys: Vec<&str> = rows.iter().map(|r| r.key.as_str()).collect();
        let done = self
            .store
            .wait_until(SETTLE, |t| keys.iter().all(|k| t.orders.get(*k).is_none_or(|o| !o.status.active())))
            .await;
        if done {
            Ok(())
        } else {
            Err("IB did not confirm the cancellation of the previous take profit / stop loss in time".into())
        }
    }

    /// Set a pair of exits (take profit, stop loss) to `want`. Moved prices are changed in place. Adding or removing
    /// a leg replaces the pair: the broker cancels the other orders of a one-cancels-all group with a cancelled one,
    /// so the old legs are all cancelled and, once the broker confirms, the wanted ones are placed again (`build`).
    async fn reshape_exits(
        &self,
        conn: &Conn,
        contract: &Contract,
        have: (Option<OrdRow>, Option<OrdRow>),
        want: (Option<f64>, Option<f64>),
        qty: f64,
        build: impl Fn(Leg, f64) -> IbOrder,
    ) -> Result<(), String> {
        let (tp, sl) = have;
        if want.0.is_some() == tp.is_some() && want.1.is_some() == sl.is_some() {
            for (leg, price, row) in [(Leg::TakeProfit, want.0, tp), (Leg::StopLoss, want.1, sl)] {
                let (Some(price), Some(row)) = (price, row) else { continue };
                let now = if leg == Leg::TakeProfit { row.limit } else { row.stop };
                if now == Some(price) && row.qty == qty {
                    continue;
                }
                self.resubmit(conn, contract, &row, |o| {
                    o.total_quantity = qty;
                    match leg {
                        Leg::TakeProfit => o.limit_price = Some(price),
                        Leg::StopLoss => o.aux_price = Some(price),
                    }
                })
                .await?;
            }
            return Ok(());
        }
        let old: Vec<OrdRow> = tp.into_iter().chain(sl).collect();
        self.cancel_all(conn, &old).await?;
        for (leg, price) in [(Leg::TakeProfit, want.0), (Leg::StopLoss, want.1)] {
            if let Some(price) = price {
                let mut o = build(leg, price);
                o.order_id = conn.client.next_order_id().await;
                self.send(conn, contract, &[o]).await?;
            }
        }
        Ok(())
    }

    pub async fn cancel(&self, key: &str) -> Result<(), String> {
        let conn = self.current()?;
        let row = self.own_order(key)?;
        self.cancel_row(&conn, &row).await
    }

    fn position(&self, id: &str) -> Result<PosRow, String> {
        let cid: i32 = id.parse().map_err(|_| format!("Unknown position {id}"))?;
        self.store.read(|t| t.positions.get(&cid).cloned()).ok_or_else(|| "The position is closed".to_string())
    }

    /// The position's exit orders, refused when any was placed elsewhere (this client id cannot change them).
    fn own_exits(&self, p: &PosRow) -> Result<(Option<OrdRow>, Option<OrdRow>), String> {
        let (tp, sl) = self.store.read(|t| {
            let (tp, sl) = t.exits(p);
            (tp.cloned(), sl.cloned())
        });
        if tp.iter().chain(sl.iter()).any(|o| !o.mine) {
            return Err("This position's take profit or stop loss was placed in TWS or by another program: change it there".into());
        }
        Ok((tp, sl))
    }

    /// `broker.closePosition`: a market order the other way. Once the broker takes it, the position's exit orders
    /// are cancelled (whole close) or cut to what is left (partial close), so none is left to open a new position.
    pub async fn close_position(&self, id: &str, qty: Option<f64>) -> Result<(), String> {
        let conn = self.current()?;
        let account = self.account()?;
        let p = self.position(id)?;
        let held = p.qty.abs();
        let qty = qty.filter(|q| q.is_finite() && *q > 0.0).map_or(held, |q| q.min(held));
        let contract = self.contract_by_id(&conn, p.contract_id).await?;
        let ticket = OrderTicket {
            ticker: p.ticker.clone(),
            side: p.side().opposite(),
            order_type: OrderType::Market,
            qty,
            limit_price: None,
            stop_price: None,
            take_profit: None,
            stop_loss: None,
            duration: None,
        };
        let mut order = orders::build_order(&ticket, &account);
        order.order_id = conn.client.next_order_id().await;
        self.send(&conn, &contract, &[order]).await?;

        let (tp, sl) = self.store.read(|t| {
            let (tp, sl) = t.exits(&p);
            (tp.filter(|o| o.mine).cloned(), sl.filter(|o| o.mine).cloned())
        });
        let left = held - qty;
        for exit in tp.into_iter().chain(sl) {
            let done = if left <= 0.0 {
                self.cancel_row(&conn, &exit).await
            } else {
                self.resubmit(&conn, &contract, &exit, |o| o.total_quantity = left).await
            };
            if let Err(e) = done {
                self.store.update(|t| t.notice("warn", format!("{}: the exit order {} was not updated: {e}", p.ticker, exit.key)));
            }
        }
        Ok(())
    }

    /// `broker.setPositionBrackets`: the position's take profit (limit) and stop loss (stop) as exit orders for its
    /// whole quantity, in a one-cancels-all group (see `reshape_exits`).
    pub async fn set_position_brackets(&self, id: &str, take_profit: Option<f64>, stop_loss: Option<f64>) -> Result<(), String> {
        let conn = self.current()?;
        let account = self.account()?;
        let p = self.position(id)?;
        let have = self.own_exits(&p)?;
        let contract = self.contract_by_id(&conn, p.contract_id).await?;
        let tick = self.tick_of(p.contract_id);
        let want = (orders::on_tick(take_profit, tick), orders::on_tick(stop_loss, tick));
        for (p, what) in [(want.0, "take profit"), (want.1, "stop loss")] {
            if p.is_some_and(|v| !(v.is_finite() && v > 0.0)) {
                return Err(format!("The {what} price must be above 0"));
            }
        }
        let (qty, exit) = (p.qty.abs(), p.side().opposite());
        let group = format!("{EXIT_GROUP}{}-{}", p.contract_id, orders::now_ms() as u64);
        self.reshape_exits(&conn, &contract, have, want, qty, |leg, price| orders::grouped_exit(leg, exit, qty, price, &account, &group))
            .await
    }

    // ── Order ticket quotes ────────────────────────────────────────────────

    /// `broker.watchQuote`: the whole set of tickers to send `broker.quote` for.
    pub fn watch_quotes(self: &Arc<Self>, tickers: Vec<String>) {
        *lock(&self.watched) = tickers;
        if let Ok(conn) = self.current() {
            self.sync_quotes(&conn);
        }
    }

    fn sync_quotes(self: &Arc<Self>, conn: &Arc<Conn>) {
        let wanted: HashSet<String> = lock(&self.watched).iter().cloned().collect();
        let mut feeds = lock(&conn.quotes);
        feeds.retain(|t, h| {
            let keep = wanted.contains(t) && !h.is_finished();
            if !keep {
                h.abort();
            }
            keep
        });
        for ticker in wanted {
            if feeds.contains_key(&ticker) {
                continue;
            }
            let me = self.clone();
            let c = conn.clone();
            let t = ticker.clone();
            feeds.insert(ticker, tokio::spawn(async move { me.run_quote(c, t).await }));
        }
    }

    async fn run_quote(self: Arc<Self>, conn: Arc<Conn>, ticker: String) {
        let contract = match self.contract_for(&conn, &ticker).await {
            Ok(c) => c,
            Err(e) => return println!("[warn] no quote for {ticker}: {e}"),
        };
        let mut sub = match conn.client.quotes(&contract).await {
            Ok(s) => s,
            Err(e) => return println!("[warn] no quote for {ticker}: {e}"),
        };
        let mut quote = Quote::default();
        let mut sent = tokio::time::Instant::now() - QUOTE_EVERY;
        let mut pending = false;
        loop {
            tokio::select! {
                item = sub.next() => match item {
                    Some(Ok(SubscriptionItem::Data(tick))) => pending |= quote.apply(&tick),
                    Some(Ok(SubscriptionItem::Notice(_))) => {}
                    Some(Err(e)) => return println!("[warn] quote of {ticker} stopped: {e}"),
                    None => return,
                },
                _ = tokio::time::sleep_until(sent + QUOTE_EVERY), if pending => {
                    self.out().notify("broker.quote", json!({ "ticker": ticker, "bid": quote.bid, "ask": quote.ask, "last": quote.last }));
                    pending = false;
                    sent = tokio::time::Instant::now();
                }
            }
        }
    }
}

impl Ibkr {
    // ── Chart quotes (datafeed) ────────────────────────────────────────────

    /// `data.subscribe`: the whole set of chart tickers to send `data.quote` for.
    pub fn stream(self: &Arc<Self>, tickers: Vec<String>) {
        *lock(&self.streamed) = tickers;
        if let Ok(conn) = self.current() {
            self.sync_streams(&conn);
        }
    }

    fn sync_streams(self: &Arc<Self>, conn: &Arc<Conn>) {
        let wanted: HashSet<String> = lock(&self.streamed).iter().cloned().collect();
        let mut feeds = lock(&conn.streams);
        feeds.retain(|t, h| {
            let keep = wanted.contains(t);
            if !keep {
                h.abort();
            }
            keep
        });
        for ticker in wanted {
            if feeds.contains_key(&ticker) {
                continue;
            }
            let me = self.clone();
            let c = conn.clone();
            let t = ticker.clone();
            feeds.insert(ticker, tokio::spawn(async move { me.run_stream(c, t).await }));
        }
    }

    /// A chart symbol's quote: its ticks folded into the price, the forming minute and the day, sent at most every
    /// `QUOTE_EVERY`.
    async fn run_stream(self: Arc<Self>, conn: Arc<Conn>, ticker: String) {
        let s = match self.data.resolve(&conn.client, &ticker).await {
            Ok(s) => s,
            Err(e) => return println!("[warn] no quote for {}:{ticker}: {}", crate::EXCHANGE, e.message),
        };
        let mut sub = match conn.client.quotes(&s.contract).await {
            Ok(f) => f,
            Err(e) => return println!("[warn] no quote for {}:{ticker}: {e}", crate::EXCHANGE),
        };
        let mut live = Live::new(s.tz, s.kind == crate::datafeed::Kind::Forex);
        let mut sent = tokio::time::Instant::now() - QUOTE_EVERY;
        let mut pending = false;
        loop {
            tokio::select! {
                item = sub.next() => match item {
                    Some(Ok(SubscriptionItem::Data(tick))) => pending |= live.apply(&tick, chrono::Utc::now().timestamp()),
                    Some(Ok(SubscriptionItem::Notice(_))) => {}
                    Some(Err(e)) => return println!("[warn] quote of {}:{ticker} stopped: {e}", crate::EXCHANGE),
                    None => return,
                },
                _ = tokio::time::sleep_until(sent + QUOTE_EVERY), if pending => {
                    if let Some(q) = live.quote(&ticker, chrono::Utc::now().timestamp()) {
                        self.out().notify("data.quote", q);
                    }
                    pending = false;
                    sent = tokio::time::Instant::now();
                }
            }
        }
    }

    // ── DOM order books ────────────────────────────────────────────────────

    /// `broker.watchDepth`: the whole set of tickers to send `broker.depth` for.
    pub fn watch_depth(self: &Arc<Self>, tickers: Vec<String>) {
        *lock(&self.watched_depth) = tickers;
        if let Ok(conn) = self.current() {
            self.sync_depths(&conn);
        }
    }

    fn sync_depths(self: &Arc<Self>, conn: &Arc<Conn>) {
        let wanted: HashSet<String> = lock(&self.watched_depth).iter().cloned().collect();
        let mut feeds = lock(&conn.depths);
        // A finished feed (refused, halted) is asked again only when the DOM watches its ticker anew.
        feeds.retain(|t, h| {
            let keep = wanted.contains(t);
            if !keep {
                h.abort();
            }
            keep
        });
        for ticker in wanted {
            if feeds.contains_key(&ticker) {
                continue;
            }
            let me = self.clone();
            let c = conn.clone();
            let t = ticker.clone();
            feeds.insert(ticker, tokio::spawn(async move { me.run_depth(c, t).await }));
        }
    }

    /// The order book of a ticker: IB's rows applied as they come, sent whole at most every `QUOTE_EVERY`.
    async fn run_depth(self: Arc<Self>, conn: Arc<Conn>, ticker: String) {
        let refused = |e: String| {
            println!("[warn] no order book for {ticker}: {e}");
            self.store.update(|t| t.notice("warn", format!("No order book for {ticker}: {e}")));
        };
        let contract = match self.contract_for(&conn, &ticker).await {
            Ok(c) => c,
            Err(e) => return refused(e),
        };
        let mut sub = match conn.client.depth(&contract, DEPTH_ROWS).await {
            Ok(s) => s,
            Err(e) => return refused(e),
        };
        let mut book = Book::default();
        let mut sent = tokio::time::Instant::now() - QUOTE_EVERY;
        let mut pending = false;
        loop {
            tokio::select! {
                item = sub.next() => match item {
                    Some(Ok(SubscriptionItem::Data(row))) => pending |= book.apply(&row),
                    Some(Ok(SubscriptionItem::Notice(_))) => {}
                    Some(Err(e)) => {
                        // The book stopped (halted): the DOM must not show it as current.
                        self.out().notify("broker.depth", json!({ "ticker": ticker, "snapshot": true, "bids": [], "asks": [] }));
                        return refused(e.to_string());
                    }
                    None => return,
                },
                _ = tokio::time::sleep_until(sent + QUOTE_EVERY), if pending => {
                    let (bids, asks) = book.levels();
                    self.out().notify("broker.depth", json!({ "ticker": ticker, "snapshot": true, "bids": bids, "asks": asks }));
                    pending = false;
                    sent = tokio::time::Instant::now();
                }
            }
        }
    }
}

const ENABLE_API: &str = "Start IB Gateway or TWS, log in, and enable the API: Configure > Settings > API > Settings, tick \
\"Enable ActiveX and Socket Clients\", set the socket port to the plugin's port and allow 127.0.0.1. Retrying.";

fn connect_error(e: &IbError, cfg: &Config) -> String {
    let address = match &cfg.connection {
        Connection::Gateway { host, port } => format!("{host}:{port}"),
        Connection::Direct(_) => String::new(),
    };
    match e {
        IbError::Io(_) | IbError::ConnectionFailed | IbError::ConnectionReset => {
            format!("IB Gateway / TWS not reachable at {address}. {ENABLE_API}")
        }
        IbError::ConnectionRejected(m) => format!("IB Gateway / TWS at {address} refused the connection: {m}"),
        IbError::ServerVersion(..) => "This IB Gateway / TWS is too old: install version 10.40 or newer.".into(),
        IbError::Notice(n) if n.code == 326 => {
            format!("Client ID {} is already in use on {address}: pick another client ID in the plugin's settings.", cfg.client_id)
        }
        other => format!("Connection to IB Gateway / TWS at {address} failed: {other}"),
    }
}

/// Next item of an optional feed; pending forever when there is none.
async fn next_of<T>(sub: &mut Option<Feed<T>>) -> Option<crate::link::Item<T>> {
    match sub {
        Some(s) => s.next().await,
        None => std::future::pending().await,
    }
}

fn non_empty(s: &str) -> Option<String> {
    let s = s.trim();
    (!s.is_empty()).then(|| s.to_string())
}

/// The row of an order as sent or as the broker reports it.
fn order_row(key: String, order_id: i32, client_id: i32, c: &Contract, o: &IbOrder, status: OrderStatus, mine: bool) -> OrdRow {
    let order_type = orders::type_of(&o.order_type);
    let (limit, stop) = orders::prices_of(order_type, o.limit_price, o.aux_price);
    OrdRow {
        key,
        order_id,
        perm_id: o.perm_id,
        client_id,
        parent_id: o.parent_id,
        parent_perm: o.parent_perm_id.unwrap_or(0),
        oca_group: o.oca_group.clone(),
        oca_type: o.oca_type,
        account: o.account.clone(),
        contract_id: c.contract_id,
        ticker: symbols::ticker_of(c),
        side: orders::side_of(&o.action),
        order_type,
        qty: o.total_quantity,
        filled: orders::finite(Some(o.filled_quantity)).unwrap_or(0.0).max(0.0),
        limit,
        stop,
        avg_fill: None,
        status,
        tif: o.tif.clone(),
        outside_rth: o.outside_rth,
        message: None,
        mine,
        detached: false,
        updated_ms: orders::now_ms(),
    }
}

/// A fill. New fills of the live stream are told to the user; the ones read back at connection are not.
fn apply_execution(t: &mut Tables, c: &Contract, e: &ibapi::orders::Execution, live: bool) {
    let side = match e.side {
        ExecutionSide::Bought => Side::Buy,
        ExecutionSide::Sold => Side::Sell,
    };
    let order = t.orders.values().find(|o| (e.perm_id != 0 && o.perm_id == e.perm_id) || (o.order_id == e.order_id && o.order_id != 0 && o.client_id == e.client_id));
    let order_id = order.map(|o| o.key.clone()).or_else(|| (e.perm_id != 0).then(|| format!("p{}", e.perm_id)));
    let order_type = order.map_or(OrderType::Market, |o| o.order_type);
    let prev = t.executions.get(&e.execution_id);
    let fresh = prev.is_none_or(|p| p.exec.qty == 0.0);
    let exec = Execution {
        id: e.execution_id.clone(),
        order_id,
        ticker: symbols::ticker_of(c),
        side,
        qty: e.shares,
        price: e.price,
        time_ms: orders::parse_time(&e.time).unwrap_or_else(orders::now_ms),
        commission: prev.and_then(|p| p.exec.commission),
        realized_pnl: prev.and_then(|p| p.exec.realized_pnl),
    };
    // Only a fill of the last minute is news (a fill the broker sends again after a reconnection is not).
    if live && fresh && exec.time_ms > orders::now_ms() - 60_000.0 {
        t.event(BrokerEvent {
            kind: "executed".into(),
            ticker: exec.ticker.clone(),
            side,
            order_type,
            qty: e.shares,
            price: Some(e.price),
            message: None,
        });
    }
    t.executions.insert(exec.id.clone(), crate::state::ExecRow { exec, account: e.account_number.clone(), perm_id: e.perm_id });
}

/// A fill's commission and realized P&L, which come after it (or, rarely, before).
fn apply_commission(t: &mut Tables, exec_id: &str, commission: f64, realized: Option<f64>) {
    let row = t.executions.entry(exec_id.to_string()).or_insert_with(|| crate::state::ExecRow {
        exec: Execution {
            id: exec_id.to_string(),
            order_id: None,
            ticker: String::new(),
            side: Side::Buy,
            qty: 0.0,
            price: 0.0,
            time_ms: orders::now_ms(),
            commission: None,
            realized_pnl: None,
        },
        account: String::new(),
        perm_id: 0,
    });
    row.exec.commission = orders::finite(Some(commission));
    row.exec.realized_pnl = orders::finite(realized);
}

/// The order ticket's bid / ask / last.
#[derive(Default)]
struct Quote {
    bid: Option<f64>,
    ask: Option<f64>,
    last: Option<f64>,
}

impl Quote {
    /// Fold a tick in; true when bid, ask or last changed.
    fn apply(&mut self, tick: &TickTypes) -> bool {
        let (tt, price) = match tick {
            TickTypes::Price(t) => (&t.tick_type, t.price),
            TickTypes::PriceSize(t) => (&t.price_tick_type, t.price),
            _ => return false,
        };
        let slot = match tt {
            TickType::Bid | TickType::DelayedBid => &mut self.bid,
            TickType::Ask | TickType::DelayedAsk => &mut self.ask,
            TickType::Last | TickType::DelayedLast => &mut self.last,
            _ => return false,
        };
        let p = orders::positive(Some(price));
        if p.is_none() || *slot == p {
            return false;
        }
        *slot = p;
        true
    }
}

/// An order book as IB updates it: rows by position on each side (0 the best), inserted, updated and deleted.
#[derive(Default)]
struct Book {
    bids: Vec<(f64, f64)>,
    asks: Vec<(f64, f64)>,
}

impl Book {
    /// Fold a row in; true when the book changed.
    fn apply(&mut self, m: &MarketDepths) -> bool {
        let (position, operation, side, price, size) = match m {
            MarketDepths::MarketDepth(d) => (d.position, d.operation, d.side, d.price, d.size),
            MarketDepths::MarketDepthL2(d) => (d.position, d.operation, d.side, d.price, d.size),
            MarketDepths::Reset => {
                self.bids.clear();
                self.asks.clear();
                return true;
            }
        };
        let rows = if side == 1 { &mut self.bids } else { &mut self.asks };
        let at = position.max(0) as usize;
        match operation {
            0 => rows.insert(at.min(rows.len()), (price, size)),
            1 if at < rows.len() => rows[at] = (price, size),
            1 => rows.push((price, size)),
            2 if at < rows.len() => {
                rows.remove(at);
            }
            _ => return false,
        }
        true
    }

    /// Each side's levels, best first: rows at one price add up (smart depth lists each venue on its own row).
    fn levels(&self) -> (Vec<serde_json::Value>, Vec<serde_json::Value>) {
        fn side(rows: &[(f64, f64)], best_high: bool) -> Vec<serde_json::Value> {
            let mut by_price: Vec<(f64, f64)> = Vec::new();
            for &(price, size) in rows {
                if !(price > 0.0 && size > 0.0 && price.is_finite() && size.is_finite()) {
                    continue;
                }
                match by_price.iter_mut().find(|(p, _)| *p == price) {
                    Some(l) => l.1 += size,
                    None => by_price.push((price, size)),
                }
            }
            by_price.sort_by(|a, b| if best_high { b.0.total_cmp(&a.0) } else { a.0.total_cmp(&b.0) });
            by_price.into_iter().map(|(price, qty)| json!({ "price": price, "qty": qty })).collect()
        }
        (side(&self.bids, true), side(&self.asks, false))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ibapi::market_data::realtime::{MarketDepth, MarketDepthL2};

    #[test]
    fn book_applies_ib_rows_and_adds_up_venues() {
        let row = |position, operation, side, price, size| MarketDepths::MarketDepth(MarketDepth { position, operation, side, price, size });
        let mut b = Book::default();
        for r in [row(0, 0, 1, 1.0974, 2.0e6), row(1, 0, 1, 1.0973, 3.0e6), row(0, 0, 0, 1.0975, 1.0e6), row(0, 1, 1, 1.0974, 2.5e6)] {
            assert!(b.apply(&r));
        }
        let venue = MarketDepthL2 { position: 2, market_maker: "MEMX".into(), operation: 0, side: 1, price: 1.0973, size: 1.0e6, smart_depth: true };
        assert!(b.apply(&MarketDepths::MarketDepthL2(venue)));
        let (bids, asks) = b.levels();
        assert_eq!(bids, vec![json!({ "price": 1.0974, "qty": 2.5e6 }), json!({ "price": 1.0973, "qty": 4.0e6 })]);
        assert_eq!(asks, vec![json!({ "price": 1.0975, "qty": 1.0e6 })]);
        assert!(b.apply(&row(0, 2, 1, 0.0, 0.0)));
        assert_eq!(b.levels().0.len(), 1);
        assert!(b.apply(&MarketDepths::Reset));
        assert!(b.levels().0.is_empty() && b.levels().1.is_empty());
    }

    #[test]
    fn settings_read_with_defaults() {
        let s: HashMap<String, String> = [("port", "7497"), ("clientId", " 3 "), ("host", "")].iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        let c = Config::from_settings(&s, None).unwrap();
        assert_eq!(c, Config { connection: Connection::Gateway { host: "127.0.0.1".into(), port: 7497 }, client_id: 3 });
        assert_eq!(Config::from_settings(&HashMap::new(), None).unwrap().target(), "IB Gateway / TWS at 127.0.0.1:4002");
        let bad: HashMap<String, String> = [("clientId".to_string(), "x".to_string())].into();
        assert!(Config::from_settings(&bad, None).unwrap_err().contains("Client ID"));
    }

    #[test]
    fn direct_login_settings() {
        let settings = |pairs: &[(&str, &str)]| -> HashMap<String, String> { pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect() };
        let missing = Config::from_settings(&settings(&[("connection", "direct"), ("username", "jo")]), None);
        assert!(missing.unwrap_err().contains("password"));
        let s = settings(&[("connection", "direct"), ("username", " jo "), ("password", " p w "), ("account", "live"), ("secondFactor", "code")]);
        let c = Config::from_settings(&s, Some(PathBuf::from("data"))).unwrap();
        let Connection::Direct(login) = &c.connection else { panic!("not a direct login") };
        assert_eq!((login.username.as_str(), login.password.as_str(), login.live, login.typed_code), ("jo", " p w ", true, true));
        assert_eq!(login.server, direct::DEFAULT_SERVER);
        assert_eq!(login.restart_token.as_deref(), Some(direct::restart_token_file(std::path::Path::new("data"), "jo", true).as_path()));
        // Neither the password nor the username is in what the plugin says.
        assert_eq!(c.target(), "Interactive Brokers (direct live login)");
    }
}
