import { useEffect, useState } from "react";
import { Access, api, Bootstrap, dateTime, Meeting, on, Revision } from "./api";
import { GranolaImport } from "./GranolaImport";
import { setTheme, ThemeChoice } from "./theme";

export function Settings({ boot, onChanged, onError }: { boot: Bootstrap; onChanged: () => void; onError: (e: string) => void }) {
  const [installing, setInstalling] = useState<string | null>(null);
  const [name, setName] = useState(boot.self_name);

  useEffect(() => {
    const sub = on<{ event: string; component?: string; state?: string }>("engine", (e) => {
      if (e.event === "install_progress") setInstalling(e.state === "done" ? null : `${e.component}: ${e.state}`);
    });
    return () => void sub.then((u) => u());
  }, []);

  async function install() {
    setInstalling("starting");
    try {
      await api.installModels();
      onChanged();
    } catch (e) {
      onError(String(e));
    } finally {
      setInstalling(null);
    }
  }

  const set = (key: string, value: string) => api.setSetting(key, value).then(onChanged).catch((e) => onError(String(e)));
  const config = JSON.stringify(boot.mcp_config, null, 2);

  return (
    <div className="settings">
      <h1>Settings</h1>

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
        <p className="small muted">System follows the macOS appearance.</p>
      </section>

      <section className="panel">
        <h2>Your name</h2>
        <p className="small muted">The app uses this name for the microphone track.</p>
        <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => set("self_name", name)} />
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
        <button className="primary" disabled={!!installing} onClick={install}>
          {installing ? `Installing (${installing})…` : boot.models_installed ? "Install again" : "Install models"}
        </button>
        <p className="small muted">
          Models: Parakeet TDT 0.6B v3 by NVIDIA (CC-BY-4.0), Core ML conversion by FluidInference. Silero VAD (MIT). pyannote
          speaker diarization, Core ML conversion by FluidInference.
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
        <h2>Google Meet extension</h2>
        <ol>
          <li>Open chrome://extensions in Chrome and turn on Developer mode.</li>
          <li>Click Load unpacked and select the extension folder of this project.</li>
          <li>Check that the extension ID is {boot.extension_id}.</li>
          <li>Join a Meet call. The sidebar shows "Meet: in call".</li>
        </ol>
        <p className="small muted">
          The extension reads only participant names and who speaks. It does not read captions, chat, or audio.
        </p>
      </section>

      <section className="panel">
        <h2>MCP</h2>
        <label>
          <input type="checkbox" checked={boot.mcp_enabled} onChange={(e) => set("mcp_enabled", String(e.target.checked))} /> Allow
          MCP clients to read and change meetings
        </label>
        <p className="small">
          An AI client that reads meetings through MCP sends that content to its model provider. Only use clients that your organization
          approves. Meeting text can contain instructions from other people. Do not let a client act on them.
        </p>
        <p className="small muted">Add this server to Claude Desktop or another MCP client:</p>
        <pre className="code">{config}</pre>
        <p className="small muted">Claude Code:</p>
        <pre className="code">claude mcp add tinta "{boot.mcp_path}"</pre>
      </section>

      <GranolaImport onError={onError} onDone={onChanged} />

      <section className="panel">
        <h2>Storage</h2>
        <p>
          The library is encrypted with SQLCipher and the audio with AES-GCM. The key is in your login Keychain. Time Machine does not
          back up the library. Export is the only backup.
        </p>
        <p>FileVault: {boot.filevault ? "on" : "off. Turn it on in System Settings, Privacy and Security."}</p>
        <p className="small muted">Location: {boot.data_dir}</p>
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

export function McpActivity({ onError, boot }: { onError: (e: string) => void; boot: Bootstrap | null }) {
  const [data, setData] = useState<{ revisions: Revision[]; access: Access[] }>({ revisions: [], access: [] });
  const load = () => api.mcpActivity().then(setData).catch((e) => onError(String(e)));
  useEffect(() => {
    void load();
    const sub = on("mcp_access", () => void load());
    return () => void sub.then((u) => u());
  }, []);
  return (
    <div className="settings">
      <h1>MCP activity</h1>
      {boot && !boot.mcp_enabled && <p className="warn">MCP access is off.</p>}
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
