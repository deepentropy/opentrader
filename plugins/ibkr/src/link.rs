/*
 * The connection to the broker, by either way the plugin connects:
 *   • Gateway: the socket API of the user's IB Gateway / TWS;
 *   • Direct: the plugin logs in to the broker's servers itself (`direct`).
 *
 * Both give the same answers in the socket API's types, so the rest of the plugin (`ib`) doesn't know which one it
 * talks to. A subscription is a `Feed`: its items, then None when it ends; dropping it cancels it.
 */
use crate::direct::{self, Direct};
use futures_util::{Stream, StreamExt};
use ibapi::accounts::types::{AccountGroup, AccountId, ContractId};
use ibapi::accounts::{AccountSummaryResult, AccountSummaryTags, AccountUpdate, PnL, PnLSingle};
use ibapi::contracts::{Contract, ContractDetails};
use ibapi::market_data::realtime::{MarketDepths, TickTypes};
use ibapi::market_data::historical::{BarSize, BarTimestamp, Duration as IbDuration, WhatToShow};
use ibapi::market_data::{MarketDataType, SmartDepth, TradingHours};
use ibapi::orders::{ExecutionFilter, Executions, Order, OrderUpdate, Orders};
use ibapi::subscriptions::{NoticeStream, SubscriptionItem};
use ibapi::{Client, Error as IbError, Notice, NoticeCategory};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

pub type Item<T> = Result<SubscriptionItem<T>, IbError>;

/// How long a list (open orders, executions) may take to come whole.
pub const LIST_TIMEOUT: Duration = Duration::from_secs(10);
/// The days of executions read at connection.
pub const EXECUTION_DAYS: i32 = 7;
/// How long a historical request may wait: the broker holds a burst of them for seconds each.
pub const HISTORY_TIMEOUT: Duration = Duration::from_secs(90);

/// A bar of the past: intraday at its start (UNIX seconds), daily on its trading day.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BarTime {
    At(i64),
    Day(chrono::NaiveDate),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HistBar {
    pub time: BarTime,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
}

/// The bar sizes the plugin serves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistSize {
    Min1,
    Min5,
    Min15,
    Min30,
    Hour1,
    Day1,
}

impl HistSize {
    /// The broker's name of the size.
    pub fn name(self) -> &'static str {
        match self {
            HistSize::Min1 => "1 min",
            HistSize::Min5 => "5 mins",
            HistSize::Min15 => "15 mins",
            HistSize::Min30 => "30 mins",
            HistSize::Hour1 => "1 hour",
            HistSize::Day1 => "1 day",
        }
    }

    fn gateway(self) -> BarSize {
        match self {
            HistSize::Min1 => BarSize::Min,
            HistSize::Min5 => BarSize::Min5,
            HistSize::Min15 => BarSize::Min15,
            HistSize::Min30 => BarSize::Min30,
            HistSize::Hour1 => BarSize::Hour,
            HistSize::Day1 => BarSize::Day,
        }
    }
}

/// One historical request: `days` of bars ending at `end` (UNIX seconds), extended hours. `midpoint` for what has no
/// trades (forex).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HistQuery {
    pub size: HistSize,
    pub end: i64,
    pub days: u32,
    pub midpoint: bool,
}

impl HistQuery {
    /// The duration as the broker takes it: days up to a year, whole years beyond.
    pub fn duration(&self) -> (u32, char) {
        if self.days <= 365 {
            (self.days.max(1), 'D')
        } else {
            (self.days.div_ceil(365), 'Y')
        }
    }
}

/// Why a historical request has no bars.
#[derive(Debug, Clone, PartialEq)]
pub enum HistError {
    /// Pacing: ask again later.
    Busy(String),
    /// Nothing there (before the history starts).
    NoData,
    /// The contract is unknown.
    Unknown,
    Failed(String),
}

impl HistError {
    /// From the broker's notice of a historical request.
    pub fn of_notice(code: i32, message: &str) -> HistError {
        let m = message.to_ascii_lowercase();
        if m.contains("pacing") {
            HistError::Busy(message.to_string())
        } else if code == 162 && (m.contains("no data") || m.contains("returned no")) {
            HistError::NoData
        } else if code == 200 {
            HistError::Unknown
        } else {
            HistError::Failed(format!("{message} (code {code})"))
        }
    }
}

/// A symbol search's match.
#[derive(Debug, Clone)]
pub struct Match {
    pub contract: Contract,
    pub description: String,
    /// "FUT", "OPT"… of this underlying.
    pub derivatives: Vec<String>,
}

pub enum Feed<T> {
    /// A socket API subscription, boxed: its type can't be named in generic code.
    Gateway(Pin<Box<dyn Stream<Item = Item<T>> + Send>>),
    Direct(direct::Feed<T>),
}

impl<T> Feed<T> {
    fn gateway<S: Stream<Item = Item<T>> + Send + 'static>(s: S) -> Self {
        Feed::Gateway(Box::pin(s))
    }

    pub async fn next(&mut self) -> Option<Item<T>> {
        match self {
            Feed::Gateway(s) => s.next().await,
            Feed::Direct(f) => f.next().await,
        }
    }
}

