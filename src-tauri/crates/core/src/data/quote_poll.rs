/*
 * REST snapshot poller — the live-data transport that needs no stream
 * entitlement.
 *
 * Which stream channels the plan may use is measured by the entitlement
 * probe (`provider::entitlements`). This task provides the live feed
 * without the stream by polling the bulk snapshot endpoint on an interval
 * and re-emitting the identical `TradeTick` / `ChartAggregate` events the
 * frontend already listens for — so the watchlist and chart light up with
 * no frontend change. It also supplies the day bar and change / change% /
 * volume, which the stream's minute bars and trades do not carry.
 *
 * It reuses market_stream's subscription plumbing (`SubscribeMsg`,
 * `WsHandle`) so `commands/realtime.rs` and the managed app state are
 * unchanged: the frontend still declares its desired chart symbol +
 * watchlist set, and this task polls exactly that union.
 *
 * A subscription change polls at once only for a ticker not polled yet
 * (at most once per `MIN_GAP`); a view subscribing to an already-polled
 * symbol gets its last values at once instead. Many views changing together
 * (the web server's visitors) then cost one poll, not one each.
 *
 * It always runs. When the probe grants 1-second bars, the second-bars
 * stream (`market_stream::spawn_second_bars`) runs next to it for the
 * seconds charts only (see `provider/gateway.rs` spawn).
 */
use crate::data::market_rest::{self, LiveTick};
use crate::data::market_stream::{ticker_of, ChartAggregate, SubscribeMsg, SubscriptionState, TradeTick, WsHandle};
use crate::host::{Event, HostRef};
use std::collections::{HashMap, HashSet};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::{interval, Instant, MissedTickBehavior};

/// How often to poll. The data is 15-minute delayed, so a tight loop buys
/// nothing new from the feed; 5s keeps the watchlist visibly fresh without
/// hammering. The cadence is purely a UI-freshness choice (a rate-limited
/// answer is retried by the REST client after its `Retry-After`).
const POLL_INTERVAL: Duration = Duration::from_secs(5);

/// Shortest wait between two polls asked by subscription changes.
const MIN_GAP: Duration = Duration::from_secs(1);

pub fn spawn(app: HostRef) -> WsHandle {
    let (tx, rx) = mpsc::channel::<SubscribeMsg>(32);
    // `rt::spawn` — see the note in market_stream::spawn_mode.
    crate::rt::spawn(async move {
        run_poller(app, rx).await;
    });
    WsHandle { tx }
}

struct Poller {
    app: HostRef,
    /// Desired state, declared per owner (window / window:pane) by the
    /// frontend via the realtime commands; the poller consumes the unions.
    state: SubscriptionState,
    /// Last snapshot of each ticker polled: what a view subscribing to an
    /// already-polled symbol gets at once.
    last: HashMap<String, LiveTick>,
    /// Tickers the last poll asked for.
    polled: HashSet<String>,
    last_poll: Option<Instant>,
}

async fn run_poller(app: HostRef, mut rx: mpsc::Receiver<SubscribeMsg>) {
    let mut p = Poller { app, state: SubscriptionState::default(), last: HashMap::new(), polled: HashSet::new(), last_poll: None };

    let mut ticker = interval(POLL_INTERVAL);
    // If a poll runs long (slow network), don't fire a burst of catch-up
    // ticks afterwards — just resume the cadence from now.
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            _ = ticker.tick() => {
                p.poll().await;
            }
            msg = rx.recv() => {
                let Some(msg) = msg else { return; }; // mpsc closed → app shutting down
                // Every update already queued is part of the same change.
                let mut burst = vec![msg];
                while let Ok(m) = rx.try_recv() {
                    burst.push(m);
                }
                for m in burst {
                    p.replay(&m);
                    p.state.apply(m);
                }
                // A ticker not polled yet: poll now so the view populates
                // without waiting up to POLL_INTERVAL.
                if !p.state.all_tickers().is_subset(&p.polled) {
                    if let Some(t) = p.last_poll {
                        tokio::time::sleep_until(t + MIN_GAP).await;
                    }
                    p.poll().await;
                }
            }
        }
    }
}

