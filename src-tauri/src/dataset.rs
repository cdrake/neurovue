//! Dataset commands shared by the Tauri app and `neurovue-web`; no Tauri types here.

use crate::volumetric_server;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeuroVueServerInfo {
    url: String,
    port: u16,
    volume_count: usize,
    dataset_root: Option<String>,
    cache_root: String,
    bids_name: Option<String>,
    bids_version: Option<String>,
    bids_dataset_doi: Option<String>,
    warm_progress: volumetric_server::WarmProgressSnapshot,
    /// The bundled MNI152 sample, opened on request from the Welcome screen.
    sample_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetOpenResult {
    url: String,
    port: u16,
    volume_count: usize,
    dataset_root: String,
    /// The file opened, when that was a single volume: its dataset root is the
    /// parent folder, which may hold other files.
    opened_file: Option<String>,
    cache_root: String,
    bids_name: Option<String>,
    bids_version: Option<String>,
    bids_dataset_doi: Option<String>,
    warm_progress: volumetric_server::WarmProgressSnapshot,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayAddResult {
    id: String,
    label: String,
    volume_count: usize,
    warm_progress: volumetric_server::WarmProgressSnapshot,
}

pub fn server_info(
    server: &volumetric_server::ServerHandle,
    sample_path: Option<&Path>,
) -> NeuroVueServerInfo {
    let bids = volumetric_server::bids_dataset_info(server);
    NeuroVueServerInfo {
        url: server.url.clone(),
        port: server.port,
        volume_count: volumetric_server::volume_count(server),
        dataset_root: volumetric_server::dataset_root(server)
            .map(|path| path.display().to_string()),
        cache_root: volumetric_server::cache_root().display().to_string(),
        bids_name: bids.as_ref().and_then(|info| info.name.clone()),
        bids_version: bids.as_ref().and_then(|info| info.bids_version.clone()),
        bids_dataset_doi: bids.as_ref().and_then(|info| info.dataset_doi.clone()),
        warm_progress: volumetric_server::warm_progress(server),
        sample_path: sample_path.map(|path| path.display().to_string()),
    }
}

/// The iOS document picker hands back a `file://` URL (Tauri copies the picked
/// file into the app's Inbox first), so convert it to a plain, percent-decoded
/// filesystem path. Desktop paths have no scheme, so this is a no-op there.
pub fn normalize_local_path(raw: &str) -> String {
    let without_scheme = raw.strip_prefix("file://").unwrap_or(raw);
    percent_decode(without_scheme)
}

pub fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn add_overlay(
    server: &volumetric_server::ServerHandle,
    path: &Path,
) -> Result<OverlayAddResult, String> {
    let registered = volumetric_server::register_overlay_volume(server, path)?;
    Ok(OverlayAddResult {
        id: registered.id,
        label: registered.label,
        volume_count: volumetric_server::volume_count(server),
        warm_progress: volumetric_server::warm_progress(server),
    })
}

/// Surface mesh formats NiiVue reads (its `mesh/readers`), lower-case. FreeSurfer
/// surfaces are named by their type (`lh.pial`), so those count as extensions.
pub const MESH_EXTENSIONS: &[&str] = &[
    "asc", "byu", "dfs", "geo", "gii", "ico", "mz3", "nv", "obj", "off", "ply", "srf", "stl",
    "vtk", "wrl", "x3d", "cbor", "white", "pial", "inflated", "sphere", "orig", "smoothwm",
    "qsphere", "trk", "tck", "trx",
];

pub fn read_mesh_bytes(path: &str) -> Result<Vec<u8>, String> {
    let path = PathBuf::from(normalize_local_path(path));
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if !MESH_EXTENSIONS.contains(&extension.as_str()) {
        return Err(format!(
            "{} is not a mesh NeuroVue can open.",
            path.display()
        ));
    }
    std::fs::read(&path).map_err(|error| format!("Couldn't read {}: {error}", path.display()))
}

/// A drawing mask: NIfTI only, as NiiVue's `loadDrawing` reads.
pub fn read_mask_bytes(path: &str) -> Result<Vec<u8>, String> {
    let path = PathBuf::from(normalize_local_path(path));
    let name = path.to_string_lossy().to_ascii_lowercase();
    if !(name.ends_with(".nii") || name.ends_with(".nii.gz")) {
        return Err(format!("{} is not a NIfTI mask.", path.display()));
    }
    std::fs::read(&path).map_err(|error| format!("Couldn't read {}: {error}", path.display()))
}

pub fn open_dataset_at_path(
    server: &volumetric_server::ServerHandle,
    root: &Path,
) -> Result<DatasetOpenResult, String> {
    let volume_count = volumetric_server::open_dataset_root(server, root)?;
    let dataset_root = volumetric_server::dataset_root(server)
        .unwrap_or_else(|| root.to_path_buf())
        .display()
        .to_string();
    let bids = volumetric_server::bids_dataset_info(server);
    let opened_file = root
        .is_file()
        .then(|| root.canonicalize().unwrap_or_else(|_| root.to_path_buf()))
        .map(|path| path.display().to_string());

    Ok(DatasetOpenResult {
        url: server.url.clone(),
        port: server.port,
        volume_count,
        dataset_root,
        opened_file,
        cache_root: volumetric_server::cache_root().display().to_string(),
        bids_name: bids.as_ref().and_then(|info| info.name.clone()),
        bids_version: bids.as_ref().and_then(|info| info.bids_version.clone()),
        bids_dataset_doi: bids.as_ref().and_then(|info| info.dataset_doi.clone()),
        warm_progress: volumetric_server::warm_progress(server),
    })
}
