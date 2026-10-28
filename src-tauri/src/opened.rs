// Files another app hands NeuroVue: AirDrop, "Open in" from the Files app,
// (once macOS declares the types) Finder's Open With, or a Mac's Send to iPad
// (receive.rs). Each lands inside the sandbox first: iOS copies handed-over
// files into the app's Inbox, and receive.rs writes sends to its own.
//
// A file can arrive before the page has loaded, when it is what launched the
// app, so paths wait here until the page takes them; the event only tells a
// page that is already running to look.
//
// iOS purges the Inbox (it lives in tmp), so on iOS `keep` moves each arrival
// into Documents/Received first, where it stays until the person deletes it.
// Recents can then reopen it after a relaunch.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::{Emitter, EventTarget, Manager};

/// Emitted to the launch window when files arrive.
const OPENED_EVENT: &str = "neurovue-files-opened";

#[derive(Default)]
pub(crate) struct OpenedFiles(Mutex<Vec<String>>);

/// Keeps the local files among `urls` and tells the launch window.
#[cfg_attr(not(any(target_os = "macos", target_os = "ios")), allow(dead_code))]
pub(crate) fn receive(app: &tauri::AppHandle, urls: Vec<tauri::Url>) {
    let paths = urls
        .iter()
        .filter_map(|url| url.to_file_path().ok())
        .map(|path| keep(&path.to_string_lossy()))
        .collect();
    receive_paths(app, paths);
}

/// Keeps `paths` for the page to take and tells the launch window.
pub(crate) fn receive_paths(app: &tauri::AppHandle, paths: Vec<String>) {
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

/// Where `keep` moves arrivals. Set only on iOS, so `keep` does nothing elsewhere.
static RECEIVED_DIR: OnceLock<PathBuf> = OnceLock::new();

#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub(crate) fn init_received_dir(dir: PathBuf) {
    let _ = RECEIVED_DIR.set(dir);
}

/// `path`, or where it now lives if it was in the OS temp dir (the iOS Inbox)
/// and could be moved into the received dir. A failed move keeps the original,
/// so the file still opens this time.
pub(crate) fn keep(path: &str) -> String {
    let Some(dir) = RECEIVED_DIR.get() else {
        return path.to_string();
    };
    match move_out_of_temp(Path::new(path), dir) {
        Some(kept) => kept.to_string_lossy().into_owned(),
        None => path.to_string(),
    }
}

fn move_out_of_temp(path: &Path, dir: &Path) -> Option<PathBuf> {
    let path = path.canonicalize().ok()?;
    let temp = std::env::temp_dir().canonicalize().ok()?;
    if !path.is_file() || !path.starts_with(&temp) {
        return None;
    }
    std::fs::create_dir_all(dir).ok()?;
    let dest = crate::receive::unused_path(dir, path.file_name()?.to_str()?);
    std::fs::rename(&path, &dest).ok()?;
    Some(dest)
}

/// A file the page picked (the iOS picker copies it into the Inbox), kept like
/// a handed-over one so recents can reopen it.
#[tauri::command]
pub(crate) fn keep_picked_file(path: String) -> String {
    keep(&crate::normalize_local_path(&path))
}
