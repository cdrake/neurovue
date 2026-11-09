// The Pipelines view's backend: a locally installed `neuroflow-mcp` (an MCP
// server over stdio JSON-RPC), spawned on the first request and relayed to.
// Settings live in neuroflow.json next to mcp.json; `--data-root` is mcp.json's
// `roots`, so agents and pipelines see the same folders.
//
// std::process and std threads, like mcp.rs: tokio's `process` feature isn't
// enabled, so the child is killed in `Drop` instead of with `kill_on_drop`.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::sync::oneshot;

const TEMPLATE: &str = r#"{
  "binary": "~/Dev/neuroflow/target/release/neuroflow-mcp",
  "registries": ["~/Dev/neuroflow/gallery"],
  "spec": "~/Dev/neuroflow-spec",
  "interpreters": { "node": "/opt/homebrew/bin/node", "python3": "~/.venvs/neuroflow/bin/python" }
}
"#;
const STDERR_LINES: usize = 200;
const INIT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Deserialize)]
pub(crate) struct Settings {
    binary: String,
    #[serde(default)]
    registries: Vec<String>,
    #[serde(default)]
    spec: Option<String>,
    #[serde(default)]
    interpreters: BTreeMap<String, String>,
}

fn expand(path: &str, home: &Path) -> String {
    let rest = match path.strip_prefix('~') {
        Some("") => "",
        Some(rest) if rest.starts_with('/') => &rest[1..],
        _ => return path.to_string(),
    };
    // A non-UTF-8 home stays unexpanded rather than lossily converted.
    home.join(rest)
        .into_os_string()
        .into_string()
        .unwrap_or_else(|_| path.to_string())
}

impl Settings {
    fn expanded(self, home: &Path) -> Self {
        Settings {
            binary: expand(&self.binary, home),
            registries: self.registries.iter().map(|r| expand(r, home)).collect(),
            spec: self.spec.map(|s| expand(&s, home)),
            interpreters: self
                .interpreters
                .into_iter()
                .map(|(name, path)| (name, expand(&path, home)))
                .collect(),
        }
    }
}

pub(crate) fn build_args(s: &Settings, roots: &[PathBuf], sessions: &Path) -> Vec<OsString> {
    let mut args = Vec::new();
    for registry in &s.registries {
        args.extend(["--registry".into(), registry.into()]);
    }
    for root in roots {
        args.extend(["--data-root".into(), root.as_os_str().to_owned()]);
    }
    args.extend(["--sessions".into(), sessions.as_os_str().to_owned()]);
    if let Some(spec) = &s.spec {
        args.extend(["--spec".into(), spec.into()]);
    }
    for (name, path) in &s.interpreters {
        args.extend(["--interpreter".into(), format!("{name}={path}").into()]);
    }
    args
}

pub(crate) enum Line {
    Response {
        id: u64,
        result: Result<Value, String>,
    },
    Progress(Value),
    Other,
}

pub(crate) fn classify(line: &str) -> Line {
    let Ok(msg) = serde_json::from_str::<Value>(line) else {
        return Line::Other;
    };
    if msg["method"] == "notifications/progress" {
        return Line::Progress(msg["params"].clone());
    }
    let Some(id) = msg["id"].as_u64() else {
        return Line::Other;
    };
    let result = match msg.get("error") {
        Some(error) => Err(error["message"]
            .as_str()
            .map_or_else(|| error.to_string(), str::to_string)),
        None => Ok(msg["result"].clone()),
    };
    Line::Response { id, result }
}

pub(crate) fn valid_run_id(id: &str) -> bool {
    let mut parts = Path::new(id).components();
    matches!(
        (parts.next(), parts.next()),
        (Some(std::path::Component::Normal(name)), None) if name == id
    )
}

type Reply = Result<Value, String>;

#[derive(Default)]
pub(crate) struct Pending(HashMap<u64, oneshot::Sender<Reply>>);

impl Pending {
    pub(crate) fn insert(&mut self, id: u64) -> oneshot::Receiver<Reply> {
        let (tx, rx) = oneshot::channel();
        self.0.insert(id, tx);
        rx
    }

