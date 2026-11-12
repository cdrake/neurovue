//! The Pipelines view's backend in the browser build: the same `neuroflow_*`
//! calls the desktop app answers (src-tauri/src/neuroflow.rs), over /rpc, with
//! the shared process manager in neuroflow_core.rs.
//!
//! Configuration comes from the environment, since a server has no app config
//! dir:
//! - NEUROVUE_NEUROFLOW_CONFIG: a neuroflow.json in the desktop format
//!   (binary, registries, spec, interpreters). Unset or missing: the server
//!   reports Pipelines as unavailable and the page hides them.
//! - NEUROVUE_DATA_ROOTS: ':'-separated folders steps may read inputs from.
//!   Default: $HOME, plus /neurodesktop-storage and /data when they exist.
//!
//! The desktop app pushes progress as Tauri events. A browser behind
//! Neurodesk's proxy gets them by polling `web_events` instead (see
//! src/web/event.ts): no websocket or server-sent events, so a custom-protocol
//! transport could carry them too.

use crate::neuroflow_core::{build_args, valid_run_id, Emit, NeuroflowState, Settings};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Events kept for clients that poll late; older ones are dropped.
const EVENT_BACKLOG: usize = 2000;

#[derive(Default)]
struct Events {
    next: u64,
    queue: VecDeque<(u64, String, Value)>,
}

#[derive(Default)]
pub struct Pipelines {
    state: NeuroflowState,
    events: Arc<Mutex<Events>>,
}

fn push_event(events: &Mutex<Events>, name: &str, payload: Value) {
    let mut events = events.lock().unwrap();
    let id = events.next;
    events.next += 1;
    if events.queue.len() == EVENT_BACKLOG {
        events.queue.pop_front();
    }
    events.queue.push_back((id, name.to_string(), payload));
}

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| "/".into())
}

fn config_path() -> Option<PathBuf> {
    std::env::var_os("NEUROVUE_NEUROFLOW_CONFIG")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn load_settings() -> Result<(PathBuf, Settings), String> {
    let path = config_path().ok_or("Pipelines aren't set up on this server.")?;
    let bytes = std::fs::read(&path)
        .map_err(|error| format!("NeuroFlow isn't set up ({}): {error}", path.display()))?;
    let settings: Settings = serde_json::from_slice(&bytes)
        .map_err(|error| format!("{} is invalid: {error}", path.display()))?;
    Ok((path, settings.expanded(&home())))
}

/// Folders pipeline inputs may come from.
pub fn data_roots() -> Vec<PathBuf> {
    if let Some(roots) = std::env::var_os("NEUROVUE_DATA_ROOTS").filter(|v| !v.is_empty()) {
        return std::env::split_paths(&roots).collect();
    }
    let mut roots = vec![home()];
    for extra in ["/neurodesktop-storage", "/data"] {
        if Path::new(extra).is_dir() {
            roots.push(extra.into());
        }
    }
    roots
}

fn sessions_dir() -> PathBuf {
    home().join(".neuroflow").join("runs")
}

/// `path`, resolved, if it lies inside one of `roots` (component-wise, so a
/// root /data does not admit /database).
fn resolve_in_roots(path: &Path, roots: &[PathBuf]) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err(format!("{} is not an absolute path.", path.display()));
    }
    let real = std::fs::canonicalize(path)
        .map_err(|error| format!("Couldn't open {}: {error}", path.display()))?;
    if roots
        .iter()
        .filter_map(|root| std::fs::canonicalize(root).ok())
        .any(|root| real.starts_with(root))
    {
        return Ok(real);
    }
    let names: Vec<String> = roots.iter().map(|r| r.display().to_string()).collect();
    Err(format!(
        "{} is outside the folders pipelines may read ({}); set NEUROVUE_DATA_ROOTS to add one.",
        path.display(),
        names.join(", ")
    ))
}

fn path_string(path: PathBuf) -> Result<String, String> {
    path.into_os_string()
        .into_string()
        .map_err(|path| format!("{} is not valid UTF-8", PathBuf::from(path).display()))
}

fn arg<'a>(args: &'a Value, name: &str) -> Result<&'a Value, String> {
    args.get(name)
        .filter(|value| !value.is_null())
        .ok_or_else(|| format!("missing {name}"))
}

impl Pipelines {
    /// Answers a Pipelines command, or None if `command` isn't one.
    pub async fn handle(&self, command: &str, args: &Value) -> Option<Result<Value, String>> {
        Some(match command {
            "neuroflow_status" => self.status(),
            "neuroflow_request" => self.request(args).await,
            "neuroflow_cancel" => match arg(args, "requestId").map(Value::as_u64) {
                Ok(Some(id)) => self.state.cancel(id).await.map(|()| Value::Null),
                _ => Err("missing requestId".into()),
            },
            "neuroflow_restart" => {
                self.state.stop().await;
                Ok(Value::Null)
            }
            "neuroflow_read_run" => read_run(args),
            "neuroflow_check_path" => match arg(args, "path").map(Value::as_str) {
                Ok(Some(path)) => resolve_in_roots(
                    Path::new(&crate::dataset::normalize_local_path(path)),
                    &data_roots(),
                )
                .and_then(path_string)
                .map(Value::String),
                _ => Err("missing path".into()),
            },
            "neuroflow_reveal" => {
                Err("Showing files in a file manager isn't available in the browser.".into())
            }
            "web_events" => Ok(self.events_after(args.get("after").and_then(Value::as_u64))),
            _ => return None,
        })
    }

