import { useEffect, useState } from "react";
import { Access, api, AppCall, Bootstrap, bytes, dateTime, Meeting, on, RETENTION_DAYS, Revision, StorageUsage } from "./api";
import { open, save } from "@tauri-apps/plugin-dialog";
import { setTheme, ThemeChoice } from "./theme";
import { ExtensionSteps, useModelInstall } from "./Onboarding";

type Props = { boot: Bootstrap; calls: AppCall[]; onChanged: () => void; onError: (e: string) => void };

export function Settings({ boot, calls, onChanged, onError }: Props) {
  const [name, setName] = useState(boot.self_name);
  const { progress, install } = useModelInstall(onChanged, onError);

  const [moving, setMoving] = useState(false);
  const [usage, setUsage] = useState<StorageUsage | null>(null);

  useEffect(() => {
    api.storageUsage().then(setUsage).catch((e) => onError(String(e)));
  }, [boot.data_dir, boot.models_installed]);

  async function changeLocation() {
    const parent = await open({ directory: true, multiple: false, title: "Select a folder for the Tinta library" });
    if (typeof parent !== "string") return;
    setMoving(true);
    try {
      await api.moveLibrary(parent);
      onChanged();
    } catch (e) {
      onError(String(e));
    } finally {
      setMoving(false);
    }
  }

  const set = (key: string, value: string) => api.setSetting(key, value).then(onChanged).catch((e) => onError(String(e)));

  async function setCallReading(enabled: boolean) {
    try {
      await api.setSetting("call_reading", String(enabled));
      if (enabled && !(await api.requestAccessibility()).granted) {
        await api.openAccessibilitySettings();
      }
      onChanged();
    } catch (e) {
      onError(String(e));
    }
  }

  async function saveReport(call: AppCall) {
    const path = await save({ title: `Save a report of the ${call.name} window`, defaultPath: `Tinta ${call.name} report.txt` });
    if (!path) return;
    try {
      await api.saveCallReport(call.app, path);
    } catch (e) {
      onError(String(e));
    }
  }

  return (
    <div className="settings">
      <div className="settings-head">
        <h1>Settings</h1>
        <button onClick={() => set("onboarded", "false")}>Run setup again</button>
      </div>

      <section className="panel">
        <h2>Appearance</h2>
        <div className="segmented" role="radiogroup" aria-label="Theme">
          {(["system", "light", "dark"] as ThemeChoice[]).map((t) => (
            <button
              key={t}
              role="radio"
              aria-checked={boot.theme === t}
              className={boot.theme === t ? "active" : ""}
              onClick={() => {
                setTheme(t);
                set("theme", t);
              }}
            >
              {t === "system" ? "System" : t === "light" ? "Light" : "Dark"}
            </button>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>Your name</h2>
        <p className="small muted">The app uses this name for the microphone track.</p>
        <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => set("self_name", name)} />
      </section>

      <section className="panel">
        <h2>Summaries</h2>
        <label>
          <input
            type="checkbox"
            checked={boot.auto_summary}
            disabled={!boot.summaries.available}
            onChange={(e) => set("auto_summary", String(e.target.checked))}
          />{" "}
          Write a summary after each call
        </label>
        <p className="small muted">
          {boot.summaries.available
            ? "The Apple on-device model writes the summary on this Mac from your notes and the transcript. Nothing leaves this Mac. You can also write a summary from each meeting."
            : boot.summaries.reason}
        </p>
      </section>

      <section className="panel">
        <h2>Microphone and echo</h2>
        <p>Microphone access: {boot.microphone}</p>
        {boot.microphone !== "granted" && (
          <button onClick={() => api.requestMicrophone().then(onChanged).catch((e) => onError(String(e)))}>Allow microphone</button>
        )}
        <p className="small">
          Tinta chooses the echo handling from the sound output when a recording starts. With speakers, it removes the echo
          of the call from your microphone, and other audio plays a little quieter. With headphones, it records your
          microphone directly. Headphones give the best transcript.
        </p>
        <p className="small muted">
          The app records the default macOS input device. Change it in System Settings, Sound. macOS asks for permission to record
          the meeting audio at the first recording.
        </p>
      </section>

      <section className="panel">
        <h2>Calls</h2>
        <label>
          <input type="checkbox" checked={boot.auto_stop} onChange={(e) => set("auto_stop", String(e.target.checked))} /> Stop the
          recording when the call ends
        </label>
        <p className="small muted">
          Tinta detects calls in Google Meet with the extension, and in the Zoom and Microsoft Teams apps from their use of the
          microphone. It stops 3 seconds after you leave. A rejoin in this time keeps the recording.
        </p>
        <label>
          <input type="checkbox" checked={boot.call_reading} onChange={(e) => setCallReading(e.target.checked)} /> Get speaker names
          from Zoom and Microsoft Teams <span className="tag">Beta</span>
        </label>
        <p className="small muted">
          Tinta reads the participant names, who speaks, and whether your microphone is muted from the window of the call app.
          It does not keep other text of the window. This needs Accessibility access in macOS.
        </p>
        {boot.call_reading && !boot.accessibility && (
          <div className="row">
            <span className="warn small">macOS does not allow Accessibility access for Tinta.</span>
            <button onClick={() => api.openAccessibilitySettings().catch((e) => onError(String(e)))}>Open Accessibility settings</button>
            <button onClick={onChanged}>Check again</button>
          </div>
        )}
        {boot.call_reading && calls.length > 0 && (
          <>
            <div className="row">
              {calls.map((c) => (
                <button key={c.app} onClick={() => saveReport(c)}>
                  Save a report of the {c.name} window
                </button>
              ))}
            </div>
            <p className="small muted">
              If names are missing or wrong, save a report during the call and send it to the Tinta team. The report can contain
              any text of the window, such as chat messages. Read it before you send it.
            </p>
          </>
        )}
      </section>

      <section className="panel">
        <h2>Google Meet extension</h2>
        <p className="small muted">When you mute your microphone in Meet, Tinta does not record it.</p>
        {boot.extension.connected_at ? (
          <p>The extension is connected. Its ID is {boot.extension_id}.</p>
        ) : (
          <ExtensionSteps onError={onError} />
        )}
        <p className="small muted">
          The extension reads only participant names and who speaks. It does not read captions, chat, or audio.
        </p>
      </section>

      <section className="panel">
        <h2>Storage</h2>
        <p className="path">{boot.data_dir}</p>
        {usage && (
          <dl className="usage">
            <dt>Total</dt>
            <dd>
              <strong>{bytes(usage.total)}</strong>
            </dd>
            <dt>Audio</dt>
            <dd>{bytes(usage.audio)}</dd>
            <dt>Notes and transcripts</dt>
            <dd>{bytes(usage.library)}</dd>
            <dt className="muted">Speech models</dt>
            <dd className="muted">{bytes(usage.models)}, in a separate folder</dd>
          </dl>
        )}
        <label>
          Keep the audio of new meetings for{" "}
          <select
            value={boot.audio_retention_days}
            onChange={(e) => api.setAudioRetentionDays(Number(e.target.value)).then(onChanged).catch((err) => onError(String(err)))}
          >
            {RETENTION_DAYS.map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </select>
        </label>
        <p className="small muted">
          The app deletes the audio this many days after the final pass. The notes and the transcript stay. Existing meetings keep their
          period. To change one meeting, use the Audio section of the meeting.
        </p>
        <div className="row">
          <button onClick={changeLocation} disabled={moving}>
            {moving ? "Moving the library…" : "Change location"}
          </button>
          <button onClick={() => api.showLibrary().catch((e) => onError(String(e)))}>Show in Finder</button>
        </div>
      </section>

      <section className="panel">
        <h2>Speech models</h2>
        {boot.models_installed ? (
          <p>The models are installed and match their pinned hashes when the app loads them.</p>
        ) : (
          <p>
            Install the models once. This is the only time the app downloads files. It downloads about 500 MB from Hugging Face at
            pinned revisions and checks each file against its SHA-256 hash.
          </p>
        )}
        <p className="small muted">Location: {boot.models_path}</p>
        <button className="primary" disabled={!!progress} onClick={() => void install()}>
          {progress ? `${progress}…` : boot.models_installed ? "Install again" : "Install models"}
        </button>
        <p className="small muted">
          Models: Parakeet TDT 0.6B v3 by NVIDIA (CC-BY-4.0), Core ML conversion by FluidInference. Silero VAD (MIT). pyannote
          speaker diarization, Core ML conversion by FluidInference.
        </p>
      </section>
    </div>
  );
}

export function Trash({ onError, onChanged }: { onError: (e: string) => void; onChanged: () => void }) {
  const [items, setItems] = useState<Meeting[]>([]);
  const load = () => api.trash().then(setItems).catch((e) => onError(String(e)));
  useEffect(() => {
    void load();
  }, []);
  return (
    <div className="settings">
      <h1>Trash</h1>
      <p className="muted">Deletions through MCP stay here for 7 days. Deletions that you make in the app are immediate.</p>
      {items.length === 0 && <p className="muted">The trash is empty.</p>}
      {items.map((m) => (
        <div key={m.id} className="panel row">
          <div>
            <strong>{m.title}</strong>
            <div className="small muted">
              {m.deleted_at ? `Meeting deleted ${dateTime(m.deleted_at)}` : `Audio deleted ${dateTime(m.audio_trashed_at)}`}
            </div>
          </div>
          <button onClick={() => api.restore(m.id).then(load).then(onChanged).catch((e) => onError(String(e)))}>Restore</button>
          <button
            className="danger"
            onClick={() => {
              if (!confirm("Delete permanently now?")) return;
              const action = m.deleted_at ? api.deleteMeeting(m.id) : api.deleteAudio(m.id).then(() => api.restore(m.id));
              action.then(load).then(onChanged).catch((e) => onError(String(e)));
            }}
          >
            Delete now
          </button>
        </div>
      ))}
    </div>
  );
}

type McpProps = { boot: Bootstrap | null; onChanged: () => void; onError: (e: string) => void };

/** MCP access, the client configuration, the changes by MCP clients, and the access log. */
export function Mcp({ boot, onChanged, onError }: McpProps) {
  const [data, setData] = useState<{ revisions: Revision[]; access: Access[] }>({ revisions: [], access: [] });
  const load = () => api.mcpActivity().then(setData).catch((e) => onError(String(e)));
  useEffect(() => {
    void load();
    const sub = on("mcp_access", () => void load());
    return () => void sub.then((u) => u());
  }, []);
  return (
    <div className="settings">
      <h1>MCP</h1>
      {boot && (
        <section className="panel">
          <h2>Access</h2>
          <label>
            <input
              type="checkbox"
              checked={boot.mcp_enabled}
              onChange={(e) => api.setSetting("mcp_enabled", String(e.target.checked)).then(onChanged).catch((err) => onError(String(err)))}
            />{" "}
            Allow MCP clients to read and change meetings
          </label>
          <p className="small">
            An AI client that reads meetings through MCP sends that content to its model provider. Only use clients that your
            organization approves. Meeting text can contain instructions from other people. Do not let a client act on them.
          </p>
        </section>
      )}
      {boot && (
        <section className="panel">
          <h2>Connect a client</h2>
          <p className="small muted">Add this server to Claude Desktop or another MCP client:</p>
          <pre className="code">{JSON.stringify(boot.mcp_config, null, 2)}</pre>
          <p className="small muted">Claude Code:</p>
          <pre className="code">claude mcp add tinta "{boot.mcp_path}"</pre>
          <p className="small muted">Tinta must be open while the client uses it.</p>
        </section>
      )}
      <section className="panel">
        <h2>Changes by MCP clients</h2>
        {data.revisions.length === 0 && <p className="muted">No changes.</p>}
        {data.revisions.map((r) => (
          <div key={r.id} className="row small">
            <span>{dateTime(r.ts)}</span>
            <span>
              {r.entity}.{r.field}
            </span>
            <span className="muted ellipsis">{(r.new_value ?? "").slice(0, 80)}</span>
            {r.undone ? (
              <span className="tag">undone</span>
            ) : (
              <button onClick={() => api.undo(r.id).then(load).catch((e) => onError(String(e)))}>Undo</button>
            )}
          </div>
        ))}
      </section>
      <section className="panel">
        <h2>Access log</h2>
        {data.access.length === 0 && <p className="muted">No MCP requests.</p>}
        {data.access.map((a) => (
          <div key={a.id} className="row small">
            <span>{dateTime(a.ts)}</span>
            <span>{a.tool}</span>
            <span className="muted">{a.meeting_ids.length} meetings</span>
            <span className={a.result === "ok" ? "muted" : "warn"}>{a.result}</span>
          </div>
        ))}
      </section>
    </div>
  );
}
