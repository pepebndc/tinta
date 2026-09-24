//! End-to-end self-test without the window. It builds a synthetic three-person meeting
//! with the macOS `say` voices, simulates Meet active-speaker events, runs the final pass,
//! and checks names, export, MCP tools, undo, trash, audio retention, and a simulated Zoom call.
//!
//! Run: `TINTA_DATA_DIR=$(mktemp -d) cargo run -p tinta-selftest`

use anyhow::{bail, Context, Result};
use tinta_core::db::{Origin, Participant};
use tinta_core::{export, now_ms, paths, tools};
use serde_json::json;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

const SCRIPT: &[(&str, &str, &str)] = &[
    ("Daniel", "daniel", "Good morning everyone. Today we review the audit schedule for the new lending protocol."),
    ("Samantha", "sam", "Thanks Daniel. I finished the report on the oracle integration yesterday afternoon."),
    ("Daniel", "daniel", "Great. Did you find any critical issues in the liquidation logic?"),
    ("Samantha", "sam", "One medium issue. The price feed can be stale for up to one hour during high volatility."),
    ("Karen", "karen", "I can take a look at that fix tomorrow morning if you send me the details."),
    ("Daniel", "daniel", "Perfect. Let us meet again on Thursday to confirm the plan."),
];

fn pcm(path: &Path) -> Result<Vec<u8>> {
    let data = std::fs::read(path)?;
    let mut i = 12;
    while i + 8 <= data.len() {
        let id = &data[i..i + 4];
        let size = u32::from_le_bytes(data[i + 4..i + 8].try_into()?) as usize;
        if id == b"data" {
            return Ok(data[i + 8..(i + 8 + size).min(data.len())].to_vec());
        }
        i += 8 + size + (size & 1);
    }
    bail!("no data chunk in {}", path.display())
}

fn wav(samples: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + samples.len() as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&16000u32.to_le_bytes());
    out.extend_from_slice(&32000u32.to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(samples.len() as u32).to_le_bytes());
    out.extend_from_slice(samples);
    out
}

/// Builds the meeting WAV and returns (path, [(participant, start, end)]).
fn build_audio(dir: &Path) -> Result<(std::path::PathBuf, Vec<(String, f64, f64)>)> {
    let mut all = Vec::new();
    let mut spans = Vec::new();
    for (index, (voice, participant, text)) in SCRIPT.iter().enumerate() {
        let file = dir.join(format!("seg{index}.wav"));
        let status = Command::new("/usr/bin/say")
            .args(["-v", voice, "--data-format=LEI16@16000", "-o"])
            .arg(&file)
            .arg(text)
            .status()?;
        if !status.success() {
            bail!("say failed for voice {voice}");
        }
        let start = all.len() as f64 / 32000.0;
        all.extend(pcm(&file)?);
        spans.push((participant.to_string(), start, all.len() as f64 / 32000.0));
        all.extend(vec![0u8; 16000]);
    }
    let path = dir.join("meeting.wav");
    std::fs::write(&path, wav(&all))?;
    Ok((path, spans))
}

fn check(ok: bool, label: &str, failures: &mut Vec<String>) {
    println!("{} {label}", if ok { "PASS" } else { "FAIL" });
    if !ok {
        failures.push(label.to_string());
    }
}

/// Simulates the engine events of a Zoom call during a recording: the call start, the participants
/// and the active speaker from the app window, a mute, and the call end.
fn desktop_call(state: &std::sync::Arc<tinta_app::AppState>, failures: &mut Vec<String>) -> Result<()> {
    const ZOOM: &str = "us.zoom.xos";
    state.db.lock().unwrap().set_setting("self_name", "Test User")?;
    state.db.lock().unwrap().set_setting("auto_stop", "true")?;
    state.on_engine_event(json!({"event": "call_started", "app": ZOOM, "name": "Zoom", "since": now_ms()}));
    check(state.calls.lock().unwrap().iter().any(|c| c.app == ZOOM), "a Zoom call is detected", failures);

    let t0 = now_ms();
    let id = {
        let db = state.db.lock().unwrap();
        let m = db.create_meeting("Zoom self-test", Some("selftest"))?;
        db.mark_started(&m.id, t0, None)?;
        m.id
    };
    *state.active.lock().unwrap() = Some(tinta_app::Active {
        meeting_id: id.clone(),
        start_wall_ms: t0,
        paused: false,
        source: ZOOM.into(),
        meeting_code: None,
        app_call: Some(ZOOM.into()),
    });
    let participants = json!([
        {"id": "Test User", "name": "Test User", "is_self": false},
        {"id": "Ada Lovelace", "name": "Ada Lovelace", "is_self": false},
    ]);
    for (offset, speaking, muted) in [(0, json!([]), false), (1000, json!(["Ada Lovelace"]), false), (2000, json!(["Ada Lovelace"]), true)] {
        state.on_engine_event(json!({
            "event": "call_state", "app": ZOOM, "t": t0 + offset,
            "participants": participants, "speaking": speaking, "mic_muted": muted,
        }));
    }
    {
        let db = state.db.lock().unwrap();
        let stored = db.participants(&id)?;
        check(
            stored.len() == 2 && stored.iter().any(|p| p.name == "Test User" && p.is_self),
            "Zoom participants are stored, and the user is found by name",
            failures,
        );
        let events = db.speaker_events(&id)?;
        check(events.iter().any(|(_, s)| s == &vec!["Ada Lovelace".to_string()]), "Zoom speaker events are stored", failures);
    }
    check(
        state.calls.lock().unwrap().iter().any(|c| c.app == ZOOM && c.mic_muted == Some(true)),
        "the Zoom mute state is read",
        failures,
    );

    state.on_engine_event(json!({"event": "call_ended", "app": ZOOM, "name": "Zoom", "left_at": now_ms()}));
    std::thread::sleep(Duration::from_millis(3800));
    check(state.active.lock().unwrap().is_none(), "the recording stops after the Zoom call ends", failures);
    check(state.calls.lock().unwrap().is_empty(), "the ended Zoom call is removed", failures);
    Ok(())
}

