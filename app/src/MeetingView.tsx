import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Active,
  api,
  AppCall,
  Bootstrap,
  bytes,
  clock,
  dateTime,
  ExtensionState,
  LANGUAGES,
  languageName,
  MeetingDetail,
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
  onImport: () => void;
  onActive: (a: Active | null) => void;
  onError: (e: string) => void;
  onDeleted: (id: string, title: string) => void;
  onDiscarded: () => void;
};

type EngineEvent = { event: string; id?: string; [key: string]: unknown };

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

export function MeetingView({ id, boot, active, extension, calls, folders, tags, onImport, onActive, onError, onDeleted, onDiscarded }: Props) {
  const [detail, setDetail] = useState<MeetingDetail | null>(() => cache.get(id) ?? null);
  const [notes, setNotes] = useState(() => cache.get(id)?.notes ?? "");
  const [sources, setSources] = useState<Source[]>([]);
  const [route, setRoute] = useState<"speakers" | "headphones" | null>(null);
  const [source, setSource] = useState(boot?.last_source ?? "com.google.Chrome");
  const [progress, setProgress] = useState<{ stage: string; fraction: number } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<"starting" | "stopping" | null>(null);
  const notesTimer = useRef<number | undefined>(undefined);
  const notesSaving = useRef(0);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const latestNotes = useRef(cache.get(id)?.notes ?? "");
  const detailRef = useRef<MeetingDetail | null>(cache.get(id) ?? null);
  const firstTitle = useRef<string | null>(null);
  const firstFolder = useRef<string | null | undefined>(undefined);
  const startRequested = useRef(false);
  const recordingHere = active?.meeting_id === id;

  const load = useCallback(async () => {
    try {
      const d = await api.getMeeting(id);
      remember(d);
      detailRef.current = d;
      firstTitle.current ??= d.meeting.title;
      if (firstFolder.current === undefined) firstFolder.current = d.meeting.folder;
      setDetail(d);
      // A reload does not replace notes that the user types or that are not saved yet.
      if (!notesTimer.current && notesSaving.current === 0) {
        setNotes(d.notes);
        latestNotes.current = d.notes;
      }
    } catch (e) {
      onError(String(e));
    }
  }, [id, onError]);

  useEffect(() => {
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
        if (t.meeting_id !== id) return;
        setDetail((d) => (d ? { ...d, turns: [...d.turns, t] } : d));
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
    return () => {
      subs.forEach((s) => s.then((u) => u()));
      stopPlayback();
      // Save a pending edit when the user opens another view.
      if (notesTimer.current) {
        window.clearTimeout(notesTimer.current);
        notesTimer.current = undefined;
        api.setNotes(id, latestNotes.current).catch((e) => onError(String(e)));
      }
      // A new meeting that the user leaves without a recording or any input is not kept.
      const d = detailRef.current;
      if (
        d &&
        !startRequested.current &&
        d.meeting.state === "draft" &&
        !d.meeting.started_at &&
        !latestNotes.current.trim() &&
        d.meeting.tags.length === 0 &&
        d.meeting.folder === firstFolder.current &&
        d.meeting.title === firstTitle.current
      ) {
        cache.delete(id);
        api
          .trashMeeting(id)
          .then(() => api.deleteMeeting(id))
          .then(onDiscarded)
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
    if (notesTimer.current) window.clearTimeout(notesTimer.current);
    notesTimer.current = window.setTimeout(() => {
      notesTimer.current = undefined;
      notesSaving.current += 1;
      api
        .setNotes(id, value)
        .catch((e) => onError(String(e)))
        .finally(() => (notesSaving.current -= 1));
    }, 600);
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
      if (active) onActive({ ...active, paused });
    } catch (e) {
      onError(String(e));
    }
  }

  if (!detail) return <MeetingSkeleton />;
  const m = detail.meeting;
  const ready = m.state === "ready";
  const imported = m.source === "granola";
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
          <MeetingTools detail={detail} recording={recordingHere} onError={onError} onDeleted={onDeleted} onMessage={setMessage} onChanged={load} />
        </div>
        <input
          className="title"
          defaultValue={m.title}
          key={m.title}
          aria-label="Meeting title"
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          onBlur={(e) => {
            const title = e.target.value.trim();
            if (!title) e.target.value = m.title;
            else if (title !== m.title) api.setTitle(id, title).catch((err) => onError(String(err)));
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
        <MeetingTags detail={detail} folders={folders} tags={tags} onError={onError} onChanged={load} />
      </header>

      {message && (
        <div className="info-bar" role="status">
          <span>{message}</span>
          <CloseButton onClick={() => setMessage(null)} />
        </div>
      )}

      {m.state === "draft" && !recordingHere && (
        <section className="panel record-panel">
          <div className="notice">
            <strong>Tell everyone in the call that you record it.</strong> Tinta does not tell them.
          </div>
          <div className="row">
            <label>
              Meeting audio
              <select value={source} onChange={(e) => setSource(e.target.value)} disabled={!!busy}>
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.playing ? " (playing)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <button className="primary big" disabled={!boot?.models_installed || !!active || !!busy} onClick={start}>
              {busy === "starting" ? "Starting…" : "Start recording"}
            </button>
            <button className="quiet" onClick={onImport} disabled={!!busy}>
              Or import an audio file
            </button>
          </div>
          {!boot?.models_installed && <div className="warn small">Install the speech models in Settings first.</div>}
          {!!active && <div className="warn small">Another meeting is recording. Stop it first.</div>}
          {source === "all" && <div className="warn small">All system audio includes every app and browser tab on this Mac.</div>}
          {route === "speakers" && (
            <div className="small warn">Sound plays through speakers. Tinta removes the echo, but headphones give a better transcript.</div>
          )}
          {boot?.microphone !== "granted" && <div className="small muted">macOS asks for microphone access when the recording starts.</div>}
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
        <RecordingPanel active={active} callApp={callApp} stopping={busy === "stopping"} onPause={pause} onStop={stop} />
      )}

      {saving && <section className="panel quiet-panel">Saving the recording…</section>}

      {m.state === "processing" && !saving && (
        <section className="panel quiet-panel progress-panel">
          <span>
            Processing the recording{progress ? `: ${STAGE[progress.stage] ?? progress.stage}` : ""}…{" "}
            <span className="small">Tinta improves the transcript and matches the speaker names.</span>
          </span>
          <div className={`meter-bar wide ${progress ? "" : "indeterminate"}`}>
            <div style={progress ? { transform: `scaleX(${Math.max(0.02, progress.fraction)})` } : undefined} />
          </div>
        </section>
      )}
      {m.state === "failed" && (
        <section className="panel warn row">
          <span>Processing failed: {m.error}</span>
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
            placeholder="Write your notes. They save automatically."
            onChange={(e) => changeNotes(e.target.value)}
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
            <AudioAndLanguage detail={detail} onError={onError} onChanged={load} />
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
function RecordingPanel({ active, callApp, stopping, onPause, onStop }: { active: Active; callApp: string; stopping: boolean; onPause: (paused: boolean) => void; onStop: () => void }) {
  const [now, setNow] = useState(Date.now());
  const [levels, setLevels] = useState({ mic: 0, remote: 0, capturing: false, micMuted: false });
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const sub = on<EngineEvent>("engine", (e) => {
      if (e.event !== "levels") return;
      setLevels({ mic: Number(e.mic), remote: Number(e.remote), capturing: Boolean(e.remote_capturing), micMuted: Boolean(e.mic_muted) });
    });
    return () => {
      clearInterval(tick);
      void sub.then((u) => u());
    };
  }, []);
  return (
    <section className="panel record-panel recording">
      <div className="row">
        <span className={`rec-dot big ${active.paused ? "paused" : ""}`} /> <strong>{active.paused ? "Paused" : "Recording"}</strong>
        <span className="timer">{clock((now - active.start_wall_ms) / 1000)}</span>
        <Meter label={levels.micMuted ? `Microphone (muted in ${callApp})` : "Microphone"} value={levels.mic} />
        <Meter label={levels.capturing ? "Meeting audio" : "Meeting audio (no sound yet)"} value={levels.remote} />
        <button onClick={() => onPause(!active.paused)} disabled={stopping}>
          {active.paused ? "Resume" : "Pause"}
        </button>
        <button className="danger" onClick={onStop} disabled={stopping}>
          {stopping ? "Stopping…" : "Stop"}
        </button>
      </div>
      {levels.micMuted && <div className="small muted">Your microphone is muted in {callApp}. Tinta does not record it until you unmute.</div>}
      {!levels.capturing && <div className="warn small">Tinta starts to capture the meeting audio when the app plays sound.</div>}
    </section>
  );
}

// Stack notes over the transcript on tall or narrow windows.
const STACKED = "(max-aspect-ratio: 1/1) and (min-height: 820px), (max-width: 1100px) and (min-height: 760px)";

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

const Transcript = memo(function Transcript({ detail, tones, editable, timed, onError, onChanged }: TranscriptProps) {
  const box = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const turns = useMemo(() => [...detail.turns].sort((a, b) => a.start - b.start || a.id - b.id), [detail.turns]);
  const speakers = useMemo(() => new Map(detail.speakers.map((s) => [s.id, s])), [detail.speakers]);

  // The live transcript follows new turns only while the user is at the end of it.
  useEffect(() => {
    if (!editable && atBottom.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [turns.length, editable]);

  if (turns.length === 0) return <div className="muted pad">No transcript yet.</div>;

  return (
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
          speakers={detail.speakers}
          names={detail.names}
          onError={onError}
          onChanged={onChanged}
        />
      ))}
    </div>
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
  speakers: Speaker[];
  names: Record<string, string>;
  onError: (e: string) => void;
  onChanged: () => void;
};

const TurnRow = memo(function TurnRow({ turn: t, name, tone, speaker, editable, timed, playable, speakers, names, onError, onChanged }: TurnRowProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
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
            <span className="speaker-box">
              <button
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
                  speakers={speakers}
                  names={names}
                  onClose={() => setNaming(false)}
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
            onClick={() => setDraft(t.text)}
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
});

type SpeakerPopoverProps = {
  turn: Turn;
  speaker: Speaker | undefined;
  speakers: Speaker[];
  names: Record<string, string>;
  onClose: () => void;
  onError: (e: string) => void;
  onChanged: () => void;
};

/** Names the speaker of a turn, or gives the turn to another speaker. */
function SpeakerPopover({ turn, speaker, speakers, names, onClose, onError, onChanged }: SpeakerPopoverProps) {
  const box = useRef<HTMLDivElement>(null);
  useDismiss(box, true, onClose);
  const act = (p: Promise<unknown>) =>
    p
      .then(() => {
        onClose();
        onChanged();
      })
      .catch((e) => onError(String(e)));
  return (
    <div className="popover speaker-popover" ref={box}>
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
            {detail.speakers.length > 1 && (
              <select
                className="inline-select"
                value=""
                aria-label="Merge into another speaker"
                onChange={(e) => e.target.value && act(api.mergeSpeakers(s.id, e.target.value))}
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
              {RETENTION_DAYS.map((d) => (
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
      <button
        disabled={detail.has_edits || m.audio_deleted}
        title={detail.has_edits ? "The transcript has edits. Processing again does not overwrite them." : ""}
        onClick={() => api.runFinalPass(m.id, language || null).then(onChanged).catch((e) => onError(String(e)))}
      >
        Process again
      </button>
    </div>
  );
}

/** The tags and the folder of a meeting, as chips. */
type TagsProps = { detail: MeetingDetail; folders: string[]; tags: string[]; onError: (e: string) => void; onChanged: () => void };

function MeetingTags({ detail, folders, tags, onError, onChanged }: TagsProps) {
  const m = detail.meeting;
  const [adding, setAdding] = useState<"tag" | "folder" | null>(null);
  // Return saves and closes the field. The blur that follows does not save again.
  const committed = useRef(false);

  const saveTags = (tags: string[]) => api.setTags(m.id, tags).then(onChanged).catch((e) => onError(String(e)));
  const saveFolder = (folder: string | null) => api.setFolder(m.id, folder).then(onChanged).catch((e) => onError(String(e)));

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
  onChanged: () => void;
};

function MeetingTools({ detail, recording, onError, onDeleted, onMessage, onChanged }: ToolsProps) {
  const m = detail.meeting;
  async function exportAs(format: string) {
    try {
      const path = await api.exportFile(m.id, format);
      onMessage(`Exported to ${path}`);
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
