/*
 * The app's chart symbols ("NYSE:BRK.B") and the broker's contracts (symbol "BRK B", primary exchange "NYSE").
 *
 * The plugin's ticker for a contract is the broker's own name of it: the symbol for a stock ("AAPL", "BRK B"), the
 * local symbol for anything else ("ESZ6", "EUR.USD", an option's OCC code), so a stock and its options held together
 * stay apart. `broker.resolveSymbol` answers with the same string, which is how the app matches positions and orders
 * to its charts.
 */
use ibapi::contracts::{Contract, SecurityType};

/// The primary exchanges an app exchange prefix may stand for (most likely first); empty when the app's prefix is
/// not a US stock exchange.
pub fn broker_exchanges(app: &str) -> &'static [&'static str] {
    match app.to_ascii_uppercase().as_str() {
        "NASDAQ" => &["NASDAQ"],
        "NYSE" => &["NYSE"],
        // The app files NYSE American and NYSE Arca under one prefix.
        "AMEX" => &["ARCA", "AMEX"],
        "CBOE" => &["BATS"],
        "IEX" => &["IEX"],
        "OTC" => &["PINK"],
        _ => &[],
    }
}

/// "BRK.B" → "BRK B" (the broker separates share classes with a space).
pub fn broker_ticker(ticker: &str) -> String {
    ticker.trim().to_ascii_uppercase().replace(['.', '/'], " ")
}

/// The exchange prefix of "EXCHANGE:TICKER", if any.
pub fn exchange_of(symbol: &str) -> Option<&str> {
    symbol.split_once(':').map(|(ex, _)| ex).filter(|ex| !ex.is_empty())
}

/// The plugin's ticker of a contract (see the top of this file).
pub fn ticker_of(c: &Contract) -> String {
    let symbol = c.symbol.as_str().trim();
    if c.security_type == SecurityType::Stock || c.local_symbol.trim().is_empty() {
        symbol.to_string()
    } else {
        c.local_symbol.trim().to_string()
    }
}

/// The contract to send orders and market data requests with: stocks route SMART, other contracts keep their exchange.
pub fn routed(mut c: Contract) -> Contract {
    if c.security_type == SecurityType::Stock || c.exchange.as_str().is_empty() {
        c.exchange = "SMART".into();
    }
    c
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tickers() {
        assert_eq!(broker_ticker("BRK.B"), "BRK B");
        assert_eq!(broker_ticker(" aapl "), "AAPL");
        assert_eq!(exchange_of("NYSE:BRK.B"), Some("NYSE"));
        assert_eq!(exchange_of("AAPL"), None);
        assert_eq!(broker_exchanges("amex"), &["ARCA", "AMEX"]);
        assert!(broker_exchanges("FX").is_empty());
    }

    #[test]
    fn contract_tickers() {
        let mut stock = Contract::stock("BRK B").build();
        stock.local_symbol = "BRK B".into();
        assert_eq!(ticker_of(&stock), "BRK B");
        let mut option = Contract::stock("AAPL").build();
        option.security_type = SecurityType::Option;
        option.local_symbol = "AAPL  261120C00150000".into();
        assert_eq!(ticker_of(&option), "AAPL  261120C00150000");
        option.local_symbol.clear();
        assert_eq!(ticker_of(&option), "AAPL");
    }

    #[test]
    fn routing() {
        let mut stock = Contract::stock("AAPL").build();
        stock.exchange = "NASDAQ".into();
        assert_eq!(routed(stock).exchange.as_str(), "SMART");
        let mut future = Contract::stock("ES").build();
        future.security_type = SecurityType::Future;
        future.exchange = "CME".into();
        assert_eq!(routed(future).exchange.as_str(), "CME");
    }
}
