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

    init(directory: URL, key: SymmetricKey, track: Track) throws {
        self.directory = directory.appendingPathComponent("audio/\(track.rawValue)", isDirectory: true)
        self.key = key
        self.track = track
        try FileManager.default.createDirectory(at: self.directory, withIntermediateDirectories: true)
        let existing = (try? FileManager.default.contentsOfDirectory(atPath: self.directory.path)) ?? []
        fileCounter = existing.count
    }

    /// Appends samples that start at `startIndex` on the meeting clock.
    /// A jump of more than 100 ms starts a new chunk and leaves a gap.
    func append(_ samples: [Float], startIndex: Int64) {
        lock.lock()
        defer { lock.unlock() }
        var start = startIndex
        if nextIndex >= 0 {
            let drift = start - nextIndex
            if drift > Int64(ChunkFormat.sampleRate / 10) {
                flushLocked()
            } else {
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
        } catch {
            Output.shared.event("error", ["message": "chunk write failed for \(track.rawValue): \(error)"])
        }
        buffer.removeAll(keepingCapacity: true)
    }
}

enum ChunkReader {
    struct Chunk {
        let start: Int64
        let samples: [Int16]
    }

    static func chunks(directory: URL, key: SymmetricKey, track: Track) throws -> [Chunk] {
        let trackDir = directory.appendingPathComponent("audio/\(track.rawValue)", isDirectory: true)
        guard FileManager.default.fileExists(atPath: trackDir.path) else { return [] }
        let names = try FileManager.default.contentsOfDirectory(atPath: trackDir.path)
            .filter { $0.hasSuffix(".tntc") }
            .sorted()
        var result: [Chunk] = []
        for name in names {
            let data = try Data(contentsOf: trackDir.appendingPathComponent(name))
            guard data.count > 16, data.prefix(4) == ChunkFormat.magic else {
                throw EngineError("invalid chunk \(name)")
            }
            let start = data.subdata(in: 4..<12).withUnsafeBytes { Int64(littleEndian: $0.loadUnaligned(as: Int64.self)) }
            let box = try AES.GCM.SealedBox(combined: data.subdata(in: 16..<data.count))
            let pcm = try AES.GCM.open(box, using: key)
            let samples = pcm.withUnsafeBytes { raw in
                Array(raw.bindMemory(to: Int16.self))
            }
            result.append(Chunk(start: start, samples: samples))
        }
        return result
    }

    /// Returns the full track on the meeting clock. Gaps contain silence.
    static func track(directory: URL, key: SymmetricKey, track: Track) throws -> [Float] {
        let chunks = try chunks(directory: directory, key: key, track: track)
        guard let end = chunks.map({ $0.start + Int64($0.samples.count) }).max() else { return [] }
        var output = [Float](repeating: 0, count: Int(end))
        let scale = 1 / Float(Int16.max)
        for chunk in chunks {
            let offset = Int(chunk.start)
            for (index, sample) in chunk.samples.enumerated() where offset + index < output.count {
                output[offset + index] = Float(sample) * scale
            }
        }
        return output
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
