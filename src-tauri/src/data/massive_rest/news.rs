//! Latest news headlines of a ticker.
use super::http;
use crate::data::gateway::{self, BASE};
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

#[derive(Deserialize)]
struct NewsResponse {
    #[serde(default)]
    results: Vec<NewsRow>,
}

#[derive(Deserialize)]
struct NewsRow {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    publisher: Option<NewsPublisher>,
    #[serde(default)]
    published_utc: Option<String>,
    #[serde(default)]
    article_url: Option<String>,
    #[serde(default)]
    description: Option<String>,
}

#[derive(Deserialize)]
struct NewsPublisher {
    #[serde(default)]
    name: Option<String>,
}

/// Newest `limit` headlines tagged with `ticker` (newest first). Empty on any
/// lookup failure: the lollipop is decorative.
pub async fn latest_news(ticker: &str, limit: u32) -> Vec<NewsItem> {
    fetch_latest_news(ticker, limit).await.unwrap_or_default()
}

async fn fetch_latest_news(ticker: &str, limit: u32) -> Option<Vec<NewsItem>> {
    let token = gateway::token()?;
    let url = format!(
        "{BASE}/v2/reference/news?ticker={ticker}&order=desc&sort=published_utc&limit={limit}&apiKey={token}"
    );
    let resp = http().get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: NewsResponse = resp.json().await.ok()?;
    Some(
        body.results
            .into_iter()
            .filter_map(|r| {
                let published = DateTime::parse_from_rfc3339(r.published_utc.as_deref()?).ok()?;
                Some(NewsItem {
                    id: r.id?,
                    title: r.title?,
                    publisher: r.publisher.and_then(|p| p.name).unwrap_or_default(),
                    published: published.timestamp_millis() as f64,
                    url: r.article_url,
                    description: r.description,
                })
            })
            .collect(),
    )
}
