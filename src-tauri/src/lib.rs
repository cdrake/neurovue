// niimath (a native sidecar) and the integrated terminal (a PTY/shell) both
// spawn subprocesses, which iOS/Android forbid, so both modules are desktop-only.
#[cfg(any(target_os = "macos", target_os = "ios"))]
mod bonjour;
#[cfg(desktop)]
mod mcp;
#[cfg(desktop)]
mod niimath;
mod opened;
mod receive;
mod send;
mod share;
#[cfg(desktop)]
mod terminal;
mod volumetric_server;

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;
// The app menu bar is a desktop-only concept; iOS/Android have no `tauri::menu`.
#[cfg(desktop)]
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
#[cfg(desktop)]
use tauri::{Emitter, EventTarget};

// File and View menu item ids. Each click is forwarded to the frontend as a
// `neurovue-menu` event whose payload is the id minus its `file-` or `view-`
// prefix (see `src/hooks/useNativeMenu.ts`).
#[cfg(desktop)]
const MENU_EVENT: &str = "neurovue-menu";
#[cfg(desktop)]
const MENU_OPEN_FILE: &str = "file-open-file";
#[cfg(desktop)]
const MENU_OPEN_FOLDER: &str = "file-open-folder";
#[cfg(desktop)]
const MENU_OPEN_MESH: &str = "file-open-mesh";
#[cfg(desktop)]
const MENU_OPEN_BUNDLE: &str = "file-open-bundle";
#[cfg(desktop)]
const MENU_OPEN_SAMPLE: &str = "file-open-sample";
#[cfg(desktop)]
const MENU_EXPORT_BUNDLE: &str = "file-export-bundle";
#[cfg(target_os = "macos")]
const MENU_SHARE: &str = "file-share";
#[cfg(desktop)]
const MENU_EXPRESS_VIEW: &str = "view-express-view";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NeuroVueServerInfo {
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

/// The label of the window NeuroVue opens at launch.
const MAIN_WINDOW: &str = "main";

pub(crate) struct NeuroVueState {
    /// Each window's dataset server, by window label: windows opened after
    /// launch show datasets of their own.
    servers: Mutex<HashMap<String, volumetric_server::ServerHandle>>,
    pub(crate) sample_path: Option<PathBuf>,
}

impl NeuroVueState {
    /// The dataset server for the window labelled `label`, started empty the
    /// first time a window other than the launch window asks.
    pub(crate) fn server(&self, label: &str) -> volumetric_server::ServerHandle {
        let mut servers = self
            .servers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        servers
            .entry(label.to_string())
            .or_insert_with(volumetric_server::spawn_empty)
            .clone()
    }

    /// Stops the server of a window that has closed.
    fn close(&self, label: &str) {
        let removed = self
            .servers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(label);
        if let Some(server) = removed {
            volumetric_server::shutdown(&server);
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DatasetOpenResult {
    url: String,
    port: u16,
    volume_count: usize,
    dataset_root: String,
    cache_root: String,
    bids_name: Option<String>,
    bids_version: Option<String>,
    bids_dataset_doi: Option<String>,
    warm_progress: volumetric_server::WarmProgressSnapshot,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OverlayAddResult {
    id: String,
    label: String,
    volume_count: usize,
    warm_progress: volumetric_server::WarmProgressSnapshot,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportBundleResult {
    bundle_path: String,
    volume_count: usize,
    total_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeCapabilities {
    terminal_available: bool,
    native_niimath_available: bool,
    airdrop_available: bool,
}

#[tauri::command]
fn neurovue_runtime_capabilities() -> RuntimeCapabilities {
    RuntimeCapabilities {
        terminal_available: cfg!(desktop),
        native_niimath_available: cfg!(desktop),
        airdrop_available: cfg!(target_os = "macos") || cfg!(target_os = "ios"),
    }
}

#[tauri::command]
fn neurovue_server_info(
    window: tauri::Window,
    state: tauri::State<'_, NeuroVueState>,
) -> NeuroVueServerInfo {
    let server = state.server(window.label());
    let bids = volumetric_server::bids_dataset_info(&server);
    NeuroVueServerInfo {
        url: server.url.clone(),
        port: server.port,
        volume_count: volumetric_server::volume_count(&server),
        dataset_root: volumetric_server::dataset_root(&server)
            .map(|path| path.display().to_string()),
        cache_root: volumetric_server::cache_root().display().to_string(),
        bids_name: bids.as_ref().and_then(|info| info.name.clone()),
        bids_version: bids.as_ref().and_then(|info| info.bids_version.clone()),
        bids_dataset_doi: bids.as_ref().and_then(|info| info.dataset_doi.clone()),
        warm_progress: volumetric_server::warm_progress(&server),
        sample_path: state
            .sample_path
            .as_ref()
            .map(|path| path.display().to_string()),
    }
}

#[tauri::command]
async fn open_dataset_path(
    window: tauri::Window,
    state: tauri::State<'_, NeuroVueState>,
    path: String,
) -> Result<DatasetOpenResult, String> {
    let path = normalize_local_path(&path);
    let server = state.server(window.label());
    tauri::async_runtime::spawn_blocking(move || open_dataset_at_path(&server, Path::new(&path)))
        .await
        .map_err(|error| format!("open_dataset_path: join error: {error}"))?
}

/// The iOS document picker hands back a `file://` URL (Tauri copies the picked
/// file into the app's Inbox first), so convert it to a plain, percent-decoded
/// filesystem path. Desktop paths have no scheme, so this is a no-op there.
pub(crate) fn normalize_local_path(raw: &str) -> String {
    let without_scheme = raw.strip_prefix("file://").unwrap_or(raw);
    percent_decode(without_scheme)
}

fn percent_decode(input: &str) -> String {
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

#[tauri::command]
async fn add_overlay_volume_path(
    window: tauri::Window,
    state: tauri::State<'_, NeuroVueState>,
    path: String,
) -> Result<OverlayAddResult, String> {
    let path = normalize_local_path(&path);
    let server = state.server(window.label());
    tauri::async_runtime::spawn_blocking(move || {
        let registered = volumetric_server::register_overlay_volume(&server, Path::new(&path))?;
        Ok(OverlayAddResult {
            id: registered.id,
            label: registered.label,
            volume_count: volumetric_server::volume_count(&server),
            warm_progress: volumetric_server::warm_progress(&server),
        })
    })
    .await
    .map_err(|error| format!("add_overlay_volume_path: join error: {error}"))?
}

#[tauri::command]
async fn export_dataset_bundle(
    window: tauri::Window,
    state: tauri::State<'_, NeuroVueState>,
    dest_path: String,
    volume_ids: Vec<String>,
    view: serde_json::Value,
    created_at: String,
) -> Result<ExportBundleResult, String> {
    let server = state.server(window.label());
    tauri::async_runtime::spawn_blocking(move || {
        let result = volumetric_server::export_bundle(
            &server,
            Path::new(&dest_path),
            &volume_ids,
            &view,
            &created_at,
        )?;
        Ok(ExportBundleResult {
            bundle_path: result.bundle_path,
            volume_count: result.volume_count,
            total_bytes: result.total_bytes,
        })
    })
    .await
    .map_err(|error| format!("export_dataset_bundle: join error: {error}"))?
}

/// Stages the bundle a share sends under the app cache (a share picks no
/// destination, unlike Save). An already-staged bundle whose inputs are
/// unchanged is reused, so re-sharing the same dataset is instant instead of
/// re-zipping. Blocking: run it off the main thread.
fn stage_share_bundle(
    server: &volumetric_server::ServerHandle,
    volume_ids: &[String],
    view: &serde_json::Value,
    created_at: &str,
    name: &str,
) -> Result<(volumetric_server::BundleExportResult, std::path::PathBuf), String> {
    let shares_dir = volumetric_server::cache_root().join("shares");
    let name = sanitize_share_name(name);
    let dest = shares_dir.join(format!("{name}.nvbundle"));
    let sig_path = shares_dir.join(format!("{name}.nvbundle.sig"));
    let key = volumetric_server::share_cache_key(server, volume_ids);

    if dest.is_file() && std::fs::read_to_string(&sig_path).is_ok_and(|sig| sig == key) {
        let total_bytes = std::fs::metadata(&dest).map(|meta| meta.len()).unwrap_or(0);
        return Ok((
            volumetric_server::BundleExportResult {
                bundle_path: dest.display().to_string(),
                volume_count: volume_ids.len(),
                total_bytes,
            },
            dest,
        ));
    }

    volumetric_server::prune_share_cache(&shares_dir, 4);
    let result = volumetric_server::export_bundle(server, &dest, volume_ids, view, created_at)?;
    let _ = std::fs::write(&sig_path, &key); // export_bundle created shares_dir
    Ok((result, dest))
}

/// Devices on the network that can take a Send to iPad (or, from an iPad, a
/// drawing sent back).
/// Listens for sends and advertises the port (see receive.rs, bonjour.rs).
fn start_receiving(app: &tauri::AppHandle) {
    match receive::start(app) {
        Ok(port) => {
            eprintln!("NeuroVue: receiving sends on port {port}");
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let Err(error) = bonjour::advertise(port) {
                eprintln!("NeuroVue: {error}");
            }
        }
        Err(error) => eprintln!("NeuroVue: can't receive sends ({error})"),
    }
}

#[tauri::command]
async fn list_send_targets() -> Result<Vec<send::SendTarget>, String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    return tauri::async_runtime::spawn_blocking(|| {
        bonjour::browse(std::time::Duration::from_millis(1500))
    })
    .await
    .map_err(|error| format!("list_send_targets: join error: {error}"))?;
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    Ok(Vec::new())
}

/// Stages the dataset as a bundle, like a share, and sends it to `target`,
/// returning once the person there has accepted it and it has arrived.
/// `on_offered` hears once staging (slow for a big dataset) is done and the
/// person there is being asked.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn send_view_to_device(
    window: tauri::Window,
    state: tauri::State<'_, NeuroVueState>,
    target: send::SendTarget,
    volume_ids: Vec<String>,
    view: serde_json::Value,
    created_at: String,
    name: String,
    on_offered: tauri::ipc::Channel<()>,
) -> Result<ExportBundleResult, String> {
    let server = state.server(window.label());
    tauri::async_runtime::spawn_blocking(move || {
        let (result, dest) = stage_share_bundle(&server, &volume_ids, &view, &created_at, &name)?;
        let addresses = target.addresses();
        if addresses.is_empty() {
            return Err(format!("Couldn't find {} on the network.", target.name));
        }
        let _ = on_offered.send(());
        send::send_file(&addresses, &target.name, &dest, &send::device_name())?;
        Ok(ExportBundleResult {
            bundle_path: result.bundle_path,
            volume_count: result.volume_count,
            total_bytes: result.total_bytes,
        })
    })
    .await
    .map_err(|error| format!("send_view_to_device: join error: {error}"))?
}

/// Sends a drawing back to the device its volume came from, as a drawing
/// bundle (volumetric_server::export_drawing_bundle). The raw body is a
/// little-endian u32 length, that many bytes of JSON `{ target, base,
/// createdAt }`, then the drawing's NIfTI bytes: a drawing is megabytes, too
/// big to pass as a JSON array of numbers.
#[tauri::command]
async fn send_drawing_to_device(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err("send_drawing_to_device: expected the drawing's bytes".to_string());
    };
    let (length, rest) = body
        .split_first_chunk::<4>()
        .ok_or("send_drawing_to_device: empty body")?;
    let length = u32::from_le_bytes(*length) as usize;
    if rest.len() < length {
        return Err("send_drawing_to_device: truncated body".to_string());
    }
    let (meta, drawing) = rest.split_at(length);
    let meta: serde_json::Value =
        serde_json::from_slice(meta).map_err(|error| format!("send_drawing_to_device: {error}"))?;
    let target: send::SendTarget = serde_json::from_value(meta["target"].clone())
        .map_err(|error| format!("send_drawing_to_device: target: {error}"))?;
    let base = meta["base"].clone();
    let created_at = meta["createdAt"].as_str().unwrap_or_default().to_string();
    let drawing = drawing.to_vec();
    tauri::async_runtime::spawn_blocking(move || {
        let label = base["label"].as_str().unwrap_or("volume");
        let name: String = format!("Drawing on {label}")
            .chars()
            .map(|c| {
                if matches!(c, '/' | '\\' | ':') {
                    '-'
                } else {
                    c
                }
            })
            .collect();
        let dest = volumetric_server::cache_root()
            .join("drawings")
            .join(format!("{name}.nvbundle"));
        volumetric_server::export_drawing_bundle(&dest, &drawing, &base, &created_at)?;
        let addresses = target.addresses();
        if addresses.is_empty() {
            return Err(format!("Couldn't find {} on the network.", target.name));
        }
        let sent = send::send_file(&addresses, &target.name, &dest, &send::device_name());
        let _ = std::fs::remove_file(&dest);
        sent
    })
    .await
    .map_err(|error| format!("send_drawing_to_device: join error: {error}"))?
}

/// Lays a received drawing over the volume it was drawn on (see
/// volumetric_server::attach_drawing) and returns the new volume's id.
#[tauri::command]
async fn attach_drawing(
    window: tauri::Window,
    state: tauri::State<'_, NeuroVueState>,
    drawing_path: String,
    base_id: String,
    base_sha256: String,
    base_label: String,
) -> Result<String, String> {
    let server = state.server(window.label());
    tauri::async_runtime::spawn_blocking(move || {
        volumetric_server::attach_drawing(
            &server,
            Path::new(&drawing_path),
            &base_id,
            &base_sha256,
            &base_label,
        )
    })
    .await
    .map_err(|error| format!("attach_drawing: join error: {error}"))?
}

#[tauri::command]
async fn share_view_via_airdrop(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: tauri::State<'_, NeuroVueState>,
    volume_ids: Vec<String>,
    view: serde_json::Value,
    created_at: String,
    name: String,
) -> Result<ExportBundleResult, String> {
    let server = state.server(window.label());
    let (result, dest) = tauri::async_runtime::spawn_blocking(move || {
        stage_share_bundle(&server, &volume_ids, &view, &created_at, &name)
    })
    .await
    .map_err(|error| format!("share_view_via_airdrop: join error: {error}"))??;

    share::share_via_airdrop(&app, vec![dest.display().to_string()])?;

    Ok(ExportBundleResult {
        bundle_path: result.bundle_path,
        volume_count: result.volume_count,
        total_bytes: result.total_bytes,
    })
}

/// Keep a share bundle's directory name to a safe single path segment.
fn sanitize_share_name(name: &str) -> String {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('-');
    if trimmed.is_empty() {
        "neurovue-bundle".to_string()
    } else {
        trimmed.to_string()
    }
}

#[tauri::command]
async fn read_bundle_manifest(path: String) -> Result<serde_json::Value, String> {
    let path = normalize_local_path(&path);
    tauri::async_runtime::spawn_blocking(move || volumetric_server::read_bundle(Path::new(&path)))
        .await
        .map_err(|error| format!("read_bundle_manifest: join error: {error}"))?
}

/// Open a NiiVue document (`.nvd`): its embedded volumes become `.nii` files,
/// returned in `read_bundle_manifest`'s shape.
#[tauri::command]
async fn read_document_manifest(path: String) -> Result<serde_json::Value, String> {
    let path = normalize_local_path(&path);
    tauri::async_runtime::spawn_blocking(move || volumetric_server::read_document(Path::new(&path)))
        .await
        .map_err(|error| format!("read_document_manifest: join error: {error}"))?
}

/// Surface mesh formats NiiVue reads (its `mesh/readers`), lower-case. FreeSurfer
/// surfaces are named by their type (`lh.pial`), so those count as extensions.
const MESH_EXTENSIONS: &[&str] = &[
    "asc", "byu", "dfs", "geo", "gii", "ico", "mz3", "nv", "obj", "off", "ply", "srf", "stl",
    "vtk", "wrl", "x3d", "cbor", "white", "pial", "inflated", "sphere", "orig", "smoothwm",
    "qsphere", "trk", "tck", "trx",
];

/// The raw bytes of a surface mesh. Meshes skip the volume server: the viewer
/// hands the bytes straight to NiiVue, which parses the format itself.
#[tauri::command]
async fn read_mesh_file(path: String) -> Result<tauri::ipc::Response, String> {
    let path = PathBuf::from(normalize_local_path(&path));
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
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::read(&path)
            .map(tauri::ipc::Response::new)
            .map_err(|error| format!("Couldn't read {}: {error}", path.display()))
    })
    .await
    .map_err(|error| format!("read_mesh_file: join error: {error}"))?
}

fn open_dataset_at_path(
    server: &volumetric_server::ServerHandle,
    root: &Path,
) -> Result<DatasetOpenResult, String> {
    let volume_count = volumetric_server::open_dataset_root(server, root)?;
    let dataset_root = volumetric_server::dataset_root(server)
        .unwrap_or_else(|| root.to_path_buf())
        .display()
        .to_string();
    let bids = volumetric_server::bids_dataset_info(server);

    Ok(DatasetOpenResult {
        url: server.url.clone(),
        port: server.port,
        volume_count,
        dataset_root,
        cache_root: volumetric_server::cache_root().display().to_string(),
        bids_name: bids.as_ref().and_then(|info| info.name.clone()),
        bids_version: bids.as_ref().and_then(|info| info.bids_version.clone()),
        bids_dataset_doi: bids.as_ref().and_then(|info| info.dataset_doi.clone()),
        warm_progress: volumetric_server::warm_progress(server),
    })
}

#[cfg(desktop)]
fn neurovue_menu<R: tauri::Runtime>(handle: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    // Start from Tauri's default bar so the app, Edit (copy/paste in text
    // fields), View and Window menus keep working, then fill in File.
    let menu = Menu::default(handle)?;
    let open_file = MenuItem::with_id(
        handle,
        MENU_OPEN_FILE,
        "Open File\u{2026}",
        true,
        Some("CmdOrCtrl+O"),
    )?;
    let open_folder = MenuItem::with_id(
        handle,
        MENU_OPEN_FOLDER,
        "Open Folder\u{2026}",
        true,
        Some("CmdOrCtrl+Shift+O"),
    )?;
    let open_mesh = MenuItem::with_id(
        handle,
        MENU_OPEN_MESH,
        "Open Mesh\u{2026}",
        true,
        Some("CmdOrCtrl+Shift+M"),
    )?;
    let open_bundle = MenuItem::with_id(
        handle,
        MENU_OPEN_BUNDLE,
        "Open Bundle\u{2026}",
        true,
        Some("CmdOrCtrl+Alt+O"),
    )?;
    let open_sample = MenuItem::with_id(
        handle,
        MENU_OPEN_SAMPLE,
        "Open Sample Dataset",
        true,
        None::<&str>,
    )?;
    let export_bundle = MenuItem::with_id(
        handle,
        MENU_EXPORT_BUNDLE,
        "Export Bundle\u{2026}",
        true,
        Some("CmdOrCtrl+E"),
    )?;
    // AirDrop exists only on Apple platforms, and of those only macOS has a
    // menu bar.
    #[cfg(target_os = "macos")]
    let share = MenuItem::with_id(
        handle,
        MENU_SHARE,
        "Share via AirDrop\u{2026}",
        true,
        None::<&str>,
    )?;
    let open_separator = PredefinedMenuItem::separator(handle)?;
    let close_separator = PredefinedMenuItem::separator(handle)?;
    let items: Vec<&dyn tauri::menu::IsMenuItem<R>> = vec![
        &open_file,
        &open_folder,
        &open_mesh,
        &open_bundle,
        &open_sample,
        &open_separator,
        &export_bundle,
        #[cfg(target_os = "macos")]
        &share,
        // Keeps the default File items (Close Window, Quit off macOS) apart.
        &close_separator,
    ];

    // The default bar already has a File menu on macOS and Windows; extend it
    // so Close Window stays at the bottom. Linux's default has none, so add one.
    let existing_file = menu.items()?.into_iter().find_map(|item| {
        item.as_submenu()
            .filter(|submenu| submenu.text().is_ok_and(|text| text == "File"))
            .cloned()
    });
    match existing_file {
        Some(file_menu) => file_menu.prepend_items(&items)?,
        None => {
            let file_menu = Submenu::with_items(handle, "File", true, &items[..items.len() - 1])?;
            menu.insert(&file_menu, 0)?;
        }
    }

    // Same for View: macOS's default has one (Enter Full Screen), others may not.
    let express_view = MenuItem::with_id(
        handle,
        MENU_EXPRESS_VIEW,
        "Toggle Express View",
        true,
        Some("CmdOrCtrl+Alt+V"),
    )?;
    let allow_agents = CheckMenuItem::with_id(
        handle,
        mcp::MENU_ALLOW_AGENTS,
        "Allow AI Agents",
        true,
        // Checked in setup: the saved choice lives in the config dir, which
        // isn't resolvable while the menu is built.
        false,
        None::<&str>,
    )?;
    let existing_view = menu.items()?.into_iter().find_map(|item| {
        item.as_submenu()
            .filter(|submenu| submenu.text().is_ok_and(|text| text == "View"))
            .cloned()
    });
    match existing_view {
        Some(view_menu) => view_menu.prepend_items(&[
            &express_view,
            &allow_agents,
            &PredefinedMenuItem::separator(handle)?,
        ])?,
        None => {
            let view_menu =
                Submenu::with_items(handle, "View", true, &[&express_view, &allow_agents])?;
            menu.append(&view_menu)?;
        }
    }
    Ok(menu)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(opened::OpenedFiles::default())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<NeuroVueState>() {
                    state.close(window.label());
                }
            }
        })
        .setup(|app| {
            // The bundled MNI152 is not opened at launch: the app starts on the
            // Welcome screen (or reopens the last dataset), which offers it as a
            // sample through `open_dataset_path`.
            let sample_path = app
                .path()
                .resolve(
                    "resources/mni152.nii.gz",
                    tauri::path::BaseDirectory::Resource,
                )
                .ok()
                .filter(|path| path.is_file());
            // niimath derivatives and extracted bundles are user work, so they
            // live in the app's local data dir rather than the OS temp dir,
            // which macOS purges. Set before the server spawns: discovery
            // restores working derivatives from there.
            match app.path().app_local_data_dir() {
                Ok(dir) => volumetric_server::init_data_root(dir),
                Err(error) => eprintln!(
                    "NeuroVue: no app data dir ({error}); keeping user work in the temp cache"
                ),
            }
            app.manage(NeuroVueState {
                servers: Mutex::new(HashMap::from([(
                    MAIN_WINDOW.to_string(),
                    volumetric_server::spawn_default(),
                )])),
                sample_path,
            });
            #[cfg(desktop)]
            mcp::start_if_enabled(app.handle());
            // The iPad listens for Send to iPad from a Mac, and the Mac for
            // drawings sent back. Elsewhere nothing advertises the port, so
            // only listen when asked.
            if cfg!(any(target_os = "ios", target_os = "macos"))
                || std::env::var_os("NEUROVUE_RECEIVE").is_some()
            {
                start_receiving(app.handle());
            }
            Ok(())
        });

    // The menu bar (and its File menu) is desktop-only; on mobile the frontend
    // opens datasets through on-screen controls instead.
    #[cfg(desktop)]
    let builder = builder.menu(neurovue_menu).on_menu_event(|app, event| {
        let id = event.id().as_ref();
        if id == mcp::MENU_ALLOW_AGENTS {
            let checked = mcp::allow_agents_item(app).and_then(|item| item.is_checked().ok());
            if let Some(enabled) = checked {
                mcp::set_enabled(app, enabled);
            }
            return;
        }
        if let Some(action) = id
            .strip_prefix("file-")
            .or_else(|| id.strip_prefix("view-"))
        {
            // To the window in front only: each window has its own dataset.
            let focused = app
                .webview_windows()
                .into_values()
                .find(|window| window.is_focused().unwrap_or(false));
            let label =
                focused.map_or(MAIN_WINDOW.to_string(), |window| window.label().to_string());
            let _ = app.emit_to(EventTarget::webview_window(label), MENU_EVENT, action);
        }
    });

    // niimath (sidecar) and terminal (PTY) commands are desktop-only; mobile
    // registers only the portable commands.
    #[cfg(desktop)]
    let builder = builder
        .manage(terminal::TerminalState::default())
        .manage(mcp::McpState::default())
        .invoke_handler(tauri::generate_handler![
            neurovue_runtime_capabilities,
            neurovue_server_info,
            open_dataset_path,
            add_overlay_volume_path,
            read_mesh_file,
            export_dataset_bundle,
            read_bundle_manifest,
            read_document_manifest,
            share_view_via_airdrop,
            opened::take_opened_files,
            receive::answer_send_offer,
            list_send_targets,
            send_view_to_device,
            send_drawing_to_device,
            attach_drawing,
            niimath::validate_niimath_mask_path,
            niimath::run_niimath_task,
            terminal::terminal_start,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_kill,
            terminal::discover_python_interpreters,
            terminal::inspect_python_interpreter,
            mcp::mcp_status,
            mcp::agent_resolve_path,
            mcp::open_viewer_window,
            mcp::focus_window
        ]);
    #[cfg(not(desktop))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        neurovue_runtime_capabilities,
        neurovue_server_info,
        open_dataset_path,
        add_overlay_volume_path,
        read_mesh_file,
        export_dataset_bundle,
        read_bundle_manifest,
        read_document_manifest,
        share_view_via_airdrop,
        opened::take_opened_files,
        receive::answer_send_offer,
        list_send_targets,
        send_view_to_device,
        send_drawing_to_device,
        attach_drawing
    ]);

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building NeuroVue");
    app.run(|_app, event| match event {
        // Don't leave the agent server holding its port after we quit.
        #[cfg(desktop)]
        tauri::RunEvent::Exit => mcp::stop(_app),
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        tauri::RunEvent::Opened { urls } => opened::receive(_app, urls),
        // A suspended iOS app can lose its listening socket and its Bonjour
        // registration, so the iPad would no longer show up to send to.
        // With scenes, coming back is a window gaining focus (RunEvent::Resumed
        // is something else, and WindowEvent::Resumed never comes).
        #[cfg(target_os = "ios")]
        tauri::RunEvent::WindowEvent {
            event: tauri::WindowEvent::Focused(true),
            ..
        } => {
            let app = _app.clone();
            std::thread::spawn(move || match receive::live_port(&app) {
                Some(port) => {
                    if let Err(error) = bonjour::advertise(port) {
                        eprintln!("NeuroVue: {error}");
                    }
                }
                None => start_receiving(&app),
            });
        }
        _ => {}
    });
}
