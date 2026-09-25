import { useEffect, useState } from "react";
import { Active, AppCall, Bootstrap, clock, dateTime, ExtensionState, Meeting, Preview, relativeDate } from "./api";
import { Icon, InkMark, Name } from "./Brand";
import { pressable } from "./MeetingList";

type Props = {
  boot: Bootstrap | null;
  meetings: Meeting[];
  previews: Record<string, Preview>;
  /** Shows a folder or a tag in the sidebar list. */
  onFilter: (filter: string) => void;
  active: Active | null;
  extension: ExtensionState | null;
  calls: AppCall[];
  onOpen: (id: string) => void;
  onRecordCall: (source: string) => void;
  onSettings: () => void;
  onAllowMicrophone: () => void;
  onRetry: (id: string) => void;
  /** A new meeting or a recording is starting. */
  busy: boolean;
};

const DAY = 86_400_000;

function greeting(name: string, now: Date): string {
  const hour = now.getHours();
  const part = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const first = name.trim().split(/\s+/)[0];
  return first ? `${part}, ${first}` : part;
}

export function Home({ boot, meetings, previews, onFilter, active, extension, calls, onOpen, onRecordCall, onSettings, onAllowMicrophone, onRetry, busy }: Props) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const inCall = !!(extension?.meeting_code && extension.last_seen && now - extension.last_seen < 30_000);
  const appCall = calls[0];
  const everConnected = !!extension?.connected_at;
  const recording = active ? meetings.find((m) => m.id === active.meeting_id) : undefined;
  const ready = boot?.models_installed ?? false;

  const setup = boot
    ? [
        { done: boot.models_installed, label: "Install the speech models", detail: "About 500 MB, once. This is the only download.", action: onSettings },
        boot.microphone === "denied"
          ? { done: false, label: "Allow the microphone", detail: "macOS blocks it. Turn on Tinta in the Microphone settings.", action: onAllowMicrophone }
          : { done: boot.microphone === "granted", label: "Allow the microphone", detail: "macOS asks you one time.", action: onAllowMicrophone },
        { done: everConnected, label: "Connect the Meet extension", detail: "Remote speakers get names on Google Meet in Chrome.", action: onSettings },
        { done: boot.filevault, label: "Turn on FileVault", detail: "System Settings, Privacy and Security.", action: undefined },
      ]
    : [];
  const pending = setup.filter((s) => !s.done);

  const attention = meetings.filter(
    (m) =>
      m.state === "failed" ||
      (m.state === "ready" && !m.audio_deleted && !m.audio_trashed_at && m.audio_until !== null && m.audio_until - now < 2 * DAY),
  );
  const recent = meetings.filter((m) => m.id !== active?.meeting_id).slice(0, 6);
  const week = meetings.filter((m) => now - (m.started_at ?? m.created_at) < 7 * DAY);
  const weekMinutes = Math.round(week.reduce((sum, m) => sum + m.duration, 0) / 60);

  return (
    <div className="home">
      <header className="home-header">
        <div>
          <div className="eyebrow">{new Date(now).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</div>
          <h1>{greeting(boot?.self_name ?? "", new Date(now))}</h1>
          <p className="muted">
            {week.length === 0
              ? "No meetings this week yet."
              : `${week.length} ${week.length === 1 ? "meeting" : "meetings"} this week${weekMinutes > 0 ? `, ${weekMinutes} minutes transcribed` : ""}.`}
          </p>
        </div>
      </header>

      {recording && active ? (
        <section className="hero hero-recording" onClick={() => onOpen(recording.id)}>
          <span className="rec-dot big" />
          <div className="hero-text">
            <div className="eyebrow">{active.paused ? "Paused" : "Recording now"}</div>
            <h2>{recording.title}</h2>
            <p>Write your notes in the meeting.</p>
          </div>
          <span className="timer">{clock((now - active.start_wall_ms) / 1000)}</span>
          <button className="primary" onClick={(e) => (e.stopPropagation(), onOpen(recording.id))}>
            Open meeting
          </button>
        </section>
      ) : inCall ? (
        <section className="hero hero-call">
          <InkMark size={44} />
          <div className="hero-text">
            <div className="eyebrow">Google Meet call</div>
            <h2>{extension?.title || extension?.meeting_code}</h2>
            <p>
              {people(extension?.participants.length ?? 0)} Tell everyone that you record the call.
            </p>
          </div>
          <RecordButton ready={ready} busy={busy} onClick={() => onRecordCall("com.google.Chrome")} />
        </section>
      ) : appCall ? (
        <section className="hero hero-call">
          <InkMark size={44} />
          <div className="hero-text">
            <div className="eyebrow">Call detected</div>
            <h2>{appCall.name}</h2>
            <p>
              {appCall.participants.length > 0
                ? `${people(appCall.participants.length)} Names come from ${appCall.name} (beta). `
                : "You name the speakers after the call. "}
              Tell everyone that you record the call.
            </p>
          </div>
          <RecordButton ready={ready} busy={busy} onClick={() => onRecordCall(appCall.app)} />
        </section>
      ) : (
        <section className="hero">
          <InkMark size={44} />
          <div className="hero-text">
            <div className="eyebrow">A little ink. A clear record.</div>
            <h2>
              Stay in the <em>conversation.</em>
            </h2>
            <p>Join a call in Google Meet, Zoom, or Microsoft Teams, and Tinta offers to record it. For other apps, create a new meeting.</p>
          </div>
        </section>
      )}

      <div className={`home-grid ${pending.length > 0 || attention.length > 0 ? "" : "single"}`}>
        <div className="home-main">
          <div className="section-head">
            <h2>Recent meetings</h2>
          </div>
          {recent.length === 0 ? (
            <div className="empty-card">
              Your meetings appear here.
            </div>
          ) : (
            <div className="cards">
              {recent.map((m) => {
                const preview = previews[m.id];
                return (
                <div key={m.id} className="meeting-card" {...pressable(() => onOpen(m.id))}>
                  <div className="card-top">
                    <Icon name="document" />
                    {(m.state === "processing" || m.state === "failed") && (
                      <span className={`badge ${m.state}`}>{m.state === "failed" ? "Processing failed" : "Processing"}</span>
                    )}
                  </div>
                  <strong>{m.title}</strong>
                  <span className="muted small">
                    {relativeDate(m.started_at ?? m.created_at)}
                    {m.duration > 0 && ` · ${Math.max(1, Math.round(m.duration / 60))} min`}
                  </span>
                  {preview && preview.people.length > 0 && (
                    <span className="card-people" title={preview.people.join(", ")}>
                      {preview.people.slice(0, 3).map((p, i) => (
                        <span key={p}>
                          {i > 0 && ", "}
                          <Name name={p} />
                        </span>
                      ))}
                      {preview.people.length > 3 && ` and ${preview.people.length - 3} more`}
                    </span>
                  )}
                  {preview?.summary && <span className="card-summary">{preview.summary}</span>}
                  {(m.folder || m.tags.length > 0) && (
                    <span className="card-tags">
                      {m.folder && (
                        <button className="tag tag-button" onClick={(e) => (e.stopPropagation(), onFilter(`folder:${m.folder}`))} title="Show this folder">
                          <Icon name="folder" size={10} /> {m.folder}
                        </button>
                      )}
                      {m.tags.slice(0, 3).map((t) => (
                        <button key={t} className="tag tag-button" onClick={(e) => (e.stopPropagation(), onFilter(`tag:${t}`))} title="Show meetings with this tag">
                          {t}
                        </button>
                      ))}
                    </span>
                  )}
                </div>
                );
              })}
            </div>
          )}
        </div>

        {(pending.length > 0 || attention.length > 0) && (
        <aside className="home-side">
          {pending.length > 0 && (
            <section className="side-card">
              <h2>Get ready</h2>
              <ul className="checklist">
                {setup.map((s) => (
                  <li key={s.label} className={s.done ? "done" : ""}>
                    <span className="check">{s.done ? "✓" : ""}</span>
                    <div>
                      {s.action && !s.done ? (
                        <button className="quiet" onClick={s.action}>
                          {s.label}
                        </button>
                      ) : (
                        <span>{s.label}</span>
                      )}
                      {!s.done && <div className="small muted">{s.detail}</div>}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {attention.length > 0 && (
            <section className="side-card">
              <h2>Needs attention</h2>
              {attention.map((m) => (
                <div key={m.id} className="attention-row">
                  <button className="quiet" onClick={() => onOpen(m.id)}>
                    {m.title}
                  </button>
                  <div className="small muted">
                    {m.state === "failed" && "Processing failed."}
                    {m.state === "ready" && m.audio_until && `The audio is deleted ${dateTime(m.audio_until)}.`}
                  </div>
                  {m.state === "failed" && (
                    <button onClick={() => onRetry(m.id)}>Process again</button>
                  )}
                </div>
              ))}
            </section>
          )}
        </aside>
        )}
      </div>
    </div>
  );
}

function people(count: number): string {
  return count === 1 ? "1 person in the call." : `${count} people in the call.`;
}

function RecordButton({ ready, busy, onClick }: { ready: boolean; busy: boolean; onClick: () => void }) {
  return (
    <button className="primary big" disabled={!ready || busy} onClick={onClick} title={ready ? "" : "Install the speech models first"}>
      {busy ? "Starting…" : "Record this call"}
    </button>
  );
}
