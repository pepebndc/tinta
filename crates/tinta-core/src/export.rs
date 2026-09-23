//! Export formats: Markdown, JSON, SRT, and VTT.

use crate::db::{Db, Meeting, Speaker, Turn};
use anyhow::{bail, Result};
use serde_json::json;
use std::collections::HashMap;

pub struct Document {
    pub meeting: Meeting,
    pub notes: String,
    pub summary: Option<String>,
    pub speakers: Vec<Speaker>,
    pub turns: Vec<Turn>,
}

impl Document {
    pub fn load(db: &Db, id: &str) -> Result<Self> {
        Ok(Self { meeting: db.meeting(id)?, notes: db.notes(id)?, summary: db.summary(id)?.map(|s| s.content), speakers: db.all_speakers(id)?, turns: db.turns(id)? })
    }

    /// Display name for each speaker ID. Merged speakers show the name of their target.
    pub fn names(&self) -> HashMap<String, String> {
        let mut order: Vec<&Speaker> = self.speakers.iter().filter(|s| s.merged_into.is_none()).collect();
        order.sort_by(|a, b| {
            let first = |s: &Speaker| {
                self.turns
                    .iter()
                    .filter(|t| t.speaker_id.as_deref() == Some(s.id.as_str()))
                    .map(|t| t.start)
                    .fold(f64::MAX, f64::min)
            };
            first(a).total_cmp(&first(b))
        });
        let mut names = HashMap::new();
        let mut unnamed = 0;
        for s in &order {
            let name = match &s.name {
                Some(n) => n.clone(),
                None => {
                    unnamed += 1;
                    format!("Speaker {unnamed}")
                }
            };
            names.insert(s.id.clone(), name);
        }
        for s in self.speakers.iter().filter(|s| s.merged_into.is_some()) {
            if let Some(target) = s.merged_into.as_ref().and_then(|t| names.get(t)).cloned() {
                names.insert(s.id.clone(), target);
            }
        }
        names
    }

    /// Imported meetings from Granola have no timestamps.
    pub fn timed(&self) -> bool {
        self.meeting.source.as_deref() != Some(crate::granola::SOURCE)
    }

    pub fn speaker_name(&self, names: &HashMap<String, String>, turn: &Turn) -> String {
        turn.speaker_id
            .as_ref()
            .and_then(|id| names.get(id).cloned())
            .or_else(|| turn.live_name.clone())
            .unwrap_or_else(|| if turn.track == "mic" { "Me".into() } else { "Remote".into() })
    }
}

pub fn timestamp(seconds: f64, separator: char, hours: bool) -> String {
    let ms = (seconds.max(0.0) * 1000.0).round() as u64;
    let (h, m, s, f) = (ms / 3_600_000, (ms / 60_000) % 60, (ms / 1000) % 60, ms % 1000);
    if hours {
        format!("{h:02}:{m:02}:{s:02}{separator}{f:03}")
    } else {
        format!("{:02}:{s:02}", ms / 60_000)
    }
}

pub fn markdown(doc: &Document) -> String {
    let names = doc.names();
    let mut out = format!("# {}\n\n", doc.meeting.title);
    if let Some(start) = doc.meeting.started_at.or(Some(doc.meeting.created_at)) {
        out.push_str(&format!("Date: {}\n", format_date(start)));
    }
    if !doc.meeting.tags.is_empty() {
        out.push_str(&format!("Tags: {}\n", doc.meeting.tags.join(", ")));
    }
    out.push_str("\n## Notes\n\n");
    out.push_str(if doc.notes.trim().is_empty() { "No notes.\n" } else { doc.notes.trim_end() });
    if let Some(summary) = &doc.summary {
        out.push_str("\n\n## Summary (written by a local model)\n\n");
        out.push_str(summary.trim_end());
    }
    out.push_str("\n\n## Transcript\n\n");
    for turn in &doc.turns {
        let name = doc.speaker_name(&names, turn);
        if doc.timed() {
            out.push_str(&format!("**{name}** [{}]: {}\n\n", timestamp(turn.start, '.', false), turn.text));
        } else {
            out.push_str(&format!("**{name}**: {}\n\n", turn.text));
        }
    }
    out
}

pub fn json(doc: &Document) -> Result<String> {
    let names = doc.names();
    let value = json!({
        "meeting": {
            "id": doc.meeting.id,
            "title": doc.meeting.title,
            "started_at": doc.meeting.started_at,
            "duration": doc.meeting.duration,
            "language": doc.meeting.language,
            "timed": doc.timed(),
            "tags": doc.meeting.tags,
            "folder": doc.meeting.folder,
        },
        "notes": doc.notes,
        "summary": doc.summary,
        "speakers": doc.speakers.iter().filter(|s| s.merged_into.is_none()).map(|s| json!({
            "id": s.id,
            "name": names.get(&s.id),
            "name_state": name_state(s),
            "track": s.track,
        })).collect::<Vec<_>>(),
        "turns": doc.turns.iter().map(|t| json!({
            "start": t.start,
            "end": t.end,
            "speaker": doc.speaker_name(&names, t),
            "speaker_id": t.speaker_id,
            "text": t.text,
            "provisional": t.provisional,
        })).collect::<Vec<_>>(),
    });
    Ok(serde_json::to_string_pretty(&value)?)
}

/// "confirmed" for names that the user set or confirmed, "automatic" for names from Meet
/// metadata or the microphone owner, and "unnamed" otherwise.
pub fn name_state(s: &Speaker) -> &'static str {
    match (s.name.as_ref(), s.name_source.as_deref()) {
        (None, _) => "unnamed",
        (Some(_), Some("user")) => "confirmed",
        (Some(_), _) => "automatic",
    }
}

pub fn subtitles(doc: &Document, vtt: bool) -> String {
    let names = doc.names();
    let mut out = if vtt { String::from("WEBVTT\n\n") } else { String::new() };
    let separator = if vtt { '.' } else { ',' };
    for (index, turn) in doc.turns.iter().enumerate() {
        if !vtt {
            out.push_str(&format!("{}\n", index + 1));
        }
        out.push_str(&format!(
            "{} --> {}\n{}: {}\n\n",
            timestamp(turn.start, separator, true),
            timestamp(turn.end.max(turn.start + 0.5), separator, true),
            doc.speaker_name(&names, turn),
            turn.text
        ));
    }
    out
}

pub fn render(doc: &Document, format: &str) -> Result<String> {
    Ok(match format {
        "md" | "markdown" => markdown(doc),
        "json" => json(doc)?,
        "srt" | "vtt" if !doc.timed() => bail!("meetings imported from Granola have no timestamps, so SRT and VTT export is not available"),
        "srt" => subtitles(doc, false),
        "vtt" => subtitles(doc, true),
        other => bail!("unknown export format {other}"),
    })
}

pub fn format_date(ms: i64) -> String {
    // Civil date from days since the Unix epoch (Howard Hinnant's algorithm), in UTC.
    let days = ms.div_euclid(86_400_000);
    let secs = ms.rem_euclid(86_400_000) / 1000;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02} UTC", secs / 3600, (secs / 60) % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_timestamps_and_dates() {
        assert_eq!(timestamp(3725.5, ',', true), "01:02:05,500");
        assert_eq!(timestamp(65.0, '.', false), "01:05");
        assert_eq!(format_date(0), "1970-01-01 00:00 UTC");
        assert_eq!(format_date(1_790_000_000_000), "2026-09-21 14:13 UTC");
    }
}
