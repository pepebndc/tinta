use anyhow::{bail, Context, Result};
use std::path::{Component, Path, PathBuf};
use std::sync::RwLock;

/// The fixed app folder. It holds `config.json` and the app socket, so the helper binaries
/// always find the app. `TINTA_DATA_DIR` overrides it for tests.
pub fn base_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("TINTA_DATA_DIR") {
        return PathBuf::from(dir);
    }
    dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")).join("Tinta")
}

fn config_path() -> PathBuf {
    base_dir().join("config.json")
}

static LIBRARY: RwLock<Option<PathBuf>> = RwLock::new(None);

/// The library folder that `config.json` names. Without `config.json`, the library is in `base_dir()`.
fn configured_dir() -> Result<Option<PathBuf>> {
    let path = config_path();
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).with_context(|| format!("cannot read {}", path.display())),
    };
    let config: serde_json::Value = serde_json::from_str(&text).with_context(|| {
        format!(
            "Tinta cannot read the file that holds the location of the library: {}. Correct the file, or delete it to open the library in the default folder. Details",
            path.display()
        )
    })?;
    Ok(config["library_dir"].as_str().map(PathBuf::from))
}

/// The folder of the library and the audio. The user can move it. The default is `base_dir()`.
pub fn data_dir() -> PathBuf {
    if let Some(dir) = LIBRARY.read().unwrap().clone() {
        return dir;
    }
    let dir = configured_dir().ok().flatten().unwrap_or_else(base_dir);
    *LIBRARY.write().unwrap() = Some(dir.clone());
    dir
}

/// Checks that the app can find the library that the user moved. The app calls this before it opens
/// the library, so a folder that is not there gives a message and not a new, empty library.
pub fn check_library() -> Result<()> {
    let Some(dir) = configured_dir()? else { return Ok(()) };
    if !dir.join("library.db").exists() {
        bail!(
            "Tinta cannot find the library in {}. Put the folder back, or connect its disk, and open Tinta again. To start with an empty library, delete {}.",
            dir.display(),
            config_path().display()
        );
    }
    Ok(())
}

/// Records a new library folder. The caller moves the files first.
pub fn set_data_dir(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(base_dir())?;
    let config = serde_json::json!({ "library_dir": dir });
    // A rename replaces the file in one step, so a crash leaves the old file or the new file.
    let temporary = config_path().with_extension("json.tmp");
    std::fs::write(&temporary, serde_json::to_vec_pretty(&config)?).context("cannot write config.json")?;
    std::fs::rename(&temporary, config_path()).context("cannot write config.json")?;
    *LIBRARY.write().unwrap() = Some(dir.to_path_buf());
    Ok(())
}

/// The library must stay on this Mac, so cloud-synced folders are not allowed.
/// The check follows symbolic links, and it compares whole folder names.
pub fn check_local(dir: &Path) -> Result<()> {
    if is_synced(&resolve(dir)) {
        bail!("This folder is in a cloud-synced location. Select a folder that stays on this Mac.");
    }
    Ok(())
}

/// The real path of `dir`. The last parts of the path can be folders that do not exist yet.
fn resolve(dir: &Path) -> PathBuf {
    let mut missing = Vec::new();
    let mut existing = dir;
    loop {
        if let Ok(real) = existing.canonicalize() {
            return missing.iter().rev().fold(real, |path, name| path.join(name));
        }
        match (existing.parent(), existing.file_name()) {
            (Some(parent), Some(name)) => {
                missing.push(name);
                existing = parent;
            }
            _ => return dir.to_path_buf(),
        }
    }
}

fn is_synced(dir: &Path) -> bool {
    let names: Vec<String> = dir
        .components()
        .filter_map(|c| match c {
            Component::Normal(name) => Some(name.to_string_lossy().to_lowercase()),
            _ => None,
        })
        .collect();
    let in_library = |folder: &str| names.windows(2).any(|pair| pair[0] == "library" && pair[1] == folder);
    in_library("mobile documents")
        || in_library("cloudstorage")
        || names.iter().any(|n| {
            matches!(n.as_str(), "dropbox" | "google drive" | "googledrive" | "box sync")
                || n.starts_with("onedrive")
                || n.starts_with("dropbox (")
        })
}

pub fn database_path() -> PathBuf {
    data_dir().join("library.db")
}

pub fn meeting_dir(meeting_id: &str) -> PathBuf {
    data_dir().join("meetings").join(meeting_id)
}

pub fn audio_dir(meeting_id: &str) -> PathBuf {
    meeting_dir(meeting_id).join("audio")
}

/// The Unix socket that the MCP binary and the Chrome native host use.
pub fn socket_path() -> PathBuf {
    base_dir().join("tinta.sock")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_synced_folders_by_whole_names_and_through_links() {
        let home = Path::new("/Users/ana");
        for synced in [
            "Library/Mobile Documents/com~apple~CloudDocs/Tinta",
            "Library/CloudStorage/GoogleDrive-ana@example.com/My Drive/Tinta",
            "Dropbox/Tinta",
            "Dropbox (Example)/Tinta",
            "OneDrive - Example/Tinta",
            "Google Drive/Tinta",
        ] {
            assert!(is_synced(&home.join(synced)), "{synced}");
        }
        for local in ["Tinta", "dropbox-notes/Tinta", "Music/Library/Tinta", "Boxes/Tinta"] {
            assert!(!is_synced(&home.join(local)), "{local}");
        }

        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("Dropbox");
        std::fs::create_dir_all(&real).unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(check_local(&link.join("Tinta")).is_err());
        assert!(check_local(&dir.path().join("local").join("Tinta")).is_ok());
    }
}
