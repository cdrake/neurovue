// Files another app hands NeuroVue: AirDrop, "Open in" from the Files app,
// or (once macOS declares the types) Finder's Open With. iOS copies each one
// into the app's Inbox first, so the paths are always inside the sandbox.
//
// A file can arrive before the page has loaded, when it is what launched the
// app, so paths wait here until the page takes them; the event only tells a
// page that is already running to look.

use std::sync::Mutex;
use tauri::{Emitter, EventTarget, Manager};

/// Emitted to the launch window when files arrive.
const OPENED_EVENT: &str = "neurovue-files-opened";

#[derive(Default)]
pub(crate) struct OpenedFiles(Mutex<Vec<String>>);

/// Keeps the local files among `urls` and tells the launch window.
#[cfg_attr(not(any(target_os = "macos", target_os = "ios")), allow(dead_code))]
pub(crate) fn receive(app: &tauri::AppHandle, urls: Vec<tauri::Url>) {
    let paths: Vec<String> = urls
        .iter()
        .filter_map(|url| url.to_file_path().ok())
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    if paths.is_empty() {
        return;
    }
    app.state::<OpenedFiles>()
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .extend(paths);
    let _ = app.emit_to(
        EventTarget::webview_window(crate::MAIN_WINDOW),
        OPENED_EVENT,
        (),
    );
}

/// The files received since the last call, oldest first.
#[tauri::command]
pub(crate) fn take_opened_files(state: tauri::State<'_, OpenedFiles>) -> Vec<String> {
    std::mem::take(
        &mut *state
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()),
    )
}
