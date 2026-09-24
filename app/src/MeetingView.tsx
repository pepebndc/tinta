import { useEffect, useMemo, useRef, useState } from "react";
import { Active, api, AppCall, Bootstrap, bytes, clock, dateTime, ExtensionState, MeetingDetail, on, RETENTION_DAYS, Source, Speaker, Turn } from "./api";
import { Avatar, Icon } from "./Brand";
import { PlayButton, stopPlayback } from "./Player";
import { SummaryPanel } from "./Summary";

type Props = {
  id: string;
  boot: Bootstrap | null;
  active: Active | null;
  extension: ExtensionState | null;
  calls: AppCall[];
  onActive: (a: Active | null) => void;
  onError: (e: string) => void;
  onDeleted: () => void;
};

type EngineEvent = { event: string; [key: string]: unknown };

const NAME_STATE: Record<string, string> = { user: "Confirmed", platform: "Automatic (call app)", self: "Automatic (microphone)" };

/** One line about a detected desktop app call and where the speaker names come from. */
function callStatus(call: AppCall, boot: Bootstrap | null): string {
  if (call.participants.length > 0) {
    return `${call.name}: ${call.participants.length} participants. Names come from ${call.name} (beta).`;
  }
  if (boot?.call_reading) {
    return `${call.name}: call detected. Tinta reads the names when macOS allows Accessibility access and the call window is open.`;
  }
  return `${call.name}: call detected. You name the speakers after the call, or turn on names from ${call.name} in Settings.`;
}

