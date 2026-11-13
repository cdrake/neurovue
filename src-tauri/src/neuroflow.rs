// The Pipelines view's backend: a locally installed `neuroflow-mcp` (an MCP
// server over stdio JSON-RPC), spawned on the first request and relayed to.
// Settings live in neuroflow.json next to mcp.json; `--data-root` is mcp.json's
// `roots`, so agents and pipelines see the same folders. The process manager
// itself is in neuroflow_core.rs, shared with neurovue-web.

pub(crate) use crate::neuroflow_core::NeuroflowState;
use crate::neuroflow_core::{build_args, valid_run_id, Emit, Settings};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, Runtime};

const TEMPLATE: &str = r#"{
  "binary": "~/Dev/neuroflow/target/release/neuroflow-mcp",
  "registries": ["~/Dev/neuroflow/gallery"],
  "spec": "~/Dev/neuroflow-spec",
  "interpreters": { "node": "/opt/homebrew/bin/node", "python3": "~/.venvs/neuroflow/bin/python" }
}
"#;

fn settings_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("neuroflow.json"))
        .map_err(|error| error.to_string())
}

fn home<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path().home_dir().map_err(|error| error.to_string())
}

fn sessions_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(home(app)?.join(".neuroflow").join("runs"))
}

fn load_settings<R: Runtime>(app: &AppHandle<R>) -> Result<Settings, String> {
    let path = settings_path(app)?;
    let bytes = std::fs::read(&path)
        .map_err(|error| format!("NeuroFlow isn't set up ({}): {error}", path.display()))?;
    let settings: Settings = serde_json::from_slice(&bytes)
        .map_err(|error| format!("{} is invalid: {error}", path.display()))?;
    Ok(settings.expanded(&home(app)?))
}

fn path_string(path: PathBuf) -> Result<String, String> {
    path.into_os_string()
        .into_string()
        .map_err(|path| format!("{} is not valid UTF-8", PathBuf::from(path).display()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NeuroflowStatus {
    configured: bool,
    running: bool,
    settings_path: String,
    stderr_tail: Vec<String>,
}

#[tauri::command]
pub(crate) async fn neuroflow_status(app: AppHandle) -> Result<NeuroflowStatus, String> {
    let path = settings_path(&app)?;
    if !path.exists() {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
        }
        std::fs::write(&path, TEMPLATE).map_err(|error| error.to_string())?;
    }
    let state = app.state::<NeuroflowState>();
    let stderr_tail = state.stderr_tail();
    Ok(NeuroflowStatus {
        configured: load_settings(&app).is_ok_and(|s| Path::new(&s.binary).is_file()),
        running: state.running(),
        settings_path: path.display().to_string(),
        stderr_tail,
    })
}

#[tauri::command]
pub(crate) async fn neuroflow_request(
    app: AppHandle,
    method: String,
    params: Value,
) -> Result<Value, String> {
    let settings = load_settings(&app)?;
    let args = build_args(
        &settings,
        &crate::mcp::allowed_roots(&app),
        &sessions_dir(&app)?,
    );
    let emitter = app.clone();
    let emit: Emit = Arc::new(move |params| {
        let _ = emitter.emit("neuroflow:progress", params);
    });
    let state = app.state::<NeuroflowState>();
    let version = app.package_info().version.to_string();
    state
        .ensure(Path::new(&settings.binary), &args, &version, emit)
        .await?;
    // Lets the client tell a run's id from a concurrent catalog/describe request.
    let token = params.pointer("/_meta/progressToken").cloned();
    state
        .request(&method, params, |id| {
            let _ = app.emit(
                "neuroflow:request-id",
                json!({ "requestId": id, "progressToken": token }),
            );
        })
        .await
}

#[tauri::command]
pub(crate) async fn neuroflow_cancel(app: AppHandle, request_id: u64) -> Result<(), String> {
    app.state::<NeuroflowState>().cancel(request_id).await
}

#[tauri::command]
pub(crate) async fn neuroflow_restart(app: AppHandle) -> Result<(), String> {
    app.state::<NeuroflowState>().stop().await;
    Ok(())
}

#[tauri::command]
pub(crate) async fn neuroflow_read_run(app: AppHandle, run_id: String) -> Result<Value, String> {
    if !valid_run_id(&run_id) {
        return Err(format!("{run_id:?} is not a run id"));
    }
    let dir = sessions_dir(&app)?.join(&run_id);
    let bytes = std::fs::read(dir.join("run.json"))
        .map_err(|error| format!("couldn't read run {run_id}: {error}"))?;
    let record: Value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    Ok(json!({ "sessionDir": path_string(dir)?, "record": record }))
}

/// Decodes only `file://` URLs (iOS pickers); a plain path is used byte-for-byte,
/// so a file really named `scan%20a.nii.gz` stays that.
fn input_path(path: &str) -> PathBuf {
    if path.starts_with("file://") {
        PathBuf::from(crate::normalize_local_path(path))
    } else {
        PathBuf::from(path)
    }
}

#[tauri::command]
pub(crate) async fn neuroflow_check_path(app: AppHandle, path: String) -> Result<String, String> {
    let path = input_path(&path);
    path_string(crate::mcp::resolve_in_roots(
        &path,
        &crate::mcp::allowed_roots(&app),
    )?)
}

/// Shows `path` in the file manager. shortcut: any path, unconfined; it only
/// reveals (never opens or runs) — confine to roots if it ever does more.
#[tauri::command]
pub(crate) fn neuroflow_reveal(path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut cmd = Command::new("open");
        cmd.arg("-R").arg(&path);
        cmd
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        // Explorer parses its own command line: the path must be quoted after the comma.
        let mut cmd = Command::new("explorer");
        cmd.raw_arg(format!("/select,\"{}\"", path.display()));
        cmd
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut cmd = {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(path.parent().unwrap_or(&path));
        cmd
    };
    let mut child = cmd.spawn().map_err(|error| error.to_string())?;
    // Reap it, or each reveal leaves a zombie until the app quits.
    std::thread::spawn(move || child.wait());
    Ok(())
}

/// App exit: cancel running steps and stop the process (blocks up to STOP_GRACE).
pub(crate) fn stop<R: Runtime>(app: &AppHandle<R>) {
    app.state::<NeuroflowState>().stop_now();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_path_keeps_percent_names() {
        let dir = std::env::temp_dir().join(format!("neuroflow-pct-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir = std::fs::canonicalize(&dir).unwrap();
        let file = dir.join("scan%20a.nii.gz");
        std::fs::write(&file, b"").unwrap();
        let input = file.to_str().unwrap();
        let resolved = crate::mcp::resolve_in_roots(&input_path(input), std::slice::from_ref(&dir));
        assert_eq!(resolved, Ok(file));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
