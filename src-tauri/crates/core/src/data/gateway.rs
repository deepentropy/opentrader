/*
 * gateway — the one door to market data.
 *
 * Every market-data call (REST and stream) goes through the OpenTrader
 * gateway (`deepentropy/gateway`, a Cloudflare Worker) and its own contract,
 * the "Market API (v2)" of `gateway/doc/README.md`: REST under
 * `/market/v1/`, the stream at `/market/v1/stream`, the screener feed at
 * `/screener/v2/live`. The app depends on that contract only: the gateway
 * holds the upstream credentials and shares one upstream stream connection
 * between all running apps, so users need no key of their own.
 *
 * The token is compiled in from `OPENTRADER_GATEWAY_TOKEN` (`build.rs` takes it
 * from the environment, else from the repo-root `.env`). It is never committed.
 * A build without it reads the same variable at run time (the web server); with
 * neither there is no market data. It is sent as
 * `Authorization: Bearer <token>`, or as the first stream message.
 */
use reqwest::StatusCode;
use std::fmt;
use std::time::Duration;

/// Gateway origin. No trailing slash: the ticker logo URLs of the details
/// answer start with exactly this origin (see `market_rest::fetch_icon`).
pub const BASE: &str = "https://opentrader-gateway.cloudflare-breeder165.workers.dev";

/// REST base of the market API: `<MARKET>/<path>?<query>`.
pub const MARKET: &str = "https://opentrader-gateway.cloudflare-breeder165.workers.dev/market/v1";

/// The market stream. The gateway holds the one upstream connection and picks
/// the delayed or real-time feed itself.
pub const STREAM_URL: &str = "wss://opentrader-gateway.cloudflare-breeder165.workers.dev/market/v1/stream";

/// The screener's live feed: one full-market table, then its changes every
/// 10 s, polled once by the gateway for every app (`?token=<token>`).
pub const SCREENER_LIVE_URL: &str = "wss://opentrader-gateway.cloudflare-breeder165.workers.dev/screener/v2/live";

/// Shown when the build has no token. Surfaces in the UI as the reason a chart
/// failed to load.
pub const NO_TOKEN: &str =
    "No gateway token — set OPENTRADER_GATEWAY_TOKEN when building the app or starting the server";

/// The app token: the compiled-in one, else `OPENTRADER_GATEWAY_TOKEN` from
/// the process environment. `None` when neither is set.
pub fn token() -> Option<&'static str> {
    static RUNTIME: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    option_env!("OPENTRADER_GATEWAY_TOKEN")
        .or_else(|| RUNTIME.get_or_init(|| std::env::var("OPENTRADER_GATEWAY_TOKEN").ok()).as_deref())
        .map(str::trim)
        .filter(|t| !t.is_empty())
}

/// Error codes of the market API (`code` of an error body). Anything else the
/// gateway may add later reads as `Other`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    BadRequest,
    Unauthorized,
    NotEntitled,
    NotFound,
    RateLimited,
    UpstreamError,
    UpstreamTimeout,
    Internal,
    Other,
}

impl ErrorCode {
    pub fn parse(code: &str) -> Self {
        match code {
            "BAD_REQUEST" => Self::BadRequest,
            "UNAUTHORIZED" => Self::Unauthorized,
            "NOT_ENTITLED" => Self::NotEntitled,
            "NOT_FOUND" => Self::NotFound,
            "RATE_LIMITED" => Self::RateLimited,
            "UPSTREAM_ERROR" => Self::UpstreamError,
            "UPSTREAM_TIMEOUT" => Self::UpstreamTimeout,
            "INTERNAL" => Self::Internal,
            _ => Self::Other,
        }
    }

    /// The code of an answer without a readable error body, from its status.
    fn from_status(status: StatusCode) -> Self {
        match status.as_u16() {
            400 => Self::BadRequest,
            401 => Self::Unauthorized,
            403 => Self::NotEntitled,
            404 => Self::NotFound,
            429 => Self::RateLimited,
            502 => Self::UpstreamError,
            504 => Self::UpstreamTimeout,
            500 => Self::Internal,
            _ => Self::Other,
        }
    }
}

/// A failed gateway call: the error body `{"code","error","ref"}` (or what
/// could be read of it). `Display` is the message the user sees; it carries
/// `ref`, which finds the cause in the gateway log.
#[derive(Debug, Clone)]
pub struct ApiError {
    /// What was asked ("bars", "symbol search"…), to read the message alone.
    pub what: &'static str,
    pub code: ErrorCode,
    /// The code as sent (kept for an unknown one).
    pub code_text: String,
    /// The gateway's message (never upstream text).
    pub message: String,
    pub reference: Option<String>,
    /// `Retry-After` of a `RATE_LIMITED` answer.
    pub retry_after: Option<Duration>,
}

impl ApiError {
    /// The request did not reach the gateway or its answer could not be read.
    pub fn transport(what: &'static str, message: impl Into<String>) -> Self {
        Self {
            what,
            code: ErrorCode::Other,
            code_text: "NETWORK".into(),
            message: message.into(),
            reference: None,
            retry_after: None,
        }
    }

