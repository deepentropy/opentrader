/*
 * The direct login: the plugin logs in to the broker's servers itself through the ibx engine, with no IB Gateway or
 * TWS. ibx answers as the socket API does, through callbacks; this module turns them into the socket API client's
 * types and feeds (`link`), so the rest of the plugin is the same in both modes.
 *
 * One thread runs ibx's `process_msgs` and routes each callback by its request id: to the feed that asked for it, to
 * the list being read, to the order updates (order ids and new fills) or to the connection's notices. Requests are
 * sent from blocking threads: ibx may hold one for its pacing.
 */
use crate::link::{Item, EXECUTION_DAYS, LIST_TIMEOUT};
use crate::prompt::{Prompt, Prompts};
use ibapi::accounts::{AccountPortfolioValue, AccountSummary, AccountSummaryResult, AccountUpdate, AccountValue, PnL, PnLSingle};
use ibapi::contracts::tick_types::TickType;
use ibapi::contracts::{Contract, ContractDetails};
use ibapi::market_data::realtime::{MarketDepth, MarketDepthL2, MarketDepths, TickPrice, TickTypes};
use ibapi::orders::{
    Action, CommissionReport, Execution, ExecutionData, ExecutionSide, Executions, Order, OrderData, OrderState, OrderStatus,
    OrderStatusKind, OrderUpdate, Orders, TimeInForce,
};
use ibapi::subscriptions::SubscriptionItem;
use ibapi::{Error as IbError, Notice, NoticeCategory};
use ibx::api::types as x;
use ibx::api::{EClient, EClientConfig, Wrapper};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

/// The login server; the broker sends a login elsewhere when the account lives on another server.
pub const DEFAULT_SERVER: &str = "cdc1.ibllc.com";
/// ibx has no wait for its next message: the dispatch thread looks this often.
const POLL: Duration = Duration::from_millis(5);
/// A live login waiting this long is waiting for the phone's approval: the user is told.
const APPROVAL_NOTICE_AFTER: Duration = Duration::from_secs(3);
/// Request ids start far above order ids: the broker's notices share one id space.
const FIRST_REQUEST_ID: i64 = 1_000_000_000;
const MARKET_DEPTH_RESET: i64 = 317;

/// A direct login's settings.
#[derive(Clone, PartialEq, Eq)]
pub struct Login {
    pub username: String,
    pub password: String,
    pub live: bool,
    pub server: String,
    /// The second factor is a code typed in the app, not the phone's approval.
    pub typed_code: bool,
    /// Where the login keeps its restart token, so the daily reconnect and the next start need no password.
    pub restart_token: Option<PathBuf>,
}

impl std::fmt::Debug for Login {
    /// Without the password: the settings may be logged.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Login").field("username", &self.username).field("live", &self.live).field("server", &self.server).finish_non_exhaustive()
    }
}

/// The restart token's file of a login in the plugin's data folder.
pub fn restart_token_file(dir: &Path, username: &str, live: bool) -> PathBuf {
    let user: String = username.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '_' }).collect();
    dir.join(format!("restart-token-{}-{user}", if live { "live" } else { "paper" }))
}

/// Log in and start the dispatch thread. The receiver gives the connection's notices and ends with the session.
pub async fn connect(login: &Login, client_id: i32, prompts: &Arc<Prompts>) -> Result<(Arc<Direct>, mpsc::UnboundedReceiver<Notice>), String> {
    let config = EClientConfig {
        username: login.username.clone(),
        password: login.password.clone(),
        host: login.server.clone(),
        paper: !login.live,
        core_id: None,
        client_id,
        copied_waits: false,
        code_provider: login.typed_code.then(|| code_provider(prompts.clone())),
        restart_token_file: login.restart_token.clone(),
    };
    if let Some(dir) = login.restart_token.as_deref().and_then(Path::parent) {
        let _ = std::fs::create_dir_all(dir);
    }
    // A live login without a typed code waits for the phone's approval; a quick one (restart token) shows nothing.
    let approval = (login.live && !login.typed_code).then(|| {
        let prompts = prompts.clone();
        tokio::spawn(async move {
            tokio::time::sleep(APPROVAL_NOTICE_AFTER).await;
            prompts.show(&Prompt {
                title: "Approve the login".into(),
                message: "Interactive Brokers sent a login request to IBKR Mobile on your phone: approve it there.".into(),
                ..Default::default()
            })
        })
    });
    let result = tokio::task::spawn_blocking(move || EClient::connect(&config).map_err(|e| e.to_string())).await;
    if let Some(task) = approval {
        task.abort();
        if let Ok(id) = task.await {
            prompts.done(&id);
        }
    }
    let client = match result {
        Ok(Ok(c)) => Arc::new(c),
        Ok(Err(e)) if e.contains("SRP Authentication FAILED") => {
            return Err("Interactive Brokers refused the login: check the username and password in the plugin's settings".into())
        }
        Ok(Err(e)) => return Err(format!("Direct login to Interactive Brokers failed: {e}")),
        Err(e) => return Err(format!("Direct login to Interactive Brokers failed: {e}")),
    };
    let (notices_tx, notices) = mpsc::unbounded_channel();
    let routes = Arc::new(Mutex::new(Routes { notices: Some(notices_tx), ..Default::default() }));
    let stop = Arc::new(AtomicBool::new(false));
    let thread = {
        let (client, routes, stop) = (client.clone(), routes.clone(), stop.clone());
        std::thread::Builder::new()
            .name("ibx-dispatch".into())
            .spawn(move || {
                let mut router = Router { routes };
                while !stop.load(Ordering::SeqCst) {
                    client.process_msgs(&mut router);
                    std::thread::sleep(POLL);
                }
            })
            .map_err(|e| e.to_string())?
    };
    Ok((
        Arc::new(Direct { client, routes, stop, next_request: AtomicI64::new(FIRST_REQUEST_ID), thread: Mutex::new(Some(thread)) }),
        notices,
    ))
}

