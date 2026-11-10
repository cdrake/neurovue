//! Apple Pencil on the iPad (ios/Sources/PencilPlugin.swift): a double-tap or
//! squeeze reaches the page as a `tap` or `squeeze` event carrying the action
//! the person chose for it in Settings, and `feedback` plays the Pencil Pro's
//! haptics. The page calls both straight through to Swift; on other platforms
//! the plugin is empty.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_pencil);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("pencil")
        .setup(|_app, _api| {
            #[cfg(target_os = "ios")]
            _api.register_ios_plugin(init_plugin_pencil)?;
            Ok(())
        })
        .build()
}
