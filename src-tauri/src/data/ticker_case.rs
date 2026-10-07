/*
 * Ticker notation — the app's name of a ticker the data source spells with a
 * lower-case letter.
 *
 * The data source is case-sensitive and marks a share class with a lower-case
 * letter: preferred shares "BACpB" and "DCOMp", rights "AIIAr" (398 of 13,252
 * active tickers on 07/10/2026, all of the form <root>p, <root>p<series> or
 * <root>r). The app names every symbol in upper case and writes that marker
 * as a slash and the upper-case letter: "NYSE:BAC/PB", "NYSE:DCOM/P",
 * "NYSE:AIIA/R". Both forms carry the same information, so the translation is
 * a rule, done at the provider boundary: requests go out in the source's
 * spelling, results and live events come back under the app's name.
 *
 * "T/PC" (a preferred share) and "TPC" (another company) stay two symbols.
 */

/// The source's spelling of an app ticker: a slash and a letter become that
/// letter in lower case ("BAC/PB" → "BACpB"). Any other ticker is unchanged.
pub fn to_source(ticker: &str) -> String {
    let mut out = String::with_capacity(ticker.len());
    let mut chars = ticker.chars().peekable();
    while let Some(ch) = chars.next() {
        match chars.peek() {
            Some(next) if ch == '/' && next.is_ascii_alphabetic() => {
                out.push(next.to_ascii_lowercase());
                chars.next();
            }
            _ => out.push(ch),
        }
    }
    out
}

/// The app's name of a source ticker: a lower-case letter becomes a slash and
/// that letter in upper case ("BACpB" → "BAC/PB").
pub fn to_app(ticker: &str) -> String {
    let mut out = String::with_capacity(ticker.len() + 1);
    for ch in ticker.chars() {
        if ch.is_ascii_lowercase() {
            out.push('/');
            out.push(ch.to_ascii_uppercase());
        } else {
            out.push(ch);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::symbol::SymbolRef;

    #[test]
    fn share_class_marker_is_a_slash_in_the_app() {
        for (source, app) in [("BACpB", "BAC/PB"), ("DCOMp", "DCOM/P"), ("AIIAr", "AIIA/R"), ("TpC", "T/PC")] {
            assert_eq!(to_app(source), app);
            assert_eq!(to_source(app), source);
        }
    }

    #[test]
    fn other_tickers_are_unchanged() {
        for t in ["AAPL", "TPC", "BRK.A", "BCPC", "X:BTCUSD"] {
            assert_eq!(to_app(t), t);
            assert_eq!(to_source(t), t);
        }
        // A slash without a letter after it is no marker.
        assert_eq!(to_source("BAC/"), "BAC/");
    }

    #[test]
    fn a_full_name_keeps_its_exchange() {
        let sym = SymbolRef::parse("nyse:bac/pb");
        assert_eq!((sym.exchange.as_str(), sym.ticker.as_str()), ("NYSE", "BAC/PB"));
        assert_eq!(to_source(&sym.ticker), "BACpB");
    }

    /// Every lower-case ticker of the real list has the form the rule covers
    /// and survives the round trip; a preferred share loads under its source
    /// spelling and is found by its app name (network). Run with:
    ///   cargo test --lib ticker_case_live -- --nocapture --ignored
    #[tokio::test]
    #[ignore = "hits the gateway; run explicitly"]
    async fn ticker_case_live() {
        use crate::data::massive_rest;
        let list = massive_rest::fetch_reference_tickers().await.unwrap();
        let lower: Vec<&str> =
            list.iter().map(|r| r.ticker.as_str()).filter(|t| t.bytes().any(|b| b.is_ascii_lowercase())).collect();
        let odd: Vec<&&str> = lower.iter().filter(|t| to_source(&to_app(t)) != **t || t.contains('/')).collect();
        eprintln!("{} tickers, {} with a lower-case letter, {} not covered {:?}", list.len(), lower.len(), odd.len(), odd);
        assert!(!lower.is_empty() && odd.is_empty());
        let names: std::collections::HashSet<String> = list.iter().map(|r| to_app(&r.ticker)).collect();
        assert_eq!(names.len(), list.len(), "two tickers share an app name");

        let ticker = to_source("BAC/PB");
        let to = crate::data::trading_calendar::ny_today();
        let bars = massive_rest::fetch_daily_aggs(&ticker, to - chrono::Duration::days(3650), to, true).await.unwrap();
        let archive = crate::data::daily_archive::daily_bars(&ticker, true).await.unwrap();
        let snap = massive_rest::fetch_ticker_snapshot(&ticker).await.unwrap();
        let ticks = massive_rest::fetch_snapshots(&[ticker.clone(), "AAPL".to_string()]).await.unwrap();
        eprintln!(
            "{ticker}: {} daily bars, {} archived, last {}, bulk snapshot {:?}",
            bars.len(), archive.len(), snap.last, ticks.iter().map(|t| t.ticker.as_str()).collect::<Vec<_>>(),
        );
        assert!(!bars.is_empty() && !archive.is_empty() && ticks.len() == 2);
        for q in ["BAC/P", "BAC", "T/PC", "TPC", "AIIA/"] {
            let found = massive_rest::search_tickers(q, None).await.unwrap();
            eprintln!("search {q}: {:?}", found.iter().map(|r| r.ticker.as_str()).take(14).collect::<Vec<_>>());
        }
        let found = massive_rest::search_tickers("BAC/P", None).await.unwrap();
        assert!(found.iter().any(|r| r.ticker == "BAC/PB") && found.iter().all(|r| r.ticker.starts_with("BAC/P")));
        assert!(massive_rest::search_tickers("BAC", None).await.unwrap().iter().any(|r| r.ticker == "BAC/PB"));
    }
}
