import { createContext, memo, RefObject, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  Active,
  allowMicrophone,
  api,
  AppCall,
  Bootstrap,
  bytes,
  clock,
  dateTime,
  EngineEvent,
  ExtensionState,
  LANGUAGES,
  languageName,
  MeetingDetail,
  NO_SPEECH_ERROR,
  on,
  RETENTION_DAYS,
  Source,
  Speaker,
  Turn,
} from "./api";
import { CloseButton, Icon, meetingTones, Name, nameTone } from "./Brand";
import { ConfirmButton, Menu, useDismiss } from "./Menu";
import { PlayButton, stopPlayback } from "./Player";
import { SummaryPanel } from "./Summary";

type Props = {
  id: string;
  boot: Bootstrap | null;
  active: Active | null;
  extension: ExtensionState | null;
  calls: AppCall[];
  folders: string[];
  tags: string[];
  /** True for a meeting that the user created now. Tinta does not keep it when the user leaves it without input. */
  fresh: boolean;
  /** True while Tinta imports an audio file. */
  importing: boolean;
  onImport: () => void;
  onActive: (a: Active | null) => void;
  onError: (e: string) => void;
  onDeleted: (id: string, title: string) => void;
  onDiscarded: () => void;
};

/** The time between the last key press in the notes and the save. */
const NOTES_SAVE_MS = 300;
/** The time before Tinta saves the notes again after a save that failed. */
const NOTES_RETRY_MS = 2000;
const TRASH_MS = 7 * 86_400_000;


const NAME_STATE: Record<string, string> = { user: "Confirmed", platform: "Automatic (call app)", self: "Automatic (microphone)" };

const STAGE: Record<string, string> = { transcription: "transcribing", diarization: "separating the speakers" };

// The meetings that the user opened or pointed at. A meeting opens at once from this cache and then loads again.
const cache = new Map<string, MeetingDetail>();
const CACHE_SIZE = 20;

function remember(d: MeetingDetail) {
  cache.delete(d.meeting.id);
  cache.set(d.meeting.id, d);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
}

/** Loads a meeting before the user opens it. The sidebar calls this on hover. */
export function prefetchMeeting(id: string) {
  if (cache.has(id)) return;
  api.getMeeting(id).then(remember).catch(() => undefined);
}

/** One line about the detected call and where the speaker names come from. */
function callStatus(call: AppCall, boot: Bootstrap | null): string {
  if (call.participants.length > 0) return `${call.name} call, ${call.participants.length} people. Names come from ${call.name} (beta).`;
  if (boot?.call_reading) return `${call.name} call. Tinta reads the names when it has Accessibility access and the call window is open.`;
  return `${call.name} call. You name the speakers after the call, or turn on names from ${call.name} in Settings.`;
}

