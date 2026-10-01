import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { resizeWindow } from "./windowFrame";
import { Active, api, AppCall, clock, EngineEvent, ExtensionState, MeetingDetail, on, Turn } from "./api";
import { Icon } from "./Brand";

const MOCK = import.meta.env.MODE === "mock";
/** The window sizes, with the transparent margin for the shadow. The Rust side creates the window with the closed size. */
const CLOSED = { width: 236, height: 64 };
const OPEN = { width: 340, height: 480 };
/** The number of bars in a wave. */
const BARS = 7;
/** A move of this many pixels after the mouse press starts a drag, not a click. */
const DRAG_PX = 3;
/** The open bubble shows this many of the last turns. */
const TURNS = 40;

/** The place of the meeting audio, such as "Google Meet" or "Zoom". */
function audioPlace(active: Active, calls: AppCall[]): string {
  if (active.app_call) return calls.find((c) => c.app === active.app_call)?.name ?? "the call app";
  if (active.meeting_code) return "Google Meet";
  if (active.source === "all") return "System audio";
  return "the app";
}

function speaker(detail: MeetingDetail | null, turn: Turn): string {
  if (turn.speaker_id && detail?.names[turn.speaker_id]) return detail.names[turn.speaker_id];
  if (turn.live_name) return turn.live_name;
  return turn.track === "mic" ? "You" : "Speaker";
}

/** A small wave from the last audio levels. */
function Wave({ levels, off }: { levels: number[]; off: boolean }) {
  return (
    <span className={`wave ${off ? "off" : ""}`} aria-hidden="true">
      {levels.map((l, i) => (
        <span key={i} style={{ transform: `scaleY(${off ? 0.12 : Math.max(0.12, Math.min(1, Math.sqrt(l) * 2.2))})` }} />
      ))}
    </span>
  );
}

