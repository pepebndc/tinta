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

export type Participant = { participant_id: string; name: string; is_self: boolean };

export type MeetingDetail = {
  meeting: Meeting;
  notes: string;
  speakers: Speaker[];
  turns: Turn[];
  names: Record<string, string>;
  participants: Participant[];
  has_edits: boolean;
  finalizing: boolean;
};

export type ExtensionState = {
  connected_at: number | null;
  last_seen: number | null;
  meeting_code: string | null;
  title: string | null;
  self_name: string | null;
  participants: Participant[];
  speaking: string[];
};

export type Active = { meeting_id: string; start_wall_ms: number; paused: boolean };

export type Bootstrap = {
  self_name: string;
  mcp_enabled: boolean;
  last_source: string;
  theme: "system" | "light" | "dark";
  onboarded: boolean;
  filevault: boolean;
  models_installed: boolean;
  models_path: string;
  microphone: "granted" | "denied" | "undetermined";
  mcp_path: string;
  mcp_config: unknown;
  extension_id: string;
  data_dir: string;
  active: Active | null;
  extension: ExtensionState;
};

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
export type Access = { id: number; ts: number; session: string; tool: string; meeting_ids: string[]; result: string };

export const api = {
  bootstrap: () => invoke<Bootstrap>("bootstrap"),
  setSetting: (key: string, value: string) => invoke<void>("set_setting", { key, value }),
  installModels: () => invoke<unknown>("install_models"),
  requestMicrophone: () => invoke<{ granted: boolean }>("request_microphone"),
  listSources: () => invoke<{ sources: Source[]; default_input: string; route: "speakers" | "headphones" }>("list_sources"),
  listMeetings: (includeArchived: boolean) =>
    invoke<{ meetings: Meeting[]; folders: string[] }>("list_meetings", { includeArchived }),
  search: (query: string) => invoke<SearchHit[]>("search", { query }),
  createMeeting: (title?: string) => invoke<Meeting>("create_meeting", { title }),
  getMeeting: (id: string) => invoke<MeetingDetail>("get_meeting", { id }),
  setTitle: (id: string, title: string) => invoke<void>("set_title", { id, title }),
  setNotes: (id: string, content: string) => invoke<void>("set_notes", { id, content }),
  setTags: (id: string, tags: string[]) => invoke<void>("set_tags", { id, tags }),
  setFolder: (id: string, folder: string | null) => invoke<void>("set_folder", { id, folder }),
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
  deleteMeeting: (id: string) => invoke<void>("delete_meeting", { id }),
  deleteAudio: (id: string) => invoke<void>("delete_audio", { id }),
  setAudioRetention: (id: string, days: number) => invoke<number>("set_audio_retention", { id, days }),
  exportText: (id: string, format: string) => invoke<string>("export_text", { id, format }),
  exportFile: (id: string, format: string) => invoke<string>("export_file", { id, format }),
  moveLibrary: (parent: string) => invoke<string>("move_library", { parent }),
  showLibrary: () => invoke<void>("show_library"),
  prepareExtension: () => invoke<string>("prepare_extension"),
  granolaDefaultPath: () => invoke<string | null>("granola_default_path"),
  granolaPreview: (path: string) => invoke<GranolaPreview>("granola_preview", { path }),
  importGranola: (path: string, includeSummaries: boolean) =>
    invoke<GranolaSummary>("import_granola", { path, includeSummaries }),
  trash: () => invoke<Meeting[]>("trash"),
  restore: (id: string) => invoke<void>("restore", { id }),
  mcpActivity: () => invoke<{ revisions: Revision[]; access: Access[] }>("mcp_activity"),
  undo: (revisionId: number) => invoke<void>("undo", { revisionId }),
};

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

export function dateTime(ms: number | null): string {
  if (!ms) return "";
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function playWav(base64: string): HTMLAudioElement {
  const audio = new Audio(`data:audio/wav;base64,${base64}`);
  void audio.play();
  return audio;
}
