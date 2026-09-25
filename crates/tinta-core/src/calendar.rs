//! Calendar events from the calendars on this Mac, and the video call links in them.

use serde::{Deserialize, Serialize};

/// The prefix of the `external_id` of a meeting that the user created from a calendar event.
pub const EXTERNAL_PREFIX: &str = "calendar";

pub fn external_id(event_id: &str) -> String {
    format!("{EXTERNAL_PREFIX}:{event_id}")
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Calendar {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub color: String,
    /// The account of the calendar, such as the Google account.
    #[serde(default)]
    pub account: String,
    /// True when the user hides the calendar in Tinta. The engine does not send this field.
    #[serde(default)]
    pub hidden: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Attendee {
    pub name: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub is_self: bool,
    /// "accepted", "declined", "tentative", "pending", or "unknown".
    #[serde(default)]
    pub status: String,
}

impl Attendee {
    /// The name, or the email address when the calendar has no name.
    pub fn label(&self) -> &str {
        if self.name.trim().is_empty() {
            &self.email
        } else {
            &self.name
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    /// The event and the original date of the occurrence. A repeating event has one ID for each occurrence.
    pub id: String,
    pub title: String,
    pub start: i64,
    pub end: i64,
    pub calendar_id: String,
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default, skip_serializing)]
    pub url: Option<String>,
    #[serde(default, skip_serializing)]
    pub notes: Option<String>,
    #[serde(default)]
    pub attendees: Vec<Attendee>,
    /// The video call link. `Snapshot::parse` finds it in the URL, the location, and the notes.
    #[serde(default)]
    pub link: Option<Link>,
    /// The Tinta meeting of this event, when the user created one.
    #[serde(default)]
    pub meeting_id: Option<String>,
}

impl Event {
    /// The title, or a fixed text for an event without a title.
    pub fn display_title(&self) -> &str {
        if self.title.is_empty() {
            "Untitled meeting"
        } else {
            &self.title
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Meet,
    Zoom,
    Teams,
    Webex,
}

impl Platform {
    pub fn name(self) -> &'static str {
        match self {
            Platform::Meet => "Google Meet",
            Platform::Zoom => "Zoom",
            Platform::Teams => "Microsoft Teams",
            Platform::Webex => "Webex",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Link {
    pub url: String,
    pub platform: Platform,
    /// The Meet meeting code, such as "abc-defg-hij".
    pub code: Option<String>,
}

impl Link {
    /// The link for the desktop app of the platform, when the platform has one.
    /// A Meet or Webex call opens in Chrome.
    pub fn app_url(&self) -> Option<String> {
        let (host, path, query) = split_url(&self.url)?;
        match self.platform {
            Platform::Zoom => {
                let number = path.strip_prefix("/j/")?.split('/').next()?;
                if number.is_empty() || !number.chars().all(|c| c.is_ascii_digit()) {
                    return None;
                }
                let mut url = format!("zoommtg://{host}/join?action=join&confno={number}");
                if let Some(pwd) = query.split('&').find_map(|p| p.strip_prefix("pwd=")) {
                    url.push_str(&format!("&pwd={pwd}"));
                }
                Some(url)
            }
            Platform::Teams => {
                let rest = self.url.split_once("://")?.1;
                Some(format!("msteams:{}", &rest[rest.find('/')?..]))
            }
            Platform::Meet | Platform::Webex => None,
        }
    }

    /// The bundle ID of the desktop app that opens `app_url`. It is also the recording source.
    pub fn app_bundle(&self) -> Option<&'static str> {
        match self.platform {
            Platform::Zoom => Some("us.zoom.xos"),
            Platform::Teams => Some("com.microsoft.teams2"),
            Platform::Meet | Platform::Webex => None,
        }
    }
}

/// The calendars and the events that the engine reads, with the access state.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Snapshot {
    /// "granted", "denied", or "undetermined".
    pub access: String,
    #[serde(default)]
    pub calendars: Vec<Calendar>,
    #[serde(default)]
    pub events: Vec<Event>,
}

impl Snapshot {
    /// Reads an engine reply and finds the call link of each event.
    pub fn parse(value: serde_json::Value) -> serde_json::Result<Self> {
        let mut snapshot: Snapshot = serde_json::from_value(value)?;
        for event in &mut snapshot.events {
            let texts = [event.url.as_deref(), event.location.as_deref(), event.notes.as_deref()];
            event.link = find_link(texts.into_iter().flatten());
        }
        Ok(snapshot)
    }

    /// The same snapshot without the events of the hidden calendars. It marks the hidden calendars.
    pub fn visible(&self, hidden: &[String]) -> Snapshot {
        let mut snapshot = self.clone();
        for calendar in &mut snapshot.calendars {
            calendar.hidden = hidden.contains(&calendar.id);
        }
        snapshot.events.retain(|e| !hidden.contains(&e.calendar_id));
        snapshot
    }
}

/// The first video call link in the texts, in order.
pub fn find_link<'a>(texts: impl IntoIterator<Item = &'a str>) -> Option<Link> {
    texts.into_iter().find_map(|text| urls(text).find_map(classify))
}

/// The http and https URLs in a text. A URL ends at white space, a quote, or a bracket, without the punctuation at its end.
fn urls(text: &str) -> impl Iterator<Item = &str> {
    let mut rest = text;
    std::iter::from_fn(move || loop {
        let start = rest.find("http")?;
        let candidate = &rest[start..];
        let end = candidate
            .find(|c: char| c.is_whitespace() || matches!(c, '<' | '>' | '"' | '\'' | '(' | ')' | '[' | ']' | '{' | '}' | '|'))
            .unwrap_or(candidate.len());
        rest = &candidate[end..];
        let url = candidate[..end].trim_end_matches(['.', ',', ';', ':', '!', '?']);
        if url.starts_with("https://") || url.starts_with("http://") {
            return Some(url);
        }
    })
}

/// The lowercase host, the path, and the query of a URL.
fn split_url(url: &str) -> Option<(String, &str, &str)> {
    let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"))?;
    let host_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let host = rest[..host_end].to_lowercase();
    let after = &rest[host_end..];
    let after = after.split('#').next().unwrap_or_default();
    let (path, query) = after.split_once('?').unwrap_or((after, ""));
    Some((host, path, query))
}

fn classify(url: &str) -> Option<Link> {
    let (host, path, _) = split_url(url)?;
    let link = |platform, code| Some(Link { url: url.to_string(), platform, code });
    let under = |domain: &str| host == domain || host.ends_with(&format!(".{domain}"));
    if host == "meet.google.com" {
        let code = path.trim_start_matches('/').split('/').next().unwrap_or_default().to_lowercase();
        return is_meet_code(&code).then(|| link(Platform::Meet, Some(code))).flatten();
    }
    if under("zoom.us") || under("zoomgov.com") {
        let joins = ["/j/", "/my/", "/w/", "/s/"].iter().any(|p| path.starts_with(p));
        return joins.then(|| link(Platform::Zoom, None)).flatten();
    }
    if host == "teams.microsoft.com" || host == "teams.live.com" {
        let joins = path.starts_with("/l/meetup-join/") || path.starts_with("/meet/");
        return joins.then(|| link(Platform::Teams, None)).flatten();
    }
    if under("webex.com") {
        return link(Platform::Webex, None);
    }
    None
}

/// A Meet meeting code has three, four, and three lowercase letters, such as "abc-defg-hij".
fn is_meet_code(code: &str) -> bool {
    let parts: Vec<&str> = code.split('-').collect();
    parts.len() == 3
        && parts.iter().zip([3, 4, 3]).all(|(p, n)| p.len() == n && p.chars().all(|c| c.is_ascii_lowercase()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_meet_links_in_google_notes() {
        let notes = "Agenda\n\n-::~:~::~:~::-\nJoin with Google Meet: https://meet.google.com/abc-defg-hij\nOr dial: (US) +1 555";
        let link = find_link([notes]).unwrap();
        assert_eq!(link.platform, Platform::Meet);
        assert_eq!(link.code.as_deref(), Some("abc-defg-hij"));
        assert_eq!(link.url, "https://meet.google.com/abc-defg-hij");
        assert_eq!(link.app_url(), None);
    }

    #[test]
    fn ignores_meet_pages_that_are_not_calls() {
        assert!(find_link(["https://meet.google.com/", "https://meet.google.com/landing"]).is_none());
        assert!(find_link(["<https://meet.google.com/abc-defg-hij?hs=224>."]).unwrap().code.is_some());
    }

    #[test]
    fn finds_zoom_and_builds_the_app_link() {
        let link = find_link(["Zoom: https://acme.zoom.us/j/123456789?pwd=Xy12.1, passcode 42"]).unwrap();
        assert_eq!(link.platform, Platform::Zoom);
        assert_eq!(link.url, "https://acme.zoom.us/j/123456789?pwd=Xy12.1");
        assert_eq!(
            link.app_url().as_deref(),
            Some("zoommtg://acme.zoom.us/join?action=join&confno=123456789&pwd=Xy12.1")
        );
        assert!(find_link(["https://zoom.us/pricing"]).is_none());
    }

    #[test]
    fn finds_teams_and_builds_the_app_link() {
        let url = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%7d";
        let link = find_link([format!("Microsoft Teams meeting\nJoin: <{url}>").as_str()]).unwrap();
        assert_eq!(link.platform, Platform::Teams);
        assert_eq!(link.url, url);
        assert_eq!(
            link.app_url().as_deref(),
            Some("msteams:/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%7d")
        );
    }

    #[test]
    fn uses_the_first_text_with_a_link() {
        let link = find_link(["Room 4", "https://acme.webex.com/meet/sam", "https://meet.google.com/abc-defg-hij"]).unwrap();
        assert_eq!(link.platform, Platform::Webex);
        assert!(find_link(["Lunch at https://example.com/menu", "httpd notes"]).is_none());
    }

    #[test]
    fn hides_the_events_of_hidden_calendars() {
        let snapshot = Snapshot::parse(serde_json::json!({
            "access": "granted",
            "calendars": [{"id": "work", "title": "Work"}, {"id": "home", "title": "Home"}],
            "events": [
                {"id": "a@1", "title": "Standup", "start": 1, "end": 2, "calendar_id": "work",
                 "notes": "https://meet.google.com/abc-defg-hij", "attendees": []},
                {"id": "b@1", "title": "Dentist", "start": 1, "end": 2, "calendar_id": "home", "attendees": []},
            ],
        }))
        .unwrap();
        assert_eq!(snapshot.events[0].link.as_ref().unwrap().code.as_deref(), Some("abc-defg-hij"));
        let visible = snapshot.visible(&["home".to_string()]);
        assert_eq!(visible.events.len(), 1);
        assert!(visible.calendars[1].hidden);
        let json = serde_json::to_value(&visible.events[0]).unwrap();
        assert!(json.get("notes").is_none());
    }
}