/** The bubble window during a recording. A click opens the live transcript. A drag moves the bubble. */
export function Bubble() {
  const [active, setActive] = useState<Active | null>(null);
  const [calls, setCalls] = useState<AppCall[]>([]);
  const [extension, setExtension] = useState<ExtensionState | null>(null);
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [mic, setMic] = useState<number[]>(() => Array(BARS).fill(0));
  const [remote, setRemote] = useState<number[]>(() => Array(BARS).fill(0));
  const [capturing, setCapturing] = useState(false);
  const [open, setOpen] = useState(() => MOCK && window.location.hash === "#bubble-open");
  const [now, setNow] = useState(Date.now());
  const press = useRef<{ x: number; y: number; dragged: boolean } | null>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.classList.add("bubble-root");
    api
      .bootstrap()
      .then((b) => {
        setActive(b.active);
        setCalls(b.calls);
        setExtension(b.extension);
      })
      .catch(() => undefined);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const push = (values: number[], value: number) => [...values.slice(1), value];
    const subs = [
      on<Active | null>("recording", setActive),
      on<AppCall[]>("calls", setCalls),
      on<ExtensionState>("extension", setExtension),
      on<Turn>("live_turn", (t) => setDetail((d) => (d && d.meeting.id === t.meeting_id ? { ...d, turns: [...d.turns, t] } : d))),
      on<EngineEvent>("engine", (e) => {
        if (e.event !== "levels") return;
        setMic((m) => push(m, Number(e.mic)));
        setRemote((r) => push(r, Number(e.remote)));
        setCapturing(Boolean(e.remote_capturing));
      }),
    ];
    return () => {
      clearInterval(tick);
      subs.forEach((p) => p.then((u) => u()));
    };
  }, []);

  // The meeting of the recording gives the title, the speaker names, and the transcript so far.
  const meetingId = active?.meeting_id;
  useEffect(() => {
    if (!meetingId) return setDetail(null);
    api.getMeeting(meetingId).then(setDetail).catch(() => undefined);
    const sub = on<{ id: string }>("meeting_changed", (p) => {
      if (p.id === meetingId) api.getMeeting(meetingId).then(setDetail).catch(() => undefined);
    });
    return () => void sub.then((u) => u());
  }, [meetingId]);

  useEffect(() => {
    if (open) list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [open, detail?.turns.length]);

  function toggle(next: boolean) {
    setOpen(next);
    const size = next ? OPEN : CLOSED;
    void resizeWindow(size.width, size.height, true).catch(() => undefined);
  }

  // A press and a move starts a drag of the window. A press without a move is a click.
  const dragProps = (onClick?: () => void) => ({
    onMouseDown: (e: React.MouseEvent) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
      press.current = { x: e.screenX, y: e.screenY, dragged: false };
    },
    onMouseMove: (e: React.MouseEvent) => {
      const p = press.current;
      if (!p || p.dragged || Math.hypot(e.screenX - p.x, e.screenY - p.y) < DRAG_PX) return;
      p.dragged = true;
      if (!MOCK) void getCurrentWindow().startDragging().catch(() => undefined);
    },
    onMouseUp: () => {
      const p = press.current;
      press.current = null;
      if (p && !p.dragged) onClick?.();
    },
  });

  if (!active) return null;
  const muted = active.mic_muted;
  const place = audioPlace(active, calls);
  const elapsed = clock((now - active.start_wall_ms) / 1000);
  const state = active.paused ? "Paused" : "Recording";
  const title = detail?.meeting.title ?? extension?.title ?? "Meeting";
  const muteButton = (
    <button
      className={`bubble-icon ${muted ? "muted" : ""}`}
      onClick={() => api.setMicMuted(!muted).catch(() => undefined)}
      aria-pressed={muted}
      aria-label={muted ? "Unmute the microphone" : "Mute the microphone"}
      title={muted ? "Record the microphone again" : "Do not record the microphone"}
    >
      <Icon name={muted ? "mic-off" : "mic"} size={14} />
    </button>
  );

  if (!open) {
    return (
      <div className="bubble closed" {...dragProps(() => toggle(true))} title="Click to see the transcript. Drag to move.">
        <span className={`rec-dot ${active.paused ? "paused" : ""}`} />
        <div className="bubble-time">
          <strong>{elapsed}</strong>
          <span>{state}</span>
        </div>
        <div className="bubble-source" title={muted ? "Your microphone is muted" : "Your microphone"}>
          <Icon name={muted ? "mic-off" : "mic"} size={12} />
          <Wave levels={mic} off={muted || active.paused} />
        </div>
        <div className="bubble-source" title={capturing ? `Meeting audio from ${place}` : `No sound from ${place} yet`}>
          <Icon name="users" size={12} />
          <Wave levels={remote} off={!capturing || active.paused} />
        </div>
      </div>
    );
  }

  const turns = detail?.turns.slice(-TURNS) ?? [];
  return (
    <div className="bubble open">
      <div className="bubble-head" {...dragProps()}>
        <span className={`rec-dot ${active.paused ? "paused" : ""}`} />
        <div className="grow">
          <strong className="bubble-title">{title}</strong>
          <span className="small muted">
            {state} · {elapsed}
          </span>
        </div>
        {muteButton}
        <button className="bubble-icon" onClick={() => api.showMeeting(active.meeting_id).catch(() => undefined)} aria-label="Open in Tinta" title="Open in Tinta">
          <Icon name="document" size={14} />
        </button>
        <button className="bubble-icon" onClick={() => toggle(false)} aria-label="Close the transcript" title="Close the transcript">
          <Icon name="chevron" size={14} />
        </button>
      </div>
      <div className="bubble-levels">
        <div className="bubble-level">
          <Icon name={muted ? "mic-off" : "mic"} size={13} />
          <span className="grow">{muted ? (active.mic_muted_by_user ? "Your microphone, muted" : `Your microphone, muted in ${place}`) : "Your microphone"}</span>
          <Wave levels={mic} off={muted || active.paused} />
        </div>
        <div className="bubble-level">
          <Icon name="users" size={13} />
          <span className="grow">{capturing ? `Meeting audio, ${place}` : `Meeting audio, no sound from ${place} yet`}</span>
          <Wave levels={remote} off={!capturing || active.paused} />
        </div>
      </div>
      <div className="bubble-transcript" ref={list}>
        {turns.length === 0 && <p className="small muted">Tinta writes the transcript here when someone speaks.</p>}
        {turns.map((t) => (
          <p key={t.id}>
            <strong>{speaker(detail, t)}</strong> {t.text}
          </p>
        ))}
      </div>
    </div>
  );
}