impl Poller {
    /// The last values of the symbols `msg` subscribes, to its owner only,
    /// for the tickers already polled (the others come with the next poll).
    fn replay(&self, msg: &SubscribeMsg) {
        match msg {
            SubscribeMsg::SetChart { owner, symbol: Some(symbol) } => {
                if let Some(t) = self.last.get(&ticker_of(symbol)) {
                    if let Some(e) = trade_tick(symbol, t) {
                        let _ = e.emit_to(&self.app, owner);
                    }
                    if let Some(e) = chart_aggregate(symbol, t) {
                        let _ = e.emit_to(&self.app, owner);
                    }
                }
            }
            SubscribeMsg::SetWatchlist { owner, symbols } => {
                for symbol in symbols {
                    if let Some(e) = self.last.get(&ticker_of(symbol)).and_then(|t| trade_tick(symbol, t)) {
                        let _ = e.emit_to(&self.app, owner);
                    }
                }
            }
            _ => {}
        }
    }

    async fn poll(&mut self) {
        // Union of everything we care about — one bulk request covers it all
        // (vendor tickers; events go back under each subscribed full name).
        let tickers = self.state.all_tickers();
        self.last_poll = Some(Instant::now());
        self.last.retain(|t, _| tickers.contains(t));
        self.polled = tickers.clone();
        if tickers.is_empty() {
            return;
        }
        let symbols: Vec<String> = tickers.into_iter().collect();

        let ticks = match market_rest::fetch_snapshots(&symbols).await {
            Ok(t) => t,
            Err(e) => {
                eprintln!("[quote_poll] snapshot poll failed: {e:#}");
                return;
            }
        };

        let app = &self.app;
        for t in ticks {
            // Watchlist quote update (every polled symbol gets one).
            for symbol in self.state.symbols_for(&t.ticker) {
                if let Some(e) = trade_tick(&symbol, &t) {
                    // The host's alert rules read every quote, with the
                    // minute bar for what happened since the previous one.
                    app.on_quote(&symbol, t.last, t.minute.as_ref());
                    let _ = e.emit(app);
                }
            }
            // Chart minute bar — for every full name some pane currently charts
            // with this ticker (any window; the frontend filters by symbol).
            for symbol in self.state.chart_symbols_for(&t.ticker) {
                if let Some(e) = chart_aggregate(&symbol, &t) {
                    let _ = e.emit(app);
                }
            }
            self.last.insert(t.ticker.clone(), t);
        }
    }
}

/// The watchlist quote of a snapshot: regular-session last + change / Chg% /
/// Vol, plus the pre/post Ext move and session source so the UI can blank Ext
/// during regular hours. None without a price.
fn trade_tick(symbol: &str, t: &LiveTick) -> Option<TradeTick> {
    (t.last > 0.0).then(|| TradeTick {
        symbol: symbol.to_string(),
        price: t.last,
        change: Some(t.change),
        change_percent: Some(t.change_percent),
        ext_change_percent: t.ext_change_percent,
        volume: Some(t.volume),
        source: Some(t.source.clone()),
        trade_price: t.minute.as_ref().map(|m| m.close),
        trade_time: t.minute.as_ref().map(|m| m.time),
    })
}

/// The chart bar of a snapshot. Prefers the minute bar; when the snapshot has
/// no minute bar but DOES have a day bar (illiquid minute edge case), still
/// one, so daily-family charts keep updating. That fallback stamps `time: 0`
/// so the frontend's intraday bucketing skips it (only the daily path, which
/// reads `day` directly, consumes such a tick).
fn chart_aggregate(symbol: &str, t: &LiveTick) -> Option<ChartAggregate> {
    let day_only = t.minute.is_none();
    let bar = t.minute.as_ref().or(t.day.as_ref())?;
    Some(ChartAggregate {
        symbol: symbol.to_string(),
        time: if day_only { 0.0 } else { bar.time },
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        // Today's full daily bar rides along so daily/weekly/monthly charts
        // update exactly (see bucketLiveTick).
        day: t.day.clone(),
    })
}
