mod commands;
mod engine;
mod socket;
mod system;

use anyhow::{bail, Result};
use engine::Engine;
use tinta_core::db::{Db, Participant};
use tinta_core::keys::Keys;
use tinta_core::naming;
use tinta_core::transcript::{self, FinalResult};
use tinta_core::{now_ms, paths};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize)]
pub struct Active {
    pub meeting_id: String,
    pub start_wall_ms: i64,
    pub paused: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ExtensionState {
    pub connected_at: Option<i64>,
    pub last_seen: Option<i64>,
    pub meeting_code: Option<String>,
    pub title: Option<String>,
    pub self_name: Option<String>,
    pub participants: Vec<Participant>,
    pub speaking: Vec<String>,
}

pub struct AppState {
    pub db: Mutex<Db>,
    pub keys: Keys,
    pub engine: Arc<Engine>,
    pub app: Option<AppHandle>,
    pub active: Mutex<Option<Active>>,
    pub extension: Mutex<ExtensionState>,
    pub finalizing: Mutex<HashSet<String>>,
}

static STATE: OnceLock<Arc<AppState>> = OnceLock::new();

pub fn state() -> Arc<AppState> {
    STATE.get().expect("state").clone()
}

impl AppState {
    pub fn setting(&self, key: &str, default: &str) -> String {
        self.db.lock().unwrap().setting(key).ok().flatten().unwrap_or_else(|| default.to_string())
    }

    pub fn self_name(&self) -> String {
        let stored = self.db.lock().unwrap().setting("self_name").ok().flatten();
        stored.unwrap_or_else(system::full_name)
    }

    pub fn emit(&self, event: &str, payload: Value) {
        if let Some(app) = &self.app {
            let _ = app.emit(event, payload);
        }
    }

    pub fn meeting_changed(&self, id: &str) {
        self.emit("meeting_changed", json!({"id": id}));
    }

    fn audio_params(&self, id: &str) -> Value {
        json!({"dir": paths::meeting_dir(id).to_string_lossy(), "audio_key": self.keys.audio_base64()})
    }

    // MARK: Recording

    pub fn start_recording(&self, id: &str, source: &str) -> Result<Active> {
        if self.active.lock().unwrap().is_some() {
            bail!("a recording is already active");
        }
        let meeting = self.db.lock().unwrap().meeting(id)?;
        if meeting.started_at.is_some() {
            bail!("this meeting already has a recording. Create a new meeting.");
        }
        let mut params = self.audio_params(id);
        params["source"] = json!(source);
        let result = self.engine.call("start", params, Duration::from_secs(60))?;
        let start_wall_ms = result["start_wall_ms"].as_i64().unwrap_or_else(now_ms);
        let extension = self.extension.lock().unwrap().clone();
        {
            let db = self.db.lock().unwrap();
            db.mark_started(id, start_wall_ms, extension.meeting_code.as_deref())?;
            if extension.meeting_code.is_some() {
                db.upsert_participants(id, &extension.participants)?;
                if meeting.title.starts_with("Meeting ") {
                    if let Some(title) = extension.title.as_deref().filter(|t| !t.is_empty()) {
                        db.set_title(id, title, tinta_core::db::Origin::User)?;
                    }
                }
            }
            db.set_setting("last_source", source)?;
        }
        let active = Active { meeting_id: id.to_string(), start_wall_ms, paused: false };
        *self.active.lock().unwrap() = Some(active.clone());
        self.meeting_changed(id);
        Ok(active)
    }

    /// The engine reader thread also takes the `active` lock, so engine calls never run under it.
    pub fn set_paused(&self, paused: bool) -> Result<()> {
        if self.active.lock().unwrap().is_none() {
            bail!("no recording is active");
        }
        self.engine.call(if paused { "pause" } else { "resume" }, json!({}), Duration::from_secs(10))?;
        let mut active = self.active.lock().unwrap();
        if let Some(current) = active.as_mut() {
            current.paused = paused;
            self.emit("recording", json!(current.clone()));
        }
        Ok(())
    }

