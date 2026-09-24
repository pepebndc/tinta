//! Commands for the app window.

use crate::{names_for, state, system};
use tinta_core::db::Origin;
use tinta_core::export::{self, Document};
use tinta_core::paths;
use serde_json::{json, Value};
use std::time::Duration;

type CommandResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[tauri::command]
async fn bootstrap() -> CommandResult<Value> {
    let s = state();
    let models = s.engine.call("models_status", json!({}), Duration::from_secs(20)).unwrap_or(json!({}));
    let permissions = s.engine.call("permissions", json!({}), Duration::from_secs(10)).unwrap_or(json!({}));
    let summaries = s.engine.call("summary_status", json!({}), Duration::from_secs(10)).unwrap_or(json!({"available": false}));
    let db = s.db.lock().unwrap();
    let setting = |key: &str, default: &str| db.setting(key).ok().flatten().unwrap_or_else(|| default.to_string());
    let mcp_path = system::helper_path("tinta-mcp");
    Ok(json!({
        "self_name": db.setting("self_name").ok().flatten().unwrap_or_else(system::full_name),
        "mcp_enabled": setting("mcp_enabled", "true") == "true",
        "last_source": setting("last_source", "com.google.Chrome"),
        "theme": setting("theme", "system"),
        "onboarded": setting("onboarded", "false") == "true",
        "auto_stop": setting("auto_stop", "true") == "true",
        "auto_summary": setting("auto_summary", "true") == "true",
        "audio_retention_days": db.audio_retention_days().map_err(err)?,
        "summaries": summaries,
        "filevault": system::filevault_on(),
        "models_installed": models["installed"].as_bool().unwrap_or(false),
        "models_path": models["path"],
        "microphone": permissions["microphone"],
        "mcp_path": mcp_path,
        "mcp_config": {"mcpServers": {"tinta": {"command": mcp_path}}},
        "extension_id": system::EXTENSION_ID,
        "data_dir": paths::data_dir(),
        "active": *s.active.lock().unwrap(),
        "extension": *s.extension.lock().unwrap(),
    }))
}

#[tauri::command]
async fn set_setting(key: String, value: String) -> CommandResult<()> {
    let allowed = ["self_name", "mcp_enabled", "last_source", "theme", "onboarded", "auto_stop", "auto_summary"];
    if !allowed.contains(&key.as_str()) {
        return Err(format!("unknown setting {key}"));
    }
    state().db.lock().unwrap().set_setting(&key, &value).map_err(err)
}

#[tauri::command]
async fn install_models() -> CommandResult<Value> {
    state().engine.call("install_models", json!({}), Duration::from_secs(60 * 60)).map_err(err)
}

#[tauri::command]
async fn request_microphone() -> CommandResult<Value> {
    state().engine.call("request_microphone", json!({}), Duration::from_secs(120)).map_err(err)
}

#[tauri::command]
async fn list_sources() -> CommandResult<Value> {
    state().engine.call("list_sources", json!({}), Duration::from_secs(10)).map_err(err)
}

#[tauri::command]
async fn list_meetings(include_archived: bool) -> CommandResult<Value> {
    let s = state();
    let db = s.db.lock().unwrap();
    Ok(json!({"meetings": db.meetings(include_archived).map_err(err)?, "folders": db.folders().map_err(err)?}))
}

#[tauri::command]
async fn search(query: String) -> CommandResult<Value> {
    Ok(json!(state().db.lock().unwrap().search(&query, 50).map_err(err)?))
}

#[tauri::command]
async fn create_meeting(title: Option<String>) -> CommandResult<Value> {
    let s = state();
    let ext = s.extension.lock().unwrap().clone();
    let title = title
        .filter(|t| !t.trim().is_empty())
        .or(ext.title.filter(|t| !t.is_empty()))
        .unwrap_or_else(|| format!("Meeting {}", export::format_date(tinta_core::now_ms())));
    let meeting = s.db.lock().unwrap().create_meeting(&title, None).map_err(err)?;
    Ok(json!(meeting))
}

#[tauri::command]
async fn get_meeting(id: String) -> CommandResult<Value> {
    let s = state();
    let db = s.db.lock().unwrap();
    let doc = Document::load(&db, &id).map_err(err)?;
    Ok(json!({
        "meeting": doc.meeting,
        "notes": doc.notes,
        "speakers": doc.speakers.iter().filter(|sp| sp.merged_into.is_none()).collect::<Vec<_>>(),
        "turns": doc.turns,
        "names": names_for(&db, &id).map_err(err)?,
        "participants": db.participants(&id).map_err(err)?,
        "has_edits": db.has_edits(&id).map_err(err)?,
        "finalizing": s.finalizing.lock().unwrap().contains(&id),
        "audio_bytes": dir_size(&paths::audio_dir(&id)),
        "summary": db.summary(&id).map_err(err)?,
        "summarizing": s.summarizing.lock().unwrap().contains(&id),
    }))
}

