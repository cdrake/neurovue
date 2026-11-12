//! `neurovue-web`: NeuroVue in a browser (e.g. Neurodesk). One listener serves
//! the built UI (`bun run build:web`), the dataset routes, and
//! `POST /rpc/<command>`, which stands in for Tauri's `invoke`.

// Shares the app's dataset server source without depending on Tauri, so it
// builds on Linux (Neurodesk) with no webkit/gtk.
#[path = "../../src/dataset.rs"]
mod dataset;
#[allow(dead_code)]
#[path = "../../src/volumetric_server.rs"]
mod volumetric_server;

mod private_dir;
mod same_user;

use axum::http::HeaderValue;
use axum::{
    extract::{Path as UrlPath, State},
    http::{header, StatusCode},
    middleware,
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use dataset::{
    add_overlay, normalize_local_path, open_dataset_at_path, read_mesh_bytes, server_info,
};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tower_http::{services::ServeDir, set_header::SetResponseHeaderLayer};
use volumetric_server::ServerHandle;

const USAGE: &str =
    "usage: neurovue-web [--version] [--bind 127.0.0.1:PORT] [--dist DIR] [--dataset PATH]";

fn main() {
    std::process::exit(run(std::env::args().skip(1).collect()));
}

fn run(args: Vec<String>) -> i32 {
    // Neurodesk's webapp wrapper picks the port and proxies to it.
    let mut bind = format!(
        "127.0.0.1:{}",
        std::env::var("NEURODESK_WEBAPP_PORT").unwrap_or_else(|_| "8090".into())
    );
    let mut dist = PathBuf::from("dist-web");
    let mut dataset = None;
    if args.first().map(String::as_str) == Some("--version") {
        println!("neurovue-web {}", env!("CARGO_PKG_VERSION"));
        return 0;
    }
    let mut args = args.into_iter();
    while let Some(flag) = args.next() {
        let Some(value) = args.next() else {
            eprintln!("{USAGE}");
            return 2;
        };
        match flag.as_str() {
            "--bind" => bind = value,
            "--dist" => dist = value.into(),
            "--dataset" => dataset = Some(value),
            _ => {
                eprintln!("{USAGE}");
                return 2;
            }
        }
    }

    // Before anything touches the cache: keep it in a directory only this user
    // controls, never a shared /tmp/neurovue.
    let cache_dir = private_dir::default_cache_dir();
    if let Err(error) = private_dir::ensure_private_dir(&cache_dir) {
        eprintln!("neurovue-web: cache: {error} (set NEUROVUE_CACHE_DIR to choose another)");
        return 1;
    }
    volumetric_server::init_cache_root(cache_dir);

    let listener = match std::net::TcpListener::bind(&bind) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("neurovue-web: bind {bind}: {error}");
            return 1;
        }
    };
    let addr = listener.local_addr().expect("read neurovue-web addr");
    if !addr.ip().is_loopback() {
        // open_dataset_path takes any server path, so the port reads any file this user can.
        eprintln!("neurovue-web: WARNING: listening on {addr} with no auth; anyone who reaches it can read your files");
    }
    let (server, dataset_routes) = volumetric_server::web_router(".".into(), addr.port());
    let mut reopen = None;
    if let Some(dataset) = dataset {
        if let Err(error) =
            open_dataset_at_path(&server, Path::new(&normalize_local_path(&dataset)))
        {
            eprintln!("neurovue-web: {error}");
            return 1;
        }
    } else if let Ok(last) = std::fs::read_to_string(last_dataset_file()) {
        // Neurodesk stops idle apps; reopen what was open so a relaunch picks
        // up where it was. In the background: Neurodesk treats the app as ready
        // once the port accepts, and a big tree (or a slow mount) mustn't hold
        // every request until the walk finishes.
        reopen = Some((server.clone(), last));
    }

    let app = Router::new()
        .route("/rpc/:command", post(rpc))
        .with_state(server)
        .merge(dataset_routes)
        .fallback_service(ServeDir::new(dist))
        // The page names content-hashed assets, so they may be cached, but a
        // stale index.html after an upgrade would keep loading the old build.
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CACHE_CONTROL,
            |response: &Response| {
                response
                    .headers()
                    .get(header::CONTENT_TYPE)
                    .and_then(|value| value.to_str().ok())
                    .is_some_and(|value| value.starts_with("text/html"))
                    .then(|| HeaderValue::from_static("no-cache"))
            },
        ))
        .layer(middleware::from_fn(same_user::require_same_user));

    eprintln!("neurovue-web: serving http://{addr}");
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("build neurovue-web runtime");
    runtime.block_on(async move {
        listener
            .set_nonblocking(true)
            .expect("set listener nonblocking");
        let listener = tokio::net::TcpListener::from_std(listener).expect("adopt listener");
        if let Some((server, last)) = reopen {
            tokio::task::spawn_blocking(move || {
                if let Err(error) = open_dataset_at_path(&server, Path::new(&last)) {
                    eprintln!("neurovue-web: reopening {last}: {error}");
                }
            });
        }
        let service = app.into_make_service_with_connect_info::<same_user::Peer>();
        match axum::serve(listener, service).await {
            Ok(()) => 0,
            Err(error) => {
                eprintln!("neurovue-web: {error}");
                1
            }
        }
    })
}