    pub fn stop_recording(self: &Arc<Self>) -> Result<String> {
        let Some(active) = self.active.lock().unwrap().take() else { bail!("no recording is active") };
        let result = self.engine.call("stop", json!({}), Duration::from_secs(30));
        self.db.lock().unwrap().mark_stopped(&active.meeting_id)?;
        self.meeting_changed(&active.meeting_id);
        result?;
        let state = self.clone();
        let id = active.meeting_id.clone();
        std::thread::spawn(move || state.finalize_logged(&id, None));
        Ok(active.meeting_id)
    }

    // MARK: Live pass

    fn live_name(&self, meeting_id: &str, start_wall_ms: i64, track: &str, s: f64, e: f64) -> Option<String> {
        if track == "mic" {
            return Some(self.self_name());
        }
        let db = self.db.lock().unwrap();
        let participants = db.participants(meeting_id).ok()?;
        let exclude: HashSet<String> =
            participants.iter().filter(|p| p.is_self).map(|p| p.participant_id.clone()).collect();
        let events = db.speaker_events(meeting_id).ok()?;
        let highlights = naming::highlights(&events, start_wall_ms, &exclude);
        let participant = naming::live_participant(&highlights, s, e)?;
        participants.into_iter().find(|p| p.participant_id == participant).map(|p| p.name)
    }

    fn on_engine_event(&self, event: Value) {
        match event["event"].as_str().unwrap_or_default() {
            "live" => {
                let Some(active) = self.active.lock().unwrap().clone() else { return };
                let track = event["track"].as_str().unwrap_or("remote");
                let s = event["s"].as_f64().unwrap_or(0.0);
                let e = event["e"].as_f64().unwrap_or(s);
                let text = event["text"].as_str().unwrap_or_default();
                let name = self.live_name(&active.meeting_id, active.start_wall_ms, track, s, e);
                let turn = self
                    .db
                    .lock()
                    .unwrap()
                    .add_live_turn(&active.meeting_id, track, s, e, text, name.as_deref());
                if let Ok(turn) = turn {
                    self.emit("live_turn", json!(turn));
                }
            }
            _ => self.emit("engine", event),
        }
    }

    // MARK: Final pass

    pub fn finalize_logged(self: &Arc<Self>, id: &str, language: Option<String>) {
        if let Err(error) = self.finalize(id, language) {
            let _ = self.db.lock().unwrap().set_state(id, "failed", Some(&error.to_string()));
            self.meeting_changed(id);
        }
    }

    pub fn finalize(self: &Arc<Self>, id: &str, language: Option<String>) -> Result<()> {
        if !self.finalizing.lock().unwrap().insert(id.to_string()) {
            bail!("the final pass for this meeting is already running");
        }
        let _guard = FinalizeGuard { state: self.clone(), id: id.to_string() };
        let (participants, events, start_wall_ms) = {
            let db = self.db.lock().unwrap();
            if db.has_edits(id)? {
                bail!("the transcript has edits. The final pass does not overwrite them.");
            }
            db.set_state(id, "processing", None)?;
            (db.participants(id)?, db.speaker_events(id)?, db.start_wall_ms(id)?)
        };
        self.meeting_changed(id);
        let mut params = self.audio_params(id);
        let remote = participants.iter().filter(|p| !p.is_self).count();
        if remote > 0 {
            params["max_speakers"] = json!(remote);
        }
        let value = self.engine.call("finalize", params, Duration::from_secs(60 * 60))?;
        let result: FinalResult = serde_json::from_value(value)?;
        let built = transcript::build(&result, &self.self_name(), &participants, &events, start_wall_ms);
        let detected = result.language.clone();
        self.db.lock().unwrap().replace_with_final(
            id,
            &built.speakers,
            &built.turns,
            result.duration,
            language.as_deref().or(detected.as_deref()),
        )?;
        self.meeting_changed(id);
        self.emit(
            "final_pass",
            json!({"id": id, "named": built.named, "remote_speakers": built.remote_labels}),
        );
        Ok(())
    }

