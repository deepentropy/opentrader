/*
 * `GET /api/poll?client=<id>` — the live events over plain HTTP, for a tab
 * whose WebSocket cannot open (a browser extension, a proxy or an antivirus
 * blocking it). The first call opens a session for the client, which counts
 * as its connection (its subscriptions need one); each call returns the events
 * queued since the previous one as a JSON array, waiting up to `WAIT` for the
 * first. A session not polled for `LEASE` ends like a closed WebSocket.
 *
 * `wait=0` answers at once (the tab's first call, before it subscribes). The
 * `x-opentrader-session: new` header tells the tab that its subscriptions were
 * dropped (the server restarted, or the lease ended) and must be sent again.
 */
use crate::clients::{valid_id, Outgoing};
use crate::{client_gone, origin_ok, Shared};
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::Notify;
use tokio::time::Instant;

/// Longest a poll waits for an event.
const WAIT: Duration = Duration::from_secs(20);
/// A session not polled for this long is closed.
const LEASE: Duration = Duration::from_secs(45);
/// Events kept for a session between two polls (older ones are dropped).
const QUEUE_MAX: usize = 2000;
/// After the first event, wait this long for the rest of its burst (a quote
/// poll sends one event per symbol), so a poll carries them together.
const GATHER: Duration = Duration::from_millis(300);

pub struct Session {
    queue: Mutex<VecDeque<Arc<Outgoing>>>,
    ready: Notify,
    last_poll: Mutex<Instant>,
}

#[derive(Default)]
pub struct Sessions {
    map: Mutex<HashMap<String, Arc<Session>>>,
}

#[derive(Deserialize)]
pub struct PollQuery {
    client: String,
    #[serde(default)]
    wait: Option<u32>,
}

pub async fn handle(State(state): State<Shared>, Query(q): Query<PollQuery>, headers: HeaderMap) -> Response {
    if !valid_id(&q.client) {
        return (StatusCode::BAD_REQUEST, "invalid client id").into_response();
    }
    if !origin_ok(&state, &headers) {
        return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
    }
    let (session, new) = {
        let mut map = state.polls.map.lock().unwrap();
        match map.get(&q.client) {
            Some(s) => (s.clone(), false),
            None => {
                let s = Arc::new(Session {
                    queue: Mutex::new(VecDeque::new()),
                    ready: Notify::new(),
                    last_poll: Mutex::new(Instant::now()),
                });
                map.insert(q.client.clone(), s.clone());
                (s, true)
            }
        }
    };
    if new {
        // Connected before answering, so the tab may subscribe right after.
        let subs = state.clients.connect(&q.client);
        tokio::spawn(run_session(state.clone(), q.client.clone(), session.clone(), subs));
    }
    *session.last_poll.lock().unwrap() = Instant::now();

    if q.wait != Some(0) && session.queue.lock().unwrap().is_empty() {
        if tokio::time::timeout(WAIT, session.ready.notified()).await.is_ok() {
            tokio::time::sleep(GATHER).await;
        }
    }
    let events: Vec<Arc<Outgoing>> = session.queue.lock().unwrap().drain(..).collect();
    *session.last_poll.lock().unwrap() = Instant::now();
    let body = format!("[{}]", events.iter().map(|e| e.text.as_str()).collect::<Vec<_>>().join(","));
    let mut res = ([(header::CONTENT_TYPE, "application/json"), (header::CACHE_CONTROL, "no-store")], body).into_response();
    if new {
        res.headers_mut().insert("x-opentrader-session", header::HeaderValue::from_static("new"));
    }
    res
}

/// Queues the client's events until its lease ends, then releases it.
async fn run_session(
    state: Shared,
    client: String,
    session: Arc<Session>,
    subs: Arc<Mutex<crate::clients::Subs>>,
) {
    let mut rx = state.host.subscribe();
    let mut check = tokio::time::interval(Duration::from_secs(5));
    loop {
        tokio::select! {
            ev = rx.recv() => match ev {
                Ok(ev) => {
                    if subs.lock().unwrap().wants(&client, &ev) {
                        let mut q = session.queue.lock().unwrap();
                        if q.len() >= QUEUE_MAX {
                            q.pop_front();
                        }
                        q.push_back(ev);
                        drop(q);
                        session.ready.notify_one();
                    }
                }
                Err(RecvError::Lagged(n)) => eprintln!("[server] poll client {client} missed {n} events"),
                Err(RecvError::Closed) => break,
            },
            _ = check.tick() => {
                if session.last_poll.lock().unwrap().elapsed() > LEASE {
                    break;
                }
            }
        }
    }
    state.polls.map.lock().unwrap().remove(&client);
    client_gone(&state, &client, &subs).await;
}
