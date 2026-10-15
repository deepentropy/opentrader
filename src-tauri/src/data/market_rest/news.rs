//! Latest news headlines of a ticker.
use super::get_json;
use chrono::DateTime;
use serde::{Deserialize, Serialize};

/// One news headline for the chart's "Latest news" lollipop: publisher,
/// publish time (UNIX ms) and title.
#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NewsItem {
    pub id: String,
    pub title: String,
    pub publisher: String,
    pub published: f64,
    pub url: Option<String>,
    pub description: Option<String>,
}

/// A `news` answer (newest first).
#[derive(Deserialize)]
struct NewsAnswer {
    #[serde(default)]
    news: Vec<NewsRow>,
}

#[derive(Deserialize)]
struct NewsRow {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    publisher: Option<String>,
    /// Publish time: an RFC 3339 string as served (13/10/2026), or Unix ms.
    #[serde(default)]
    published: Option<serde_json::Value>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    description: Option<String>,
}

/// Publish time in Unix ms from either form of `published`.
fn published_ms(v: &serde_json::Value) -> Option<f64> {
    match v {
        serde_json::Value::Number(n) => n.as_f64(),
        serde_json::Value::String(s) => DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis() as f64),
        _ => None,
    }
}

/// Newest `limit` headlines tagged with `ticker` (newest first). Empty on any
/// lookup failure: the lollipop is decorative.
pub async fn latest_news(ticker: &str, limit: u32) -> Vec<NewsItem> {
    fetch_latest_news(ticker, limit).await.unwrap_or_default()
}

async fn fetch_latest_news(ticker: &str, limit: u32) -> Option<Vec<NewsItem>> {
    let answer: NewsAnswer = get_json(
        "news",
        "news",
        &[("ticker", ticker.to_string()), ("limit", limit.clamp(1, 100).to_string())],
    )
    .await
    .map_err(|e| eprintln!("[market_rest] {e}"))
    .ok()?;
    Some(
        answer
            .news
            .into_iter()
            // A headline without id, title or time cannot be placed or shown;
            // a missing publisher reads empty.
            .filter_map(|r| {
                Some(NewsItem {
                    id: r.id?,
                    title: r.title?,
                    publisher: r.publisher.unwrap_or_default(),
                    published: published_ms(r.published.as_ref()?)?,
                    url: r.url,
                    description: r.description,
                })
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn published_reads_both_forms() {
        assert_eq!(published_ms(&serde_json::json!("2026-10-15T07:30:00Z")), Some(1_792_049_400_000.0));
        assert_eq!(published_ms(&serde_json::json!(1_792_049_400_000i64)), Some(1_792_049_400_000.0));
        assert_eq!(published_ms(&serde_json::Value::Null), None);
    }
}
