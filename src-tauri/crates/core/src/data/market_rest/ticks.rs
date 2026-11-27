//! A symbol's trades (`ticks/<T>`, real-time accounts only): the prints that set the last price, the bars of tick
//! charts. The answer is `{"ticks":[[timeMs, price, size], ...]}`, oldest first.
use super::{get_json, seg};
use crate::data::gateway::ApiError;
use crate::data::market_stream::{ticker_of, Tick};
use serde::Deserialize;

#[derive(Deserialize)]
struct Answer {
    ticks: Vec<(f64, f64, f64)>,
}

/// The newest `count` ticks of `symbol` before `before_ms` (none: up to now); with `from_ms`, the first `count` from
/// then on (Bar Replay).
pub async fn fetch_ticks(symbol: &str, before_ms: Option<f64>, from_ms: Option<f64>, count: u32) -> Result<Vec<Tick>, ApiError> {
    let mut query = vec![("count", count.to_string())];
    if let Some(to) = before_ms {
        query.push(("to", (to.floor() as i64).to_string()));
    }
    if let Some(from) = from_ms {
        query.push(("from", (from.floor() as i64).to_string()));
    }
    let answer: Answer = get_json("ticks", &format!("ticks/{}", seg(&ticker_of(symbol))), &query).await?;
    Ok(answer.ticks.into_iter().map(|(time_ms, price, volume)| Tick { time_ms, price, volume }).collect())
}
