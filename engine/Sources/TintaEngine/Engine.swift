import AVFoundation
import AppKit
import CryptoKit
import Foundation

/// The app starts this process and sends one JSON request per line on stdin.
/// The engine replies with `{"id", "ok", "result" | "error"}` and sends events as `{"event", ...}`.
@main
struct Engine {
    static func main() async {
        let arguments = CommandLine.arguments
        if arguments.count >= 3, arguments[1] == "--tap-helper" {
            TapHelper.run(source: arguments[2])
        }
        setvbuf(stdout, nil, _IOLBF, 0)
        ModelPins.setOnline(false)
        let controller = Controller()
        Output.shared.event("ready", ["version": "0.3.0"])
        Controller.calls.start()
        Controller.calendar.start()
        Task.detached { await controller.prewarm() }
        let reader = Thread {
            while let line = readLine(strippingNewline: true) {
                handle(line: line, controller: controller)
            }
            Task.detached {
                await controller.shutdown()
                exit(0)
            }
        }
        reader.start()
        while true {
            try? await Task.sleep(nanoseconds: 3_600_000_000_000)
        }
    }

    private static func handle(line: String, controller: Controller) {
        guard let data = line.data(using: .utf8),
            let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
            let command = request["cmd"] as? String
        else {
            Output.shared.event("error", ["message": "invalid request"])
            return
        }
        let id = request["id"] ?? NSNull()
        let params = request["params"] as? [String: Any] ?? [:]
        Task.detached {
            if command == "shutdown" {
                await controller.shutdown()
                Output.shared.reply(id, result: [:])
                exit(0)
            }
            do {
                let result = try await controller.handle(command, params)
                Output.shared.reply(id, result: result)
            } catch {
                Output.shared.fail(id, "\(error)")
            }
        }
    }
}

