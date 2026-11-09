//! A company's filings (`filings/<T>`) and the text of one filing by section
//! (`filings/<T>/<accn>`), for the coding agents' `list_filings` /
//! `read_filing`. Lists are kept in memory a few minutes (a new filing shows
//! within the gateway's own 10 min); a filing never changes, so its pages are
//! kept until newer pages push them out of the memo.
use super::get_json;
use crate::data::gateway::ApiError;
use crate::memo::Memo;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

const LIST_TTL: Duration = Duration::from_secs(5 * 60);
/// Answers kept per memo; past it the oldest goes.
const MEMO_MAX: usize = 64;

/// What `list_filings` asks: every field optional.
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FilingQuery {
    /// Forms ("10-K", "8-K"); a form takes its amendments.
    #[serde(default)]
    pub forms: Option<Vec<String>>,
    /// Event types of the fundamentals `events` ("executive_change"…).
    #[serde(default)]
    pub events: Option<Vec<String>>,
    /// First / last public day (YYYY-MM-DD).
    #[serde(default)]
    pub since: Option<String>,
    #[serde(default)]
    pub until: Option<String>,
    /// 1-100 (the gateway's default 25).
    #[serde(default)]
    pub limit: Option<u32>,
    /// The `next` cursor of the previous page.
    #[serde(default)]
    pub before: Option<String>,
}

/// One filing, as listed.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Filing {
    /// Accession number: the filing's id.
    pub accn: String,
    pub form: String,
    /// The document's description, when it says more than the form.
    #[serde(default)]
    pub title: Option<String>,
    /// New York day the filing became public (YYYY-MM-DD).
    #[serde(default)]
    pub date: Option<String>,
    /// "bmo" (before the regular session), "amc" (after it), or null.
    #[serde(default)]
    pub time: Option<String>,
    /// Period end (the event date of a current report).
    #[serde(default)]
    pub report: Option<String>,
    /// Items of a current report ("2.02", "5.02").
    #[serde(default)]
    pub items: Vec<String>,
    /// Event types of the filing.
    #[serde(default)]
    pub events: Vec<String>,
    #[serde(default)]
    pub amended: bool,
    /// The filing's index page.
    pub url: String,
}

/// A page of a company's filings, newest first.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FilingList {
    pub ticker: String,
    #[serde(default)]
    pub name: Option<String>,
    pub filings: Vec<Filing>,
    /// Older filings remain: ask again with `before: next`.
    #[serde(default)]
    pub more: bool,
    #[serde(default)]
    pub next: Option<String>,
}

/// A section of a filing: an item ("1A", "7", "II-1A", "2.02"), an exhibit
/// ("ex99.1") or `main`.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FilingSection {
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    /// Length of its text.
    pub chars: u32,
}

/// The table of contents of a filing (no `section` asked: `sections` set), or
/// a page of one section's text (`section`, `text`, `offset`, `next`).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FilingText {
    pub ticker: String,
    pub accn: String,
    #[serde(default)]
    pub form: Option<String>,
    #[serde(default)]
    pub date: Option<String>,
    #[serde(default)]
    pub time: Option<String>,
    #[serde(default)]
    pub sections: Option<Vec<FilingSection>>,
    #[serde(default)]
    pub section: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub offset: Option<u32>,
    /// Offset of the next page; null at the section's end.
    #[serde(default)]
    pub next: Option<u32>,
}


/// The query string of `q` (lists comma-separated, as the gateway reads them).
fn query_of(q: &FilingQuery) -> Vec<(&'static str, String)> {
    let mut out = Vec::new();
    let join = |v: &Option<Vec<String>>| v.as_ref().filter(|v| !v.is_empty()).map(|v| v.join(","));
    if let Some(f) = join(&q.forms) {
        out.push(("forms", f));
    }
    if let Some(e) = join(&q.events) {
        out.push(("events", e));
    }
    for (k, v) in [("since", &q.since), ("until", &q.until), ("before", &q.before)] {
        if let Some(v) = v.as_ref().filter(|v| !v.is_empty()) {
            out.push((k, v.clone()));
        }
    }
    if let Some(l) = q.limit {
        out.push(("limit", l.clamp(1, 100).to_string()));
    }
    out
}

