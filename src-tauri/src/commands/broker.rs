/*
 * Broker commands (trading panel, order ticket). The connection and its
 * tables live in the core (`opentrader_core::broker`); changes reach the
 * views as `broker-state` / `broker-quote` events.
 */
use opentrader_core::broker::types::{BrokerConfig, BrokerState, OrderTicket};
use opentrader_core::broker::Broker;
use opentrader_core::host::HostRef;
use tauri::State;

#[tauri::command]
#[specta::specta]
pub async fn broker_state(broker: State<'_, Broker>) -> Result<BrokerState, String> {
    Ok(broker.state())
}

#[tauri::command]
#[specta::specta]
pub async fn broker_connect(
    host: State<'_, HostRef>,
    broker: State<'_, Broker>,
    config: BrokerConfig,
) -> Result<BrokerState, String> {
    broker.connect(host.inner().clone(), config).await
}

#[tauri::command]
#[specta::specta]
pub async fn broker_disconnect(broker: State<'_, Broker>) -> Result<(), String> {
    broker.disconnect().await;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn broker_select_account(broker: State<'_, Broker>, account: String) -> Result<(), String> {
    broker.select_account(account).await
}

/// Returns the row id of the new order (the parent of a bracket).
#[tauri::command]
#[specta::specta]
pub async fn broker_place_order(broker: State<'_, Broker>, ticket: OrderTicket) -> Result<String, String> {
    broker.place_order(ticket).await
}

#[tauri::command]
#[specta::specta]
pub async fn broker_modify_order(
    broker: State<'_, Broker>,
    id: String,
    ticket: OrderTicket,
) -> Result<(), String> {
    broker.modify_order(id, ticket).await
}

#[tauri::command]
#[specta::specta]
pub async fn broker_cancel_order(broker: State<'_, Broker>, id: String) -> Result<(), String> {
    broker.cancel_order(id).await
}

#[tauri::command]
#[specta::specta]
pub async fn broker_close_position(broker: State<'_, Broker>, id: String) -> Result<(), String> {
    broker.close_position(id).await
}

/// Quote one symbol for the order ticket; `null` stops it.
#[tauri::command]
#[specta::specta]
pub async fn broker_watch_quote(broker: State<'_, Broker>, symbol: Option<String>) -> Result<(), String> {
    broker.watch_quote(symbol).await
}
