/*
 * Host — what the core needs from the program it runs in (the desktop app or
 * the web server): a way to push events to the open views, and the quotes of
 * the live task for the host's own consumers (the desktop alert engine).
 *
 * Events keep the names the desktop bindings know (`chart-aggregate`, ...):
 * the desktop host hands them to its webviews, the web server to its
 * WebSocket clients.
 */
use crate::data::types::Candle;
use serde::Serialize;
use std::sync::Arc;

/// An event payload and its name on the wire (kebab case of the type name,
/// as the desktop bindings derive it).
pub trait Event: Serialize {
    const NAME: &'static str;

    /// Push the event through the host.
    fn emit(&self, host: &HostRef) -> Result<(), serde_json::Error> {
        host.emit_value(Self::NAME, serde_json::to_value(self)?);
        Ok(())
    }

    /// Push the event to the view of a subscription `owner` only.
    fn emit_to(&self, host: &HostRef, owner: &str) -> Result<(), serde_json::Error> {
        host.emit_value_to(owner, Self::NAME, serde_json::to_value(self)?);
        Ok(())
    }
}

pub trait Host: Send + Sync + 'static {
    /// Push one event to every open view.
    fn emit_value(&self, name: &'static str, payload: serde_json::Value);

    /// Push one event to the view of a subscription owner ("<view>" or
    /// "<view>:<pane>", see `SubscribeMsg`). Every view gets it by default:
    /// views keep only the symbols they show.
    fn emit_value_to(&self, _owner: &str, name: &'static str, payload: serde_json::Value) {
        self.emit_value(name, payload);
    }

    /// One quote from the live task: the regular-session last and the latest
    /// minute bar (pre- and post-market included).
    fn on_quote(&self, _symbol: &str, _last: f64, _minute: Option<&Candle>) {}
}

/// Shared handle to the host.
pub type HostRef = Arc<dyn Host>;

/// `impl Event` with the wire name.
macro_rules! event {
    ($ty:ty, $name:literal) => {
        impl $crate::host::Event for $ty {
            const NAME: &'static str = $name;
        }
    };
}
pub(crate) use event;
