/*
 * The title bar main menu's app commands (#335):
 *  - Zoom: one factor for every window, from 20 % to 500 % (the window steps
 *    it by 10 %). It lasts for the run: the app starts again at 100 %, as the
 *    reference app does. A window opened later takes it (`app_zoom_get`).
 *  - Exit: every window writes its settings, then the app quits with all its
 *    windows kept for the next start (a ready update installs, as on any quit).
 *  - The clipboard's text, for "Open link from clipboard" (read here: the
 *    webview's clipboard API wants the page focused and may ask permission).
 */
use opentrader_core::sync::LockExt;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_specta::Event;

const MIN_ZOOM: f64 = 0.2;
const MAX_ZOOM: f64 = 5.0;

pub struct Zoom(Mutex<f64>);

impl Default for Zoom {
    fn default() -> Self {
        Self(Mutex::new(1.0))
    }
}

/// The zoom changed (every window updates the value its menu shows).
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type, Event)]
pub struct AppZoomChanged {
    pub zoom: f64,
}

/// A factor in range, to the tenth (steps of 10 % stay exact).
fn clamp_zoom(factor: f64) -> f64 {
    if !factor.is_finite() {
        return 1.0;
    }
    ((factor * 10.0).round() / 10.0).clamp(MIN_ZOOM, MAX_ZOOM)
}

/// Set the zoom of every window; returns the factor applied.
#[tauri::command]
#[specta::specta]
pub fn app_zoom_set(app: AppHandle, zoom: State<'_, Zoom>, factor: f64) -> f64 {
    let z = clamp_zoom(factor);
    *zoom.0.locked() = z;
    for w in app.webview_windows().values() {
        let _ = w.set_zoom(z);
    }
    let _ = AppZoomChanged { zoom: z }.emit(&app);
    z
}

/// The zoom, applied to the calling window first (a window opened after a change).
#[tauri::command]
#[specta::specta]
pub fn app_zoom_get(window: WebviewWindow, zoom: State<'_, Zoom>) -> f64 {
    let z = *zoom.0.locked();
    if z != 1.0 {
        let _ = window.set_zoom(z);
    }
    z
}

/// Exit: save, then quit with every window kept.
#[tauri::command]
#[specta::specta]
pub async fn app_quit(app: AppHandle) {
    crate::app_update::save_before_exit(&app, None).await;
    app.exit(0);
}

/// The clipboard's text; None when it holds no text.
#[tauri::command]
#[specta::specta]
pub fn app_clipboard_text() -> Option<String> {
    arboard::Clipboard::new().ok()?.get_text().ok()
}

#[cfg(test)]
mod tests {
    use super::clamp_zoom;

    #[test]
    fn zoom_stays_in_range_by_tenths() {
        assert_eq!(clamp_zoom(1.1 + 0.1), 1.2);
        assert_eq!(clamp_zoom(0.1), 0.2);
        assert_eq!(clamp_zoom(7.0), 5.0);
        assert_eq!(clamp_zoom(f64::NAN), 1.0);
    }
}
