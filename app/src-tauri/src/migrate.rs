//! Moves the macOS data of the bundle identifier of versions before 0.4.0 to the current
//! identifier. Each step runs only while the old data exists, so the move happens once.

use std::path::{Path, PathBuf};

const OLD_IDENTIFIER: &str = "app.tinta";

/// Runs before the window opens, because the web view locks its data folder.
pub fn run(identifier: &str) {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return;
    };
    let library = home.join("Library");
    // The web view data holds the interface settings, for example the theme and the sidebar filter.
    let old_webkit = library.join("WebKit").join(OLD_IDENTIFIER);
    let webkit = library.join("WebKit").join(identifier);
    if old_webkit.exists() && !webkit.exists() {
        let _ = std::fs::rename(&old_webkit, &webkit);
    }
    remove(&old_webkit);
    remove(&library.join("Caches").join(OLD_IDENTIFIER));
    remove(&library.join("HTTPStorages").join(OLD_IDENTIFIER));
    remove(&library.join("Saved Application State").join(format!("{OLD_IDENTIFIER}.savedState")));
    remove(&library.join("Preferences").join(format!("{OLD_IDENTIFIER}.plist")));
}

fn remove(path: &Path) {
    if path.is_dir() {
        let _ = std::fs::remove_dir_all(path);
    } else if path.exists() {
        let _ = std::fs::remove_file(path);
    }
}