/// The second factor typed in the app: asked when the server sends its challenge.
fn code_provider(prompts: Arc<Prompts>) -> ibx::auth::session::CodeProvider {
    Arc::new(move |c: ibx::auth::session::IbKeyChallenge| {
        let message = if !c.image.is_empty() {
            "Look up the two indexes shown on your security code card and type their values one after the other.".to_string()
        } else if !c.display_id.is_empty() && c.kind.is_empty() {
            format!("In IBKR Mobile, open Authenticate, enter the challenge {} and type the response code here.", c.display_id)
        } else if !c.message.trim().is_empty() {
            c.message.trim().to_string()
        } else {
            "Type the login code Interactive Brokers sent you.".to_string()
        };
        let prompt = Prompt { title: "Interactive Brokers login code".into(), message, input: Some("text"), image: c.image.clone() };
        prompts
            .ask(&prompt)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::Interrupted, "the login code was not given"))
    })
}

type Tx<T> = mpsc::UnboundedSender<Item<T>>;
/// A list being read and where it goes once whole.
type Reading<T, R = Vec<T>> = (Vec<T>, oneshot::Sender<R>);

/// Where each callback goes.
#[derive(Default)]
struct Routes {
    notices: Option<mpsc::UnboundedSender<Notice>>,
    orders: Option<Tx<OrderUpdate>>,
    accounts: Option<oneshot::Sender<Vec<String>>>,
    /// The account whose updates are subscribed.
    account: Option<(String, Tx<AccountUpdate>)>,
    pnl: HashMap<i64, Tx<PnL>>,
    pnl_single: HashMap<i64, Tx<PnLSingle>>,
    summary: HashMap<i64, Tx<AccountSummaryResult>>,
    quotes: HashMap<i64, Tx<TickTypes>>,
    depth: HashMap<i64, Tx<MarketDepths>>,
    details: HashMap<i64, Reading<ContractDetails, Result<Vec<ContractDetails>, IbError>>>,
    open_orders: Option<Reading<Orders>>,
    completed_orders: Option<Reading<Orders>>,
    executions: HashMap<i64, Reading<Executions>>,
    /// Order id → the cancel waiting for the broker's first answer.
    cancels: HashMap<i64, oneshot::Sender<Notice>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// A direct feed: its items, cancelled when dropped.
pub struct Feed<T> {
    rx: mpsc::UnboundedReceiver<Item<T>>,
    cancel: Option<Box<dyn FnOnce() + Send>>,
}

impl<T> Feed<T> {
    pub async fn next(&mut self) -> Option<Item<T>> {
        self.rx.recv().await
    }
}

impl<T> Drop for Feed<T> {
    fn drop(&mut self) {
        if let Some(cancel) = self.cancel.take() {
            cancel();
        }
    }
}

pub struct Direct {
    client: Arc<EClient>,
    routes: Arc<Mutex<Routes>>,
    stop: Arc<AtomicBool>,
    next_request: AtomicI64,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}

/// ibx's requests that take a wrapper answer later through `process_msgs`; they don't use the one given.
struct Unused;
impl Wrapper for Unused {}

impl Direct {
    fn request_id(&self) -> i64 {
        self.next_request.fetch_add(1, Ordering::SeqCst)
    }

    /// Run an ibx call on a blocking thread.
    async fn call<R: Send + 'static>(&self, f: impl FnOnce(&EClient) -> R + Send + 'static) -> Result<R, String> {
        let client = self.client.clone();
        tokio::task::spawn_blocking(move || f(&client)).await.map_err(|e| e.to_string())
    }

