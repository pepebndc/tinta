use crate::keys::Keys;
use crate::{now_ms, DAY_MS, DEFAULT_AUDIO_RETENTION_DAYS, MAX_AUDIO_RETENTION_DAYS, TRASH_DAYS};

const AUDIO_RETENTION_SETTING: &str = "audio_retention_days";
use anyhow::{anyhow, bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;

/// The kinds of search entries. Each meeting has one entry of each kind.
const SEARCH_KINDS: [&str; 5] = ["title", "notes", "summary", "speakers", "transcript"];

/// The author of a summary that an MCP client wrote.
pub const MCP_AUTHOR: &str = "MCP client";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Summary {
    pub content: String,
    /// The local model, or `MCP_AUTHOR`.
    pub written_by: String,
    pub updated_at: i64,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS meetings (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    ended_at INTEGER,
    duration REAL NOT NULL DEFAULT 0,
    state TEXT NOT NULL,
    language TEXT,
    source TEXT,
    meeting_code TEXT,
    folder TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    audio_until INTEGER,
    audio_deleted INTEGER NOT NULL DEFAULT 0,
    audio_trashed_at INTEGER,
    deleted_at INTEGER,
    error TEXT
);
CREATE TABLE IF NOT EXISTS recordings (
    meeting_id TEXT NOT NULL,
    start_wall_ms INTEGER NOT NULL,
    offset_seconds REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS notes (
    meeting_id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS summaries (
    meeting_id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    model TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tags (
    meeting_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    PRIMARY KEY (meeting_id, tag)
);
CREATE TABLE IF NOT EXISTS speakers (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL,
    label TEXT NOT NULL,
    track TEXT NOT NULL,
    name TEXT,
    name_source TEXT,
    suggestion TEXT,
    suggestion_score REAL,
    merged_into TEXT
);
CREATE TABLE IF NOT EXISTS turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id TEXT NOT NULL,
    track TEXT NOT NULL,
    speaker_id TEXT,
    start REAL NOT NULL,
    end REAL NOT NULL,
    text TEXT NOT NULL,
    provisional INTEGER NOT NULL DEFAULT 0,
    live_name TEXT,
    name_changed INTEGER NOT NULL DEFAULT 0,
    edited INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS turns_meeting ON turns (meeting_id, start);
CREATE INDEX IF NOT EXISTS turns_speaker ON turns (speaker_id);
CREATE INDEX IF NOT EXISTS speakers_meeting ON speakers (meeting_id);
CREATE INDEX IF NOT EXISTS recordings_meeting ON recordings (meeting_id);
CREATE TABLE IF NOT EXISTS participants (
    meeting_id TEXT NOT NULL,
    participant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    is_self INTEGER NOT NULL,
    PRIMARY KEY (meeting_id, participant_id)
);
CREATE TABLE IF NOT EXISTS speaker_events (
    meeting_id TEXT NOT NULL,
    t_ms INTEGER NOT NULL,
    speaking TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS speaker_events_meeting ON speaker_events (meeting_id, t_ms);
CREATE TABLE IF NOT EXISTS revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch TEXT NOT NULL,
    meeting_id TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    field TEXT NOT NULL,
    origin TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    ts INTEGER NOT NULL,
    undone INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS revisions_meeting ON revisions (meeting_id);
CREATE INDEX IF NOT EXISTS revisions_batch ON revisions (batch);
CREATE TABLE IF NOT EXISTS access_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    session TEXT NOT NULL,
    tool TEXT NOT NULL,
    meeting_ids TEXT NOT NULL,
    result TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(meeting_id UNINDEXED, kind UNINDEXED, body, tokenize = 'unicode61 remove_diacritics 2');
"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    User,
    Mcp,
}

impl Origin {
    pub fn as_str(self) -> &'static str {
        match self {
            Origin::User => "user",
            Origin::Mcp => "mcp",
        }
    }
}

/// One change that the MCP screen shows and can undo.
struct Change<'a> {
    meeting_id: &'a str,
    entity: &'a str,
    entity_id: &'a str,
    field: &'a str,
    old: Option<&'a str>,
    new: Option<&'a str>,
}

impl<'a> Change<'a> {
    /// A change of a field of the meeting itself.
    fn meeting(id: &'a str, field: &'a str, old: Option<&'a str>, new: Option<&'a str>) -> Self {
        Change { meeting_id: id, entity: "meeting", entity_id: id, field, old, new }
    }

    /// A change of a part of the meeting that has the meeting ID, such as the notes or the summary.
    fn whole(id: &'a str, entity: &'a str, old: Option<&'a str>, new: Option<&'a str>) -> Self {
        Change { meeting_id: id, entity, entity_id: id, field: "content", old, new }
    }
}

/// A short view of a meeting for the meeting cards on Home.
#[derive(Debug, Clone, Serialize)]
pub struct Preview {
    pub summary: Option<String>,
    pub people: Vec<String>,
}

/// The first line of a summary that is not a heading, without Markdown marks.
fn summary_line(content: &str) -> Option<String> {
    let line = content.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with('#'))?;
    let text = line.trim_start_matches("- ").replace("**", "");
    let mut short: String = text.chars().take(160).collect();
    if text.chars().count() > 160 {
        short.push('…');
    }
    Some(short)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Meeting {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub duration: f64,
    pub state: String,
    pub language: Option<String>,
    pub source: Option<String>,
    pub meeting_code: Option<String>,
    pub folder: Option<String>,
    pub archived: bool,
    pub audio_until: Option<i64>,
    pub audio_deleted: bool,
    pub audio_trashed_at: Option<i64>,
    pub deleted_at: Option<i64>,
    pub error: Option<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Speaker {
    pub id: String,
    pub meeting_id: String,
    pub label: String,
    pub track: String,
    pub name: Option<String>,
    /// "user", "platform", or "self".
    pub name_source: Option<String>,
    pub suggestion: Option<String>,
    pub suggestion_score: Option<f64>,
    pub merged_into: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Turn {
    pub id: i64,
    pub meeting_id: String,
    pub track: String,
    pub speaker_id: Option<String>,
    pub start: f64,
    pub end: f64,
    pub text: String,
    pub provisional: bool,
    pub live_name: Option<String>,
    pub name_changed: bool,
    pub edited: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Participant {
    pub participant_id: String,
    pub name: String,
    pub is_self: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Revision {
    pub id: i64,
    pub batch: String,
    pub meeting_id: String,
    pub entity: String,
    pub entity_id: String,
    pub field: String,
    pub origin: String,
    pub old_value: Option<String>,
    pub new_value: Option<String>,
    pub ts: i64,
    pub undone: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccessEntry {
    pub id: i64,
    pub ts: i64,
    pub session: String,
    pub tool: String,
    pub meeting_ids: Vec<String>,
    pub result: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub meeting_id: String,
    pub title: String,
    pub kind: String,
    pub snippet: String,
}

/// A speaker to create during the final pass.
#[derive(Debug, Clone)]
pub struct NewSpeaker {
    pub label: String,
    pub track: String,
    pub name: Option<String>,
    pub name_source: Option<String>,
    pub suggestion: Option<String>,
    pub suggestion_score: Option<f64>,
}

/// A final turn. `speaker_label` refers to a `NewSpeaker` label.
#[derive(Debug, Clone)]
pub struct NewTurn {
    pub track: String,
    pub speaker_label: String,
    pub start: f64,
    pub end: f64,
    pub text: String,
}

pub struct Db {
    conn: Connection,
}

fn meeting_from_row(row: &Row) -> rusqlite::Result<Meeting> {
    Ok(Meeting {
        id: row.get("id")?,
        title: row.get("title")?,
        created_at: row.get("created_at")?,
        started_at: row.get("started_at")?,
        ended_at: row.get("ended_at")?,
        duration: row.get("duration")?,
        state: row.get("state")?,
        language: row.get("language")?,
        source: row.get("source")?,
        meeting_code: row.get("meeting_code")?,
        folder: row.get("folder")?,
        archived: row.get::<_, i64>("archived")? != 0,
        audio_until: row.get("audio_until")?,
        audio_deleted: row.get::<_, i64>("audio_deleted")? != 0,
        audio_trashed_at: row.get("audio_trashed_at")?,
        deleted_at: row.get("deleted_at")?,
        error: row.get("error")?,
        tags: Vec::new(),
    })
}

fn speaker_from_row(row: &Row) -> rusqlite::Result<Speaker> {
    Ok(Speaker {
        id: row.get("id")?,
        meeting_id: row.get("meeting_id")?,
        label: row.get("label")?,
        track: row.get("track")?,
        name: row.get("name")?,
        name_source: row.get("name_source")?,
        suggestion: row.get("suggestion")?,
        suggestion_score: row.get("suggestion_score")?,
        merged_into: row.get("merged_into")?,
    })
}

fn turn_from_row(row: &Row) -> rusqlite::Result<Turn> {
    Ok(Turn {
        id: row.get("id")?,
        meeting_id: row.get("meeting_id")?,
        track: row.get("track")?,
        speaker_id: row.get("speaker_id")?,
        start: row.get("start")?,
        end: row.get("end")?,
        text: row.get("text")?,
        provisional: row.get::<_, i64>("provisional")? != 0,
        live_name: row.get("live_name")?,
        name_changed: row.get::<_, i64>("name_changed")? != 0,
        edited: row.get::<_, i64>("edited")? != 0,
    })
}

impl Db {
    pub fn open(path: &Path, keys: &Keys) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path).with_context(|| format!("open {}", path.display()))?;
        Self::init(conn, keys)
    }

    pub fn open_in_memory(keys: &Keys) -> Result<Self> {
        Self::init(Connection::open_in_memory()?, keys)
    }

    fn init(conn: Connection, keys: &Keys) -> Result<Self> {
        conn.execute_batch(&format!("PRAGMA key = \"x'{}'\";", hex::encode(keys.database)))?;
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")
            .context("the database key does not match")?;
        conn.execute_batch(SCHEMA)?;
        let db = Self { conn };
        db.migrate()?;
        Ok(db)
    }

    /// Adds columns that later versions need to libraries that exist already.
    fn migrate(&self) -> Result<()> {
        let columns: Vec<String> = self
            .conn
            .prepare("SELECT name FROM pragma_table_info('meetings')")?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        if !columns.iter().any(|c| c == "external_id") {
            self.conn.execute_batch("ALTER TABLE meetings ADD COLUMN external_id TEXT;")?;
        }
        self.conn
            .execute_batch("CREATE UNIQUE INDEX IF NOT EXISTS meetings_external ON meetings (external_id);")?;
        Ok(())
    }

    pub fn external_exists(&self, external_id: &str) -> Result<bool> {
        let count: i64 =
            self.conn.query_row("SELECT COUNT(*) FROM meetings WHERE external_id = ?1", [external_id], |r| r.get(0))?;
        Ok(count > 0)
    }

    /// Inserts a meeting from another app in one transaction. Imported meetings have no audio.
    pub fn insert_imported(&mut self, m: &crate::granola::Imported) -> Result<()> {
        let id = uuid::Uuid::new_v4().to_string();
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO meetings (id, title, created_at, started_at, ended_at, state, source, folder, audio_deleted, external_id)
             VALUES (?1, ?2, ?3, ?3, ?3, 'ready', ?4, 'Granola', 1, ?5)",
            params![id, m.title, m.started_at, crate::granola::SOURCE, m.external_id],
        )?;
        tx.execute("INSERT INTO notes (meeting_id, content, updated_at) VALUES (?1, ?2, ?3)", params![id, m.notes, now_ms()])?;
        let mut tags = vec!["granola"];
        if m.shared {
            tags.push("shared-with-me");
        }
        for tag in tags {
            tx.execute("INSERT INTO tags (meeting_id, tag) VALUES (?1, ?2)", params![id, tag])?;
        }
        for p in &m.participants {
            tx.execute(
                "INSERT OR IGNORE INTO participants (meeting_id, participant_id, name, is_self) VALUES (?1, ?2, ?3, ?4)",
                params![id, p.participant_id, p.name, p.is_self as i64],
            )?;
        }
        let mut speaker_ids = std::collections::HashMap::new();
        for s in &m.speakers {
            let speaker_id = uuid::Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO speakers (id, meeting_id, label, track, name, name_source) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![speaker_id, id, s.label, s.track, s.name, s.name_source],
            )?;
            speaker_ids.insert(s.label.clone(), speaker_id);
        }
        for t in &m.turns {
            tx.execute(
                "INSERT INTO turns (meeting_id, track, speaker_id, start, end, text) VALUES (?1, ?2, ?3, 0, 0, ?4)",
                params![id, t.track, speaker_ids.get(&t.speaker_label), t.text],
            )?;
        }
        tx.commit()?;
        self.reindex(&id)
    }

    /// Writes all pending changes into the main database file, so the file can be copied.
    pub fn checkpoint(&self) -> Result<()> {
        self.conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
        Ok(())
    }

    // MARK: Settings

    pub fn setting(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0))
            .optional()?)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    /// The number of days that new meetings keep their audio: the `audio_retention_days` setting,
    /// or `DEFAULT_AUDIO_RETENTION_DAYS`.
    pub fn audio_retention_days(&self) -> Result<i64> {
        let stored = self.setting(AUDIO_RETENTION_SETTING)?.and_then(|v| v.parse::<i64>().ok());
        Ok(stored.filter(|d| (0..=MAX_AUDIO_RETENTION_DAYS).contains(d)).unwrap_or(DEFAULT_AUDIO_RETENTION_DAYS))
    }

    pub fn set_audio_retention_days(&self, days: i64) -> Result<()> {
        if !(0..=MAX_AUDIO_RETENTION_DAYS).contains(&days) {
            bail!("the retention period must be between 0 and {MAX_AUDIO_RETENTION_DAYS} days");
        }
        self.set_setting(AUDIO_RETENTION_SETTING, &days.to_string())
    }

    // MARK: Meetings

    pub fn create_meeting(&self, title: &str, source: Option<&str>) -> Result<Meeting> {
        let id = uuid::Uuid::new_v4().to_string();
        self.conn.execute(
            "INSERT INTO meetings (id, title, created_at, state, source) VALUES (?1, ?2, ?3, 'draft', ?4)",
            params![id, title, now_ms(), source],
        )?;
        self.conn.execute(
            "INSERT INTO notes (meeting_id, content, updated_at) VALUES (?1, '', ?2)",
            params![id, now_ms()],
        )?;
        self.reindex(&id)?;
        self.meeting(&id)
    }

    pub fn meeting(&self, id: &str) -> Result<Meeting> {
        let mut meeting = self
            .conn
            .query_row("SELECT * FROM meetings WHERE id = ?1", [id], meeting_from_row)
            .optional()?
            .ok_or_else(|| anyhow!("meeting not found: {id}"))?;
        meeting.tags = self.tags(id)?;
        Ok(meeting)
    }

    /// Returns meetings that are not in the trash, newest first.
    pub fn meetings(&self, include_archived: bool) -> Result<Vec<Meeting>> {
        let mut stmt = self.conn.prepare(
            "SELECT * FROM meetings WHERE deleted_at IS NULL AND (?1 OR archived = 0) ORDER BY created_at DESC",
        )?;
        let mut meetings: Vec<Meeting> =
            stmt.query_map([include_archived], meeting_from_row)?.collect::<rusqlite::Result<_>>()?;
        let mut tags: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
        let mut stmt = self.conn.prepare("SELECT meeting_id, tag FROM tags ORDER BY tag")?;
        for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (id, tag) = row?;
            tags.entry(id).or_default().push(tag);
        }
        for meeting in &mut meetings {
            meeting.tags = tags.remove(&meeting.id).unwrap_or_default();
        }
        Ok(meetings)
    }

    /// The first line of the summary and the names of the other people, for the latest `limit` meetings.
    /// Home shows these on its meeting cards.
    pub fn previews(&self, limit: usize) -> Result<HashMap<String, Preview>> {
        let mut stmt = self.conn.prepare(
            "SELECT m.id, s.content FROM meetings m LEFT JOIN summaries s ON s.meeting_id = m.id
             WHERE m.deleted_at IS NULL AND m.archived = 0 ORDER BY m.created_at DESC LIMIT ?1",
        )?;
        let mut previews: HashMap<String, Preview> = HashMap::new();
        for row in stmt.query_map([limit as i64], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)))? {
            let (id, summary) = row?;
            previews.insert(id, Preview { summary: summary.as_deref().and_then(summary_line), people: Vec::new() });
        }
        let mut stmt = self.conn.prepare(
            "SELECT meeting_id, name FROM participants WHERE is_self = 0
             UNION SELECT meeting_id, name FROM speakers WHERE name IS NOT NULL AND merged_into IS NULL AND track = 'remote'",
        )?;
        for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (id, name) = row?;
            if let Some(preview) = previews.get_mut(&id) {
                if !preview.people.contains(&name) {
                    preview.people.push(name);
                }
            }
        }
        Ok(previews)
    }

    pub fn trash(&self) -> Result<Vec<Meeting>> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM meetings WHERE deleted_at IS NOT NULL OR audio_trashed_at IS NOT NULL ORDER BY created_at DESC")?;
        let rows = stmt.query_map([], meeting_from_row)?;
        rows.map(|r| r.map_err(Into::into)).collect()
    }

    pub fn set_state(&self, id: &str, state: &str, error: Option<&str>) -> Result<()> {
        self.conn.execute(
            "UPDATE meetings SET state = ?2, error = ?3 WHERE id = ?1",
            params![id, state, error],
        )?;
        Ok(())
    }

    /// Records the start of the meeting clock. A meeting has one recording.
    pub fn mark_started(&self, id: &str, start_wall_ms: i64, meeting_code: Option<&str>) -> Result<()> {
        if self.start_wall_ms(id)?.is_some() {
            bail!("this meeting already has a recording");
        }
        self.conn.execute(
            "INSERT INTO recordings (meeting_id, start_wall_ms, offset_seconds) VALUES (?1, ?2, 0)",
            params![id, start_wall_ms],
        )?;
        self.conn.execute(
            "UPDATE meetings SET state = 'recording', started_at = COALESCE(started_at, ?2), meeting_code = COALESCE(?3, meeting_code) WHERE id = ?1",
            params![id, start_wall_ms, meeting_code],
        )?;
        Ok(())
    }

    /// The wall clock time of the start of the meeting clock.
    pub fn start_wall_ms(&self, id: &str) -> Result<Option<i64>> {
        Ok(self.conn.query_row(
            "SELECT MIN(start_wall_ms) FROM recordings WHERE meeting_id = ?1",
            [id],
            |r| r.get(0),
        )?)
    }

    /// Sets the state to processing. A meeting that has an end time keeps it.
    pub fn mark_stopped(&self, id: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE meetings SET state = 'processing', ended_at = COALESCE(ended_at, ?2) WHERE id = ?1",
            params![id, now_ms()],
        )?;
        Ok(())
    }

    /// Records a change, so the MCP screen can show it and undo it. The changes of one batch undo together.
    fn record(&self, batch: &str, origin: Origin, change: Change) -> Result<()> {
        let Change { meeting_id, entity, entity_id, field, old, new } = change;
        self.conn.execute(
            "INSERT INTO revisions (batch, meeting_id, entity, entity_id, field, origin, old_value, new_value, ts) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![batch, meeting_id, entity, entity_id, field, origin.as_str(), old, new, now_ms()],
        )?;
        Ok(())
    }

    fn new_batch() -> String {
        uuid::Uuid::new_v4().to_string()
    }

    pub fn set_title(&self, id: &str, title: &str, origin: Origin) -> Result<()> {
        let title = title.trim();
        if title.is_empty() {
            bail!("the title is empty");
        }
        let old = self.meeting(id)?.title;
        self.conn.execute("UPDATE meetings SET title = ?2 WHERE id = ?1", params![id, title])?;
        self.record(&Self::new_batch(), origin, Change::meeting(id, "title", Some(&old), Some(title)))?;
        self.reindex_kind(id, "title")
    }

    /// Moves a meeting to a folder. A name that matches an existing folder in another case uses the existing name,
    /// so "clients" and "Clients" are one folder.
    pub fn set_folder(&self, id: &str, folder: Option<&str>, origin: Origin) -> Result<()> {
        let folder = folder.map(str::trim).filter(|f| !f.is_empty());
        let folder = match folder {
            Some(name) => Some(self.existing_folder(name)?.unwrap_or_else(|| name.to_string())),
            None => None,
        };
        let old = self.meeting(id)?.folder;
        if old == folder {
            return Ok(());
        }
        self.conn.execute("UPDATE meetings SET folder = ?2 WHERE id = ?1", params![id, folder])?;
        self.record(&Self::new_batch(), origin, Change::meeting(id, "folder", old.as_deref(), folder.as_deref()))?;
        self.reindex_kind(id, "title")
    }

    fn existing_folder(&self, name: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row(
                "SELECT folder FROM meetings WHERE folder IS NOT NULL AND lower(folder) = lower(?1) LIMIT 1",
                [name],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// The meetings in a folder, in the trash too, so a restored meeting keeps the new name.
    fn folder_members(&self, folder: &str) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare("SELECT id FROM meetings WHERE folder = ?1")?;
        let rows = stmt.query_map([folder], |r| r.get(0))?;
        rows.map(|r| r.map_err(Into::into)).collect()
    }

    /// Renames a folder. A new name that is another folder merges the two folders. Returns the changed meetings.
    pub fn rename_folder(&self, folder: &str, name: &str) -> Result<Vec<String>> {
        let name = name.trim();
        if name.is_empty() {
            bail!("the folder name is empty");
        }
        let ids = self.folder_members(folder)?;
        // The rename can change only the case of the name, so the existing name is not the target.
        let target = match self.existing_folder(name)? {
            Some(existing) if existing != folder => existing,
            _ => name.to_string(),
        };
        let tx = self.conn.unchecked_transaction()?;
        for id in &ids {
            self.conn.execute("UPDATE meetings SET folder = ?2 WHERE id = ?1", params![id, target])?;
            self.record(&Self::new_batch(), Origin::User, Change::meeting(id, "folder", Some(folder), Some(&target)))?;
            self.reindex_kind(id, "title")?;
        }
        tx.commit()?;
        Ok(ids)
    }

    /// Removes a folder. Its meetings stay, without a folder. Returns the changed meetings.
    pub fn remove_folder(&self, folder: &str) -> Result<Vec<String>> {
        let ids = self.folder_members(folder)?;
        let tx = self.conn.unchecked_transaction()?;
        for id in &ids {
            self.set_folder(id, None, Origin::User)?;
        }
        tx.commit()?;
        Ok(ids)
    }

    pub fn set_archived(&self, id: &str, archived: bool) -> Result<()> {
        self.conn.execute("UPDATE meetings SET archived = ?2 WHERE id = ?1", params![id, archived as i64])?;
        Ok(())
    }

    pub fn tags(&self, id: &str) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare("SELECT tag FROM tags WHERE meeting_id = ?1 ORDER BY tag")?;
        let rows = stmt.query_map([id], |r| r.get(0))?;
        rows.map(|r| r.map_err(Into::into)).collect()
    }

    pub fn set_tags(&self, id: &str, tags: &[String], origin: Origin) -> Result<()> {
        let old = serde_json::to_string(&self.tags(id)?)?;
        let mut clean: Vec<String> = tags
            .iter()
            .map(|t| t.trim().trim_start_matches('#').to_lowercase())
            .filter(|t| !t.is_empty())
            .collect();
        clean.sort();
        clean.dedup();
        let tx = self.conn.unchecked_transaction()?;
        self.conn.execute("DELETE FROM tags WHERE meeting_id = ?1", [id])?;
        for tag in &clean {
            self.conn.execute("INSERT INTO tags (meeting_id, tag) VALUES (?1, ?2)", params![id, tag])?;
        }
        let new = serde_json::to_string(&clean)?;
        self.record(&Self::new_batch(), origin, Change::meeting(id, "tags", Some(&old), Some(&new)))?;
        self.reindex_kind(id, "title")?;
        tx.commit()?;
        Ok(())
    }

    pub fn folders(&self) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT DISTINCT folder FROM meetings WHERE folder IS NOT NULL AND deleted_at IS NULL ORDER BY folder",
        )?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        rows.map(|r| r.map_err(Into::into)).collect()
    }

    // MARK: Notes

    pub fn notes(&self, id: &str) -> Result<String> {
        Ok(self
            .conn
            .query_row("SELECT content FROM notes WHERE meeting_id = ?1", [id], |r| r.get(0))
            .optional()?
            .unwrap_or_default())
    }

    /// Saves notes. The app autosaves often, so user saves do not create revisions.
    /// MCP saves create a revision that the user can undo.
    pub fn set_notes(&self, id: &str, content: &str, origin: Origin) -> Result<()> {
        let old = self.notes(id)?;
        self.conn.execute(
            "INSERT INTO notes (meeting_id, content, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(meeting_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at",
            params![id, content, now_ms()],
        )?;
        if origin == Origin::Mcp {
            self.record(&Self::new_batch(), origin, Change::whole(id, "notes", Some(&old), Some(content)))?;
        }
        self.reindex_kind(id, "notes")
    }

    // MARK: Summaries

    /// The summary of a meeting. A local model writes it, and MCP clients can change it.
    pub fn summary(&self, id: &str) -> Result<Option<Summary>> {
        Ok(self
            .conn
            .query_row("SELECT content, model, created_at FROM summaries WHERE meeting_id = ?1", [id], |r| {
                Ok(Summary { content: r.get(0)?, written_by: r.get(1)?, updated_at: r.get(2)? })
            })
            .optional()?)
    }

    /// `written_by` names the local model, or `MCP_AUTHOR` for a change through MCP.
    /// MCP changes create a revision that the user can undo.
    pub fn set_summary(&self, id: &str, content: &str, written_by: &str, origin: Origin) -> Result<()> {
        let old = self.summary(id)?;
        self.conn.execute(
            "INSERT INTO summaries (meeting_id, content, model, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(meeting_id) DO UPDATE SET content = excluded.content, model = excluded.model, created_at = excluded.created_at",
            params![id, content, written_by, now_ms()],
        )?;
        if origin == Origin::Mcp {
            let old = old.map(|s| serde_json::to_string(&s)).transpose()?;
            self.record(&Self::new_batch(), origin, Change::whole(id, "summary", old.as_deref(), Some(content)))?;
        }
        self.reindex_kind(id, "summary")
    }

    pub fn delete_summary(&self, id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM summaries WHERE meeting_id = ?1", [id])?;
        self.reindex_kind(id, "summary")
    }

    // MARK: Participants and speaker events

    pub fn upsert_participants(&self, id: &str, participants: &[Participant]) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        for p in participants {
            self.conn.execute(
                "INSERT INTO participants (meeting_id, participant_id, name, is_self) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(meeting_id, participant_id) DO UPDATE SET name = excluded.name, is_self = excluded.is_self",
                params![id, p.participant_id, p.name, p.is_self as i64],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn participants(&self, id: &str) -> Result<Vec<Participant>> {
        let mut stmt = self
            .conn
            .prepare("SELECT participant_id, name, is_self FROM participants WHERE meeting_id = ?1 ORDER BY name")?;
        let rows = stmt.query_map([id], |r| {
            Ok(Participant {
                participant_id: r.get(0)?,
                name: r.get(1)?,
                is_self: r.get::<_, i64>(2)? != 0,
            })
        })?;
        rows.map(|r| r.map_err(Into::into)).collect()
    }

    pub fn add_speaker_event(&self, id: &str, t_ms: i64, speaking: &[String]) -> Result<()> {
        self.conn.execute(
            "INSERT INTO speaker_events (meeting_id, t_ms, speaking) VALUES (?1, ?2, ?3)",
            params![id, t_ms, serde_json::to_string(speaking)?],
        )?;
        Ok(())
    }

    pub fn speaker_events(&self, id: &str) -> Result<Vec<(i64, Vec<String>)>> {
        self.speaker_events_between(id, i64::MIN, i64::MAX)
    }

    /// The speaker events of a meeting from `from_ms` to `to_ms`, both included.
    pub fn speaker_events_between(&self, id: &str, from_ms: i64, to_ms: i64) -> Result<Vec<(i64, Vec<String>)>> {
        let mut stmt = self.conn.prepare(
            "SELECT t_ms, speaking FROM speaker_events WHERE meeting_id = ?1 AND t_ms BETWEEN ?2 AND ?3 ORDER BY t_ms",
        )?;
        let rows = stmt.query_map(params![id, from_ms, to_ms], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
        let mut events = Vec::new();
        for row in rows {
            let (t, speaking) = row?;
            events.push((t, serde_json::from_str(&speaking).unwrap_or_default()));
        }
        Ok(events)
    }

    // MARK: Turns and speakers

    pub fn add_live_turn(
        &self,
        id: &str,
        track: &str,
        start: f64,
        end: f64,
        text: &str,
        live_name: Option<&str>,
    ) -> Result<Turn> {
        self.conn.execute(
            "INSERT INTO turns (meeting_id, track, start, end, text, provisional, live_name) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)",
            params![id, track, start, end, text, live_name],
        )?;
        let turn_id = self.conn.last_insert_rowid();
        self.turn(turn_id)
    }

    pub fn turn(&self, turn_id: i64) -> Result<Turn> {
        Ok(self.conn.query_row("SELECT * FROM turns WHERE id = ?1", [turn_id], turn_from_row)?)
    }

    pub fn turns(&self, id: &str) -> Result<Vec<Turn>> {
        let mut stmt = self.conn.prepare("SELECT * FROM turns WHERE meeting_id = ?1 ORDER BY start, id")?;
        let rows = stmt.query_map([id], turn_from_row)?;
        rows.map(|r| r.map_err(Into::into)).collect()
    }

    pub fn has_edits(&self, id: &str) -> Result<bool> {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM turns WHERE meeting_id = ?1 AND edited = 1",
            [id],
            |r| r.get(0),
        )?;
        Ok(count > 0)
    }

    pub fn speakers(&self, id: &str) -> Result<Vec<Speaker>> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM speakers WHERE meeting_id = ?1 AND merged_into IS NULL ORDER BY track, label")?;
        let rows = stmt.query_map([id], speaker_from_row)?;
        rows.map(|r| r.map_err(Into::into)).collect()
    }

    /// All speakers, including speakers merged into another speaker.
    pub fn all_speakers(&self, id: &str) -> Result<Vec<Speaker>> {
        let mut stmt = self.conn.prepare("SELECT * FROM speakers WHERE meeting_id = ?1 ORDER BY track, label")?;
        let rows = stmt.query_map([id], speaker_from_row)?;
        rows.map(|r| r.map_err(Into::into)).collect()
    }

    pub fn speaker(&self, speaker_id: &str) -> Result<Speaker> {
        self.conn
            .query_row("SELECT * FROM speakers WHERE id = ?1", [speaker_id], speaker_from_row)
            .optional()?
            .ok_or_else(|| anyhow!("speaker not found: {speaker_id}"))
    }

    /// Replaces live turns with the final pass result. It keeps each live name for comparison.
    pub fn replace_with_final(
        &mut self,
        id: &str,
        speakers: &[NewSpeaker],
        turns: &[NewTurn],
        duration: f64,
        language: Option<&str>,
    ) -> Result<()> {
        if self.has_edits(id)? {
            bail!("the transcript has edits. Processing again does not overwrite them.");
        }
        let live = self.turns(id)?;
        let audio_until = now_ms() + self.audio_retention_days()? * DAY_MS;
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM turns WHERE meeting_id = ?1", [id])?;
        tx.execute("DELETE FROM speakers WHERE meeting_id = ?1", [id])?;
        let mut ids = std::collections::HashMap::new();
        for s in speakers {
            let speaker_id = uuid::Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO speakers (id, meeting_id, label, track, name, name_source, suggestion, suggestion_score) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![speaker_id, id, s.label, s.track, s.name, s.name_source, s.suggestion, s.suggestion_score],
            )?;
            ids.insert(s.label.clone(), (speaker_id, s.name.clone()));
        }
        for t in turns {
            let (speaker_id, final_name) = ids
                .get(&t.speaker_label)
                .cloned()
                .ok_or_else(|| anyhow!("unknown speaker label {}", t.speaker_label))?;
            let live_name = live
                .iter()
                .filter(|l| l.track == t.track && l.start < t.end && l.end > t.start)
                .max_by(|a, b| {
                    let oa = a.end.min(t.end) - a.start.max(t.start);
                    let ob = b.end.min(t.end) - b.start.max(t.start);
                    oa.total_cmp(&ob)
                })
                .and_then(|l| l.live_name.clone());
            let changed = live_name.is_some() && live_name != final_name;
            tx.execute(
                "INSERT INTO turns (meeting_id, track, speaker_id, start, end, text, provisional, live_name, name_changed) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8)",
                params![id, t.track, speaker_id, t.start, t.end, t.text, live_name, changed as i64],
            )?;
        }
        let updated = tx.execute(
            "UPDATE meetings SET state = 'ready', error = NULL, duration = ?2, language = COALESCE(?3, language), audio_until = COALESCE(audio_until, ?4) WHERE id = ?1",
            params![id, duration, language, audio_until],
        )?;
        if updated == 0 {
            bail!("meeting not found: {id}");
        }
        tx.commit()?;
        self.reindex(id)
    }

    pub fn rename_speaker(&self, speaker_id: &str, name: Option<&str>, origin: Origin) -> Result<()> {
        let speaker = self.speaker(speaker_id)?;
        let name = name.map(str::trim).filter(|n| !n.is_empty());
        let source = name.map(|_| "user");
        self.conn.execute(
            "UPDATE speakers SET name = ?2, name_source = ?3 WHERE id = ?1",
            params![speaker_id, name, source],
        )?;
        let old = json!({"name": speaker.name, "name_source": speaker.name_source}).to_string();
        let new = json!({"name": name, "name_source": source}).to_string();
        self.record(
            &Self::new_batch(),
            origin,
            Change { meeting_id: &speaker.meeting_id, entity: "speaker", entity_id: speaker_id, field: "name", old: Some(&old), new: Some(&new) },
        )?;
        self.reindex_kind(&speaker.meeting_id, "speakers")
    }

    /// Moves all turns of `from` to `into` and hides `from`.
    pub fn merge_speakers(&self, from: &str, into: &str, origin: Origin) -> Result<()> {
        let a = self.speaker(from)?;
        let b = self.speaker(into)?;
        if a.meeting_id != b.meeting_id || from == into {
            bail!("the speakers must be different speakers of the same meeting");
        }
        if b.merged_into.is_some() {
            bail!("the target speaker is merged into another speaker");
        }
        let batch = Self::new_batch();
        let tx = self.conn.unchecked_transaction()?;
        let mut stmt = self.conn.prepare("SELECT id FROM turns WHERE speaker_id = ?1")?;
        let turn_ids: Vec<i64> = stmt.query_map([from], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        drop(stmt);
        for turn_id in turn_ids {
            self.conn.execute("UPDATE turns SET speaker_id = ?2 WHERE id = ?1", params![turn_id, into])?;
            let turn = turn_id.to_string();
            self.record(
                &batch,
                origin,
                Change { meeting_id: &a.meeting_id, entity: "turn", entity_id: &turn, field: "speaker_id", old: Some(from), new: Some(into) },
            )?;
        }
        self.conn.execute("UPDATE speakers SET merged_into = ?2 WHERE id = ?1", params![from, into])?;
        self.record(
            &batch,
            origin,
            Change { meeting_id: &a.meeting_id, entity: "speaker", entity_id: from, field: "merged_into", old: None, new: Some(into) },
        )?;
        self.reindex_kind(&a.meeting_id, "speakers")?;
        tx.commit()?;
        Ok(())
    }

    /// Assigns one turn to another speaker, or to a new speaker when `speaker_id` is None.
    pub fn reassign_turn(&self, turn_id: i64, speaker_id: Option<&str>, origin: Origin) -> Result<String> {
        let turn = self.turn(turn_id)?;
        let target = match speaker_id {
            Some(s) => {
                let speaker = self.speaker(s)?;
                if speaker.meeting_id != turn.meeting_id {
                    bail!("the speaker belongs to another meeting");
                }
                s.to_string()
            }
            None => {
                let count: i64 = self.conn.query_row(
                    "SELECT COUNT(*) FROM speakers WHERE meeting_id = ?1",
                    [&turn.meeting_id],
                    |r| r.get(0),
                )?;
                let new_id = uuid::Uuid::new_v4().to_string();
                self.conn.execute(
                    "INSERT INTO speakers (id, meeting_id, label, track) VALUES (?1, ?2, ?3, ?4)",
                    params![new_id, turn.meeting_id, format!("Speaker {}", count + 1), turn.track],
                )?;
                new_id
            }
        };
        self.conn.execute("UPDATE turns SET speaker_id = ?2 WHERE id = ?1", params![turn_id, target])?;
        let entity_id = turn_id.to_string();
        self.record(
            &Self::new_batch(),
            origin,
            Change {
                meeting_id: &turn.meeting_id,
                entity: "turn",
                entity_id: &entity_id,
                field: "speaker_id",
                old: turn.speaker_id.as_deref(),
                new: Some(&target),
            },
        )?;
        self.reindex(&turn.meeting_id)?;
        Ok(target)
    }

    pub fn edit_turn_text(&self, turn_id: i64, text: &str, origin: Origin) -> Result<()> {
        let turn = self.turn(turn_id)?;
        if turn.provisional {
            bail!("you can edit the transcript after processing");
        }
        self.conn.execute("UPDATE turns SET text = ?2, edited = 1 WHERE id = ?1", params![turn_id, text])?;
        let entity_id = turn_id.to_string();
        self.record(
            &Self::new_batch(),
            origin,
            Change { meeting_id: &turn.meeting_id, entity: "turn", entity_id: &entity_id, field: "text", old: Some(&turn.text), new: Some(text) },
        )?;
        self.reindex_kind(&turn.meeting_id, "transcript")
    }

    // MARK: Revisions

    pub fn revisions(&self, origin: Option<Origin>, limit: i64) -> Result<Vec<Revision>> {
        let mut stmt = self.conn.prepare(
            "SELECT * FROM revisions WHERE (?1 IS NULL OR origin = ?1) ORDER BY id DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![origin.map(Origin::as_str), limit], |r| {
            Ok(Revision {
                id: r.get("id")?,
                batch: r.get("batch")?,
                meeting_id: r.get("meeting_id")?,
                entity: r.get("entity")?,
                entity_id: r.get("entity_id")?,
                field: r.get("field")?,
                origin: r.get("origin")?,
                old_value: r.get("old_value")?,
                new_value: r.get("new_value")?,
                ts: r.get("ts")?,
                undone: r.get::<_, i64>("undone")? != 0,
            })
        })?;
        rows.map(|r| r.map_err(Into::into)).collect()
    }

    /// Restores the old values of every change in the batch of `revision_id`.
    pub fn undo(&self, revision_id: i64) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        let batch: String = self
            .conn
            .query_row("SELECT batch FROM revisions WHERE id = ?1", [revision_id], |r| r.get(0))?;
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM revisions WHERE batch = ?1 AND undone = 0 ORDER BY id DESC")?;
        let rows: Vec<(i64, String, String, String, String, Option<String>)> = stmt
            .query_map([&batch], |r| {
                Ok((
                    r.get("id")?,
                    r.get("meeting_id")?,
                    r.get("entity")?,
                    r.get("entity_id")?,
                    r.get("field")?,
                    r.get("old_value")?,
                ))
            })?
            .collect::<rusqlite::Result<_>>()?;
        drop(stmt);
        let mut meetings = std::collections::BTreeSet::new();
        for (rev_id, meeting_id, entity, entity_id, field, old) in rows {
            match (entity.as_str(), field.as_str()) {
                ("meeting", "title") => {
                    self.conn.execute("UPDATE meetings SET title = ?2 WHERE id = ?1", params![entity_id, old])?;
                }
                ("meeting", "folder") => {
                    self.conn.execute("UPDATE meetings SET folder = ?2 WHERE id = ?1", params![entity_id, old])?;
                }
                ("meeting", "tags") => {
                    let tags: Vec<String> = serde_json::from_str(old.as_deref().unwrap_or("[]"))?;
                    self.conn.execute("DELETE FROM tags WHERE meeting_id = ?1", [&entity_id])?;
                    for tag in tags {
                        self.conn
                            .execute("INSERT INTO tags (meeting_id, tag) VALUES (?1, ?2)", params![entity_id, tag])?;
                    }
                }
                ("meeting", "audio_until") => {
                    let value: Option<i64> = old.as_deref().and_then(|v| v.parse().ok());
                    self.conn.execute("UPDATE meetings SET audio_until = ?2 WHERE id = ?1", params![entity_id, value])?;
                }
                ("meeting", "deleted_at") => {
                    self.conn.execute("UPDATE meetings SET deleted_at = NULL WHERE id = ?1", [&entity_id])?;
                }
                ("meeting", "audio_trashed_at") => {
                    self.conn.execute("UPDATE meetings SET audio_trashed_at = NULL WHERE id = ?1", [&entity_id])?;
                }
                ("summary", "content") => match old.as_deref().map(serde_json::from_str::<Summary>).transpose()? {
                    Some(s) => {
                        self.conn.execute(
                            "UPDATE summaries SET content = ?2, model = ?3, created_at = ?4 WHERE meeting_id = ?1",
                            params![entity_id, s.content, s.written_by, s.updated_at],
                        )?;
                    }
                    None => {
                        self.conn.execute("DELETE FROM summaries WHERE meeting_id = ?1", [&entity_id])?;
                    }
                },
                ("notes", "content") => {
                    self.conn.execute(
                        "UPDATE notes SET content = ?2, updated_at = ?3 WHERE meeting_id = ?1",
                        params![entity_id, old.unwrap_or_default(), now_ms()],
                    )?;
                }
                ("speaker", "name") => {
                    let value: Value = serde_json::from_str(old.as_deref().unwrap_or("{}"))?;
                    self.conn.execute(
                        "UPDATE speakers SET name = ?2, name_source = ?3 WHERE id = ?1",
                        params![entity_id, value["name"].as_str(), value["name_source"].as_str()],
                    )?;
                }
                ("speaker", "merged_into") => {
                    self.conn.execute("UPDATE speakers SET merged_into = NULL WHERE id = ?1", [&entity_id])?;
                }
                ("turn", "speaker_id") => {
                    self.conn.execute("UPDATE turns SET speaker_id = ?2 WHERE id = ?1", params![entity_id, old])?;
                }
                ("turn", "text") => {
                    self.conn.execute(
                        "UPDATE turns SET text = ?2 WHERE id = ?1",
                        params![entity_id, old.unwrap_or_default()],
                    )?;
                }
                _ => bail!("cannot undo {entity}.{field}"),
            }
            self.conn.execute("UPDATE revisions SET undone = 1 WHERE id = ?1", [rev_id])?;
            meetings.insert(meeting_id);
        }
        for meeting_id in &meetings {
            self.reindex(meeting_id)?;
        }
        tx.commit()?;
        Ok(())
    }

    // MARK: Deletion, trash, and retention

    /// Permanent deletion: the caller removes the files. The database rows go at once.
    pub fn delete_meeting_now(&self, id: &str) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        for table in ["notes", "summaries", "tags", "speakers", "turns", "participants", "speaker_events", "recordings", "revisions"] {
            self.conn.execute(&format!("DELETE FROM {table} WHERE meeting_id = ?1"), [id])?;
        }
        self.conn.execute("DELETE FROM search WHERE meeting_id = ?1", [id])?;
        self.conn.execute("DELETE FROM meetings WHERE id = ?1", [id])?;
        tx.commit()?;
        Ok(())
    }

    /// The meeting goes to the trash for `TRASH_DAYS`.
    pub fn trash_meeting(&self, id: &str, origin: Origin) -> Result<()> {
        self.meeting(id)?;
        let now = now_ms();
        self.conn.execute("UPDATE meetings SET deleted_at = ?2 WHERE id = ?1", params![id, now])?;
        self.record(&Self::new_batch(), origin, Change::meeting(id, "deleted_at", None, Some(&now.to_string())))?;
        self.conn.execute("DELETE FROM search WHERE meeting_id = ?1", [id])?;
        Ok(())
    }

    pub fn trash_audio(&self, id: &str, origin: Origin) -> Result<()> {
        let meeting = self.meeting(id)?;
        if meeting.audio_deleted {
            bail!("the meeting has no audio");
        }
        let now = now_ms();
        self.conn.execute("UPDATE meetings SET audio_trashed_at = ?2 WHERE id = ?1", params![id, now])?;
        self.record(&Self::new_batch(), origin, Change::meeting(id, "audio_trashed_at", None, Some(&now.to_string())))
    }

    pub fn restore(&self, id: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE meetings SET deleted_at = NULL, audio_trashed_at = NULL WHERE id = ?1",
            [id],
        )?;
        self.reindex(id)
    }

    pub fn mark_audio_deleted(&self, id: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE meetings SET audio_deleted = 1, audio_until = NULL, audio_trashed_at = NULL WHERE id = ?1",
            [id],
        )?;
        Ok(())
    }

    /// Sets the audio deadline to `days` after the final pass, at most `MAX_AUDIO_RETENTION_DAYS`.
    pub fn set_audio_retention(&self, id: &str, days: i64, origin: Origin) -> Result<i64> {
        let meeting = self.meeting(id)?;
        if meeting.audio_deleted {
            bail!("the meeting has no audio");
        }
        if !(0..=MAX_AUDIO_RETENTION_DAYS).contains(&days) {
            bail!("the retention period must be between 0 and {MAX_AUDIO_RETENTION_DAYS} days");
        }
        let base = meeting.ended_at.unwrap_or(meeting.created_at);
        let until = base + days * DAY_MS;
        self.conn.execute("UPDATE meetings SET audio_until = ?2 WHERE id = ?1", params![id, until])?;
        let old = meeting.audio_until.map(|v| v.to_string());
        let new = until.to_string();
        self.record(&Self::new_batch(), origin, Change::meeting(id, "audio_until", old.as_deref(), Some(&new)))?;
        Ok(until)
    }

    /// Meetings whose audio must go now: expired audio, audio in the trash for 7 days,
    /// and unfinished meetings older than the default period. A failed meeting keeps its audio for a new final pass.
    pub fn expired_audio(&self, now: i64) -> Result<Vec<String>> {
        let default_days = self.audio_retention_days()?;
        let mut stmt = self.conn.prepare(
            "SELECT id FROM meetings WHERE audio_deleted = 0 AND state NOT IN ('recording', 'processing') AND (
                (audio_until IS NOT NULL AND audio_until <= ?1)
                OR (audio_trashed_at IS NOT NULL AND audio_trashed_at <= ?2)
                OR (audio_until IS NULL AND state <> 'failed' AND created_at <= ?3))",
        )?;
        let rows = stmt.query_map(
            params![now, now - TRASH_DAYS * DAY_MS, now - default_days * DAY_MS],
            |r| r.get(0),
        )?;
        rows.map(|r| r.map_err(Into::into)).collect()
    }

    pub fn expired_trash(&self, now: i64) -> Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id FROM meetings WHERE deleted_at IS NOT NULL AND deleted_at <= ?1")?;
        let rows = stmt.query_map([now - TRASH_DAYS * DAY_MS], |r| r.get(0))?;
        rows.map(|r| r.map_err(Into::into)).collect()
    }

    // MARK: Access log

    pub fn log_access(&self, session: &str, tool: &str, meeting_ids: &[String], result: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO access_log (ts, session, tool, meeting_ids, result) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![now_ms(), session, tool, serde_json::to_string(meeting_ids)?, result],
        )?;
        Ok(())
    }

    pub fn access_log(&self, limit: i64) -> Result<Vec<AccessEntry>> {
        let mut stmt = self.conn.prepare("SELECT * FROM access_log ORDER BY id DESC LIMIT ?1")?;
        let rows = stmt.query_map([limit], |r| {
            Ok(AccessEntry {
                id: r.get("id")?,
                ts: r.get("ts")?,
                session: r.get("session")?,
                tool: r.get("tool")?,
                meeting_ids: serde_json::from_str(&r.get::<_, String>("meeting_ids")?).unwrap_or_default(),
                result: r.get("result")?,
            })
        })?;
        rows.map(|r| r.map_err(Into::into)).collect()
    }

    // MARK: Search

    /// Rebuilds the search entries of one meeting: title and tags, notes, summary, speaker names, and transcript.
    pub fn reindex(&self, id: &str) -> Result<()> {
        SEARCH_KINDS.iter().try_for_each(|kind| self.reindex_kind(id, kind))
    }

    /// Rebuilds one kind of search entry of a meeting. A meeting in the trash has no search entries.
    fn reindex_kind(&self, id: &str, kind: &str) -> Result<()> {
        self.conn.execute("DELETE FROM search WHERE meeting_id = ?1 AND kind = ?2", params![id, kind])?;
        let Some((title, folder, deleted_at)) = self
            .conn
            .query_row("SELECT title, folder, deleted_at FROM meetings WHERE id = ?1", [id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Option<i64>>(2)?))
            })
            .optional()?
        else {
            return Ok(());
        };
        if deleted_at.is_some() {
            return Ok(());
        }
        let body = match kind {
            "title" => Some(format!("{} {} {}", title, folder.unwrap_or_default(), self.tags(id)?.join(" "))),
            "notes" => Some(self.notes(id)?),
            "summary" => self.summary(id)?.map(|s| s.content),
            "speakers" => Some(self.speakers(id)?.into_iter().filter_map(|s| s.name).collect::<Vec<_>>().join(" ")),
            "transcript" => Some(self.turns(id)?.into_iter().map(|t| t.text).collect::<Vec<_>>().join("\n")),
            other => bail!("unknown search kind {other}"),
        };
        if let Some(body) = body {
            self.conn.execute("INSERT INTO search (meeting_id, kind, body) VALUES (?1, ?2, ?3)", params![id, kind, body])?;
        }
        Ok(())
    }

    pub fn search(&self, query: &str, limit: i64) -> Result<Vec<SearchHit>> {
        let terms: Vec<String> = query
            .split_whitespace()
            .map(|t| t.chars().filter(|c| c.is_alphanumeric()).collect::<String>())
            .filter(|t| !t.is_empty())
            .map(|t| format!("\"{t}\"*"))
            .collect();
        if terms.is_empty() {
            return Ok(Vec::new());
        }
        let mut stmt = self.conn.prepare(
            "SELECT s.meeting_id, m.title, s.kind, snippet(search, 2, '[', ']', ' … ', 12)
             FROM search s JOIN meetings m ON m.id = s.meeting_id
             WHERE search MATCH ?1 AND m.deleted_at IS NULL ORDER BY rank LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![terms.join(" "), limit], |r| {
            Ok(SearchHit { meeting_id: r.get(0)?, title: r.get(1)?, kind: r.get(2)?, snippet: r.get(3)? })
        })?;
        rows.map(|r| r.map_err(Into::into)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::Keys;

    #[test]
    fn tags_and_folders_are_clean_and_searchable() {
        let db = Db::open_in_memory(&Keys::for_tests()).unwrap();
        let a = db.create_meeting("Audit kickoff", None).unwrap();
        let b = db.create_meeting("Weekly sync", None).unwrap();
        db.set_tags(&a.id, &["Audit".into(), " #audit ".into(), "Q3".into(), "".into()], Origin::User).unwrap();
        assert_eq!(db.tags(&a.id).unwrap(), vec!["audit", "q3"]);
        db.set_folder(&a.id, Some("  Clients "), Origin::User).unwrap();
        db.set_folder(&b.id, Some("   "), Origin::User).unwrap();
        assert_eq!(db.meeting(&a.id).unwrap().folder.as_deref(), Some("Clients"));
        assert_eq!(db.meeting(&b.id).unwrap().folder, None);
        assert_eq!(db.folders().unwrap(), vec!["Clients"]);
        let listed = db.meetings(false).unwrap();
        assert_eq!(listed.iter().find(|m| m.id == a.id).unwrap().tags, vec!["audit", "q3"]);
        assert!(db.search("q3", 10).unwrap().iter().any(|h| h.meeting_id == a.id));
        db.trash_meeting(&a.id, Origin::User).unwrap();
        assert!(db.folders().unwrap().is_empty());
        db.restore(&a.id).unwrap();
        assert!(db.search("clients", 10).unwrap().iter().any(|h| h.meeting_id == a.id));
        db.set_folder(&b.id, Some("clients"), Origin::User).unwrap();
        assert_eq!(db.meeting(&b.id).unwrap().folder.as_deref(), Some("Clients"));
        assert_eq!(db.rename_folder("Clients", "Customers").unwrap().len(), 2);
        assert_eq!(db.folders().unwrap(), vec!["Customers"]);
        db.set_folder(&a.id, Some("Partners"), Origin::User).unwrap();
        db.rename_folder("Partners", "customers").unwrap();
        assert_eq!(db.folders().unwrap(), vec!["Customers"]);
        db.rename_folder("Customers", "customers").unwrap();
        assert_eq!(db.folders().unwrap(), vec!["customers"]);
        assert_eq!(db.remove_folder("customers").unwrap().len(), 2);
        assert!(db.folders().unwrap().is_empty());
        assert_eq!(db.meetings(false).unwrap().len(), 2);
    }

    #[test]
    fn user_deletion_goes_to_trash_and_expires() {
        let db = Db::open_in_memory(&Keys::for_tests()).unwrap();
        let m = db.create_meeting("Weekly sync", None).unwrap();
        db.trash_meeting(&m.id, Origin::User).unwrap();
        assert!(db.meetings(true).unwrap().is_empty());
        assert_eq!(db.trash().unwrap().len(), 1);
        let now = now_ms();
        assert!(db.expired_trash(now).unwrap().is_empty());
        assert_eq!(db.expired_trash(now + TRASH_DAYS * DAY_MS).unwrap(), vec![m.id.clone()]);
        db.restore(&m.id).unwrap();
        assert_eq!(db.meetings(true).unwrap().len(), 1);
    }

    #[test]
    fn retention_keeps_the_audio_of_failed_and_unfinished_meetings() {
        let db = Db::open_in_memory(&Keys::for_tests()).unwrap();
        let old = now_ms() - (DEFAULT_AUDIO_RETENTION_DAYS + 1) * DAY_MS;
        let mut ids = Vec::new();
        for state in ["ready", "failed", "processing", "recording"] {
            let m = db.create_meeting(state, None).unwrap();
            db.conn
                .execute("UPDATE meetings SET state = ?2, created_at = ?3 WHERE id = ?1", params![m.id, state, old])
                .unwrap();
            ids.push(m.id);
        }
        assert_eq!(db.expired_audio(now_ms()).unwrap(), vec![ids[0].clone()]);
    }

    #[test]
    fn mark_stopped_keeps_the_end_time() {
        let db = Db::open_in_memory(&Keys::for_tests()).unwrap();
        let m = db.create_meeting("Weekly sync", None).unwrap();
        db.mark_stopped(&m.id).unwrap();
        db.conn.execute("UPDATE meetings SET ended_at = 1000 WHERE id = ?1", [&m.id]).unwrap();
        db.mark_stopped(&m.id).unwrap();
        let meeting = db.meeting(&m.id).unwrap();
        assert_eq!((meeting.state.as_str(), meeting.ended_at), ("processing", Some(1000)));
    }

    #[test]
    fn merge_refuses_a_merged_target() {
        let db = Db::open_in_memory(&Keys::for_tests()).unwrap();
        let m = db.create_meeting("Weekly sync", None).unwrap();
        for id in ["a", "b", "c"] {
            db.conn
                .execute(
                    "INSERT INTO speakers (id, meeting_id, label, track) VALUES (?1, ?2, ?1, 'remote')",
                    params![id, m.id],
                )
                .unwrap();
        }
        db.merge_speakers("a", "b", Origin::User).unwrap();
        assert!(db.merge_speakers("c", "a", Origin::User).is_err());
        assert!(db.speaker("c").unwrap().merged_into.is_none());
        db.merge_speakers("c", "b", Origin::User).unwrap();
    }

    #[test]
    fn audio_retention_default_follows_the_setting() {
        let db = Db::open_in_memory(&Keys::for_tests()).unwrap();
        assert_eq!(db.audio_retention_days().unwrap(), DEFAULT_AUDIO_RETENTION_DAYS);
        db.set_audio_retention_days(14).unwrap();
        assert_eq!(db.audio_retention_days().unwrap(), 14);
        assert!(db.set_audio_retention_days(MAX_AUDIO_RETENTION_DAYS + 1).is_err());
        assert_eq!(db.audio_retention_days().unwrap(), 14);
    }
}