/// The connection-level notices; None once the connection is gone for good.
pub enum Notices {
    Gateway(NoticeStream),
    Direct(mpsc::UnboundedReceiver<Notice>),
}

impl Notices {
    pub async fn next(&mut self) -> Option<Notice> {
        match self {
            Notices::Gateway(s) => s.next().await,
            Notices::Direct(rx) => rx.recv().await,
        }
    }
}

#[derive(Clone)]
pub enum Link {
    Gateway(Arc<Client>),
    Direct(Arc<Direct>),
}

impl Link {
    pub async fn managed_accounts(&self) -> Result<Vec<String>, String> {
        match self {
            Link::Gateway(c) => c.managed_accounts().await.map_err(|e| e.to_string()),
            Link::Direct(d) => d.managed_accounts().await,
        }
    }

    /// Real-time prices where the account has the market data, delayed elsewhere.
    pub async fn prefer_delayed(&self) {
        match self {
            Link::Gateway(c) => {
                let _ = c.switch_market_data_type(MarketDataType::Delayed).await;
            }
            Link::Direct(d) => d.prefer_delayed(),
        }
    }

    pub fn is_connected(&self) -> bool {
        match self {
            Link::Gateway(c) => c.is_connected(),
            Link::Direct(d) => d.is_connected(),
        }
    }

    pub async fn disconnect(&self) {
        match self {
            Link::Gateway(c) => c.disconnect().await,
            Link::Direct(d) => d.disconnect().await,
        }
    }

    /// Orders, statuses, fills, commissions and order notices of this client id, as they happen.
    pub async fn order_updates(&self) -> Result<Feed<OrderUpdate>, String> {
        match self {
            Link::Gateway(c) => c.order_update_stream().await.map(Feed::gateway).map_err(|e| e.to_string()),
            Link::Direct(d) => Ok(Feed::Direct(d.order_updates())),
        }
    }

    pub async fn account_updates(&self, account: &str) -> Result<Feed<AccountUpdate>, String> {
        match self {
            Link::Gateway(c) => c.account_updates(&AccountId(account.into())).await.map(Feed::gateway).map_err(|e| e.to_string()),
            Link::Direct(d) => Ok(Feed::Direct(d.account_updates(account))),
        }
    }

    pub async fn pnl(&self, account: &str) -> Option<Feed<PnL>> {
        match self {
            Link::Gateway(c) => c.pnl(&AccountId(account.into()), None).await.ok().map(Feed::gateway),
            Link::Direct(d) => Some(Feed::Direct(d.pnl(account))),
        }
    }

    pub async fn pnl_single(&self, account: &str, contract_id: i32) -> Option<Feed<PnLSingle>> {
        match self {
            Link::Gateway(c) => c.pnl_single(&AccountId(account.into()), ContractId(contract_id), None).await.ok().map(Feed::gateway),
            Link::Direct(d) => Some(Feed::Direct(d.pnl_single(account, contract_id))),
        }
    }

    /// Every value of every account (SMA, Reg T equity, day trades left…).
    pub async fn account_summary(&self) -> Option<Feed<AccountSummaryResult>> {
        match self {
            Link::Gateway(c) => c.account_summary(&AccountGroup("All".into()), AccountSummaryTags::ALL).await.ok().map(Feed::gateway),
            Link::Direct(d) => Some(Feed::Direct(d.account_summary(AccountSummaryTags::ALL))),
        }
    }

    /// The open orders of every client, or the completed orders.
    pub async fn orders(&self, completed: bool) -> Result<Vec<Orders>, String> {
        match self {
            Link::Gateway(c) => {
                let sub = if completed { c.completed_orders(false).await } else { c.all_open_orders().await };
                match sub {
                    Ok(mut sub) => sub.collect_to_end_within(LIST_TIMEOUT).await.map_err(|e| e.to_string()),
                    Err(e) => Err(e.to_string()),
                }
            }
            Link::Direct(d) => d.orders(completed).await,
        }
    }

    /// The executions of the last `EXECUTION_DAYS`, with their commissions.
    pub async fn executions(&self) -> Result<Vec<Executions>, String> {
        match self {
            Link::Gateway(c) => {
                let filter = ExecutionFilter { last_n_days: EXECUTION_DAYS, ..Default::default() };
                match c.executions(filter).await {
                    Ok(mut sub) => sub.collect_to_end_within(LIST_TIMEOUT).await.map_err(|e| e.to_string()),
                    Err(e) => Err(e.to_string()),
                }
            }
            Link::Direct(d) => d.executions().await,
        }
    }

    /// The contracts matching `query`; an error notice (200: none) as `IbError::Notice`.
    pub async fn contract_details(&self, query: &Contract) -> Result<Vec<ContractDetails>, IbError> {
        match self {
            Link::Gateway(c) => c.contract_details(query).await,
            Link::Direct(d) => d.contract_details(query).await,
        }
    }

