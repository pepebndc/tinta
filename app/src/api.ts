import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

// The "mock" Vite mode serves sample data for design previews. Production builds remove this branch.
const MOCK = import.meta.env.MODE === "mock";
async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (import.meta.env.MODE === "mock") {
    const { mockInvoke } = await import("./mock");
    return mockInvoke<T>(command);
  }
  return tauriInvoke<T>(command, args);
}

export type Meeting = {
  id: string;
  title: string;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  duration: number;
  state: "draft" | "recording" | "processing" | "ready" | "failed";
  language: string | null;
  source: string | null;
  meeting_code: string | null;
  folder: string | null;
  archived: boolean;
  audio_until: number | null;
  audio_deleted: boolean;
  audio_trashed_at: number | null;
  deleted_at: number | null;
  error: string | null;
  tags: string[];
};

export type Speaker = {
  id: string;
  meeting_id: string;
  label: string;
  track: "mic" | "remote";
  name: string | null;
  name_source: "user" | "platform" | "self" | null;
  suggestion: string | null;
  suggestion_score: number | null;
};

export type Turn = {
  id: number;
  meeting_id: string;
  track: "mic" | "remote";
  speaker_id: string | null;
  start: number;
  end: number;
  text: string;
  provisional: boolean;
  live_name: string | null;
  name_changed: boolean;
  edited: boolean;
};

type Participant = { participant_id: string; name: string; is_self: boolean };

export type MeetingDetail = {
  meeting: Meeting;
  notes: string;
  speakers: Speaker[];
  turns: Turn[];
  names: Record<string, string>;
  participants: Participant[];
  has_edits: boolean;
  audio_bytes: number;
  summary: { content: string; written_by: string; updated_at: number } | null;
  summarizing: boolean;
};

export type ExtensionState = {
  connected_at: number | null;
  last_seen: number | null;
  meeting_code: string | null;
  title: string | null;
  self_name: string | null;
  participants: Participant[];
  speaking: string[];
  mic_muted: boolean | null;
};

export type Active = {
  meeting_id: string;
  start_wall_ms: number;
  paused: boolean;
  source: string;
  meeting_code: string | null;
  app_call: string | null;
};

/**
 * A call in a desktop meeting app. `app` is the bundle ID, which is also the recording source.
 * The participants, the speakers, and the mute state come from the app window when names from the call app are on.
 */
export type AppCall = {
  app: string;
  name: string;
  since: number;
  participants: Participant[];
  speaking: string[];
  mic_muted: boolean | null;
};

export type Bootstrap = {
  self_name: string;
  mcp_enabled: boolean;
  last_source: string;
  theme: "system" | "light" | "dark";
  onboarded: boolean;
  auto_stop: boolean;
  auto_summary: boolean;
  /** The number of days that new meetings keep their audio. */
  audio_retention_days: number;
  call_reading: boolean;
  accessibility: boolean;
  summaries: { available: boolean; reason?: string };
  filevault: boolean;
  models_installed: boolean;
  models_path: string;
  microphone: "granted" | "denied" | "undetermined";
  mcp_path: string;
  mcp_config: unknown;
  data_dir: string;
  active: Active | null;
  extension: ExtensionState;
  calls: AppCall[];
};

/** The first line of the summary and the other people of a meeting, for the cards on Home. */
export type Preview = { summary: string | null; people: string[] };

export type Source = { id: string; name: string; playing: boolean };
export type SearchHit = { meeting_id: string; title: string; kind: string; snippet: string };
export type Revision = {
  id: number;
  meeting_id: string;
  entity: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  ts: number;
  undone: boolean;
};
export type GranolaPreview = { path: string; total: number; mine: number; shared: number; already_imported: number };
export type GranolaSummary = { imported: number; skipped: number; failed: { title: string; error: string }[] };
export type StorageUsage = { library: number; audio: number; total: number; models: number };
export type Access = { id: number; ts: number; session: string; tool: string; meeting_ids: string[]; result: string };

/** The audio retention periods, in days, that the app offers. */
export const RETENTION_DAYS = [0, 1, 2, 3, 7, 14, 21, 30];

