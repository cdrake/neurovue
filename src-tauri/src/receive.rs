// Send to iPad: a Mac on the same network offers a file, the person accepts
// or declines it here, and only then is it uploaded and opened. Unlike the
// volume server (127.0.0.1 only) this listens on the network, so nothing is
// written until the person has said yes, and only file types the page opens
// are offered at all.
//
// POST /offer {name, from, size} waits for the answer (up to OFFER_TIMEOUT)
// and returns a one-time upload token; PUT /upload/:token streams the file
// into the inbox and hands it to opened.rs like any other received file.

use axum::{
    body::Body,
    extract::{ConnectInfo, Path, State},
    http::StatusCode,
    routing::{post, put},
    Json, Router,
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path as FsPath, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};
use tauri::{Emitter, EventTarget, Manager};
use tokio::{io::AsyncWriteExt, sync::oneshot};

/// Asks the launch window to accept or decline an offer.
const OFFER_EVENT: &str = "neurovue-send-offered";
/// Tells the launch window an offer it was asked about is gone (answered,
/// timed out, or the sender gave up).
const OFFER_CLOSED_EVENT: &str = "neurovue-send-offer-closed";
const OFFER_TIMEOUT: Duration = Duration::from_secs(120);
/// What the page can open; checked longest first so .nii.gz isn't read as .gz.
const EXTENSIONS: [&str; 4] = [".nvbundle", ".nii.gz", ".nvd", ".nii"];

#[derive(Deserialize)]
struct OfferRequest {
    name: String,
    from: String,
    size: u64,
    /// Shown on the sender too, so the person can tell their send from a
    /// look-alike on the same network.
    #[serde(default)]
    code: String,
}

#[derive(Clone, Serialize)]
struct OfferEvent {
    id: String,
    name: String,
    from: String,
    size: u64,
    code: String,
    address: String,
}

struct Pending {
    id: String,
    answer: oneshot::Sender<bool>,
}

struct Upload {
    name: String,
    size: u64,
}

pub(crate) struct Receiver {
    app: tauri::AppHandle,
    inbox: PathBuf,
    /// One offer at a time: the page shows one prompt.
    pending: Mutex<Option<Pending>>,
    /// Accepted offers, by upload token, until their upload starts.
    uploads: Mutex<HashMap<String, Upload>>,
    /// The port listening now, and what stops it when `start` replaces it.
    listening: Mutex<Option<(u16, tokio::sync::oneshot::Sender<()>)>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Starts listening on the network and returns the port, for advertising.
/// Called again, it replaces the server listening before (see `live_port`).
pub(crate) fn start(app: &tauri::AppHandle) -> std::io::Result<u16> {
    let listener = std::net::TcpListener::bind(("0.0.0.0", 0))?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    let receiver = match app.try_state::<Arc<Receiver>>() {
        Some(receiver) => receiver.inner().clone(),
        None => {
            let receiver = Arc::new(Receiver {
                app: app.clone(),
                inbox: crate::volumetric_server::data_root().join("received"),
                pending: Mutex::new(None),
                uploads: Mutex::new(HashMap::new()),
                listening: Mutex::new(None),
            });
            app.manage(receiver.clone());
            receiver
        }
    };
    let (stop, stopped) = tokio::sync::oneshot::channel();
    if let Some((_, previous)) = lock(&receiver.listening).replace((port, stop)) {
        let _ = previous.send(());
    }

    let router = Router::new()
        .route("/offer", post(offer))
        .route("/upload/:token", put(upload))
        .with_state(receiver);
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .thread_name("neurovue-receive")
            .build()
            .expect("build NeuroVue receive runtime");
        runtime.block_on(async move {
            let listener = tokio::net::TcpListener::from_std(listener)
                .expect("adopt NeuroVue receive listener");
            let serve = axum::serve(
                listener,
                router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            });
            if let Err(error) = serve.await {
                eprintln!("NeuroVue receive server stopped: {error}");
            }
        });
    });
    Ok(port)
}

/// The port this device receives on, if it still answers: iOS can take a
/// suspended app's listening socket.
#[cfg(target_os = "ios")]
pub(crate) fn live_port(app: &tauri::AppHandle) -> Option<u16> {
    let receiver = app.try_state::<Arc<Receiver>>()?;
    let port = lock(&receiver.listening).as_ref()?.0;
    let address = std::net::SocketAddr::from((std::net::Ipv4Addr::LOCALHOST, port));
    std::net::TcpStream::connect_timeout(&address, std::time::Duration::from_millis(500))
        .ok()
        .map(|_| port)
}