    /// A feed whose cancel runs `cancel` on the client and forgets the route.
    fn feed<T: Send + 'static>(
        &self,
        rx: mpsc::UnboundedReceiver<Item<T>>,
        forget: impl FnOnce(&mut Routes) + Send + 'static,
        cancel: impl FnOnce(&EClient) + Send + 'static,
    ) -> Feed<T> {
        let (client, routes) = (self.client.clone(), self.routes.clone());
        Feed {
            rx,
            cancel: Some(Box::new(move || {
                forget(&mut lock(&routes));
                // Off the async thread: ibx may hold a request for its pacing.
                std::thread::spawn(move || cancel(&client));
            })),
        }
    }

    pub async fn managed_accounts(&self) -> Result<Vec<String>, String> {
        let (tx, rx) = oneshot::channel();
        lock(&self.routes).accounts = Some(tx);
        self.call(|c| c.req_managed_accts(&mut Unused)).await?;
        match tokio::time::timeout(LIST_TIMEOUT, rx).await {
            Ok(Ok(list)) if !list.is_empty() => Ok(list),
            _ => Ok(vec![self.client.account_id.clone()].into_iter().filter(|a| !a.is_empty()).collect()),
        }
    }

    pub fn prefer_delayed(&self) {
        // 3: delayed where the account has no real-time data.
        self.client.req_market_data_type(3);
    }

    pub fn is_connected(&self) -> bool {
        self.client.is_connected()
    }

    pub async fn disconnect(&self) {
        self.stop.store(true, Ordering::SeqCst);
        let thread = lock(&self.thread).take();
        let client = self.client.clone();
        let _ = tokio::task::spawn_blocking(move || {
            if let Some(t) = thread {
                let _ = t.join();
            }
            client.disconnect();
        })
        .await;
    }

    pub fn order_updates(&self) -> Feed<OrderUpdate> {
        let (tx, rx) = mpsc::unbounded_channel();
        lock(&self.routes).orders = Some(tx);
        Feed { rx, cancel: None }
    }

    pub fn account_updates(&self, account: &str) -> Feed<AccountUpdate> {
        let (tx, rx) = mpsc::unbounded_channel();
        let previous = lock(&self.routes).account.replace((account.to_string(), tx));
        let (client, acct) = (self.client.clone(), account.to_string());
        std::thread::spawn(move || {
            if let Some((old, _)) = previous.filter(|(old, _)| *old != acct) {
                client.req_account_updates(false, &old);
            }
            client.req_account_updates(true, &acct);
        });
        let acct = account.to_string();
        let mine = acct.clone();
        self.feed(
            rx,
            move |r| {
                if r.account.as_ref().is_some_and(|(a, _)| *a == mine) {
                    r.account = None;
                }
            },
            move |c| c.req_account_updates(false, &acct),
        )
    }

    pub fn pnl(&self, account: &str) -> Feed<PnL> {
        let id = self.request_id();
        let (tx, rx) = mpsc::unbounded_channel();
        lock(&self.routes).pnl.insert(id, tx);
        let (client, acct) = (self.client.clone(), account.to_string());
        std::thread::spawn(move || client.req_pnl(id, &acct, ""));
        self.feed(rx, move |r| drop(r.pnl.remove(&id)), move |c| c.cancel_pnl(id))
    }

    pub fn pnl_single(&self, account: &str, contract_id: i32) -> Feed<PnLSingle> {
        let id = self.request_id();
        let (tx, rx) = mpsc::unbounded_channel();
        lock(&self.routes).pnl_single.insert(id, tx);
        let (client, acct) = (self.client.clone(), account.to_string());
        std::thread::spawn(move || client.req_pnl_single(id, &acct, "", i64::from(contract_id)));
        self.feed(rx, move |r| drop(r.pnl_single.remove(&id)), move |c| c.cancel_pnl_single(id))
    }

    pub fn account_summary(&self, tags: &[&str]) -> Feed<AccountSummaryResult> {
        let id = self.request_id();
        let (tx, rx) = mpsc::unbounded_channel();
        lock(&self.routes).summary.insert(id, tx);
        let (client, tags) = (self.client.clone(), tags.join(","));
        std::thread::spawn(move || client.req_account_summary(id, "All", &tags));
        self.feed(rx, move |r| drop(r.summary.remove(&id)), move |c| c.cancel_account_summary(id))
    }

    pub async fn orders(&self, completed: bool) -> Result<Vec<Orders>, String> {
        let (tx, rx) = oneshot::channel();
        {
            let mut r = lock(&self.routes);
            let slot = if completed { &mut r.completed_orders } else { &mut r.open_orders };
            *slot = Some((Vec::new(), tx));
        }
        self.call(move |c| if completed { c.req_completed_orders(&mut Unused) } else { c.req_all_open_orders(&mut Unused) }).await?;
        match tokio::time::timeout(LIST_TIMEOUT, rx).await {
            Ok(Ok(list)) => Ok(list),
            _ => {
                let mut r = lock(&self.routes);
                let slot = if completed { &mut r.completed_orders } else { &mut r.open_orders };
                *slot = None;
                Err("the list did not come whole in time".into())
            }
        }
    }

    pub async fn executions(&self) -> Result<Vec<Executions>, String> {
        let id = self.request_id();
        let (tx, rx) = oneshot::channel();
        lock(&self.routes).executions.insert(id, (Vec::new(), tx));
        let since = chrono::Utc::now() - chrono::Duration::days(i64::from(EXECUTION_DAYS));
        let filter = x::ExecutionFilter { time: since.format("%Y%m%d-%H:%M:%S").to_string(), ..Default::default() };
        self.call(move |c| c.req_executions(id, &filter, &mut Unused)).await?;
        match tokio::time::timeout(LIST_TIMEOUT, rx).await {
            Ok(Ok(list)) => Ok(list),
            _ => {
                lock(&self.routes).executions.remove(&id);
                Err("the executions did not come whole in time".into())
            }
        }
    }

    pub async fn contract_details(&self, query: &Contract) -> Result<Vec<ContractDetails>, IbError> {
        let id = self.request_id();
        let (tx, rx) = oneshot::channel();
        lock(&self.routes).details.insert(id, (Vec::new(), tx));
        let contract = to_contract(query);
        let sent = self.call(move |c| c.req_contract_details(id, &contract)).await;
        if let Err(e) | Ok(Err(e)) = sent {
            lock(&self.routes).details.remove(&id);
            return Err(IbError::Simple(e));
        }
        match tokio::time::timeout(LIST_TIMEOUT, rx).await {
            Ok(Ok(answer)) => answer,
            _ => {
                lock(&self.routes).details.remove(&id);
                Err(IbError::Simple("The contract lookup got no answer in time".into()))
            }
        }
    }

    pub async fn next_order_id(&self) -> i32 {
        self.call(|c| c.next_order_id()).await.map_or(0, |id| i32::try_from(id).unwrap_or_default())
    }

    pub async fn submit_order(&self, contract: &Contract, order: &Order) -> Result<(), String> {
        let (contract, order) = (to_contract(contract), to_order(order));
        self.call(move |c| c.place_order(order.order_id, &contract, &order)).await?
    }

    pub async fn cancel_order(&self, order_id: i32) -> Result<Option<String>, String> {
        let id = i64::from(order_id);
        let (tx, rx) = oneshot::channel();
        lock(&self.routes).cancels.insert(id, tx);
        if let Err(e) = self.call(move |c| c.cancel_order(id, "")).await.and_then(|r| r) {
            lock(&self.routes).cancels.remove(&id);
            return Err(e);
        }
        let first = tokio::time::timeout(Duration::from_secs(4), rx).await;
        lock(&self.routes).cancels.remove(&id);
        Ok(match first {
            Ok(Ok(n)) if crate::link::refuses(&n) => Some(n.message),
            _ => None,
        })
    }

    pub async fn quotes(&self, contract: &Contract) -> Result<Feed<TickTypes>, String> {
        let id = self.request_id();
        let (tx, rx) = mpsc::unbounded_channel();
        lock(&self.routes).quotes.insert(id, tx);
        let contract = to_contract(contract);
        if let Err(e) = self.call(move |c| c.req_mkt_data(id, &contract, "", false, false)).await.and_then(|r| r) {
            lock(&self.routes).quotes.remove(&id);
            return Err(e);
        }
        Ok(self.feed(rx, move |r| drop(r.quotes.remove(&id)), move |c| drop(c.cancel_mkt_data(id))))
    }

    pub async fn depth(&self, contract: &Contract, rows: i32, smart: bool) -> Result<Feed<MarketDepths>, String> {
        let id = self.request_id();
        let (tx, rx) = mpsc::unbounded_channel();
        lock(&self.routes).depth.insert(id, tx);
        let contract = to_contract(contract);
        if let Err(e) = self.call(move |c| c.req_mkt_depth(id, &contract, rows, smart)).await.and_then(|r| r) {
            lock(&self.routes).depth.remove(&id);
            return Err(e);
        }
        Ok(self.feed(rx, move |r| drop(r.depth.remove(&id)), move |c| drop(c.cancel_mkt_depth(id))))
    }
}

