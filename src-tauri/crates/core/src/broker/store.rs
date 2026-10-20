/*
 * The broker state the connection tasks write and the views read: one lock,
 * short critical sections (never held across an await). Each change marks
 * the state dirty; one emitter task sends it as a `broker-state` event at
 * most every 250 ms.
 */
use super::types::*;
use crate::host::{Event, HostRef};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};
use std::time::Duration as StdDuration;
use tokio::sync::Notify;

const EMIT_EVERY: StdDuration = StdDuration::from_millis(250);
const MAX_NOTICES: usize = 200;
const MAX_EXECUTIONS: usize = 1000;

#[derive(Default)]
pub struct Tables {
    pub version: u32,
    pub broker: Option<String>,
    pub connection: Option<ConnectionState>,
    pub config: Option<BrokerConfig>,
    pub error: Option<String>,
    pub accounts: Vec<String>,
    pub account: Option<String>,
    pub summary: Option<AccountSummary>,
    /// By contract id.
    pub positions: BTreeMap<i32, Position>,
    /// By row id.
    pub orders: HashMap<String, Order>,
    /// By execution id.
    pub executions: HashMap<String, Execution>,
    pub notices: VecDeque<BrokerNotice>,
}

impl Tables {
    pub fn notice(&mut self, level: NoticeLevel, code: i32, message: String, order_id: Option<i32>) {
        if self.notices.len() >= MAX_NOTICES {
            self.notices.pop_front();
        }
        self.notices.push_back(BrokerNotice { time_ms: now_ms(), level, code, message, order_id });
    }

    /// Forget the account's data (disconnect, account switch).
    pub fn clear_account(&mut self) {
        self.summary = None;
        self.positions.clear();
        self.orders.clear();
        self.executions.clear();
    }

    pub fn trim_executions(&mut self) {
        if self.executions.len() <= MAX_EXECUTIONS {
            return;
        }
        let mut times: Vec<(f64, String)> = self.executions.values().map(|e| (e.time_ms, e.id.clone())).collect();
        times.sort_by(|a, b| a.0.total_cmp(&b.0));
        for (_, id) in times.iter().take(self.executions.len() - MAX_EXECUTIONS) {
            self.executions.remove(id);
        }
    }
}

#[derive(Default)]
pub struct Store {
    tables: Mutex<Tables>,
    dirty: Notify,
    emitter: OnceLock<()>,
}

impl Store {
    /// Change the tables; the views hear of it within 250 ms.
    pub fn update<R>(&self, f: impl FnOnce(&mut Tables) -> R) -> R {
        let r = {
            let mut t = self.tables.lock().expect("broker tables lock");
            let r = f(&mut t);
            t.version = t.version.wrapping_add(1);
            r
        };
        self.dirty.notify_one();
        r
    }

    /// Read the tables without marking them changed.
    pub fn read<R>(&self, f: impl FnOnce(&Tables) -> R) -> R {
        f(&self.tables.lock().expect("broker tables lock"))
    }

    pub fn snapshot(&self) -> BrokerState {
        self.read(|t| {
            let mut orders: Vec<Order> = t.orders.values().cloned().collect();
            orders.sort_by(|a, b| b.updated_ms.total_cmp(&a.updated_ms));
            let mut executions: Vec<Execution> = t.executions.values().cloned().collect();
            executions.sort_by(|a, b| b.time_ms.total_cmp(&a.time_ms));
            BrokerState {
                version: t.version,
                broker: t.broker.clone(),
                connection: t.connection.unwrap_or(ConnectionState::Disconnected),
                config: t.config.clone(),
                error: t.error.clone(),
                accounts: t.accounts.clone(),
                account: t.account.clone(),
                summary: t.summary.clone(),
                positions: t.positions.values().cloned().collect(),
                orders,
                executions,
                notices: t.notices.iter().rev().cloned().collect(),
            }
        })
    }

    /// Start the emitter (once per app).
    pub fn ensure_emitter(self: &std::sync::Arc<Self>, host: HostRef) {
        if self.emitter.set(()).is_err() {
            return;
        }
        let store = self.clone();
        crate::rt::spawn(async move {
            loop {
                store.dirty.notified().await;
                tokio::time::sleep(EMIT_EVERY).await;
                if let Err(e) = store.snapshot().emit(&host) {
                    eprintln!("[broker] emit state failed: {e}");
                }
            }
        });
    }
}

pub fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}