/// The page's answer to the offer it was shown.
#[tauri::command]
pub(crate) fn answer_send_offer(app: tauri::AppHandle, id: String, accept: bool) {
    let Some(receiver) = app.try_state::<Arc<Receiver>>() else {
        return;
    };
    let mut pending = lock(&receiver.pending);
    if pending.as_ref().is_some_and(|offer| offer.id == id) {
        if let Some(offer) = pending.take() {
            let _ = offer.answer.send(accept);
        }
    }
}

/// Clears the offer and closes its prompt however the request ends,
/// including the sender hanging up mid-wait.
struct OfferGuard<'a> {
    receiver: &'a Receiver,
    id: String,
}

impl Drop for OfferGuard<'_> {
    fn drop(&mut self) {
        let mut pending = lock(&self.receiver.pending);
        if pending.as_ref().is_some_and(|offer| offer.id == self.id) {
            pending.take();
        }
        drop(pending);
        let _ = self.receiver.app.emit_to(
            EventTarget::webview_window(crate::MAIN_WINDOW),
            OFFER_CLOSED_EVENT,
            &self.id,
        );
    }
}

async fn offer(
    State(receiver): State<Arc<Receiver>>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    Json(request): Json<OfferRequest>,
) -> Result<Json<Value>, StatusCode> {
    let name = offered_name(&request.name).ok_or(StatusCode::UNSUPPORTED_MEDIA_TYPE)?;
    let id = random_token().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let (answer, answered) = oneshot::channel();
    {
        let mut pending = lock(&receiver.pending);
        if pending.is_some() {
            return Err(StatusCode::CONFLICT);
        }
        *pending = Some(Pending {
            id: id.clone(),
            answer,
        });
    }
    let _guard = OfferGuard {
        receiver: &receiver,
        id: id.clone(),
    };
    receiver
        .app
        .emit_to(
            EventTarget::webview_window(crate::MAIN_WINDOW),
            OFFER_EVENT,
            OfferEvent {
                id,
                name: name.clone(),
                from: request.from.chars().take(80).collect(),
                size: request.size,
                code: request
                    .code
                    .chars()
                    .filter(char::is_ascii_digit)
                    .take(8)
                    .collect(),
                address: peer.ip().to_canonical().to_string(),
            },
        )
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;

    match tokio::time::timeout(OFFER_TIMEOUT, answered).await {
        Ok(Ok(true)) => {}
        Ok(_) => return Err(StatusCode::FORBIDDEN),
        Err(_) => return Err(StatusCode::REQUEST_TIMEOUT),
    }
    let token = random_token().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    lock(&receiver.uploads).insert(
        token.clone(),
        Upload {
            name,
            size: request.size,
        },
    );
    Ok(Json(json!({ "token": token })))
}

