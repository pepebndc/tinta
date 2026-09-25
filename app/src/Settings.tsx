import { useEffect, useState } from "react";
import { Access, api, AppCall, Bootstrap, bytes, dateTime, Meeting, on, RETENTION_DAYS, Revision, StorageUsage } from "./api";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import { setTheme, ThemeChoice } from "./theme";
import { ExtensionSteps, useModelInstall } from "./Onboarding";
import { ConfirmButton } from "./Menu";

const GROUPS = [
  ["settings-general", "General"],
  ["settings-recording", "Recording and calls"],
  ["settings-storage", "Storage"],
  ["settings-import", "Import"],
] as const;

type Props = { boot: Bootstrap; calls: AppCall[]; onGranola: () => void; onChanged: () => void; onError: (e: string) => void };

export function Settings({ boot, calls, onGranola, onChanged, onError }: Props) {
  const [name, setName] = useState(boot.self_name);
  const { progress, install } = useModelInstall(onChanged, onError);

  const [moving, setMoving] = useState(false);
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [version, setVersion] = useState<string | null>(null);

  // The version comes from the app bundle. The design preview has no bundle, so it shows the package version.
  useEffect(() => {
    if (import.meta.env.MODE === "mock") setVersion(__APP_VERSION__);
    else getVersion().then(setVersion).catch(() => undefined);
  }, []);

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
        <div className="settings-title">
          <h1>Settings</h1>
          {version && <span className="version">Tinta {version}</span>}
        </div>
        <button onClick={() => set("onboarded", "false")}>Run setup again</button>
      </div>
      <nav className="settings-nav" aria-label="Settings groups">
        {GROUPS.map(([gid, label]) => (
          <button key={gid} className="quiet" onClick={() => document.getElementById(gid)?.scrollIntoView({ behavior: "smooth", block: "start" })}>
            {label}
          </button>
        ))}
      </nav>

      <h2 className="group-title" id="settings-general">General</h2>
      <section className="panel">
        <h3>Appearance</h3>
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
        <h3>Your name</h3>
        <p className="small muted">Tinta uses this name for your microphone in the transcript.</p>
        <input
          value={name}
          aria-label="Your name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          onBlur={() => {
            const next = name.trim();
            if (next && next !== boot.self_name) set("self_name", next);
            else setName(boot.self_name);
          }}
        />
      </section>

      <section className="panel">
        <h3>Summaries</h3>
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
            ? "The Apple on-device model writes the summary from your notes and the transcript. You can also write a summary from each meeting."
            : boot.summaries.reason}
        </p>
      </section>

      <h2 className="group-title" id="settings-recording">Recording and calls</h2>
      <section className="panel">
        <h3>Microphone and echo</h3>
        {boot.microphone === "granted" ? (
          <p>Tinta can use the microphone.</p>
        ) : (
          <div className="row">
            <span>{boot.microphone === "denied" ? "macOS does not allow microphone access for Tinta." : "Tinta does not have microphone access yet."}</span>
            <button onClick={() => api.requestMicrophone().then(onChanged).catch((e) => onError(String(e)))}>Allow microphone</button>
          </div>
        )}
        <p className="small">
          With speakers, Tinta removes the echo of the call from your microphone, and other audio plays a little quieter. With
          headphones, it records your microphone directly. Headphones give the best transcript.
        </p>
        <p className="small muted">
          Tinta records the default input device. Change it in System Settings, Sound. macOS asks for access to the meeting audio
          at the first recording.
        </p>
      </section>

      <section className="panel">
        <h3>Calls</h3>
        <label>
          <input type="checkbox" checked={boot.auto_stop} onChange={(e) => set("auto_stop", String(e.target.checked))} /> Stop the
          recording when the call ends
        </label>
        <p className="small muted">
          Tinta stops 3 seconds after you leave the call. If you join again in this time, the recording continues.
        </p>
        <label>
          <input type="checkbox" checked={boot.call_reading} onChange={(e) => setCallReading(e.target.checked)} /> Get speaker names
          from Zoom and Microsoft Teams <span className="tag">Beta</span>
        </label>
        <p className="small muted">
          Tinta reads the participant names, who speaks, and your mute state from the call window. It does not keep other text.
          This needs Accessibility access.
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
        <h3>Google Meet extension</h3>
        <p className="small muted">When you mute your microphone in Meet, Tinta does not record it.</p>
        {boot.extension.connected_at ? (
          <p>The extension is connected.</p>
        ) : (
          <ExtensionSteps onError={onError} />
        )}
        <p className="small muted">
          The extension reads only participant names and who speaks. It does not read captions, chat, or audio.
        </p>
      </section>

      <h2 className="group-title" id="settings-storage">Storage</h2>
      <section className="panel">
        <h3>Library</h3>
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
                {d === 1 ? "1 day" : `${d} days`}
              </option>
            ))}
          </select>
        </label>
        <p className="small muted">
          Tinta deletes the audio this many days after processing. The notes and the transcript stay. To change one meeting, use
          the Audio section of the meeting.
        </p>
        <div className="row">
          <button onClick={changeLocation} disabled={moving}>
            {moving ? "Moving the library…" : "Change location"}
          </button>
          <button onClick={() => api.showLibrary().catch((e) => onError(String(e)))}>Show in Finder</button>
        </div>
      </section>

      <section className="panel">
        <h3>Speech models</h3>
        {boot.models_installed ? (
          <p>The models are installed. Tinta checks them against their pinned hashes when it loads them.</p>
        ) : (
          <p>
            Install the models once. This is the only download. Tinta downloads about 500 MB from Hugging Face at pinned revisions
            and checks each file against its SHA-256 hash.
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
      <h2 className="group-title" id="settings-import">Import</h2>
      <section className="panel">
        <h3>Granola</h3>
        <p className="small muted">Bring your Granola export into Tinta, with notes, transcripts, and speaker names.</p>
        <button onClick={onGranola}>Import from Granola</button>
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
  const deleteNow = (m: Meeting) => {
    const action = m.deleted_at ? api.deleteMeeting(m.id) : api.deleteAudio(m.id).then(() => api.restore(m.id));
    action
      .then(load)
      .then(onChanged)
      .catch((e) => onError(String(e)));
  };
  return (
    <div className="settings">
      <h1>Trash</h1>
      <p className="muted">
        Deleted meetings stay here for 7 days. Audio that an MCP client deletes also stays here. After 7 days, Tinta deletes
        the items permanently.
      </p>
      {items.length === 0 && <p className="muted">The trash is empty.</p>}
      {items.map((m) => (
        <div key={m.id} className="panel row">
          <div className="grow">
            <strong>{m.title}</strong>
            <div className="small muted">
              {m.deleted_at ? `Meeting deleted ${dateTime(m.deleted_at)}` : `Audio deleted ${dateTime(m.audio_trashed_at)}`}
            </div>
          </div>
          <button onClick={() => api.restore(m.id).then(load).then(onChanged).catch((e) => onError(String(e)))}>Restore</button>
          <ConfirmButton
            label="Delete now"
            question={m.deleted_at ? "Delete the meeting, its audio, notes, and transcript?" : "Delete the audio?"}
            confirm="Delete permanently"
            onConfirm={() => deleteNow(m)}
          />
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
            <span className="muted">{a.meeting_ids.length === 1 ? "1 meeting" : `${a.meeting_ids.length} meetings`}</span>
            <span className={a.result === "ok" ? "muted" : "warn"}>{a.result}</span>
          </div>
        ))}
      </section>
    </div>
  );
}
