mod agent;
mod alerts;
mod app_menu;
mod assistant;
mod local_model;
mod app_update;
mod commands;
mod community;
mod deep_link;
mod host;
mod network;
mod plugins;
mod window_session;

// The data side lives in the core crate, shared with the web server.
pub(crate) use opentrader_core::{data, screener};

use data::provider;
use opentrader_core::host::HostRef;
use std::sync::Arc;
use tauri::Manager;
use tauri_specta::{collect_commands, collect_events, Builder};

/// The tauri-specta builder (commands + events). Shared by `run()` and the
/// bindings-export test, so the generated `bindings.ts` always matches the live
/// command set.
fn specta_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            network::get_proxy_settings,
            network::set_proxy_settings,
            network::reset_proxy_settings,
            community::community_auth_listen,
            community::community_auth_wait,
            community::community_auth_cancel,
            community::community_token_get,
            community::community_token_set,
            commands::history::get_daily_history,
            commands::history::get_minute_history,
            commands::history::get_second_history,
            commands::history::get_second_history_tail,
            commands::history::get_aggregates_before,
            commands::history::get_daily_history_before,
            commands::history::clear_cache,
            commands::realtime::set_chart_subscription,
            commands::realtime::set_watchlist_subscription,
            commands::realtime::market_pass_set,
            commands::realtime::market_pass_resume,
            commands::ticker::get_ticker_info,
            commands::ticker::get_symbol_session,
            commands::ticker::get_ticker_snapshot,
            commands::ticker::search_tickers,
            commands::ticker::search_economic,
            commands::ticker::economic_sources,
            commands::events::get_dividends,
            commands::events::get_splits,
            commands::events::get_latest_news,
            commands::events::get_fundamentals,
            commands::events::get_filings,
            commands::events::read_filing,
            commands::meta::get_data_provider,
            commands::meta::get_provider_capabilities,
            commands::meta::open_snapshot,
            commands::images::save_drawing_image,
            commands::images::read_drawing_image,
            commands::images::save_note_image,
            commands::images::read_note_image,
            commands::images::delete_note_image,
            commands::local_series::local_series_list,
            commands::local_series::local_series_save,
            commands::local_series::local_series_read,
            commands::local_series::local_series_delete,
            commands::local_series::local_series_rename,
            commands::local_series::local_folder_pick,
            commands::local_series::local_folder_scan,
            commands::local_series::local_folder_read,
            commands::alerts::post_webhook,
            alerts::alert_engine_claim,
            alerts::alert_engine_info,
            alerts::alert_engine_set,
            commands::screener::screener_open,
            commands::screener::screener_close,
            commands::screener::screener_scan,
            commands::screener::screener_fields,
            commands::screener::screener_custom_fields,
            commands::screener::screener_values,
            commands::screener::screener_progress,
            window_session::take_adopted_window,
            window_session::take_closed_window_bounds,
            window_session::open_window,
            window_session::open_devtools,
            app_menu::app_zoom_set,
            app_menu::app_zoom_get,
            app_menu::app_quit,
            app_menu::app_clipboard_text,
            app_update::app_update_status,
            app_update::app_update_check,
            app_update::app_settings_flushed,
            app_update::app_user_active,
            app_update::app_set_alerts_active,
            app_update::app_update_install,
            app_update::app_build_info,
            agent::agent_server_status,
            agent::agent_server_set_enabled,
            agent::agent_server_set_port,
            agent::agent_server_new_token,
            agent::agent_reply,
            agent::agent_ready,
            assistant::assistant_chat,
            assistant::assistant_cancel,
            local_model::local_model_info,
            local_model::local_model_install,
            local_model::local_model_cancel,
            local_model::local_model_remove,
            deep_link::deep_link_take,
            plugins::plugins_status,
            plugins::plugins_set_port,
            plugins::plugin_catalog,
            plugins::plugin_install_catalog,
            plugins::plugin_pick_file,
            plugins::plugin_install_file,
            plugins::plugin_set_enabled,
            plugins::plugin_set_settings,
            plugins::plugin_new_token,
            plugins::plugin_remove,
            plugins::plugin_folder_candidates,
            plugins::plugin_pick_folder,
            plugins::plugin_copy_files,
            plugins::plugin_logs,
            plugins::broker::broker_status,
            plugins::broker::broker_set_active,
            plugins::broker::broker_set_trading_enabled,
            plugins::broker::broker_select_account,
            plugins::broker::broker_resolve_symbol,
            plugins::broker::broker_place,
            plugins::broker::broker_modify,
            plugins::broker::broker_cancel,
            plugins::broker::broker_close_position,
            plugins::broker::broker_set_position_brackets,
            plugins::broker::broker_watch_quotes,
            plugins::broker::broker_set_symbol_map,
        ])
        .events(collect_events![
            data::types::ChartAggregate,
            data::types::TradeTick,
            data::types::SecondAggregate,
            data::types::MarketTier,
            data::provider::capabilities::ProviderCapabilities,
            screener::ScreenerUpdate,
            alerts::AlertFired,
            alerts::AlertLeader,
            deep_link::DeepLinkOpened,
            app_update::AppUpdateStatus,
            app_update::BeforeExit,
            app_menu::AppZoomChanged,
            agent::AgentRequest,
            plugins::PluginsChanged,
            plugins::broker::BrokerStatus,
            plugins::broker::BrokerOrderEvent,
            plugins::broker::BrokerQuote,
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

    // The active data provider (DATA_PROVIDER env, default gateway). Built once
    // and shared: the icon proxy holds one clone, app state holds another, and
    // the data side starts from it in `.setup()`.
    let provider = provider::build();
    let provider_icon = provider.clone();

    #[cfg(debug_assertions)]
    builder
        .export(
            specta_typescript::Typescript::default(),
            "../src/bindings.ts",
        )
        .expect("Failed to export typescript bindings");

    // One app at a time, and `opentrader://` links (deep_link): the single-instance plugin comes first.
    deep_link::plugins(tauri::Builder::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
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
                alerts::on_window_destroyed(window.app_handle(), &owner);
                // Its screener panel can no longer close itself: stop its market table polling.
                if let Some(s) = window.app_handle().try_state::<screener::Screener>() {
                    s.close(&format!("{owner}:screener"));
                }
                // And the data plugins' streams it asked for.
                if window.app_handle().try_state::<plugins::Plugins>().is_some() {
                    plugins::data::drop_owner(window.app_handle(), &owner);
                }
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
                responder.respond(icon_response(provider.icon(&encoded).await));
            });
        })
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);
            // The core's background tasks start from here, outside any
            // ambient Tokio context: give them Tauri's runtime.
            opentrader_core::rt::set_handle(tauri::async_runtime::handle().inner().clone());
            // The proxy first: the data side connects.
            network::init(app.handle());
            let host: HostRef = Arc::new(host::DesktopHost(app.handle().clone()));
            app.manage(host.clone());
            // Restore the saved windows (main's bounds, then the others) and
            // show them; the config creates main hidden for this.
            window_session::init(app.handle());
            // `opentrader://` links: the ones the app started with wait for main's page.
            deep_link::init(app.handle());
            alerts::init(app.handle());
            // The data side, started as in the web server (`opentrader_core::start`):
            // this install's own gateway token, the live-data task, the
            // entitlements and the symbol catalogs. Its subscription handle
            // (`WsHandle`) goes to app state for the realtime commands, then
            // the provider itself for the data commands.
            let token_file = app.path().app_local_data_dir().unwrap_or_else(|_| data::cache_root()).join("gateway-install.json");
            app.manage(opentrader_core::start(&host, &provider, token_file));
            app.manage(provider);
            app.manage(screener::Screener::default());
            app.manage(app_menu::Zoom::default());
            // Update check at startup, then hourly (app_update).
            app_update::init(app.handle());
            // Settings > Coding agents (listens only when turned on).
            agent::init(app.handle());
            // Settings > Plugins (the Plugin API listens while a plugin is enabled).
            plugins::init(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // A normal quit installs a ready update (app_update).
            if let tauri::RunEvent::Exit = event {
                app_update::on_exit(app);
                // The AI assistant's model server would outlive the app.
                local_model::shutdown();
                // The plugin programs the app started.
                plugins::shutdown(app);
            }
        });
}

