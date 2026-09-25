//! Matches remote speaker labels to call participants.
//!
//! The Meet extension and the engine reader for Zoom and Teams report which participants
//! the call app marks as speaking, with wall clock times. For each speaker label from
//! diarization, the matcher measures how much of that label's speech overlaps with each
//! participant's highlighted time over the whole meeting. It assigns a name only when the
//! evidence is strong and clear.

use serde::Deserialize;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Deserialize)]
pub struct Segment {
    pub speaker: String,
    pub s: f64,
    pub e: f64,
}

/// A time range, in meeting seconds, in which a participant is highlighted.
/// `weight` is 1 divided by the number of participants highlighted at the same time.
#[derive(Debug, Clone)]
pub struct Highlight {
    pub participant: String,
    pub s: f64,
    pub e: f64,
    pub weight: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Decision {
    pub participant: Option<String>,
    pub suggestion: Option<String>,
    pub score: f64,
}

/// An event holds until the next event, but never longer than this.
/// The extension sends a heartbeat every 5 seconds, and the engine reader every 3 seconds.
pub const EVENT_HOLD_SECONDS: f64 = 7.0;
const MIN_SHARE: f64 = 0.5;
const MIN_MARGIN: f64 = 0.25;
const MIN_OVERLAP_SECONDS: f64 = 2.0;
const MIN_SUGGESTION_SHARE: f64 = 0.2;

pub fn highlights(events: &[(i64, Vec<String>)], start_wall_ms: i64, exclude: &HashSet<String>) -> Vec<Highlight> {
    let mut result = Vec::new();
    for (index, (t, speaking)) in events.iter().enumerate() {
        let s = (*t - start_wall_ms) as f64 / 1000.0;
        let next = events
            .get(index + 1)
            .map(|(n, _)| (*n - start_wall_ms) as f64 / 1000.0)
            .unwrap_or(s + EVENT_HOLD_SECONDS);
        let e = next.min(s + EVENT_HOLD_SECONDS);
        let remote: Vec<&String> = speaking.iter().filter(|p| !exclude.contains(*p)).collect();
        if remote.is_empty() || e <= s {
            continue;
        }
        let weight = 1.0 / remote.len() as f64;
        for participant in remote {
            result.push(Highlight { participant: participant.clone(), s, e, weight });
        }
    }
    result
}

fn overlap(a0: f64, a1: f64, b0: f64, b1: f64) -> f64 {
    (a1.min(b1) - a0.max(b0)).max(0.0)
}

/// Weighted overlap per label and participant, with highlights moved by `shift` seconds.
fn overlaps(segments: &[Segment], highlights: &[Highlight], shift: f64) -> HashMap<String, HashMap<String, f64>> {
    let mut table: HashMap<String, HashMap<String, f64>> = HashMap::new();
    for segment in segments {
        let row = table.entry(segment.speaker.clone()).or_default();
        for h in highlights {
            let o = overlap(segment.s, segment.e, h.s + shift, h.e + shift);
            if o > 0.0 {
                *row.entry(h.participant.clone()).or_default() += o * h.weight;
            }
        }
    }
    table
}

/// Meet highlights a tile after a short delay. The matcher tests delays from -1 s to +2 s
/// and uses the one with the most total best-match overlap.
fn best_shift(segments: &[Segment], highlights: &[Highlight]) -> f64 {
    let mut best = (0.0, f64::MIN);
    let mut shift = -1.0;
    while shift <= 2.0 + 1e-9 {
        let table = overlaps(segments, highlights, -shift);
        let total: f64 = table
            .values()
            .map(|row| row.values().cloned().fold(0.0, f64::max))
            .sum();
        if total > best.1 + 1e-9 {
            best = (shift, total);
        }
        shift += 0.25;
    }
    best.0
}

pub fn match_names(segments: &[Segment], highlights: &[Highlight]) -> HashMap<String, Decision> {
    let mut speech: HashMap<String, f64> = HashMap::new();
    for segment in segments {
        *speech.entry(segment.speaker.clone()).or_default() += (segment.e - segment.s).max(0.0);
    }
    let shift = best_shift(segments, highlights);
    let table = overlaps(segments, highlights, -shift);
    let mut decisions = HashMap::new();
    for (label, total) in speech {
        let mut ranked: Vec<(String, f64)> = table
            .get(&label)
            .map(|row| row.iter().map(|(p, o)| (p.clone(), *o)).collect())
            .unwrap_or_default();
        ranked.sort_by(|a, b| b.1.total_cmp(&a.1));
        let decision = match ranked.first() {
            Some((participant, best)) if total > 0.0 => {
                let share = best / total;
                let second = ranked.get(1).map(|r| r.1 / total).unwrap_or(0.0);
                if share >= MIN_SHARE && share - second >= MIN_MARGIN && *best >= MIN_OVERLAP_SECONDS {
                    Decision { participant: Some(participant.clone()), suggestion: None, score: share }
                } else if share >= MIN_SUGGESTION_SHARE {
                    Decision { participant: None, suggestion: Some(participant.clone()), score: share }
                } else {
                    Decision { participant: None, suggestion: None, score: share }
                }
            }
            _ => Decision { participant: None, suggestion: None, score: 0.0 },
        };
        decisions.insert(label, decision);
    }
    decisions
}

/// The provisional live name: the one remote participant that Meet highlights at time `t`.
pub fn live_participant(highlights: &[Highlight], s: f64, e: f64) -> Option<String> {
    let mut totals: HashMap<&str, f64> = HashMap::new();
    for h in highlights {
        let o = overlap(s, e, h.s, h.e) * h.weight;
        if o > 0.0 {
            *totals.entry(h.participant.as_str()).or_default() += o;
        }
    }
    let duration = (e - s).max(0.1);
    totals
        .into_iter()
        .filter(|(_, o)| *o / duration >= 0.6)
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(p, _)| p.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(speaker: &str, s: f64, e: f64) -> Segment {
        Segment { speaker: speaker.into(), s, e }
    }

    fn events(list: &[(f64, &[&str])]) -> Vec<(i64, Vec<String>)> {
        list.iter()
            .map(|(t, ids)| ((t * 1000.0) as i64 + 1_000_000, ids.iter().map(|s| s.to_string()).collect()))
            .collect()
    }

    #[test]
    fn assigns_clear_matches_with_delay() {
        let segments = vec![seg("S1", 0.0, 10.0), seg("S2", 10.0, 20.0), seg("S1", 20.0, 30.0)];
        // Meet highlights each speaker 0.75 s late.
        let ev = events(&[(0.75, &["alice"]), (10.75, &["bob"]), (20.75, &["alice"]), (30.75, &[])]);
        let h = highlights(&ev, 1_000_000, &HashSet::new());
        let d = match_names(&segments, &h);
        assert_eq!(d["S1"].participant.as_deref(), Some("alice"));
        assert_eq!(d["S2"].participant.as_deref(), Some("bob"));
    }

    #[test]
    fn excludes_self_and_leaves_unclear_labels_unnamed() {
        let segments = vec![seg("S1", 0.0, 10.0)];
        let ev = events(&[(0.0, &["me", "alice", "bob"]), (10.0, &[])]);
        let exclude: HashSet<String> = ["me".to_string()].into();
        let h = highlights(&ev, 1_000_000, &exclude);
        let d = match_names(&segments, &h);
        assert_eq!(d["S1"].participant, None);
        assert!(d["S1"].suggestion.is_some());
    }

    #[test]
    fn no_events_means_no_names() {
        let d = match_names(&[seg("S1", 0.0, 5.0)], &[]);
        assert_eq!(d["S1"], Decision { participant: None, suggestion: None, score: 0.0 });
    }

    #[test]
    fn short_evidence_is_only_a_suggestion() {
        let segments = vec![seg("S1", 0.0, 1.5)];
        let ev = events(&[(0.0, &["alice"]), (1.5, &[])]);
        let d = match_names(&segments, &highlights(&ev, 1_000_000, &HashSet::new()));
        assert_eq!(d["S1"].participant, None);
        assert_eq!(d["S1"].suggestion.as_deref(), Some("alice"));
    }

    #[test]
    fn live_participant_needs_one_clear_highlight() {
        let ev = events(&[(0.0, &["alice"]), (5.0, &["alice", "bob"]), (10.0, &[])]);
        let h = highlights(&ev, 1_000_000, &HashSet::new());
        assert_eq!(live_participant(&h, 1.0, 4.0).as_deref(), Some("alice"));
        assert_eq!(live_participant(&h, 6.0, 9.0), None);
    }
}
