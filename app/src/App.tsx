import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Active, allowCalendar, allowMicrophone, api, AppCall, Bootstrap, CalendarState, ExtensionState, Meeting, on, Preview, SearchHit } from "./api";
import { MeetingView } from "./MeetingView";
import { MeetingList, Notice, pressable, tagList } from "./MeetingList";
import { Mcp, Settings, Trash } from "./Settings";
import { CloseButton, CopyButton, Icon, Lockup } from "./Brand";
import { Home } from "./Home";
import { CallNotice, SidebarNext } from "./NextMeetings";
import { resizeWindow } from "./windowFrame";
import { GranolaImport } from "./GranolaImport";
import { Onboarding } from "./Onboarding";
import { setTheme } from "./theme";

/** Below this window width, the window shows only the sidebar. */
const COMPACT_WIDTH = 640;
/** The expand band gives the window this ratio of width to height. */
const WINDOW_RATIO = 1280 / 820;

type View =
  | { kind: "meeting"; id: string; fresh?: boolean }
  | { kind: "settings"; section?: string }
  | { kind: "trash" }
  | { kind: "mcp" }
  | { kind: "granola" }
  | { kind: "home" };

// The extension and the call apps send their state many times each second. The sidebar renders again only for a change that it shows.
const List = memo(MeetingList);
const Next = memo(SidebarNext);
const CallBanner = memo(CallNotice);

const sameNames = (a: { name: string; is_self: boolean }[], b: { name: string; is_self: boolean }[]) =>
  a.length === b.length && a.every((p, i) => p.name === b[i].name && p.is_self === b[i].is_self);

/** The age of `last_seen` shows whether the extension is connected, so a step of 10 seconds is exact enough. */
const SEEN_STEP_MS = 10_000;

function sameExtension(a: ExtensionState | null, b: ExtensionState): boolean {
  return (
    !!a &&
    a.meeting_code === b.meeting_code &&
    a.title === b.title &&
    a.connected_at === b.connected_at &&
    a.mic_muted === b.mic_muted &&
    Math.floor((a.last_seen ?? 0) / SEEN_STEP_MS) === Math.floor((b.last_seen ?? 0) / SEEN_STEP_MS) &&
    sameNames(a.participants, b.participants)
  );
}

function sameCalls(a: AppCall[], b: AppCall[]): boolean {
  return (
    a.length === b.length &&
    a.every((c, i) => c.app === b[i].app && c.name === b[i].name && c.since === b[i].since && c.mic_muted === b[i].mic_muted && sameNames(c.participants, b[i].participants))
  );
}

