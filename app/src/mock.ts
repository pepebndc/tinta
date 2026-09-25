// Sample data for `pnpm preview:mock`, a design preview outside the Tauri window.
// Only the "mock" Vite mode imports this file.
import type { Bootstrap, Meeting, MeetingDetail, Turn } from "./api";

const now = Date.now();
const hash = () => window.location.hash.replace("#", "");

function meeting(id: string, title: string, minutesAgo: number, state: Meeting["state"]): Meeting {
  return {
    id, title, created_at: now - minutesAgo * 60_000, started_at: now - minutesAgo * 60_000, ended_at: null,
    duration: state === "ready" ? 1920 : 0, state, language: "en", source: "com.google.Chrome", meeting_code: "abc-defg-hij",
    folder: "Audits", archived: false, audio_until: now + 6 * 86_400_000, audio_deleted: false, audio_trashed_at: null,
    deleted_at: null, error: null, tags: ["audit", "weekly"],
  };
}

const meetings = hash() === "fresh" ? [] : [
  meeting("m1", "Design review", 40, hash() === "recording" ? "recording" : "ready"),
  meeting("m2", "Weekly planning", 1500, "ready"),
  meeting("m3", "Product catch-up", 4400, "ready"),
  { ...meeting("m4", "Client kickoff", 6000, "failed"), error: "the engine stopped" },
  { ...meeting("m5", "Audit retro", 9000, "ready"), audio_until: now + 20 * 3_600_000, tags: ["retro"] },
];

const lines: [string, string, number, string][] = [
  ["s1", "remote", 12, "The first screen should feel calm. I want to open a meeting and find the conversation straight away."],
  ["s2", "remote", 28, "Agreed. The speaker names and timestamps help me find the part I need. Everything else can stay quiet."],
  ["self", "mic", 46, "Let's give the notes their own space. I want to write down what matters to me while the transcript keeps the full conversation."],
  ["s1", "remote", 68, "And keep the notes on this Mac. Sharing should be something I choose."],
  ["s3", "remote", 90, "I can review the icon at small sizes tomorrow morning."],
];

function detail(): MeetingDetail {
  const recording = hash() === "recording";
  const turns: Turn[] = lines.map(([speaker, track, start, text], i) => ({
    id: i + 1, meeting_id: "m1", track: track as Turn["track"], speaker_id: recording ? null : speaker, start, end: start + 12,
    text, provisional: recording, live_name: recording ? (speaker === "self" ? "Sam Rivera" : speaker === "s1" ? "Alex Moreno" : speaker === "s2" ? "Morgan Lee" : null) : null,
    name_changed: !recording && i === 1, edited: false,
    ...(!recording && i === 1 ? { live_name: "Alex Moreno" } : {}),
  }));
  return {
    meeting: meetings[0],
    notes: "Make the first screen feel calm.\n\n• Keep the transcript easy to scan.\n• Give notes their own space.\n\n[00:46] Next: review the icon at small sizes.",
    speakers: recording ? [] : [
      { id: "self", meeting_id: "m1", label: "self", track: "mic", name: "Sam Rivera", name_source: "self", suggestion: null, suggestion_score: null },
      { id: "s1", meeting_id: "m1", label: "S1", track: "remote", name: "Alex Moreno", name_source: "platform", suggestion: null, suggestion_score: 0.9 },
      { id: "s2", meeting_id: "m1", label: "S2", track: "remote", name: "Morgan Lee", name_source: "user", suggestion: null, suggestion_score: 0.8 },
      { id: "s3", meeting_id: "m1", label: "S3", track: "remote", name: null, name_source: null, suggestion: "Sam Carter", suggestion_score: 0.3 },
    ],
    turns,
    names: recording ? {} : { self: "Sam Rivera", s1: "Alex Moreno", s2: "Morgan Lee", s3: "Speaker 1" },
    participants: [
      { participant_id: "p0", name: "Sam Rivera", is_self: true },
      { participant_id: "p1", name: "Alex Moreno", is_self: false },
      { participant_id: "p2", name: "Morgan Lee", is_self: false },
      { participant_id: "p3", name: "Sam Carter", is_self: false },
    ],
    has_edits: false,
    audio_bytes: 61_400_000,
    summary: {
      content: "The team reviewed the first screen of the app. They agreed to keep it calm, with speaker names and timestamps, and to give the notes their own space.\n\n### Key points\n\n- The first screen should feel calm.\n- Speaker names and timestamps help people find a part of the conversation.\n- Notes stay on this Mac.\n\n### Action items\n\n- **Sam Carter**: Review the icon at small sizes tomorrow morning.\n",
      written_by: "Apple on-device model",
      updated_at: now - 30 * 60_000,
    },
    summarizing: false,
  };
}

