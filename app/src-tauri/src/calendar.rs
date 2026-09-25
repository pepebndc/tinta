//! The next meetings from the calendars on this Mac, and the reminders before they start.
//!
//! The engine reads the calendars with EventKit. The app reads them again when the engine reports a change,
//! when the window gets the focus, and every few minutes.

use crate::{notify, state, system, AppState};
use anyhow::{anyhow, Result};
use serde_json::json;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;
use tinta_core::calendar::{Event, Snapshot};
use tinta_core::now_ms;

/// The number of days of events that the app reads.
const DAYS: i64 = 7;
/// The longest time between two reads of the calendars.
const REFRESH_MS: i64 = 5 * 60_000;
/// The time between two checks for reminders.
const TICK: Duration = Duration::from_secs(15);
/// The time before the start of a meeting when the reminder shows.
const REMINDER_LEAD_MS: i64 = 60_000;
/// A reminder for a meeting that started this long ago still shows, for example after the Mac wakes up.
const REMINDER_LATE_MS: i64 = 5 * 60_000;
/// The setting with the IDs of the calendars that the user hides, as a JSON list.
const HIDDEN_SETTING: &str = "calendar_hidden";

#[derive(Default)]
pub struct CalendarState {
    snapshot: Snapshot,
    /// The time of the last read of the calendars.
    read_at: Option<i64>,
    /// The events that had a reminder.
    reminded: HashSet<String>,
}

impl AppState {
    fn hidden_calendars(&self) -> Vec<String> {
        serde_json::from_str(&self.setting(HIDDEN_SETTING, "[]")).unwrap_or_default()
    }

    /// The events that the window shows: the events that did not end, without the hidden calendars,
    /// with the Tinta meeting of each event.
    pub fn calendar_view(&self) -> Snapshot {
        let hidden = self.hidden_calendars();
        let meetings = self.db.lock().unwrap().event_meetings().unwrap_or_default();
        let mut view = self.calendar.lock().unwrap().snapshot.visible(&hidden);
        let now = now_ms();
        view.events.retain(|e| e.end > now);
        for event in &mut view.events {
            event.meeting_id = meetings.get(&event.id).cloned();
        }
        view
    }

    fn emit_calendar(&self) {
        self.emit("calendar", json!(self.calendar_view()));
    }

    /// Reads the calendars from the engine and sends them to the window.
    pub fn refresh_calendar(&self) -> Result<Snapshot> {
        let value = self.engine.call("calendar", json!({"days": DAYS}), Duration::from_secs(30))?;
        let snapshot = Snapshot::parse(value)?;
        {
            let mut calendar = self.calendar.lock().unwrap();
            calendar.reminded.retain(|id| snapshot.events.iter().any(|e| &e.id == id));
            calendar.snapshot = snapshot;
            calendar.read_at = Some(now_ms());
        }
        let view = self.calendar_view();
        self.emit("calendar", json!(view));
        Ok(view)
    }

    /// Asks macOS for calendar access, and then for permission to show reminders.
    pub fn request_calendar(&self) -> Result<Snapshot> {
        let result = self.engine.call("request_calendar", json!({}), Duration::from_secs(300))?;
        if result["granted"].as_bool() == Some(true) {
            notify::request_permission();
        }
        self.refresh_calendar()
    }

    pub fn set_calendar_hidden(&self, calendar_id: &str, hidden: bool) -> Result<()> {
        let mut ids = self.hidden_calendars();
        ids.retain(|id| id != calendar_id);
        if hidden {
            ids.push(calendar_id.to_string());
        }
        self.db.lock().unwrap().set_setting(HIDDEN_SETTING, &serde_json::to_string(&ids)?)?;
        self.emit_calendar();
        Ok(())
    }