/// The `ticker-icon://` answer: the icon with its content type, or the error
/// as text. Built without the fallible builder, so an odd content type from
/// upstream cannot panic the icon task.
fn icon_response<E: std::fmt::Display>(answer: Result<(Vec<u8>, String), E>) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header::CONTENT_TYPE, HeaderValue, Response, StatusCode};
    let text = HeaderValue::from_static("text/plain");
    let (status, body, content_type) = match answer {
        Ok((bytes, ct)) => match HeaderValue::from_str(&ct) {
            Ok(ct) => (StatusCode::OK, bytes, ct),
            Err(_) => (StatusCode::BAD_GATEWAY, format!("icon: unreadable content type {ct:?}").into_bytes(), text),
        },
        Err(e) => (StatusCode::BAD_GATEWAY, e.to_string().into_bytes(), text),
    };
    let mut response = Response::new(body);
    *response.status_mut() = status;
    response.headers_mut().insert(CONTENT_TYPE, content_type);
    response
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

    /// Every command the web server answers (`opentrader_core::commands::SERVED`)
    /// is a desktop command of the bindings, so both builds call the same names.
    #[test]
    fn served_commands_are_desktop_commands() {
        let path = std::env::temp_dir().join(format!("opentrader-bindings-{}.ts", std::process::id()));
        specta_builder().export(specta_typescript::Typescript::default(), &path).expect("export bindings");
        let bindings = std::fs::read_to_string(&path).expect("read bindings");
        let _ = std::fs::remove_file(&path);
        let missing: Vec<&str> =
            opentrader_core::commands::SERVED.iter().copied().filter(|name| !bindings.contains(&format!("(\"{name}\""))).collect();
        assert!(missing.is_empty(), "served but not desktop commands: {missing:?}");
    }

    #[test]
    fn icon_answer_with_an_odd_content_type_is_an_error_not_a_panic() {
        let r = super::icon_response::<&str>(Ok((vec![1], "image/png".into())));
        assert_eq!(r.status(), 200);
        assert_eq!(r.headers()[tauri::http::header::CONTENT_TYPE], "image/png");
        let r = super::icon_response::<&str>(Ok((vec![1], "bad\nvalue".into())));
        assert_eq!(r.status(), 502);
        let r = super::icon_response(Err("gone"));
        assert_eq!((r.status().as_u16(), r.body().as_slice()), (502, b"gone".as_slice()));
    }
}
