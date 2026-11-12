// The Tauri-free core of the Pipelines backend: spawn a `neuroflow-mcp` (an MCP
// server over stdio JSON-RPC) and relay requests to it. Shared by the desktop
// app (neuroflow.rs, which adds the Tauri commands and settings location) and
// neurovue-web (web/), which serves the same calls to the browser build.
//
// std::process and std threads: tokio's `process` feature isn't enabled, so the
// child is killed in `Drop` instead of with `kill_on_drop`.

use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

const STDERR_LINES: usize = 200;
const INIT_TIMEOUT: Duration = Duration::from_secs(30);
const STOP_GRACE: Duration = Duration::from_secs(2);

#[derive(Deserialize)]
pub(crate) struct Settings {
    pub(crate) binary: String,
    #[serde(default)]
    pub(crate) registries: Vec<String>,
    #[serde(default)]
    pub(crate) spec: Option<String>,
    #[serde(default)]
    pub(crate) interpreters: BTreeMap<String, String>,
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
    pub(crate) fn expanded(self, home: &Path) -> Self {
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

    fn ids(&self) -> Vec<u64> {
        self.0.keys().copied().collect()
    }

    pub(crate) fn fail_all(&mut self, msg: &str) {
        for (_, tx) in self.0.drain() {
            let _ = tx.send(Err(msg.to_string()));
        }
    }
}

pub(crate) type Emit = Arc<dyn Fn(Value) + Send + Sync>;

/// One running neuroflow-mcp. Its own `pending`, so a stale reader from an
/// earlier process can't fail requests sent to a newer one.
struct Proc {
    child: Child,
    stdin: Option<ChildStdin>,
    pending: Arc<Mutex<Pending>>,
}

fn cancelled(id: u64) -> Value {
    json!({ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": id } })
}

impl Drop for Proc {
    /// Cancels in-flight steps first: neuroflow-mcp tears a step's process group
    /// down only on `notifications/cancelled`, not on stdin EOF or its own kill.
    fn drop(&mut self) {
        let ids = self.pending.lock().unwrap().ids();
        for id in ids {
            let _ = self.write(&cancelled(id));
        }
        self.stdin = None;
        let deadline = Instant::now() + STOP_GRACE;
        while matches!(self.child.try_wait(), Ok(None)) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Proc {
    // shortcut: a blocking pipe write under the state lock, fine for small JSON-RPC messages; move to a writer thread if messages grow large.
    fn write(&mut self, msg: &Value) -> Result<(), String> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or("neuroflow-mcp's stdin is closed")?;
        writeln!(stdin, "{msg}")
            .and_then(|()| stdin.flush())
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

    pub(crate) async fn ensure(
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
            stdin: Some(stdin),
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
    pub(crate) async fn request(
        &self,
        method: &str,
        params: Value,
        on_id: impl FnOnce(u64),
    ) -> Reply {
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

    pub(crate) async fn cancel(&self, id: u64) -> Result<(), String> {
        let mut slot = self.proc.lock().await;
        let Some(proc) = Self::live(&mut slot) else {
            return Ok(());
        };
        proc.pending.lock().unwrap().remove(id);
        proc.write(&cancelled(id))
    }

    /// Holds the lock until the old process is gone, so a new one can't race it.
    pub(crate) async fn stop(&self) {
        let mut slot = self.proc.lock().await;
        if let Some(proc) = slot.take() {
            // Drop waits up to STOP_GRACE; keep it off the async workers.
            let _ = tokio::task::spawn_blocking(move || drop(proc)).await;
        }
    }

    /// Not running while the lock is held (a spawn or handshake is underway),
    /// so status never waits on it.
    /// The last lines neuroflow-mcp wrote to stderr, oldest first.
    pub(crate) fn stderr_tail(&self) -> Vec<String> {
        self.stderr.lock().unwrap().iter().cloned().collect()
    }

    /// App exit: cancel running steps and stop the process (blocks up to
    /// STOP_GRACE). try_lock, so a stuck handshake can't hold up quitting; the
    /// child then sees stdin close.
    pub(crate) fn stop_now(&self) {
        if let Ok(mut slot) = self.proc.try_lock() {
            slot.take();
        }
    }

    pub(crate) fn running(&self) -> bool {
        self.proc
            .try_lock()
            .is_ok_and(|mut slot| Self::live(&mut slot).is_some())
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

    #[cfg(unix)]
    #[test]
    fn drop_cancels_pending_then_closes_stdin() {
        let out = std::env::temp_dir().join(format!("neuroflow-stop-{}", std::process::id()));
        let mut child = Command::new("/bin/sh")
            .args(["-c", "cat > \"$0\""])
            .arg(&out)
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take();
        let pending = Arc::new(Mutex::new(Pending::default()));
        let _rx = pending.lock().unwrap().insert(5);
        let started = Instant::now();
        drop(Proc {
            child,
            stdin,
            pending,
        });
        // cat exits on EOF, well before the grace period.
        assert!(started.elapsed() < STOP_GRACE);
        let written = std::fs::read_to_string(&out).unwrap();
        assert_eq!(written.trim(), cancelled(5).to_string());
        std::fs::remove_file(&out).unwrap();
    }
}