const minute = 60_000;
const calendar: Bootstrap["calendar"] = {
  access: hash() === "setup" ? "undetermined" : "granted",
  calendars: [
    { id: "work", title: "sam@example.com", color: "#7986cb", account: "Google", hidden: false },
    { id: "home", title: "Home", color: "#33b679", account: "iCloud", hidden: false },
  ],
  events: [
    {
      id: "e1@1", title: "Weekly planning", start: now + 4 * minute, end: now + 34 * minute, calendar_id: "work", location: null,
      attendees: [
        { name: "Sam Rivera", email: "sam@example.com", is_self: true, status: "accepted" },
        { name: "Priya Shah", email: "priya@example.com", is_self: false, status: "accepted" },
        { name: "Leo Park", email: "leo@example.com", is_self: false, status: "tentative" },
      ],
      link: { url: "https://meet.google.com/abc-defg-hij", platform: "meet", code: "abc-defg-hij" }, meeting_id: null,
    },
    {
      id: "e2@1", title: "Client check-in", start: now + 180 * minute, end: now + 210 * minute, calendar_id: "work", location: null,
      attendees: [], link: { url: "https://acme.zoom.us/j/123456789", platform: "zoom", code: null }, meeting_id: "m2",
    },
    { id: "e3@1", title: "Dentist", start: now + 1500 * minute, end: now + 1560 * minute, calendar_id: "home", location: "Main St 4", attendees: [], link: null, meeting_id: null },
  ],
};

const boot: Bootstrap = {
  self_name: "Sam Rivera", onboarded: !hash().startsWith("onboarding"), auto_stop: true, auto_summary: true, audio_retention_days: 7, summaries: { available: true }, mcp_enabled: true, theme: (localStorage.getItem("tinta-theme") as Bootstrap["theme"]) || "system", last_source: "com.google.Chrome", filevault: true,
  models_path: "~/Library/Application Support/FluidAudio/Models", microphone: "granted",
  mcp_path: "/Applications/Tinta.app/Contents/MacOS/tinta-mcp",
  mcp_config: { mcpServers: { tinta: { command: "/Applications/Tinta.app/Contents/MacOS/tinta-mcp" } } },
  data_dir: "~/Library/Application Support/Tinta",
  models_installed: hash() !== "setup" && !hash().startsWith("onboarding"),
  active: hash() === "recording" ? { meeting_id: "m1", start_wall_ms: now - 754_000, paused: false, source: "com.google.Chrome", meeting_code: "abc-defg-hij", app_call: null } : null,
  extension: {
    connected_at: hash() === "setup" || hash().startsWith("onboarding") ? null : now, last_seen: hash() === "setup" ? null : now,
    meeting_code: hash() === "zoom" ? null : "abc-defg-hij", title: hash() === "zoom" ? null : "Design review", self_name: "Sam Rivera",
    participants: hash() === "zoom" ? [] : detail().participants, speaking: [], mic_muted: hash() === "recording" ? true : false,
  },
  call_reading: hash() === "zoom", accessibility: hash() === "zoom", meeting_reminders: true, calendar,
  calls: hash() === "zoom"
    ? [{
        app: "us.zoom.xos", name: "Zoom", since: now - 30_000, speaking: ["Priya Shah"], mic_muted: false,
        participants: [
          { participant_id: "Sam Rivera", name: "Sam Rivera", is_self: true },
          { participant_id: "Priya Shah", name: "Priya Shah", is_self: false },
          { participant_id: "Leo Park", name: "Leo Park", is_self: false },
        ],
      }]
    : [],
};

/** Sends sample level meters during a recording. Other events do not occur in the preview. */
export function mockOn(event: string, handler: (payload: unknown) => void): () => void {
  if (event !== "engine" || hash() !== "recording") return () => undefined;
  const send = () => handler({ event: "levels", mic: 0.03 + Math.random() * 0.04, remote: 0.1 + Math.random() * 0.06, remote_capturing: true, mic_muted: false });
  send();
  const timer = setInterval(send, 400);
  return () => clearInterval(timer);
}

export async function mockInvoke<T>(command: string): Promise<T> {
  const results: Record<string, unknown> = {
    bootstrap: boot,
    list_meetings: { meetings, folders: ["Audits"], previews: { m1: { summary: "The team agrees to keep the first screen calm, with notes and the transcript side by side.", people: ["Alex Moreno", "Morgan Lee"] } } },
    get_meeting: detail(),
    list_sources: {
      sources: [
        { id: "com.google.Chrome", name: "Google Chrome", playing: true },
        { id: "us.zoom.xos", name: "Zoom", playing: hash() === "zoom" },
        { id: "all", name: "All system audio", playing: true },
      ],
      default_input: "MacBook Pro Microphone",
      route: "speakers",
    },
    search: [],
    granola_default_path: "/Users/sam/granola-export",
    granola_preview: { path: "/Users/sam/granola-export", total: 128, mine: 120, shared: 8, already_imported: 0 },
    trash: [],
    storage_usage: { library: 4_200_000, audio: 312_000_000, total: 316_200_000, models: 486_000_000 },
    export_file: "/Users/sam/Downloads/Design review.md",
    prepare_extension: "/Users/sam/Library/Application Support/Tinta/Chrome extension",
    mcp_activity: {
      revisions: [],
      access: [],
      tools: [
        { name: "list_meetings", description: "List meetings, newest first. Filter by folder, tag, or date range (epoch milliseconds).", read_only: true },
        { name: "search_meetings", description: "Full-text search over titles, tags, notes, summaries, speaker names, and transcripts.", read_only: true },
        { name: "get_transcript", description: "Get transcript turns in pages.", read_only: true },
        { name: "update_summary", description: "Replace the summary of a meeting, or add one. The user can undo the change.", read_only: false },
        { name: "add_tags", description: "Add tags to a meeting.", read_only: false },
        { name: "delete_meeting", description: "Move a meeting to the trash. The app deletes it permanently after 7 days.", read_only: false },
      ],
    },
    refresh_calendar: calendar,
    request_calendar: calendar,
  };
  return results[command] as T;
}
