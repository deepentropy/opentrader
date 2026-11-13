/*
 * OpenTrader's Interactive Brokers plugin: a broker plugin (plugins/PROTOCOL.md) between the app and the user's IB
 * Gateway / TWS. The app starts it with its address and token in the environment; `run_session` says hello, then
 * answers the app's broker requests and pushes the account until the app closes the connection.
 */
pub mod ib;
pub mod orders;
pub mod rpc;
pub mod state;
pub mod symbols;
pub mod wire;

use ib::{Config, Ibkr};
use rpc::{params, Out, RpcError, PARSE_ERROR, UNKNOWN_METHOD};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use wire::OrderTicket;

pub const API: u32 = 1;
const HELLO_TIMEOUT: Duration = Duration::from_secs(15);

/// One session with the app: Ok when the app closed the connection, Err with the reason when it refused the plugin
/// or could not be reached.
pub async fn run_session(addr: &str, plugin: &str, token: &str) -> Result<(), String> {
    let stream = TcpStream::connect(addr).await.map_err(|e| format!("OpenTrader is not reachable at {addr}: {e}"))?;
    let _ = stream.set_nodelay(true);
    let (read, mut write) = stream.into_split();
    let (out, mut queue) = Out::channel();
    tokio::spawn(async move {
        while let Some(line) = queue.recv().await {
            if write.write_all(line.as_bytes()).await.is_err() {
                return;
            }
        }
    });
    let mut lines = BufReader::new(read).lines();

    out.send(json!({ "jsonrpc": "2.0", "id": 1, "method": "hello",
        "params": { "plugin": plugin, "token": token, "api": API, "version": env!("CARGO_PKG_VERSION") } }));
    let answer = tokio::time::timeout(HELLO_TIMEOUT, async {
        while let Ok(Some(line)) = lines.next_line().await {
            match serde_json::from_str::<Value>(&line) {
                Ok(msg) if msg.get("method").is_none() && msg.get("id") == Some(&json!(1)) => return Some(msg),
                _ => println!("[warn] ignored before hello: {line}"),
            }
        }
        None
    })
    .await
    .map_err(|_| "OpenTrader did not answer hello".to_string())?
    .ok_or("OpenTrader closed the connection during hello")?;
    if let Some(e) = answer.get("error") {
        let message = e.get("message").and_then(Value::as_str).unwrap_or("refused");
        return Err(format!("OpenTrader refused the plugin: {message}"));
    }
    println!("[info] connected to OpenTrader at {addr}");

    let ib = Ibkr::new(out.clone());
    tokio::spawn(state::push_states(ib.store.clone()));
    tokio::spawn(ib.clone().supervise());

    while let Ok(Some(line)) = lines.next_line().await {
        let msg: Value = match serde_json::from_str(&line) {
            Ok(m) => m,
            Err(e) => {
                out.answer(Value::Null, Err(RpcError::new(PARSE_ERROR, format!("Parse error: {e}"))));
                continue;
            }
        };
        let Some(method) = msg.get("method").and_then(Value::as_str).map(str::to_string) else { continue };
        let p = msg.get("params").cloned().unwrap_or(Value::Null);
        match msg.get("id").cloned() {
            // Requests run on their own: an order waiting on the broker doesn't hold the others up.
            Some(id) => {
                let ib = ib.clone();
                let out = out.clone();
                tokio::spawn(async move { out.answer(id, request(&ib, &method, p).await) });
            }
            None => notification(&ib, &method, p),
        }
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveParams {
    symbol: String,
    #[serde(default)]
    ticker: Option<String>,
}

#[derive(Deserialize)]
struct AccountParams {
    account: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModifyParams {
    order_id: String,
    #[serde(flatten)]
    ticket: OrderTicket,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrderParams {
    order_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloseParams {
    position_id: String,
    #[serde(default)]
    qty: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BracketParams {
    position_id: String,
    #[serde(default)]
    take_profit: Option<f64>,
    #[serde(default)]
    stop_loss: Option<f64>,
}

#[derive(Deserialize)]
struct ConfigureParams {
    settings: HashMap<String, String>,
}

#[derive(Deserialize)]
struct WatchParams {
    tickers: Vec<String>,
}

async fn request(ib: &Arc<Ibkr>, method: &str, p: Value) -> Result<Value, RpcError> {
    match method {
        "broker.resolveSymbol" => {
            let r: ResolveParams = params(method, p)?;
            let ticker = r.ticker.unwrap_or_else(|| r.symbol.split_once(':').map_or(r.symbol.as_str(), |(_, t)| t).to_string());
            Ok(json!({ "ticker": ib.resolve_symbol(&r.symbol, &ticker).await? }))
        }
        "broker.selectAccount" => {
            let r: AccountParams = params(method, p)?;
            ib.select_account(&r.account)?;
            Ok(json!({}))
        }
        "broker.place" => {
            let t: OrderTicket = params(method, p)?;
            Ok(json!({ "orderId": ib.place(t).await? }))
        }
        "broker.modify" => {
            let r: ModifyParams = params(method, p)?;
            ib.modify(&r.order_id, r.ticket).await?;
            Ok(json!({}))
        }
        "broker.cancel" => {
            let r: OrderParams = params(method, p)?;
            ib.cancel(&r.order_id).await?;
            Ok(json!({}))
        }
        "broker.closePosition" => {
            let r: CloseParams = params(method, p)?;
            ib.close_position(&r.position_id, r.qty).await?;
            Ok(json!({}))
        }
        "broker.setPositionBrackets" => {
            let r: BracketParams = params(method, p)?;
            ib.set_position_brackets(&r.position_id, r.take_profit, r.stop_loss).await?;
            Ok(json!({}))
        }
        _ => Err(RpcError::new(UNKNOWN_METHOD, format!("Unknown method {method}"))),
    }
}

fn notification(ib: &Arc<Ibkr>, method: &str, p: Value) {
    match method {
        "plugin.configure" => match params::<ConfigureParams>(method, p).map_err(|e| e.message).and_then(|r| Config::from_settings(&r.settings)) {
            Ok(cfg) => {
                println!("[info] settings: {}:{} client ID {}", cfg.host, cfg.port, cfg.client_id);
                ib.configure(cfg);
            }
            Err(e) => ib.store.update(|t| t.notice("error", e)),
        },
        "broker.watchQuote" => match params::<WatchParams>(method, p) {
            Ok(r) => ib.watch_quotes(r.tickers),
            Err(e) => println!("[warn] {}", e.message),
        },
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modify_params_carry_the_ticket() {
        let r: ModifyParams = params(
            "broker.modify",
            json!({ "orderId": "17:4", "ticker": "AAPL", "side": "buy", "type": "limit", "qty": 1, "limitPrice": 1.01,
                    "stopPrice": null, "takeProfit": null, "stopLoss": 0.5 }),
        )
        .unwrap();
        assert_eq!(r.order_id, "17:4");
        assert_eq!((r.ticket.limit_price, r.ticket.stop_loss), (Some(1.01), Some(0.5)));
        let bad = params::<OrderTicket>("broker.place", json!({ "ticker": "AAPL" })).unwrap_err();
        assert_eq!(bad.code, rpc::BAD_PARAMS);
    }
}