impl Drop for Direct {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

/// The ibx callbacks, routed.
struct Router {
    routes: Arc<Mutex<Routes>>,
}

/// A notice that leaves its subscription running (the socket API client's `SubscriptionItem::Notice`).
fn keeps_running(n: &Notice) -> bool {
    matches!(n.category(), NoticeCategory::Warning | NoticeCategory::DataAdvisory | NoticeCategory::SystemMessage)
}

/// Send a notice to a feed: as an item when the feed goes on, as its last error otherwise (the route is dropped).
fn notice_to<T>(map: &mut HashMap<i64, Tx<T>>, id: i64, n: Notice) {
    if keeps_running(&n) {
        if let Some(tx) = map.get(&id) {
            let _ = tx.send(Ok(SubscriptionItem::Notice(n)));
        }
    } else if let Some(tx) = map.remove(&id) {
        let _ = tx.send(Err(IbError::Notice(n)));
    }
}

fn data<T>(map: &HashMap<i64, Tx<T>>, id: i64, item: T) {
    if let Some(tx) = map.get(&id) {
        let _ = tx.send(Ok(SubscriptionItem::Data(item)));
    }
}

impl Router {
    fn routes(&self) -> std::sync::MutexGuard<'_, Routes> {
        lock(&self.routes)
    }

