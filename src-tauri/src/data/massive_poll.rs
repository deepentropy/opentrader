/*
 * Massive REST snapshot poller — the live-data transport that needs no
 * WebSocket entitlement.
 *
 * Which stream channels the key may use is now measured by the entitlement
 * probe (`provider::entitlements`; on 27/09/2026 the delayed WebSocket
 * accepted AM / A / T). This task provides the live feed without a
 * WebSocket by polling the bulk snapshot endpoint on an interval and
 * re-emitting the identical `TradeTick` / `ChartAggregate` events the
 * frontend already listens for — so the watchlist and chart light up with
 * no frontend change. It also supplies the day bar and change / change% /
 * volume, which the WebSocket AM / T events do not carry.
 *
 * It reuses massive_ws's subscription plumbing (`SubscribeMsg`, `WsHandle`)
 * so `commands/realtime.rs` and the managed app state are unchanged: the
 * frontend still declares its desired chart symbol + watchlist set, and
 * this task polls exactly that union.
 *
 * It always runs. When the probe grants 1-second bars, the second-bars
 * WebSocket (`massive_ws::spawn_second_bars`) runs next to it for the
 * seconds charts only (see `provider/massive.rs` spawn).
 */
use crate::data::massive_rest;
use crate::data::massive_ws::{ChartAggregate, SubscribeMsg, SubscriptionState, TradeTick, WsHandle};
use std::time::Duration;
use tauri::AppHandle;
use tauri_specta::Event;
use tokio::sync::mpsc;
use tokio::time::{interval, MissedTickBehavior};

/// How often to poll. The data is 15-minute delayed, so a tight loop buys
/// nothing new from the feed; 5s keeps the watchlist visibly fresh without
/// hammering. The Starter plan allows unlimited REST calls, so the cadence is
/// purely a UI-freshness choice.
const POLL_INTERVAL: Duration = Duration::from_secs(5);

pub fn spawn(app: AppHandle) -> WsHandle {
    let (tx, rx) = mpsc::channel::<SubscribeMsg>(32);
    // Use Tauri's managed runtime — see the note in massive_ws::spawn: this
    // is called from `.setup()`, outside any ambient Tokio context.
    tauri::async_runtime::spawn(async move {
        run_poller(app, rx).await;
    });
    WsHandle { tx }
}

async fn run_poller(app: AppHandle, mut rx: mpsc::Receiver<SubscribeMsg>) {
    // Desired state, declared per owner (window / window:pane) by the
    // frontend via commands/realtime.rs; the poller consumes the unions.
    let mut state = SubscriptionState::default();

    let mut ticker = interval(POLL_INTERVAL);
    // If a poll runs long (slow network), don't fire a burst of catch-up
    // ticks afterwards — just resume the cadence from now.
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            _ = ticker.tick() => {
                poll_once(&app, &state).await;
            }
            msg = rx.recv() => {
                let Some(msg) = msg else { return; }; // mpsc closed → app shutting down
                state.apply(msg);
                // Poll immediately on a subscription change so the UI
                // populates without waiting up to POLL_INTERVAL.
                poll_once(&app, &state).await;
            }
        }
    }
}

async fn poll_once(app: &AppHandle, state: &SubscriptionState) {
    // Union of everything we care about — one bulk request covers it all.
    let symbols = state.all_symbols();
    if symbols.is_empty() {
        return;
    }
    let symbols: Vec<String> = symbols.into_iter().collect();

    let ticks = match massive_rest::fetch_snapshots(&symbols).await {
        Ok(t) => t,
        Err(e) => {
            eprintln!("[massive_poll] snapshot poll failed: {e:#}");
            return;
        }
    };

    for t in ticks {
        // Watchlist quote update (every polled symbol gets one): regular-session
        // last + change / Chg% / Vol, plus the pre/post Ext move and session
        // source so the UI can blank Ext during regular hours.
        if t.last > 0.0 {
            let _ = TradeTick {
                symbol: t.ticker.clone(),
                price: t.last,
                change: Some(t.change),
                change_percent: Some(t.change_percent),
                ext_change_percent: t.ext_change_percent,
                volume: Some(t.volume),
                source: Some(t.source.clone()),
            }
            .emit(app);
        }
        // Chart minute bar — for every symbol some pane currently charts
        // (any window; the frontend filters aggregates by symbol).
        if state.is_chart_symbol(t.ticker.as_str()) {
            // Prefer the minute bar; when the snapshot has no minute bar but
            // DOES have a day bar (illiquid minute edge case), still emit so
            // daily-family charts keep updating. The fallback stamps `time: 0`
            // so the frontend's intraday bucketing skips it (only the daily
            // path, which reads `day` directly, consumes such a tick).
            let day_only = t.minute.is_none();
            let base = t.minute.clone().or_else(|| t.day.clone());
            if let Some(bar) = base {
                let _ = ChartAggregate {
                    symbol: t.ticker.clone(),
                    time: if day_only { 0.0 } else { bar.time },
                    open: bar.open,
                    high: bar.high,
                    low: bar.low,
                    close: bar.close,
                    volume: bar.volume,
                    // Today's full daily bar rides along so daily/weekly/
                    // monthly charts update exactly (see bucketLiveTick).
                    day: t.day,
                }
                .emit(app);
            }
        }
    }
}