enum Reply {
    Json(Value),
    Bytes(Vec<u8>),
}

async fn rpc(
    State(server): State<ServerHandle>,
    UrlPath(command): UrlPath<String>,
    body: Option<Json<Value>>,
) -> Response {
    let path = body
        .as_ref()
        .and_then(|Json(args)| args.get("path"))
        .and_then(Value::as_str)
        .map(normalize_local_path);
    let reply = tokio::task::spawn_blocking(move || dispatch(&server, &command, path))
        .await
        .unwrap_or_else(|error| Err(format!("rpc join error: {error}")));
    match reply {
        Ok(Reply::Json(value)) => Json(value).into_response(),
        Ok(Reply::Bytes(bytes)) => {
            ([(header::CONTENT_TYPE, "application/octet-stream")], bytes).into_response()
        }
        Err(message) => (StatusCode::BAD_REQUEST, message).into_response(),
    }
}

/// The Tauri commands the web version supports, by name; the rest reject, and
/// the page falls back as it does in any browser.
fn dispatch(server: &ServerHandle, command: &str, path: Option<String>) -> Result<Reply, String> {
    let required = || {
        path.clone()
            .ok_or_else(|| format!("{command}: missing path"))
    };
    match command {
        "neurovue_runtime_capabilities" => Ok(Reply::Json(json!({
            "terminalAvailable": false,
            "nativeNiimathAvailable": false,
            "airdropAvailable": false,
        }))),
        "neurovue_server_info" => json(Ok(server_info(server, None))),
        "open_dataset_path" => {
            let path = required()?;
            let opened = open_dataset_at_path(server, Path::new(&path))?;
            remember_dataset(Some(&path));
            json(Ok(opened))
        }
        "close_dataset" => {
            volumetric_server::clear_dataset(server);
            remember_dataset(None);
            Ok(Reply::Json(Value::Null))
        }
        "add_overlay_volume_path" => json(add_overlay(server, Path::new(&required()?))),
        "read_bundle_manifest" => json(volumetric_server::read_bundle(Path::new(&required()?))),
        "read_document_manifest" => json(volumetric_server::read_document(Path::new(&required()?))),
        "read_mesh_file" => read_mesh_bytes(&required()?).map(Reply::Bytes),
        "take_opened_files" => Ok(Reply::Json(json!([]))),
        "keep_picked_file" => Ok(Reply::Json(json!(required()?))),
        "list_dir" => list_dir(path.as_deref()),
        _ => Err(format!("{command} isn't available in the web version.")),
    }
}

fn json<T: serde::Serialize>(value: Result<T, String>) -> Result<Reply, String> {
    Ok(Reply::Json(
        serde_json::to_value(value?).map_err(|error| error.to_string())?,
    ))
}

fn last_dataset_file() -> PathBuf {
    // The private cache dir; by default ~/.cache/neurovue, which survives a
    // Neurodesk container restart where the temp dir may not.
    volumetric_server::cache_root().join("web-last-dataset")
}

fn remember_dataset(path: Option<&str>) {
    let file = last_dataset_file();
    let result = match path {
        Some(path) => std::fs::write(&file, path),
        None => std::fs::remove_file(&file).or_else(|error| {
            (error.kind() == std::io::ErrorKind::NotFound)
                .then_some(())
                .ok_or(error)
        }),
    };
    if let Err(error) = result {
        eprintln!("neurovue-web: {}: {error}", file.display());
    }
}

/// One folder for the page's file picker: the browser can't see server paths.
/// No path means the home folder.
fn list_dir(path: Option<&str>) -> Result<Reply, String> {
    let dir = match path.filter(|path| !path.is_empty()) {
        Some(path) => PathBuf::from(path),
        None => std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| ".".into()),
    };
    let dir = dir
        .canonicalize()
        .map_err(|error| format!("{}: {error}", dir.display()))?;
    // A typed file path lists its folder and names the file, so the picker can
    // open it directly.
    let (dir, file) = match dir.parent() {
        Some(parent) if !dir.is_dir() => (parent.to_path_buf(), Some(dir.clone())),
        _ => (dir, None),
    };
    let mut entries: Vec<(bool, String)> = std::fs::read_dir(&dir)
        .map_err(|error| format!("{}: {error}", dir.display()))?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            if name.starts_with('.') {
                return None;
            }
            // The entry's own type needs no extra stat; only symlinks are
            // followed, so a linked folder (e.g. ~/neurodesktop-storage)
            // browses as a folder.
            let kind = entry.file_type().ok()?;
            let is_dir = if kind.is_symlink() {
                entry.path().is_dir()
            } else {
                kind.is_dir()
            };
            Some((is_dir, name))
        })
        // HPC scratch folders can hold millions of entries.
        .take(MAX_LIST_ENTRIES + 1)
        .collect();
    let truncated = entries.len() > MAX_LIST_ENTRIES;
    entries.truncate(MAX_LIST_ENTRIES);
    entries.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| a.1.to_lowercase().cmp(&b.1.to_lowercase()))
    });
    Ok(Reply::Json(json!({
        "path": dir,
        "parent": dir.parent(),
        "file": file,
        "truncated": truncated,
        "entries": entries.into_iter().map(|(dir, name)| json!({"name": name, "dir": dir})).collect::<Vec<_>>(),
    })))
}

const MAX_LIST_ENTRIES: usize = 5000;
