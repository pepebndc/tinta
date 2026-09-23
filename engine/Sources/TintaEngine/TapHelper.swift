import Foundation

/// Voice processing on the microphone silences a process tap in the same process.
/// The engine therefore runs the tap in a child process: `tinta-engine --tap-helper <source>`.
/// The helper writes binary frames to stdout:
/// - kind 0: host time (UInt64), sample count (UInt32), then Float32 samples at 16 kHz
/// - kind 1: capturing flag (UInt8), process count (UInt32)
/// All numbers are little endian. The helper stops when its stdin closes.
enum TapHelper {
    static func run(source: String) -> Never {
        let out = FileHandle.standardOutput
        let lock = NSLock()
        func write(_ data: Data) {
            lock.lock()
            defer { lock.unlock() }
            out.write(data)
        }
        let capture = ProcessTapCapture(
            source: source,
            handler: { samples, host in
                var frame = Data([0])
                var hostLE = host.littleEndian
                var count = UInt32(samples.count).littleEndian
                frame.append(Data(bytes: &hostLE, count: 8))
                frame.append(Data(bytes: &count, count: 4))
                samples.withUnsafeBufferPointer { frame.append(Data(buffer: $0)) }
                write(frame)
            },
            onState: { capturing, processes in
                var frame = Data([1, capturing ? 1 : 0])
                var count = UInt32(processes).littleEndian
                frame.append(Data(bytes: &count, count: 4))
                write(frame)
            })
        capture.start()
        var byte: UInt8 = 0
        while read(STDIN_FILENO, &byte, 1) > 0 {}
        capture.stop()
        exit(0)
    }
}

/// Runs the tap helper and reads its frames.
final class RemoteTap: @unchecked Sendable {
    private let source: String
    private let handler: SampleHandler
    private let process = Process()
    private let input = Pipe()
    private let output = Pipe()
    private(set) var isCapturing = false

    init(source: String, handler: @escaping SampleHandler) {
        self.source = source
        self.handler = handler
    }

    func start() throws {
        process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
        process.arguments = ["--tap-helper", source]
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.standardError
        try process.run()
        let reader = output.fileHandleForReading
        Thread { [weak self] in self?.read(reader) }.start()
    }

    private func read(_ reader: FileHandle) {
        var buffer = Data()
        func take(_ count: Int) -> Data? {
            while buffer.count < count {
                let chunk = reader.availableData
                if chunk.isEmpty { return nil }
                buffer.append(chunk)
            }
            let head = buffer.prefix(count)
            buffer.removeFirst(count)
            return Data(head)
        }
        while let kind = take(1)?.first {
            if kind == 0 {
                guard let header = take(12) else { return }
                let host = header.prefix(8).withUnsafeBytes { UInt64(littleEndian: $0.loadUnaligned(as: UInt64.self)) }
                let count = header.suffix(4).withUnsafeBytes { Int(UInt32(littleEndian: $0.loadUnaligned(as: UInt32.self))) }
                guard let body = take(count * 4) else { return }
                let samples = body.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
                handler(samples, host)
            } else {
                guard let state = take(5) else { return }
                isCapturing = state.first == 1
                let processes = state.suffix(4).withUnsafeBytes { Int(UInt32(littleEndian: $0.loadUnaligned(as: UInt32.self))) }
                Output.shared.event("source_state", ["capturing": isCapturing, "processes": processes])
            }
        }
    }

    func stop() {
        try? input.fileHandleForWriting.close()
        process.waitUntilExit()
    }
}
