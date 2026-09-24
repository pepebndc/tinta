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

    static func setOnline(_ online: Bool) {
        ModelRegistry.baseURL = online ? onlineRegistry : offlineRegistry
        ModelRegistry.revisionOverrides = revisions
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
    private var diarizer: OfflineDiarizerManager?

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
        ModelPins.setOnline(true)
        defer { ModelPins.setOnline(false) }
        Output.shared.event("install_progress", ["component": "transcription", "state": "downloading"])
        let asrModels = try await AsrModels.downloadAndLoad(version: .v3)
        Output.shared.event("install_progress", ["component": "vad", "state": "downloading"])
        let vadManager = try await VadManager()
        Output.shared.event("install_progress", ["component": "diarization", "state": "downloading"])
        let diarizerManager = OfflineDiarizerManager()
        try await diarizerManager.prepareModels()
        verified = false
        try verify()
        let manager = AsrManager()
        try await manager.loadModels(asrModels)
        asr = manager
        vad = vadManager
        diarizer = diarizerManager
        Output.shared.event("install_progress", ["component": "all", "state": "done"])
    }

    private func loadIfNeeded() async throws {
        guard modelsInstalled() else { throw EngineError("models are not installed") }
        ModelPins.setOnline(false)
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

    private func loadDiarizerIfNeeded() async throws {
        guard diarizer == nil else { return }
        ModelPins.setOnline(false)
        try verify()
        let manager = OfflineDiarizerManager()
        try await manager.prepareModels()
        diarizer = manager
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

    func transcribe(_ samples: [Float], offset: Double) async throws -> (String, [Word]) {
        try await loadIfNeeded()
        guard let asr else { throw EngineError("ASR not loaded") }
        guard samples.count >= ChunkFormat.sampleRate / 4 else { return ("", []) }
        var state = try TdtDecoderState(decoderLayers: await asr.decoderLayerCount)
        let result = try await asr.transcribe(samples, decoderState: &state)
        let words = buildWordTimings(from: result.tokenTimings ?? []).map {
            Word(text: $0.word, start: $0.startTime + offset, end: $0.endTime + offset)
        }
        return (result.text.trimmingCharacters(in: .whitespacesAndNewlines), words)
    }

    // MARK: Final pass

    /// Transcribes speech regions of a full track. Regions come from VAD and are grouped
    /// into windows of at most 25 seconds.
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
            if let last = windows.last, end - last.0 <= 25 * rate, start - last.1 <= rate {
                windows[windows.count - 1] = (last.0, end)
            } else {
                windows.append((start, end))
            }
        }
        var words: [Word] = []
        for (index, window) in windows.enumerated() {
            let slice = Array(samples[window.0..<window.1])
            let (_, windowWords) = try await transcribe(slice, offset: Double(window.0) / Double(rate))
            words.append(contentsOf: windowWords)
            Output.shared.event("finalize_progress", ["stage": "transcription", "fraction": Double(index + 1) / Double(max(1, windows.count))])
        }
        return words
    }

    /// `maxSpeakers` comes from the Meet participant count when it is known.
    func diarize(_ samples: [Float], maxSpeakers: Int?) async throws -> [[String: Any]] {
        guard samples.count > ChunkFormat.sampleRate * 2 else { return [] }
        try await loadDiarizerIfNeeded()
        guard var active = diarizer else { return [] }
        if let maxSpeakers, maxSpeakers > 0 {
            let manager = OfflineDiarizerManager(config: OfflineDiarizerConfig.default.withSpeakers(min: nil, max: maxSpeakers))
            try await manager.prepareModels()
            active = manager
        }
        Output.shared.event("finalize_progress", ["stage": "diarization", "fraction": 0.0])
        let result = try await active.process(audio: samples)
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
