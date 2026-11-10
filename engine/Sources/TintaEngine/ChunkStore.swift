import CryptoKit
import Foundation

/// Audio chunk file layout:
/// - 4 bytes: magic "TNTC"
/// - 8 bytes: start sample index on the meeting clock (Int64, little endian, 16 kHz)
/// - 4 bytes: sample count (UInt32, little endian)
/// - rest: AES-GCM combined box (nonce, ciphertext, tag) of Int16 little-endian PCM
enum ChunkFormat {
    static let sampleRate = 16_000
    static let magic = Data("TNTC".utf8)
    static let chunkSamples = 5 * sampleRate
    /// The longest track that the reader accepts: 24 hours.
    static let maxTrackSamples = Int64(24 * 60 * 60 * sampleRate)
}

enum Track: String, CaseIterable {
    case mic
    case remote
}

final class ChunkWriter: @unchecked Sendable {
    private let directory: URL
    private let key: SymmetricKey
    private let track: Track
    private let lock = NSLock()
    private var buffer: [Int16] = []
    private var bufferStart: Int64 = 0
    private var nextIndex: Int64 = -1
    private var fileCounter = 0
    private var failedWrites = 0
    /// Receives a call when 2 chunk writes in sequence fail, for example on a full disk.
    var onFailure: (() -> Void)?

    init(directory: URL, key: SymmetricKey, track: Track) throws {
        self.directory = directory.appendingPathComponent("audio/\(track.rawValue)", isDirectory: true)
        self.key = key
        self.track = track
        try FileManager.default.createDirectory(at: self.directory, withIntermediateDirectories: true)
        // A new file gets an index after the highest index in the folder, so its name is always free.
        let existing = (try? FileManager.default.contentsOfDirectory(atPath: self.directory.path)) ?? []
        let highest = existing.compactMap { $0.hasSuffix(".tntc") ? Int($0.dropLast(5)) : nil }.max()
        fileCounter = (highest ?? -1) + 1
    }

    /// Appends samples that start at `startIndex` on the meeting clock.
    /// A jump of more than 100 ms starts a new chunk and leaves a gap.
    /// Samples that are early by 100 ms to 1 second come from a device clock that is faster than the
    /// meeting clock. The writer drops the early part, so the track stays on the meeting clock.
    func append(_ samples: [Float], startIndex: Int64) {
        lock.lock()
        defer { lock.unlock() }
        var samples = samples[...]
        var start = startIndex
        if nextIndex >= 0 {
            let drift = start - nextIndex
            let limit = Int64(ChunkFormat.sampleRate / 10)
            if drift > limit {
                flushLocked()
            } else {
                if drift < -limit && drift >= -Int64(ChunkFormat.sampleRate) {
                    samples = samples.dropFirst(Int(-drift))
                    if samples.isEmpty { return }
                }
                start = nextIndex
            }
        }
        if buffer.isEmpty { bufferStart = start }
        buffer.reserveCapacity(buffer.count + samples.count)
        for sample in samples {
            let clamped = max(-1, min(1, sample))
            buffer.append(Int16(clamped * Float(Int16.max)))
        }
        nextIndex = start + Int64(samples.count)
        if buffer.count >= ChunkFormat.chunkSamples {
            flushLocked()
        }
    }

    func flush() {
        lock.lock()
        defer { lock.unlock() }
        flushLocked()
    }

    private func flushLocked() {
        guard !buffer.isEmpty else { return }
        let pcm = buffer.withUnsafeBufferPointer { Data(buffer: $0) }
        do {
            let sealed = try AES.GCM.seal(pcm, using: key)
            guard let combined = sealed.combined else { throw EngineError("seal failed") }
            var file = ChunkFormat.magic
            var start = bufferStart.littleEndian
            var count = UInt32(buffer.count).littleEndian
            file.append(Data(bytes: &start, count: 8))
            file.append(Data(bytes: &count, count: 4))
            file.append(combined)
            let name = String(format: "%08d.tntc", fileCounter)
            let tmp = directory.appendingPathComponent(name + ".part")
            let url = directory.appendingPathComponent(name)
            try file.write(to: tmp, options: [.atomic])
            try FileManager.default.moveItem(at: tmp, to: url)
            fileCounter += 1
            failedWrites = 0
        } catch {
            Output.shared.event("error", ["message": "chunk write failed for \(track.rawValue): \(error)"])
            failedWrites += 1
            if failedWrites == 2 { onFailure?() }
        }
        buffer.removeAll(keepingCapacity: true)
    }
}

