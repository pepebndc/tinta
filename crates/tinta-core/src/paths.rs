use std::path::PathBuf;

/// The app data directory. `TINTA_DATA_DIR` overrides it for tests.
pub fn data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("TINTA_DATA_DIR") {
        return PathBuf::from(dir);
    }
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Tinta")
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
    data_dir().join("tinta.sock")
}
