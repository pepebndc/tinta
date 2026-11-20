import CoreML
import CryptoKit
import FluidAudio
import Foundation
import NaturalLanguage

/// Pinned model revisions. The app installs models only through `install_models`.
enum ModelPins {
    static let revisions: [String: String] = [
        "FluidInference/parakeet-tdt-0.6b-v3-coreml": "7dd20fe6b1797d35f5e3307e8b1732d9a178edfe",
        "FluidInference/silero-vad-coreml": "b419383c55c110e2c9271fa6ee0ea83d03c70d96",
        "FluidInference/speaker-diarization-coreml": "df2625ac79a7ac6b65ad868fee6d80f320da4232",
    ]

    /// Blocks every model download outside `install_models`.
    static let offlineRegistry = "http://127.0.0.1:9"
    static let onlineRegistry = "https://huggingface.co"

    /// The engine starts offline, and only `install_models` goes online. In offline mode, FluidAudio
    /// does not delete a model folder and download it again when a model fails to load.
    static func setOnline(_ online: Bool) {
        ModelRegistry.baseURL = online ? onlineRegistry : offlineRegistry
        ModelRegistry.revisionOverrides = revisions
        ModelHub.offlineMode = !online
    }

    static var modelsRoot: URL { MLModelConfigurationUtils.defaultModelsDirectory() }

    /// The model folder of each pinned repository.
    static let folders: [String: String] = [
        "parakeet-tdt-0.6b-v3": "FluidInference/parakeet-tdt-0.6b-v3-coreml",
        "silero-vad": "FluidInference/silero-vad-coreml",
        "speaker-diarization": "FluidInference/speaker-diarization-coreml",
    ]