enum ChunkReader {
    struct Chunk {
        let start: Int64
        let samples: [Int16]
    }

    /// Reads the chunks of a track. A chunk that is damaged, for example after a power loss, does not
    /// stop the read: the result has the other chunks and the number of chunks that the reader skipped.
    /// The read fails only when no chunk of the track is readable.
    static func chunks(directory: URL, key: SymmetricKey, track: Track) throws -> (chunks: [Chunk], skipped: Int) {
        let trackDir = directory.appendingPathComponent("audio/\(track.rawValue)", isDirectory: true)
        guard FileManager.default.fileExists(atPath: trackDir.path) else { return ([], 0) }
        let names = try FileManager.default.contentsOfDirectory(atPath: trackDir.path)
            .filter { $0.hasSuffix(".tntc") }
            .sorted()
        var result: [Chunk] = []
        var skipped = 0
        for name in names {
            guard let chunk = read(trackDir.appendingPathComponent(name), key: key) else {
                Output.shared.log("skipped the unreadable chunk \(track.rawValue)/\(name)")
                skipped += 1
                continue
            }
            result.append(chunk)
        }
        if result.isEmpty && skipped > 0 {
            throw EngineError("Tinta cannot read the \(track.rawValue) audio of this meeting.")
        }
        return (result, skipped)
    }

    /// Reads one chunk file. Returns nil for a file that is not a complete chunk on the meeting clock.
    private static func read(_ url: URL, key: SymmetricKey) -> Chunk? {
        guard let data = try? Data(contentsOf: url), data.count > 16, data.prefix(4) == ChunkFormat.magic,
            let box = try? AES.GCM.SealedBox(combined: data.subdata(in: 16..<data.count)),
            let pcm = try? AES.GCM.open(box, using: key)
        else { return nil }
        let start = data.subdata(in: 4..<12).withUnsafeBytes { Int64(littleEndian: $0.loadUnaligned(as: Int64.self)) }
        let samples = pcm.withUnsafeBytes { raw in
            Array(raw.bindMemory(to: Int16.self))
        }
        // The start index is not encrypted. A damaged value must not move the chunk outside the track.
        guard start >= 0, start <= ChunkFormat.maxTrackSamples - Int64(samples.count) else { return nil }
        return Chunk(start: start, samples: samples)
    }

    /// Returns the full track on the meeting clock, and the number of chunks that the reader skipped.
    /// Gaps contain silence.
    static func track(directory: URL, key: SymmetricKey, track: Track) throws -> (samples: [Float], skipped: Int) {
        let (chunks, skipped) = try chunks(directory: directory, key: key, track: track)
        guard let end = chunks.map({ $0.start + Int64($0.samples.count) }).max() else { return ([], skipped) }
        var output = [Float](repeating: 0, count: Int(end))
        let scale = 1 / Float(Int16.max)
        for chunk in chunks {
            let offset = Int(chunk.start)
            for (index, sample) in chunk.samples.enumerated() where offset + index < output.count {
                output[offset + index] = Float(sample) * scale
            }
        }
        return (output, skipped)
    }

    static func wav(samples: [Float]) -> Data {
        var data = Data()
        let sampleRate = UInt32(ChunkFormat.sampleRate)
        let byteCount = UInt32(samples.count * 2)
        func append<T>(_ value: T) {
            withUnsafeBytes(of: value) { data.append(contentsOf: $0) }
        }
        data.append(Data("RIFF".utf8))
        append(UInt32(36 + byteCount).littleEndian)
        data.append(Data("WAVEfmt ".utf8))
        append(UInt32(16).littleEndian)
        append(UInt16(1).littleEndian)
        append(UInt16(1).littleEndian)
        append(sampleRate.littleEndian)
        append((sampleRate * 2).littleEndian)
        append(UInt16(2).littleEndian)
        append(UInt16(16).littleEndian)
        data.append(Data("data".utf8))
        append(byteCount.littleEndian)
        for sample in samples {
            append(Int16(max(-1, min(1, sample)) * Float(Int16.max)).littleEndian)
        }
        return data
    }
}
