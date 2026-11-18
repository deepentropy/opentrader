/*
 * Symbol identity — "EXCHANGE:TICKER", the full name the frontend keeps for
 * every chart, watchlist row and alert. Commands receive the full name and
 * hand providers both parts, so a provider listing the same ticker on two
 * exchanges (NSE:RELIANCE, BSE:RELIANCE) can tell them apart. Live events
 * carry the full name back.
 */

/// One symbol: its exchange ("" for a bare ticker) and the provider ticker.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SymbolRef {
    pub exchange: String,
    pub ticker: String,
}

/// See `SymbolRef::could_be_ticker`; also takes the source's spelling ("BACpB").
pub fn could_be_ticker(t: &str) -> bool {
    t.len() <= 20
        && t.starts_with(|c: char| c.is_ascii_alphanumeric())
        && t.chars().any(|c| c.is_ascii_alphabetic())
        && t.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '/'))
}

impl SymbolRef {
    /// "NASDAQ:AAPL" → (NASDAQ, AAPL); a bare "AAPL" → ("", AAPL). Uppercased.
    pub fn parse(symbol: &str) -> Self {
        let s = symbol.trim().to_uppercase();
        match s.split_once(':') {
            Some((exchange, ticker)) => Self { exchange: exchange.to_string(), ticker: ticker.to_string() },
            None => Self { exchange: String::new(), ticker: s },
        }
    }

    /// The ticker can name a listed security: letters, digits and `.` `-` `/`
    /// (share classes, preferreds, units), starting with a letter or a digit
    /// and holding a letter. A word with a space or a quote, or a number (a
    /// table's cells uploaded as a watchlist, #355), is never asked for.
    pub fn could_be_ticker(&self) -> bool {
        could_be_ticker(&self.ticker)
    }

    /// The full name ("NASDAQ:AAPL"; the bare ticker when no exchange).
    pub fn full(&self) -> String {
        if self.exchange.is_empty() {
            self.ticker.clone()
        } else {
            format!("{}:{}", self.exchange, self.ticker)
        }
    }
}

impl std::fmt::Display for SymbolRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.full())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_and_bare() {
        let s = SymbolRef::parse("nse:reliance");
        assert_eq!((s.exchange.as_str(), s.ticker.as_str()), ("NSE", "RELIANCE"));
        assert_eq!(s.full(), "NSE:RELIANCE");
        let b = SymbolRef::parse("AAPL");
        assert_eq!((b.exchange.as_str(), b.ticker.as_str()), ("", "AAPL"));
        assert_eq!(b.full(), "AAPL");
    }

    #[test]
    fn tells_tickers_from_table_cells() {
        for t in ["AAPL", "BRK.B", "BAC/PB", "NASDAQ:MSFT", "X:BTCUSD", "C3IS", "DE40", "4DS"] {
            assert!(SymbolRef::parse(t).could_be_ticker(), "{t}");
        }
        for t in ["-2.5939832", "-", "7103565945", "\"PRICE", "AMERICAN DEPOSITARY SHARES", "(1)", "%", "", "SHARE)"] {
            assert!(!SymbolRef::parse(t).could_be_ticker(), "{t}");
        }
    }
}