async fn upload(
    State(receiver): State<Arc<Receiver>>,
    Path(token): Path<String>,
    body: Body,
) -> StatusCode {
    let Some(upload) = lock(&receiver.uploads).remove(&token) else {
        return StatusCode::NOT_FOUND;
    };
    let _background = crate::background::BackgroundTask::begin("Receive");
    if let Err(error) = tokio::fs::create_dir_all(&receiver.inbox).await {
        eprintln!("NeuroVue receive: inbox: {error}");
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    let Ok((dest, part, file)) = reserve_part(&receiver.inbox, &upload.name) else {
        return StatusCode::INTERNAL_SERVER_ERROR;
    };
    match write_body(file.into(), body, upload.size).await {
        Ok(()) => {}
        Err(status) => {
            let _ = tokio::fs::remove_file(&part).await;
            return status;
        }
    }
    if tokio::fs::rename(&part, &dest).await.is_err() {
        let _ = tokio::fs::remove_file(&part).await;
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    crate::opened::receive_paths(&receiver.app, vec![dest.to_string_lossy().into_owned()]);
    StatusCode::OK
}

/// Streams `body` to `file`, refusing anything but exactly `size` bytes.
async fn write_body(mut file: tokio::fs::File, body: Body, size: u64) -> Result<(), StatusCode> {
    let mut written: u64 = 0;
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| StatusCode::BAD_REQUEST)?;
        written += chunk.len() as u64;
        if written > size {
            return Err(StatusCode::PAYLOAD_TOO_LARGE);
        }
        file.write_all(&chunk)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }
    if written != size {
        return Err(StatusCode::BAD_REQUEST);
    }
    file.flush()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

/// The offered file's name made safe to write: no directories, only plain
/// characters, and an extension the page opens.
fn offered_name(name: &str) -> Option<String> {
    let base = FsPath::new(name).file_name()?.to_str()?;
    let cleaned: String = base
        .chars()
        .take(120)
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let (stem, _) = split_extension(&cleaned)?;
    let stem = stem.trim_matches(|c| c == '-' || c == '.');
    (!stem.is_empty()).then(|| cleaned.trim_start_matches(['-', '.']).to_string())
}

/// `name` as (stem, extension) for one of EXTENSIONS, ignoring case.
fn split_extension(name: &str) -> Option<(&str, &str)> {
    let lower = name.to_ascii_lowercase();
    EXTENSIONS
        .iter()
        .find(|extension| lower.ends_with(*extension))
        .map(|extension| name.split_at(name.len() - extension.len()))
}

/// `dir/name`, then `dir/stem-2.ext` and so on.
fn candidate_paths<'a>(dir: &'a FsPath, name: &'a str) -> impl Iterator<Item = PathBuf> + 'a {
    let (stem, extension) = split_extension(name).unwrap_or((name, ""));
    std::iter::once(dir.join(name))
        .chain((2..).map(move |n| dir.join(format!("{stem}-{n}{extension}"))))
}

/// `dir/name`, or `dir/stem-2.ext` and so on if that's taken.
pub(crate) fn unused_path(dir: &FsPath, name: &str) -> PathBuf {
    candidate_paths(dir, name)
        .find(|path| !path.exists())
        .expect("an unused name")
}

/// An unused final path and its newly created `.part` sibling; creating the
/// part exclusively keeps overlapping uploads of one name apart.
fn reserve_part(dir: &FsPath, name: &str) -> std::io::Result<(PathBuf, PathBuf, std::fs::File)> {
    for dest in candidate_paths(dir, name).filter(|path| !path.exists()) {
        let part = PathBuf::from(format!("{}.part", dest.display()));
        match std::fs::File::create_new(&part) {
            Ok(file) => return Ok((dest, part, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
    unreachable!("candidate paths never run out")
}

fn random_token() -> std::io::Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(std::io::Error::other)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offered_names_keep_only_openable_files() {
        assert_eq!(
            offered_name("anat.nvbundle").as_deref(),
            Some("anat.nvbundle")
        );
        assert_eq!(
            offered_name("../../etc/T1w.nii.gz").as_deref(),
            Some("T1w.nii.gz")
        );
        assert_eq!(
            offered_name("Motor Demo.nvd").as_deref(),
            Some("Motor-Demo.nvd")
        );
        assert_eq!(offered_name("notes.txt"), None);
        assert_eq!(offered_name(".nvbundle"), None);
        assert_eq!(offered_name("archive.gz"), None);
    }

    #[test]
    fn taken_names_get_a_number_before_the_extension() {
        let dir = std::env::temp_dir().join(format!("nv-receive-{}", random_token().unwrap()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("T1w.nii.gz"), b"").unwrap();
        assert_eq!(unused_path(&dir, "T1w.nii.gz"), dir.join("T1w-2.nii.gz"));
        assert_eq!(
            unused_path(&dir, "anat.nvbundle"),
            dir.join("anat.nvbundle")
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn overlapping_uploads_reserve_distinct_paths() {
        let dir = std::env::temp_dir().join(format!("nv-receive-{}", random_token().unwrap()));
        std::fs::create_dir_all(&dir).unwrap();
        let (dest_a, part_a, _) = reserve_part(&dir, "T1w.nii.gz").unwrap();
        let (dest_b, part_b, _) = reserve_part(&dir, "T1w.nii.gz").unwrap();
        assert_eq!(dest_a, dir.join("T1w.nii.gz"));
        assert_eq!(dest_b, dir.join("T1w-2.nii.gz"));
        assert_ne!(part_a, part_b);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