    // MARK: Extension messages

    pub fn on_extension_message(&self, message: &Value) -> Value {
        let t = message["t"].as_i64().unwrap_or_else(now_ms);
        let code = message["meeting_code"].as_str().map(str::to_string);
        let active = self.active.lock().unwrap().clone();
        {
            let mut ext = self.extension.lock().unwrap();
            if ext.connected_at.is_none() {
                ext.connected_at = Some(now_ms());
            }
            ext.last_seen = Some(now_ms());
            match message["type"].as_str().unwrap_or_default() {
                "meet_state" => {
                    ext.meeting_code = code.clone();
                    ext.title = message["title"].as_str().map(str::to_string);
                    ext.self_name = message["self_name"].as_str().map(str::to_string);
                    ext.participants = message["participants"]
                        .as_array()
                        .map(|list| {
                            list.iter()
                                .filter_map(|p| {
                                    Some(Participant {
                                        participant_id: p["id"].as_str()?.chars().take(200).collect(),
                                        name: p["name"].as_str()?.chars().take(200).collect(),
                                        is_self: p["is_self"].as_bool().unwrap_or(false),
                                    })
                                })
                                .take(100)
                                .collect()
                        })
                        .unwrap_or_default();
                    if let Some(active) = &active {
                        let db = self.db.lock().unwrap();
                        let _ = db.upsert_participants(&active.meeting_id, &ext.participants);
                    }
                    if let Some(name) = ext.self_name.clone() {
                        let db = self.db.lock().unwrap();
                        if matches!(db.setting("self_name"), Ok(None)) {
                            let _ = db.set_setting("self_name", &name);
                        }
                    }
                }
                "active_speakers" => {
                    ext.speaking = message["speaking"]
                        .as_array()
                        .map(|l| l.iter().filter_map(|v| v.as_str().map(str::to_string)).take(100).collect())
                        .unwrap_or_default();
                    if let Some(active) = &active {
                        if !active.paused {
                            let _ = self.db.lock().unwrap().add_speaker_event(&active.meeting_id, t, &ext.speaking);
                        }
                    }
                }
                "ping" => {}
                "meeting_ended" => {
                    ext.meeting_code = None;
                    ext.speaking.clear();
                    ext.participants.clear();
                    ext.title = None;
                }
                _ => {}
            }
            self.emit("extension", json!(ext.clone()));
        }
        json!({
            "recording": active.as_ref().map(|a| !a.paused).unwrap_or(false),
            "recording_since": active.as_ref().map(|a| a.start_wall_ms),
        })
    }

    // MARK: Library location

    /// Moves the library and the audio to `<parent>/Tinta` and opens it there.
    pub fn move_library(&self, parent: &std::path::Path) -> Result<std::path::PathBuf> {
        if self.active.lock().unwrap().is_some() || !self.finalizing.lock().unwrap().is_empty() {
            bail!("Stop the recording and wait for the final pass before you move the library.");
        }
        let target = parent.join("Tinta");
        paths::check_local(&target)?;
        let current = paths::data_dir();
        if target == current {
            bail!("The library is already in this folder.");
        }
        if target.exists() && std::fs::read_dir(&target)?.next().is_some() {
            bail!("{} already exists and is not empty.", target.display());
        }
        std::fs::create_dir_all(&target)?;
        let mut db = self.db.lock().unwrap();
        db.checkpoint()?;
        std::fs::copy(current.join("library.db"), target.join("library.db"))?;
        let meetings = current.join("meetings");
        if meetings.exists() {
            copy_dir(&meetings, &target.join("meetings"))?;
        }
        *db = Db::open(&target.join("library.db"), &self.keys)?;
        paths::set_data_dir(&target)?;
        system::exclude_from_backup(&target);
        for name in ["library.db", "library.db-wal", "library.db-shm"] {
            let _ = std::fs::remove_file(current.join(name));
        }
        let _ = std::fs::remove_dir_all(&meetings);
        Ok(target)
    }