export function MeetingView({ id, boot, active, extension, calls, folders, tags, fresh, importing, onImport, onActive, onError, onDeleted, onDiscarded }: Props) {
  const [detail, setDetail] = useState<MeetingDetail | null>(() => cache.get(id) ?? null);
  const [notes, setNotes] = useState(() => cache.get(id)?.notes ?? "");
  // The notes from the cache can be old, so the field is read-only until the meeting loads.
  const [loaded, setLoaded] = useState(false);
  const [sources, setSources] = useState<Source[]>([]);
  const [route, setRoute] = useState<"speakers" | "headphones" | null>(null);
  const [source, setSource] = useState(boot?.last_source ?? "com.google.Chrome");
  const [progress, setProgress] = useState<{ stage: string; fraction: number } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  /** The path of the last export, for the notice with the copy buttons. */
  const [exported, setExported] = useState<string | null>(null);
  const [busy, setBusy] = useState<"starting" | "stopping" | null>(null);
  const notesTimer = useRef<number | undefined>(undefined);
  const notesSaving = useRef(0);
  /** True while the notes on the screen are not in the library. */
  const notesDirty = useRef(false);
  /** Changes at each edit and at the end of each save, so a load knows that its notes are old. */
  const notesEpoch = useRef(0);
  const loadSeq = useRef(0);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const latestNotes = useRef(cache.get(id)?.notes ?? "");
  const detailRef = useRef<MeetingDetail | null>(cache.get(id) ?? null);
  /** The text in the title field while the user changes it. */
  const titleDraft = useRef<string | null>(null);
  /** True after the user gave the meeting a title, notes, a tag, or a folder. */
  const touched = useRef(false);
  const startRequested = useRef(false);
  const mounted = useRef(true);
  const recordingHere = active?.meeting_id === id;

  const notesIdle = () => !notesTimer.current && notesSaving.current === 0 && !notesDirty.current;

  const show = (d: MeetingDetail) => {
    remember(d);
    detailRef.current = d;
    setDetail(d);
  };

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const epoch = notesEpoch.current;
    const idle = notesIdle();
    try {
      const d = await api.getMeeting(id);
      // A newer load is in progress, and its answer replaces this one.
      if (seq !== loadSeq.current) return;
      // A live turn can arrive while the meeting loads. The load keeps the live turns that it does not contain.
      const before = detailRef.current;
      const last = d.turns.reduce((max, t) => Math.max(max, t.id), 0);
      const later = before && d.meeting.state !== "ready" ? before.turns.filter((t) => t.provisional && t.id > last) : [];
      show(later.length > 0 ? { ...d, turns: [...d.turns, ...later] } : d);
      setLoaded(true);
      // A reload does not replace notes that the user types or that are not saved yet.
      if (idle && epoch === notesEpoch.current && notesIdle()) {
        setNotes(d.notes);
        latestNotes.current = d.notes;
      }
    } catch (e) {
      onError(String(e));
    }
  }, [id, onError]);

  /** Saves the notes now. A save that fails runs again after a short time. */
  const flush = useCallback(() => {
    window.clearTimeout(notesTimer.current);
    notesTimer.current = undefined;
    if (!notesDirty.current) return;
    const value = latestNotes.current;
    notesSaving.current += 1;
    api
      .setNotes(id, value)
      .then(() => {
        if (latestNotes.current === value) notesDirty.current = false;
      })
      .catch((e) => {
        onError(String(e));
        if (mounted.current) notesTimer.current ??= window.setTimeout(flush, NOTES_RETRY_MS);
      })
      .finally(() => {
        notesSaving.current -= 1;
        notesEpoch.current += 1;
      });
  }, [id, onError]);

  /** Saves a new title. Returns false when the title is empty or did not change. */
  const commitTitle = useCallback(
    (value: string) => {
      titleDraft.current = null;
      const title = value.trim();
      if (!title || title === detailRef.current?.meeting.title) return false;
      touched.current = true;
      api.setTitle(id, title).catch((e) => onError(String(e)));
      return true;
    },
    [id, onError],
  );

  useEffect(() => {
    mounted.current = true;
    void load();
    api
      .listSources()
      .then((r) => {
        setSources(r.sources);
        setRoute(r.route);
      })
      .catch(() => undefined);
    const subs = [
      on<{ id: string }>("meeting_changed", (p) => p.id === id && void load()),
      on<Turn>("live_turn", (t) => {
        const d = detailRef.current;
        if (t.meeting_id !== id || !d || d.turns.some((o) => o.id === t.id)) return;
        show({ ...d, turns: [...d.turns, t] });
      }),
      on<EngineEvent>("engine", (e) => {
        if (e.event !== "finalize_progress" || (e.id && e.id !== id)) return;
        setProgress({ stage: String(e.stage), fraction: Number(e.fraction) });
      }),
      on<{ id: string; named: number; remote_speakers: number }>("final_pass", (p) => {
        if (p.id !== id) return;
        setProgress(null);
        const unnamed = p.remote_speakers - p.named;
        if (unnamed > 0) {
          setMessage(`${unnamed === 1 ? "1 speaker has" : `${unnamed} speakers have`} no name. Click a speaker name in the transcript to name it.`);
        }
      }),
    ];
    // The window can close or go to the background before the save timer runs.
    const hidden = () => document.visibilityState === "hidden" && flush();
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", flush);
    return () => {
      mounted.current = false;
      subs.forEach((s) => s.then((u) => u()));
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", flush);
      stopPlayback();
      // Save the pending edits when the user opens another view. The title field gets no blur event when it goes away.
      if (titleDraft.current !== null) commitTitle(titleDraft.current);
      window.clearTimeout(notesTimer.current);
      notesTimer.current = undefined;
      if (notesDirty.current) api.setNotes(id, latestNotes.current).catch((e) => onError(String(e)));
      // A new meeting that the user leaves without a recording or any input is not kept.
      const d = detailRef.current;
      if (fresh && d && !touched.current && !startRequested.current && d.meeting.state === "draft" && !d.meeting.started_at) {
        cache.delete(id);
        api
          .discardDraft(id)
          .then((discarded) => discarded && onDiscarded())
          .catch(() => undefined);
      }
    };
  }, [id]);

  // One color list for the header and the transcript. The order is the speakers first, then the live names.
  const tones = useMemo(() => {
    if (!detail) return new Map<string, number>();
    const listed = detail.speakers.length > 0
      ? detail.speakers.map((sp) => detail.names[sp.id]).filter(Boolean)
      : detail.participants.map((p) => (p.is_self ? "You" : p.name));
    return meetingTones([...listed, ...detail.turns.map((t) => speakerName(detail.names, t))]);
  }, [detail?.speakers, detail?.names, detail?.participants, detail?.turns]);

  // A detected desktop app call selects its app as the meeting audio.
  const detectedApp = calls[0]?.app;
  useEffect(() => {
    if (detectedApp) setSource(detectedApp);
  }, [detectedApp]);

  function changeNotes(value: string) {
    setNotes(value);
    latestNotes.current = value;
    touched.current = true;
    notesDirty.current = true;
    notesEpoch.current += 1;
    // The meeting opens from the cache the next time, so the cache gets the new notes.
    const cached = cache.get(id);
    if (cached) cache.set(id, { ...cached, notes: value });
    window.clearTimeout(notesTimer.current);
    notesTimer.current = window.setTimeout(flush, NOTES_SAVE_MS);
  }

  function insertTimestamp() {
    const el = notesRef.current;
    if (!el || !active) return;
    const stamp = `[${clock((Date.now() - active.start_wall_ms) / 1000)}] `;
    const from = el.selectionStart;
    const next = notes.slice(0, from) + stamp + notes.slice(el.selectionEnd);
    changeNotes(next);
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = from + stamp.length;
    });
  }

  async function start() {
    setBusy("starting");
    startRequested.current = true;
    try {
      onActive(await api.startRecording(id, source));
      await load();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function stop() {
    setBusy("stopping");
    try {
      await api.stopRecording();
      onActive(null);
      await load();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function pause(paused: boolean) {
    try {
      await api.pauseRecording(paused);
    } catch (e) {
      onError(String(e));
    }
  }

  async function mute(muted: boolean) {
    try {
      await api.setMicMuted(muted);
    } catch (e) {
      onError(String(e));
    }
  }

  if (!detail) return <MeetingSkeleton />;
  const m = detail.meeting;
  const ready = m.state === "ready";
  const imported = m.source === "granola";
  const trashed = m.deleted_at !== null;
  const saving = busy === "stopping" && !recordingHere;
  const extensionInCall = extension?.meeting_code && extension.last_seen && Date.now() - extension.last_seen < 30_000;
  const callApp = active?.app_call ? (calls.find((c) => c.app === active.app_call)?.name ?? "the call app") : "Meet";

  const people = Array.from(
    new Set(
      detail.speakers.length > 0
        ? detail.speakers.map((sp) => detail.names[sp.id]).filter(Boolean)
        : detail.participants.map((p) => (p.is_self ? "You" : p.name)),
    ),
  );

  return (
    <div className="meeting">
      <div className="meeting-body">
      <header className="meeting-header">
        <div className="header-row">
          <div className="date">
            {dateTime(m.started_at ?? m.created_at)}
            {m.language && <> · {languageName(m.language)}</>}
          </div>
          <MeetingTools detail={detail} recording={recordingHere} onError={onError} onDeleted={onDeleted} onMessage={setMessage} onExported={setExported} onChanged={load} />
        </div>
        <input
          className="title"
          defaultValue={m.title}
          key={m.title}
          aria-label="Meeting title"
          readOnly={trashed}
          onChange={(e) => (titleDraft.current = e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          onBlur={(e) => {
            if (!e.target.value.trim()) e.target.value = m.title;
            commitTitle(e.target.value);
          }}
        />
        <div className="metadata">
          {people.length > 0 && (
            <span className="people">
              {people.map((p, i) => (
                <span key={p}>
                  {i > 0 && ", "}
                  <Name name={p} tones={tones} />
                </span>
              ))}
            </span>
          )}
          {m.duration > 0 && <span>{Math.max(1, Math.round(m.duration / 60))} minutes</span>}
          {imported && <span className="tag">Imported from Granola</span>}
          {m.archived && <span className="tag">Archived</span>}
        </div>
        <MeetingTags detail={detail} folders={folders} tags={tags} onError={onError} onChanged={load} onTouched={() => (touched.current = true)} />
      </header>

      {trashed && (
        <div className="info-bar trash-bar" role="status">
          <span>This meeting is in the trash. Tinta deletes it on {dateTime((m.deleted_at ?? 0) + TRASH_MS)}.</span>
          <button className="quiet" onClick={() => api.restore(id).catch((e) => onError(String(e)))}>
            Restore
          </button>
        </div>
      )}

      {message && (
        <div className="info-bar" role="status">
          <span>{message}</span>
          <CloseButton onClick={() => setMessage(null)} />
        </div>
      )}
      {exported && <ExportedBar path={exported} onError={onError} onClose={() => setExported(null)} />}

      {m.state === "draft" && !recordingHere && (
        <section className="panel record-panel">
          <div className="notice">
            <strong>Tell everyone in the call that you record it.</strong> Tinta does not tell them.
          </div>
          <div className="row">
            <label>
              Meeting audio
              <select value={source} onChange={(e) => setSource(e.target.value)} disabled={!!busy || importing}>
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.playing ? " (playing)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <button className="primary big" disabled={!boot?.models_installed || !!active || !!busy || importing} onClick={start}>
              {busy === "starting" ? "Starting…" : "Start recording"}
            </button>
            <button className="quiet" onClick={onImport} disabled={!!busy || importing}>
              Or import an audio file
            </button>
          </div>
          {importing && (
            <div className="small muted" role="status">
              Importing the audio file…
            </div>
          )}
          {!boot?.models_installed && <div className="warn small">Install the speech models in Settings first.</div>}
          {!!active && <div className="warn small">Another meeting is recording. Stop it first.</div>}
          {source === "all" && <div className="warn small">All system audio includes every app and browser tab on this Mac.</div>}
          {route === "speakers" && (
            <div className="small warn">Sound plays through speakers. Tinta removes the echo, but headphones give a better transcript.</div>
          )}
          {boot?.microphone === "undetermined" && <div className="small muted">macOS asks for microphone access when the recording starts.</div>}
          {boot?.microphone === "denied" && (
            <div className="warn small row">
              <span>macOS blocks the microphone. Turn on Tinta in the Microphone settings.</span>
              <button onClick={() => allowMicrophone("denied").catch((e) => onError(String(e)))}>Open Microphone settings</button>
            </div>
          )}
          <div className="small muted">
            {calls.length > 0
              ? calls.map((c) => callStatus(c, boot)).join(" ")
              : extensionInCall
                ? `Meet call, ${extension?.participants.length} people. Names come from Meet.`
                : "No call detected. You name the speakers after the call."}
          </div>
        </section>
      )}

      {recordingHere && active && (
        <RecordingPanel active={active} callApp={callApp} stopping={busy === "stopping"} onPause={pause} onMute={mute} onStop={stop} />
      )}

      {saving && <section className="panel quiet-panel">Saving the recording…</section>}

      {m.state === "processing" && !saving && (
        <section className="panel quiet-panel progress-panel">
          <span>
            Processing the recording{progress ? `: ${STAGE[progress.stage] ?? progress.stage}` : ""}…{" "}
            <span className="small">Tinta improves the transcript and matches the speaker names.</span>
          </span>
          <div
            className={`meter-bar wide ${progress ? "" : "indeterminate"}`}
            role="progressbar"
            aria-label="Processing"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress ? Math.round(progress.fraction * 100) : undefined}
          >
            <div style={progress ? { transform: `scaleX(${Math.max(0.02, progress.fraction)})` } : undefined} />
          </div>
        </section>
      )}
      {m.state === "failed" && (
        <section className="panel warn row failure-panel">
          {m.error === NO_SPEECH_ERROR ? (
            <div className="grow">
              <strong>No speech in this recording</strong>
              <p className="small">
                Tinta heard no one speak, so there is no transcript. Make sure that your microphone works and that the meeting
                audio plays on this Mac. Your notes stay in the meeting.
              </p>
            </div>
          ) : (
            <div className="grow">
              <strong>Tinta could not make the transcript</strong>
              <p className="small">The recording is safe. Click Process again to try one more time.</p>
              {m.error && (
                <details className="small">
                  <summary>Details</summary>
                  {m.error}
                </details>
              )}
            </div>
          )}
          <button onClick={() => api.runFinalPass(id, null).then(load).catch((e) => onError(String(e)))}>Process again</button>
        </section>
      )}

      {ready && <SummaryPanel detail={detail} boot={boot} onError={onError} onMessage={setMessage} />}

      <Workspace details={ready}>
        <section className="column notes-column">
          <div className="column-head">
            <h2>Your notes</h2>
            {recordingHere && (
              <button className="quiet" onClick={insertTimestamp} title="Insert the current recording time">
                Insert timestamp
              </button>
            )}
          </div>
          <textarea
            ref={notesRef}
            className="notes"
            value={notes}
            aria-label="Your notes"
            placeholder="Write your notes. They save automatically."
            readOnly={!loaded || trashed}
            onChange={(e) => changeNotes(e.target.value)}
            onBlur={flush}
          />
        </section>
        <section className="column transcript-column">
          <div className="column-head">
            <h2>Transcript</h2>
            {!ready && detail.turns.length > 0 && <span className="small muted">Live draft. You can edit it after processing.</span>}
          </div>
          <Transcript detail={detail} tones={tones} editable={ready} timed={!imported} onError={onError} onChanged={load} />
        </section>
      </Workspace>

      {ready && (
        <div className="columns">
          <section className="column">
            <Speakers detail={detail} onError={onError} onChanged={load} />
          </section>
          <section className="column">
            <AudioAndLanguage key={m.language ?? ""} detail={detail} onError={onError} onChanged={load} />
          </section>
        </div>
      )}
      </div>
    </div>
  );
}

/** The layout of a meeting while it loads, so the content does not jump. */
function MeetingSkeleton() {
  return (
    <div className="meeting" aria-busy="true">
      <div className="meeting-body">
        <div className="skeleton line short" />
        <div className="skeleton line title" />
        <div className="skeleton line medium" />
        <div className="workspace side skeleton-workspace">
          <div className="column" />
          <div />
          <div className="column" />
        </div>
      </div>
    </div>
  );
}

/** The recording controls. The clock and the level meters update here, so the transcript does not render again. */
function RecordingPanel({ active, callApp, stopping, onPause, onMute, onStop }: { active: Active; callApp: string; stopping: boolean; onPause: (paused: boolean) => void; onMute: (muted: boolean) => void; onStop: () => void }) {
  const [now, setNow] = useState(Date.now());
  const [levels, setLevels] = useState({ mic: 0, remote: 0, capturing: false });
  const muted = active.mic_muted;
  const micLabel = !muted ? "Microphone" : active.mic_muted_by_user ? "Microphone (muted)" : `Microphone (muted in ${callApp})`;
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const sub = on<EngineEvent>("engine", (e) => {
      if (e.event !== "levels") return;
      setLevels({ mic: Number(e.mic), remote: Number(e.remote), capturing: Boolean(e.remote_capturing) });
    });
    return () => {
      clearInterval(tick);
      void sub.then((u) => u());
    };
  }, []);
  return (
    <section className="panel record-panel recording">
      <div className="row">
        <span className={`rec-dot big ${active.paused ? "paused" : ""}`} /> <strong role="status">{active.paused ? "Paused" : "Recording"}</strong>
        <span className="timer">{clock((now - active.start_wall_ms) / 1000)}</span>
        <button
          className={`icon-button mic-toggle ${muted ? "muted" : ""}`}
          onClick={() => onMute(!muted)}
          disabled={stopping}
          aria-pressed={muted}
          aria-label={muted ? "Unmute the microphone" : "Mute the microphone"}
          title={muted ? "Record the microphone again" : "Do not record the microphone"}
        >
          <Icon name={muted ? "mic-off" : "mic"} size={15} />
        </button>
        <Meter label={micLabel} value={muted || active.paused ? 0 : levels.mic} />
        <Meter label={levels.capturing ? "Meeting audio" : "Meeting audio (no sound yet)"} value={active.paused ? 0 : levels.remote} />
        <button onClick={() => onPause(!active.paused)} disabled={stopping}>
          {active.paused ? "Resume" : "Pause"}
        </button>
        <button className="danger" onClick={onStop} disabled={stopping}>
          {stopping ? "Stopping…" : "Stop"}
        </button>
      </div>
      {muted && (
        <div className="small muted">
          {active.mic_muted_by_user
            ? "Tinta does not record your microphone. Click the microphone button to record it again."
            : `Your microphone is muted in ${callApp}. Tinta does not record it until you unmute. To record it now, click the microphone button.`}
        </div>
      )}
      {!levels.capturing && <div className="warn small">Tinta starts to capture the meeting audio when the app plays sound.</div>}
    </section>
  );
}

// Stack notes over the transcript on tall or narrow windows. Below 900 px, the two columns do not fit side by side.
const STACKED = "(max-aspect-ratio: 1/1) and (min-height: 820px), (max-width: 1100px) and (min-height: 760px), (max-width: 900px)";

function useStacked(): boolean {
  const [stacked, setStacked] = useState(() => window.matchMedia(STACKED).matches);
  useEffect(() => {
    const media = window.matchMedia(STACKED);
    const change = () => setStacked(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  return stacked;
}

const MIN_RATIO = 0.25;
const MAX_RATIO = 0.75;
const clampRatio = (r: number) => Math.min(MAX_RATIO, Math.max(MIN_RATIO, r));

/** Notes and transcript with a divider that the user can drag. Each layout keeps its own ratio. */
function Workspace({ details, children }: { details: boolean; children: [React.ReactNode, React.ReactNode] }) {
  const stacked = useStacked();
  const key = stacked ? "tinta-split-stacked" : "tinta-split-side";
  const [ratio, setRatio] = useState(() => clampRatio(Number(localStorage.getItem(key)) || 0.5));
  const box = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  useEffect(() => setRatio(clampRatio(Number(localStorage.getItem(key)) || 0.5)), [key]);

  function save(next: number) {
    const value = clampRatio(next);
    setRatio(value);
    localStorage.setItem(key, String(value));
  }

  function move(e: React.PointerEvent) {
    if (!dragging.current || !box.current) return;
    const rect = box.current.getBoundingClientRect();
    save(stacked ? (e.clientY - rect.top) / rect.height : (e.clientX - rect.left) / rect.width);
  }

  const template = `minmax(0, ${ratio}fr) 12px minmax(0, ${1 - ratio}fr)`;
  return (
    <div
      ref={box}
      className={`workspace ${stacked ? "stacked" : "side"} ${details ? "with-details" : ""}`}
      style={stacked ? { gridTemplateRows: template } : { gridTemplateColumns: template }}
    >
      {children[0]}
      <div
        className="splitter"
        role="separator"
        aria-orientation={stacked ? "horizontal" : "vertical"}
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={MIN_RATIO * 100}
        aria-valuemax={MAX_RATIO * 100}
        aria-label="Resize notes and transcript"
        tabIndex={0}
        onPointerDown={(e) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={move}
        onPointerUp={() => (dragging.current = false)}
        onDoubleClick={() => save(0.5)}
        onKeyDown={(e) => {
          const back = stacked ? "ArrowUp" : "ArrowLeft";
          const forward = stacked ? "ArrowDown" : "ArrowRight";
          if (e.key === back) save(ratio - 0.05);
          if (e.key === forward) save(ratio + 0.05);
        }}
      >
        <span />
      </div>
      {children[1]}
    </div>
  );
}

function Meter({ label, value }: { label: string; value: number }) {
  const scale = Math.min(1, Math.sqrt(value) * 1.8);
  return (
    <div className="meter">
      <div className="small muted">{label}</div>
      <div className="meter-bar">
        <div style={{ transform: `scaleX(${scale})` }} />
      </div>
    </div>
  );
}

function speakerName(names: Record<string, string>, turn: Turn): string {
  if (turn.speaker_id && names[turn.speaker_id]) return names[turn.speaker_id];
  if (turn.live_name) return turn.live_name;
  return turn.track === "mic" ? "You" : "Speaker";
}

type TranscriptProps = { detail: MeetingDetail; tones: Map<string, number>; editable: boolean; timed: boolean; onError: (e: string) => void; onChanged: () => void };

/** The speakers of the meeting, for the popover of a turn. Only an open popover reads them, so a reload does not render every turn again. */
const SpeakersContext = createContext<{ speakers: Speaker[]; names: Record<string, string> }>({ speakers: [], names: {} });

const Transcript = memo(function Transcript({ detail, tones, editable, timed, onError, onChanged }: TranscriptProps) {
  const box = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const turns = useMemo(() => [...detail.turns].sort((a, b) => a.start - b.start || a.id - b.id), [detail.turns]);
  const speakers = useMemo(() => new Map(detail.speakers.map((s) => [s.id, s])), [detail.speakers]);
  const speakerList = useMemo(() => ({ speakers: detail.speakers, names: detail.names }), [detail.speakers, detail.names]);

  // The live transcript follows new turns only while the user is at the end of it.
  useEffect(() => {
    if (!editable && atBottom.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [turns.length, editable]);

  if (turns.length === 0) return <div className="muted pad">No transcript yet.</div>;

  return (
    <SpeakersContext.Provider value={speakerList}>
      <div
        className="transcript"
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {turns.map((t) => (
          <TurnRow
            key={t.id}
            turn={t}
            name={speakerName(detail.names, t)}
            tone={nameTone(speakerName(detail.names, t), tones)}
            speaker={t.speaker_id ? speakers.get(t.speaker_id) : undefined}
            editable={editable}
            timed={timed}
            playable={!detail.meeting.audio_deleted}
            onError={onError}
            onChanged={onChanged}
          />
        ))}
      </div>
    </SpeakersContext.Provider>
  );
});

type TurnRowProps = {
  turn: Turn;
  name: string;
  /** The color class of the speaker name. */
  tone: string;
  speaker: Speaker | undefined;
  editable: boolean;
  timed: boolean;
  playable: boolean;
  onError: (e: string) => void;
  onChanged: () => void;
};

/** A reload gives new objects with the same content. A row renders again only when its content changes. */
function sameTurnRow(a: TurnRowProps, b: TurnRowProps): boolean {
  const s = a.turn;
  const t = b.turn;
  return (
    s.id === t.id &&
    s.text === t.text &&
    s.start === t.start &&
    s.track === t.track &&
    s.speaker_id === t.speaker_id &&
    s.edited === t.edited &&
    s.name_changed === t.name_changed &&
    s.provisional === t.provisional &&
    s.live_name === t.live_name &&
    a.name === b.name &&
    a.tone === b.tone &&
    a.speaker?.id === b.speaker?.id &&
    a.speaker?.name === b.speaker?.name &&
    a.editable === b.editable &&
    a.timed === b.timed &&
    a.playable === b.playable &&
    a.onError === b.onError &&
    a.onChanged === b.onChanged
  );
}

const TurnRow = memo(function TurnRow({ turn: t, name, tone, speaker, editable, timed, playable, onError, onChanged }: TurnRowProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const speakerBox = useRef<HTMLSpanElement>(null);
  const speakerButton = useRef<HTMLButtonElement>(null);
  const unnamed = !!speaker && !speaker.name;

  async function save() {
    try {
      if (draft !== null && draft !== t.text) await api.editTurnText(t.id, draft);
      setDraft(null);
      onChanged();
    } catch (e) {
      onError(String(e));
    }
  }

  return (
    <div className={`turn ${t.provisional ? "provisional" : ""} ${t.track}`}>
      <div className="turn-content">
        <div className="turn-head">
          {editable ? (
            <span className="speaker-box" ref={speakerBox}>
              <button
                ref={speakerButton}
                className={`speaker speaker-button ${unnamed ? "unnamed" : tone}`}
                onClick={() => setNaming(!naming)}
                aria-expanded={naming}
                title="Name this speaker, or give this turn to another speaker"
              >
                {name}
              </button>
              {naming && (
                <SpeakerPopover
                  turn={t}
                  speaker={speaker}
                  boundary={speakerBox}
                  onClose={(focus) => {
                    setNaming(false);
                    if (focus) speakerButton.current?.focus();
                  }}
                  onError={onError}
                  onChanged={onChanged}
                />
              )}
            </span>
          ) : (
            <span className={`speaker ${unnamed ? "unnamed" : tone}`}>{name}</span>
          )}
          {timed && <time>{clock(t.start)}</time>}
          {t.provisional && t.live_name && (
            <span className="tag" title="The name comes from the call. Processing confirms it.">
              unconfirmed
            </span>
          )}
          {t.name_changed && <span className="tag changed" title={`Live name: ${t.live_name}`}>name changed from {t.live_name}</span>}
          {editable && playable && (
            <span className="turn-actions">
              <PlayButton id={`turn-${t.id}`} label="Play" load={() => api.turnAudio(t.id)} onError={onError} />
            </span>
          )}
        </div>
        {draft !== null ? (
          <div>
            <textarea
              className="turn-edit"
              value={draft}
              autoFocus
              aria-label="Turn text"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setDraft(null);
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void save();
              }}
            />
            <div className="row edit-actions">
              <button className="primary" onClick={save}>
                Save
              </button>
              <button className="quiet" onClick={() => setDraft(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : editable ? (
          <div
            className="turn-text editable"
            role="button"
            tabIndex={0}
            title="Click to edit"
            onClick={() => {
              // A drag over the text selects it, for a copy. Only a plain click opens the editor.
              if (window.getSelection()?.isCollapsed === false) return;
              setDraft(t.text);
            }}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setDraft(t.text))}
          >
            {t.text}
            {t.edited && <span className="tag">edited</span>}
          </div>
        ) : (
          <div className="turn-text">
            {t.text}
            {t.edited && <span className="tag">edited</span>}
          </div>
        )}
      </div>
    </div>
  );
}, sameTurnRow);

type SpeakerPopoverProps = {
  turn: Turn;
  speaker: Speaker | undefined;
  /** The speaker name and the popover. A click on the name closes the popover with the button, not with the click outside. */
  boundary: RefObject<HTMLElement>;
  /** `focus` is true when the focus must go back to the speaker name. */
  onClose: (focus: boolean) => void;
  onError: (e: string) => void;
  onChanged: () => void;
};

/** Names the speaker of a turn, or gives the turn to another speaker. */
function SpeakerPopover({ turn, speaker, boundary, onClose, onError, onChanged }: SpeakerPopoverProps) {
  const { speakers, names } = useContext(SpeakersContext);
  useDismiss(boundary, true, onClose);
  const act = (p: Promise<unknown>) =>
    p
      .then(() => {
        onClose(true);
        onChanged();
      })
      .catch((e) => onError(String(e)));
  return (
    <div className="popover speaker-popover">
      {speaker && (
        <label>
          Name of this speaker
          <input
            list="participant-names"
            defaultValue={speaker.name ?? ""}
            placeholder={names[speaker.id]}
            autoFocus
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              const name = e.currentTarget.value.trim();
              act(api.renameSpeaker(speaker.id, name || null));
            }}
          />
          <span className="small muted">Press Return to save. The name applies to every turn of this speaker.</span>
        </label>
      )}
      <label>
        This turn belongs to
        <select
          value={turn.speaker_id ?? ""}
          onChange={(e) => act(api.reassignTurn(turn.id, e.target.value === "new" ? null : e.target.value))}
        >
          {!turn.speaker_id && (
            <option value="" disabled>
              No speaker
            </option>
          )}
          {speakers.map((s) => (
            <option key={s.id} value={s.id}>
              {names[s.id] ?? s.label}
            </option>
          ))}
          <option value="new">A new speaker</option>
        </select>
      </label>
    </div>
  );
}

function Speakers({ detail, onError, onChanged }: { detail: MeetingDetail; onError: (e: string) => void; onChanged: () => void }) {
  const participants = detail.participants.filter((p) => !p.is_self);
  const seconds = useMemo(() => {
    const total = new Map<string, number>();
    for (const t of detail.turns) if (t.speaker_id) total.set(t.speaker_id, (total.get(t.speaker_id) ?? 0) + t.end - t.start);
    return total;
  }, [detail.turns]);
  const act = (p: Promise<unknown>) => p.then(onChanged).catch((e) => onError(String(e)));
  // A merge has no undo, so the row asks before it merges.
  const [merge, setMerge] = useState<{ from: string; into: string } | null>(null);
  const label = (speakerId: string) => detail.names[speakerId] ?? detail.speakers.find((o) => o.id === speakerId)?.label ?? "this speaker";
  return (
    <div>
      <h2>Speakers</h2>
      <datalist id="participant-names">
        {participants.map((p) => (
          <option key={p.participant_id} value={p.name} />
        ))}
      </datalist>
      {detail.speakers.map((s) => (
        <div key={s.id} className="speaker-row">
          <div className="speaker-main">
            <input
              list="participant-names"
              defaultValue={s.name ?? ""}
              key={`${s.id}-${s.name}`}
              placeholder={detail.names[s.id]}
              aria-label={`Name of ${detail.names[s.id] ?? s.label}`}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              onBlur={(e) => e.target.value.trim() !== (s.name ?? "") && act(api.renameSpeaker(s.id, e.target.value.trim() || null))}
            />
            <span className="tag">{s.name ? NAME_STATE[s.name_source ?? ""] ?? "Named" : "Unnamed"}</span>
            {detail.meeting.source !== "granola" && <span className="small muted">{clock(seconds.get(s.id) ?? 0)} speaking</span>}
          </div>
          <div className="speaker-actions">
            {!detail.meeting.audio_deleted && (
              <PlayButton id={`speaker-${s.id}`} label="Play sample" load={() => api.speakerSample(s.id)} onError={onError} />
            )}
            {s.name && s.name_source !== "user" && (
              <button className="quiet" onClick={() => act(api.renameSpeaker(s.id, s.name))}>
                Confirm name
              </button>
            )}
            {!s.name && s.suggestion && (
              <button className="quiet" onClick={() => act(api.renameSpeaker(s.id, s.suggestion))}>
                Use suggestion: {s.suggestion}
              </button>
            )}
            {merge?.from === s.id && (
              <span className="confirm-row" onKeyDown={(e) => e.key === "Escape" && setMerge(null)}>
                <span className="small warn">
                  Merge {label(merge.from)} into {label(merge.into)}? You cannot undo this.
                </span>
                <button className="quiet" autoFocus onClick={() => setMerge(null)}>
                  Cancel
                </button>
                <button
                  className="danger"
                  onClick={() => {
                    setMerge(null);
                    void act(api.mergeSpeakers(merge.from, merge.into));
                  }}
                >
                  Merge
                </button>
              </span>
            )}
            {detail.speakers.length > 1 && merge?.from !== s.id && (
              <select
                className="inline-select"
                value=""
                aria-label="Merge into another speaker"
                onChange={(e) => e.target.value && setMerge({ from: s.id, into: e.target.value })}
              >
                <option value="">Merge into…</option>
                {detail.speakers
                  .filter((o) => o.id !== s.id)
                  .map((o) => (
                    <option key={o.id} value={o.id}>
                      {detail.names[o.id] ?? o.label}
                    </option>
                  ))}
              </select>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function AudioAndLanguage({ detail, onError, onChanged }: { detail: MeetingDetail; onError: (e: string) => void; onChanged: () => void }) {
  const m = detail.meeting;
  const [language, setLanguage] = useState<string>(m.language ?? "");
  const processAgain = () => api.runFinalPass(m.id, language || null).then(onChanged).catch((e) => onError(String(e)));
  if (m.source === "granola") {
    return (
      <div>
        <h2>Imported from Granola</h2>
        <p className="muted">
          This meeting has no audio and no timestamps, so SRT and VTT export is not available. Speaker names come from Granola.
          Correct them in the list of speakers.
        </p>
      </div>
    );
  }
  const base = m.ended_at ?? m.created_at;
  const days = m.audio_until ? Math.round((m.audio_until - base) / 86_400_000) : 7;
  // An MCP client can set a period that is not in the usual list.
  const periods = Array.from(new Set([...RETENTION_DAYS, days])).sort((a, b) => a - b);
  return (
    <div>
      <h2>Audio</h2>
      {m.audio_deleted ? (
        <p className="muted">The audio is deleted. The notes and the transcript stay until you delete the meeting.</p>
      ) : m.audio_trashed_at ? (
        <p className="muted">The audio is in the trash. It uses {bytes(detail.audio_bytes)}.</p>
      ) : (
        <>
          <p>
            The audio uses <strong>{bytes(detail.audio_bytes)}</strong>. Tinta deletes it on <strong>{dateTime(m.audio_until)}</strong>.
          </p>
          <label>
            Keep audio for{" "}
            <select
              value={days}
              onChange={(e) =>
                api.setAudioRetention(m.id, Number(e.target.value)).then(onChanged).catch((err) => onError(String(err)))
              }
            >
              {periods.map((d) => (
                <option key={d} value={d}>
                  {d === 1 ? "1 day" : `${d} days`}
                </option>
              ))}
            </select>{" "}
            after processing
          </label>
          <div>
            <ConfirmButton
              label="Delete audio now"
              question="Delete the audio of this meeting?"
              confirm="Delete audio"
              onConfirm={() => api.deleteAudio(m.id).then(onChanged).catch((e) => onError(String(e)))}
            />
          </div>
        </>
      )}
      <h2>Language</h2>
      <p className="small muted">Tinta detects the language. If it is wrong, select the language and click Process again.</p>
      <select value={language} onChange={(e) => setLanguage(e.target.value)} aria-label="Language">
        <option value="">Automatic</option>
        {LANGUAGES.map((code) => ({ code, name: languageName(code) }))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(({ code, name }) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
      </select>{" "}
      {detail.has_speaker_changes && !detail.has_edits && !m.audio_deleted ? (
        // A new pass makes new speakers, so the names and the merges that the user set do not stay.
        <ConfirmButton
          label="Process again"
          question="Process again? Tinta removes the speaker names and the merges that you set."
          confirm="Process again"
          onConfirm={processAgain}
        />
      ) : (
        <button
          disabled={detail.has_edits || m.audio_deleted}
          title={detail.has_edits ? "The transcript has edits. Processing again does not overwrite them." : ""}
          onClick={processAgain}
        >
          Process again
        </button>
      )}
    </div>
  );
}

/** The tags and the folder of a meeting, as chips. */
type TagsProps = { detail: MeetingDetail; folders: string[]; tags: string[]; onError: (e: string) => void; onChanged: () => void; onTouched: () => void };

function MeetingTags({ detail, folders, tags, onError, onChanged, onTouched }: TagsProps) {
  const m = detail.meeting;
  const [adding, setAdding] = useState<"tag" | "folder" | null>(null);
  // Return saves and closes the field. The blur that follows does not save again.
  const committed = useRef(false);

  const saveTags = (tags: string[]) => (onTouched(), api.setTags(m.id, tags).then(onChanged).catch((e) => onError(String(e))));
  const saveFolder = (folder: string | null) => (onTouched(), api.setFolder(m.id, folder).then(onChanged).catch((e) => onError(String(e))));

  function open(kind: "tag" | "folder") {
    committed.current = false;
    setAdding(kind);
  }

  function commit(value: string) {
    if (committed.current) return;
    committed.current = true;
    const text = value.trim();
    if (adding === "tag") {
      const next = text.split(",").map((t) => t.trim()).filter((t) => t && !m.tags.includes(t));
      if (next.length > 0) void saveTags([...m.tags, ...next]);
    } else if (adding === "folder" && text !== (m.folder ?? "")) {
      void saveFolder(text || null);
    }
    setAdding(null);
  }

  return (
    <div className="chip-row">
      {m.folder && adding !== "folder" && (
        <span className="chip">
          <button className="chip-label" onClick={() => open("folder")} title="Change the folder">
            <Icon name="folder" size={12} /> {m.folder}
          </button>
          <button className="chip-remove" onClick={() => void saveFolder(null)} aria-label={`Remove from the folder ${m.folder}`}>
            <Icon name="close" size={10} />
          </button>
        </span>
      )}
      {m.tags.map((t) => (
        <span key={t} className="chip">
          <span className="chip-label">{t}</span>
          <button className="chip-remove" onClick={() => void saveTags(m.tags.filter((o) => o !== t))} aria-label={`Remove the tag ${t}`}>
            <Icon name="close" size={10} />
          </button>
        </span>
      ))}
      {adding ? (
        <input
          className="chip-input"
          autoFocus
          list={adding === "folder" ? "folder-names" : "tag-names"}
          defaultValue={adding === "folder" ? (m.folder ?? "") : ""}
          placeholder={adding === "folder" ? "Folder" : "Tag"}
          aria-label={adding === "folder" ? "Folder" : "New tag"}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit(e.currentTarget.value);
            if (e.key === "Escape") {
              committed.current = true;
              setAdding(null);
            }
          }}
          onBlur={(e) => commit(e.target.value)}
        />
      ) : (
        <>
          <button className="quiet chip-add" onClick={() => open("tag")}>
            <Icon name="plus" size={12} /> Tag
          </button>
          {!m.folder && (
            <button className="quiet chip-add" onClick={() => open("folder")}>
              <Icon name="plus" size={12} /> Folder
            </button>
          )}
        </>
      )}
      <datalist id="folder-names">
        {folders.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
      <datalist id="tag-names">
        {tags
          .filter((t) => !m.tags.includes(t))
          .map((t) => (
            <option key={t} value={t} />
          ))}
      </datalist>
    </div>
  );
}

type ToolsProps = {
  detail: MeetingDetail;
  recording: boolean;
  onError: (e: string) => void;
  onDeleted: (id: string, title: string) => void;
  onMessage: (m: string) => void;
  onExported: (path: string) => void;
  onChanged: () => void;
};

/** The notice after an export, with buttons that copy the path or the file. */
function ExportedBar({ path, onError, onClose }: { path: string; onError: (e: string) => void; onClose: () => void }) {
  const [copied, setCopied] = useState<"path" | "file" | null>(null);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  useEffect(() => setCopied(null), [path]);
  const copy = (kind: "path" | "file") =>
    (kind === "path" ? navigator.clipboard.writeText(path) : api.copyFile(path))
      .then(() => setCopied(kind))
      .catch((e) => onError(String(e)));
  return (
    <div className="info-bar" role="status">
      <span className="export-path" title={path}>
        Exported to {path}
      </span>
      <button className="quiet" onClick={() => copy("path")}>
        {copied === "path" ? "Copied" : "Copy path"}
      </button>
      <button className="quiet" onClick={() => copy("file")} title="Copy the file, to paste it in Finder, Mail, or a chat app">
        {copied === "file" ? "Copied" : "Copy file"}
      </button>
      <CloseButton onClick={onClose} />
    </div>
  );
}

function MeetingTools({ detail, recording, onError, onDeleted, onMessage, onExported, onChanged }: ToolsProps) {
  const m = detail.meeting;
  async function exportAs(format: string) {
    try {
      onExported(await api.exportFile(m.id, format));
    } catch (e) {
      onError(String(e));
    }
  }
  const copy = (text: Promise<string> | string, done: string) =>
    Promise.resolve(text)
      .then((t) => navigator.clipboard.writeText(t))
      .then(() => onMessage(done))
      .catch((e) => onError(String(e)));
  return (
    <div className="toolbar-actions">
      <label className="quiet select-quiet">
        <Icon name="export" size={15} />
        <select value="" onChange={(e) => e.target.value && exportAs(e.target.value)} aria-label="Export">
          <option value="">Export</option>
          <option value="md">Markdown</option>
          <option value="json">JSON</option>
          {m.source !== "granola" && <option value="srt">SRT</option>}
          {m.source !== "granola" && <option value="vtt">VTT</option>}
        </select>
      </label>
      <Menu
        label="More actions"
        items={[
          { label: "Copy as Markdown", onSelect: () => void copy(api.exportText(m.id, "md"), "Copied the meeting as Markdown.") },
          { label: "Copy the meeting ID", title: "MCP clients use the ID to find this meeting.", onSelect: () => void copy(m.id, "Copied the meeting ID.") },
          {
            label: m.archived ? "Unarchive" : "Archive",
            onSelect: () =>
              api
                .setArchived(m.id, !m.archived)
                .then(onChanged)
                .catch((e) => onError(String(e))),
          },
          {
            label: "Move to the trash",
            danger: true,
            disabled: recording,
            title: recording ? "Stop the recording first" : "Tinta keeps the meeting in the trash for 7 days.",
            onSelect: () => api.trashMeeting(m.id).then(() => onDeleted(m.id, m.title)).catch((e) => onError(String(e))),
          },
        ]}
      />
    </div>
  );
}
