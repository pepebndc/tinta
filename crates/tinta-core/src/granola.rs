//! Imports a Granola export folder: `manifest.json` plus one folder per meeting with
//! `meta.json`, `notes.md`, `transcript.md`, `summary.md`, and `raw-transcript.json`.
//!
//! Granola transcripts have no timestamps. Each line starts with an audio source label:
//! `Microphone`, `System audio`, or `System audio (Name)`.

use crate::db::{Db, NewSpeaker, NewTurn, Participant};
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const SOURCE: &str = "granola";
const PLACEHOLDER_NOTES: &str = "_No private notes._";

#[derive(Debug, Clone, Deserialize)]
struct ManifestEntry {
    id: String,
    title: String,
    #[serde(default)]
    captured_by_me: bool,
    folder: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Preview {
    pub path: PathBuf,
    pub total: usize,
    pub mine: usize,
    pub shared: usize,
    pub already_imported: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct Failure {
    pub title: String,
    pub error: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Summary {
    pub imported: usize,
    pub skipped: usize,
    pub failed: Vec<Failure>,
}

/// One parsed meeting, ready for the database.
#[derive(Debug, Clone)]
pub struct Imported {
    pub external_id: String,
    pub title: String,
    pub started_at: i64,
    pub shared: bool,
    pub notes: String,
    pub participants: Vec<Participant>,
    pub speakers: Vec<NewSpeaker>,
    pub turns: Vec<NewTurn>,
}

fn manifest(dir: &Path) -> Result<Vec<ManifestEntry>> {
    let path = dir.join("manifest.json");
    let text = std::fs::read_to_string(&path)
        .with_context(|| format!("{} is not a Granola export: manifest.json is missing", dir.display()))?;
    serde_json::from_str(&text).context("manifest.json has an unknown format")
}

pub fn preview(db: &Db, dir: &Path) -> Result<Preview> {
    let entries = manifest(dir)?;
    let mut already = 0;
    for entry in &entries {
        if db.external_exists(&external_id(&entry.id))? {
            already += 1;
        }
    }
    Ok(Preview {
        path: dir.to_path_buf(),
        total: entries.len(),
        mine: entries.iter().filter(|e| e.captured_by_me).count(),
        shared: entries.iter().filter(|e| !e.captured_by_me).count(),
        already_imported: already,
    })
}

fn external_id(id: &str) -> String {
    format!("{SOURCE}:{id}")
}

/// Removes the header that the export adds to each Markdown file: the title, and the
/// Date, Granola, and Participants lines.
fn body(markdown: &str) -> String {
    let mut lines = markdown.lines().peekable();
    if lines.peek().map(|l| l.starts_with("# ")).unwrap_or(false) {
        lines.next();
    }
    let mut rest: Vec<&str> = lines.collect();
    while let Some(first) = rest.first() {
        let t = first.trim();
        if t.is_empty() || t.starts_with("- Date:") || t.starts_with("- Granola:") || t.starts_with("- Participants:") {
            rest.remove(0);
        } else {
            break;
        }
    }
    rest.join("\n").trim().to_string()
}

/// Splits "Name (note creator) from Org <email>, Name <email>" into participants.
fn participants(text: &str, captured_by_me: bool) -> Vec<Participant> {
    let mut result = Vec::new();
    for part in text.split(">,").map(str::trim).filter(|p| !p.is_empty()) {
        let part = part.trim_end_matches('>');
        let email = part.rsplit_once('<').map(|(_, e)| e.trim().to_string());
        let mut name = part.split('<').next().unwrap_or(part).trim().to_string();
        let creator = name.contains("(note creator)");
        for cut in [" (", " from "] {
            if let Some(i) = name.find(cut) {
                name.truncate(i);
            }
        }
        let name = name.trim().to_string();
        if name.is_empty() {
            continue;
        }
        result.push(Participant {
            participant_id: email.filter(|e| !e.is_empty()).unwrap_or_else(|| name.clone()),
            name,
            is_self: creator && captured_by_me,
        });
    }
    result
}

/// Parses `transcript.md` into (label, text) entries in order.
fn transcript_entries(markdown: &str) -> Vec<(String, String)> {
    let mut entries: Vec<(String, String)> = Vec::new();
    for chunk in body(markdown).split("\n\n") {
        let chunk = chunk.trim();
        if chunk.is_empty() {
            continue;
        }
        let labeled = chunk.split_once(": ").filter(|(label, _)| {
            *label == "Microphone" || *label == "System audio" || (label.starts_with("System audio (") && label.ends_with(')'))
        });
        match labeled {
            Some((label, text)) => entries.push((label.to_string(), text.trim().to_string())),
            None => match entries.last_mut() {
                Some(last) => {
                    last.1.push(' ');
                    last.1.push_str(chunk);
                }
                None => entries.push(("System audio".into(), chunk.to_string())),
            },
        }
    }
    entries
}

pub fn parse(dir: &Path, folder: &str, captured_by_me: bool, include_summary: bool) -> Result<Imported> {
    let path = dir.join(folder);
    let read = |name: &str| std::fs::read_to_string(path.join(name)).with_context(|| format!("{name} is missing"));
    let meta: Value = serde_json::from_str(&read("meta.json")?)?;
    let raw: Value = read("raw-transcript.json").ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    let id = meta["id"].as_str().ok_or_else(|| anyhow!("meta.json has no id"))?;
    let title = meta["title"].as_str().filter(|t| !t.trim().is_empty()).unwrap_or("Granola meeting").trim().to_string();

    // The raw API time is exact UTC. The manifest time is local time without a zone.
    let started_at = raw["created_at"]
        .as_str()
        .and_then(parse_utc)
        .or_else(|| meta["datetime"].as_str().and_then(|d| parse_utc(&format!("{d}Z"))))
        .unwrap_or_else(crate::now_ms);

    let mut notes = body(&read("notes.md").unwrap_or_default());
    if notes == PLACEHOLDER_NOTES {
        notes.clear();
    }
    if include_summary {
        let summary = body(&read("summary.md").unwrap_or_default());
        if !summary.is_empty() {
            if !notes.is_empty() {
                notes.push_str("\n\n");
            }
            notes.push_str("---\n\n## Granola summary (AI-generated, imported)\n\n");
            notes.push_str(&summary);
        }
    }

    let recorder = raw["recording_context"]["recorder"]["name"].as_str().map(str::to_string);
    let entries = transcript_entries(&read("transcript.md")?);
    let mut speakers: Vec<NewSpeaker> = Vec::new();
    let label_of = |label: &str, speakers: &mut Vec<NewSpeaker>| -> String {
        if speakers.iter().any(|s| s.label == label) {
            return label.to_string();
        }
        let (track, name, source) = if label == "Microphone" {
            ("mic", recorder.clone(), Some(if captured_by_me { "self" } else { "platform" }))
        } else if let Some(name) = label.strip_prefix("System audio (").and_then(|l| l.strip_suffix(')')) {
            ("remote", Some(name.trim().to_string()), Some("platform"))
        } else {
            ("remote", None, None)
        };
        speakers.push(NewSpeaker {
            label: label.to_string(),
            track: track.into(),
            name: name.clone(),
            name_source: name.as_ref().and(source).map(str::to_string),
            suggestion: None,
            suggestion_score: None,
        });
        label.to_string()
    };
    let mut turns: Vec<NewTurn> = Vec::new();
    for (label, text) in entries {
        let key = label_of(&label, &mut speakers);
        if let Some(last) = turns.last_mut() {
            if last.speaker_label == key {
                last.text.push(' ');
                last.text.push_str(&text);
                continue;
            }
        }
        let track = speakers.iter().find(|s| s.label == key).map(|s| s.track.clone()).unwrap_or_default();
        turns.push(NewTurn { track, speaker_label: key, start: 0.0, end: 0.0, text });
    }

    Ok(Imported {
        external_id: external_id(id),
        title,
        started_at,
        shared: !captured_by_me,
        notes,
        participants: participants(meta["participants"].as_str().unwrap_or_default(), captured_by_me),
        speakers,
        turns,
    })
}

/// Parses "2026-03-24T11:06:36.463Z" to epoch milliseconds.
fn parse_utc(s: &str) -> Option<i64> {
    let s = s.trim().trim_end_matches('Z');
    let (date, time) = s.split_once('T')?;
    let mut d = date.split('-').map(|p| p.parse::<i64>());
    let (y, m, day) = (d.next()?.ok()?, d.next()?.ok()?, d.next()?.ok()?);
    let mut t = time.split(':');
    let h: i64 = t.next()?.parse().ok()?;
    let min: i64 = t.next()?.parse().ok()?;
    let sec: f64 = t.next().unwrap_or("0").parse().ok()?;
    // Days from civil date (Howard Hinnant's algorithm).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400_000 + h * 3_600_000 + min * 60_000 + (sec * 1000.0) as i64)
}

/// Imports every meeting that is not in the library yet. `progress` receives (done, total).
/// The import locks the library for each meeting only, so other work continues during the import.
pub fn import(db: &Mutex<Db>, dir: &Path, include_summaries: bool, mut progress: impl FnMut(usize, usize)) -> Result<Summary> {
    let entries = manifest(dir)?;
    let mut summary = Summary::default();
    for (index, entry) in entries.iter().enumerate() {
        progress(index, entries.len());
        if db.lock().unwrap().external_exists(&external_id(&entry.id))? {
            summary.skipped += 1;
            continue;
        }
        match parse(dir, &entry.folder, entry.captured_by_me, include_summaries).and_then(|m| db.lock().unwrap().insert_imported(&m)) {
            Ok(()) => summary.imported += 1,
            Err(error) => summary.failed.push(Failure { title: entry.title.clone(), error: error.to_string() }),
        }
    }
    progress(entries.len(), entries.len());
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::Keys;

    const HEADER: &str = "# Weekly sync\n\n- Date: Mar 24, 2026 12:00 PM GMT+1\n- Granola: https://notes.granola.ai/d/abc\n- Participants: Ana Ruiz (note creator) from Example <ana@example.com>, Bo Chen <bo@example.com>\n\n";

    fn export(dir: &Path) {
        let folder = dir.join("my-meetings/2026/03/2026-03-24_1200 - Weekly sync");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(
            dir.join("manifest.json"),
            r#"[{"id":"abc","title":"Weekly sync","captured_by_me":true,"folder":"my-meetings/2026/03/2026-03-24_1200 - Weekly sync"}]"#,
        )
        .unwrap();
        std::fs::write(
            folder.join("meta.json"),
            r#"{"id":"abc","title":"Weekly sync","datetime":"2026-03-24T12:00:00","participants":"Ana Ruiz (note creator) from Example <ana@example.com>, Bo Chen <bo@example.com>"}"#,
        )
        .unwrap();
        std::fs::write(folder.join("raw-transcript.json"), r#"{"created_at":"2026-03-24T11:06:36.463Z","recording_context":{"recorder":{"name":"Ana Ruiz"}}}"#).unwrap();
        std::fs::write(folder.join("notes.md"), format!("{HEADER}Check the oracle fix.")).unwrap();
        std::fs::write(folder.join("summary.md"), format!("{HEADER}An AI summary.")).unwrap();
        std::fs::write(
            folder.join("transcript.md"),
            format!("{HEADER}Microphone: Hello Bo.\n\nMicrophone: How are you?\n\nSystem audio (Bo Chen): Fine, thanks.\n\nSystem audio: Someone else.\n\n"),
        )
        .unwrap();
    }

    #[test]
    fn imports_once_with_speakers_and_notes() {
        let dir = tempfile::tempdir().unwrap();
        export(dir.path());
        let db = Mutex::new(Db::open_in_memory(&Keys::for_tests()).unwrap());
        assert_eq!(preview(&db.lock().unwrap(), dir.path()).unwrap().total, 1);
        let summary = import(&db, dir.path(), false, |_, _| {}).unwrap();
        assert_eq!(summary.imported, 1);
        let again = import(&db, dir.path(), false, |_, _| {}).unwrap();
        assert_eq!((again.imported, again.skipped), (0, 1));
        let db = db.into_inner().unwrap();

        let meeting = &db.meetings(true).unwrap()[0];
        assert_eq!(meeting.title, "Weekly sync");
        assert_eq!(meeting.source.as_deref(), Some(SOURCE));
        assert_eq!(meeting.started_at, Some(1_774_350_396_463));
        assert!(meeting.audio_deleted);
        assert_eq!(db.notes(&meeting.id).unwrap(), "Check the oracle fix.");
        let turns = db.turns(&meeting.id).unwrap();
        assert_eq!(turns.len(), 3);
        assert_eq!(turns[0].text, "Hello Bo. How are you?");
        let speakers = db.speakers(&meeting.id).unwrap();
        let bo = speakers.iter().find(|s| s.label == "System audio (Bo Chen)").unwrap();
        assert_eq!(bo.name.as_deref(), Some("Bo Chen"));
        let mic = speakers.iter().find(|s| s.label == "Microphone").unwrap();
        assert_eq!((mic.name.as_deref(), mic.name_source.as_deref()), (Some("Ana Ruiz"), Some("self")));
        assert!(speakers.iter().any(|s| s.label == "System audio" && s.name.is_none()));
        assert_eq!(db.participants(&meeting.id).unwrap().len(), 2);
        assert_eq!(db.search("oracle", 5).unwrap().len(), 1);
    }

    /// Imports a real export into an in-memory library and prints counts only.
    /// Run: `TINTA_GRANOLA_EXPORT=~/granola-export cargo test -p tinta-core real_export -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_export() {
        let Some(dir) = std::env::var_os("TINTA_GRANOLA_EXPORT") else { return };
        let dir = PathBuf::from(dir);
        let db = Mutex::new(Db::open_in_memory(&Keys::for_tests()).unwrap());
        let started = std::time::Instant::now();
        let summary = import(&db, &dir, false, |_, _| {}).unwrap();
        println!("imported {} skipped {} failed {} in {:.1} s", summary.imported, summary.skipped, summary.failed.len(), started.elapsed().as_secs_f64());
        for f in summary.failed.iter().take(5) {
            println!("  failed: {}", f.error);
        }
        let meetings = db.lock().unwrap().meetings(true).unwrap();
        let (mut turns, mut named, mut unnamed, mut with_notes) = (0, 0, 0, 0);
        for m in &meetings {
            let db = db.lock().unwrap();
            turns += db.turns(&m.id).unwrap().len();
            for s in db.speakers(&m.id).unwrap() {
                if s.name.is_some() { named += 1 } else { unnamed += 1 }
            }
            if !db.notes(&m.id).unwrap().is_empty() { with_notes += 1 }
        }
        println!("meetings {} turns {} named speakers {} unnamed speakers {} meetings with notes {}", meetings.len(), turns, named, unnamed, with_notes);
        let again = import(&db, &dir, false, |_, _| {}).unwrap();
        println!("second import: imported {} skipped {}", again.imported, again.skipped);
    }

    #[test]
    fn summary_is_optional_and_labeled() {
        let dir = tempfile::tempdir().unwrap();
        export(dir.path());
        let m = parse(dir.path(), "my-meetings/2026/03/2026-03-24_1200 - Weekly sync", true, true).unwrap();
        assert!(m.notes.contains("## Granola summary (AI-generated, imported)"));
        assert!(m.notes.starts_with("Check the oracle fix."));
    }
}
