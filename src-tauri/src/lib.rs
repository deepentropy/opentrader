mod app_update;
mod commands;
mod data;
mod window_session;

use data::provider;
use tauri::Manager;
use tauri_specta::{collect_commands, collect_events, Builder};

#[tauri::command]
#[specta::specta]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// The tauri-specta builder (commands + events). Shared by `run()` and the
/// bindings-export test, so the generated `bindings.ts` always matches the live
/// command set.
fn specta_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            greet,
            commands::history::get_daily_history,
            commands::history::get_minute_history,
            commands::history::get_second_history,
            commands::history::get_second_history_tail,
            commands::history::get_aggregates_before,
            commands::history::get_daily_history_before,
            commands::realtime::set_chart_subscription,
            commands::realtime::set_watchlist_subscription,
            commands::ticker::get_ticker_info,
            commands::ticker::get_ticker_snapshot,
            commands::ticker::search_tickers,
            commands::events::get_dividends,
            commands::events::get_splits,
            commands::events::get_latest_news,
            commands::meta::get_data_provider,
            commands::meta::get_provider_capabilities,
            commands::meta::open_snapshot,
            commands::images::save_drawing_image,
            commands::images::read_drawing_image,
            commands::alerts::post_webhook,
            window_session::take_adopted_window,
            window_session::take_closed_window_bounds,
            window_session::open_window,
            window_session::open_devtools,
            app_update::app_update_status,
            app_update::app_update_check,
            app_update::app_update_flushed,
            app_update::app_update_install,
            app_update::app_build_info,
        ])
        .events(collect_events![
            data::types::ChartAggregate,
            data::types::TradeTick,
            data::types::SecondAggregate,
            data::provider::capabilities::ProviderCapabilities,
            app_update::AppUpdateStatus,
            app_update::AppUpdateBeforeInstall,
        ])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Load .env into the environment, for DATA_PROVIDER (see `provider::build`)
    // — the only setting still read from there at run time. The gateway token
    // is compiled in instead (`data::gateway`, `build.rs`), so a packaged build,
    // where no `.env` resolves, has the same single source as a dev run.
    //
    // Best-effort: both paths are relative to the working directory, so they
    // only resolve when running from the repo (`cargo tauri dev` runs from
    // `src-tauri/`, making `../.env` the repo-root file).
    let _ = dotenvy::from_path(std::path::Path::new("../.env"));
    let _ = dotenvy::dotenv();

    let builder = specta_builder();

    // The active data provider (DATA_PROVIDER env, default massive). Built once
    // and shared: the icon proxy holds one clone, app state holds another, and
    // the realtime task is spawned from it in `.setup()`.
    let provider = provider::build();
    let provider_icon = provider.clone();

    #[cfg(debug_assertions)]
    builder
        .export(
            specta_typescript::Typescript::default(),
            "../src/bindings.ts",
        )
        .expect("Failed to export typescript bindings");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // A destroyed window can no longer clear its own subscription slots
        // (its webview is gone) — drop everything it owned so its symbols
        // don't stay subscribed forever.
        .on_window_event(|window, event| {
            // Window bounds / maximized / focus for the restart (window_session).
            window_session::on_window_event(window, event);
            if let tauri::WindowEvent::Destroyed = event {
                use tauri::Manager;
                let owner = window.label().to_string();
                if let Some(handle) = window.app_handle().try_state::<data::types::WsHandle>() {
                    let tx = handle.tx.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = tx.send(data::types::SubscribeMsg::DropOwner { owner }).await;
                    });
                }
            }
        })
        // `ticker-icon://` proxy: the webview asks for an icon by its (token-less)
        // proxy URL; we re-attach the gateway token here and stream the bytes
        // back so the token never appears in the DOM or the webview's request logs.
        .register_asynchronous_uri_scheme_protocol("ticker-icon", move |_ctx, request, responder| {
            let encoded = request.uri().path().trim_start_matches('/').to_string();
            let provider = provider_icon.clone();
            tauri::async_runtime::spawn(async move {
                let response = match provider.icon(&encoded).await {
                    Ok((bytes, content_type)) => tauri::http::Response::builder()
                        .status(200)
                        .header(tauri::http::header::CONTENT_TYPE, content_type)
                        .body(bytes)
                        .unwrap(),
                    Err(e) => tauri::http::Response::builder()
                        .status(502)
                        .header(tauri::http::header::CONTENT_TYPE, "text/plain")
                        .body(e.to_string().into_bytes())
                        .unwrap(),
                };
                responder.respond(response);
            });
        })
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);
            // Restore the saved windows (main's bounds, then the others) and
            // show them; the config creates main hidden for this.
            window_session::init(app.handle());
            // Spawn the provider's live-data task and expose its subscription
            // handle (`WsHandle`, an mpsc of `SubscribeMsg`) in app state — the
            // realtime commands push onto it. Then manage the provider itself so
            // the data commands can route through it. Which transport backs the
            // handle (REST poll vs WebSocket) is the provider's concern.
            let handle = provider.spawn(app.handle().clone());
            app.manage(handle);
            // Publish the cached entitlements (no network wait) and re-probe in
            // the background when missing or stale.
            provider::entitlements::init(app.handle(), provider.clone());
            app.manage(provider);
            // Update check at startup, then hourly (app_update).
            app_update::init(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::specta_builder;

    /// Regenerate `src/bindings.ts` from the live command set without launching
    /// the app: `cargo test export_bindings`. The same export `run()` does in
    /// debug, so the committed bindings stay in sync.
    #[test]
    fn export_bindings() {
        specta_builder()
            .export(specta_typescript::Typescript::default(), "../src/bindings.ts")
            .expect("export bindings");
    }
}