    /// Opens the Tinta meeting of a calendar event, and creates it when the event has none yet.
    /// With `join`, it also opens the call link and starts the recording of the call.
    pub fn open_event(self: &Arc<Self>, event_id: &str, join: bool) -> Result<String> {
        let event = self.calendar_view().events.into_iter().find(|e| e.id == event_id);
        let event = event.ok_or_else(|| anyhow!("the event is not in the calendar now"))?;
        let meeting = self.db.lock().unwrap().meeting_for_event(&event.id, event.display_title())?;
        if let Some(link) = event.link.as_ref().filter(|_| join) {
            let source = system::open_call(link);
            let idle = self.active.lock().unwrap().is_none();
            if meeting.started_at.is_none() && idle {
                match self.start_recording(&meeting.id, &source) {
                    Ok(active) => self.emit("recording", json!(active)),
                    Err(error) => self.emit(
                        "engine",
                        json!({"event": "warning", "message": format!("Tinta did not start the recording: {error}")}),
                    ),
                }
            }
        }
        self.meeting_changed(&meeting.id);
        self.emit_calendar();
        Ok(meeting.id)
    }

    /// A click on a reminder joins the call and shows the meeting in the window.
    fn on_reminder_click(self: &Arc<Self>, event_id: &str) {
        match self.open_event(event_id, true) {
            Ok(id) => self.emit("open_meeting", json!({"id": id})),
            Err(error) => self.emit("engine", json!({"event": "warning", "message": error.to_string()})),
        }
        if let Some(app) = &self.app {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
    }

    /// Shows a reminder for each meeting with a call link that starts now.
    /// A meeting that the user joined or records already gets no reminder.
    fn remind_due(&self) {
        if self.setting("meeting_reminders", "true") != "true" {
            return;
        }
        let now = now_ms();
        let in_call = self.extension.lock().unwrap().meeting_code.clone();
        let due: Vec<Event> = self
            .calendar_view()
            .events
            .into_iter()
            .filter(|e| e.start - now <= REMINDER_LEAD_MS && now - e.start <= REMINDER_LATE_MS)
            .filter(|e| e.link.as_ref().is_some_and(|l| l.code.is_none() || l.code != in_call))
            .filter(|e| !self.calendar.lock().unwrap().reminded.contains(&e.id))
            .filter(|e| {
                let recorded = e.meeting_id.as_ref().map(|id| self.db.lock().unwrap().meeting(id).map(|m| m.started_at.is_some()));
                !matches!(recorded, Some(Ok(true)))
            })
            .collect();
        for event in due {
            self.calendar.lock().unwrap().reminded.insert(event.id.clone());
            let platform = event.link.as_ref().map(|l| l.platform.name()).unwrap_or_default();
            let minutes = ((event.start - now) as f64 / 60_000.0).round() as i64;
            let when = match minutes {
                m if m > 1 => format!("Starts in {m} minutes"),
                1 => "Starts in 1 minute".to_string(),
                0 => "Starts now".to_string(),
                -1 => "Started 1 minute ago".to_string(),
                m => format!("Started {} minutes ago", -m),
            };
            let body = format!("{when} on {platform}. Join to take notes. Tell everyone that you record the call.");
            notify::remind(&event.id, event.display_title(), &body);
        }
    }

    /// Handles a calendar event from the engine. The engine reader thread calls this, so the work runs on its own thread.
    pub fn on_calendar_changed(self: &Arc<Self>) {
        let state = self.clone();
        std::thread::spawn(move || {
            let _ = state.refresh_calendar();
        });
    }
}

/// Registers the reminders, and reads the calendars and checks for reminders on a new thread.
pub fn watch() {
    notify::init(|event_id| {
        std::thread::spawn(move || state().on_reminder_click(&event_id));
    });
    std::thread::spawn(|| {
        let state = state();
        if state.refresh_calendar().map(|s| s.access == "granted").unwrap_or(false) {
            notify::request_permission();
        }
        loop {
            std::thread::sleep(TICK);
            // The wall clock also counts the time while the Mac sleeps.
            let read_at = state.calendar.lock().unwrap().read_at;
            if read_at.map(|t| now_ms() - t >= REFRESH_MS).unwrap_or(true) {
                let _ = state.refresh_calendar();
            }
            state.remind_due();
        }
    });
}