/// A page of the filings of `ticker` (the source's spelling).
pub async fn fetch_filings(ticker: &str, q: &FilingQuery) -> Result<FilingList, ApiError> {
    static MEMO: Memo<String, Instant, FilingList> = Memo::new(MEMO_MAX);
    let t = ticker.to_uppercase();
    let query = query_of(q);
    let key = format!("{t}?{query:?}");
    if let Some(l) = MEMO.get(&key, |at| at.elapsed() < LIST_TTL) {
        return Ok(l);
    }
    let l: FilingList = get_json("filings", &format!("filings/{}", super::seg(&t)), &query).await?;
    MEMO.insert(key, Instant::now(), l.clone());
    Ok(l)
}

/// The contents of filing `accn` of `ticker` (no `section`), or a page of
/// one section's text from `offset`.
pub async fn fetch_filing_text(ticker: &str, accn: &str, section: Option<&str>, offset: u32) -> Result<FilingText, ApiError> {
    static MEMO: Memo<String, Instant, FilingText> = Memo::new(MEMO_MAX);
    let t = ticker.to_uppercase();
    let query: Vec<(&str, String)> = match section {
        Some(s) => vec![("section", s.to_string()), ("offset", offset.to_string())],
        None => Vec::new(),
    };
    let key = format!("{t}/{accn}?{query:?}");
    if let Some(f) = MEMO.get(&key, |_| true) {
        return Ok(f);
    }
    let f: FilingText = get_json("filing", &format!("filings/{}/{}", super::seg(&t), super::seg(accn)), &query).await?;
    MEMO.insert(key, Instant::now(), f.clone());
    Ok(f)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_string_skips_empty_fields() {
        let q = FilingQuery {
            forms: Some(vec!["10-K".into(), "8-K".into()]),
            events: Some(vec![]),
            since: Some("2025-01-01".into()),
            until: Some(String::new()),
            limit: Some(500),
            before: None,
        };
        assert_eq!(
            query_of(&q),
            vec![("forms", "10-K,8-K".to_string()), ("since", "2025-01-01".into()), ("limit", "100".into())]
        );
    }

    #[test]
    fn reads_the_gateway_answers() {
        let l: FilingList = serde_json::from_value(serde_json::json!({
            "ticker": "AAPL", "name": "Apple Inc.", "more": true, "next": "MjAyNS0",
            "filings": [{ "accn": "0000320193-25-000071", "form": "8-K", "title": null, "date": "2025-07-31",
                          "time": "amc", "report": "2025-07-31", "items": ["2.02", "9.01"], "events": [],
                          "amended": false, "url": "https://example.test/index.htm" }]
        }))
        .unwrap();
        assert_eq!(l.filings[0].items, vec!["2.02", "9.01"]);
        assert_eq!(l.next.as_deref(), Some("MjAyNS0"));

        let toc: FilingText = serde_json::from_value(serde_json::json!({
            "ticker": "AAPL", "accn": "0000320193-25-000079", "form": "10-K", "date": "2025-10-31", "time": "bmo",
            "sections": [{ "id": "1A", "title": "Risk Factors", "chars": 61234 }]
        }))
        .unwrap();
        assert_eq!(toc.sections.as_ref().unwrap()[0].chars, 61234);
        assert!(toc.text.is_none());

        let page: FilingText = serde_json::from_value(serde_json::json!({
            "ticker": "AAPL", "accn": "0000320193-25-000079", "section": "1A", "title": "Risk Factors",
            "text": "The Company's operations…", "offset": 0, "next": 5987
        }))
        .unwrap();
        assert_eq!((page.offset, page.next), (Some(0), Some(5987)));
        assert!(page.sections.is_none());
    }
}