#[tauri::command]
async fn set_title(id: String, title: String) -> CommandResult<()> {
    state().db.lock().unwrap().set_title(&id, &title, Origin::User).map_err(err)
}

#[tauri::command]
async fn set_notes(id: String, content: String) -> CommandResult<()> {
    state().db.lock().unwrap().set_notes(&id, &content, Origin::User).map_err(err)
}

#[tauri::command]
async fn set_tags(id: String, tags: Vec<String>) -> CommandResult<()> {
    state().db.lock().unwrap().set_tags(&id, &tags, Origin::User).map_err(err)
}

#[tauri::command]
async fn set_folder(id: String, folder: Option<String>) -> CommandResult<()> {
    state().db.lock().unwrap().set_folder(&id, folder.as_deref(), Origin::User).map_err(err)
}

#[tauri::command]
async fn set_archived(id: String, archived: bool) -> CommandResult<()> {
    state().db.lock().unwrap().set_archived(&id, archived).map_err(err)
}

#[tauri::command]
async fn start_recording(id: String, source: String) -> CommandResult<Value> {
    Ok(json!(state().start_recording(&id, &source).map_err(err)?))
}

#[tauri::command]
async fn pause_recording(paused: bool) -> CommandResult<()> {
    state().set_paused(paused).map_err(err)
}

#[tauri::command]
async fn stop_recording() -> CommandResult<String> {
    state().stop_recording().map_err(err)
}

#[tauri::command]
async fn run_final_pass(id: String, language: Option<String>) -> CommandResult<()> {
    let s = state();
    std::thread::spawn(move || s.finalize_logged(&id, language));
    Ok(())
}

#[tauri::command]
async fn summarize(id: String) -> CommandResult<()> {
    let s = state();
    std::thread::spawn(move || s.summarize_logged(&id));
    Ok(())
}

#[tauri::command]
async fn delete_summary(id: String) -> CommandResult<()> {
    let s = state();
    s.db.lock().unwrap().delete_summary(&id).map_err(err)?;
    s.meeting_changed(&id);
    Ok(())
}

#[tauri::command]
async fn import_recording(path: String) -> CommandResult<Value> {
    let s = state();
    let name = std::path::Path::new(&path)
        .file_stem()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "Imported recording".into());
    let meeting = s.db.lock().unwrap().create_meeting(&name, Some("import")).map_err(err)?;
    let params = json!({
        "dir": paths::meeting_dir(&meeting.id).to_string_lossy(),
        "audio_key": s.keys.audio_base64(),
        "path": path,
    });
    s.engine.call("import_audio", params, Duration::from_secs(600)).map_err(err)?;
    s.db.lock().unwrap().mark_stopped(&meeting.id).map_err(err)?;
    let id = meeting.id.clone();
    let worker = s.clone();
    std::thread::spawn(move || worker.finalize_logged(&id, None));
    Ok(json!(meeting))
}

#[tauri::command]
async fn rename_speaker(speaker_id: String, name: Option<String>) -> CommandResult<()> {
    state().db.lock().unwrap().rename_speaker(&speaker_id, name.as_deref(), Origin::User).map_err(err)
}

#[tauri::command]
async fn merge_speakers(from: String, into: String) -> CommandResult<()> {
    state().db.lock().unwrap().merge_speakers(&from, &into, Origin::User).map_err(err)
}

#[tauri::command]
async fn reassign_turn(turn_id: i64, speaker_id: Option<String>) -> CommandResult<String> {
    state().db.lock().unwrap().reassign_turn(turn_id, speaker_id.as_deref(), Origin::User).map_err(err)
}

#[tauri::command]
async fn edit_turn_text(turn_id: i64, text: String) -> CommandResult<()> {
    state().db.lock().unwrap().edit_turn_text(turn_id, &text, Origin::User).map_err(err)
}

/// Returns a WAV clip as base64 for a speaker: the longest turn, at most 8 seconds.
#[tauri::command]
async fn speaker_sample(speaker_id: String) -> CommandResult<String> {
    let s = state();
    let (meeting_id, track, start, end) = {
        let db = s.db.lock().unwrap();
        let speaker = db.speaker(&speaker_id).map_err(err)?;
        let turn = db
            .turns(&speaker.meeting_id)
            .map_err(err)?
            .into_iter()
            .filter(|t| t.speaker_id.as_deref() == Some(speaker_id.as_str()))
            .max_by(|a, b| (a.end - a.start).total_cmp(&(b.end - b.start)))
            .ok_or("this speaker has no turns")?;
        (speaker.meeting_id, turn.track, turn.start, turn.end.min(turn.start + 8.0))
    };
    clip(&meeting_id, &track, start, end)
}

