import { CalendarEvent, CalendarState, Meeting, PLATFORM_NAMES } from "./api";

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
