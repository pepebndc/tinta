import AppKit
import EventKit
import Foundation

/// Reads the events of the calendars on this Mac with EventKit. The accounts in System Settings,
/// Internet Accounts, such as a Google account, sync their calendars to this Mac, so Tinta needs no sign-in.
/// The reader sends a `calendar_changed` event when the calendar store changes.
final class CalendarReader: @unchecked Sendable {
    /// The time without a new change before the reader sends `calendar_changed`. A sync changes many events at a time.
    private static let changeDelay = 1.0
    /// The maximum number of events in one read.
    private static let maxEvents = 500
    /// The maximum length of the event notes. The app looks for the call link in the notes.
    private static let maxNotes = 20_000

    private let lock = NSLock()
    private var store = EKEventStore()
    private let queue = DispatchQueue(label: "tinta.calendar")
    private var observer: NSObjectProtocol?
    private var pending: DispatchWorkItem?

    /// "granted", "denied", or "undetermined". Write-only access counts as denied, because Tinta must read the events.
    static var access: String {
        switch EKEventStore.authorizationStatus(for: .event) {
        case .fullAccess: return "granted"
        case .notDetermined: return "undetermined"
        default: return "denied"
        }
    }

    func start() {
        // The store changes after access is granted, so the observer accepts the changes of all stores.
        observer = NotificationCenter.default.addObserver(forName: .EKEventStoreChanged, object: nil, queue: nil) {
            [weak self] _ in self?.changed()
        }
    }

    private func changed() {
        queue.async { [self] in
            pending?.cancel()
            let work = DispatchWorkItem { Output.shared.event("calendar_changed") }
            pending = work
            queue.asyncAfter(deadline: .now() + Self.changeDelay, execute: work)
        }
    }

    private func currentStore() -> EKEventStore {
        lock.withLock { store }
    }

    /// Asks macOS for full access to the calendars. macOS shows its prompt only one time.
    func request() async throws -> Bool {
        let granted = try await currentStore().requestFullAccessToEvents()
        // A store from before the access does not read the events, so the reader uses a new store.
        if granted { lock.withLock { store = EKEventStore() } }
        return granted
    }

    /// The calendars and the timed events from now until `days` days from now, with the events in progress.
    /// Canceled events and events that the user declined are not in the result.
    func read(days: Int) -> [String: Any] {
        let access = Self.access
        guard access == "granted" else { return ["access": access, "calendars": [], "events": []] }
        let store = currentStore()
        store.refreshSourcesIfNecessary()
        let calendars = store.calendars(for: .event).filter { $0.type != .birthday }
        var result: [String: Any] = ["access": access, "calendars": calendars.map(Self.json)]
        guard !calendars.isEmpty else {
            result["events"] = []
            return result
        }
        let now = Date()
        let end = now.addingTimeInterval(Double(days) * 86_400)
        let predicate = store.predicateForEvents(withStart: now, end: end, calendars: calendars)
        let events = store.events(matching: predicate)
            .filter { !$0.isAllDay && $0.status != .canceled && Self.selfStatus($0) != .declined && $0.endDate > now }
            .sorted { $0.startDate < $1.startDate }
            .prefix(Self.maxEvents)
        result["events"] = events.map(Self.json)
        return result
    }

    private static func selfStatus(_ event: EKEvent) -> EKParticipantStatus? {
        event.attendees?.first(where: \.isCurrentUser)?.participantStatus
    }

    private static func json(_ calendar: EKCalendar) -> [String: Any] {
        ["id": calendar.calendarIdentifier, "title": calendar.title, "color": hex(calendar.color), "account": calendar.source?.title ?? ""]
    }

    private static func json(_ event: EKEvent) -> [String: Any] {
        let milliseconds = { (date: Date) in Int64(date.timeIntervalSince1970 * 1000) }
        // A repeating event has one identifier for all its occurrences. The original date of the occurrence makes the ID unique.
        let occurrence = event.occurrenceDate ?? event.startDate ?? Date()
        let attendees = (event.attendees ?? []).filter { $0.participantType != .room && $0.participantType != .resource }
        var fields: [String: Any] = [
            "id": "\(event.eventIdentifier ?? event.calendarItemIdentifier)@\(milliseconds(occurrence))",
            "title": event.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "",
            "start": milliseconds(event.startDate),
            "end": milliseconds(event.endDate),
            "calendar_id": event.calendar?.calendarIdentifier ?? "",
            "attendees": attendees.map { attendee in
                [
                    "name": attendee.name ?? "",
                    "email": email(attendee.url),
                    "is_self": attendee.isCurrentUser,
                    "status": status(attendee.participantStatus),
                ] as [String: Any]
            },
        ]
        if let location = event.location, !location.isEmpty { fields["location"] = location }
        if let url = event.url { fields["url"] = url.absoluteString }
        if let notes = event.notes, !notes.isEmpty { fields["notes"] = String(notes.prefix(maxNotes)) }
        return fields
    }

    private static func email(_ url: URL) -> String {
        let text = url.absoluteString
        return text.lowercased().hasPrefix("mailto:") ? String(text.dropFirst(7)) : ""
    }

    private static func status(_ status: EKParticipantStatus) -> String {
        switch status {
        case .accepted: return "accepted"
        case .declined: return "declined"
        case .tentative: return "tentative"
        case .pending: return "pending"
        default: return "unknown"
        }
    }

    private static func hex(_ color: NSColor?) -> String {
        guard let rgb = color?.usingColorSpace(.sRGB) else { return "" }
        let byte = { (value: CGFloat) in Int((max(0, min(1, value)) * 255).rounded()) }
        return String(format: "#%02x%02x%02x", byte(rgb.redComponent), byte(rgb.greenComponent), byte(rgb.blueComponent))
    }
}
