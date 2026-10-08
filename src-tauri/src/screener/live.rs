/*
 * The screener's live feed client.
 *
 * The gateway polls the full-market snapshot once for every app and sends it
 * over one WebSocket (`gateway::SCREENER_LIVE_URL`): the whole table first,
 * then only what changed, every 10 s. Each message is a binary frame of
 * gzip-compressed JSON:
 *
 *   {"type":"full","seq","cols":[…],"tickers":[…],"rows":[[…]]}
 *   {"type":"delta","seq","set":{"AAPL":[col,value,…]},"del":[…]}   (+ "error" after a failed poll)
 *   {"type":"error","error":"…"}                                    (the feed has no table)
 *
 * `seq` rises by one per message; a gap means a message was lost and the
 * table held here is no longer the gateway's.
 *
 * This file keeps the raw table (`LiveTable`, pure) and reads the socket
 * (`Feed`). The poll loop in `mod.rs` turns the table into rows with the REST
 * snapshot's rules and falls back to REST polling whenever the feed fails.
 */
use crate::data::gateway;
use crate::data::massive_rest::FeedSnapshot;
use anyhow::{anyhow, bail, Context, Result};
use flate2::read::GzDecoder;
use futures_util::StreamExt;
use serde::Deserialize;
use std::collections::HashMap;
use std::io::Read;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

/// Longest silence of a healthy feed: it sends a message every 10 s, an empty
/// one when nothing changed.
pub const SILENCE_TIMEOUT: Duration = Duration::from_secs(30);
/// Longest wait for the connection and for the table that follows it (a
/// healthy feed sends it at once: 1.3 s measured). Short, because the panel
/// is empty meanwhile and the REST snapshot can fill it.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum FeedMessage {
    Full {
        seq: u64,
        cols: Vec<String>,
        tickers: Vec<String>,
        rows: Vec<Vec<Option<f64>>>,
    },
    Delta {
        seq: u64,
        #[serde(default)]
        set: HashMap<String, Vec<Option<f64>>>,
        #[serde(default)]
        del: Vec<String>,
        #[serde(default)]
        error: Option<String>,
    },
    Error {
        error: String,
    },
}

/// Column positions of the fields the screener reads.
#[derive(Default)]
struct Columns {
    updated_ms: Option<usize>,
    todays_change: Option<usize>,
    day: [Option<usize>; 5],
    prev_day: [Option<usize>; 5],
    min_close: Option<usize>,
}

impl Columns {
    fn new(cols: &[String]) -> Self {
        let at = |name: &str| cols.iter().position(|c| c == name);
        let bar = |p: &str| ["o", "h", "l", "c", "v"].map(|f| at(&format!("{p}.{f}")));
        Self {
            updated_ms: at("updatedMs"),
            todays_change: at("todaysChange"),
            day: bar("day"),
            prev_day: bar("prevDay"),
            min_close: at("min.c"),
        }
    }
}

/// The gateway's table as received: one row of values per ticker.
#[derive(Default)]
pub struct LiveTable {
    seq: u64,
    width: usize,
    columns: Columns,
    rows: HashMap<String, Vec<Option<f64>>>,
}

