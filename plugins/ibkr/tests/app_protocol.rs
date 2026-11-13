/*
 * The plugin against a fake app (the Plugin API's server side), without IB Gateway / TWS: the hello, the first
 * state, the errors of requests it cannot serve yet, the notice when IB Gateway is not reachable, and the end of the
 * session when the app closes the connection.
 */
use serde_json::{json, Value};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::TcpListener;

struct FakeApp {
    lines: Lines<BufReader<OwnedReadHalf>>,
    write: OwnedWriteHalf,
}

impl FakeApp {
    async fn send(&mut self, msg: Value) {
        self.write.write_all(format!("{msg}\n").as_bytes()).await.unwrap();
    }

    async fn next(&mut self) -> Value {
        let line = tokio::time::timeout(Duration::from_secs(30), self.lines.next_line()).await.expect("a message in time");
        serde_json::from_str(&line.unwrap().expect("the plugin closed the connection")).unwrap()
    }

    /// The next message matching `f`, skipping the others (states pushed in between).
    async fn wait(&mut self, f: impl Fn(&Value) -> bool) -> Value {
        loop {
            let m = self.next().await;
            if f(&m) {
                return m;
            }
        }
    }

    async fn answer_of(&mut self, id: i64) -> Value {
        self.wait(|m| m["id"] == id && m.get("method").is_none()).await
    }
}

/// Start the plugin against a fake app; returns the app's side after the plugin's hello, and the session.
async fn start(accept: bool) -> (FakeApp, Value, tokio::task::JoinHandle<Result<(), String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    let session = tokio::spawn(async move { opentrader_ibkr::run_session(&addr, "ibkr", "secret").await });
    let (socket, _) = listener.accept().await.unwrap();
    let (read, write) = socket.into_split();
    let mut app = FakeApp { lines: BufReader::new(read).lines(), write };
    let hello = app.next().await;
    let reply = if accept {
        json!({ "jsonrpc": "2.0", "id": hello["id"], "result": { "app": "OpenTrader", "api": 1 } })
    } else {
        json!({ "jsonrpc": "2.0", "id": hello["id"], "error": { "code": -32001, "message": "Unknown token" } })
    };
    app.send(reply).await;
    (app, hello, session)
}

/// A local port nothing listens on.
async fn closed_port() -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    l.local_addr().unwrap().port()
}

#[tokio::test]
async fn hello_state_and_errors_without_ib() {
    let (mut app, hello, session) = start(true).await;
    assert_eq!(hello["method"], "hello");
    assert_eq!(hello["params"]["plugin"], "ibkr");
    assert_eq!(hello["params"]["token"], "secret");
    assert_eq!(hello["params"]["api"], 1);
    assert_eq!(hello["params"]["version"], env!("CARGO_PKG_VERSION"));

    // A first state at once: not connected to the broker.
    let state = app.wait(|m| m["method"] == "broker.state").await;
    assert_eq!(state["params"]["connected"], false);
    assert_eq!(state["params"]["positionMode"], "netting");
    assert_eq!(state["params"]["capabilities"]["brackets"], true);

    // Requests it cannot serve are errors with a message for the user.
    app.send(json!({ "jsonrpc": "2.0", "id": 5, "method": "broker.resolveSymbol", "params": { "symbol": "NASDAQ:AAPL", "ticker": "AAPL" } })).await;
    let a = app.answer_of(5).await;
    assert_eq!(a["error"]["code"], -32000);
    assert!(a["error"]["message"].as_str().unwrap().contains("not configured"), "{a}");

    app.send(json!({ "jsonrpc": "2.0", "id": 6, "method": "broker.nope", "params": {} })).await;
    assert_eq!(app.answer_of(6).await["error"]["code"], -32601);

    app.send(json!({ "jsonrpc": "2.0", "id": 7, "method": "broker.place", "params": { "ticker": "AAPL" } })).await;
    let a = app.answer_of(7).await;
    assert_eq!(a["error"]["code"], -32602);

    // A bad ticket is refused before anything is sent.
    app.send(json!({ "jsonrpc": "2.0", "id": 8, "method": "broker.place", "params": { "ticker": "AAPL", "side": "buy", "type": "limit", "qty": 1, "limitPrice": null } })).await;
    let a = app.answer_of(8).await;
    assert!(a["error"]["message"].as_str().unwrap().contains("limit price"), "{a}");

    app.write.write_all(b"not json\n").await.unwrap();
    let a = app.wait(|m| m.get("error").is_some() && m["id"].is_null()).await;
    assert_eq!(a["error"]["code"], -32700);

    // Configured with a port nothing listens on: a notice that says so, still not connected, and requests now say
    // the broker is not connected.
    let port = closed_port().await;
    app.send(json!({ "jsonrpc": "2.0", "method": "plugin.configure", "params": { "settings": { "host": "127.0.0.1", "port": port.to_string(), "clientId": "17" } } })).await;
    let notice = app.wait(|m| m["method"] == "broker.notice").await;
    let text = notice["params"]["message"].as_str().unwrap();
    assert!(text.contains(&format!("127.0.0.1:{port}")) && text.contains("Enable ActiveX"), "{text}");
    assert_eq!(notice["params"]["level"], "warn");
    app.send(json!({ "jsonrpc": "2.0", "id": 9, "method": "broker.cancel", "params": { "orderId": "17:1" } })).await;
    let a = app.answer_of(9).await;
    assert!(a["error"]["message"].as_str().unwrap().contains("Not connected"), "{a}");
    let state = app.wait(|m| m["method"] == "broker.state").await;
    assert_eq!(state["params"]["connected"], false);

    // Bad settings are reported, not fatal.
    app.send(json!({ "jsonrpc": "2.0", "method": "plugin.configure", "params": { "settings": { "port": "abc" } } })).await;
    let notice = app.wait(|m| m["method"] == "broker.notice" && m["params"]["level"] == "error").await;
    assert!(notice["params"]["message"].as_str().unwrap().contains("abc"));

    // The app closes the connection: the session ends.
    drop(app);
    let ended = tokio::time::timeout(Duration::from_secs(10), session).await.expect("the session ends").unwrap();
    assert_eq!(ended, Ok(()));
}

#[tokio::test]
async fn a_refused_hello_ends_the_session_with_the_reason() {
    let (_app, _, session) = start(false).await;
    let ended = tokio::time::timeout(Duration::from_secs(10), session).await.expect("the session ends").unwrap();
    assert!(ended.unwrap_err().contains("Unknown token"));
}
