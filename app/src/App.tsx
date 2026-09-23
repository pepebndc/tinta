import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Active, api, Bootstrap, dateTime, ExtensionState, Meeting, on, SearchHit } from "./api";
import { MeetingView } from "./MeetingView";
import { McpActivity, Settings, Trash } from "./Settings";
import { Icon, Lockup } from "./Brand";
import { Home } from "./Home";
import { GranolaImport } from "./GranolaImport";
import { Onboarding } from "./Onboarding";
import { setTheme } from "./theme";

type View = { kind: "meeting"; id: string } | { kind: "settings" } | { kind: "trash" } | { kind: "mcp" } | { kind: "granola" } | { kind: "home" };

export function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [view, setView] = useState<View>(() => {
    const preview = import.meta.env.MODE === "mock" ? window.location.hash.slice(1) : null;
    if (preview === "meeting" || preview === "recording") return { kind: "meeting", id: "m1" };
    if (preview === "settings") return { kind: "settings" };
    return { kind: "home" };
  });
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [showArchived, setShowArchived] = useState(false);
  const [active, setActive] = useState<Active | null>(null);
  const [extension, setExtension] = useState<ExtensionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [granolaExport, setGranolaExport] = useState<string | null>(null);

  useEffect(() => {
    api.granolaDefaultPath().then(setGranolaExport).catch(() => undefined);
  }, []);

  const refreshBoot = useCallback(async () => {
    try {
      const b = await api.bootstrap();
      setBoot(b);
      setTheme(b.theme);
      setActive(b.active);
      setExtension(b.extension);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const refreshList = useCallback(async () => {
    const result = await api.listMeetings(showArchived);
    setMeetings(result.meetings);
    setFolders(result.folders);
  }, [showArchived]);

  useEffect(() => {
    void refreshBoot();
  }, [refreshBoot]);

  useEffect(() => {
    void refreshList();
    const subs = [
      on("meeting_changed", () => void refreshList()),
      on<ExtensionState>("extension", setExtension),
      on<Active>("recording", setActive),
    ];
    return () => subs.forEach((p) => p.then((u) => u()));
  }, [refreshList]);

  useEffect(() => {
    if (!query.trim()) {
      setHits(null);
      return;
    }
    const t = setTimeout(() => api.search(query).then(setHits).catch(() => setHits([])), 200);
    return () => clearTimeout(t);
  }, [query]);

  const tags = useMemo(() => Array.from(new Set(meetings.flatMap((m) => m.tags))).sort(), [meetings]);
  const visible = meetings.filter((m) => {
    if (filter === "all") return true;
    if (filter.startsWith("folder:")) return m.folder === filter.slice(7);
    if (filter.startsWith("tag:")) return m.tags.includes(filter.slice(4));
    return true;
  });

  async function newMeeting() {
    try {
      const m = await api.createMeeting();
      await refreshList();
      setView({ kind: "meeting", id: m.id });
    } catch (e) {
      setError(String(e));
    }
  }

  async function importRecording() {
    const path = await open({ multiple: false, filters: [{ name: "Audio", extensions: ["wav", "m4a", "mp3", "aiff", "caf"] }] });
    if (typeof path !== "string") return;
    try {
      const m = await api.importRecording(path);
      await refreshList();
      setView({ kind: "meeting", id: m.id });
    } catch (e) {
      setError(String(e));
    }
  }

  async function recordCall() {
    try {
      const m = await api.createMeeting();
      const started = await api.startRecording(m.id, boot?.last_source ?? "com.google.Chrome");
      setActive(started);
      await refreshList();
      setView({ kind: "meeting", id: m.id });
    } catch (e) {
      setError(String(e));
      void refreshList();
    }
  }

  const extensionLive = extension?.last_seen && Date.now() - extension.last_seen < 30_000;

  if (boot && !boot.onboarded) {
    return (
      <Onboarding
        boot={boot}
        extension={extension}
        granolaExport={granolaExport}
        error={error}
        onChanged={() => void refreshBoot()}
        onError={setError}
        onFinish={(next) => {
          setBoot({ ...boot, onboarded: true });
          setView({ kind: next });
        }}
      />
    );
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <button className="sidebar-brand" onClick={() => setView({ kind: "home" })} aria-label="Home">
          <Lockup />
        </button>
        <button className={`quiet home-link ${view.kind === "home" ? "current" : ""}`} onClick={() => setView({ kind: "home" })}>
          <Icon name="home" size={15} /> Home
        </button>
        <div className="sidebar-actions">
          <button className="primary" onClick={newMeeting}>
            <Icon name="plus" /> New meeting
          </button>
          <button className="icon-button" onClick={importRecording} title="Import a recording">
            <Icon name="import" />
          </button>
        </div>
        <label className="search">
          <Icon name="search" size={15} />
          <input placeholder="Find a conversation" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        {hits ? (
          <ul className="list">
            {hits.length === 0 && <li className="empty-list">No meetings found.</li>}
            {hits.map((h, i) => (
              <li key={i} className="item" onClick={() => setView({ kind: "meeting", id: h.meeting_id })}>
                <Icon name="document" />
                <div>
                  <strong>{h.title}</strong>
                  <span className="snippet">{h.snippet}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <>
            <div className="side-label-row">
              <span className="side-label">YOUR MEETINGS</span>
              <select className="filter" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter meetings">
                <option value="all">All</option>
                {folders.map((f) => <option key={f} value={`folder:${f}`}>Folder: {f}</option>)}
                {tags.map((t) => <option key={t} value={`tag:${t}`}>Tag: {t}</option>)}
              </select>
            </div>
            <ul className="list">
              {visible.length === 0 && <li className="empty-list">No meetings yet.</li>}
              {visible.map((m) => (
                <li
                  key={m.id}
                  className={`item ${view.kind === "meeting" && view.id === m.id ? "selected" : ""}`}
                  onClick={() => setView({ kind: "meeting", id: m.id })}
                >
                  {active?.meeting_id === m.id ? <span className="rec-dot" /> : <Icon name="document" />}
                  <div>
                    <strong>{m.title}</strong>
                    <span>
                      {dateTime(m.started_at ?? m.created_at)}
                      {m.state !== "ready" && m.state !== "draft" && <em className={`state state-${m.state}`}> · {m.state}</em>}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
            <label className="archived-toggle">
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived
            </label>
          </>
        )}
        <nav className="sidebar-nav">
          <div className={`ext-status ${extensionLive ? "on" : ""}`}>
            <span className="dot" />
            {extensionLive ? (extension?.meeting_code ? `Meet: in call, ${extension.participants.length} people` : "Meet extension connected") : "Meet extension not connected"}
          </div>
          <button className={`quiet ${view.kind === "mcp" ? "current" : ""}`} onClick={() => setView({ kind: "mcp" })}>
            <Icon name="activity" size={15} /> MCP activity
          </button>
          <button className={`quiet ${view.kind === "trash" ? "current" : ""}`} onClick={() => setView({ kind: "trash" })}>
            <Icon name="trash" size={15} /> Trash
          </button>
          <button className={`quiet ${view.kind === "settings" ? "current" : ""}`} onClick={() => setView({ kind: "settings" })}>
            <Icon name="settings" size={15} /> Settings
          </button>
        </nav>
        <footer className="sidebar-footer" aria-label="Storage">
          <Icon name="lock" size={11} /> Encrypted and stored on this Mac
        </footer>
      </aside>
      <main className="main">
        {error && (
          <div className="bar error-bar" onClick={() => setError(null)} role="alert">
            {error} <span className="muted">Click to close.</span>
          </div>
        )}
        {boot && !boot.models_installed && view.kind !== "settings" && (
          <div className="bar warn-bar">
            Install the speech models before your first meeting. <button className="link" onClick={() => setView({ kind: "settings" })}>Open settings</button>
          </div>
        )}
        {boot && !boot.filevault && (
          <div className="bar warn-bar">FileVault is off. Turn on FileVault in System Settings to protect this Mac when it is off or locked.</div>
        )}
        {view.kind === "meeting" && (
          <MeetingView
            key={view.id}
            id={view.id}
            boot={boot}
            active={active}
            extension={extension}
            onActive={setActive}
            onError={setError}
            onDeleted={() => {
              setView({ kind: "home" });
              void refreshList();
            }}
          />
        )}
        {view.kind === "settings" && boot && (
          <Settings
            boot={boot}
            onChanged={() => {
              void refreshBoot();
              void refreshList();
            }}
            onError={setError}
          />
        )}
        {view.kind === "trash" && <Trash onError={setError} onChanged={refreshList} />}
        {view.kind === "granola" && (
          <div className="settings">
            <h1>Import from Granola</h1>
            <GranolaImport onError={setError} onDone={refreshList} />
          </div>
        )}
        {view.kind === "mcp" && <McpActivity onError={setError} boot={boot} />}
        {view.kind === "home" && boot && (
          <Home
            boot={boot}
            meetings={meetings}
            active={active}
            extension={extension}
            onOpen={(id) => setView({ kind: "meeting", id })}
            onNew={newMeeting}
            onImport={importRecording}
            onRecordCall={recordCall}
            onSettings={() => setView({ kind: "settings" })}
            onRetry={(id) => api.runFinalPass(id, null).then(refreshList).catch((e) => setError(String(e)))}
            granolaExport={granolaExport}
            onGranola={() => setView({ kind: "granola" })}
          />
        )}
      </main>
    </div>
  );
}
