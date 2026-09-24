import CryptoKit
import FluidAudio
import Foundation

/// Finds speech in a live track with VAD and sends each utterance to the live pass.
final class LiveSegmenter: @unchecked Sendable {
    private let track: Track
    private let speech: Speech
    private var continuation: AsyncStream<([Float], Int64)>.Continuation?
    private var task: Task<Void, Never>?

    private static let frame = VadManager.chunkSize
    private static let maxSegmentSamples = 12 * ChunkFormat.sampleRate
    private static let endSilenceSamples = ChunkFormat.sampleRate * 7 / 10
    private static let paddingSamples = ChunkFormat.sampleRate / 4

    /// `isEcho` receives the RMS level and the sample range of a microphone utterance.
    typealias EchoCheck = @Sendable (_ level: Float, _ start: Int64, _ end: Int64) -> Bool

    init(track: Track, speech: Speech, isEcho: EchoCheck? = nil) {
        self.track = track
        self.speech = speech
        let (stream, continuation) = AsyncStream<([Float], Int64)>.makeStream(bufferingPolicy: .bufferingNewest(2000))
        self.continuation = continuation
        task = Task { [track, speech] in
            await Self.run(stream: stream, track: track, speech: speech, isEcho: isEcho)
        }
    }

    func push(_ samples: [Float], index: Int64) {
        continuation?.yield((samples, index))
    }

    func finish() {
        continuation?.finish()
    }

    private static func run(stream: AsyncStream<([Float], Int64)>, track: Track, speech: Speech, isEcho: EchoCheck?) async {
        var pending: [Float] = []
        var pendingStart: Int64 = 0
        var history: [Float] = []
        var segment: [Float] = []
        var segmentStart: Int64 = 0
        var speaking = false
        var silence = 0
        var state: VadStreamState? = nil

        func emit(_ samples: [Float], start: Int64) async {
            if let isEcho {
                let level = EchoFilter.rms(samples, 0, Double(samples.count) / Double(ChunkFormat.sampleRate))
                if isEcho(level, start, start + Int64(samples.count)) { return }
            }
            let offset = Double(start) / Double(ChunkFormat.sampleRate)
            do {
                let (text, _) = try await speech.transcribe(samples, offset: offset)
                guard !text.isEmpty else { return }
                Output.shared.event(
                    "live",
                    [
                        "track": track.rawValue, "s": offset,
                        "e": offset + Double(samples.count) / Double(ChunkFormat.sampleRate), "text": text,
                    ])
            } catch {
                Output.shared.event("error", ["message": "live transcription failed: \(error)"])
            }
        }

        for await (samples, index) in stream {
            if pending.isEmpty { pendingStart = index }
            if index > pendingStart + Int64(pending.count) + Int64(ChunkFormat.sampleRate / 10) {
                if speaking && !segment.isEmpty { await emit(segment, start: segmentStart) }
                speaking = false
                segment.removeAll()
                pending.removeAll()
                history.removeAll()
                pendingStart = index
                state = nil
            }
            pending.append(contentsOf: samples)
            while pending.count >= frame {
                let chunk = Array(pending.prefix(frame))
                let chunkStart = pendingStart
                pending.removeFirst(frame)
                pendingStart += Int64(frame)
                let probability: Float
                do {
                    let (value, next) = try await speech.vadProbability(chunk, state: state)
                    probability = value
                    state = next
                } catch {
                    Output.shared.event("error", ["message": "live VAD failed: \(error)"])
                    return
                }
                if speaking {
                    segment.append(contentsOf: chunk)
                    silence = probability < 0.35 ? silence + frame : 0
                    if silence >= endSilenceSamples || segment.count >= maxSegmentSamples {
                        await emit(segment, start: segmentStart)
                        segment.removeAll()
                        speaking = silence < endSilenceSamples
                        segmentStart = chunkStart + Int64(frame)
                        silence = 0
                    }
                } else if probability >= 0.5 {
                    speaking = true
                    silence = 0
                    let pad = Array(history.suffix(paddingSamples))
                    segment = pad + chunk
                    segmentStart = chunkStart - Int64(pad.count)
                }
                history.append(contentsOf: chunk)
                if history.count > paddingSamples * 2 { history.removeFirst(history.count - paddingSamples) }
            }
        }
        if speaking && !segment.isEmpty { await emit(segment, start: segmentStart) }
    }
}