fn main() -> Result<()> {
    if std::env::var_os("TINTA_DATA_DIR").is_none() {
        bail!("set TINTA_DATA_DIR to an empty test folder");
    }
    let state = tinta_app::init(None)?;
    let work = paths::data_dir().join("selftest");
    std::fs::create_dir_all(&work)?;
    let (audio, spans) = build_audio(&work)?;
    let mut failures = Vec::new();

    // Meeting with Meet metadata. Meet highlights each speaker 0.6 s late.
    let t0 = now_ms();
    let id = {
        let db = state.db.lock().unwrap();
        let m = db.create_meeting("Self-test meeting", Some("selftest"))?;
        db.mark_started(&m.id, t0, Some("abc-defg-hij"))?;
        db.upsert_participants(
            &m.id,
            &[
                Participant { participant_id: "me".into(), name: "Test User".into(), is_self: true },
                Participant { participant_id: "daniel".into(), name: "Daniel Cooper".into(), is_self: false },
                Participant { participant_id: "sam".into(), name: "Samantha Lee".into(), is_self: false },
                Participant { participant_id: "karen".into(), name: "Karen Walsh".into(), is_self: false },
            ],
        )?;
        for (participant, start, end) in &spans {
            db.add_speaker_event(&m.id, t0 + ((start + 0.6) * 1000.0) as i64, &[participant.clone()])?;
            db.add_speaker_event(&m.id, t0 + ((end + 0.6) * 1000.0) as i64, &[])?;
        }
        m.id
    };

    let params = json!({
        "dir": paths::meeting_dir(&id).to_string_lossy(),
        "audio_key": state.keys.audio_base64(),
        "path": audio,
    });
    state.engine.call("import_audio", params, Duration::from_secs(120)).context("import")?;
    state.db.lock().unwrap().mark_stopped(&id)?;
    let started = std::time::Instant::now();
    // The self-test writes the summary itself, so the automatic summary stays off.
    state.db.lock().unwrap().set_setting("auto_summary", "false")?;
    state.finalize(&id, None).context("final pass")?;
    println!("final pass: {:.1} s for {:.1} s of audio", started.elapsed().as_secs_f64(), spans.last().unwrap().2);

    let names = [("daniel", "Daniel Cooper"), ("sam", "Samantha Lee"), ("karen", "Karen Walsh")];
    let (correct, named, total) = {
        let db = state.db.lock().unwrap();
        let doc = export::Document::load(&db, &id)?;
        let display = doc.names();
        let mut correct = 0.0;
        let mut named = 0.0;
        let mut total = 0.0;
        for turn in &doc.turns {
            let speaker = turn.speaker_id.as_ref().and_then(|s| doc.speakers.iter().find(|x| &x.id == s));
            let got = speaker.and_then(|s| s.name.clone());
            // Split each turn over the true speaker spans, so a merged turn counts as partly wrong.
            for (participant, s, e) in &spans {
                let overlap = (turn.end.min(*e) - turn.start.max(*s)).max(0.0);
                if overlap <= 0.0 {
                    continue;
                }
                let expected = names.iter().find(|(k, _)| k == participant).map(|(_, n)| *n);
                total += overlap;
                if got.is_some() {
                    named += overlap;
                    if got.as_deref() == expected {
                        correct += overlap;
                    }
                }
            }
            println!(
                "  [{:>5.1}] {:<14} {}",
                turn.start,
                turn.speaker_id.as_ref().and_then(|s| display.get(s)).cloned().unwrap_or_default(),
                turn.text
            );
        }
        (correct, named, total)
    };
    let precision = if named > 0.0 { correct / named } else { 0.0 };
    let coverage = named / total.max(0.001);
    println!("names: precision {:.0}% by speaking time, coverage {:.0}%", precision * 100.0, coverage * 100.0);
    // Synthetic voices are harder to separate than real voices, so the self-test checks the
    // pipeline, not the 95% pilot target.
    check(precision >= 0.7, "Meet events name the separated speakers", &mut failures);
    check(coverage >= 0.5, "names cover at least half of the speech", &mut failures);

    if state.summaries_available() {
        let started = std::time::Instant::now();
        let written = state.summarize(&id);
        let summary = state.db.lock().unwrap().summary(&id)?;
        println!("summary ({:.1} s):\n{}", started.elapsed().as_secs_f64(), summary.as_ref().map(|s| s.content.as_str()).unwrap_or(""));
        check(written.is_ok() && summary.is_some(), "the on-device model writes a summary", &mut failures);
    } else {
        println!("SKIP the on-device model is not available");
    }

    let markdown = {
        let db = state.db.lock().unwrap();
        export::render(&export::Document::load(&db, &id)?, "md")?
    };
    check(markdown.contains("lending protocol"), "Markdown export contains the transcript", &mut failures);
    if state.summaries_available() {
        check(markdown.contains("## Summary"), "Markdown export contains the summary", &mut failures);
    }
    let srt = {
        let db = state.db.lock().unwrap();
        export::render(&export::Document::load(&db, &id)?, "srt")?
    };
    check(srt.starts_with("1\n00:00:0"), "SRT export has timed cues", &mut failures);

    {
        let db = state.db.lock().unwrap();
        let (hits, _) = tools::call(&db, "search_meetings", &json!({"query": "oracle"}))?;
        check(hits["results"].as_array().map(|a| !a.is_empty()).unwrap_or(false), "MCP search finds the transcript", &mut failures);
        let (page, _) = tools::call(&db, "get_transcript", &json!({"meeting_id": id, "page_size": 10}))?;
        check(page["turns"].as_array().map(|a| !a.is_empty()).unwrap_or(false), "MCP get_transcript returns turns", &mut failures);
        db.set_notes(&id, "My notes", Origin::User)?;
        tools::call(&db, "edit_notes", &json!({"meeting_id": id, "content": "Changed by MCP"}))?;
        let revision = db.revisions(Some(Origin::Mcp), 1)?;
        db.undo(revision[0].id)?;
        check(db.notes(&id)? == "My notes", "undo restores notes after an MCP edit", &mut failures);
        let short = &id[..8];
        let (meeting, _) = tools::call(&db, "get_meeting", &json!({"meeting_id": short}))?;
        check(meeting["meeting"]["id"] == json!(id), "MCP finds a meeting by the first 8 characters of its ID", &mut failures);
        let before = db.summary(&id)?.map(|s| s.content);
        tools::call(&db, "update_summary", &json!({"meeting_id": id, "content": "Summary from MCP"}))?;
        let (read, _) = tools::call(&db, "get_summary", &json!({"meeting_id": id}))?;
        check(
            read["summary"]["content"] == "Summary from MCP" && read["summary"]["written_by"] == "MCP client",
            "MCP updates and reads the summary",
            &mut failures,
        );
        let revision = db.revisions(Some(Origin::Mcp), 1)?;
        db.undo(revision[0].id)?;
        check(db.summary(&id)?.map(|s| s.content) == before, "undo restores the summary after an MCP update", &mut failures);
        tools::call(&db, "delete_meeting", &json!({"meeting_id": id}))?;
        check(db.meetings(true)?.is_empty() && db.trash()?.len() == 1, "MCP delete moves the meeting to the trash", &mut failures);
        db.restore(&id)?;
        db.set_audio_retention(&id, 0, Origin::User)?;
    }
    state.run_retention();
    let audio_gone = !paths::audio_dir(&id).exists() && state.db.lock().unwrap().meeting(&id)?.audio_deleted;
    check(audio_gone, "retention deletes expired audio", &mut failures);

    let before = state.db.lock().unwrap().meetings(true)?.len();
    let parent = paths::base_dir().join("moved-here");
    std::fs::create_dir_all(&parent)?;
    let moved = state.move_library(&parent)?;
    let after = state.db.lock().unwrap().meetings(true)?.len();
    check(
        moved == parent.join("Tinta") && paths::data_dir() == moved && after == before && moved.join("library.db").exists(),
        "moving the library keeps every meeting",
        &mut failures,
    );
    let cloud = std::path::Path::new("/Users/someone/Library/Mobile Documents/com~apple~CloudDocs");
    check(state.move_library(cloud).is_err(), "cloud-synced folders are refused", &mut failures);

    desktop_call(&state, &mut failures)?;

    state.engine.shutdown();
    if failures.is_empty() {
        println!("All checks passed.");
        Ok(())
    } else {
        bail!("{} checks failed: {}", failures.len(), failures.join("; "))
    }
}
