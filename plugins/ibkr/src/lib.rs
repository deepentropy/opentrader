/*
 * OpenTrader's Interactive Brokers plugin: a broker plugin (plugins/PROTOCOL.md) between the app and the user's IB
 * Gateway / TWS, or the broker's servers it logs in to itself (`direct`). The app starts it with its address and token in the environment; `run_session` says hello, then
 * answers the app's broker requests and pushes the account until the app closes the connection.
 */
pub mod datafeed;
pub mod direct;
pub mod ib;
pub mod link;
pub mod orders;
pub mod prompt;
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

pub const API: u32 = 3;
/// The exchange of the plugin's chart symbols (`IBKR:AAPL`), as in the manifest.
pub const EXCHANGE: &str = "IBKR";
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
struct SearchParams {
    query: String,
}

#[derive(Deserialize)]
struct TickerParams {
    ticker: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BarsParams {
    ticker: String,
    resolution: String,
    // Numbers: the app may send them with a fraction (1794528000.0).
    from: f64,
    to: f64,
    #[serde(default)]
    count_back: Option<f64>,
}

#[derive(Deserialize)]
struct PromptAnswerParams {
    id: String,
    #[serde(default)]
    value: Option<String>,
}

#[derive(Deserialize)]
struct InstrumentParams {
    ticker: String,
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
        "data.search" => {
            let r: SearchParams = params(method, p)?;
            ib.data.search(&ib.data_link()?, &r.query).await
        }
        "data.symbolInfo" => {
            let r: TickerParams = params(method, p)?;
            ib.data.symbol_info(&ib.data_link()?, &r.ticker).await
        }
        "data.bars" => {
            let r: BarsParams = params(method, p)?;
            let count_back = r.count_back.filter(|c| c.is_finite() && *c >= 1.0).map_or(5000, |c| c as usize);
            ib.data.bars(&ib.data_link()?, &r.ticker, &r.resolution, r.from as i64, r.to as i64, count_back).await
        }
        "broker.getState" => Ok(ib.store.read(|t| serde_json::to_value(t.snapshot()).unwrap_or_default())),
        "broker.instrument" => {
            let r: InstrumentParams = params(method, p)?;
            Ok(serde_json::to_value(ib.instrument(&r.ticker).await?).unwrap_or_default())
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
        "broker.previewOrder" => {
            let t: OrderTicket = params(method, p)?;
            Ok(ib.preview(t).await?)
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
        "plugin.configure" => {
            // The plugin's data folder, which the app gives its plugins (a direct login's restart token).
            let data = std::env::var_os("OPENTRADER_PLUGIN_DATA").filter(|d| !d.is_empty()).map(std::path::PathBuf::from);
            match params::<ConfigureParams>(method, p).map_err(|e| e.message).and_then(|r| Config::from_settings(&r.settings, data)) {
                Ok(cfg) => {
                    println!("[info] settings: {}, client ID {}", cfg.target(), cfg.client_id);
                    ib.configure(cfg);
                }
                Err(e) => ib.store.update(|t| t.notice("error", e)),
            }
        }
        "plugin.promptAnswer" => match params::<PromptAnswerParams>(method, p) {
            Ok(r) => ib.prompts.answer(&r.id, r.value),
            Err(e) => println!("[warn] {}", e.message),
        },
        "data.subscribe" => match params::<WatchParams>(method, p) {
            Ok(r) => ib.stream(r.tickers),
            Err(e) => println!("[warn] {}", e.message),
        },
        "broker.watchQuote" => match params::<WatchParams>(method, p) {
            Ok(r) => ib.watch_quotes(r.tickers),
            Err(e) => println!("[warn] {}", e.message),
        },
        "broker.watchDepth" => match params::<WatchParams>(method, p) {
            Ok(r) => ib.watch_depth(r.tickers),
            Err(e) => println!("[warn] {}", e.message),
        },
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bars_params_take_fractions() {
        let r: BarsParams = params("data.bars", json!({ "ticker": "AAPL", "resolution": "5", "from": 1794528000.0, "to": 1795212000, "countBack": 300.0 })).unwrap();
        assert_eq!((r.from as i64, r.to as i64, r.count_back), (1_794_528_000, 1_795_212_000, Some(300.0)));
    }

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