    pub(crate) fn remove(&mut self, id: u64) {
        self.0.remove(&id);
    }

    pub(crate) fn resolve(&mut self, id: u64, r: Reply) -> bool {
        self.0.remove(&id).is_some_and(|tx| tx.send(r).is_ok())
    }

    pub(crate) fn fail_all(&mut self, msg: &str) {
        for (_, tx) in self.0.drain() {
            let _ = tx.send(Err(msg.to_string()));
        }
    }
}

type Emit = Arc<dyn Fn(Value) + Send + Sync>;

/// One running neuroflow-mcp. Its own `pending`, so a stale reader from an
/// earlier process can't fail requests sent to a newer one.
struct Proc {
    child: Child,
    stdin: ChildStdin,
    pending: Arc<Mutex<Pending>>,
}

impl Drop for Proc {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Proc {
    // shortcut: a blocking pipe write under the state lock, fine for small JSON-RPC messages; move to a writer thread if messages grow large.
    fn write(&mut self, msg: &Value) -> Result<(), String> {
        writeln!(self.stdin, "{msg}")
            .and_then(|()| self.stdin.flush())
            .map_err(|error| format!("couldn't write to neuroflow-mcp: {error}"))
    }

    fn send(
        &mut self,
        id: u64,
        method: &str,
        params: Value,
    ) -> Result<oneshot::Receiver<Reply>, String> {
        let rx = self.pending.lock().unwrap().insert(id);
        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        self.write(&msg)
            .inspect_err(|_| self.pending.lock().unwrap().remove(id))?;
        Ok(rx)
    }
}

/// Spawn plus relay, independent of Tauri so the integration test can drive it.
#[derive(Default)]
pub(crate) struct NeuroflowState {
    proc: tokio::sync::Mutex<Option<Proc>>,
    stderr: Arc<Mutex<VecDeque<String>>>,
    next_id: AtomicU64,
}

impl NeuroflowState {
    /// The running process, after dropping one that has exited.
    fn live(slot: &mut Option<Proc>) -> Option<&mut Proc> {
        if slot
            .as_mut()
            .is_some_and(|p| !matches!(p.child.try_wait(), Ok(None)))
        {
            *slot = None;
        }
        slot.as_mut()
    }

