/*
 * Window session — windows come back after a restart with their size,
 * position and maximized state (TV Desktop saves every window's normal
 * bounds, state and tabs, and restores them at start).
 *
 *  - Each window's NORMAL bounds (not the maximized ones), its maximized flag
 *    and the focused window are kept here and written to
 *    `<app config dir>/window-session.json`: 500 ms after a move / resize,
 *    and at once when a window closes.
 *  - A window the user closes while other windows stay open is forgotten.
 *    The last window (closing it quits the app) is kept, like TV.
 *  - At start the main window takes its saved bounds before it is shown, and
 *    every other saved window is created again with its label, so its
 *    label-scoped tabs (localStorage `tv:tabs:<label>`) load with it.
 *  - A window whose saved position is on no monitor opens at the default
 *    position (TV drops x/y in that case).
 *  - "main" always exists (it runs the alert engine). When the user had closed
 *    main while other windows stayed open, main takes the first saved window's
 *    bounds, and the frontend moves that window's tabs into main
 *    (`take_adopted_window`).
 *  - A forgotten window's bounds are kept for "Reopen closed window"
 *    (`take_closed_window_bounds`), which opens it again with `open_window`.
 *
 * Tabs themselves stay in the frontend's localStorage (tabs.ts).
 */
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{
    AppHandle, LogicalSize, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, Window, WindowEvent,
};

const FILE: &str = "window-session.json";
const MAIN: &str = "main";
/// Minimum overlap (physical px) between a saved window and a monitor for the
/// saved position to be used.
const MIN_VISIBLE: i32 = 64;

#[derive(Serialize, Deserialize, Clone, Debug, specta::Type)]
pub struct WindowState {
    pub label: String,
    /// Outer position, physical pixels (monitor-independent on Windows).
    pub x: i32,
    pub y: i32,
    /// Inner size, logical pixels.
    pub width: f64,
    pub height: f64,
    pub maximized: bool,
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
struct SessionFile {
    focused: Option<String>,
    windows: Vec<WindowState>,
}

pub struct Session {
    path: PathBuf,
    file: Mutex<SessionFile>,
    adopted: Mutex<Option<String>>,
    /// Bounds of windows the user closed while others stayed open (this run).
    closed: Mutex<HashMap<String, WindowState>>,
    save_pending: AtomicBool,
}

impl Session {
    fn save_now(&self) {
        let snapshot = self.file.lock().unwrap().clone();
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        match serde_json::to_string_pretty(&snapshot) {
            Ok(json) => {
                if let Err(e) = std::fs::write(&self.path, json) {
                    eprintln!("[window-session] write failed: {e}");
                }
            }
            Err(e) => eprintln!("[window-session] encode failed: {e}"),
        }
    }
}

/// Save 500 ms after the last burst of moves / resizes (one writer at a time).
fn schedule_save(app: &AppHandle) {
    let Some(session) = app.try_state::<Session>() else { return };
    if session.save_pending.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(500));
        if let Some(session) = app.try_state::<Session>() {
            session.save_pending.store(false, Ordering::SeqCst);
            session.save_now();
        }
    });
}

/// Current bounds of a window, or None while minimized / fullscreen (those are
/// not the bounds to restore).
fn capture(window: &Window) -> Option<WindowState> {
    if window.is_minimized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false) {
        return None;
    }
    let scale = window.scale_factor().ok()?;
    let pos = window.outer_position().ok()?;
    let size = window.inner_size().ok()?.to_logical::<f64>(scale);
    Some(WindowState {
        label: window.label().to_string(),
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
        maximized: window.is_maximized().unwrap_or(false),
    })
}

/// Record a window's state. A maximized window keeps its last normal bounds.
fn record(session: &Session, window: &Window) {
    let Some(now) = capture(window) else { return };
    let mut file = session.file.lock().unwrap();
    match file.windows.iter_mut().find(|w| w.label == now.label) {
        Some(entry) => {
            entry.maximized = now.maximized;
            if !now.maximized {
                entry.x = now.x;
                entry.y = now.y;
                entry.width = now.width;
                entry.height = now.height;
            }
        }
        None => file.windows.push(now),
    }
}

/// Window events: keep bounds / focus current, forget a window the user closes
/// while others stay open.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    let app = window.app_handle();
    let Some(session) = app.try_state::<Session>() else { return };
    match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            record(&session, window);
            schedule_save(app);
        }
        WindowEvent::Focused(true) => {
            record(&session, window);
            session.file.lock().unwrap().focused = Some(window.label().to_string());
            schedule_save(app);
        }
        WindowEvent::CloseRequested { .. } => {
            let open = app.webview_windows().len();
            {
                let mut file = session.file.lock().unwrap();
                if open > 1 {
                    let label = window.label();
                    if let Some(i) = file.windows.iter().position(|w| w.label == label) {
                        let st = file.windows.remove(i);
                        session.closed.lock().unwrap().insert(st.label.clone(), st);
                    }
                    if file.focused.as_deref() == Some(label) {
                        file.focused = None;
                    }
                }
            }
            if open <= 1 {
                // Quitting: keep the last window with its latest bounds.
                record(&session, window);
            }
            session.save_now();
        }
        _ => {}
    }
}