    // MARK: Retention

    pub fn delete_meeting_files(&self, id: &str) {
        let _ = std::fs::remove_dir_all(paths::meeting_dir(id));
    }

    pub fn delete_audio_files(&self, id: &str) -> Result<()> {
        let dir = paths::audio_dir(id);
        if dir.exists() {
            std::fs::remove_dir_all(dir)?;
        }
        self.db.lock().unwrap().mark_audio_deleted(id)
    }

    pub fn run_retention(&self) {
        let now = now_ms();
        let (audio, trash) = {
            let db = self.db.lock().unwrap();
            (db.expired_audio(now).unwrap_or_default(), db.expired_trash(now).unwrap_or_default())
        };
        for id in audio {
            let _ = self.delete_audio_files(&id);
            self.meeting_changed(&id);
        }
        for id in trash {
            self.delete_meeting_files(&id);
            let _ = self.db.lock().unwrap().delete_meeting_now(&id);
        }
    }
}

fn copy_dir(from: &std::path::Path, to: &std::path::Path) -> Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

struct FinalizeGuard {
    state: Arc<AppState>,
    id: String,
}

impl Drop for FinalizeGuard {
    fn drop(&mut self) {
        self.state.finalizing.lock().unwrap().remove(&self.id);
    }
}

/// Opens the library, starts the engine client and the app socket, and starts recovery and retention.
pub fn init(app: Option<AppHandle>) -> Result<Arc<AppState>> {
    let data = paths::data_dir();
    std::fs::create_dir_all(&data)?;
    std::fs::create_dir_all(paths::base_dir())?;
    system::exclude_from_backup(&data);
    let keys = Keys::load_or_create()?;
    let db = Db::open(&paths::database_path(), &keys)?;
    let engine = Engine::new(Arc::new(|event| {
        if let Some(state) = STATE.get() {
            state.on_engine_event(event);
        }
    }));
    let state = Arc::new(AppState {
        db: Mutex::new(db),
        keys,
        engine,
        app,
        active: Mutex::new(None),
        extension: Mutex::new(ExtensionState::default()),
        finalizing: Mutex::new(HashSet::new()),
    });
    let _ = STATE.set(state.clone());
    // Test runs use their own data folder and must not change the Chrome configuration.
    if std::env::var_os("TINTA_DATA_DIR").is_none() {
        let _ = system::install_native_host();
    }
    socket::serve(state.clone())?;

    // Recover meetings that were recording or processing when the app stopped.
    let unfinished: Vec<String> = {
        let db = state.db.lock().unwrap();
        db.meetings(true)?
            .into_iter()
            .filter(|m| m.state == "recording" || m.state == "processing")
            .map(|m| m.id)
            .collect()
    };
    let recovery = state.clone();
    std::thread::spawn(move || {
        for id in unfinished {
            let _ = recovery.db.lock().unwrap().mark_stopped(&id);
            recovery.finalize_logged(&id, None);
        }
    });

    let retention = state.clone();
    std::thread::spawn(move || loop {
        retention.run_retention();
        std::thread::sleep(Duration::from_secs(300));
    });
    Ok(state)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            init(Some(app.handle().clone())).map_err(|e| -> Box<dyn std::error::Error> { e.to_string().into() })?;
            Ok(())
        })
        .invoke_handler(commands::handler())
        .build(tauri::generate_context!())
        .expect("error while building the app")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                if let Some(state) = STATE.get() {
                    if state.active.lock().unwrap().is_some() {
                        let _ = state.stop_recording();
                    }
                    state.engine.shutdown();
                }
                let _ = std::fs::remove_file(paths::socket_path());
                let _ = app;
            }
        });
}

pub fn names_for(db: &Db, id: &str) -> Result<HashMap<String, String>> {
    Ok(tinta_core::export::Document::load(db, id)?.names())
}