/// One recording: capture, encrypted chunks, levels, and the live pass.
final class RecordingSession: @unchecked Sendable {
    let directory: URL
    let startHost: UInt64
    let startWallMs: Int64
    private let writers: [Track: ChunkWriter]
    private let segmenters: [Track: LiveSegmenter]
    private var tap: RemoteTap?
    private var mic: MicCapture?
    private let lock = NSLock()
    private var paused = false
    private var levels: [Track: Float] = [:]
    private var levelTimer: DispatchSourceTimer?
    /// Remote levels by sample range, for the live echo check. Kept for 60 seconds.
    private var remoteLevels: [(start: Int64, end: Int64, level: Float)] = []
    /// Microphone audio waits here before it is stored or transcribed. A mute in Meet reaches the
    /// engine a little after the click, so the delay lets the engine silence the audio from the exact time.
    private var micHold: [(samples: [Float], start: Int64)] = []
    private static let micHoldSamples = Int64(ChunkFormat.sampleRate * 8 / 10)
    /// Changes of the Meet microphone state, by meeting clock index.
    private var muteChanges: [(index: Int64, muted: Bool)] = []

    init(directory: URL, key: SymmetricKey, source: String, speech: Speech, micMuted: Bool) throws {
        self.directory = directory
        startHost = Clock.now()
        startWallMs = Int64(Date().timeIntervalSince1970 * 1000)
        if micMuted { muteChanges = [(0, true)] }
        var writers: [Track: ChunkWriter] = [:]
        var segmenters: [Track: LiveSegmenter] = [:]
        for track in Track.allCases {
            writers[track] = try ChunkWriter(directory: directory, key: key, track: track)
        }
        segmenters[.remote] = LiveSegmenter(track: .remote, speech: speech)
        let box = WeakBox()
        segmenters[.mic] = LiveSegmenter(track: .mic, speech: speech) { level, start, end in
            box.session?.isEcho(level: level, start: start, end: end) ?? false
        }
        self.writers = writers
        self.segmenters = segmenters
        defer { box.session = self }
        let session: [String: Any] = ["start_wall_ms": startWallMs, "sample_rate": ChunkFormat.sampleRate, "source": source]
        let sessionURL = directory.appendingPathComponent("audio/session-\(startWallMs).json")
        try FileManager.default.createDirectory(
            at: sessionURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: session).write(to: sessionURL)

        tap = RemoteTap(source: source) { [weak self] samples, host in
            self?.receive(.remote, samples, host)
        }
        mic = MicCapture { [weak self] samples, host in
            self?.receive(.mic, samples, host)
        }
    }

    func start() throws {
        try tap?.start()
        try mic?.start()
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        timer.schedule(deadline: .now() + 0.25, repeating: 0.25)
        timer.setEventHandler { [weak self] in self?.emitLevels() }
        timer.resume()
        levelTimer = timer
    }

    /// The meeting clock index of a host time, relative to the session start.
    func index(for host: UInt64) -> Int64 {
        let seconds = Clock.seconds(hostTime: host) - Clock.seconds(hostTime: startHost)
        return Int64(max(0, seconds) * Double(ChunkFormat.sampleRate))
    }

    private func receive(_ track: Track, _ samples: [Float], _ host: UInt64) {
        lock.lock()
        let isPaused = paused
        var sum: Float = 0
        for sample in samples { sum += sample * sample }
        let rms = samples.isEmpty ? 0 : (sum / Float(samples.count)).squareRoot()
        levels[track] = max(levels[track] ?? 0, rms)
        lock.unlock()
        guard !isPaused else { return }
        let start = index(for: host)
        if track == .remote {
            lock.lock()
            remoteLevels.append((start, start + Int64(samples.count), rms))
            let cutoff = start - Int64(60 * ChunkFormat.sampleRate)
            if let first = remoteLevels.first, first.start < cutoff {
                remoteLevels.removeAll { $0.end < cutoff }
            }
            lock.unlock()
        }
        if track == .mic {
            holdMic(samples, start: start)
        } else {
            store(.remote, samples, start: start)
        }
    }

