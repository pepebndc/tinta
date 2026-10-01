import { useEffect, useState } from "react";
import { Active, CalendarEvent, CalendarState, ExtensionState, Meeting, PLATFORM_NAMES } from "./api";
import { CloseButton } from "./Brand";
import { pressable } from "./MeetingList";

/** The number of events that the card shows. */
const SHOWN = 8;
/** The time before the start of a meeting when the card offers to join it. */
export const JOIN_BEFORE_MS = 15 * 60_000;
const DAY = 86_400_000;

type Props = {
  calendar: CalendarState;
  meetings: Meeting[];
  now: number;
  /** A new meeting or a recording is starting. */
  busy: boolean;
  onJoin: (eventId: string) => void;
  onNotes: (eventId: string) => void;
  onConnect: () => void;
  onInternetAccounts: () => void;
  /** Hides the offer to connect the calendar. */
  onDismiss: () => void;
};

/** True when the Tinta meeting of the event has a recording. */
export function recorded(event: CalendarEvent, meetings: Meeting[]): boolean {
  return !!event.meeting_id && !!meetings.find((m) => m.id === event.meeting_id)?.started_at;
}

export function timeRange(event: CalendarEvent): string {
  const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${time(event.start)} – ${time(event.end)}`;
}

/** "Now", "In 5 min", or the start time. */
export function startsIn(event: CalendarEvent, now: number): string {
  const minutes = Math.round((event.start - now) / 60_000);
  if (event.start <= now) return "Now";
  if (minutes < 60) return minutes <= 1 ? "In 1 min" : `In ${minutes} min`;
  return new Date(event.start).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function dayLabel(ms: number, now: number): string {
  const days = Math.round((new Date(ms).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / DAY);
  if (days <= 0) return "Today";
  if (days === 1) return "Tomorrow";
  return new Date(ms).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

/** The next meetings from the calendars on this Mac, on Home. */
export function NextMeetings({ calendar, meetings, now, busy, onJoin, onNotes, onConnect, onInternetAccounts, onDismiss }: Props) {
  if (calendar.access !== "granted") {
    return (
      <section className="side-card">
        <h2>Next meetings</h2>
        <p className="small muted">
          {calendar.access === "denied"
            ? "macOS does not allow calendar access for Tinta. Allow it to see your next meetings here."
            : "See your next meetings here, and get a reminder when they start. Tinta reads the calendars on this Mac, with no sign-in."}
        </p>
        <div className="row">
          <button onClick={onConnect}>{calendar.access === "denied" ? "Open Calendar settings" : "Connect calendar"}</button>
          <button className="quiet" onClick={onDismiss}>
            Not now
          </button>
        </div>
      </section>
    );
  }

  if (calendar.calendars.length === 0) {
    return (
      <section className="side-card">
        <h2>Next meetings</h2>
        <p className="small muted">This Mac has no calendars. Add your Google account in System Settings, Internet Accounts, and turn on Calendars.</p>
        <button onClick={onInternetAccounts}>Open Internet Accounts</button>
      </section>
    );
  }

  const colors = new Map(calendar.calendars.map((c) => [c.id, c.color]));
  const shown = calendar.events.slice(0, SHOWN);
  const more = calendar.events.length - shown.length;
  const days: { label: string; events: CalendarEvent[] }[] = [];
  for (const event of shown) {
    const label = dayLabel(event.start, now);
    if (days[days.length - 1]?.label !== label) days.push({ label, events: [] });
    days[days.length - 1].events.push(event);
  }

  return (
    <section className="side-card">
      <h2>Next meetings</h2>
      {shown.length === 0 && <p className="small muted">No meetings in the next 7 days.</p>}
      {days.map((day) => (
        <div key={day.label} className="event-day">
          <div className="eyebrow">{day.label}</div>
          {day.events.map((e) => {
            const joinable = !!e.link && e.start - now <= JOIN_BEFORE_MS && !recorded(e, meetings);
            const invited = e.attendees.length;
            return (
              <div key={e.id} className={`event-row ${e.start <= now ? "now" : ""}`}>
                <span className="event-color" style={{ background: colors.get(e.calendar_id) || "var(--accent)" }} />
                <div className="grow">
                  <button
                    className="quiet event-title"
                    onClick={() => onNotes(e.id)}
                    disabled={busy}
                    title={e.meeting_id ? "Open the notes of this meeting" : "Write notes for this meeting"}
                  >
                    {e.title || "Untitled meeting"}
                  </button>
                  <div className="small muted">
                    {timeRange(e)}
                    {e.link && ` · ${PLATFORM_NAMES[e.link.platform]}`}
                    {invited > 1 && ` · ${invited} people`}
                    {e.meeting_id && " · Notes"}
                  </div>
                </div>
                {joinable && (
                  <button className="primary" onClick={() => onJoin(e.id)} disabled={busy}>
                    Join
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ))}
      {more > 0 && <p className="small muted">{more === 1 ? "1 more meeting" : `${more} more meetings`} in the next 7 days.</p>}
    </section>
  );
}

type NoticeProps = {
  calendar: CalendarState;
  meetings: Meeting[];
  active: Active | null;
  extension: ExtensionState | null;
  /** True when the speech models are installed. */
  ready: boolean;
  /** A new meeting or a recording is starting. */
  busy: boolean;
  /** Opens the meeting of the event. With `join`, Tinta also joins the call and records it. */
  onOpenEvent: (eventId: string, join: boolean) => void;
  /** Records the Meet call that the user is in. */
  onRecord: (eventId: string) => void;
};

/**
 * A notice above the meeting list for a meeting with a call link that starts soon or runs now.
 * A meeting that the user records gets no notice. In the Meet call of the meeting, the notice offers only to record.
 * During the recording of a Meet call, the notice of that call does not show.
 */
export function CallNotice({ calendar, meetings, active, extension, ready, busy, onOpenEvent, onRecord }: NoticeProps) {
  const [now, setNow] = useState(Date.now());
  const [closed, setClosed] = useState<string[]>([]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);

  const event = calendar.events.find(
    (e) =>
      e.link &&
      e.start - now <= JOIN_BEFORE_MS &&
      e.end > now &&
      !closed.includes(e.id) &&
      !recorded(e, meetings) &&
      !(active && active.meeting_id === e.meeting_id),
  );
  if (!event?.link) return null;
  const live = !!extension?.last_seen && now - extension.last_seen < 30_000;
  const inCall = live && !!event.link.code && extension?.meeting_code === event.link.code;
  // The user is in the call and Tinta records it.
  if (inCall && active) return null;
  const action = inCall
    ? { label: "Record", run: () => onRecord(event.id) }
    : active
      ? { label: "Join", run: () => onOpenEvent(event.id, true) }
      : { label: "Join and record", run: () => onOpenEvent(event.id, true) };

  return (
    <div className={`call-notice ${event.start <= now ? "now" : ""}`} role="status">
      <div className="call-notice-head">
        <span className="eyebrow">
          {startsIn(event, now)} · {PLATFORM_NAMES[event.link.platform]}
        </span>
        <CloseButton onClick={() => setClosed([...closed, event.id])} />
      </div>
      <button className="quiet call-notice-title" onClick={() => onOpenEvent(event.id, false)} disabled={busy} title="Open the notes of this meeting">
        {event.title || "Untitled meeting"}
      </button>
      <div className="small muted">{inCall ? "You are in the call." : timeRange(event)}</div>
      <button
        className="primary"
        disabled={!ready || busy}
        onClick={action.run}
        title={ready ? "Tell everyone that you record the call." : "Install the speech models first"}
      >
        {busy ? "Starting…" : action.label}
      </button>
    </div>
  );
}

/** The number of meetings of today that the sidebar shows before the user expands the list. */
const SIDEBAR_TODAY = 3;

type SidebarProps = {
  calendar: CalendarState;
  busy: boolean;
  /** Opens the notes of the event. */
  onOpen: (eventId: string) => void;
  onConnect: () => void;
};

/** The next meetings in the sidebar: at most 3 of today, and all the meetings of the next 7 days when expanded. */
export function SidebarNext({ calendar, busy, onOpen, onConnect }: SidebarProps) {
  const [now, setNow] = useState(Date.now());
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  if (calendar.access !== "granted") {
    return (
      <section className="side-section">
        <div className="side-label-row">
          <span className="side-label">Next meetings</span>
        </div>
        <div className="empty-list">
          {calendar.access === "denied" ? "macOS does not allow calendar access for Tinta." : "See your next meetings here."}{" "}
          <button className="quiet link-button" onClick={onConnect}>
            {calendar.access === "denied" ? "Open Calendar settings" : "Connect calendar"}
          </button>
        </div>
      </section>
    );
  }

  const colors = new Map(calendar.calendars.map((c) => [c.id, c.color]));
  const endOfToday = new Date(now).setHours(24, 0, 0, 0);
  const today = calendar.events.filter((e) => e.start < endOfToday);
  const shown = expanded ? calendar.events : today.slice(0, SIDEBAR_TODAY);
  const hidden = calendar.events.length - shown.length;
  const days: { label: string; events: CalendarEvent[] }[] = [];
  for (const event of shown) {
    const label = dayLabel(event.start, now);
    if (days[days.length - 1]?.label !== label) days.push({ label, events: [] });
    days[days.length - 1].events.push(event);
  }

  return (
    <section className={`side-section next-section ${expanded ? "expanded" : ""}`}>
      <div className="side-label-row">
        <span className="side-label">Next meetings</span>
        {(hidden > 0 || expanded) && (
          <button className="quiet link-button" onClick={() => setExpanded(!expanded)}>
            {expanded ? "Show less" : `${hidden} more`}
          </button>
        )}
      </div>
      <ul className="list next-list">
        {today.length === 0 && !expanded && <li className="empty-list">No more meetings today.</li>}
        {days.map((day) => (
          <li key={day.label}>
            {(expanded || day.label !== "Today") && <div className="eyebrow next-day">{day.label}</div>}
            <ul className="list">
              {day.events.map((e) => (
                <li
                  key={e.id}
                  className={`item next-item ${e.start <= now ? "now" : ""}`}
                  title={e.meeting_id ? "Open the notes of this meeting" : "Write notes for this meeting"}
                  aria-disabled={busy}
                  {...pressable(() => !busy && onOpen(e.id))}
                >
                  <span className="event-color" style={{ background: colors.get(e.calendar_id) || "var(--accent)" }} />
                  <div>
                    <strong>{e.title || "Untitled meeting"}</strong>
                    <span>
                      {e.start - now <= 60 * 60_000 ? startsIn(e, now) : timeRange(e)}
                      {e.link && ` · ${PLATFORM_NAMES[e.link.platform]}`}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}
