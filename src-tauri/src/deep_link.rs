/*
 * Deep links (#233): `opentrader://post/<id>` from the Community website
 * ("Open in OpenTrader" on a post's chart) brings the app forward and opens
 * the post in the Community panel, its shared chart on the active chart.
 *
 *  - One app at a time (single-instance plugin): a link clicked while the
 *    app runs reaches the running app instead of starting a second one, and
 *    a second launch only brings the open app forward. Two apps would share
 *    one window session and one store on disk.
 *  - The scheme is registered by the installers (tauri.conf.json); an
 *    AppImage registers it at start.
 *  - Links wait in a queue: the window they are for (main, or the first
 *    window left) takes them when told (`DeepLinkOpened`), and main takes
 *    those of a cold start once its page is up (`deep_link_take`).
 */
use serde::{Deserialize, Serialize};
use opentrader_core::sync::LockExt;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_specta::Event;

pub const SCHEME: &str = "opentrader";

/// Links arrived for `window`: it takes them with `deep_link_take`.
#[derive(Clone, Serialize, Deserialize, specta::Type, Event)]
pub struct DeepLinkOpened {
    pub window: String,
}

#[derive(Default)]
pub struct PendingLinks(Mutex<Vec<String>>);

/// Our scheme's links among a launch's arguments or a forwarded open.
pub fn ours<'a>(urls: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    urls.into_iter().filter(|u| u.starts_with(&format!("{SCHEME}://"))).map(str::to_string).collect()
}

/// The window links go to: main, or the first window when main was closed.
fn target(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window("main").or_else(|| app.webview_windows().into_values().next())
}

/// Brings the app's window forward (a link, or a second launch).
pub fn focus(app: &AppHandle) {
    if let Some(w) = target(app) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn deliver(app: &AppHandle, urls: Vec<String>) {
    if urls.is_empty() {
        return;
    }
    if let Some(p) = app.try_state::<PendingLinks>() {
        p.0.locked().extend(urls);
    }
    focus(app);
    if let Some(w) = target(app) {
        let _ = DeepLinkOpened { window: w.label().to_string() }.emit(app);
    }
}

/// Plugins and state: call on the builder (the single-instance plugin first).
pub fn plugins(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder
        // With its "deep-link" feature, a link given to a second launch is passed on as an open-url event.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| focus(app)))
        .plugin(tauri_plugin_deep_link::init())
}

/// In `setup`: the queue, the links the app was started with, the ones that come later.
pub fn init(app: &AppHandle) {
    app.manage(PendingLinks::default());
    #[cfg(all(target_os = "linux", not(debug_assertions)))]
    if let Err(e) = app.deep_link().register_all() {
        eprintln!("[deep-link] scheme not registered: {e}");
    }
    if let Ok(Some(start)) = app.deep_link().get_current() {
        let urls = ours(start.iter().map(|u| u.as_str()));
        if let Some(p) = app.try_state::<PendingLinks>() {
            p.0.locked().extend(urls);
        }
    }
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        let urls = event.urls();
        deliver(&handle, ours(urls.iter().map(|u| u.as_str())));
    });
}

/// The links waiting for this window (emptied).
#[tauri::command]
#[specta::specta]
pub fn deep_link_take(pending: State<'_, PendingLinks>) -> Vec<String> {
    std::mem::take(&mut *pending.0.locked())
}

#[cfg(test)]
mod tests {
    use super::ours;

    #[test]
    fn keeps_only_our_links() {
        assert_eq!(ours(["C:\\OpenTrader.exe", "opentrader://post/abc", "https://x.y"]), vec!["opentrader://post/abc".to_string()]);
    }
}