    /// An error answer: its status, headers' `Retry-After` and body.
    pub fn from_answer(what: &'static str, status: StatusCode, retry_after: Option<Duration>, body: &[u8]) -> Self {
        #[derive(serde::Deserialize)]
        struct Body {
            #[serde(default)]
            code: Option<String>,
            #[serde(default)]
            error: Option<String>,
            #[serde(default, rename = "ref")]
            reference: Option<String>,
        }
        let parsed: Option<Body> = serde_json::from_slice(body).ok();
        let code_text = parsed.as_ref().and_then(|b| b.code.clone());
        let code = code_text.as_deref().map_or_else(|| ErrorCode::from_status(status), ErrorCode::parse);
        Self {
            what,
            code,
            code_text: code_text.unwrap_or_else(|| format!("HTTP {}", status.as_u16())),
            message: parsed
                .as_ref()
                .and_then(|b| b.error.clone())
                .unwrap_or_else(|| status.canonical_reason().unwrap_or("error").to_lowercase()),
            reference: parsed.and_then(|b| b.reference),
            retry_after,
        }
    }
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {} ({}", self.what, self.message, self.code_text)?;
        if let Some(r) = &self.reference {
            write!(f, ", ref {r}")?;
        }
        write!(f, ")")
    }
}

impl std::error::Error for ApiError {}

impl ApiError {
    /// A failure a later try can get past: the gateway could not be reached,
    /// or was busy or failing. (A build without a token never recovers.)
    pub fn is_transient(&self) -> bool {
        if self.code_text == "NETWORK" {
            return self.message != NO_TOKEN;
        }
        matches!(self.code, ErrorCode::RateLimited | ErrorCode::UpstreamError | ErrorCode::UpstreamTimeout | ErrorCode::Internal)
            || self.code_text.starts_with("HTTP 5")
    }
}

/// Debug builds: the environment variable `var` = `<n>` makes the requests
/// that check it fail as unreachable during the first `n` seconds after the
/// first check (live tests of a server that cannot be reached for one kind
/// of request: `OPENTRADER_TEST_ARCHIVE_DOWN_SECS`,
/// `OPENTRADER_TEST_SYMBOL_HISTORY_DOWN_SECS`).
#[cfg(debug_assertions)]
pub fn test_outage(var: &'static str) -> bool {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    use std::time::Instant;
    static OUTAGES: OnceLock<Mutex<HashMap<&'static str, (Instant, u64)>>> = OnceLock::new();
    let mut outages = OUTAGES.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap_or_else(|e| e.into_inner());
    let (start, secs) = *outages
        .entry(var)
        .or_insert_with(|| (Instant::now(), std::env::var(var).ok().and_then(|v| v.parse().ok()).unwrap_or(0)));
    start.elapsed().as_secs() < secs
}

/// True when `e` is (or wraps) a gateway failure a later try can get past.
pub fn is_transient(e: &anyhow::Error) -> bool {
    e.chain().any(|c| c.downcast_ref::<ApiError>().is_some_and(ApiError::is_transient))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transient_errors_are_the_ones_a_later_try_can_get_past() {
        assert!(ApiError::transport("bars", "request failed: timeout").is_transient());
        assert!(!ApiError::transport("bars", NO_TOKEN).is_transient());
        assert!(ApiError::from_answer("bars", StatusCode::BAD_GATEWAY, None, b"").is_transient());
        assert!(ApiError::from_answer("bars", StatusCode::SERVICE_UNAVAILABLE, None, b"").is_transient());
        assert!(ApiError::from_answer("bars", StatusCode::TOO_MANY_REQUESTS, None, b"").is_transient());
        assert!(!ApiError::from_answer("bars", StatusCode::NOT_FOUND, None, b"").is_transient());
        assert!(!ApiError::from_answer("bars", StatusCode::FORBIDDEN, None, b"").is_transient());
        let wrapped = anyhow::Error::from(ApiError::transport("archive", "request failed")).context("outer");
        assert!(is_transient(&wrapped));
        assert!(!is_transient(&anyhow::anyhow!("archive: columns of different lengths")));
    }

    #[test]
    fn error_body_reads_code_message_and_ref() {
        let e = ApiError::from_answer(
            "bars",
            StatusCode::FORBIDDEN,
            None,
            br#"{"code":"NOT_ENTITLED","error":"this data is not available","ref":"35a8903f"}"#,
        );
        assert_eq!(e.code, ErrorCode::NotEntitled);
        assert_eq!(e.to_string(), "bars: this data is not available (NOT_ENTITLED, ref 35a8903f)");
        // The gateway sends no ref for its own checks (wrong token, bad parameter).
        let e = ApiError::from_answer("bars", StatusCode::UNAUTHORIZED, None, br#"{"code":"UNAUTHORIZED","error":"invalid app token"}"#);
        assert_eq!(e.to_string(), "bars: invalid app token (UNAUTHORIZED)");
    }

    #[test]
    fn unreadable_body_falls_back_on_the_status() {
        let e = ApiError::from_answer("news", StatusCode::TOO_MANY_REQUESTS, Some(Duration::from_secs(3)), b"<html>");
        assert_eq!(e.code, ErrorCode::RateLimited);
        assert_eq!(e.retry_after, Some(Duration::from_secs(3)));
        assert_eq!(e.to_string(), "news: too many requests (HTTP 429)");
        assert_eq!(ErrorCode::parse("SOMETHING_NEW"), ErrorCode::Other);
    }

    #[test]
    fn message_and_code_survive_anyhow() {
        // Commands hand `e.to_string()` to the frontend: the ref must be in it.
        let err: anyhow::Error = ApiError::from_answer("x", StatusCode::NOT_FOUND, None, br#"{"code":"NOT_FOUND","error":"not found","ref":"a1"}"#).into();
        assert_eq!(err.to_string(), "x: not found (NOT_FOUND, ref a1)");
        assert_eq!(err.downcast_ref::<ApiError>().map(|e| e.code), Some(ErrorCode::NotFound));
    }
}
