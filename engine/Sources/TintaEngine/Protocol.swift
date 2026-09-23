import Foundation

/// Writes JSON lines to stdout. The app reads responses and events from this stream.
final class Output: @unchecked Sendable {
    static let shared = Output()
    private let lock = NSLock()

    func send(_ object: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(object),
            let data = try? JSONSerialization.data(withJSONObject: object, options: [])
        else {
            FileHandle.standardError.write(Data("invalid JSON output\n".utf8))
            return
        }
        lock.lock()
        defer { lock.unlock() }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }

    func event(_ name: String, _ fields: [String: Any] = [:]) {
        var object = fields
        object["event"] = name
        send(object)
    }

    func reply(_ id: Any, result: [String: Any]) {
        send(["id": id, "ok": true, "result": result])
    }

    func fail(_ id: Any, _ message: String) {
        send(["id": id, "ok": false, "error": message])
    }

    func log(_ message: String) {
        FileHandle.standardError.write(Data("[tinta-engine] \(message)\n".utf8))
    }
}

struct EngineError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

extension Dictionary where Key == String, Value == Any {
    func string(_ key: String) throws -> String {
        guard let value = self[key] as? String, !value.isEmpty else {
            throw EngineError("missing parameter: \(key)")
        }
        return value
    }

    func optionalString(_ key: String) -> String? {
        guard let value = self[key] as? String, !value.isEmpty else { return nil }
        return value
    }

    func double(_ key: String) throws -> Double {
        if let value = self[key] as? Double { return value }
        if let value = self[key] as? Int { return Double(value) }
        throw EngineError("missing parameter: \(key)")
    }

    func bool(_ key: String, default fallback: Bool) -> Bool {
        (self[key] as? Bool) ?? fallback
    }
}
