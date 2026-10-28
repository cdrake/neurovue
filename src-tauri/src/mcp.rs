// The MCP server for AI agents (mcp-server/main.ts, compiled to the
// `neurovue-mcp` sidecar). Off until the person turns on View > Allow AI
// Agents: while it runs, any process on this machine can drive NeuroVue and
// open files through it. The choice persists in the app config dir, and every
// window learns of a change through the `neurovue-mcp` event.
//
// Agents open files only inside the allowed data roots (NeuroFlow RFC 0009
// §5.4): the `roots` in mcp.json, or the home folder when it names none.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{CheckMenuItem, MenuItemKind};
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

pub(crate) const MENU_ALLOW_AGENTS: &str = "mcp-allow-agents";
const STATUS_EVENT: &str = "neurovue-mcp";
// Dev builds take the next port, so one can run beside the installed app.
const DEFAULT_PORT: u16 = if cfg!(debug_assertions) { 4243 } else { 4242 };

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpStatus {
    enabled: bool,
    port: u16,
    /// Why the server isn't running although enabled.
    error: Option<String>,
}

#[derive(Default)]
pub(crate) struct McpState {
    child: Mutex<Option<Child>>,
    error: Mutex<Option<String>>,
    /// Counts starts, so a watcher left from an earlier start stands down.
    generation: AtomicU64,
}

#[derive(Default, Serialize, Deserialize)]
struct McpPrefs {
    enabled: bool,
    /// Folders agents may open files from; the home folder when empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    roots: Vec<PathBuf>,
}

fn port() -> u16 {
    std::env::var("NEUROVUE_MCP_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

fn prefs_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("mcp.json"))
}

fn prefs<R: Runtime>(app: &AppHandle<R>) -> McpPrefs {
    prefs_path(app)
        .and_then(|path| std::fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice::<McpPrefs>(&bytes).ok())
        .unwrap_or_default()
}

fn is_enabled<R: Runtime>(app: &AppHandle<R>) -> bool {
    prefs(app).enabled
}

/// The folders agents may open files from, as configured (not yet resolved).
fn allowed_roots<R: Runtime>(app: &AppHandle<R>) -> Vec<PathBuf> {
    let roots = prefs(app).roots;
    if !roots.is_empty() {
        return roots;
    }
    app.path().home_dir().into_iter().collect()
}

fn save_enabled<R: Runtime>(app: &AppHandle<R>, enabled: bool) {
    let Some(path) = prefs_path(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let prefs = McpPrefs {
        enabled,
        ..prefs(app)
    };
    if let Ok(bytes) = serde_json::to_vec_pretty(&prefs) {
        if let Err(error) = std::fs::write(&path, bytes) {
            eprintln!("NeuroVue: couldn't save {}: {error}", path.display());
        }
    }
}

fn status<R: Runtime>(app: &AppHandle<R>) -> McpStatus {
    let state = app.state::<McpState>();
    McpStatus {
        enabled: is_enabled(app),
        port: port(),
        error: state.error.lock().ok().and_then(|error| error.clone()),
    }
}

/// Starts the sidecar when the saved preference says so and checks the menu
/// item to match; called once at launch.
pub(crate) fn start_if_enabled<R: Runtime>(app: &AppHandle<R>) {
    if !is_enabled(app) {
        return;
    }
    if let Some(item) = allow_agents_item(app) {
        let _ = item.set_checked(true);
    }
    start(app);
}

/// The View menu's Allow AI Agents item. `Menu::get` looks only at the top
/// level, so this searches the submenus.
pub(crate) fn allow_agents_item<R: Runtime>(app: &AppHandle<R>) -> Option<CheckMenuItem<R>> {
    fn find<R: Runtime>(items: Vec<MenuItemKind<R>>) -> Option<CheckMenuItem<R>> {
        items.into_iter().find_map(|item| {
            if item.id() == MENU_ALLOW_AGENTS {
                return item.as_check_menuitem().cloned();
            }
            item.as_submenu()
                .and_then(|submenu| find(submenu.items().ok()?))
        })
    }
    find(app.menu()?.items().ok()?)
}

fn start<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<McpState>();
    let Ok(mut child) = state.child.lock() else {
        return;
    };
    if child.is_some() {
        return;
    }
    let roots = std::env::join_paths(allowed_roots(app)).unwrap_or_default();
    let spawned = crate::niimath::sidecar_binary("neurovue-mcp").and_then(|program| {
        Command::new(program)
            .env("NEUROVUE_MCP_PORT", port().to_string())
            .env("NEUROVUE_MCP_ROOTS", roots)
            .env("NEUROVUE_PARENT_PID", std::process::id().to_string())
            .env("NEUROVUE_VERSION", app.package_info().version.to_string())
            .spawn()
            .map_err(|error| format!("couldn't start the agent server: {error}"))
    });
    let error = match spawned {
        Ok(process) => {
            *child = Some(process);
            let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
            watch(app.clone(), generation);
            None
        }
        Err(error) => {
            eprintln!("NeuroVue: {error}");
            Some(error)
        }
    };
    if let Ok(mut slot) = state.error.lock() {
        *slot = error;
    };
}