/// True when the saved outer rectangle overlaps a monitor enough to be seen.
fn on_screen(win: &WebviewWindow, st: &WindowState) -> bool {
    let Ok(monitors) = win.available_monitors() else { return false };
    monitors.iter().any(|m| {
        let scale = m.scale_factor();
        let (mx, my) = (m.position().x, m.position().y);
        let (mw, mh) = (m.size().width as i32, m.size().height as i32);
        let w = (st.width * scale) as i32;
        let h = (st.height * scale) as i32;
        let ox = (st.x + w).min(mx + mw) - st.x.max(mx);
        let oy = (st.y + h).min(my + mh) - st.y.max(my);
        ox >= MIN_VISIBLE && oy >= MIN_VISIBLE
    })
}

fn apply(win: &WebviewWindow, st: &WindowState) {
    let _ = win.set_size(LogicalSize::new(st.width, st.height));
    if on_screen(win, st) {
        let _ = win.set_position(PhysicalPosition::new(st.x, st.y));
    } else {
        let _ = win.center();
    }
    if st.maximized {
        let _ = win.maximize();
    }
}

/// Load the saved session, restore main's bounds, create the other saved
/// windows, then show them. Call from `setup` (the config's main window is
/// created hidden).
pub fn init(app: &AppHandle) {
    let path = match app.path().app_config_dir() {
        Ok(dir) => dir.join(FILE),
        Err(e) => {
            eprintln!("[window-session] no config dir: {e}");
            if let Some(main) = app.get_webview_window(MAIN) {
                let _ = main.show();
            }
            return;
        }
    };
    let saved: SessionFile = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    let Some(main) = app.get_webview_window(MAIN) else {
        eprintln!("[window-session] main window missing");
        return;
    };

    // Which saved window main stands for: itself, or (main was closed while
    // other windows stayed open) the first saved window, whose tabs it adopts.
    let main_idx = saved.windows.iter().position(|w| w.label == MAIN);
    let mut adopted = None;
    let main_state = match main_idx {
        Some(i) => Some(saved.windows[i].clone()),
        None => saved.windows.first().cloned().inspect(|w| {
            adopted = Some(w.label.clone());
        }),
    };
    let others: Vec<WindowState> = saved
        .windows
        .iter()
        .filter(|w| w.label != MAIN && Some(&w.label) != adopted.as_ref())
        .cloned()
        .collect();

    let mut current = SessionFile { focused: None, windows: Vec::new() };
    if let Some(st) = &main_state {
        apply(&main, st);
        current.windows.push(WindowState { label: MAIN.to_string(), ..st.clone() });
    }
    let _ = main.show();

    for st in &others {
        match build_window(app, st) {
            Ok(_) => current.windows.push(st.clone()),
            Err(e) => eprintln!("[window-session] restore {} failed: {e}", st.label),
        }
    }

    // Focus the window that had it (an adopted label now lives in main).
    let focus = saved.focused.map(|f| if Some(&f) == adopted.as_ref() { MAIN.to_string() } else { f });
    if let Some(label) = &focus {
        if let Some(win) = app.get_webview_window(label) {
            let _ = win.set_focus();
        }
    }
    current.focused = focus;

    app.manage(Session {
        path,
        file: Mutex::new(current),
        adopted: Mutex::new(adopted),
        closed: Mutex::new(HashMap::new()),
        save_pending: AtomicBool::new(false),
    });
}

/// Create a window at saved bounds, then show it. Same options as the
/// frontend's detached / new windows (window-bridge.ts): frameless, shadow,
/// no native file drop.
fn build_window(app: &AppHandle, st: &WindowState) -> tauri::Result<WebviewWindow> {
    let win = WebviewWindowBuilder::new(app, &st.label, WebviewUrl::App("index.html".into()))
        .title("OpenTrader")
        .inner_size(st.width, st.height)
        .decorations(false)
        .shadow(true)
        .disable_drag_drop_handler()
        .visible(false)
        .build()?;
    apply(&win, st);
    win.show()?;
    Ok(win)
}

/// Open the calling window's developer tools (TV tab menu "Developer tools").
/// Available in debug builds (Tauri's `devtools` feature is not enabled).
#[tauri::command]
#[specta::specta]
pub fn open_devtools(window: tauri::WebviewWindow) {
    #[cfg(debug_assertions)]
    window.open_devtools();
    #[cfg(not(debug_assertions))]
    let _ = window;
}

/// The saved window whose tabs main takes over at this start (once), or null.
#[tauri::command]
#[specta::specta]
pub fn take_adopted_window(session: State<'_, Session>) -> Option<String> {
    session.adopted.lock().unwrap().take()
}

/// Bounds of a window the user closed while others stayed open (once), for
/// "Reopen closed window". Null when unknown (closed in an earlier run).
#[tauri::command]
#[specta::specta]
pub fn take_closed_window_bounds(session: State<'_, Session>, label: String) -> Option<WindowState> {
    session.closed.lock().unwrap().remove(&label)
}

/// Open a window at saved bounds ("Reopen closed window"). The frontend has
/// written the window's tabs under its label first. Async: creating a window
/// from a synchronous command deadlocks on Windows (Tauri docs).
#[tauri::command]
#[specta::specta]
pub async fn open_window(app: AppHandle, state: WindowState) -> Result<(), String> {
    if app.get_webview_window(&state.label).is_some() {
        return Err(format!("window {} is already open", state.label));
    }
    let win = build_window(&app, &state).map_err(|e| e.to_string())?;
    let _ = win.set_focus();
    if let Some(session) = app.try_state::<Session>() {
        // Its first events may have recorded it already.
        let mut file = session.file.lock().unwrap();
        if !file.windows.iter().any(|w| w.label == state.label) {
            file.windows.push(state);
        }
        drop(file);
        schedule_save(&app);
    }
    Ok(())
}