impl LiveTable {
    /// Apply one decoded message. `Ok(true)` when the table changed; an error
    /// when the message cannot be applied (no table yet, a gap in `seq`, a
    /// failed poll): the caller drops the feed.
    fn apply(&mut self, msg: FeedMessage) -> Result<bool> {
        match msg {
            FeedMessage::Full { seq, cols, tickers, rows } => {
                if tickers.len() != rows.len() {
                    bail!("screener feed: {} tickers for {} rows", tickers.len(), rows.len());
                }
                self.seq = seq;
                self.width = cols.len();
                self.columns = Columns::new(&cols);
                self.rows = tickers.into_iter().zip(rows).collect();
                Ok(true)
            }
            FeedMessage::Delta { seq, set, del, error } => {
                if self.width == 0 {
                    bail!("screener feed: change received before the table");
                }
                if seq != self.seq + 1 {
                    bail!("screener feed: message {} after {}", seq, self.seq);
                }
                self.seq = seq;
                if let Some(e) = error {
                    bail!("screener feed: {e}");
                }
                let changed = !set.is_empty() || !del.is_empty();
                for ticker in del {
                    self.rows.remove(&ticker);
                }
                for (ticker, pairs) in set {
                    // A ticker not in the table yet is new: its other values are missing.
                    let row = self.rows.entry(ticker).or_insert_with(|| vec![None; self.width]);
                    for pair in pairs.chunks_exact(2) {
                        if let Some(col) = pair[0].map(|c| c as usize).filter(|c| *c < row.len()) {
                            row[col] = pair[1];
                        }
                    }
                }
                Ok(changed)
            }
            FeedMessage::Error { error } => bail!("screener feed: {error}"),
        }
    }

    pub fn len(&self) -> usize {
        self.rows.len()
    }

    /// The table as snapshot entries, ordered by ticker.
    pub fn snapshots(&self) -> Vec<FeedSnapshot> {
        let c = &self.columns;
        let mut out: Vec<FeedSnapshot> = self
            .rows
            .iter()
            .map(|(ticker, row)| {
                let value = |col: Option<usize>| col.and_then(|i| row.get(i).copied().flatten());
                // A bar is there when any of its values is; a missing value of it reads 0, as in the REST snapshot.
                let bar = |cols: &[Option<usize>; 5]| {
                    let vals = cols.map(value);
                    vals.iter().any(Option::is_some).then(|| vals.map(|v| v.unwrap_or(0.0)))
                };
                FeedSnapshot {
                    ticker: ticker.clone(),
                    updated_ms: value(c.updated_ms).unwrap_or(0.0),
                    todays_change: value(c.todays_change),
                    day: bar(&c.day),
                    prev_day: bar(&c.prev_day),
                    min_close: value(c.min_close),
                }
            })
            .collect();
        out.sort_by(|a, b| a.ticker.cmp(&b.ticker));
        out
    }
}

fn decode(frame: &[u8]) -> Result<FeedMessage> {
    let mut json = Vec::new();
    GzDecoder::new(frame).read_to_end(&mut json).context("screener feed: gzip")?;
    serde_json::from_slice(&json).context("screener feed: json")
}

/// One connection to the feed with the table it carries.
pub struct Feed {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
    pub table: LiveTable,
}

impl Feed {
    /// Connect and read the first message (the full table).
    pub async fn connect(url: &str) -> Result<Self> {
        let token = gateway::token().context(gateway::NO_TOKEN)?;
        let (ws, _resp) = tokio::time::timeout(CONNECT_TIMEOUT, connect_async(format!("{url}?apiKey={token}")))
            .await
            .map_err(|_| anyhow!("screener feed: connection timed out"))?
            .context("screener feed: connection refused")?;
        let mut feed = Self { ws, table: LiveTable::default() };
        tokio::time::timeout(CONNECT_TIMEOUT, feed.next())
            .await
            .map_err(|_| anyhow!("screener feed: no table after {} s", CONNECT_TIMEOUT.as_secs()))??;
        if feed.table.len() == 0 {
            bail!("screener feed: empty table");
        }
        Ok(feed)
    }

    /// Wait for the next message and apply it. `Ok(true)` when the table
    /// changed. An error (silence, closed socket, lost message, failed poll)
    /// ends this feed: the caller falls back and connects again later.
    pub async fn next(&mut self) -> Result<bool> {
        loop {
            let msg = tokio::time::timeout(SILENCE_TIMEOUT, self.ws.next())
                .await
                .map_err(|_| anyhow!("screener feed: silent for {} s", SILENCE_TIMEOUT.as_secs()))?
                .ok_or_else(|| anyhow!("screener feed: closed"))?
                .context("screener feed: read")?;
            match msg {
                Message::Binary(bytes) => return self.table.apply(decode(&bytes)?),
                Message::Close(_) => bail!("screener feed: closed by the gateway"),
                // Ping / pong are answered by the library; nothing else is sent.
                _ => {}
            }
        }
    }

