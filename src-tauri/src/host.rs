/*
 * The desktop `Host` of the core: its events go to every webview, its quotes
 * to the alert engine.
 */
use crate::data::types::Candle;
use opentrader_core::host::Host;
use tauri::{AppHandle, Emitter};

pub struct DesktopHost(pub AppHandle);

impl Host for DesktopHost {
    fn emit_value(&self, name: &'static str, payload: serde_json::Value) {
        if let Err(e) = self.0.emit(name, payload) {
            eprintln!("[host] emit {name} failed: {e}");
        }
    }

    fn on_quote(&self, symbol: &str, last: f64, minute: Option<&Candle>) {
        crate::alerts::on_quote(&self.0, symbol, last, minute);
    }
}

#[cfg(test)]
mod tests {
    /// The core's wire names are the ones the generated bindings listen to.
    #[test]
    fn event_names_match_bindings() {
        fn same<E: opentrader_core::host::Event + tauri_specta::Event>() {
            assert_eq!(<E as opentrader_core::host::Event>::NAME, <E as tauri_specta::Event>::NAME);
        }
        same::<crate::data::types::ChartAggregate>();
        same::<crate::data::types::SecondAggregate>();
        same::<crate::data::types::TradeTick>();
        same::<crate::data::provider::capabilities::ProviderCapabilities>();
        same::<crate::screener::ScreenerUpdate>();
        same::<opentrader_core::broker::types::BrokerState>();
        same::<opentrader_core::broker::types::BrokerQuote>();
    }
}