/** A search result text. The search puts "[" and "]" around each word that matches. */
function Snippet({ text, query }: { text: string; query: string }) {
  const plain = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const terms = plain(query).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return (
    <span className="snippet">
      {text.split(/(\[[^\[\]]+\])/).map((part, i) => {
        // The text can have its own brackets, such as a timestamp. Only a word that starts with a search term is a match.
        const word = part.startsWith("[") && part.endsWith("]") ? part.slice(1, -1) : null;
        return word !== null && terms.some((t) => plain(word).startsWith(t)) ? <mark key={i}>{word}</mark> : <Fragment key={i}>{part}</Fragment>;
      })}
    </span>
  );
}

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
  const [searchError, setSearchError] = useState<string | null>(null);
  // The sidebar filter stays the same after a restart.
  const [filter, setFilter] = useState<string>(() => localStorage.getItem("tinta-filter") ?? "all");
  const [loaded, setLoaded] = useState(false);
  const [active, setActive] = useState<Active | null>(null);
  const [extension, setExtension] = useState<ExtensionState | null>(null);
  const [calls, setCalls] = useState<AppCall[]>([]);
  const [calendar, setCalendar] = useState<CalendarState>({ access: "", calendars: [], events: [] });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [granolaExport, setGranolaExport] = useState<string | null>(null);
  /** The calendar events whose notice the user closed. */
  const [closedNotices, setClosedNotices] = useState<string[]>([]);
  const [compact, setCompact] = useState(() => window.innerWidth < COMPACT_WIDTH);

  useEffect(() => {
    const resize = () => setCompact(window.innerWidth < COMPACT_WIDTH);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  /** Gives a compact window its full size again. */
  const expand = useCallback(() => {
    if (window.innerWidth >= COMPACT_WIDTH) return;
    const height = Math.max(window.innerHeight, 600);
    void resizeWindow(Math.round(height * WINDOW_RATIO), height, false).catch((e) => setError(String(e)));
  }, []);

  /** Shows a view. A compact window gets its full size, so the view is visible. */
  const show = useCallback(
    (next: View) => {
      setView(next);
      expand();
    },
    [expand],
  );

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
      setCalendar(b.calendar);
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

  // The calendars change in other apps and in System Settings, so Tinta reads them again when the window gets the focus.
  useEffect(() => {
    const focus = () => void api.refreshCalendar().then(setCalendar).catch(() => undefined);
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, []);

  useEffect(() => {
    void refreshList();
    const subs = [
      on<CalendarState>("calendar", setCalendar),
      on<{ id: string }>("open_meeting", (p) => {
        void refreshList();
        show({ kind: "meeting", id: p.id });
      }),
      on("meeting_changed", () => void refreshList()),
      on<ExtensionState>("extension", (next) => setExtension((before) => (sameExtension(before, next) ? before : next))),
      on<AppCall[]>("calls", (next) => setCalls((before) => (sameCalls(before, next) ? before : next))),
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
        if (e.event === "error") setError(String(e.message));
        if (e.event === "warning") setNotice({ text: String(e.message) });
      }),
    ];
    return () => subs.forEach((p) => p.then((u) => u()));
  }, [refreshList, show]);

  useEffect(() => {
    setSearchError(null);
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
          .catch((e) => {
            if (!current) return;
            setHits([]);
            setSearchError(String(e));
          }),
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
  const [importing, setImporting] = useState(false);
  // The handlers of the sidebar and of the shortcuts stay the same functions, and they call the newest code.
  const latest = useRef({ newMeeting, openEvent, recordCall, connectCalendar, ready: false });
  latest.current = { newMeeting, openEvent, recordCall, connectCalendar, ready: !!boot?.onboarded };
  const openMeeting = useCallback((id: string) => show({ kind: "meeting", id }), [show]);
  const openEventNotes = useCallback((id: string) => void latest.current.openEvent(id, false), []);
  const openEventFrom = useCallback((id: string, join: boolean) => void latest.current.openEvent(id, join), []);
  const recordEvent = useCallback((id: string) => void latest.current.recordCall("com.google.Chrome", id), []);
  const connect = useCallback(() => latest.current.connectCalendar(), []);
  const closeNotice = useCallback((id: string) => setClosedNotices((closed) => [...closed, id]), []);

  // Command-F opens the search. Command-N creates a meeting. Command-comma opens Settings.
  // Control-Command-F is the full screen shortcut of macOS. The shortcuts do not work during setup.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!e.metaKey || e.shiftKey || e.altKey || e.ctrlKey || !latest.current.ready) return;
      const letter = e.key.toLowerCase();
      if (letter === "f") {
        e.preventDefault();
        setSearchOpen(true);
        searchInput.current?.focus();
      } else if (letter === "n") {
        e.preventDefault();
        void latest.current.newMeeting();
      } else if (letter === ",") {
        e.preventDefault();
        show({ kind: "settings" });
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [show]);

  async function newMeeting() {
    if (creating) return;
    setCreating(true);
    try {
      const m = await api.createMeeting();
      // A new meeting from an open folder goes into that folder.
      if (filter.startsWith("folder:")) await api.setFolder(m.id, filter.slice(7));
      await refreshList();
      show({ kind: "meeting", id: m.id, fresh: true });
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  }

  async function importRecording() {
    if (importing) return;
    setImporting(true);
    try {
      const path = await open({ multiple: false, filters: [{ name: "Audio", extensions: ["wav", "m4a", "mp3", "aiff", "caf"] }] });
      if (typeof path !== "string") return;
      const m = await api.importRecording(path);
      await refreshList();
      show({ kind: "meeting", id: m.id });
    } catch (e) {
      setError(String(e));
    } finally {
      setImporting(false);
    }
  }

  /** Records a detected call. A call of a calendar event records into the meeting of the event. */
  async function recordCall(source: string, eventId?: string) {
    if (creating) return;
    setCreating(true);
    let id: string | null = null;
    try {
      id = eventId ? await api.openEvent(eventId, false) : (await api.createMeeting()).id;
      setActive(await api.startRecording(id, source));
      await refreshList();
      setView({ kind: "meeting", id });
    } catch (e) {
      setError(String(e));
      // The meeting has no recording, so Tinta does not keep it. The meeting of a calendar event can have notes, so it stays.
      if (id && !eventId) {
        await api.discardDraft(id).catch(() => undefined);
      }
      void refreshList();
    } finally {
      setCreating(false);
    }
  }

  async function openEvent(eventId: string, join: boolean) {
    if (creating) return;
    setCreating(true);
    // Tinta creates the meeting of an event when the user opens its notes for the first time.
    const fresh = !join && !calendar.events.find((e) => e.id === eventId)?.meeting_id;
    try {
      const id = await api.openEvent(eventId, join);
      await refreshList();
      // A join opens the call. A compact window stays small next to the call.
      if (join) setView({ kind: "meeting", id });
      else show({ kind: "meeting", id, fresh });
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  }

  function connectCalendar() {
    allowCalendar(calendar.access)
      .then((c) => c && setCalendar(c))
      .catch((e) => setError(String(e)));
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

  // The errors and the notices. A compact window shows them above the sidebar, because the main area is hidden.
  const modelsMissing = boot && !boot.models_installed && view.kind !== "settings" && view.kind !== "home";
  const bars = (error || notice || modelsMissing) && (
    <div className="bars">
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
      {modelsMissing && (
        <div className="bar warn-bar">
          <span>Install the speech models before your first meeting.</span>
          <button className="quiet" onClick={() => show({ kind: "settings", section: "models" })}>
            Open Settings
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div className={`app ${compact ? "compact" : ""}`}>
      <aside className="sidebar">
        {compact && bars}
        <button className="sidebar-brand" onClick={() => show({ kind: "home" })} aria-label="Home" title="Home">
          <Lockup />
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
            {searchError ? (
              <li className="empty-list warn" role="alert">
                The search failed: {searchError}
              </li>
            ) : (
              hits.length === 0 && <li className="empty-list">No meetings found.</li>
            )}
            {hits.map((h, i) => (
              <li key={i} className="item" {...pressable(() => show({ kind: "meeting", id: h.meeting_id }))}>
                <Icon name="document" />
                <div>
                  <strong>{h.title}</strong>
                  <Snippet text={h.snippet} query={query} />
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <>
            <CallBanner
              calendar={calendar}
              meetings={meetings}
              active={active}
              extension={extension}
              ready={boot?.models_installed ?? false}
              busy={creating}
              closed={closedNotices}
              onClose={closeNotice}
              onOpenEvent={openEventFrom}
              onRecord={recordEvent}
            />
            <Next calendar={calendar} busy={creating} onOpen={openEventNotes} onConnect={connect} />
            <List
              meetings={meetings}
              loaded={loaded}
              filter={filter}
              selectedId={view.kind === "meeting" ? view.id : null}
              activeId={active?.meeting_id ?? null}
              onFilter={setFilter}
              onOpen={openMeeting}
              onError={setError}
              onNotice={setNotice}
            />
          </>
        )}
        <nav className="sidebar-nav">
          <ExtensionStatus extension={extension} />
          <button className={`quiet ${view.kind === "mcp" ? "current" : ""}`} onClick={() => show({ kind: "mcp" })}>
            <Icon name="activity" size={15} /> MCP
          </button>
          <button className={`quiet ${view.kind === "trash" ? "current" : ""}`} onClick={() => show({ kind: "trash" })}>
            <Icon name="trash" size={15} /> Trash
          </button>
          <button className={`quiet ${view.kind === "settings" ? "current" : ""}`} onClick={() => show({ kind: "settings" })}>
            <Icon name="settings" size={15} /> Settings
          </button>
        </nav>
        <footer className="sidebar-footer" aria-label="Storage">
          <Icon name="lock" size={11} /> Encrypted and stored on this Mac
        </footer>
      </aside>
      {compact && (
        <button className="expand-band" onClick={expand} aria-label="Expand the window" title="Expand the window">
          <Icon name="chevron" size={14} />
        </button>
      )}
      <main className="main">
        {!compact && bars}
        <div className="page">
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
            fresh={view.fresh ?? false}
            importing={importing}
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
            section={view.section}
            calls={calls}
            calendar={calendar}
            onConnectCalendar={connectCalendar}
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
        {view.kind === "mcp" && <Mcp boot={boot} meetings={meetings} onOpen={openMeeting} onChanged={() => void refreshBoot()} onUndone={() => void refreshList()} onError={setError} />}
        {view.kind === "home" && boot && (
          <Home
            boot={boot}
            meetings={current}
            previews={previews}
            onFilter={setFilter}
            active={active}
            extension={extension}
            calls={calls}
            calendar={calendar}
            onOpen={(id) => setView({ kind: "meeting", id })}
            busy={creating}
            onRecordCall={recordCall}
            onOpenEvent={openEvent}
            onConnectCalendar={connectCalendar}
            onInternetAccounts={() => api.openPrivacySettings("internet_accounts").catch((e) => setError(String(e)))}
            onSettings={(section) => setView({ kind: "settings", section })}
            onAllowMicrophone={() =>
              boot &&
              allowMicrophone(boot.microphone)
                .then(refreshBoot)
                .catch((e) => setError(String(e)))
            }
            onRetry={(id) => api.runFinalPass(id, null).then(refreshList).catch((e) => setError(String(e)))}
          />
        )}
        </div>
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