    fn order_update(&self, u: OrderUpdate) {
        if let Some(tx) = &self.routes().orders {
            let _ = tx.send(Ok(SubscriptionItem::Data(u)));
        }
    }
}

impl Wrapper for Router {
    fn connection_closed(&mut self) {
        // The session is over: the notices end, and with them the connection (`ib::run_notices`).
        let mut r = self.routes();
        r.notices = None;
        r.orders = None;
    }

    fn managed_accounts(&mut self, accounts_list: &str) {
        if let Some(tx) = self.routes().accounts.take() {
            let _ = tx.send(accounts_list.split(',').map(str::trim).filter(|a| !a.is_empty()).map(String::from).collect());
        }
    }

    fn error(&mut self, req_id: i64, error_code: i64, error_string: &str, advanced_order_reject_json: &str) {
        let n = Notice {
            request_id: (req_id >= 0).then(|| i32::try_from(req_id).ok()).flatten(),
            code: i32::try_from(error_code).unwrap_or(i32::MAX),
            message: error_string.to_string(),
            error_time: None,
            advanced_order_reject_json: advanced_order_reject_json.to_string(),
        };
        let mut r = self.routes();
        if let Some((_, tx)) = r.details.remove(&req_id) {
            let _ = tx.send(Err(IbError::Notice(n)));
        } else if let Some((list, tx)) = r.executions.remove(&req_id) {
            let _ = tx.send(list);
        } else if error_code == MARKET_DEPTH_RESET && r.depth.contains_key(&req_id) {
            data(&r.depth, req_id, MarketDepths::Reset);
        } else if r.depth.contains_key(&req_id) {
            notice_to(&mut r.depth, req_id, n);
        } else if r.quotes.contains_key(&req_id) {
            notice_to(&mut r.quotes, req_id, n);
        } else if r.pnl.contains_key(&req_id) {
            notice_to(&mut r.pnl, req_id, n);
        } else if r.pnl_single.contains_key(&req_id) {
            notice_to(&mut r.pnl_single, req_id, n);
        } else if r.summary.contains_key(&req_id) {
            notice_to(&mut r.summary, req_id, n);
        } else if let Some(tx) = r.cancels.remove(&req_id) {
            let _ = tx.send(n);
        } else if req_id > 0 && req_id < FIRST_REQUEST_ID {
            // An order's notice.
            if let Some(tx) = &r.orders {
                let _ = tx.send(Ok(SubscriptionItem::Notice(n)));
            }
        } else if let Some(tx) = &r.notices {
            let _ = tx.send(n);
        }
    }

    fn tick_price(&mut self, req_id: i64, tick_type: i32, price: f64, _attrib: &x::TickAttrib) {
        let tick = TickTypes::Price(TickPrice { tick_type: TickType::from(tick_type), price, ..Default::default() });
        data(&self.routes().quotes, req_id, tick);
    }

    fn update_mkt_depth(&mut self, req_id: i64, position: i32, operation: i32, side: i32, price: f64, size: f64) {
        data(&self.routes().depth, req_id, MarketDepths::MarketDepth(MarketDepth { position, operation, side, price, size }));
    }

    #[allow(clippy::too_many_arguments)]
    fn update_mkt_depth_l2(
        &mut self,
        req_id: i64,
        position: i32,
        market_maker: &str,
        operation: i32,
        side: i32,
        price: f64,
        size: f64,
        is_smart_depth: bool,
    ) {
        let row = MarketDepthL2 { position, market_maker: market_maker.to_string(), operation, side, price, size, smart_depth: is_smart_depth };
        data(&self.routes().depth, req_id, MarketDepths::MarketDepthL2(row));
    }

