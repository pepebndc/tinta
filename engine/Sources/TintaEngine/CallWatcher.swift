import CoreAudio
import Foundation

/// Detects calls in desktop meeting apps from their audio processes.
/// A call starts when the app uses the microphone. The call continues while the app uses the
/// microphone or plays audio, because some apps release the microphone while it is muted.
/// The watcher sends `call_started` and `call_ended` events.
///
/// When reading is on and macOS allows Accessibility access, the watcher also reads the
/// participants, the active speaker, and the microphone state of each call. It sends a
/// `call_state` event when the state changes, and every few seconds while the call lasts.
final class CallWatcher: @unchecked Sendable {
    struct App {
        /// The recording source for the app, also used as the call ID.
        let id: String
        let name: String
        /// Bundle ID prefixes of the app processes that use audio.
        let prefixes: [String]
    }

    static let apps = [
        App(id: "us.zoom.xos", name: "Zoom", prefixes: ["us.zoom."]),
        App(id: "com.microsoft.teams2", name: "Microsoft Teams", prefixes: ["com.microsoft.teams2"]),
    ]

    /// The time without audio activity before a call counts as ended.
    private static let endDelay = 2.0
    /// The time between two `call_state` events without a change.
    private static let stateHeartbeat = 3.0

    private struct Call {
        let since: Int64
        var lastActive: Date
    }

    private let queue = DispatchQueue(label: "tinta.calls")
    private let readQueue = DispatchQueue(label: "tinta.calls.read")
    private var timer: DispatchSourceTimer?
    private var readTimer: DispatchSourceTimer?
    private var calls: [String: Call] = [:]
    private var reading = false
    /// The last state sent for each call, and the time it was sent. Only the read queue uses it.
    private var sent: [String: (CallSnapshot, Date)] = [:]

    func start() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: 1)
        timer.setEventHandler { [weak self] in self?.poll() }
        timer.resume()
        self.timer = timer

        let readTimer = DispatchSource.makeTimerSource(queue: readQueue)
        readTimer.schedule(deadline: .now() + 0.5, repeating: 0.5)
        readTimer.setEventHandler { [weak self] in self?.read() }
        readTimer.resume()
        self.readTimer = readTimer
    }

    func setReading(_ enabled: Bool) {
        queue.sync { reading = enabled }
    }

    /// The current calls, for a client that connects after the events.
    func current() -> [[String: Any]] {
        queue.sync {
            Self.apps.compactMap { app in
                calls[app.id].map { ["app": app.id, "name": app.name, "since": $0.since] }
            }
        }
    }

    private func poll() {
        let processes = CoreAudioQuery.processes()
        let now = Date()
        for app in Self.apps {
            let own = processes.filter { process in app.prefixes.contains { process.bundleID.hasPrefix($0) } }
            let input = own.contains(where: \.isRunningInput)
            let active = input || own.contains(where: \.isRunningOutput)
            if var call = calls[app.id] {
                if active {
                    call.lastActive = now
                    calls[app.id] = call
                } else if now.timeIntervalSince(call.lastActive) >= Self.endDelay {
                    calls[app.id] = nil
                    let leftAt = Int64(call.lastActive.timeIntervalSince1970 * 1000)
                    Output.shared.event("call_ended", ["app": app.id, "name": app.name, "left_at": leftAt])
                }
            } else if input {
                let since = Int64(now.timeIntervalSince1970 * 1000)
                calls[app.id] = Call(since: since, lastActive: now)
                Output.shared.event("call_started", ["app": app.id, "name": app.name, "since": since])
            }
        }
    }

    private func read() {
        let (enabled, active) = queue.sync { (reading, Set(calls.keys)) }
        sent = sent.filter { active.contains($0.key) }
        guard enabled else { return }
        let now = Date()
        for app in active {
            guard let snapshot = CallReader.read(appID: app) else { continue }
            if let (last, time) = sent[app], last == snapshot, now.timeIntervalSince(time) < Self.stateHeartbeat {
                continue
            }
            sent[app] = (snapshot, now)
            var fields = snapshot.json
            fields["app"] = app
            fields["t"] = Int64(now.timeIntervalSince1970 * 1000)
            Output.shared.event("call_state", fields)
        }
    }
}