export function MeetingView({ id, boot, active, extension, calls, onActive, onError, onDeleted }: Props) {
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [notes, setNotes] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const [route, setRoute] = useState<"speakers" | "headphones" | null>(null);
  const [source, setSource] = useState(boot?.last_source ?? "com.google.Chrome");
  const [levels, setLevels] = useState({ mic: 0, remote: 0, capturing: false, micMuted: false });
  const [progress, setProgress] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const notesTimer = useRef<number | undefined>(undefined);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const latestNotes = useRef("");
  const recordingHere = active?.meeting_id === id;

  async function load() {
    try {
      const d = await api.getMeeting(id);
      setDetail(d);
      setNotes((current) => (notesTimer.current ? current : d.notes));
    } catch (e) {
      onError(String(e));
    }
  }

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
        if (e.event === "levels") {
          setLevels({
            mic: Number(e.mic),
            remote: Number(e.remote),
            capturing: Boolean(e.remote_capturing),
            micMuted: Boolean(e.mic_muted),
          });
        } else if (e.event === "finalize_progress") {
          setProgress(`${e.stage}: ${Math.round(Number(e.fraction) * 100)}%`);
        } else if (e.event === "error" || e.event === "warning") {
          setMessage(String(e.message));
        }
      }),
      on<{ id: string; named: number; remote_speakers: number }>("final_pass", (p) => {
        if (p.id !== id) return;
        setProgress(null);
        setMessage(`Final pass done. Names from the call found for ${p.named} of ${p.remote_speakers} remote speakers.`);
      }),
    ];
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      subs.forEach((s) => s.then((u) => u()));
      clearInterval(tick);
      stopPlayback();
      // Save a pending edit when the user opens another view.
      if (notesTimer.current) {
        window.clearTimeout(notesTimer.current);
        notesTimer.current = undefined;
        api.setNotes(id, latestNotes.current).catch((e) => onError(String(e)));
      }
    };
  }, [id]);

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
      api.setNotes(id, value).catch((e) => onError(String(e)));
    }, 600);
  }

  const elapsed = recordingHere && active ? (now - active.start_wall_ms) / 1000 : null;

  function insertTimestamp() {
    const el = notesRef.current;
    if (!el) return;
    const stamp = `[${clock(elapsed ?? 0)}] `;
    const next = notes.slice(0, el.selectionStart) + stamp + notes.slice(el.selectionEnd);
    changeNotes(next);
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = el.selectionStart + stamp.length;
    });
  }

  async function start() {
    try {
      onActive(await api.startRecording(id, source));
      await load();
    } catch (e) {
      onError(String(e));
    }
  }

  async function stop() {
    try {
      await api.stopRecording();
      onActive(null);
      setProgress("starting the final pass");
      await load();
    } catch (e) {
      onError(String(e));
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

  if (!detail) return <div className="pad muted">Loading…</div>;
  const m = detail.meeting;
  const ready = m.state === "ready";
  const imported = m.source === "granola";
  const extensionInCall = extension?.meeting_code && extension.last_seen && now - extension.last_seen < 30_000;
  const callApp = active?.app_call ? (calls.find((c) => c.app === active.app_call)?.name ?? "the call app") : "Meet";

  const people = Array.from(
    new Set(
      detail.speakers.length > 0
        ? detail.speakers.map((sp) => detail.names[sp.id]).filter(Boolean)
        : detail.participants.map((p) => (p.is_self ? "You" : p.name)),
    ),
  );
  const status = recordingHere
    ? active?.paused
      ? "Paused · Audio stays on this Mac"
      : "Recording · Transcribing on this Mac"
    : m.state === "ready"
      ? "Transcript ready · Processed on this Mac"
      : m.state === "processing"
        ? `Final pass running on this Mac${progress ? ` · ${progress}` : ""}`
        : m.state === "failed"
          ? "Final pass failed"
          : "Ready to record";

  return (
    <div className="meeting">
      <div className="toolbar">
        <span className="breadcrumb">
          Your meetings / <span>{m.title}</span>
        </span>
        <MeetingTools detail={detail} onError={onError} onDeleted={onDeleted} onMessage={setMessage} />
      </div>
      <div className="meeting-body">
      <header className="meeting-header">
        <div className="date">
          {dateTime(m.started_at ?? m.created_at)}
          {m.language && <> · {m.language === "es" ? "Spanish" : m.language === "en" ? "English" : m.language}</>}
          <button
            className="id-chip"
            title={`Meeting ID ${m.id}. MCP clients use it to find this meeting.`}
            onClick={() =>
              navigator.clipboard
                .writeText(m.id)
                .then(() => setMessage(`Copied the meeting ID ${m.id}. MCP clients can use it to find this meeting.`))
                .catch((e) => onError(String(e)))
            }
          >
            ID {m.id.slice(0, 8)} · Copy
          </button>
        </div>
        <input
          className="title"
          defaultValue={m.title}
          key={m.title}
          aria-label="Meeting title"
          onBlur={(e) => e.target.value !== m.title && api.setTitle(id, e.target.value).catch((err) => onError(String(err)))}
        />
        <div className="metadata">
          {people.length > 0 && (
            <span className="avatars">
              {people.slice(0, 5).map((p) => (
                <Avatar key={p} name={p} />
              ))}
            </span>
          )}
          {people.length > 0 && <span>{people.join(", ")}</span>}
          {m.duration > 0 && <span>{Math.max(1, Math.round(m.duration / 60))} minutes</span>}
          {imported && <span className="tag">Imported from Granola</span>}
          {m.state !== "ready" && (
            <span className={`badge ${m.state}`}>{recordingHere && active?.paused ? "paused" : m.state}</span>
          )}
        </div>
        <MeetingTags detail={detail} onError={onError} />
      </header>

      {message && (
        <div className="info-bar" onClick={() => setMessage(null)}>
          {message}
        </div>
      )}

      {m.state === "draft" && !recordingHere && (
        <section className="panel record-panel">
          <div className="notice">
            <strong>Tell everyone in the call that you record and transcribe this meeting.</strong> Tinta does not tell
            other participants.
          </div>
          <div className="row">
            <label>
              Meeting audio
              <select value={source} onChange={(e) => setSource(e.target.value)}>
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.playing ? " (playing)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <button className="primary big" disabled={!boot?.models_installed || !!active} onClick={start}>
              Start recording
            </button>
          </div>
          {source === "all" && <div className="warn small">All system audio includes every app and browser tab on this Mac.</div>}
          <div className="small muted">
            Microphone: macOS default input. {boot?.microphone !== "granted" && "macOS asks for microphone access at the first recording."}
          </div>
          {route === "speakers" && (
            <div className="small warn">
              Sound plays through speakers. Tinta removes the echo, but headphones give a better transcript.
            </div>
          )}
          {route === "headphones" && <div className="small muted">Headphones detected. Tinta records your microphone directly.</div>}
          <div className="small muted">
            {calls.length > 0
              ? calls.map((c) => callStatus(c, boot)).join(" ")
              : extensionInCall
                ? `Meet: ${extension?.title ?? extension?.meeting_code}, ${extension?.participants.length} participants. Names come from Meet.`
                : "No call detected. Remote speakers get names only on Google Meet in Chrome with the extension."}
          </div>
          {!!active && <div className="warn small">Another meeting is recording.</div>}
        </section>
      )}

      {recordingHere && (
        <section className="panel record-panel recording">
          <div className="row">
            <span className="rec-dot big" /> <strong>{active?.paused ? "Paused" : "Recording"}</strong>
            <span className="timer">{clock(elapsed ?? 0)}</span>
            <Meter label={levels.micMuted ? `Microphone (muted in ${callApp})` : "Microphone"} value={levels.mic} />
            <Meter label={levels.capturing ? "Meeting audio" : "Meeting audio (not detected)"} value={levels.remote} />
            <button onClick={() => pause(!active?.paused)}>{active?.paused ? "Resume" : "Pause"}</button>
            <button className="danger" onClick={stop}>
              Stop
            </button>
          </div>
          {levels.micMuted && (
            <div className="small muted">Your microphone is muted in {callApp}. Tinta does not record it until you unmute.</div>
          )}
          {!levels.capturing && (
            <div className="warn small">
              No audio from the selected app yet. The app starts to capture when the meeting app plays sound.
            </div>
          )}
        </section>
      )}

      {m.state === "processing" && (
        <section className="panel quiet-panel">Final pass running on this Mac{progress ? `: ${progress}` : "…"}</section>
      )}
      {m.state === "failed" && (
        <section className="panel warn">
          The final pass failed: {m.error}
          <button onClick={() => api.runFinalPass(id, null).then(load).catch((e) => onError(String(e)))}>Run the final pass again</button>
        </section>
      )}

      {ready && <SummaryPanel detail={detail} boot={boot} onError={onError} onMessage={setMessage} />}

      <Workspace details={ready}>
        <section className="column notes-column">
          <div className="column-head">
            <h2>Your notes</h2>
            <button className="small-button" onClick={insertTimestamp} title="Insert the current recording time">
              Insert timestamp
            </button>
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
            {!ready && detail.turns.length > 0 && <span className="small muted">Draft. Editing starts after the final pass.</span>}
          </div>
          <Transcript detail={detail} editable={ready} timed={!imported} onError={onError} onChanged={load} />
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
      <footer className="statusbar">
        <span>
          <i className={`dot ${recordingHere && !active?.paused ? "live" : ""}`} />
          {status}
        </span>
        <span>{detail.turns.length > 0 ? `${detail.turns.length} turns` : ""}</span>
      </footer>
    </div>
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
  const pct = Math.min(100, Math.round(Math.sqrt(value) * 180));
  return (
    <div className="meter">
      <div className="small muted">{label}</div>
      <div className="meter-bar">
        <div style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function speakerName(detail: MeetingDetail, turn: Turn): string {
  if (turn.speaker_id && detail.names[turn.speaker_id]) return detail.names[turn.speaker_id];
  if (turn.live_name) return turn.live_name;
  return turn.track === "mic" ? "You" : "Remote";
}

function Transcript({ detail, editable, timed, onError, onChanged }: { detail: MeetingDetail; editable: boolean; timed: boolean; onError: (e: string) => void; onChanged: () => void }) {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const turns = useMemo(() => [...detail.turns].sort((a, b) => a.start - b.start || a.id - b.id), [detail.turns]);

  useEffect(() => {
    if (!editable && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [turns.length, editable]);

  if (turns.length === 0) return <div className="muted pad">No transcript yet.</div>;

  async function save(turn: Turn) {
    try {
      if (draft !== turn.text) await api.editTurnText(turn.id, draft);
      setEditing(null);
      onChanged();
    } catch (e) {
      onError(String(e));
    }
  }

  return (
    <div className="transcript" ref={box}>
      {turns.map((t) => {
        const name = speakerName(detail, t);
        const speaker = detail.speakers.find((s) => s.id === t.speaker_id);
        const unnamed = speaker && !speaker.name;
        return (
          <div key={t.id} className={`turn ${t.provisional ? "provisional" : ""} ${t.track}`}>
            <Avatar name={name} muted={unnamed} />
            <div className="turn-content">
            <div className="turn-head">
              <span className={`speaker ${unnamed ? "unnamed" : ""}`}>{name}</span>
              {timed && <time>{clock(t.start)}</time>}
              {t.provisional && t.live_name && <span className="tag">provisional</span>}
              {t.name_changed && <span className="tag changed" title={`Live name: ${t.live_name}`}>name changed from {t.live_name}</span>}
              {editable && (
                <span className="turn-actions">
                  {!detail.meeting.audio_deleted && (
                    <PlayButton id={`turn-${t.id}`} label="Play" load={() => api.turnAudio(t.id)} onError={onError} />
                  )}
                  <select
                    className="inline-select"
                    value={t.speaker_id ?? ""}
                    aria-label="Speaker of this turn"
                    onChange={(e) =>
                      api
                        .reassignTurn(t.id, e.target.value === "new" ? null : e.target.value)
                        .then(onChanged)
                        .catch((err) => onError(String(err)))
                    }
                  >
                    {detail.speakers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {detail.names[s.id] ?? s.label}
                      </option>
                    ))}
                    <option value="new">New speaker</option>
                  </select>
                </span>
              )}
            </div>
            {editing === t.id ? (
              <div>
                <textarea className="turn-edit" value={draft} autoFocus onChange={(e) => setDraft(e.target.value)} />
                <button onClick={() => save(t)}>Save</button> <button onClick={() => setEditing(null)}>Cancel</button>
              </div>
            ) : (
              <div
                className={`turn-text ${editable ? "editable" : ""}`}
                onClick={() => {
                  if (!editable) return;
                  setEditing(t.id);
                  setDraft(t.text);
                }}
              >
                {t.text}
                {t.edited && <span className="tag">edited</span>}
              </div>
            )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Speakers({ detail, onError, onChanged }: { detail: MeetingDetail; onError: (e: string) => void; onChanged: () => void }) {
  const participants = detail.participants.filter((p) => !p.is_self);
  const seconds = (s: Speaker) =>
    detail.turns.filter((t) => t.speaker_id === s.id).reduce((sum, t) => sum + (t.end - t.start), 0);
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
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              onBlur={(e) => e.target.value !== (s.name ?? "") && act(api.renameSpeaker(s.id, e.target.value || null))}
            />
            <span className="tag">{s.name ? NAME_STATE[s.name_source ?? ""] ?? "Named" : "Unnamed"}</span>
            {detail.meeting.source !== "granola" && <span className="small muted">{clock(seconds(s))} speaking</span>}
          </div>
          <div className="speaker-actions">
            {!detail.meeting.audio_deleted && (
              <PlayButton id={`speaker-${s.id}`} label="Play sample" load={() => api.speakerSample(s.id)} onError={onError} />
            )}
            {s.name && s.name_source !== "user" && (
              <button className="link" onClick={() => act(api.renameSpeaker(s.id, s.name))}>
                Confirm name
              </button>
            )}
            {!s.name && s.suggestion && (
              <button className="link" onClick={() => act(api.renameSpeaker(s.id, s.suggestion))}>
                Use suggestion: {s.suggestion}
              </button>
            )}
            <select
              className="inline-select"
              value=""
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
          </div>
        </div>
      ))}
    </div>
  );
}

function AudioAndLanguage({ detail, onError, onChanged }: { detail: MeetingDetail; onError: (e: string) => void; onChanged: () => void }) {
  const m = detail.meeting;
  if (m.source === "granola") {
    return (
      <div>
        <h2>Imported from Granola</h2>
        <p className="muted">
          This meeting comes from a Granola export. It has no audio and no timestamps, so SRT and VTT export is not available.
          Speaker names come from Granola. Correct them in the list of speakers.
        </p>
      </div>
    );
  }
  const base = m.ended_at ?? m.created_at;
  const days = m.audio_until ? Math.round((m.audio_until - base) / 86_400_000) : 7;
  const [language, setLanguage] = useState<string>(m.language ?? "");
  return (
    <div>
      <h2>Audio</h2>
      {m.audio_deleted ? (
        <p className="muted">The audio is deleted. The notes and the transcript stay until you delete the meeting.</p>
      ) : m.audio_trashed_at ? (
        <p className="muted">The audio is in the trash. It uses {bytes(detail.audio_bytes)} on this Mac.</p>
      ) : (
        <>
          <p>
            The audio uses <strong>{bytes(detail.audio_bytes)}</strong> on this Mac. The app deletes it on{" "}
            <strong>{dateTime(m.audio_until)}</strong>.
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
                  {d} days
                </option>
              ))}
            </select>{" "}
            after the meeting
          </label>
          <div>
            <button
              className="danger"
              onClick={() =>
                confirm("Delete the audio of this meeting now? You cannot undo this.") &&
                api.deleteAudio(m.id).then(onChanged).catch((e) => onError(String(e)))
              }
            >
              Delete audio now
            </button>
          </div>
        </>
      )}
      <h2>Language</h2>
      <p className="small muted">The app detects the language. Change it and run the final pass again if the detection is wrong.</p>
      <select value={language} onChange={(e) => setLanguage(e.target.value)}>
        <option value="">Automatic</option>
        <option value="en">English</option>
        <option value="es">Spanish</option>
      </select>{" "}
      <button
        disabled={detail.has_edits || m.audio_deleted}
        title={detail.has_edits ? "The transcript has edits. The final pass does not overwrite them." : ""}
        onClick={() => api.runFinalPass(m.id, language || null).then(onChanged).catch((e) => onError(String(e)))}
      >
        Run the final pass again
      </button>
    </div>
  );
}

function MeetingTags({ detail, onError }: { detail: MeetingDetail; onError: (e: string) => void }) {
  const m = detail.meeting;
  const [tags, setTags] = useState(m.tags.join(", "));
  useEffect(() => setTags(m.tags.join(", ")), [m.tags.join(",")]);
  return (
    <div className="tag-row">
      <input
        className="tags"
        placeholder="Add tags, separated by commas"
        value={tags}
        aria-label="Tags"
        onChange={(e) => setTags(e.target.value)}
        onBlur={() => api.setTags(m.id, tags.split(",").map((t) => t.trim()).filter(Boolean)).catch((e) => onError(String(e)))}
      />
      <input
        className="folder"
        placeholder="Folder"
        aria-label="Folder"
        defaultValue={m.folder ?? ""}
        key={m.folder ?? ""}
        onBlur={(e) => e.target.value !== (m.folder ?? "") && api.setFolder(m.id, e.target.value || null).catch((err) => onError(String(err)))}
      />
    </div>
  );
}

function MeetingTools({ detail, onError, onDeleted, onMessage }: { detail: MeetingDetail; onError: (e: string) => void; onDeleted: () => void; onMessage: (m: string) => void }) {
  const m = detail.meeting;
  async function exportAs(format: string) {
    try {
      const path = await api.exportFile(m.id, format);
      onMessage(`Exported to ${path}`);
    } catch (e) {
      onError(String(e));
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(await api.exportText(m.id, "md"));
      onMessage("Copied the meeting as Markdown.");
    } catch (e) {
      onError(String(e));
    }
  }
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
      <button className="quiet" onClick={copy}>Copy</button>
      <button className="quiet" onClick={() => api.setArchived(m.id, !m.archived).catch((e) => onError(String(e)))}>
        {m.archived ? "Unarchive" : "Archive"}
      </button>
      <button
        className="quiet danger"
        onClick={() =>
          confirm("Move this meeting to the trash? The app deletes it permanently after 7 days.") &&
          api.trashMeeting(m.id).then(onDeleted).catch((e) => onError(String(e)))
        }
      >
        Delete
      </button>
    </div>
  );
}