    async fn ensure(
        &self,
        program: &Path,
        args: &[OsString],
        version: &str,
        emit: Emit,
    ) -> Result<(), String> {
        let mut slot = self.proc.lock().await;
        if Self::live(&mut slot).is_some() {
            return Ok(());
        }
        let mut child = Command::new(program)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("couldn't start {}: {error}", program.display()))?;
        let (stdin, stdout, stderr) = (
            child.stdin.take().unwrap(),
            child.stdout.take().unwrap(),
            child.stderr.take().unwrap(),
        );
        let tail = self.stderr.clone();
        tail.lock().unwrap().clear();
        let stderr_reader = std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let mut tail = tail.lock().unwrap();
                if tail.len() == STDERR_LINES {
                    tail.pop_front();
                }
                tail.push_back(line);
            }
        });
        let pending = Arc::new(Mutex::new(Pending::default()));
        let (routes, tail) = (pending.clone(), self.stderr.clone());
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                match classify(&line) {
                    Line::Response { id, result } => {
                        routes.lock().unwrap().resolve(id, result);
                    }
                    Line::Progress(params) => emit(params),
                    Line::Other => eprintln!("neuroflow-mcp: {line}"),
                }
            }
            // Wait for stderr to close so the message carries the last lines.
            let _ = stderr_reader.join();
            let tail = tail.lock().unwrap();
            let last: Vec<&str> = tail
                .iter()
                .rev()
                .take(5)
                .rev()
                .map(String::as_str)
                .collect();
            routes
                .lock()
                .unwrap()
                .fail_all(&format!("neuroflow-mcp exited: {}", last.join("\n")));
        });
        let mut proc = Proc {
            child,
            stdin,
            pending,
        };
        let init = json!({
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": { "name": "neurovue", "version": version },
        });
        let rx = proc.send(
            self.next_id.fetch_add(1, Ordering::SeqCst),
            "initialize",
            init,
        )?;
        tokio::time::timeout(INIT_TIMEOUT, rx)
            .await
            .map_err(|_| "neuroflow-mcp didn't answer initialize".to_string())?
            .map_err(|_| "neuroflow-mcp exited during initialize".to_string())??;
        proc.write(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))?;
        *slot = Some(proc);
        Ok(())
    }

    /// Sends `method` to the running process; `on_id` sees the id before the write.
    async fn request(&self, method: &str, params: Value, on_id: impl FnOnce(u64)) -> Reply {
        let rx = {
            let mut slot = self.proc.lock().await;
            let proc = Self::live(&mut slot).ok_or("neuroflow-mcp isn't running")?;
            let id = self.next_id.fetch_add(1, Ordering::SeqCst);
            on_id(id);
            proc.send(id, method, params)?
        };
        // The sender is dropped when the request is cancelled: MCP sends no reply.
        rx.await.map_err(|_| "cancelled".to_string())?
    }

    async fn cancel(&self, id: u64) -> Result<(), String> {
        let mut slot = self.proc.lock().await;
        let Some(proc) = Self::live(&mut slot) else {
            return Ok(());
        };
        proc.pending.lock().unwrap().remove(id);
        proc.write(&json!({
            "jsonrpc": "2.0",
            "method": "notifications/cancelled",
            "params": { "requestId": id },
        }))
    }

    async fn stop(&self) {
        self.proc.lock().await.take();
    }

    /// Not running while the lock is held (a spawn or handshake is underway),
    /// so status never waits on it.
    fn running(&self) -> bool {
        self.proc
            .try_lock()
            .is_ok_and(|mut slot| Self::live(&mut slot).is_some())
    }
}

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
    let stderr_tail = state.stderr.lock().unwrap().iter().cloned().collect();
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
    state
        .request(&method, params, |id| {
            let _ = app.emit("neuroflow:request-id", json!({ "requestId": id }));
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

/// App exit: kill the process rather than leave it running. try_lock, so a
/// stuck handshake can't hold up quitting; the child then sees stdin close.
pub(crate) fn stop<R: Runtime>(app: &AppHandle<R>) {
    if let Ok(mut slot) = app.state::<NeuroflowState>().proc.try_lock() {
        slot.take();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};

    fn settings(spec: Option<&str>) -> Settings {
        Settings {
            binary: "/bin/neuroflow-mcp".into(),
            registries: vec!["/Data/my lab/ü.gallery".into()],
            spec: spec.map(Into::into),
            interpreters: BTreeMap::from([("node".into(), "/opt/homebrew/bin/node".into())]),
        }
    }

    #[test]
    fn build_args_passes_paths_verbatim() {
        let args = build_args(
            &settings(None),
            &[PathBuf::from("/Data/my lab")],
            Path::new("/h/.neuroflow/runs"),
        );
        let expected: Vec<OsString> = [
            "--registry",
            "/Data/my lab/ü.gallery",
            "--data-root",
            "/Data/my lab",
            "--sessions",
            "/h/.neuroflow/runs",
            "--interpreter",
            "node=/opt/homebrew/bin/node",
        ]
        .iter()
        .map(OsString::from)
        .collect();
        assert_eq!(args, expected);
    }

    #[test]
    fn build_args_includes_spec_when_set() {
        let args = build_args(&settings(Some("/spec")), &[], Path::new("/runs"));
        let at: Vec<usize> = (0..args.len()).filter(|&i| args[i] == "--spec").collect();
        assert_eq!(at.len(), 1);
        assert_eq!(args[at[0] + 1], "/spec");
    }

    fn response(line: &str) -> (u64, Result<Value, String>) {
        match classify(line) {
            Line::Response { id, result } => (id, result),
            _ => panic!("not a response: {line}"),
        }
    }

    #[test]
    fn classify_response_ok() {
        let (id, result) = response(r#"{"jsonrpc":"2.0","id":7,"result":{"a":1}}"#);
        assert_eq!(id, 7);
        assert_eq!(result, Ok(json!({"a": 1})));
    }

    #[test]
    fn classify_response_error() {
        let (id, result) =
            response(r#"{"jsonrpc":"2.0","id":7,"error":{"code":-1,"message":"boom"}}"#);
        assert_eq!(id, 7);
        assert_eq!(result, Err("boom".to_string()));
    }

    #[test]
    fn classify_progress() {
        let params = json!({"progressToken": "t", "progress": 1, "total": 3, "message": "bet"});
        let line = json!({"jsonrpc": "2.0", "method": "notifications/progress", "params": params});
        match classify(&line.to_string()) {
            Line::Progress(got) => assert_eq!(got, params),
            _ => panic!("not progress"),
        }
    }

    #[test]
    fn classify_garbage() {
        for line in ["Loading registry…", "{\"jsonrpc\":", ""] {
            assert!(matches!(classify(line), Line::Other), "{line}");
        }
    }

    #[test]
    fn pending_routes_out_of_order() {
        let mut pending = Pending::default();
        let mut one = pending.insert(1);
        let mut two = pending.insert(2);
        assert!(pending.resolve(2, Ok(json!(2))));
        assert!(pending.resolve(1, Ok(json!(1))));
        assert_eq!(one.try_recv().unwrap(), Ok(json!(1)));
        assert_eq!(two.try_recv().unwrap(), Ok(json!(2)));
    }

    #[test]
    fn pending_drops_unknown_and_cancelled() {
        let mut pending = Pending::default();
        assert!(!pending.resolve(99, Ok(json!(null))));
        let mut rx = pending.insert(3);
        pending.remove(3);
        assert!(!pending.resolve(3, Ok(json!("late"))));
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn pending_fail_all() {
        let mut pending = Pending::default();
        let mut one = pending.insert(1);
        let mut two = pending.insert(2);
        pending.fail_all("neuroflow-mcp exited: segfault");
        for rx in [&mut one, &mut two] {
            assert_eq!(
                rx.try_recv().unwrap(),
                Err("neuroflow-mcp exited: segfault".to_string())
            );
        }
    }

    #[test]
    fn run_id_must_be_one_segment() {
        assert!(valid_run_id("run-2026"));
        for bad in ["../x", "a/b", ""] {
            assert!(!valid_run_id(bad), "{bad}");
        }
    }

    #[tokio::test]
    #[ignore = "needs NEUROFLOW_MCP_BIN and NEUROFLOW_GALLERY"]
    async fn real_server_lists_tools() {
        let (Ok(bin), Ok(gallery)) = (
            std::env::var("NEUROFLOW_MCP_BIN"),
            std::env::var("NEUROFLOW_GALLERY"),
        ) else {
            return;
        };
        let home = PathBuf::from(std::env::var("HOME").unwrap());
        let settings = Settings {
            binary: bin,
            registries: vec![gallery],
            spec: None,
            interpreters: BTreeMap::new(),
        }
        .expanded(&home);
        let sessions = std::env::temp_dir().join(format!("neuroflow-runs-{}", std::process::id()));
        let args = build_args(&settings, &[home], &sessions);
        let state = NeuroflowState::default();
        state
            .ensure(Path::new(&settings.binary), &args, "test", Arc::new(|_| {}))
            .await
            .unwrap();
        let tools = state
            .request("tools/list", json!({}), |_| {})
            .await
            .unwrap();
        let names: Vec<&str> = tools["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect();
        assert!(
            names
                .iter()
                .any(|name| name.starts_with("neuroflow.gallery.tools.")),
            "{names:?}"
        );
        state.stop().await;
        let _ = std::fs::remove_dir_all(&sessions);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn crash_fails_waiting_request_with_stderr_tail() {
        let state = NeuroflowState::default();
        let args: Vec<OsString> = ["-c", "read line; echo 'not json'; echo boom >&2; exit 1"]
            .iter()
            .map(OsString::from)
            .collect();
        let error = state
            .ensure(Path::new("/bin/sh"), &args, "test", Arc::new(|_| {}))
            .await
            .unwrap_err();
        assert_eq!(error, "neuroflow-mcp exited: boom");
        assert!(!state.running());
    }

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
