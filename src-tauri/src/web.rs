//! `neurovue-web`: NeuroVue in a browser (e.g. Neurodesk). One listener serves
//! the built UI (`bun run build:web`), the dataset routes, and
//! `POST /rpc/<command>`, which stands in for Tauri's `invoke`.

use crate::{
    add_overlay, normalize_local_path, open_dataset_at_path, read_mesh_bytes, server_info,
    volumetric_server::{self, ServerHandle},
};
use axum::{
    extract::{Path as UrlPath, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tower_http::services::ServeDir;

const USAGE: &str =
    "usage: neurovue-web [--bind 127.0.0.1:8090] [--dist DIR] [--public-url URL] [--dataset PATH]";

/// Run the server on `args` (without the program name); returns the exit code.
pub fn main(args: Vec<String>) -> i32 {
    let mut bind = "127.0.0.1:8090".to_string();
    let mut dist = PathBuf::from("dist-web");
    let mut public_url = None;
    let mut dataset = None;
    let mut args = args.into_iter();
    while let Some(flag) = args.next() {
        let Some(value) = args.next() else {
            eprintln!("{USAGE}");
            return 2;
        };
        match flag.as_str() {
            "--bind" => bind = value,
            "--dist" => dist = value.into(),
            "--public-url" => public_url = Some(value),
            "--dataset" => dataset = Some(value),
            _ => {
                eprintln!("{USAGE}");
                return 2;
            }
        }
    }

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
    let public_url = public_url
        .unwrap_or_else(|| format!("http://{addr}"))
        .trim_end_matches('/')
        .to_string();
    let (server, dataset_routes) = volumetric_server::web_router(public_url.clone(), addr.port());
    if let Some(dataset) = dataset {
        if let Err(error) =
            open_dataset_at_path(&server, Path::new(&normalize_local_path(&dataset)))
        {
            eprintln!("neurovue-web: {error}");
            return 1;
        }
    }

    let app = Router::new()
        .route("/rpc/:command", post(rpc))
        .with_state(server)
        .merge(dataset_routes)
        .fallback_service(ServeDir::new(dist));

    eprintln!("neurovue-web: serving {public_url}");
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("build neurovue-web runtime");
    runtime.block_on(async move {
        listener
            .set_nonblocking(true)
            .expect("set listener nonblocking");
        let listener = tokio::net::TcpListener::from_std(listener).expect("adopt listener");
        match axum::serve(listener, app).await {
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
    let path = || {
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
        "open_dataset_path" => json(open_dataset_at_path(server, Path::new(&path()?))),
        "close_dataset" => {
            volumetric_server::clear_dataset(server);
            Ok(Reply::Json(Value::Null))
        }
        "add_overlay_volume_path" => json(add_overlay(server, Path::new(&path()?))),
        "read_bundle_manifest" => json(volumetric_server::read_bundle(Path::new(&path()?))),
        "read_document_manifest" => json(volumetric_server::read_document(Path::new(&path()?))),
        "read_mesh_file" => read_mesh_bytes(&path()?).map(Reply::Bytes),
        "take_opened_files" => Ok(Reply::Json(json!([]))),
        "keep_picked_file" => Ok(Reply::Json(json!(path()?))),
        _ => Err(format!("{command} isn't available in the web version.")),
    }
}

fn json<T: serde::Serialize>(value: Result<T, String>) -> Result<Reply, String> {
    Ok(Reply::Json(
        serde_json::to_value(value?).map_err(|error| error.to_string())?,
    ))
}
