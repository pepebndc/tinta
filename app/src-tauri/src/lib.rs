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
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize)]
pub struct Active {
    pub meeting_id: String,
    pub start_wall_ms: i64,
    pub paused: bool,
    /// The meeting audio source: an app bundle ID, or "all".
    pub source: String,
    /// The Meet call of this recording, when the extension saw one at the start.
    pub meeting_code: Option<String>,
    /// The desktop app call of this recording, by the app bundle ID. It is the same as `source`.
    pub app_call: Option<String>,
}

/// A call in a desktop meeting app, such as Zoom or Microsoft Teams. The engine detects it from the audio of the app.
#[derive(Debug, Clone, Serialize)]
pub struct AppCall {
    /// The bundle ID of the app, which is also its recording source.
    pub app: String,
    pub name: String,
    pub since: i64,
    /// The participants that the engine reads from the app window. The name is also the participant ID.
    /// The list is empty when reading is off.
    pub participants: Vec<Participant>,
    pub speaking: Vec<String>,
    /// The microphone state in the app. `None` when the engine cannot read it.
    pub mic_muted: Option<bool>,
}

impl AppCall {
    /// Reads a call from an engine message. The name is the bundle ID and the start is now when the message has none.
    fn parse(value: &Value) -> Option<Self> {
        let app = value["app"].as_str()?.to_string();
        Some(Self {
            name: value["name"].as_str().unwrap_or(&app).to_string(),
            since: value["since"].as_i64().unwrap_or_else(now_ms),
            app,
            participants: Vec::new(),
            speaking: Vec::new(),
            mic_muted: None,
        })
    }
}

/// Reads a participant list from an extension or engine message.
fn parse_participants(value: &Value) -> Vec<Participant> {
    value
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
        .unwrap_or_default()
}

fn parse_names(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|l| l.iter().filter_map(|v| v.as_str().map(|s| s.chars().take(200).collect())).take(100).collect())
        .unwrap_or_default()
}

/// The call app does not always mark the user. Then the user's name identifies the user.
fn mark_self(participants: &mut [Participant], own: &str) {
    if participants.iter().any(|p| p.is_self) {
        return;
    }
    let own = own.trim().to_lowercase();
    for p in participants.iter_mut().filter(|p| !own.is_empty() && p.name.trim().to_lowercase() == own) {
        p.is_self = true;
    }
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
    /// The microphone state in Meet. `None` when the page does not show it.
    pub mic_muted: Option<bool>,
}

pub struct AppState {
    pub db: Mutex<Db>,
    pub keys: Keys,
    pub engine: Arc<Engine>,
    pub app: Option<AppHandle>,
    pub active: Mutex<Option<Active>>,
    pub extension: Mutex<ExtensionState>,
    pub calls: Mutex<Vec<AppCall>>,
    pub finalizing: Mutex<HashSet<String>>,
    pub summarizing: Mutex<HashSet<String>>,
    /// A call that ended during a recording, and the time of the end message.
    /// The call is a Meet meeting code or a desktop app bundle ID.
    pub call_ended: Mutex<Option<(String, i64)>>,
    /// True while a recording starts, so a second start fails.
    starting: AtomicBool,
    /// The number of the newest native host connection. Only its disconnection ends the Meet call.
    extension_connection: AtomicU64,
    /// The time of the last "ready" event of the engine, and the wait before the next restart.
    engine_restart: Mutex<(Option<Instant>, Duration)>,
}

/// The time between leaving a call and the automatic stop. A rejoin in this time cancels the stop.
const CALL_END_GRACE_MS: i64 = 3000;

/// The default of the `mcp_enabled` setting. The user turns MCP access on.
pub const MCP_ENABLED_DEFAULT: &str = "false";

/// The first and the longest wait before the app restarts an engine that stopped.
const ENGINE_RESTART_MIN: Duration = Duration::from_secs(1);
const ENGINE_RESTART_MAX: Duration = Duration::from_secs(60);
/// An engine that runs this long before it stops restarts after `ENGINE_RESTART_MIN` again.
const ENGINE_STABLE: Duration = Duration::from_secs(60);

