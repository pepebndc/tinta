import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Active, allowMicrophone, api, AppCall, Bootstrap, ExtensionState, Meeting, on, Preview, SearchHit } from "./api";
import { MeetingView } from "./MeetingView";
import { MeetingList, Notice, pressable, tagList } from "./MeetingList";
import { Mcp, Settings, Trash } from "./Settings";
import { CloseButton, CopyButton, Icon, Lockup } from "./Brand";
import { Home } from "./Home";
import { GranolaImport } from "./GranolaImport";
import { Onboarding } from "./Onboarding";
import { setTheme } from "./theme";

type View = { kind: "meeting"; id: string } | { kind: "settings" } | { kind: "trash" } | { kind: "mcp" } | { kind: "granola" } | { kind: "home" };

export function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const [view, setView] = useState<View>(() => {
    const preview = import.meta.env.MODE === "mock" ? window.location.hash.slice(1) : null;
    if (preview === "meeting" || preview === "recording") return { kind: "meeting", id: "m1" };
    if (preview === "settings") return { kind: "settings" };
    if (preview === "mcp") return { kind: "mcp" };
    return { kind: "home" };
  });
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  // The sidebar filter stays the same after a restart.
  const [filter, setFilter] = useState<string>(() => localStorage.getItem("tinta-filter") ?? "all");
  const [loaded, setLoaded] = useState(false);
  const [active, setActive] = useState<Active | null>(null);
  const [extension, setExtension] = useState<ExtensionState | null>(null);
  const [calls, setCalls] = useState<AppCall[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
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
      setCalls(b.calls);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const refreshList = useCallback(async () => {
    try {
      const result = await api.listMeetings();
      setMeetings(result.meetings);
      setFolders(result.folders);
      setPreviews(result.previews);
      setLoaded(true);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refreshBoot();
  }, [refreshBoot]);

  // A change in System Settings shows when the user comes back to Tinta.
  const micAllowed = boot?.microphone === "granted";
  useEffect(() => {
    if (!boot || micAllowed) return;
    const focus = () => void refreshBoot();
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [!!boot, micAllowed, refreshBoot]);

  useEffect(() => {
    void refreshList();
    const subs = [
      on("meeting_changed", () => void refreshList()),
      on<ExtensionState>("extension", setExtension),
      on<AppCall[]>("calls", setCalls),
      on<Active | null>("recording", setActive),
      on<{ id: string; app: string }>("auto_stopped", (p) => {
        setNotice({ text: `The ${p.app} call ended, so Tinta stopped the recording.` });
        void refreshList();
      }),
      on<{ id: string }>("recording_lost", () => {
        setNotice({ text: "The recording stopped because the Tinta engine quit. Tinta keeps the audio up to that time and processes it." });
        void refreshList();
      }),
      on<{ event: string; message?: string }>("engine", (e) => {
        if (e.event === "error" || e.event === "warning") setNotice({ text: String(e.message) });
      }),
    ];
    return () => subs.forEach((p) => p.then((u) => u()));
  }, [refreshList]);

  useEffect(() => {
    if (!query.trim()) {
      setHits(null);
      return;
    }
    let current = true;
    const t = setTimeout(
      () =>
        api
          .search(query)
          .then((h) => current && setHits(h))
          .catch(() => current && setHits([])),
      200,
    );
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [query]);

  function closeSearch() {
    setQuery("");
    setSearchOpen(false);
  }

  useEffect(() => localStorage.setItem("tinta-filter", filter), [filter]);
  const tags = useMemo(() => tagList(meetings), [meetings]);
  const current = useMemo(() => meetings.filter((m) => !m.archived), [meetings]);

  const [creating, setCreating] = useState(false);
  const shortcuts = useRef({ newMeeting: () => {} });
  shortcuts.current.newMeeting = () => void newMeeting();

  // Command-F opens the search. Command-N creates a meeting.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!e.metaKey || e.shiftKey || e.altKey) return;
      const letter = e.key.toLowerCase();
      if (letter === "f") {
        e.preventDefault();
        setSearchOpen(true);
        searchInput.current?.focus();
      } else if (letter === "n") {
        e.preventDefault();
        shortcuts.current.newMeeting();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  async function newMeeting() {
    if (creating) return;
    setCreating(true);
    try {
      const m = await api.createMeeting();
      // A new meeting from an open folder goes into that folder.
      if (filter.startsWith("folder:")) await api.setFolder(m.id, filter.slice(7));
      await refreshList();
      setView({ kind: "meeting", id: m.id });
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
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

  async function recordCall(source: string) {
    if (creating) return;
    setCreating(true);
    let id: string | null = null;
    try {
      id = (await api.createMeeting()).id;
      setActive(await api.startRecording(id, source));
      await refreshList();
      setView({ kind: "meeting", id });
    } catch (e) {
      setError(String(e));
      // The meeting has no recording, so Tinta does not keep it.
      if (id) {
        const failed = id;
        await api
          .trashMeeting(failed)
          .then(() => api.deleteMeeting(failed))
          .catch(() => undefined);
      }
      void refreshList();
    } finally {
      setCreating(false);
    }
  }

  function trashed(id: string, title: string) {
    setView({ kind: "home" });
    void refreshList();
    setNotice({
      text: `Moved "${title}" to the trash.`,
      undo: () =>
        api
          .restore(id)
          .then(() => {
            setNotice(null);
            setView({ kind: "meeting", id });
            return refreshList();
          })
          .catch((e) => setError(String(e))),
    });
  }

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
          {searchOpen ? (
            <label className="search">
              <Icon name="search" size={15} />
              <input
                ref={searchInput}
                autoFocus
                placeholder="Search meetings"
                aria-label="Search meetings"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && closeSearch()}
                onBlur={() => !query.trim() && setSearchOpen(false)}
              />
              <button className="bar-icon" onMouseDown={(e) => e.preventDefault()} onClick={closeSearch} aria-label="Close the search">
                <Icon name="close" size={13} />
              </button>
            </label>
          ) : (
            <>
              <button className="primary" onClick={newMeeting} disabled={creating} title="New meeting (⌘N)">
                <Icon name="plus" /> New meeting
              </button>
              <button className="icon-button" onClick={() => setSearchOpen(true)} title="Search meetings (⌘F)" aria-label="Search meetings">
                <Icon name="search" />
              </button>
            </>
          )}
        </div>
        {hits ? (
          <ul className="list">
            {hits.length === 0 && <li className="empty-list">No meetings found.</li>}
            {hits.map((h, i) => (
              <li key={i} className="item" {...pressable(() => setView({ kind: "meeting", id: h.meeting_id }))}>
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
            <MeetingList
              meetings={meetings}
              loaded={loaded}
              filter={filter}
              selectedId={view.kind === "meeting" ? view.id : null}
              activeId={active?.meeting_id ?? null}
              onFilter={setFilter}
              onOpen={(id) => setView({ kind: "meeting", id })}
              onError={setError}
              onNotice={setNotice}
            />
          </>
        )}
        <nav className="sidebar-nav">
          <ExtensionStatus extension={extension} />
          <button className={`quiet ${view.kind === "mcp" ? "current" : ""}`} onClick={() => setView({ kind: "mcp" })}>
            <Icon name="activity" size={15} /> MCP
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
          <div className="bar error-bar" role="alert">
            <span>{error}</span>
            <CopyButton text={error} label="Copy the error" />
            <CloseButton onClick={() => setError(null)} />
          </div>
        )}
        {notice && (
          <div className="bar info-notice" role="status">
            <span>{notice.text}</span>
            {notice.undo && (
              <button className="quiet" onClick={notice.undo}>
                Undo
              </button>
            )}
            <CloseButton onClick={() => setNotice(null)} />
          </div>
        )}
        {boot && !boot.models_installed && view.kind !== "settings" && view.kind !== "home" && (
          <div className="bar warn-bar">
            <span>Install the speech models before your first meeting.</span>
            <button className="quiet" onClick={() => setView({ kind: "settings" })}>
              Open Settings
            </button>
          </div>
        )}
        {view.kind === "meeting" && (
          <MeetingView
            key={view.id}
            id={view.id}
            boot={boot}
            active={active}
            extension={extension}
            calls={calls}
            folders={folders}
            tags={tags}
            onImport={importRecording}
            onActive={setActive}
            onError={setError}
            onDeleted={trashed}
            onDiscarded={() => void refreshList()}
          />
        )}
        {view.kind === "settings" && boot && (
          <Settings
            boot={boot}
            calls={calls}
            onGranola={() => setView({ kind: "granola" })}
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
        {view.kind === "mcp" && <Mcp boot={boot} onChanged={() => void refreshBoot()} onError={setError} />}
        {view.kind === "home" && boot && (
          <Home
            boot={boot}
            meetings={current}
            previews={previews}
            onFilter={setFilter}
            active={active}
            extension={extension}
            calls={calls}
            onOpen={(id) => setView({ kind: "meeting", id })}
            busy={creating}
            onRecordCall={recordCall}
            onSettings={() => setView({ kind: "settings" })}
            onAllowMicrophone={() =>
              boot &&
              allowMicrophone(boot.microphone)
                .then(refreshBoot)
                .catch((e) => setError(String(e)))
            }
            onRetry={(id) => api.runFinalPass(id, null).then(refreshList).catch((e) => setError(String(e)))}
          />
        )}
      </main>
    </div>
  );
}

/** The Meet extension status. It has its own clock, so that the status changes when the extension stops sending. */
function ExtensionStatus({ extension }: { extension: ExtensionState | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);
  const live = !!extension?.last_seen && now - extension.last_seen < 30_000;
  if (!live) return null;
  return (
    <div className="ext-status on">
      <span className="dot" />
      {extension?.meeting_code ? `Meet: in call, ${extension.participants.length} people` : "Meet extension connected"}
    </div>
  );
}