    /// Close the socket (the gateway stops polling when no client is left).
    pub async fn close(mut self) {
        let _ = self.ws.close(None).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;

    const COLS: &str = r#"["updatedMs","todaysChange","day.o","day.h","day.l","day.c","day.v","day.vw","prevDay.o","prevDay.h","prevDay.l","prevDay.c","prevDay.v","prevDay.vw","min.c","min.av"]"#;

    fn msg(json: &str) -> FeedMessage {
        let mut gz = GzEncoder::new(Vec::new(), Compression::default());
        gz.write_all(json.as_bytes()).unwrap();
        decode(&gz.finish().unwrap()).unwrap()
    }

    fn full() -> LiveTable {
        let mut t = LiveTable::default();
        let json = format!(
            r#"{{"type":"full","version":1,"seq":41,"polled":1,"cols":{COLS},"tickers":["AAPL","BACpB"],
               "rows":[[1000,0.5,10,12,9,11,500,10.5,9,10,8,10.5,400,9.5,11.2,480],[900,null,null,null,null,null,null,null,20,21,19,20.5,50,20.2,null,null]]}}"#
        );
        assert!(t.apply(msg(&json)).unwrap());
        t
    }

    #[test]
    fn full_table_becomes_snapshot_entries() {
        let t = full();
        let s = t.snapshots();
        assert_eq!(s.iter().map(|r| r.ticker.as_str()).collect::<Vec<_>>(), ["AAPL", "BACpB"]);
        assert_eq!((s[0].updated_ms, s[0].todays_change), (1000.0, Some(0.5)));
        assert_eq!(s[0].day, Some([10.0, 12.0, 9.0, 11.0, 500.0]));
        assert_eq!(s[0].prev_day, Some([9.0, 10.0, 8.0, 10.5, 400.0]));
        assert_eq!(s[0].min_close, Some(11.2));
        // No session yet: no day bar, no minute bar.
        assert_eq!((s[1].day, s[1].min_close, s[1].todays_change), (None, None, None));
        assert_eq!(s[1].prev_day, Some([20.0, 21.0, 19.0, 20.5, 50.0]));
    }

    #[test]
    fn delta_sets_values_adds_and_removes_tickers() {
        let mut t = full();
        let changed = t
            .apply(msg(r#"{"type":"delta","seq":42,"polled":2,"set":{"AAPL":[0,2000,5,11.4,6,650],"NEW":[11,3.5,5,null]},"del":["BACpB"]}"#))
            .unwrap();
        assert!(changed);
        let s = t.snapshots();
        assert_eq!(s.iter().map(|r| r.ticker.as_str()).collect::<Vec<_>>(), ["AAPL", "NEW"]);
        assert_eq!(s[0].updated_ms, 2000.0);
        assert_eq!(s[0].day, Some([10.0, 12.0, 9.0, 11.4, 650.0]));
        // The new ticker holds only what the change gave.
        assert_eq!((s[1].day, s[1].prev_day), (None, Some([0.0, 0.0, 0.0, 3.5, 0.0])));
        // An empty change is applied and changes nothing.
        assert!(!t.apply(msg(r#"{"type":"delta","seq":43,"polled":3,"set":{},"del":[]}"#)).unwrap());
    }

    #[test]
    fn lost_message_failed_poll_and_error_end_the_feed() {
        let mut t = full();
        assert!(t.apply(msg(r#"{"type":"delta","seq":44,"polled":2,"set":{},"del":[]}"#)).is_err());
        let mut t = full();
        assert!(t.apply(msg(r#"{"type":"delta","seq":42,"polled":2,"set":{},"del":[],"error":"upstream 502"}"#)).is_err());
        assert!(t.apply(msg(r#"{"type":"error","error":"no table"}"#)).is_err());
        // A change before any table cannot be applied.
        assert!(LiveTable::default().apply(msg(r#"{"type":"delta","seq":1,"set":{},"del":[]}"#)).is_err());
    }

    /// The real feed (network): the rows shaped from its table equal the rows
    /// of a REST snapshot taken at the same time, wherever both hold the same
    /// update of a ticker; changes arrive and apply; closing leaves the feed.
    /// Run with:
    ///   cargo test --lib feed_matches_rest_live -- --nocapture --ignored
    #[tokio::test]
    #[ignore = "hits the gateway; run explicitly"]
    async fn feed_matches_rest_live() {
        use crate::data::massive_rest;
        let status = || async {
            let url = format!("{}?apiKey={}", gateway::SCREENER_LIVE_URL.replace("wss://", "https://"), gateway::token().unwrap());
            massive_rest::http().get(url).send().await.unwrap().json::<serde_json::Value>().await.unwrap()
        };
        let clients_before = status().await["clients"].as_u64().unwrap_or(0);
        let t0 = std::time::Instant::now();
        let mut feed = Feed::connect(gateway::SCREENER_LIVE_URL).await.unwrap();
        eprintln!("full table: {} tickers in {} ms, clients {} -> {}", feed.table.len(), t0.elapsed().as_millis(), clients_before, status().await["clients"]);

        let mut compared = (0, 0, 0);
        for round in 0..3 {
            let t1 = std::time::Instant::now();
            let changed = feed.next().await.unwrap();
            let waited = t1.elapsed().as_millis();
            let (rest, live) = tokio::join!(massive_rest::fetch_market_snapshot(), massive_rest::shape_feed_snapshots(feed.table.snapshots()));
            let (rest, live) = (rest.unwrap(), live.unwrap());
            let by_ticker: HashMap<&str, &massive_rest::MarketRow> = rest.iter().map(|r| (r.ticker.as_str(), r)).collect();
            let (mut same_stamp, mut differ, mut missing) = (0, 0, 0);
            for l in &live {
                let Some(r) = by_ticker.get(l.ticker.as_str()) else {
                    missing += 1;
                    continue;
                };
                if (r.updated_ms - l.updated_ms).abs() >= 1.0 {
                    continue;
                }
                same_stamp += 1;
                let close = |a: f64, b: f64| (a - b).abs() <= 1e-9 * a.abs().max(1.0);
                let ok = close(r.last, l.last) && close(r.change, l.change) && close(r.change_percent, l.change_percent)
                    && close(r.open, l.open) && close(r.high, l.high) && close(r.low, l.low) && close(r.volume, l.volume)
                    && r.live == l.live && r.prev_close.is_some() == l.prev_close.is_some()
                    && close(r.prev_close.unwrap_or(0.0), l.prev_close.unwrap_or(0.0));
                if !ok {
                    differ += 1;
                    if differ <= 3 {
                        eprintln!("  differs {}: rest last {} chg {} vol {} | feed last {} chg {} vol {}", l.ticker, r.last, r.change, r.volume, l.last, l.change, l.volume);
                    }
                }
            }
            eprintln!(
                "delta {round}: after {waited} ms, changed {changed}; rest {} rows, feed {} rows, not in rest {missing}; same update stamp {same_stamp}, of which differing {differ}",
                rest.len(), live.len(),
            );
            compared = (compared.0 + same_stamp, compared.1 + differ, compared.2 + missing);
        }
        assert!(compared.0 > 10_000, "too few rows compared");
        assert_eq!(compared.1, 0, "rows with the same update differ");
        feed.close().await;
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        eprintln!("after close: clients {}", status().await["clients"]);
    }
}
