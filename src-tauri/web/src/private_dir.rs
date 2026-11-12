//! The cache directory neurovue-web keeps pyramids, previews, imports, and the
//! last-opened dataset in. It must belong to this user alone: on a multi-user
//! Linux host (an HPC node under Neurodesk) /tmp is shared, so a fixed
//! /tmp/neurovue could be pre-created, read, poisoned, or swapped for a
//! symlink by another user, and the cache sweep deletes what it finds there.

use std::path::{Path, PathBuf};

/// `$NEUROVUE_CACHE_DIR`, else `$XDG_CACHE_HOME/neurovue`, else
/// `~/.cache/neurovue` (survives a Neurodesk container restart), else
/// `<tmp>/neurovue-<uid>`.
pub fn default_cache_dir() -> PathBuf {
    let non_empty = |key: &str| std::env::var_os(key).filter(|value| !value.is_empty());
    if let Some(dir) = non_empty("NEUROVUE_CACHE_DIR") {
        return dir.into();
    }
    if let Some(xdg) = non_empty("XDG_CACHE_HOME") {
        return PathBuf::from(xdg).join("neurovue");
    }
    if let Some(home) = non_empty("HOME") {
        return PathBuf::from(home).join(".cache").join("neurovue");
    }
    std::env::temp_dir().join(format!("neurovue-{}", current_uid()))
}

/// Create `dir` if needed, then require that it is a real directory (not a
/// symlink) owned by this user, and tighten it to 0700. Fails rather than
/// using a directory someone else controls.
#[cfg(unix)]
pub fn ensure_private_dir(dir: &Path) -> Result<(), String> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};

    let describe = |error: std::io::Error| format!("{}: {error}", dir.display());
    if let Some(parent) = dir.parent() {
        std::fs::create_dir_all(parent).map_err(describe)?;
    }
    match std::fs::DirBuilder::new().mode(0o700).create(dir) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(describe(error)),
    }
    let meta = std::fs::symlink_metadata(dir).map_err(describe)?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(format!(
            "{} is a symlink or not a directory; refusing to use it as the cache",
            dir.display()
        ));
    }
    let uid = current_uid();
    if meta.uid() != uid {
        return Err(format!(
            "{} is owned by uid {}, not this user (uid {uid}); refusing to use it as the cache",
            dir.display(),
            meta.uid()
        ));
    }
    if meta.mode() & 0o077 != 0 {
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).map_err(describe)?;
    }
    Ok(())
}

#[cfg(not(unix))]
pub fn ensure_private_dir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|error| format!("{}: {error}", dir.display()))
}

#[cfg(unix)]
pub fn current_uid() -> u32 {
    // SAFETY: getuid has no preconditions and cannot fail.
    unsafe { libc::getuid() }
}

#[cfg(not(unix))]
pub fn current_uid() -> u32 {
    0
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "neurovue-private-dir-test-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn creates_a_0700_directory() {
        let dir = scratch("create").join("cache");
        ensure_private_dir(&dir).unwrap();
        let mode = std::fs::metadata(&dir).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
    }

    #[test]
    fn tightens_an_existing_open_directory() {
        let dir = scratch("tighten").join("cache");
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o777)).unwrap();
        ensure_private_dir(&dir).unwrap();
        let mode = std::fs::metadata(&dir).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
    }

    #[test]
    fn refuses_a_symlink() {
        let root = scratch("symlink");
        let target = root.join("elsewhere");
        std::fs::create_dir(&target).unwrap();
        let link = root.join("cache");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let error = ensure_private_dir(&link).unwrap_err();
        assert!(error.contains("symlink"), "{error}");
    }
}