/// Clears a flag when it goes out of scope.
struct FlagGuard<'a>(&'a AtomicBool);

impl Drop for FlagGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
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

    /// Refuses a change to a meeting while it records or while the final pass runs.
    /// With `summary`, it also refuses the change while a summary is in progress.
    pub fn check_idle(&self, id: &str, summary: bool) -> Result<()> {
        if self.active.lock().unwrap().as_ref().map(|a| a.meeting_id == id).unwrap_or(false) {
            bail!("stop the recording first");
        }
        if self.finalizing.lock().unwrap().contains(id) {
            bail!("wait until Tinta finishes processing this meeting");
        }
        if summary && self.summarizing.lock().unwrap().contains(id) {
            bail!("wait for the summary to finish");
        }
        Ok(())
    }

    fn audio_params(&self, id: &str) -> Value {
        json!({"dir": paths::meeting_dir(id).to_string_lossy(), "audio_key": self.keys.audio_base64()})
    }

    // MARK: Recording

    pub fn start_recording(&self, id: &str, source: &str) -> Result<Active> {
        {
            let active = self.active.lock().unwrap();
            if active.is_some() || self.starting.swap(true, Ordering::SeqCst) {
                bail!("a recording is already active");
            }
        }
        let _starting = FlagGuard(&self.starting);
        let meeting = self.db.lock().unwrap().meeting(id)?;
        if meeting.started_at.is_some() {
            bail!("this meeting already has a recording. Create a new meeting.");
        }
        let call = self.calls.lock().unwrap().iter().find(|c| c.app == source).cloned();
        let app_call = call.as_ref().map(|c| c.app.clone());
        let mut extension = self.extension.lock().unwrap().clone();
        // A Meet call in Chrome does not belong to a recording of a desktop app call.
        if app_call.is_some() {
            extension = ExtensionState::default();
        }
        let mut params = self.audio_params(id);
        params["source"] = json!(source);
        params["mic_muted"] = json!(
            (extension.meeting_code.is_some() && extension.mic_muted == Some(true))
                || call.as_ref().map(|c| c.mic_muted == Some(true)).unwrap_or(false)
        );
        let result = self.engine.call("start", params, Duration::from_secs(60))?;
        let start_wall_ms = result["start_wall_ms"].as_i64().unwrap_or_else(now_ms);
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
            if let Some(call) = call.as_ref().filter(|c| !c.participants.is_empty()) {
                db.upsert_participants(id, &call.participants)?;
            }
            db.set_setting("last_source", source)?;
        }
        let active = Active {
            meeting_id: id.to_string(),
            start_wall_ms,
            paused: false,
            source: source.to_string(),
            meeting_code: extension.meeting_code.clone(),
            app_call,
        };
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

    /// Stops the recording and starts the final pass. The final pass also runs when the engine
    /// fails to stop, on the audio that the engine wrote.
    pub fn stop_recording(self: &Arc<Self>) -> Result<String> {
        let Some(active) = self.active.lock().unwrap().take() else { bail!("no recording is active") };
        *self.call_ended.lock().unwrap() = None;
        self.emit("recording", Value::Null);
        let stopped = self.engine.call("stop", json!({}), Duration::from_secs(30));
        self.finalize_stopped(&active.meeting_id);
        stopped?;
        Ok(active.meeting_id)
    }

    /// Marks a meeting as stopped and starts its final pass on a new thread.
    fn finalize_stopped(self: &Arc<Self>, id: &str) {
        let marked = self.db.lock().unwrap().mark_stopped(id);
        self.meeting_changed(id);
        if marked.is_ok() {
            let state = self.clone();
            let id = id.to_string();
            std::thread::spawn(move || state.finalize_logged(&id, None));
        }
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
        // An event holds at most `EVENT_HOLD_SECONDS`, so events farther from the turn do not change the result.
        let margin = (naming::EVENT_HOLD_SECONDS * 1000.0) as i64 + 1000;
        let from = start_wall_ms + (s * 1000.0) as i64 - margin;
        let to = start_wall_ms + (e * 1000.0) as i64 + margin;
        let events = db.speaker_events_between(meeting_id, from, to).ok()?;
        let highlights = naming::highlights(&events, start_wall_ms, &exclude);
        let participant = naming::live_participant(&highlights, s, e)?;
        participants.into_iter().find(|p| p.participant_id == participant).map(|p| p.name)
    }

    /// Handles an event from the engine. The self-test also sends simulated events.
    pub fn on_engine_event(self: &Arc<Self>, mut event: Value) {
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
            "call_started" => {
                if let Some(call) = AppCall::parse(&event) {
                    self.on_call_started(call);
                }
            }
            "call_state" => {
                let Some(app) = event["app"].as_str() else { return };
                self.on_call_state(app, &event);
            }
            "call_ended" => {
                let Some(app) = event["app"].as_str() else { return };
                let name = event["name"].as_str().unwrap_or(app);
                self.on_call_ended(app, name, event["left_at"].as_i64().unwrap_or_else(now_ms).min(now_ms()));
            }
            "engine_exit" => {
                self.calls.lock().unwrap().clear();
                self.emit("calls", json!([]));
                self.emit("engine", event);
                self.on_recording_lost();
                watch_calls(self.next_restart_delay());
            }
            "ready" => {
                self.engine_restart.lock().unwrap().0 = Some(Instant::now());
                self.emit("engine", event);
            }
            kind @ ("finalize_progress" | "summary_progress") => {
                // The event has no meeting ID. It belongs to a meeting only when one call of its kind runs.
                let running = if kind == "finalize_progress" { &self.finalizing } else { &self.summarizing };
                let running = running.lock().unwrap();
                if running.len() == 1 {
                    event["id"] = json!(running.iter().next());
                }
                drop(running);
                self.emit("engine", event);
            }
            _ => self.emit("engine", event),
        }
    }

    /// The engine stopped during a recording. The final pass runs on the audio that the engine wrote.
    fn on_recording_lost(self: &Arc<Self>) {
        let Some(active) = self.active.lock().unwrap().take() else { return };
        *self.call_ended.lock().unwrap() = None;
        self.emit("recording", Value::Null);
        self.emit("recording_lost", json!({"id": active.meeting_id}));
        self.finalize_stopped(&active.meeting_id);
    }

    /// The wait before the next engine restart. It doubles after each short run of the engine.
    fn next_restart_delay(&self) -> Duration {
        let mut restart = self.engine_restart.lock().unwrap();
        let stable = restart.0.take().map(|t| t.elapsed() >= ENGINE_STABLE).unwrap_or(false);
        let delay = if stable { ENGINE_RESTART_MIN } else { restart.1 };
        restart.1 = (delay * 2).min(ENGINE_RESTART_MAX);
        delay
    }

    // MARK: Desktop app calls

    fn on_call_started(&self, call: AppCall) {
        let app = call.app.clone();
        let calls = {
            let mut calls = self.calls.lock().unwrap();
            calls.retain(|c| c.app != app);
            calls.push(call);
            calls.clone()
        };
        self.emit("calls", json!(calls));
        // A rejoin in the grace time cancels the automatic stop.
        let mut call_ended = self.call_ended.lock().unwrap();
        if call_ended.as_ref().map(|(c, _)| *c == app).unwrap_or(false) {
            *call_ended = None;
        }
        drop(call_ended);
        // A recording that started before the call joins the call.
        let mut active = self.active.lock().unwrap();
        if let Some(current) = active.as_mut().filter(|a| a.source == app && a.meeting_code.is_none()) {
            current.app_call = Some(app);
            self.emit("recording", json!(current.clone()));
        }
    }

    /// The participants, the active speaker, and the microphone state that the engine reads from the app.
    /// The engine sends the state when it changes, and every few seconds.
    fn on_call_state(&self, app: &str, event: &Value) {
        let t = event["t"].as_i64().unwrap_or_else(now_ms);
        let mut participants = parse_participants(&event["participants"]);
        mark_self(&mut participants, &self.self_name());
        let speaking = parse_names(&event["speaking"]);
        let muted = event["mic_muted"].as_bool();
        let (calls, muted_before) = {
            let mut calls = self.calls.lock().unwrap();
            let Some(call) = calls.iter_mut().find(|c| c.app == app) else { return };
            let before = call.mic_muted;
            call.participants = participants.clone();
            call.speaking = speaking.clone();
            call.mic_muted = muted;
            (calls.clone(), before)
        };
        self.emit("calls", json!(calls));
        let Some(active) = self.active.lock().unwrap().clone() else { return };
        if active.app_call.as_deref() != Some(app) {
            return;
        }
        {
            let db = self.db.lock().unwrap();
            let _ = db.upsert_participants(&active.meeting_id, &participants);
            if !active.paused {
                let _ = db.add_speaker_event(&active.meeting_id, t, &speaking);
            }
        }
        if let Some(muted) = muted.filter(|m| Some(*m) != muted_before) {
            // This runs on the engine reader thread, which must stay free to read the reply.
            let engine = self.engine.clone();
            std::thread::spawn(move || {
                let _ = engine.call("mic_muted", json!({"muted": muted, "t": t}), Duration::from_secs(5));
            });
        }
    }

    fn on_call_ended(&self, app: &str, name: &str, left_at: i64) {
        let calls = {
            let mut calls = self.calls.lock().unwrap();
            calls.retain(|c| c.app != app);
            calls.clone()
        };
        self.emit("calls", json!(calls));
        let active = self.active.lock().unwrap().clone();
        if let Some(active) = active.filter(|a| a.app_call.as_deref() == Some(app)) {
            self.schedule_auto_stop(&active.meeting_id, app, name, left_at);
        }
    }

    // MARK: Final pass

    /// Runs the final pass on this thread. The result is in the meeting state.
    pub fn finalize_logged(self: &Arc<Self>, id: &str, language: Option<String>) {
        let _ = self.finalize(id, language);
    }

    /// Runs the final pass. A failure after the pre-checks sets the meeting state to failed.
    pub fn finalize(self: &Arc<Self>, id: &str, language: Option<String>) -> Result<()> {
        let guard = self.begin_finalize(id)?;
        self.run_finalize(guard, language)
    }

    /// Reserves the final pass of a meeting and sets the state to processing.
    /// An error here does not change the meeting.
    pub fn begin_finalize(self: &Arc<Self>, id: &str) -> Result<FinalizeGuard> {
        if !self.finalizing.lock().unwrap().insert(id.to_string()) {
            bail!("Tinta already processes this meeting");
        }
        let guard = FinalizeGuard { state: self.clone(), id: id.to_string() };
        {
            let db = self.db.lock().unwrap();
            if db.has_edits(id)? {
                bail!("the transcript has edits. Processing again does not overwrite them.");
            }
            db.set_state(id, "processing", None)?;
        }
        self.meeting_changed(id);
        Ok(guard)
    }

    /// Runs a final pass that `begin_finalize` reserved. A failure sets the state to failed.
    /// After a shutdown, the meeting stays in processing, and the next start of the app runs the final pass again.
    pub fn run_finalize(self: &Arc<Self>, guard: FinalizeGuard, language: Option<String>) -> Result<()> {
        let id = guard.id.clone();
        let result = self.final_pass(&id, language);
        if let Err(error) = &result {
            if !self.engine.is_shut_down() {
                let _ = self.db.lock().unwrap().set_state(&id, "failed", Some(&error.to_string()));
            }
            drop(guard);
            self.meeting_changed(&id);
        }
        result
    }

    fn final_pass(self: &Arc<Self>, id: &str, language: Option<String>) -> Result<()> {
        let (participants, events, start_wall_ms) = {
            let db = self.db.lock().unwrap();
            (db.participants(id)?, db.speaker_events(id)?, db.start_wall_ms(id)?)
        };
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
        if self.setting("auto_summary", "true") == "true" && self.summaries_available() {
            let state = self.clone();
            let id = id.to_string();
            std::thread::spawn(move || state.summarize_logged(&id));
        }
        Ok(())
    }

    // MARK: Summaries

    pub fn summaries_available(&self) -> bool {
        let status = self.engine.call("summary_status", json!({}), Duration::from_secs(10));
        status.map(|s| s["available"].as_bool().unwrap_or(false)).unwrap_or(false)
    }

    /// Writes a summary and reports the result to the window.
    pub fn summarize_logged(self: &Arc<Self>, id: &str) {
        let result = self.summarize(id);
        self.meeting_changed(id);
        let error = result.err().map(|e| e.to_string());
        self.emit("summary", json!({"id": id, "error": error}));
    }

    /// Writes a summary from the notes and the transcript with the local model.
    pub fn summarize(self: &Arc<Self>, id: &str) -> Result<()> {
        if !self.summarizing.lock().unwrap().insert(id.to_string()) {
            bail!("a summary for this meeting is already in progress");
        }
        let _guard = SummaryGuard { state: self.clone(), id: id.to_string() };
        self.meeting_changed(id);
        let doc = tinta_core::export::Document::load(&self.db.lock().unwrap(), id)?;
        let names = doc.names();
        let lines: Vec<String> = doc
            .turns
            .iter()
            .map(|t| {
                let name = doc.speaker_name(&names, t);
                if doc.timed() {
                    format!("[{}] {name}: {}", tinta_core::export::timestamp(t.start, '.', false), t.text)
                } else {
                    format!("{name}: {}", t.text)
                }
            })
            .collect();
        let params = json!({
            "title": doc.meeting.title,
            "notes": doc.notes,
            "lines": lines,
            "language": doc.meeting.language.clone().unwrap_or_else(|| "en".into()),
        });
        let result = self.engine.call("summarize", params, Duration::from_secs(20 * 60))?;
        let summary = result["summary"].as_str().unwrap_or_default();
        let model = result["model"].as_str().unwrap_or("local model");
        let db = self.db.lock().unwrap();
        db.meeting(id)?;
        db.set_summary(id, summary, model, tinta_core::db::Origin::User)
    }

    // MARK: Extension messages

    /// Handles a message from the Meet extension. The code takes one lock at a time.
    pub fn on_extension_message(&self, message: &Value) -> Value {
        let t = message["t"].as_i64().unwrap_or_else(now_ms);
        let code = message["meeting_code"].as_str().map(str::to_string);
        let kind = message["type"].as_str().unwrap_or_default();
        let active = self.active.lock().unwrap().clone();
        let own = (kind == "meet_state" && message["self_name"].as_str().is_none()).then(|| self.self_name());
        let mut mute_change = None;
        let mut ended = None;
        let mut store_participants = None;
        let mut store_speakers = None;
        let snapshot = {
            let mut ext = self.extension.lock().unwrap();
            let muted_before = ext.mic_muted;
            if ext.connected_at.is_none() {
                ext.connected_at = Some(now_ms());
            }
            ext.last_seen = Some(now_ms());
            match kind {
                "meet_state" => {
                    ext.meeting_code = code.clone();
                    ext.title = message["title"].as_str().map(str::to_string);
                    ext.self_name = message["self_name"].as_str().map(str::to_string);
                    ext.participants = parse_participants(&message["participants"]);
                    let own = ext.self_name.clone().or(own).unwrap_or_default();
                    mark_self(&mut ext.participants, &own);
                    ext.mic_muted = message["mic_muted"].as_bool();
                    store_participants = Some(ext.participants.clone());
                }
                "active_speakers" => {
                    ext.speaking = parse_names(&message["speaking"]);
                    store_speakers = Some(ext.speaking.clone());
                }
                "mic_state" => ext.mic_muted = message["muted"].as_bool(),
                "ping" => {}
                "meeting_ended" => {
                    ended = code.clone().or_else(|| ext.meeting_code.clone());
                    ext.mic_muted = None;
                    ext.meeting_code = None;
                    ext.speaking.clear();
                    ext.participants.clear();
                    ext.title = None;
                }
                _ => {}
            }
            if ext.mic_muted != muted_before && ext.meeting_code.is_some() {
                mute_change = ext.mic_muted;
            }
            ext.clone()
        };
        self.emit("extension", json!(snapshot));
        // Any message from the call cancels the automatic stop of the call, except its end.
        if ended.is_none() && code.is_some() {
            let mut call_ended = self.call_ended.lock().unwrap();
            if call_ended.as_ref().map(|(c, _)| Some(c) == code.as_ref()).unwrap_or(false) {
                *call_ended = None;
            }
        }
        if let Some(active) = &active {
            if let Some(participants) = &store_participants {
                let _ = self.db.lock().unwrap().upsert_participants(&active.meeting_id, participants);
            }
            if let Some(speaking) = store_speakers.as_ref().filter(|_| !active.paused) {
                let _ = self.db.lock().unwrap().add_speaker_event(&active.meeting_id, t, speaking);
            }
        }
        if let Some(name) = snapshot.self_name.as_ref().filter(|_| kind == "meet_state") {
            let db = self.db.lock().unwrap();
            if matches!(db.setting("self_name"), Ok(None)) {
                let _ = db.set_setting("self_name", name);
            }
        }
        // A recording that started before the call joins the call at its first state message.
        let mut active = active;
        if let Some(current) = active.as_mut().filter(|a| a.meeting_code.is_none() && a.app_call.is_none() && code.is_some()) {
            if kind == "meet_state" {
                current.meeting_code = code.clone();
                if let Some(stored) = self.active.lock().unwrap().as_mut().filter(|a| a.meeting_id == current.meeting_id) {
                    stored.meeting_code = code.clone();
                }
                mute_change = message["mic_muted"].as_bool();
            }
        }
        if let Some(active) = active.as_ref().filter(|a| a.meeting_code.is_some() && a.meeting_code == code) {
            if let Some(muted) = mute_change {
                let _ = self.engine.call("mic_muted", json!({"muted": muted, "t": t}), Duration::from_secs(5));
            }
            if let Some(code) = &ended {
                let left_at = message["left_at"].as_i64().unwrap_or(t).min(now_ms());
                self.schedule_auto_stop(&active.meeting_id, code, "Meet", left_at);
            }
        }
        json!({
            "recording": active.as_ref().map(|a| !a.paused).unwrap_or(false),
            "recording_since": active.as_ref().map(|a| a.start_wall_ms),
        })
    }

    /// Stops the recording after a grace time when its call ends, unless the user rejoins.
    /// `call` is the Meet meeting code or the desktop app bundle ID, and `name` is the name of the call app.
    fn schedule_auto_stop(&self, meeting_id: &str, call: &str, name: &str, left_at: i64) {
        if self.setting("auto_stop", "true") != "true" {
            return;
        }
        let entry = (call.to_string(), now_ms());
        *self.call_ended.lock().unwrap() = Some(entry.clone());
        let meeting_id = meeting_id.to_string();
        let name = name.to_string();
        std::thread::spawn(move || {
            let wait = (left_at + CALL_END_GRACE_MS - now_ms()).max(0) as u64;
            std::thread::sleep(Duration::from_millis(wait));
            let state = state();
            if *state.call_ended.lock().unwrap() != Some(entry) {
                return;
            }
            let same = state.active.lock().unwrap().as_ref().map(|a| a.meeting_id == meeting_id).unwrap_or(false);
            if same && state.stop_recording().is_ok() {
                state.emit("auto_stopped", json!({"id": meeting_id, "app": name}));
            }
        });
    }

    /// Registers a new native host connection and returns its number.
    pub fn extension_connected(&self) -> u64 {
        self.extension_connection.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Chrome closed or the native host stopped. An active Meet call counts as ended.
    /// A disconnection of an older connection does not change the call.
    pub fn on_extension_disconnected(&self, connection: u64) {
        if self.extension_connection.load(Ordering::SeqCst) != connection {
            return;
        }
        let code = self.extension.lock().unwrap().meeting_code.clone();
        if let Some(code) = code {
            self.on_extension_message(&json!({"type": "meeting_ended", "meeting_code": code}));
        }
    }

    // MARK: Library location

    /// Moves the library and the audio to `<parent>/Tinta` and opens it there.
    pub fn move_library(&self, parent: &std::path::Path) -> Result<std::path::PathBuf> {
        if self.active.lock().unwrap().is_some() || !self.finalizing.lock().unwrap().is_empty() {
            bail!("Stop the recording and wait until processing finishes before you move the library.");
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
        let meetings = current.join("meetings");
        let copy = || -> Result<Db> {
            db.checkpoint()?;
            std::fs::copy(current.join("library.db"), target.join("library.db"))?;
            if meetings.exists() {
                copy_dir(&meetings, &target.join("meetings"))?;
            }
            let moved = Db::open(&target.join("library.db"), &self.keys)?;
            paths::set_data_dir(&target)?;
            Ok(moved)
        };
        let moved = match copy() {
            Ok(moved) => moved,
            Err(error) => {
                // The target was empty before, so the partial copy goes.
                let _ = std::fs::remove_dir_all(&target);
                return Err(error);
            }
        };
        *db = moved;
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
        for id in audio.into_iter().filter(|id| self.check_idle(id, false).is_ok()) {
            let _ = self.delete_audio_files(&id);
            self.meeting_changed(&id);
        }
        for id in trash.into_iter().filter(|id| self.check_idle(id, true).is_ok()) {
            self.delete_meeting_files(&id);
            let _ = self.db.lock().unwrap().delete_meeting_now(&id);
        }
    }
}

pub(crate) fn copy_dir(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
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

/// A reserved final pass. The reservation ends when the guard goes out of scope.
pub struct FinalizeGuard {
    state: Arc<AppState>,
    id: String,
}

struct SummaryGuard {
    state: Arc<AppState>,
    id: String,
}

impl Drop for SummaryGuard {
    fn drop(&mut self) {
        self.state.summarizing.lock().unwrap().remove(&self.id);
    }
}

impl Drop for FinalizeGuard {
    fn drop(&mut self) {
        self.state.finalizing.lock().unwrap().remove(&self.id);
    }
}

/// Starts the engine after `delay`. The engine watches for desktop app calls. The app sends the reading setting and reads the current calls.
/// The engine reader thread calls this after the engine stops, so the call runs on its own thread.
pub fn watch_calls(delay: Duration) {
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        let state = state();
        let read = state.setting("call_reading", "false") == "true";
        let Ok(result) = state.engine.call("calls", json!({"read": read}), Duration::from_secs(20)) else { return };
        let calls: Vec<AppCall> =
            result["calls"].as_array().map(|list| list.iter().filter_map(AppCall::parse).collect()).unwrap_or_default();
        let known: HashSet<String> = state.calls.lock().unwrap().iter().map(|c| c.app.clone()).collect();
        for call in calls.into_iter().filter(|c| !known.contains(&c.app)) {
            state.on_call_started(call);
        }
    });
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
        calls: Mutex::new(Vec::new()),
        finalizing: Mutex::new(HashSet::new()),
        summarizing: Mutex::new(HashSet::new()),
        call_ended: Mutex::new(None),
        starting: AtomicBool::new(false),
        extension_connection: AtomicU64::new(0),
        engine_restart: Mutex::new((None, ENGINE_RESTART_MIN)),
    });
    let _ = STATE.set(state.clone());
    watch_calls(ENGINE_RESTART_MIN);
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
        .run(|_, event| {
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                if let Some(state) = STATE.get() {
                    if state.active.lock().unwrap().is_some() {
                        let _ = state.stop_recording();
                    }
                    state.engine.shutdown();
                }
                let _ = std::fs::remove_file(paths::socket_path());
            }
        });
}
