//! `neurovue-cli`: write a NeuroFlow review step's outputs without a window.
//!
//! `--check` reports readiness for NeuroFlow's app-cli probe.
//! `--neuroflow-session <dir>` reads the session's context.json, opens its
//! `inputs` (`bids_dir`, `volumes`, `match`), and writes `correction.patch.json`
//! and `review.state.json` (and `review.nvbundle` when `inputs.bundle` is true)
//! to the step's output dir, with one `review.headless` provenance line.

use crate::volumetric_server::{
    append_provenance, export_bundle, iso8601_utc_now, neuroflow_context_at, open_offline,
    review_state_of, volume_ids, ServerHandle,
};
use serde_json::{json, Value};
use std::{fs, path::PathBuf};

const USAGE: &str = "usage: neurovue-cli --check | --neuroflow-session <dir>";

/// Run the CLI on `args` (without the program name); returns the exit code.
pub fn main(args: Vec<String>) -> i32 {
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["--check"] => {
            println!(
                "{}",
                json!({ "ready": true, "version": format!("v{}", env!("CARGO_PKG_VERSION")) })
            );
            0
        }
        ["--neuroflow-session", session] => match review(PathBuf::from(session)) {
            Ok(outputs) => {
                println!("{}", json!({ "ok": true, "outputs": outputs }));
                0
            }
            Err(error) => {
                eprintln!("neurovue-cli: {error}");
                1
            }
        },
        _ => {
            eprintln!("{USAGE}");
            2
        }
    }
}

/// Write the review outputs of the session at `session_dir`; returns them by name.
pub fn review(session_dir: PathBuf) -> Result<Value, String> {
    if !session_dir.join("context.json").is_file() {
        return Err(format!("{}: no context.json", session_dir.display()));
    }
    let ctx = neuroflow_context_at(session_dir);
    let inputs = &ctx.context["inputs"];
    let handle = open_offline(inputs)?;
    let ids = volume_ids(&handle);
    let view = match &inputs["view"] {
        Value::Object(_) => inputs["view"].clone(),
        _ => default_view(&ids, &inputs["clip_planes"]),
    };

    fs::create_dir_all(&ctx.output_dir)
        .map_err(|error| format!("{}: {error}", ctx.output_dir.display()))?;
    let write = |name: &str, value: &Value| {
        let path = ctx.output_dir.join(name);
        let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
        fs::write(&path, bytes).map_err(|error| format!("{}: {error}", path.display()))
    };
    write("correction.patch.json", &correction_patch(&handle, &view))?;
    write("review.state.json", &review_state_of(&handle, &view))?;
    let mut outputs = json!({
        "correction.patch.json": "correction.patch.json",
        "review.state.json": "review.state.json",
    });
    if inputs["bundle"].as_bool() == Some(true) {
        export_bundle(
            &handle,
            &ctx.output_dir.join("review.nvbundle"),
            &ids,
            &view,
            &iso8601_utc_now(),
        )?;
        outputs["review.nvbundle"] = json!("review.nvbundle");
    }
    append_provenance(&ctx, "review.headless", outputs.clone());
    Ok(outputs)
}

/// The view a window opens with: the first volume as the base, the rest as
/// overlays, and the given clip planes.
fn default_view(ids: &[String], clip_planes: &Value) -> Value {
    let volumes: Vec<Value> = ids
        .iter()
        .enumerate()
        .map(|(index, id)| json!({ "id": id, "role": if index == 0 { "base" } else { "overlay" } }))
        .collect();
    json!({
        "version": 1,
        "scene": { "crosshairPos": null, "clipPlanes": enabled_planes(clip_planes) },
        "volumes": volumes,
        "viewMode": "multiplanar",
        "backend": "webgl2",
    })
}

/// The window's Save payload (App.tsx `savePatch`), for the view's base volume.
fn correction_patch(handle: &ServerHandle, view: &Value) -> Value {
    let ids = volume_ids(handle);
    let base = view["volumes"][0]["id"]
        .as_str()
        .filter(|id| ids.iter().any(|known| known == id))
        .unwrap_or(&ids[0]);
    let source = crate::volumetric_server::volume_source_path(handle, base);
    json!({
        "neurovue": "0.1.0",
        "asset": { "id": base, "type": "VolumeDesktop", "manifest": source },
        "backend": "headless",
        "clipPlanes": enabled_planes(&view["scene"]["clipPlanes"]),
        "savedAt": iso8601_utc_now(),
    })
}

fn enabled_planes(planes: &Value) -> Vec<Value> {
    planes
        .as_array()
        .into_iter()
        .flatten()
        .filter(|plane| plane["enabled"].as_bool() != Some(false))
        .cloned()
        .collect()
}
