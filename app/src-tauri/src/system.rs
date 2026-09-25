//! macOS integration: FileVault state, Time Machine exclusion, the Chrome native host
//! manifest, peer checks for the app socket, and the user's full name.

use anyhow::{Context, Result};
use serde_json::json;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};

pub const NATIVE_HOST_NAME: &str = "app.tinta";
pub const EXTENSION_ID: &str = "ajncjfpbmkmiheokjfhfdlhnmfbaofij";

pub fn filevault_on() -> bool {
    Command::new("/usr/bin/fdesetup")
        .arg("isactive")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Excludes the data directory from Time Machine. The exclusion stays with the folder.
pub fn exclude_from_backup(dir: &Path) {
    let _ = Command::new("/usr/bin/tmutil").arg("addexclusion").arg(dir).output();
}

/// The full name of the macOS user. The app reads it once.
pub fn full_name() -> String {
    static NAME: OnceLock<String> = OnceLock::new();
    NAME.get_or_init(|| {
        Command::new("/usr/bin/id")
            .arg("-F")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "Me".into())
    })
    .clone()
}

/// A helper binary next to the app executable, or in the Cargo target directory in development.
pub fn helper_path(name: &str) -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join(name)))
        .unwrap_or_else(|| PathBuf::from(name))
}

/// Writes the Native Messaging host manifest for Chrome. Chrome starts the host only
/// for the published extension ID.
pub fn install_native_host() -> Result<PathBuf> {
    let dir = dirs_home()
        .join("Library/Application Support/Google/Chrome/NativeMessagingHosts");
    std::fs::create_dir_all(&dir)?;
    let manifest = json!({
        "name": NATIVE_HOST_NAME,
        "description": "Tinta: Google Meet participant names",
        "path": helper_path("tinta-native-host"),
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{EXTENSION_ID}/")],
    });
    let path = dir.join(format!("{NATIVE_HOST_NAME}.json"));
    std::fs::write(&path, serde_json::to_vec_pretty(&manifest)?).context("cannot write the native host manifest")?;
    Ok(path)
}

fn dirs_home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

/// The executable path of the process at the other end of a Unix socket.
pub fn peer_path(fd: i32) -> Option<PathBuf> {
    let mut pid: libc::pid_t = 0;
    let mut len = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
    // SOL_LOCAL = 0, LOCAL_PEERPID = 2 on macOS.
    let status = unsafe { libc::getsockopt(fd, 0, 2, &mut pid as *mut _ as *mut libc::c_void, &mut len) };
    if status != 0 || pid <= 0 {
        return None;
    }
    let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let size = unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr() as *mut libc::c_void, buffer.len() as u32) };
    if size <= 0 {
        return None;
    }
    buffer.truncate(size as usize);
    String::from_utf8(buffer).ok().map(PathBuf::from)
}

static SIGNATURES: Mutex<Option<HashMap<PathBuf, bool>>> = Mutex::new(None);

/// Accepts a peer only if it is one of the helper binaries next to this app and its code
/// signature is valid.
pub fn trusted_peer(path: &Path) -> bool {
    let allowed = ["tinta-mcp", "tinta-native-host"].iter().any(|name| {
        let expected = helper_path(name);
        match (expected.canonicalize(), path.canonicalize()) {
            (Ok(a), Ok(b)) => a == b,
            _ => false,
        }
    });
    if !allowed {
        return false;
    }
    let mut cache = SIGNATURES.lock().unwrap();
    let cache = cache.get_or_insert_with(HashMap::new);
    if let Some(valid) = cache.get(path) {
        return *valid;
    }
    let valid = Command::new("/usr/bin/codesign")
        .args(["--verify", "--strict"])
        .arg(path)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    cache.insert(path.to_path_buf(), valid);
    valid
}