    private func store(_ track: Track, _ samples: [Float], start: Int64) {
        writers[track]?.append(samples, startIndex: start)
        segmenters[track]?.push(samples, index: start)
    }

    private func holdMic(_ samples: [Float], start: Int64) {
        lock.lock()
        micHold.append((samples, start))
        let cutoff = start + Int64(samples.count) - Self.micHoldSamples
        var ready: [(samples: [Float], start: Int64)] = []
        while let first = micHold.first, first.start + Int64(first.samples.count) <= cutoff {
            ready.append(silenceMuted(micHold.removeFirst()))
        }
        lock.unlock()
        for item in ready { store(.mic, item.samples, start: item.start) }
    }

    private func releaseMic() {
        lock.lock()
        let ready = micHold.map(silenceMuted)
        micHold.removeAll()
        lock.unlock()
        for item in ready { store(.mic, item.samples, start: item.start) }
    }

    /// Replaces the samples that fall in a muted interval with silence. The caller holds `lock`.
    private func silenceMuted(_ item: (samples: [Float], start: Int64)) -> (samples: [Float], start: Int64) {
        guard !muteChanges.isEmpty else { return item }
        var samples = item.samples
        for i in samples.indices where isMuted(at: item.start + Int64(i)) {
            samples[i] = 0
        }
        return (samples, item.start)
    }

    private func isMuted(at index: Int64) -> Bool {
        var muted = false
        for change in muteChanges {
            if change.index > index { break }
            muted = change.muted
        }
        return muted
    }

    /// Records a Meet microphone change at a wall clock time in milliseconds.
    func setMicMuted(_ muted: Bool, wallMs: Int64) {
        let index = max(0, (wallMs - startWallMs) * Int64(ChunkFormat.sampleRate) / 1000)
        lock.lock()
        muteChanges.removeAll { $0.index >= index }
        muteChanges.append((index, muted))
        lock.unlock()
    }

    private var micMutedNow: Bool {
        lock.lock()
        defer { lock.unlock() }
        return muteChanges.last?.muted ?? false
    }

    /// A microphone utterance is echo when remote audio plays and the microphone level is low.
    func isEcho(level: Float, start: Int64, end: Int64) -> Bool {
        lock.lock()
        let overlapping = remoteLevels.filter { $0.end > start && $0.start < end }
        lock.unlock()
        guard !overlapping.isEmpty else { return false }
        let remote = (overlapping.map { $0.level * $0.level }.reduce(0, +) / Float(overlapping.count)).squareRoot()
        return EchoFilter.isEcho(micLevel: level, remoteLevel: remote)
    }

    private func emitLevels() {
        let muted = micMutedNow
        lock.lock()
        let mic = muted ? 0 : levels[.mic] ?? 0
        let remote = levels[.remote] ?? 0
        levels = [:]
        lock.unlock()
        Output.shared.event(
            "levels",
            [
                "mic": Double(mic), "remote": Double(remote), "remote_capturing": tap?.isCapturing ?? false,
                "mic_muted": muted,
            ])
    }

    private final class WeakBox: @unchecked Sendable {
        weak var session: RecordingSession?
    }

    func setPaused(_ value: Bool) {
        if value { releaseMic() }
        lock.lock()
        paused = value
        lock.unlock()
        if value { writers.values.forEach { $0.flush() } }
    }

    func stop() {
        levelTimer?.cancel()
        mic?.stop()
        tap?.stop()
        releaseMic()
        writers.values.forEach { $0.flush() }
        segmenters.values.forEach { $0.finish() }
    }
}
