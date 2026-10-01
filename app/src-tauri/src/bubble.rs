//! The bubble: a small window above the other apps during a recording. It shows the recording state, the audio levels,
//! and the live transcript, so the user can see that Tinta records while the call app is in front.
//!
//! The bubble shows while a recording is active and the main window does not have the focus. Each recording gets a new
//! bubble at the top right of the primary display, the display with the menu bar. During the recording, the bubble stays
//! where the user drags it.

use tauri::{AppHandle, LogicalPosition, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "bubble";
/// The size of the closed bubble. The window sets a larger size when the user opens the transcript.
const WIDTH: f64 = 236.0;
const HEIGHT: f64 = 64.0;
/// The space between the bubble and the top right corner of the screen.
const MARGIN: f64 = 24.0;

/// Shows or hides the bubble. `recording` is true while a recording is active.
pub fn sync(app: &AppHandle, recording: bool) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || update(&handle, recording));
}

fn update(app: &AppHandle, recording: bool) {
    let main_focused = app.get_webview_window("main").and_then(|w| w.is_focused().ok()).unwrap_or(false);
    let show = recording && !main_focused;
    match app.get_webview_window(LABEL) {
        Some(window) if show => {
            let _ = window.show();
        }
        Some(window) if recording => {
            let _ = window.hide();
        }
        // The next recording gets a new bubble in the start place, closed.
        Some(window) => {
            let _ = window.destroy();
        }
        None if show => {
            let _ = create(app);
        }
        None => {}
    }
}

/// The top left corner of the bubble at the top right of the primary display, in points.
/// macOS places windows in points on all displays, so displays with other scale factors do not change the place.
fn start_place(app: &AppHandle) -> LogicalPosition<f64> {
    let Ok(Some(monitor)) = app.primary_monitor() else { return LogicalPosition::new(MARGIN, MARGIN) };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let left = area.position.x as f64 / scale;
    let top = area.position.y as f64 / scale;
    LogicalPosition::new(left + area.size.width as f64 / scale - WIDTH - MARGIN, top + MARGIN)
}

fn create(app: &AppHandle) -> tauri::Result<()> {
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
        .title("Tinta recording")
        .inner_size(WIDTH, HEIGHT)
        .visible(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .focused(false)
        .accept_first_mouse(true)
        .build()?;
    // The place is set after the build, so it does not depend on the display where macOS first puts the window.
    window.set_position(start_place(app))?;
    window.show()
}

/// Shows the main window, for a click in the bubble.
pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
