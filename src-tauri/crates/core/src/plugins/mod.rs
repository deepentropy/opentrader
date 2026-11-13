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

/// The Plugin API version this app speaks.
pub const API_VERSION: u32 = 1;
