//! Core library for Tinta: storage, keys, name matching, calendar events, export, and MCP tools.

pub mod calendar;
pub mod db;
pub mod export;
pub mod granola;
pub mod keys;
pub mod naming;
pub mod paths;
pub mod protocol;
pub mod tools;
pub mod transcript;

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub const DAY_MS: i64 = 24 * 60 * 60 * 1000;
pub const DEFAULT_AUDIO_RETENTION_DAYS: i64 = 7;
pub const MAX_AUDIO_RETENTION_DAYS: i64 = 30;
pub const TRASH_DAYS: i64 = 7;