actor Controller {
    static let calls = CallWatcher()
    static let calendar = CalendarReader()
    private let speech = Speech()
    private var session: RecordingSession?
    /// True while `start` waits for permissions and models.
    private var starting = false
    /// A `stop` during a pending start sets this, so the start does not open a session.
    private var startCancelled = false

    func handle(_ command: String, _ params: [String: Any]) async throws -> [String: Any] {
        switch command {
        case "ping":
            return ["pong": true]
        case "models_status":
            return ["installed": await speech.modelsInstalled(), "path": ModelPins.modelsRoot.path]
        case "install_models":
            try await speech.install()
            return ["installed": true]
        case "permissions":
            return ["microphone": Self.micPermission(), "accessibility": CallReader.trusted]
        case "request_microphone":
            let granted = await AVCaptureDevice.requestAccess(for: .audio)
            return ["granted": granted]
        case "list_sources":
            return [
                "sources": Self.sources(), "default_input": CoreAudioQuery.defaultInputName() ?? "",
                "route": OutputRoute.current().rawValue,
            ]
        case "calls":
            if let read = params["read"] as? Bool { Self.calls.setReading(read) }
            return ["calls": Self.calls.current(), "accessibility": CallReader.trusted]
        case "request_accessibility":
            return ["granted": CallReader.requestTrust()]
        case "call_report":
            let app = try params.string("app")
            guard let text = CallReader.dump(appID: app) else {
                throw EngineError("Tinta cannot read the app window. Allow Accessibility access, and keep the call open.")
            }
            return ["text": text]
        case "calendar":
            return Self.calendar.read(days: params["days"] as? Int ?? 7)
        case "request_calendar":
            return ["granted": try await Self.calendar.request()]
        case "start":
            return try await start(params)
        case "pause":
            session?.setPaused(true)
            return [:]
        case "resume":
            session?.setPaused(false)
            return [:]
        case "mic_muted":
            let wallMs = (params["t"] as? NSNumber)?.int64Value ?? Int64(Date().timeIntervalSince1970 * 1000)
            session?.setMicMuted(params["muted"] as? Bool ?? false, wallMs: wallMs)
            return [:]
        case "stop":
            if starting { startCancelled = true }
            session?.stop()
            session = nil
            return [:]
        case "summary_status":
            return Summarizer.status()
        case "summarize":
            return try await Summarizer.summarize(params)
        case "finalize":
            return try await finalize(params)
        case "sample":
            return try sample(params)
        case "import_audio":
            return try importAudio(params)
        default:
            throw EngineError("unknown command \(command)")
        }
    }

    func shutdown() {
        if starting { startCancelled = true }
        session?.stop()
        session = nil
    }

    /// Loads the speech models in the background, so the first start does not wait for the model check.
    func prewarm() async {
        guard await speech.modelsInstalled() else { return }
        try? await speech.warmUp()
    }

    private static func key(_ params: [String: Any]) throws -> SymmetricKey {
        guard let data = Data(base64Encoded: try params.string("audio_key")), data.count == 32 else {
            throw EngineError("invalid audio key")
        }
        return SymmetricKey(data: data)
    }

    private static func micPermission() -> String {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return "granted"
        case .denied, .restricted: return "denied"
        default: return "undetermined"
        }
    }

    private static let knownSources: [(String, String)] = [
        ("com.google.Chrome", "Google Chrome"),
        ("us.zoom.xos", "Zoom"),
        ("com.microsoft.teams2", "Microsoft Teams"),
        ("com.tinyspeck.slackmacgap", "Slack"),
        ("com.apple.WebKit", "Safari"),
    ]

    private static func sources() -> [[String: Any]] {
        let active = CoreAudioQuery.processes().filter(\.isRunningOutput)
        var result: [[String: Any]] = knownSources.map { bundle, name in
            ["id": bundle, "name": name, "playing": active.contains { $0.belongs(to: bundle) }]
        }
        result.append(["id": "all", "name": "All system audio", "playing": !active.isEmpty])
        return result
    }

    private func start(_ params: [String: Any]) async throws -> [String: Any] {
        guard session == nil, !starting else { throw EngineError("a recording is already active") }
        starting = true
        startCancelled = false
        defer { starting = false }
        let directory = URL(fileURLWithPath: try params.string("dir"), isDirectory: true)
        let source = params.optionalString("source") ?? "com.google.Chrome"
        if !(await AVCaptureDevice.requestAccess(for: .audio)) {
            throw EngineError(
                "Microphone access is off. Allow Tinta in System Settings, Privacy and Security, Microphone.")
        }
        try await speech.warmUp()
        if startCancelled { throw EngineError("the recording stopped before it started") }
        let recording = try RecordingSession(
            directory: directory, key: try Self.key(params), source: source, speech: speech,
            micMuted: params["mic_muted"] as? Bool ?? false)
        try recording.start()
        session = recording
        return ["start_wall_ms": recording.startWallMs]
    }

    private func finalize(_ params: [String: Any]) async throws -> [String: Any] {
        // A final pass can run during a recording. The speech models serve both, one window at a time.
        let directory = URL(fileURLWithPath: try params.string("dir"), isDirectory: true)
        let key = try Self.key(params)
        var tracks: [String: Any] = [:]
        var allText = ""
        var duration = 0.0
        var trackSamples: [Track: [Float]] = [:]
        trackSamples[.remote] = try ChunkReader.track(directory: directory, key: key, track: .remote)
        for track in [Track.remote, Track.mic] {
            let samples = try trackSamples[track] ?? ChunkReader.track(directory: directory, key: key, track: track)
            duration = max(duration, Double(samples.count) / Double(ChunkFormat.sampleRate))
            var words = try await speech.transcribeTrack(samples)
            if track == .mic, let remote = trackSamples[.remote] ?? nil as [Float]? {
                words = words.filter { !EchoFilter.isEcho(mic: samples, remote: remote, start: $0.start, end: $0.end) }
            }
            allText += words.map(\.text).joined(separator: " ") + " "
            var entry: [String: Any] = ["words": words.map(\.json)]
            if track == .remote {
                entry["diarization"] = try await speech.diarize(samples, maxSpeakers: params["max_speakers"] as? Int)
            }
            tracks[track.rawValue] = entry
        }
        var result: [String: Any] = ["tracks": tracks, "duration": duration]
        if let language = Speech.detectLanguage(allText) { result["language"] = language }
        return result
    }

    /// Imports a local recording as the remote track, so the final pass separates all voices in it.
    private func importAudio(_ params: [String: Any]) throws -> [String: Any] {
        let directory = URL(fileURLWithPath: try params.string("dir"), isDirectory: true)
        let file = try AVAudioFile(forReading: URL(fileURLWithPath: try params.string("path")))
        let writer = try ChunkWriter(directory: directory, key: try Self.key(params), track: .remote)
        let resampler = Resampler()
        let frames: AVAudioFrameCount = 1 << 16
        guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: frames) else {
            throw EngineError("cannot allocate buffer")
        }
        var index: Int64 = 0
        while file.framePosition < file.length {
            try file.read(into: buffer, frameCount: frames)
            if buffer.frameLength == 0 { break }
            let samples = resampler.convert(buffer)
            writer.append(samples, startIndex: index)
            index += Int64(samples.count)
        }
        writer.flush()
        return ["duration": Double(index) / Double(ChunkFormat.sampleRate)]
    }

    private func sample(_ params: [String: Any]) throws -> [String: Any] {
        let directory = URL(fileURLWithPath: try params.string("dir"), isDirectory: true)
        guard let track = Track(rawValue: try params.string("track")) else { throw EngineError("invalid track") }
        let start = try params.double("s")
        let end = try params.double("e")
        let samples = try ChunkReader.track(directory: directory, key: try Self.key(params), track: track)
        let rate = Double(ChunkFormat.sampleRate)
        let from = max(0, min(samples.count, Int(start * rate)))
        let to = max(from, min(samples.count, Int(end * rate)))
        let wav = ChunkReader.wav(samples: Array(samples[from..<to]))
        return ["wav_base64": wav.base64EncodedString()]
    }
}