export const api = {
  bootstrap: () => invoke<Bootstrap>("bootstrap"),
  setSetting: (key: string, value: string) => invoke<void>("set_setting", { key, value }),
  installModels: () => invoke<unknown>("install_models"),
  requestMicrophone: () => invoke<{ granted: boolean }>("request_microphone"),
  requestAccessibility: () => invoke<{ granted: boolean }>("request_accessibility"),
  openPrivacySettings: (pane: "accessibility" | "microphone") => invoke<void>("open_privacy_settings", { pane }),
  saveCallReport: (app: string, path: string) => invoke<void>("save_call_report", { app, path }),
  listSources: () => invoke<{ sources: Source[]; default_input: string; route: "speakers" | "headphones" }>("list_sources"),
  /** All meetings that are not in the trash, archived meetings too. */
  listMeetings: () => invoke<{ meetings: Meeting[]; folders: string[]; previews: Record<string, Preview> }>("list_meetings"),
  search: (query: string) => invoke<SearchHit[]>("search", { query }),
  createMeeting: (title?: string) => invoke<Meeting>("create_meeting", { title }),
  getMeeting: (id: string) => invoke<MeetingDetail>("get_meeting", { id }),
  setTitle: (id: string, title: string) => invoke<void>("set_title", { id, title }),
  setNotes: (id: string, content: string) => invoke<void>("set_notes", { id, content }),
  setTags: (id: string, tags: string[]) => invoke<void>("set_tags", { id, tags }),
  setFolder: (id: string, folder: string | null) => invoke<void>("set_folder", { id, folder }),
  renameFolder: (folder: string, name: string) => invoke<void>("rename_folder", { folder, name }),
  removeFolder: (folder: string) => invoke<void>("remove_folder", { folder }),
  setArchived: (id: string, archived: boolean) => invoke<void>("set_archived", { id, archived }),
  startRecording: (id: string, source: string) => invoke<Active>("start_recording", { id, source }),
  pauseRecording: (paused: boolean) => invoke<void>("pause_recording", { paused }),
  stopRecording: () => invoke<string>("stop_recording"),
  runFinalPass: (id: string, language: string | null) => invoke<void>("run_final_pass", { id, language }),
  importRecording: (path: string) => invoke<Meeting>("import_recording", { path }),
  renameSpeaker: (speakerId: string, name: string | null) => invoke<void>("rename_speaker", { speakerId, name }),
  mergeSpeakers: (from: string, into: string) => invoke<void>("merge_speakers", { from, into }),
  reassignTurn: (turnId: number, speakerId: string | null) => invoke<string>("reassign_turn", { turnId, speakerId }),
  editTurnText: (turnId: number, text: string) => invoke<void>("edit_turn_text", { turnId, text }),
  speakerSample: (speakerId: string) => invoke<string>("speaker_sample", { speakerId }),
  turnAudio: (turnId: number) => invoke<string>("turn_audio", { turnId }),
  trashMeeting: (id: string) => invoke<void>("trash_meeting", { id }),
  deleteMeeting: (id: string) => invoke<void>("delete_meeting", { id }),
  deleteAudio: (id: string) => invoke<void>("delete_audio", { id }),
  setAudioRetention: (id: string, days: number) => invoke<number>("set_audio_retention", { id, days }),
  setAudioRetentionDays: (days: number) => invoke<void>("set_audio_retention_days", { days }),
  exportText: (id: string, format: string) => invoke<string>("export_text", { id, format }),
  exportFile: (id: string, format: string) => invoke<string>("export_file", { id, format }),
  moveLibrary: (parent: string) => invoke<string>("move_library", { parent }),
  showLibrary: () => invoke<void>("show_library"),
  prepareExtension: () => invoke<string>("prepare_extension"),
  summarize: (id: string) => invoke<void>("summarize", { id }),
  deleteSummary: (id: string) => invoke<void>("delete_summary", { id }),
  storageUsage: () => invoke<StorageUsage>("storage_usage"),
  granolaDefaultPath: () => invoke<string | null>("granola_default_path"),
  granolaPreview: (path: string) => invoke<GranolaPreview>("granola_preview", { path }),
  importGranola: (path: string, includeSummaries: boolean) =>
    invoke<GranolaSummary>("import_granola", { path, includeSummaries }),
  trash: () => invoke<Meeting[]>("trash"),
  restore: (id: string) => invoke<void>("restore", { id }),
  mcpActivity: () => invoke<{ revisions: Revision[]; access: Access[] }>("mcp_activity"),
  undo: (revisionId: number) => invoke<void>("undo", { revisionId }),
};

/**
 * Asks macOS for the microphone. macOS shows its prompt only one time, so after a denial
 * this opens the Microphone pane of System Settings.
 */
export function allowMicrophone(status: Bootstrap["microphone"]): Promise<unknown> {
  return status === "denied" ? api.openPrivacySettings("microphone") : api.requestMicrophone();
}

// One model installation at a time, shared by the setup flow and Settings.
let installation: Promise<unknown> | null = null;

export function installModels(): Promise<unknown> {
  installation ??= api.installModels().finally(() => {
    installation = null;
  });
  return installation;
}

export function installRunning(): boolean {
  return installation !== null;
}

export function on<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  if (MOCK) return Promise.resolve(() => undefined);
  return listen<T>(event, (e) => handler(e.payload));
}

export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function bytes(n: number): string {
  if (n < 1000) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function dateTime(ms: number | null): string {
  if (!ms) return "";
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const DAY = 86_400_000;

/** A date in the last 7 days shows as "Today", "Yesterday", or the weekday, with the time. Older dates show in full. */
export function relativeDate(ms: number | null, now = Date.now()): string {
  if (!ms) return "";
  const date = new Date(ms);
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const days = Math.round((new Date(now).setHours(0, 0, 0, 0) - new Date(ms).setHours(0, 0, 0, 0)) / DAY);
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  if (days > 1 && days < 7) return `${date.toLocaleDateString(undefined, { weekday: "long" })}, ${time}`;
  return dateTime(ms);
}

/** The languages of the speech model, by ISO 639-1 code. */
export const LANGUAGES = [
  "bg", "cs", "da", "de", "el", "en", "es", "et", "fi", "fr", "hr", "hu", "it",
  "lt", "lv", "mt", "nl", "pl", "pt", "ro", "ru", "sk", "sl", "sv", "uk",
];

const languageNames = new Intl.DisplayNames(undefined, { type: "language" });

export function languageName(code: string): string {
  return languageNames.of(code) ?? code;
}