    fn update_account_value(&mut self, key: &str, value: &str, currency: &str, account_name: &str) {
        let r = self.routes();
        if let Some((account, tx)) = &r.account {
            if account_name.is_empty() || account_name == account {
                let v = AccountValue { key: key.into(), value: value.into(), currency: currency.into(), account: Some(account_name.into()) };
                let _ = tx.send(Ok(SubscriptionItem::Data(AccountUpdate::AccountValue(v))));
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn update_portfolio(
        &mut self,
        contract: &x::Contract,
        position: f64,
        market_price: f64,
        market_value: f64,
        average_cost: f64,
        unrealized_pnl: f64,
        realized_pnl: f64,
        account_name: &str,
    ) {
        let r = self.routes();
        if let Some((account, tx)) = &r.account {
            if account_name.is_empty() || account_name == account {
                let p = AccountPortfolioValue {
                    contract: from_contract(contract),
                    position,
                    market_price,
                    market_value,
                    average_cost,
                    unrealized_pnl,
                    realized_pnl,
                    account: Some(account_name.into()),
                };
                let _ = tx.send(Ok(SubscriptionItem::Data(AccountUpdate::PortfolioValue(p))));
            }
        }
    }

    fn pnl(&mut self, req_id: i64, daily_pnl: f64, unrealized_pnl: f64, realized_pnl: f64) {
        data(&self.routes().pnl, req_id, PnL { daily_pnl, unrealized_pnl: set(unrealized_pnl), realized_pnl: set(realized_pnl) });
    }

    fn pnl_single(&mut self, req_id: i64, pos: f64, daily_pnl: f64, unrealized_pnl: f64, realized_pnl: f64, value: f64) {
        data(&self.routes().pnl_single, req_id, PnLSingle { position: pos, daily_pnl, unrealized_pnl, realized_pnl, value });
    }

    fn account_summary(&mut self, req_id: i64, account: &str, tag: &str, value: &str, currency: &str) {
        let s = AccountSummary { account: account.into(), tag: tag.into(), value: value.into(), currency: currency.into() };
        data(&self.routes().summary, req_id, AccountSummaryResult::Summary(s));
    }

    fn contract_details(&mut self, req_id: i64, details: &x::ContractDetails) {
        if let Some((list, _)) = self.routes().details.get_mut(&req_id) {
            list.push(from_details(details));
        }
    }

    fn contract_details_end(&mut self, req_id: i64) {
        if let Some((list, tx)) = self.routes().details.remove(&req_id) {
            let _ = tx.send(Ok(list));
        }
    }

    fn open_order(&mut self, order_id: i64, contract: &x::Contract, order: &x::Order, order_state: &x::OrderState) {
        let d = OrderData {
            order_id: i32::try_from(order_id).unwrap_or_default(),
            contract: from_contract(contract),
            order: from_order(order),
            order_state: from_state(order_state),
        };
        let mut r = self.routes();
        match &mut r.open_orders {
            Some((list, _)) => list.push(Orders::OrderData(d)),
            None => {
                drop(r);
                self.order_update(OrderUpdate::OpenOrder(d));
            }
        }
    }

    fn open_order_end(&mut self) {
        if let Some((list, tx)) = self.routes().open_orders.take() {
            let _ = tx.send(list);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn order_status(
        &mut self,
        order_id: i64,
        status: &str,
        filled: f64,
        remaining: f64,
        avg_fill_price: f64,
        perm_id: i64,
        parent_id: i64,
        last_fill_price: f64,
        client_id: i64,
        why_held: &str,
        mkt_cap_price: f64,
    ) {
        let s = OrderStatus {
            order_id: i32::try_from(order_id).unwrap_or_default(),
            status: status.parse().unwrap_or(OrderStatusKind::Unknown(status.into())),
            filled,
            remaining,
            average_fill_price: set(avg_fill_price),
            perm_id,
            parent_id: i32::try_from(parent_id).unwrap_or_default(),
            last_fill_price: set(last_fill_price),
            client_id: i32::try_from(client_id).unwrap_or_default(),
            why_held: why_held.into(),
            market_cap_price: set(mkt_cap_price),
        };
        let mut r = self.routes();
        match &mut r.open_orders {
            Some((list, _)) => list.push(Orders::OrderStatus(s)),
            None => {
                drop(r);
                self.order_update(OrderUpdate::OrderStatus(s));
            }
        }
    }

    fn completed_order(&mut self, contract: &x::Contract, order: &x::Order, order_state: &x::OrderState) {
        if let Some((list, _)) = &mut self.routes().completed_orders {
            list.push(Orders::OrderData(OrderData {
                order_id: i32::try_from(order.order_id).unwrap_or_default(),
                contract: from_contract(contract),
                order: from_order(order),
                order_state: from_state(order_state),
            }));
        }
    }

    fn completed_orders_end(&mut self) {
        if let Some((list, tx)) = self.routes().completed_orders.take() {
            let _ = tx.send(list);
        }
    }

    fn exec_details(&mut self, req_id: i64, contract: &x::Contract, execution: &x::Execution) {
        let d = ExecutionData { request_id: i32::try_from(req_id).unwrap_or(-1), contract: from_contract(contract), execution: from_execution(execution) };
        let mut r = self.routes();
        match r.executions.get_mut(&req_id) {
            Some((list, _)) => list.push(Executions::ExecutionData(d)),
            None => {
                drop(r);
                self.order_update(OrderUpdate::ExecutionData(ExecutionData { request_id: -1, ..d }));
            }
        }
    }

    fn exec_details_end(&mut self, req_id: i64) {
        if let Some((list, tx)) = self.routes().executions.remove(&req_id) {
            let _ = tx.send(list);
        }
    }

    fn commission_and_fees_report(&mut self, report: &x::CommissionAndFeesReport) {
        let c = CommissionReport {
            execution_id: report.exec_id.clone(),
            commission: report.commission_and_fees,
            currency: report.currency.clone(),
            realized_pnl: set(report.realized_pnl),
            yields: set(report.yield_amount),
            yield_redemption_date: report.yield_redemption_date.clone(),
        };
        // An executions list being read takes the commissions that come with it.
        let mut r = self.routes();
        match r.executions.values_mut().next() {
            Some((list, _)) => list.push(Executions::CommissionReport(c)),
            None => {
                drop(r);
                self.order_update(OrderUpdate::CommissionReport(c));
            }
        }
    }
}

// ── Types: ibx's (the official API's field names) and the socket API client's ──

/// ibx and the official API mark an unset number with the largest double.
fn set(v: f64) -> Option<f64> {
    (v.is_finite() && v != f64::MAX).then_some(v)
}

fn unset(v: Option<f64>) -> f64 {
    v.unwrap_or(f64::MAX)
}

pub fn to_contract(c: &Contract) -> x::Contract {
    x::Contract {
        con_id: i64::from(c.contract_id),
        symbol: c.symbol.as_str().to_string(),
        // A contract given by its id alone takes its definition's type.
        sec_type: if c.contract_id != 0 && c.symbol.as_str().is_empty() { String::new() } else { c.security_type.as_str().to_string() },
        exchange: c.exchange.as_str().to_string(),
        currency: c.currency.as_str().to_string(),
        last_trade_date_or_contract_month: c.last_trade_date_or_contract_month.clone(),
        strike: c.strike,
        right: c.right.map(|r| r.as_str().to_string()).unwrap_or_default(),
        multiplier: c.multiplier.clone(),
        local_symbol: c.local_symbol.clone(),
        primary_exchange: c.primary_exchange.as_str().to_string(),
        trading_class: c.trading_class.clone(),
        ..Default::default()
    }
}

pub fn from_contract(c: &x::Contract) -> Contract {
    Contract {
        contract_id: i32::try_from(c.con_id).unwrap_or_default(),
        symbol: c.symbol.as_str().into(),
        security_type: c.sec_type.parse().unwrap_or_default(),
        exchange: c.exchange.as_str().into(),
        currency: c.currency.as_str().into(),
        last_trade_date_or_contract_month: c.last_trade_date_or_contract_month.clone(),
        strike: c.strike,
        multiplier: c.multiplier.clone(),
        local_symbol: c.local_symbol.clone(),
        primary_exchange: c.primary_exchange.as_str().into(),
        trading_class: c.trading_class.clone(),
        ..Default::default()
    }
}

fn from_details(d: &x::ContractDetails) -> ContractDetails {
    ContractDetails {
        contract: from_contract(&d.contract),
        market_name: d.market_name.clone(),
        min_tick: d.min_tick,
        long_name: d.long_name.clone(),
        time_zone_id: d.time_zone_id.clone(),
        stock_type: d.stock_type.clone(),
        min_size: set(d.min_size),
        size_increment: set(d.size_increment),
        suggested_size_increment: set(d.suggested_size_increment),
        ..Default::default()
    }
}

pub fn to_order(o: &Order) -> x::Order {
    x::Order {
        order_id: i64::from(o.order_id),
        action: o.action.as_str().to_string(),
        total_quantity: o.total_quantity,
        order_type: o.order_type.clone(),
        lmt_price: unset(o.limit_price),
        aux_price: unset(o.aux_price),
        tif: o.tif.as_str().to_string(),
        outside_rth: o.outside_rth,
        parent_id: i64::from(o.parent_id),
        oca_group: o.oca_group.clone(),
        oca_type: i32::from(o.oca_type),
        account: o.account.clone(),
        transmit: o.transmit,
        ..Default::default()
    }
}

pub fn from_order(o: &x::Order) -> Order {
    Order {
        order_id: i32::try_from(o.order_id).unwrap_or_default(),
        client_id: o.client_id,
        perm_id: o.perm_id,
        action: o.action.parse().unwrap_or(Action::Buy),
        total_quantity: o.total_quantity,
        order_type: o.order_type.clone(),
        limit_price: set(o.lmt_price),
        aux_price: set(o.aux_price),
        tif: o.tif.parse().unwrap_or(TimeInForce::Day),
        outside_rth: o.outside_rth,
        parent_id: i32::try_from(o.parent_id).unwrap_or_default(),
        parent_perm_id: (o.parent_perm_id != 0 && o.parent_perm_id != i64::MAX).then_some(o.parent_perm_id),
        oca_group: o.oca_group.clone(),
        oca_type: o.oca_type.into(),
        account: o.account.clone(),
        filled_quantity: set(o.filled_quantity).unwrap_or(0.0),
        transmit: o.transmit,
        ..Default::default()
    }
}

fn from_state(s: &x::OrderState) -> OrderState {
    OrderState {
        status: s.status.parse().unwrap_or(OrderStatusKind::Unknown(s.status.clone())),
        reject_reason: s.reject_reason.clone(),
        warning_text: s.warning_text.clone(),
        completed_time: s.completed_time.clone(),
        completed_status: s.completed_status.clone(),
        ..Default::default()
    }
}

fn from_execution(e: &x::Execution) -> Execution {
    Execution {
        order_id: i32::try_from(e.order_id).unwrap_or_default(),
        client_id: i32::try_from(e.client_id).unwrap_or_default(),
        execution_id: e.exec_id.clone(),
        time: e.time.clone(),
        account_number: e.acct_number.clone(),
        exchange: e.exchange.clone(),
        side: if e.side == "SLD" { ExecutionSide::Sold } else { ExecutionSide::Bought },
        shares: e.shares,
        price: e.price,
        perm_id: e.perm_id,
        cumulative_quantity: e.cum_qty,
        average_price: e.avg_price,
        order_reference: e.order_ref.clone(),
        model_code: e.model_code.clone(),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ibapi::contracts::SecurityType;
    use ibapi::orders::OcaType;

    #[test]
    fn orders_round_trip() {
        let o = Order {
            order_id: 7,
            action: Action::Sell,
            total_quantity: 3.0,
            order_type: "STP LMT".into(),
            limit_price: Some(9.5),
            aux_price: Some(10.0),
            tif: TimeInForce::GoodTillCanceled,
            parent_id: 6,
            oca_group: "OT-EXIT-1".into(),
            oca_type: OcaType::ReduceWithBlock,
            account: "DU1".into(),
            transmit: false,
            ..Default::default()
        };
        let sent = to_order(&o);
        assert_eq!((sent.action.as_str(), sent.tif.as_str(), sent.oca_type, sent.parent_id), ("SELL", "GTC", 2, 6));
        let back = from_order(&sent);
        assert_eq!((back.order_id, back.action, back.limit_price, back.aux_price), (7, Action::Sell, Some(9.5), Some(10.0)));
        assert_eq!((back.oca_type, back.tif, back.parent_perm_id), (OcaType::ReduceWithBlock, TimeInForce::GoodTillCanceled, None));
        let market = to_order(&Order { order_type: "MKT".into(), ..Default::default() });
        assert_eq!((market.lmt_price, market.aux_price), (f64::MAX, f64::MAX));
    }

    #[test]
    fn contracts_round_trip() {
        let mut c = Contract::stock("BRK B").build();
        c.primary_exchange = "NYSE".into();
        let sent = to_contract(&c);
        assert_eq!((sent.symbol.as_str(), sent.sec_type.as_str(), sent.exchange.as_str(), sent.currency.as_str()), ("BRK B", "STK", "SMART", "USD"));
        let back = from_contract(&x::Contract { con_id: 72063691, local_symbol: "BRK B".into(), ..sent });
        assert_eq!((back.contract_id, back.security_type, back.primary_exchange.as_str()), (72063691, SecurityType::Stock, "NYSE"));
    }

    #[test]
    fn unset_numbers() {
        assert_eq!(set(f64::MAX), None);
        assert_eq!(set(f64::NAN), None);
        assert_eq!(set(1.5), Some(1.5));
    }

    #[test]
    fn restart_token_names() {
        let f = restart_token_file(Path::new("data"), "Jo.Doe", true);
        assert_eq!(f, Path::new("data").join("restart-token-live-jo_doe"));
    }
}
