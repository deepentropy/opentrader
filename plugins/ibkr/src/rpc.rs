/*
 * The line-delimited JSON-RPC 2.0 to the app (plugins/PROTOCOL.md, "Transport"): one writer task owns the socket's
 * write half, everything else queues whole lines to it.
 */
use serde_json::{json, Value};
use tokio::sync::mpsc;

pub const PARSE_ERROR: i64 = -32700;
pub const UNKNOWN_METHOD: i64 = -32601;
pub const BAD_PARAMS: i64 = -32602;
pub const FAILED: i64 = -32000;

/// A request's error answer; the app shows `message` to the user.
#[derive(Debug, Clone, PartialEq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
}

impl RpcError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

impl From<String> for RpcError {
    fn from(message: String) -> Self {
        Self::new(FAILED, message)
    }
}

impl From<&str> for RpcError {
    fn from(message: &str) -> Self {
        Self::new(FAILED, message)
    }
}

/// The queue to the app's socket.
#[derive(Clone)]
pub struct Out(mpsc::UnboundedSender<String>);

impl Out {
    pub fn channel() -> (Out, mpsc::UnboundedReceiver<String>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Out(tx), rx)
    }

    pub fn send(&self, msg: Value) {
        // A closed queue means the session is over; the reader ends the process.
        let _ = self.0.send(format!("{msg}\n"));
    }

    pub fn notify(&self, method: &str, params: Value) {
        self.send(json!({ "jsonrpc": "2.0", "method": method, "params": params }));
    }

    pub fn answer(&self, id: Value, result: Result<Value, RpcError>) {
        self.send(match result {
            Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
            Err(e) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": e.code, "message": e.message } }),
        });
    }
}

/// The request's params as `T`, or a bad-params error naming what is wrong.
pub fn params<T: serde::de::DeserializeOwned>(method: &str, v: Value) -> Result<T, RpcError> {
    serde_json::from_value(v).map_err(|e| RpcError::new(BAD_PARAMS, format!("{method}: {e}")))
}