#[tauri::command]
async fn turn_audio(turn_id: i64) -> CommandResult<String> {
    let turn = state().db.lock().unwrap().turn(turn_id).map_err(err)?;
    clip(&turn.meeting_id, &turn.track, turn.start, turn.end)
}

fn clip(meeting_id: &str, track: &str, start: f64, end: f64) -> CommandResult<String> {
    let s = state();
    let meeting = s.db.lock().unwrap().meeting(meeting_id).map_err(err)?;
    if meeting.audio_deleted || meeting.audio_trashed_at.is_some() {
        return Err("the audio of this meeting is deleted".into());
    }
    let params = json!({
        "dir": paths::meeting_dir(meeting_id).to_string_lossy(),
        "audio_key": s.keys.audio_base64(),
        "track": track, "s": start, "e": end,
    });
    let result = s.engine.call("sample", params, Duration::from_secs(60)).map_err(err)?;
    Ok(result["wav_base64"].as_str().unwrap_or_default().to_string())
}

/// Deletion by the user is immediate and permanent.
#[tauri::command]
async fn delete_meeting(id: String) -> CommandResult<()> {
    let s = state();
    if s.active.lock().unwrap().as_ref().map(|a| a.meeting_id == id).unwrap_or(false) {
        return Err("stop the recording first".into());
    }
    s.delete_meeting_files(&id);
    let result = s.db.lock().unwrap().delete_meeting_now(&id).map_err(err);
    result
}

#[tauri::command]
async fn delete_audio(id: String) -> CommandResult<()> {
    let s = state();
    if s.active.lock().unwrap().as_ref().map(|a| a.meeting_id == id).unwrap_or(false) {
        return Err("stop the recording first".into());
    }
    s.delete_audio_files(&id).map_err(err)?;
    s.meeting_changed(&id);
    Ok(())
}

/// Sets how many days new meetings keep their audio. Existing meetings keep their own period.
#[tauri::command]
async fn set_audio_retention_days(days: i64) -> CommandResult<()> {
    state().db.lock().unwrap().set_audio_retention_days(days).map_err(err)
}

#[tauri::command]
async fn set_audio_retention(id: String, days: i64) -> CommandResult<i64> {
    state().db.lock().unwrap().set_audio_retention(&id, days, Origin::User).map_err(err)
}

#[tauri::command]
async fn export_text(id: String, format: String) -> CommandResult<String> {
    let s = state();
    let db = s.db.lock().unwrap();
    export::render(&Document::load(&db, &id).map_err(err)?, &format).map_err(err)
}

/// Writes an export to the Downloads folder and returns the path.
#[tauri::command]
async fn export_file(id: String, format: String) -> CommandResult<String> {
    let s = state();
    let (title, text) = {
        let db = s.db.lock().unwrap();
        let doc = Document::load(&db, &id).map_err(err)?;
        (doc.meeting.title.clone(), export::render(&doc, &format).map_err(err)?)
    };
    let safe: String = title
        .chars()
        .map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' { c } else { '_' })
        .collect();
    let extension = if format == "markdown" { "md" } else { format.as_str() };
    let dir = std::env::var_os("HOME").map(std::path::PathBuf::from).unwrap_or_default().join("Downloads");
    let mut path = dir.join(format!("{}.{extension}", safe.trim()));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{} ({n}).{extension}", safe.trim()));
        n += 1;
    }
    std::fs::write(&path, text).map_err(err)?;
    Ok(path.to_string_lossy().to_string())
}

/// The usual export folder, if it exists.
#[tauri::command]
async fn granola_default_path() -> CommandResult<Option<String>> {
    let path = std::env::var_os("HOME").map(std::path::PathBuf::from).unwrap_or_default().join("granola-export");
    Ok(path.join("manifest.json").exists().then(|| path.to_string_lossy().to_string()))
}

#[tauri::command]
async fn granola_preview(path: String) -> CommandResult<Value> {
    let s = state();
    let db = s.db.lock().unwrap();
    Ok(json!(tinta_core::granola::preview(&db, std::path::Path::new(&path)).map_err(err)?))
}

