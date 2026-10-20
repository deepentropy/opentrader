/*
 * opentrader-server — the web version's backend. The same core as the desktop
 * app, reached over HTTP instead of the webview bridge:
 *
 *   POST /api/invoke/<command>  JSON arguments, named as the desktop bindings
 *                               send them; answers the command's value, or
 *                               its error string with a 4xx/5xx status.
 *   GET  /api/events            WebSocket of the live events
 *                               (`{"event": <name>, "payload": ...}`).
 *   GET  /api/ticker-icon/<url> ticker logos (the token stays here).
 *   GET  /api/health
 *
 * Each browser tab is a client: it names itself (`x-opentrader-client`
 * header, `?client=` on the WebSocket), which takes the place of the desktop
 * window label in the subscription owners.
 *
 * Configuration (environment):
 *   OPENTRADER_GATEWAY_TOKEN   gateway token (required for market data)
 *   OPENTRADER_BIND            listen address, default 127.0.0.1:8787
 *   OPENTRADER_PUBLIC_URL      origin the icon URLs start with, default none
 *                              (same origin as the page)
 *   OPENTRADER_ALLOWED_ORIGINS comma-separated page origins; unset = any
 *   OPENTRADER_STATIC_DIR      serve the built frontend from this folder
 *   OPENTRADER_CACHE_DIR       disk cache folder (see `opentrader_core::data`)
 */
mod clients;
mod invoke;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use clients::{Clients, ServerHost};
use opentrader_core::data::market_rest;
use opentrader_core::data::provider::{self, Provider};
use opentrader_core::data::types::{SubscribeMsg, WsHandle};
use opentrader_core::host::HostRef;
use opentrader_core::screener::Screener;
use serde::Deserialize;
use std::sync::Arc;
use tokio::sync::broadcast::error::RecvError;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};

/// What every request handler reads.
pub struct AppState {
    pub provider: Provider,
    pub live: WsHandle,
    pub screener: Screener,
    pub host: Arc<ServerHost>,
    pub clients: Clients,
    /// Page origins allowed to connect; `None` = any.
    pub origins: Option<Vec<String>>,
}

type Shared = Arc<AppState>;

#[tokio::main]
async fn main() {
    let bind = std::env::var("OPENTRADER_BIND").unwrap_or_else(|_| "127.0.0.1:8787".into());
    let public = std::env::var("OPENTRADER_PUBLIC_URL").unwrap_or_default();
    let origins: Option<Vec<String>> = std::env::var("OPENTRADER_ALLOWED_ORIGINS").ok().map(|v| {
        v.split(',').map(|o| o.trim().trim_end_matches('/').to_string()).filter(|o| !o.is_empty()).collect()
    });
    if opentrader_core::data::gateway::token().is_none() {
        eprintln!("[server] {}", opentrader_core::data::gateway::NO_TOKEN);
    }

    market_rest::set_icon_proxy_base(format!("{}/api/ticker-icon/", public.trim_end_matches('/')));
    let host = Arc::new(ServerHost::new());
    let host_ref: HostRef = host.clone();
    let provider = provider::build();
    let live = provider.spawn(host_ref.clone());
    provider::entitlements::init(&host_ref, provider.clone());
    market_rest::init_symbol_catalog();
    market_rest::economics::init();

    let state = Arc::new(AppState {
        provider,
        live,
        screener: Screener::default(),
        host,
        clients: Clients::default(),
        origins: origins.clone(),
    });

    let cors = match &origins {
        None => {
            eprintln!("[server] OPENTRADER_ALLOWED_ORIGINS unset: any page origin may call this server");
            CorsLayer::permissive()
        }
        Some(list) => {
            let values: Vec<HeaderValue> = list.iter().filter_map(|o| o.parse().ok()).collect();
            CorsLayer::new()
                .allow_origin(AllowOrigin::list(values))
                .allow_methods([axum::http::Method::GET, axum::http::Method::POST])
                .allow_headers([header::CONTENT_TYPE, header::HeaderName::from_static(clients::CLIENT_HEADER)])
        }
    };

    let mut app = Router::new()
        .route("/api/health", get(|| async { "ok" }))
        .route("/api/invoke/{command}", post(invoke::handle))
        .route("/api/events", get(events))
        .route("/api/ticker-icon/{*encoded}", get(icon))
        .with_state(state)
        .layer(cors);
    if let Ok(dir) = std::env::var("OPENTRADER_STATIC_DIR") {
        // The single-page app: unknown paths get its index.
        let index = std::path::Path::new(&dir).join("index.html");
        app = app.fallback_service(ServeDir::new(&dir).fallback(ServeFile::new(index)));
    }

    let listener = tokio::net::TcpListener::bind(&bind).await.unwrap_or_else(|e| panic!("bind {bind}: {e}"));
    eprintln!("[server] listening on http://{bind}");
    axum::serve(listener, app).await.expect("server");
}

#[derive(Deserialize)]
struct EventsQuery {
    client: String,
}

/// The live events of one client, filtered to what it subscribed.
async fn events(
    State(state): State<Shared>,
    Query(q): Query<EventsQuery>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if !clients::valid_id(&q.client) {
        return (StatusCode::BAD_REQUEST, "invalid client id").into_response();
    }
    // Browsers send no CORS preflight for a WebSocket: check the page origin here.
    if let Some(list) = &state.origins {
        let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()).unwrap_or("");
        if !list.iter().any(|o| o == origin) {
            return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
        }
    }
    ws.on_upgrade(move |socket| run_events(state, q.client, socket))
}

async fn run_events(state: Shared, client: String, mut socket: WebSocket) {
    let subs = state.clients.connect(&client);
    let mut rx = state.host.subscribe();
    loop {
        tokio::select! {
            ev = rx.recv() => match ev {
                Ok(ev) => {
                    if subs.lock().unwrap().wants(&ev) && socket.send(Message::Text(ev.text.clone().into())).await.is_err() {
                        break;
                    }
                }
                Err(RecvError::Lagged(n)) => eprintln!("[server] client {client} missed {n} events"),
                Err(RecvError::Closed) => break,
            },
            msg = socket.recv() => match msg {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
        }
    }
    // The tab is gone: drop its subscriptions and screener panels.
    if let Some(gone) = state.clients.disconnect(&client, &subs) {
        let _ = state.live.tx.send(SubscribeMsg::DropOwner { owner: client.clone() }).await;
        for owner in gone.screener_owners {
            state.screener.close(&owner);
        }
    }
}

/// A ticker logo by its encoded gateway URL (see `market_rest::fetch_icon`).
async fn icon(State(state): State<Shared>, Path(encoded): Path<String>) -> Response {
    match state.provider.icon(&encoded).await {
        Ok((bytes, content_type)) => (
            [(header::CONTENT_TYPE, content_type), (header::CACHE_CONTROL, "public, max-age=86400".into())],
            bytes,
        )
            .into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, e.to_string()).into_response(),
    }
}
