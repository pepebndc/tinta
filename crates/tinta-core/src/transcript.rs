//! Builds speakers and turns from the final pass of the engine.

use crate::db::{NewSpeaker, NewTurn, Participant};
use crate::naming::{self, Decision, Segment};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Deserialize)]
pub struct Word {
    pub w: String,
    pub s: f64,
    pub e: f64,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct TrackResult {
    #[serde(default)]
    pub words: Vec<Word>,
    #[serde(default)]
    pub diarization: Vec<Segment>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct FinalResult {
    #[serde(default)]
    pub tracks: HashMap<String, TrackResult>,
    #[serde(default)]
    pub duration: f64,
    pub language: Option<String>,
}

/// A new turn starts after a pause of this length.
const TURN_GAP_SECONDS: f64 = 1.2;
const TURN_MAX_SECONDS: f64 = 30.0;

pub struct Built {
    pub speakers: Vec<NewSpeaker>,
    pub turns: Vec<NewTurn>,
    pub named: usize,
    pub remote_labels: usize,
}

fn group(words: &[(String, &Word)], track: &str) -> Vec<NewTurn> {
    let mut turns: Vec<NewTurn> = Vec::new();
    for (label, word) in words {
        if let Some(last) = turns.last_mut() {
            if &last.speaker_label == label
                && word.s - last.end <= TURN_GAP_SECONDS
                && word.e - last.start <= TURN_MAX_SECONDS
            {
                last.text.push(' ');
                last.text.push_str(&word.w);
                last.end = word.e;
                continue;
            }
        }
        turns.push(NewTurn {
            track: track.to_string(),
            speaker_label: label.clone(),
            start: word.s,
            end: word.e,
            text: word.w.clone(),
        });
    }
    turns
}

/// The diarization label with the most overlap with a word, or the nearest segment.
fn label_for(word: &Word, segments: &[Segment]) -> Option<String> {
    let mut best: Option<(&str, f64)> = None;
    for segment in segments {
        let o = word.e.min(segment.e) - word.s.max(segment.s);
        let score = if o > 0.0 { o } else { -(segment.s - word.e).abs().min((word.s - segment.e).abs()) };
        if best.map(|b| score > b.1).unwrap_or(true) {
            best = Some((&segment.speaker, score));
        }
    }
    best.filter(|b| b.1 > -3.0).map(|b| b.0.to_string())
}

pub fn build(
    result: &FinalResult,
    self_name: &str,
    participants: &[Participant],
    events: &[(i64, Vec<String>)],
    start_wall_ms: Option<i64>,
) -> Built {
    let mut speakers = Vec::new();
    let mut turns = Vec::new();

    if let Some(mic) = result.tracks.get("mic") {
        if !mic.words.is_empty() {
            speakers.push(NewSpeaker {
                label: "self".into(),
                track: "mic".into(),
                name: Some(self_name.to_string()),
                name_source: Some("self".into()),
                suggestion: None,
                suggestion_score: None,
            });
            let labeled: Vec<(String, &Word)> = mic.words.iter().map(|w| ("self".to_string(), w)).collect();
            turns.extend(group(&labeled, "mic"));
        }
    }

    let mut named = 0;
    let mut remote_labels = 0;
    if let Some(remote) = result.tracks.get("remote") {
        let exclude: HashSet<String> =
            participants.iter().filter(|p| p.is_self).map(|p| p.participant_id.clone()).collect();
        let names: HashMap<&str, &str> =
            participants.iter().map(|p| (p.participant_id.as_str(), p.name.as_str())).collect();
        let decisions: HashMap<String, Decision> = match start_wall_ms {
            Some(start) if !events.is_empty() => {
                naming::match_names(&remote.diarization, &naming::highlights(events, start, &exclude))
            }
            _ => HashMap::new(),
        };
        let fallback = "remote".to_string();
        let labeled: Vec<(String, &Word)> = remote
            .words
            .iter()
            .map(|w| (label_for(w, &remote.diarization).unwrap_or_else(|| fallback.clone()), w))
            .collect();
        let mut labels: Vec<String> = labeled.iter().map(|(l, _)| l.clone()).collect();
        labels.sort();
        labels.dedup();
        for label in &labels {
            let decision = decisions.get(label);
            let name = decision
                .and_then(|d| d.participant.as_deref())
                .and_then(|p| names.get(p))
                .map(|n| n.to_string());
            if name.is_some() {
                named += 1;
            }
            remote_labels += 1;
            speakers.push(NewSpeaker {
                label: label.clone(),
                track: "remote".into(),
                name: name.clone(),
                name_source: name.as_ref().map(|_| "platform".to_string()),
                suggestion: decision
                    .and_then(|d| d.suggestion.as_deref())
                    .and_then(|p| names.get(p))
                    .map(|n| n.to_string()),
                suggestion_score: decision.map(|d| d.score),
            });
        }
        turns.extend(group(&labeled, "remote"));
    }

    turns.sort_by(|a, b| a.start.total_cmp(&b.start));
    Built { speakers, turns, named, remote_labels }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(w: &str, s: f64, e: f64) -> Word {
        Word { w: w.into(), s, e }
    }

    #[test]
    fn builds_named_turns() {
        let mut tracks = HashMap::new();
        tracks.insert("mic".into(), TrackResult { words: vec![word("Hello", 0.0, 0.5), word("team", 0.6, 1.0)], diarization: vec![] });
        tracks.insert(
            "remote".into(),
            TrackResult {
                words: vec![word("Hi", 2.0, 2.4), word("there", 2.5, 3.0), word("Bye", 10.0, 10.5)],
                diarization: vec![
                    Segment { speaker: "S1".into(), s: 1.8, e: 6.0 },
                    Segment { speaker: "S2".into(), s: 9.8, e: 12.0 },
                ],
            },
        );
        let result = FinalResult { tracks, duration: 12.0, language: Some("en".into()) };
        let participants = vec![
            Participant { participant_id: "me".into(), name: "Sam".into(), is_self: true },
            Participant { participant_id: "a".into(), name: "Alice".into(), is_self: false },
        ];
        let events = vec![(1_001_800, vec!["a".to_string(), "me".to_string()]), (1_006_000, vec![])];
        let built = build(&result, "Sam", &participants, &events, Some(1_000_000));
        assert_eq!(built.turns.len(), 3);
        assert_eq!(built.turns[0].text, "Hello team");
        assert_eq!(built.turns[1].text, "Hi there");
        let s1 = built.speakers.iter().find(|s| s.label == "S1").unwrap();
        assert_eq!(s1.name.as_deref(), Some("Alice"));
        let s2 = built.speakers.iter().find(|s| s.label == "S2").unwrap();
        assert_eq!(s2.name, None);
    }
}