/// Notices the server exiting on its own (its port taken, a crash) and tells
/// every window, which then stops trying to reach it.
fn watch<R: Runtime>(app: AppHandle<R>, generation: u64) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        let state = app.state::<McpState>();
        if state.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        let exited = {
            let Ok(mut child) = state.child.lock() else {
                return;
            };
            let Some(process) = child.as_mut() else {
                return;
            };
            match process.try_wait() {
                Ok(Some(exit)) => {
                    child.take();
                    Some(exit)
                }
                _ => None,
            }
        };
        if let Some(exit) = exited {
            let message = format!(
                "The agent server stopped ({exit}); port {} may be in use by another program.",
                port()
            );
            eprintln!("NeuroVue: {message}");
            if let Ok(mut error) = state.error.lock() {
                *error = Some(message);
            };
            let _ = app.emit(STATUS_EVENT, status(&app));
            return;
        }
    });
}

pub(crate) fn stop<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<McpState>();
    state.generation.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut child) = state.child.lock() {
        if let Some(mut process) = child.take() {
            let _ = process.kill();
            let _ = process.wait();
        }
    }
    if let Ok(mut error) = state.error.lock() {
        *error = None;
    };
}

/// The View menu's Allow AI Agents item changed: follow it, save it, tell
/// every window.
pub(crate) fn set_enabled<R: Runtime>(app: &AppHandle<R>, enabled: bool) {
    save_enabled(app, enabled);
    if enabled {
        start(app);
    } else {
        stop(app);
    }
    let _ = app.emit(STATUS_EVENT, status(app));
}

#[tauri::command]
pub(crate) fn mcp_status(app: AppHandle) -> McpStatus {
    status(&app)
}

/// The real path an agent may open, or why not: `path` must be absolute and
/// resolve, after following symlinks, inside an allowed root. The native
/// pickers skip this; only paths that come from an agent go through it.
#[tauri::command]
pub(crate) fn agent_resolve_path(app: AppHandle, path: String) -> Result<String, String> {
    let path = PathBuf::from(crate::normalize_local_path(&path));
    resolve_in_roots(&path, &allowed_roots(&app)).map(|path| path.display().to_string())
}

fn resolve_in_roots(path: &Path, roots: &[PathBuf]) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err(format!("{} is not an absolute path.", path.display()));
    }
    let real = std::fs::canonicalize(path)
        .map_err(|error| format!("Couldn't open {}: {error}", path.display()))?;
    // Component-wise, so a root /data does not admit /database.
    if roots
        .iter()
        .filter_map(|root| std::fs::canonicalize(root).ok())
        .any(|root| real.starts_with(root))
    {
        return Ok(real);
    }
    let names: Vec<String> = roots
        .iter()
        .map(|root| root.display().to_string())
        .collect();
    Err(format!(
        "{} is outside the folders agents may open ({}); the person can add a folder to \"roots\" in NeuroVue's mcp.json.",
        path.display(),
        names.join(", ")
    ))
}

/// Opens another NeuroVue window that connects to the agent server as tab
/// `tab`. Each window has its own dataset.
#[tauri::command]
pub(crate) async fn open_viewer_window(
    app: AppHandle,
    tab: String,
    title: Option<String>,
) -> Result<(), String> {
    if tab.is_empty() || !tab.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("open_viewer_window: the tab id must be letters, digits and dashes".into());
    }
    let label = format!("viewer-{tab}");
    // nv-mcp's client says hello with the id it finds here; the id is checked
    // above, so it needs no escaping.
    let claim_id = format!("sessionStorage.setItem('nv-mcp.tab', '{tab}');");
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(PathBuf::from("index.html")))
        .initialization_script(&claim_id)
        .title(title.unwrap_or_else(|| "NeuroVue".into()))
        .inner_size(1280.0, 860.0)
        .min_inner_size(900.0, 640.0)
        // Like the main window (tauri.conf.json): WebKit otherwise suspends a
        // covered or minimized window's JavaScript, and it stops answering.
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        .build()
        .map(|_| ())
        .map_err(|error| format!("open_viewer_window: {error}"))
}

/// Brings the calling window to the front, restored if minimized, so the
/// person sees the tab an agent drives; returns its title.
#[tauri::command]
pub(crate) fn focus_window(window: tauri::WebviewWindow) -> Result<String, String> {
    let _ = window.unminimize();
    window
        .show()
        .and_then(|()| window.set_focus())
        .map_err(|error| format!("focus_window: {error}"))?;
    Ok(window.title().unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::resolve_in_roots;
    use std::path::PathBuf;

    #[test]
    fn confines_paths_to_the_roots() {
        let base = std::env::temp_dir().join(format!("neurovue-roots-{}", std::process::id()));
        let root = base.join("data");
        let sibling = base.join("database");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        std::fs::write(root.join("sub/t1.nii"), b"").unwrap();
        std::fs::write(sibling.join("t1.nii"), b"").unwrap();
        let roots = vec![root.clone()];

        assert!(resolve_in_roots(&root.join("sub/t1.nii"), &roots).is_ok());
        assert!(resolve_in_roots(&root.join("sub/../sub/t1.nii"), &roots).is_ok());
        assert!(resolve_in_roots(&sibling.join("t1.nii"), &roots).is_err());
        assert!(resolve_in_roots(&root.join("../database/t1.nii"), &roots).is_err());
        assert!(resolve_in_roots(&PathBuf::from("data/sub/t1.nii"), &roots).is_err());
        assert!(resolve_in_roots(&root.join("missing.nii"), &roots).is_err());
        #[cfg(unix)]
        {
            let link = root.join("escape");
            std::os::unix::fs::symlink(&sibling, &link).unwrap();
            assert!(resolve_in_roots(&link.join("t1.nii"), &roots).is_err());
        }
        std::fs::remove_dir_all(&base).unwrap();
    }
}