    /// Unconfigured is an error, not `configured: false`: the desktop shows
    /// setup steps for its config file, which a browser user can't follow, so
    /// the page hides Pipelines instead.
    fn status(&self) -> Result<Value, String> {
        let (path, settings) = load_settings()?;
        Ok(json!({
            "configured": Path::new(&settings.binary).is_file(),
            "running": self.state.running(),
            "settingsPath": path.display().to_string(),
            "stderrTail": self.state.stderr_tail(),
        }))
    }

    async fn request(&self, args: &Value) -> Result<Value, String> {
        let method = arg(args, "method")?
            .as_str()
            .ok_or("method must be a string")?
            .to_string();
        let params = args.get("params").cloned().unwrap_or_else(|| json!({}));
        let (_, settings) = load_settings()?;
        let argv = build_args(&settings, &data_roots(), &sessions_dir());
        let events = self.events.clone();
        let emit: Emit = Arc::new(move |params| push_event(&events, "neuroflow:progress", params));
        self.state
            .ensure(
                Path::new(&settings.binary),
                &argv,
                env!("CARGO_PKG_VERSION"),
                emit,
            )
            .await?;
        // Lets the client tell a run's id from a concurrent catalog/describe request.
        let token = params.pointer("/_meta/progressToken").cloned();
        let events = self.events.clone();
        self.state
            .request(&method, params, move |id| {
                push_event(
                    &events,
                    "neuroflow:request-id",
                    json!({ "requestId": id, "progressToken": token }),
                );
            })
            .await
    }

    /// Events after `after`. With no `after`, none: just the cursor to poll
    /// from, so a new listener only sees what happens after it subscribed.
    fn events_after(&self, after: Option<u64>) -> Value {
        let events = self.events.lock().unwrap();
        let list: Vec<Value> = match after {
            None => Vec::new(),
            Some(after) => events
                .queue
                .iter()
                .filter(|(id, _, _)| *id >= after)
                .map(|(id, name, payload)| json!({ "id": id, "event": name, "payload": payload }))
                .collect(),
        };
        json!({ "next": events.next, "events": list })
    }

    /// Stop neuroflow-mcp (and its steps) when the server exits.
    pub fn stop_now(&self) {
        self.state.stop_now();
    }
}

fn read_run(args: &Value) -> Result<Value, String> {
    let run_id = arg(args, "runId")?
        .as_str()
        .ok_or("runId must be a string")?;
    if !valid_run_id(run_id) {
        return Err(format!("{run_id:?} is not a run id"));
    }
    let dir = sessions_dir().join(run_id);
    let bytes = std::fs::read(dir.join("run.json"))
        .map_err(|error| format!("couldn't read run {run_id}: {error}"))?;
    let record: Value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    Ok(json!({ "sessionDir": path_string(dir)?, "record": record }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_start_at_the_cursor_and_page_forward() {
        let pipelines = Pipelines::default();
        push_event(&pipelines.events, "early", json!(1));
        let first = pipelines.events_after(None);
        assert_eq!(first["events"], json!([]));
        let cursor = first["next"].as_u64().unwrap();
        push_event(
            &pipelines.events,
            "neuroflow:progress",
            json!({"progress": 1}),
        );
        let page = pipelines.events_after(Some(cursor));
        assert_eq!(
            page["events"],
            json!([{ "id": cursor, "event": "neuroflow:progress", "payload": {"progress": 1} }])
        );
        assert_eq!(page["next"].as_u64(), Some(cursor + 1));
        assert_eq!(
            pipelines.events_after(Some(cursor + 1))["events"],
            json!([])
        );
    }

    #[test]
    fn roots_admit_children_not_prefixes() {
        let base = std::env::temp_dir().join(format!("nv-roots-{}", std::process::id()));
        let (data, database) = (base.join("data"), base.join("database"));
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(&database).unwrap();
        std::fs::write(data.join("t1.nii.gz"), b"").unwrap();
        std::fs::write(database.join("t1.nii.gz"), b"").unwrap();
        let roots = [data.clone()];
        assert!(resolve_in_roots(&data.join("t1.nii.gz"), &roots).is_ok());
        assert!(resolve_in_roots(&database.join("t1.nii.gz"), &roots).is_err());
        assert!(resolve_in_roots(Path::new("relative.nii"), &roots).is_err());
        std::fs::remove_dir_all(&base).unwrap();
    }
}
