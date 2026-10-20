/*
 * The app's symbol names ("NASDAQ:BRK.B") and the broker's stock contracts
 * (symbol "BRK B", primary exchange "NYSE") in both directions.
 */

/// The app's exchange prefix for a primary listing exchange, `None` when the
/// app has no prefix for it.
pub fn app_exchange(primary: &str) -> Option<&'static str> {
    Some(match primary.to_ascii_uppercase().as_str() {
        "NASDAQ" | "ISLAND" => "NASDAQ",
        "NYSE" => "NYSE",
        // The app files NYSE American and NYSE Arca under one prefix.
        "AMEX" | "ARCA" | "NYSEARCA" | "NYSEAMEX" => "AMEX",
        "BATS" | "CBOE" | "BYX" | "EDGX" | "EDGEA" => "CBOE",
        "IEX" => "IEX",
        "PINK" | "OTC" | "OTCBB" | "PINKS" => "OTC",
        _ => return None,
    })
}

/// The primary exchanges an app prefix may stand for (most likely first).
pub fn broker_exchanges(app: &str) -> &'static [&'static str] {
    match app.to_ascii_uppercase().as_str() {
        "NASDAQ" => &["NASDAQ"],
        "NYSE" => &["NYSE"],
        "AMEX" => &["ARCA", "AMEX"],
        "CBOE" => &["BATS"],
        "IEX" => &["IEX"],
        "OTC" => &["PINK"],
        _ => &[],
    }
}

/// "BRK.B" → "BRK B" (the broker separates share classes with a space).
pub fn broker_ticker(ticker: &str) -> String {
    ticker.replace(['.', '/'], " ")
}

/// "BRK B" → "BRK.B".
pub fn app_ticker(symbol: &str) -> String {
    symbol.trim().replace(' ', ".")
}

/// Split "EXCHANGE:TICKER" (the exchange is optional).
pub fn split(symbol: &str) -> (Option<&str>, &str) {
    match symbol.split_once(':') {
        Some((ex, t)) => (Some(ex), t),
        None => (None, symbol),
    }
}

/// The app's name of a broker stock: "NASDAQ:AAPL", or the bare ticker when
/// the listing exchange is unknown.
pub fn app_symbol(broker_symbol: &str, primary: &str) -> String {
    let t = app_ticker(broker_symbol);
    match app_exchange(primary) {
        Some(ex) => format!("{ex}:{t}"),
        None => t,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tickers_round_trip() {
        assert_eq!(broker_ticker("BRK.B"), "BRK B");
        assert_eq!(app_ticker("BRK B"), "BRK.B");
        assert_eq!(app_symbol("AAPL", "NASDAQ"), "NASDAQ:AAPL");
        assert_eq!(app_symbol("SPY", "ARCA"), "AMEX:SPY");
        assert_eq!(app_symbol("XYZ", ""), "XYZ");
        assert_eq!(split("NYSE:BRK.B"), (Some("NYSE"), "BRK.B"));
        assert_eq!(split("AAPL"), (None, "AAPL"));
    }

    #[test]
    fn exchanges_map_back() {
        for app in ["NASDAQ", "NYSE", "AMEX", "CBOE", "IEX", "OTC"] {
            for b in broker_exchanges(app) {
                assert_eq!(app_exchange(b), Some(app));
            }
        }
    }
}
