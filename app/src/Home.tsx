import { useEffect, useState } from "react";
import { Active, AppCall, Bootstrap, clock, dateTime, ExtensionState, Meeting } from "./api";
import { Icon, InkMark } from "./Brand";

type Props = {
  boot: Bootstrap | null;
  meetings: Meeting[];
  active: Active | null;
  extension: ExtensionState | null;
  calls: AppCall[];
  onOpen: (id: string) => void;
  onNew: () => void;
  onImport: () => void;
  onRecordCall: (source: string) => void;
  onSettings: () => void;
  onRetry: (id: string) => void;
  granolaExport: string | null;
  onGranola: () => void;
};

const DAY = 86_400_000;

function greeting(name: string, now: Date): string {
  const hour = now.getHours();
  const part = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const first = name.trim().split(/\s+/)[0];
  return first ? `${part}, ${first}` : part;
}

export function Home({ boot, meetings, active, extension, calls, onOpen, onNew, onImport, onRecordCall, onSettings, onRetry, granolaExport, onGranola }: Props) {
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
        { done: boot.microphone === "granted", label: "Allow the microphone", detail: "macOS asks at the first recording.", action: onSettings },
        { done: everConnected, label: "Connect the Meet extension", detail: "Remote speakers get names on Google Meet in Chrome.", action: onSettings },
        { done: boot.filevault, label: "Turn on FileVault", detail: "System Settings, Privacy and Security.", action: undefined },
      ]
    : [];
  const pending = setup.filter((s) => !s.done);

  const attention = meetings.filter(
    (m) =>
      m.state === "failed" ||
      m.state === "processing" ||
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
        <div className="home-actions">
          <button onClick={onImport}>
            <Icon name="import" /> Import recording
          </button>
          <button className="primary" onClick={onNew}>
            <Icon name="plus" /> New meeting
          </button>
        </div>
      </header>

      {recording && active ? (
        <section className="hero hero-recording" onClick={() => onOpen(recording.id)}>
          <span className="rec-dot big" />
          <div className="hero-text">
            <div className="eyebrow">{active.paused ? "Paused" : "Recording now"}</div>
            <h2>{recording.title}</h2>
            <p>Transcribing on this Mac. Write your notes in the meeting.</p>
          </div>
          <span className="timer">{clock((now - active.start_wall_ms) / 1000)}</span>
          <button className="primary">Open meeting</button>
        </section>
      ) : inCall ? (
        <section className="hero hero-call">
          <InkMark size={44} />
          <div className="hero-text">
            <div className="eyebrow">Google Meet call detected</div>
            <h2>{extension?.title || extension?.meeting_code}</h2>
            <p>
              {extension?.participants.length} people in the call. Tell everyone that you record and transcribe this meeting.
            </p>
          </div>
          <button className="primary big" disabled={!ready} onClick={() => onRecordCall("com.google.Chrome")} title={ready ? "" : "Install the speech models first"}>
            Record this call
          </button>
        </section>
      ) : appCall ? (
        <section className="hero hero-call">
          <InkMark size={44} />
          <div className="hero-text">
            <div className="eyebrow">{appCall.name} call detected</div>
            <h2>{appCall.name} call</h2>
            <p>
              {appCall.participants.length > 0
                ? `${appCall.participants.length} people in the call. Names come from ${appCall.name} (beta). `
                : "You name the speakers after the call. "}
              Tell everyone that you record and transcribe this meeting.
            </p>
          </div>
          <button className="primary big" disabled={!ready} onClick={() => onRecordCall(appCall.app)} title={ready ? "" : "Install the speech models first"}>
            Record this call
          </button>
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

      <div className="home-grid">
        <div className="home-main">
          <div className="section-head">
            <h2>Recent meetings</h2>
          </div>
          {recent.length === 0 ? (
            <div className="empty-card">
              Your meetings appear here. Notes, transcripts, and speaker names stay on this Mac.
            </div>
          ) : (
            <div className="cards">
              {recent.map((m) => (
                <button key={m.id} className="meeting-card" onClick={() => onOpen(m.id)}>
                  <div className="card-top">
                    <Icon name="document" />
                    {m.state !== "ready" && <span className={`badge ${m.state}`}>{m.state}</span>}
                  </div>
                  <strong>{m.title}</strong>
                  <span className="muted small">
                    {dateTime(m.started_at ?? m.created_at)}
                    {m.duration > 0 && ` · ${Math.max(1, Math.round(m.duration / 60))} min`}
                  </span>
                  {m.tags.length > 0 && (
                    <span className="card-tags">
                      {m.tags.slice(0, 3).map((t) => (
                        <span key={t} className="tag">
                          {t}
                        </span>
                      ))}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

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
                        <button className="link" onClick={s.action}>
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
                  <button className="link" onClick={() => onOpen(m.id)}>
                    {m.title}
                  </button>
                  <div className="small muted">
                    {m.state === "failed" && "The final pass failed."}
                    {m.state === "processing" && "The final pass is running."}
                    {m.state === "ready" && m.audio_until && `The audio is deleted ${dateTime(m.audio_until)}.`}
                  </div>
                  {m.state === "failed" && (
                    <button className="small-button" onClick={() => onRetry(m.id)}>
                      Run the final pass again
                    </button>
                  )}
                </div>
              ))}
            </section>
          )}

          {granolaExport && !meetings.some((m) => m.source === "granola") && (
            <section className="side-card granola-card">
              <h2>Moving from Granola?</h2>
              <p className="small muted">Tinta found a Granola export in {granolaExport.replace(/^\/Users\/[^/]+/, "~")}.</p>
              <button className="primary" onClick={onGranola}>
                <Icon name="import" /> Import from Granola
              </button>
            </section>
          )}

          <section className="side-card privacy-card">
            <h2>On this Mac</h2>
            <p className="small">
              <Icon name="lock" size={13} /> Audio, notes, and transcripts are encrypted and never leave this Mac.
            </p>
            <p className="small muted">
              MCP access is {boot?.mcp_enabled ? "on" : "off"}.{" "}
              {boot?.mcp_enabled && "An AI client that you connect sends what it reads to its model provider."}
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}