    pub async fn next_order_id(&self) -> i32 {
        match self {
            Link::Gateway(c) => c.next_order_id(),
            Link::Direct(d) => d.next_order_id().await,
        }
    }

    pub async fn submit_order(&self, contract: &Contract, order: &Order) -> Result<(), String> {
        match self {
            Link::Gateway(c) => c.submit_order(order.order_id, contract, order).await.map_err(|e| e.to_string()),
            Link::Direct(d) => d.submit_order(contract, order).await,
        }
    }

    /// Cancel an order: Ok(Some(why)) when the broker refuses at once (the order filled meanwhile…); the rest of the
    /// story comes with the order updates.
    pub async fn cancel_order(&self, order_id: i32) -> Result<Option<String>, String> {
        match self {
            Link::Gateway(c) => {
                let mut sub = c.cancel_order(order_id, "").await.map_err(|e| e.to_string())?;
                let first = tokio::time::timeout(Duration::from_secs(4), sub.next()).await;
                let refused = match first {
                    Ok(Some(Ok(SubscriptionItem::Notice(n)))) | Ok(Some(Err(IbError::Notice(n)))) if refuses(&n) => Some(n.message),
                    _ => None,
                };
                tokio::spawn(async move { while tokio::time::timeout(Duration::from_secs(5), sub.next()).await.is_ok_and(|i| i.is_some()) {} });
                Ok(refused)
            }
            Link::Direct(d) => d.cancel_order(order_id).await,
        }
    }

    pub async fn quotes(&self, contract: &Contract) -> Result<Feed<TickTypes>, String> {
        match self {
            Link::Gateway(c) => c.market_data(contract).subscribe().await.map(Feed::gateway).map_err(|e| e.to_string()),
            Link::Direct(d) => d.quotes(contract).await.map(Feed::Direct),
        }
    }

    /// A SMART-routed contract's book comes from every venue (smart depth); others' from their exchange.
    pub async fn depth(&self, contract: &Contract, rows: i32) -> Result<Feed<MarketDepths>, String> {
        let smart = contract.exchange.as_str() == "SMART";
        match self {
            Link::Gateway(c) => {
                let s = if smart { SmartDepth::Yes } else { SmartDepth::No };
                c.market_depth(contract, rows).smart_depth(s).subscribe().await.map(Feed::gateway).map_err(|e| e.to_string())
            }
            Link::Direct(d) => d.depth(contract, rows, smart).await.map(Feed::Direct),
        }
    }
}

impl Link {
    /// Bars of the past, oldest first.
    pub async fn history(&self, contract: &Contract, q: HistQuery) -> Result<Vec<HistBar>, HistError> {
        match self {
            Link::Gateway(c) => {
                let end = time::OffsetDateTime::from_unix_timestamp(q.end).map_err(|e| HistError::Failed(e.to_string()))?;
                let (n, unit) = q.duration();
                let n = n as i32;
                let duration = if unit == 'Y' { IbDuration::years(n) } else { IbDuration::days(n) };
                let what = if q.midpoint { WhatToShow::MidPoint } else { WhatToShow::Trades };
                let fetch = c.historical_data(contract, q.size.gateway()).what_to_show(what).trading_hours(TradingHours::Extended).duration(duration).ending(end).fetch();
                match tokio::time::timeout(HISTORY_TIMEOUT, fetch).await {
                    Err(_) => Err(HistError::Busy("The broker did not answer in time".into())),
                    Ok(Err(IbError::Notice(n))) => Err(HistError::of_notice(n.code, &n.message)),
                    Ok(Err(e)) => Err(HistError::Failed(e.to_string())),
                    Ok(Ok(h)) => Ok(h
                        .bars
                        .iter()
                        .map(|b| HistBar {
                            time: match b.date {
                                BarTimestamp::DateTime(t) => BarTime::At(t.unix_timestamp()),
                                BarTimestamp::Date(d) => BarTime::Day(
                                    chrono::NaiveDate::from_ymd_opt(d.year(), u8::from(d.month()) as u32, d.day() as u32).unwrap_or_default(),
                                ),
                            },
                            open: b.open,
                            high: b.high,
                            low: b.low,
                            close: b.close,
                            volume: b.volume,
                        })
                        .collect()),
                }
            }
            Link::Direct(d) => d.history(contract, q).await,
        }
    }

    /// The contracts whose symbol or name starts like `pattern`.
    pub async fn matching_symbols(&self, pattern: &str) -> Result<Vec<Match>, String> {
        match self {
            Link::Gateway(c) => c
                .matching_symbols(pattern)
                .await
                .map(|list| {
                    list.into_iter()
                        .map(|d| Match { description: d.contract.description.clone(), contract: d.contract, derivatives: d.derivative_security_types })
                        .collect()
                })
                .map_err(|e| e.to_string()),
            Link::Direct(d) => d.matching_symbols(pattern).await,
        }
    }
}

/// A cancel's answer that refuses it, rather than confirming or warning.
pub fn refuses(n: &Notice) -> bool {
    !matches!(n.category(), NoticeCategory::Cancellation | NoticeCategory::Warning)
}