    /// FluidAudio downloads a model folder again when its revision marker is missing or different.
    /// Other FluidAudio clients on this Mac share the folders and can replace a marker. The engine
    /// calls this only after every file matches the pinned manifest, so the pinned revision is correct.
    static func writeRevisionMarkers() {
        for (folder, repo) in folders {
            guard let revision = revisions[repo] else { continue }
            let marker = modelsRoot.appendingPathComponent(folder).appendingPathComponent(".fluidaudio-revision")
            let current = (try? String(contentsOf: marker, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
            if current != revision {
                try? Data((revision + "\n").utf8).write(to: marker, options: .atomic)
            }
        }
    }
}

struct Word {
    let text: String
    let start: Double
    let end: Double

    var json: [String: Any] { ["w": text, "s": start, "e": end] }
}

actor Speech {
    private var asr: AsrManager?
    private var vad: VadManager?
    /// The model load in progress. Concurrent callers wait for this task and do not load the models again.
    private var loading: Task<Void, Error>?

    private var verified = false

    func modelsInstalled() -> Bool {
        ModelManifest.sha256.keys.allSatisfy {
            FileManager.default.fileExists(atPath: ModelPins.modelsRoot.appendingPathComponent($0).path)
        }
    }

    /// Checks every model file against the pinned SHA-256 manifest.
    func verify() throws {
        if verified { return }
        for (path, expected) in ModelManifest.sha256 {
            let url = ModelPins.modelsRoot.appendingPathComponent(path)
            guard let handle = try? FileHandle(forReadingFrom: url) else {
                throw EngineError("model file missing: \(path). Install the models again.")
            }
            defer { try? handle.close() }
            var hasher = SHA256()
            while let data = try handle.read(upToCount: 4 << 20), !data.isEmpty {
                hasher.update(data: data)
            }
            let digest = hasher.finalize().map { String(format: "%02x", $0) }.joined()
            guard digest == expected else {
                throw EngineError("model file does not match its pinned hash: \(path). Install the models again.")
            }
        }
        ModelPins.writeRevisionMarkers()
        verified = true
    }

    func install() async throws {
        // The downloads replace model files, so the last hash check does not apply to them.
        verified = false
        ModelPins.setOnline(true)
        defer { ModelPins.setOnline(false) }
        Output.shared.event("install_progress", ["component": "transcription", "state": "downloading"])
        let asrModels = try await AsrModels.downloadAndLoad(version: .v3)
        Output.shared.event("install_progress", ["component": "vad", "state": "downloading"])
        let vadManager = try await VadManager()
        Output.shared.event("install_progress", ["component": "diarization", "state": "downloading"])
        let diarizerManager = OfflineDiarizerManager()
        try await diarizerManager.prepareModels()
        try verify()
        let manager = AsrManager()
        try await manager.loadModels(asrModels)
        asr = manager
        vad = vadManager
        Output.shared.event("install_progress", ["component": "all", "state": "done"])
    }

    private func loadIfNeeded() async throws {
        if verified, asr != nil, vad != nil { return }
        if let loading { return try await loading.value }
        let task = Task { try await self.load() }
        loading = task
        defer { loading = nil }
        try await task.value
    }

    private func load() async throws {
        guard modelsInstalled() else { throw EngineError("models are not installed") }
        try verify()
        if asr == nil {
            let models = try await AsrModels.load(from: AsrModels.defaultCacheDirectory(for: .v3), version: .v3)
            let manager = AsrManager()
            try await manager.loadModels(models)
            asr = manager
        }
        if vad == nil {
            vad = try await VadManager()
        }
    }

    /// The diarizer models use GPU memory in proportion to the audio length, and Core ML keeps it
    /// while the models exist. Each final pass loads a new diarizer and releases it at the end.
    private func makeDiarizer(maxSpeakers: Int?) async throws -> OfflineDiarizerManager {
        try verify()
        var config = OfflineDiarizerConfig.default
        if let maxSpeakers, maxSpeakers > 0 {
            config = config.withSpeakers(min: nil, max: maxSpeakers)
        }
        let manager = OfflineDiarizerManager(config: config)
        try await manager.prepareModels()
        return manager
    }

    func warmUp() async throws {
        try await loadIfNeeded()
    }

    // MARK: Live pass

    func vadProbability(_ chunk: [Float], state: VadStreamState?) async throws -> (Float, VadStreamState) {
        try await loadIfNeeded()
        guard let vad else { throw EngineError("VAD not loaded") }
        let current: VadStreamState
        if let state { current = state } else { current = await vad.makeStreamState() }
        let result = try await vad.processStreamingChunk(chunk, state: current)
        return (result.probability, result.state)
    }

    /// The model reads at most this much audio in one pass, and it pads a shorter input to this length.
    /// So context audio up to this length costs no extra time.
    static let modelSamples = ASRConstants.maxModelSamples

    /// Transcribes the speech in `window` of `audio`. `audio[0]` is at `offset` seconds.
    /// The model has no language setting: it takes the language from the audio. A short utterance alone,
    /// such as "sí", often comes out as English words, and the speech around it gives the model the language
    /// of the conversation. But near a change of language, the speech around it can pull the utterance into
    /// the wrong language. So the model decodes the window alone and with the audio around it, and the decode
    /// with the higher mean token confidence wins. Only the words with their middle in `keep` count.
    func transcribe(_ audio: [Float], offset: Double, window: Range<Int>, keep: Range<Int>) async throws -> [Word] {
        let rate = Double(ChunkFormat.sampleRate)
        let seconds = { (sample: Int) in offset + Double(sample) / rate }
        let keep = seconds(keep.lowerBound)..<seconds(keep.upperBound)
        let alone = try await decode(Array(audio[window]), offset: seconds(window.lowerBound), keep: keep)
        let context = Self.contextRange(for: window, count: audio.count)
        guard context != window else { return alone.words }
        let around = try await decode(Array(audio[context]), offset: seconds(context.lowerBound), keep: keep)
        return around.confidence > alone.confidence ? around.words : alone.words
    }

    /// The words with their middle in `keep`, and the mean confidence of their tokens. A word of only
    /// punctuation, such as the end of the sentence before `keep`, does not count.
    private func decode(_ samples: [Float], offset: Double, keep: Range<Double>) async throws -> (words: [Word], confidence: Float) {
        try await loadIfNeeded()
        guard let asr else { throw EngineError("ASR not loaded") }
        guard samples.count >= ASRConstants.minimumRequiredSamples(forSampleRate: ChunkFormat.sampleRate) else { return ([], 0) }
        var state = try TdtDecoderState(decoderLayers: await asr.decoderLayerCount)
        let result = try await asr.transcribe(samples, decoderState: &state)
        let all = result.tokenTimings ?? []
        let inside = all.indices.filter { keep.contains(offset + (all[$0].startTime + all[$0].endTime) / 2) }
        guard let first = inside.first, let last = inside.last else { return ([], 0) }
        let tokens = Array(all[first...last])
        var words = buildWordTimings(from: tokens)
            .filter { $0.word.contains { $0.isLetter || $0.isNumber } }
            .map { Word(text: $0.word, start: $0.startTime + offset, end: $0.endTime + offset) }
        // The model can put the punctuation of a sentence in the silence around it. The marks join the
        // first and the last word, and the word times stay the times of the speech.
        let mark = { (token: TokenTiming) in token.token.replacingOccurrences(of: "▁", with: "").trimmingCharacters(in: .whitespaces) }
        var opening = "", closing = ""
        var index = first - 1
        while index >= 0, Self.isPunctuation(all[index].token, in: "¿¡\"«(") { opening = mark(all[index]) + opening; index -= 1 }
        index = last + 1
        while index < all.count, Self.isPunctuation(all[index].token, in: ".,;:?!…\"»)") { closing += mark(all[index]); index += 1 }
        if let head = words.first, !opening.isEmpty { words[0] = Word(text: opening + head.text, start: head.start, end: head.end) }
        if let tail = words.last, !closing.isEmpty { words[words.count - 1] = Word(text: tail.text + closing, start: tail.start, end: tail.end) }
        return (words, tokens.map(\.confidence).reduce(0, +) / Float(tokens.count))
    }

    /// True when the token has only characters of `marks`, without the word start mark of the vocabulary.
    nonisolated static func isPunctuation(_ token: String, in marks: String) -> Bool {
        let text = token.replacingOccurrences(of: "▁", with: "").trimmingCharacters(in: .whitespaces)
        return !text.isEmpty && text.allSatisfy { marks.contains($0) }
    }

    /// The audio range to transcribe for the speech in `window`: the window and the audio around it,
    /// to a total of almost `modelSamples`. Each side gets half of the context. When one side reaches the
    /// start or the end of the track, the other side gets the rest.
    nonisolated static func contextRange(for window: Range<Int>, count: Int) -> Range<Int> {
        let target = modelSamples - ChunkFormat.sampleRate / 2
        let extra = max(0, target - window.count)
        var start = max(0, window.lowerBound - extra / 2)
        let end = min(count, start + max(target, window.count))
        start = max(0, min(start, end - max(target, window.count)))
        return start..<end
    }

    // MARK: Final pass

    /// Transcribes speech regions of a full track. Regions come from VAD and are grouped
    /// into windows of at most 12 seconds, so that a window and its context fit in one pass of the model.
    func transcribeTrack(_ samples: [Float]) async throws -> [Word] {
        try await loadIfNeeded()
        guard let vad, !samples.isEmpty else { return [] }
        let config = VadSegmentationConfig(minSpeechDuration: 0.2, minSilenceDuration: 0.5, maxSpeechDuration: 14)
        let segments = try await vad.segmentSpeech(samples, config: config)
        var windows: [(Int, Int)] = []
        let rate = ChunkFormat.sampleRate
        for segment in segments {
            let start = segment.startSample(sampleRate: rate)
            let end = min(samples.count, segment.endSample(sampleRate: rate))
            guard end > start else { continue }
            if let last = windows.last, end - last.0 <= 12 * rate, start - last.1 <= rate {
                windows[windows.count - 1] = (last.0, end)
            } else {
                windows.append((start, end))
            }
        }
        var words: [Word] = []
        let margin = rate * 3 / 20
        for (index, window) in windows.enumerated() {
            // A word at the edge of the speech still counts, but no word of the next window does.
            let from = index == 0 ? 0 : max(window.0 - margin, (windows[index - 1].1 + window.0) / 2)
            let to = index == windows.count - 1 ? samples.count : min(window.1 + margin, (window.1 + windows[index + 1].0) / 2)
            words += try await transcribe(samples, offset: 0, window: window.0..<window.1, keep: from..<to)
            Output.shared.event("finalize_progress", ["stage": "transcription", "fraction": Double(index + 1) / Double(max(1, windows.count))])
        }
        return words
    }

    /// `maxSpeakers` comes from the Meet participant count when it is known.
    func diarize(_ samples: [Float], maxSpeakers: Int?) async throws -> [[String: Any]] {
        guard samples.count > ChunkFormat.sampleRate * 2 else { return [] }
        let diarizer = try await makeDiarizer(maxSpeakers: maxSpeakers)
        Output.shared.event("finalize_progress", ["stage": "diarization", "fraction": 0.0])
        let result = try await diarizer.process(audio: samples)
        Output.shared.event("finalize_progress", ["stage": "diarization", "fraction": 1.0])
        return result.segments.map {
            ["speaker": $0.speakerId, "s": Double($0.startTimeSeconds), "e": Double($0.endTimeSeconds)]
        }
    }

    nonisolated static func detectLanguage(_ text: String) -> String? {
        guard text.count > 20 else { return nil }
        let recognizer = NLLanguageRecognizer()
        recognizer.processString(text)
        return recognizer.dominantLanguage?.rawValue
    }
}