/// Imports the meetings of a Granola export. It sends `granola_progress` events.
#[tauri::command]
async fn import_granola(path: String, include_summaries: bool) -> CommandResult<Value> {
    let s = state();
    let summary = {
        let mut db = s.db.lock().unwrap();
        let emitter = s.clone();
        tinta_core::granola::import(&mut db, std::path::Path::new(&path), include_summaries, |done, total| {
            if done % 10 == 0 || done == total {
                emitter.emit("granola_progress", json!({"done": done, "total": total}));
            }
        })
        .map_err(err)?
    };
    s.emit("meeting_changed", json!({"id": ""}));
    Ok(json!(summary))
}

#[tauri::command]
async fn move_library(parent: String) -> CommandResult<String> {
    let s = state();
    let target = s.move_library(std::path::Path::new(&parent)).map_err(err)?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
async fn show_library() -> CommandResult<()> {
    std::process::Command::new("/usr/bin/open").arg(paths::data_dir()).spawn().map_err(err)?;
    Ok(())
}

/// Copies the bundled Chrome extension to a fixed folder and shows it in Finder.
/// Chrome loads an unpacked extension from a folder, and the app bundle is not a good place for it.
#[tauri::command]
async fn prepare_extension(app: tauri::AppHandle) -> CommandResult<String> {
    use tauri::Manager;
    let source = app.path().resource_dir().map_err(err)?.join("extension");
    let target = paths::base_dir().join("Chrome extension");
    if target.exists() {
        std::fs::remove_dir_all(&target).map_err(err)?;
    }
    copy_dir(&source, &target).map_err(err)?;
    std::process::Command::new("/usr/bin/open").arg("-R").arg(&target).spawn().map_err(err)?;
    Ok(target.to_string_lossy().to_string())
}

/// Disk use of the library, the audio, and the speech models, in bytes.
#[tauri::command]
async fn storage_usage() -> CommandResult<Value> {
    let s = state();
    let models = s.engine.call("models_status", json!({}), Duration::from_secs(20)).unwrap_or(json!({}));
    let data = paths::data_dir();
    let library: u64 = ["library.db", "library.db-wal", "library.db-shm"]
        .iter()
        .filter_map(|name| std::fs::metadata(data.join(name)).ok())
        .map(|m| m.len())
        .sum();
    let meetings = dir_size(&data.join("meetings"));
    let models = models["path"].as_str().map(|p| dir_size(std::path::Path::new(p))).unwrap_or(0);
    Ok(json!({"library": library, "audio": meetings, "total": library + meetings, "models": models}))
}

/// The total size of the files in a folder. A missing folder has size 0.
fn dir_size(path: &std::path::Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else { return 0 };
    entries
        .flatten()
        .map(|entry| match entry.file_type() {
            Ok(t) if t.is_dir() => dir_size(&entry.path()),
            Ok(t) if t.is_file() => entry.metadata().map(|m| m.len()).unwrap_or(0),
            _ => 0,
        })
        .sum()
}

fn copy_dir(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            copy_dir(&path, &to.join(entry.file_name()))?;
        } else {
            std::fs::copy(&path, to.join(entry.file_name()))?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn trash() -> CommandResult<Value> {
    Ok(json!(state().db.lock().unwrap().trash().map_err(err)?))
}

#[tauri::command]
async fn restore(id: String) -> CommandResult<()> {
    let s = state();
    s.db.lock().unwrap().restore(&id).map_err(err)?;
    s.meeting_changed(&id);
    Ok(())
}

#[tauri::command]
async fn mcp_activity() -> CommandResult<Value> {
    let s = state();
    let db = s.db.lock().unwrap();
    Ok(json!({
        "revisions": db.revisions(Some(Origin::Mcp), 200).map_err(err)?,
        "access": db.access_log(200).map_err(err)?,
    }))
}

#[tauri::command]
async fn undo(revision_id: i64) -> CommandResult<()> {
    state().db.lock().unwrap().undo(revision_id).map_err(err)
}

pub fn handler() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        bootstrap,
        set_setting,
        install_models,
        request_microphone,
        list_sources,
        list_meetings,
        search,
        create_meeting,
        get_meeting,
        set_title,
        set_notes,
        set_tags,
        set_folder,
        set_archived,
        start_recording,
        pause_recording,
        stop_recording,
        run_final_pass,
        import_recording,
        rename_speaker,
        merge_speakers,
        reassign_turn,
        edit_turn_text,
        speaker_sample,
        turn_audio,
        delete_meeting,
        delete_audio,
        set_audio_retention,
        set_audio_retention_days,
        export_text,
        export_file,
        move_library,
        show_library,
        prepare_extension,
        storage_usage,
        summarize,
        delete_summary,
        granola_default_path,
        granola_preview,
        import_granola,
        trash,
        restore,
        mcp_activity,
        undo,
    ]
}
