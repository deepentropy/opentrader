/*
 * Plugins: programs outside the app that supply market data (`datafeed`) or a broker account (`broker`). They connect
 * to the app's Plugin API, JSON-RPC 2.0 messages one per line over plain TCP on 127.0.0.1 (plugins/PROTOCOL.md): plain
 * TCP and lines so any language can speak it, down to the socket functions of a trading terminal's scripts.
 *
 * Here: the manifest a package carries and the server the plugins connect to. Installing, starting and the settings
 * screen belong to the desktop app (src-tauri/src/plugins).
 */
pub mod broker;
pub mod hub;
pub mod manifest;

/// The Plugin API version this app speaks. 2: a data plugin may serve several exchanges (`exchanges`). 3: password
/// settings, settings shown for another's value (`when`), prompts to the user (`plugin.prompt`) and a data folder.
/// 4: ready-made watchlists. 5: symbol events. 6: a symbol's extra series (`series`, open interest) and fields.
/// 7: the broker's own account manager tabs (`pages`: holdings…). 8: a data plugin says its symbols' info changed
/// (`data.symbolInfoChanged`); short messages that go away by themselves (`plugin.toast`); a data
/// plugin's scripts (`data.scripts`).
pub const API_VERSION: u32 = 9;
