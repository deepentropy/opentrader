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

impl SymbolRef {
    /// "NASDAQ:AAPL" → (NASDAQ, AAPL); a bare "AAPL" → ("", AAPL). Uppercased.
    pub fn parse(symbol: &str) -> Self {
        let s = symbol.trim().to_uppercase();
        match s.split_once(':') {
            Some((exchange, ticker)) => Self { exchange: exchange.to_string(), ticker: ticker.to_string() },
            None => Self { exchange: String::new(), ticker: s },
        }
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
}
