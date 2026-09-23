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
    finalizing: false,
  };
}

const boot: Bootstrap = {
  self_name: "Sam Rivera", mcp_enabled: true, theme: (localStorage.getItem("tinta-theme") as Bootstrap["theme"]) || "system", last_source: "com.google.Chrome", filevault: true,
  models_path: "~/Library/Application Support/FluidAudio/Models", microphone: "granted",
  mcp_path: "/Applications/Tinta.app/Contents/MacOS/tinta-mcp",
  mcp_config: { mcpServers: { tinta: { command: "/Applications/Tinta.app/Contents/MacOS/tinta-mcp" } } },
  extension_id: "ajncjfpbmkmiheokjfhfdlhnmfbaofij", data_dir: "~/Library/Application Support/Tinta",
  models_installed: hash() !== "setup",
  active: hash() === "recording" ? { meeting_id: "m1", start_wall_ms: now - 754_000, paused: false } : null,
  extension: {
    connected_at: hash() === "setup" ? null : now, last_seen: hash() === "setup" ? null : now, meeting_code: "abc-defg-hij", title: "Design review", self_name: "Sam Rivera",
    participants: detail().participants, speaking: [],
  },
};

export async function mockInvoke<T>(command: string): Promise<T> {
  const results: Record<string, unknown> = {
    bootstrap: boot,
    list_meetings: { meetings, folders: ["Audits"] },
    get_meeting: detail(),
    list_sources: { sources: [{ id: "com.google.Chrome", name: "Google Chrome", playing: true }, { id: "all", name: "All system audio", playing: true }], default_input: "MacBook Pro Microphone", route: "speakers" },
    search: [],
    granola_default_path: "/Users/sam/granola-export",
    granola_preview: { path: "/Users/sam/granola-export", total: 128, mine: 120, shared: 8, already_imported: 0 },
    trash: [],
    mcp_activity: { revisions: [], access: [] },
  };
  return results[command] as T;
}
