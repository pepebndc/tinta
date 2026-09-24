import AppKit
import ApplicationServices
import Foundation

/// The state of a desktop app call, read from the Accessibility tree of the app.
struct CallSnapshot: Equatable {
    struct Participant: Equatable {
        let name: String
        let isSelf: Bool
    }

    var participants: [Participant] = []
    /// The names of the participants that the app marks as the active speaker.
    var speaking: [String] = []
    /// The microphone state in the app. `nil` when the app does not show it.
    var micMuted: Bool?

    var json: [String: Any] {
        var result: [String: Any] = [
            "participants": participants.map { ["id": $0.name, "name": $0.name, "is_self": $0.isSelf] },
            "speaking": speaking,
        ]
        result["mic_muted"] = micMuted.map { $0 as Any } ?? NSNull()
        return result
    }
}

/// A node of the Accessibility tree. Some apps have cycles in the tree, so a walk
/// visits each element once.
struct AXNode: Hashable {
    let element: AXUIElement

    static func == (a: AXNode, b: AXNode) -> Bool { CFEqual(a.element, b.element) }
    func hash(into hasher: inout Hasher) { hasher.combine(CFHash(element)) }

    func value(_ attribute: String) -> AnyObject? {
        var value: AnyObject?
        return AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success ? value : nil
    }

    func string(_ attribute: String) -> String { (value(attribute) as? String) ?? "" }
    var role: String { string(kAXRoleAttribute) }
    var title: String { string(kAXTitleAttribute) }
    var label: String { string(kAXDescriptionAttribute) }
    var text: String { string(kAXValueAttribute) }
    var identifier: String { string(kAXIdentifierAttribute) }
    var domIdentifier: String { string("AXDOMIdentifier") }

    var children: [AXNode] { ((value(kAXChildrenAttribute) as? [AXUIElement]) ?? []).map(AXNode.init) }
    var windows: [AXNode] { ((value(kAXWindowsAttribute) as? [AXUIElement]) ?? []).map(AXNode.init) }
    var menuBar: AXNode? { value(kAXMenuBarAttribute).map { AXNode(element: $0 as! AXUIElement) } }

    /// Visits the node and its descendants, depth first, with limits for large trees.
    func walk(maxDepth: Int = 60, maxNodes: Int = 5000, _ visit: (AXNode, Int) -> Void) {
        var seen = Set<AXNode>()
        func step(_ node: AXNode, _ depth: Int) {
            guard depth <= maxDepth, seen.count < maxNodes, seen.insert(node).inserted else { return }
            visit(node, depth)
            for child in node.children { step(child, depth + 1) }
        }
        step(self, 0)
    }

    /// The application element of a running app, with a short timeout, so a busy app does not block the engine.
    static func app(bundleID: String) -> AXNode? {
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first else { return nil }
        let element = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(element, 0.5)
        return AXNode(element: element)
    }
}

enum CallReader {
    static var trusted: Bool { AXIsProcessTrusted() }

    /// Asks macOS to show the Accessibility permission request, and returns the current state.
    static func requestTrust() -> Bool {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    static func read(appID: String) -> CallSnapshot? {
        guard trusted, let app = AXNode.app(bundleID: appID) else { return nil }
        switch appID {
        case "us.zoom.xos": return ZoomReader.read(app)
        case "com.microsoft.teams2": return TeamsReader.read(app)
        default: return nil
        }
    }

    /// A text dump of the app windows and menus, for a diagnostic report that the user saves.
    static func dump(appID: String) -> String? {
        guard trusted, let app = AXNode.app(bundleID: appID) else { return nil }
        var lines: [String] = []
        for root in app.windows + [app.menuBar].compactMap({ $0 }) {
            root.walk { node, depth in
                let fields = [
                    ("role", node.role), ("subrole", node.string(kAXSubroleAttribute)), ("title", node.title),
                    ("description", node.label), ("value", node.text), ("help", node.string(kAXHelpAttribute)),
                    ("id", node.identifier), ("dom-id", node.domIdentifier),
                ]
                let text = fields.filter { !$0.1.isEmpty }.map { "\($0.0)=\"\($0.1.prefix(200))\"" }
                lines.append(String(repeating: " ", count: depth) + text.joined(separator: " "))
            }
        }
        return lines.joined(separator: "\n")
    }

    /// Words that mark the active speaker or a muted microphone. Apps translate their labels,
    /// so the lists hold English and Spanish.
    static let speakingWords = ["active speaker", "orador activo", "hablante activo", "speaking", "hablando"]
    static let unmutePrefixes = ["unmute", "turn on mic", "activar", "reactivar", "dejar de silenciar"]

    static func mentionsSpeaking(_ label: String) -> Bool {
        let lower = label.lowercased()
        return speakingWords.contains { lower.contains($0) }
    }

    /// True when a mute control offers to unmute, so the microphone is muted.
    static func offersUnmute(_ label: String) -> Bool {
        let lower = label.lowercased().trimmingCharacters(in: .whitespaces)
        return unmutePrefixes.contains { lower.hasPrefix($0) }
    }

    /// Removes a role suffix such as " (Host, me)" or " (Guest)" from a participant name.
    static func baseName(_ text: String) -> String {
        var name = text.trimmingCharacters(in: .whitespaces)
        if name.hasSuffix(")"), let open = name.lastIndex(of: "(") {
            name = String(name[..<open]).trimmingCharacters(in: .whitespaces)
        }
        return name
    }
}

/// Zoom Workplace. Each video tile is an AXTabGroup with a label such as
/// "Name, Computer audio unmuted, Video off, active speaker". The participants panel is an
/// AXOutline with one row per participant, such as "Name (Host, me)". The Meeting menu item
/// `onMuteAudio:` says "Mute audio" or "Unmute audio".
enum ZoomReader {
    static func read(_ app: AXNode) -> CallSnapshot? {
        let windows = app.windows
        guard let meeting = windows.first(where: isMeetingWindow) else { return nil }
        var snapshot = CallSnapshot()
        var names: [String] = []
        var selfNames = Set<String>()
        var speaking: [String] = []
        meeting.walk { node, _ in
            switch node.role {
            case "AXTabGroup":
                let label = node.label
                guard let name = tileName(label) else { return }
                if !names.contains(name) { names.append(name) }
                if CallReader.mentionsSpeaking(label), !speaking.contains(name) { speaking.append(name) }
            case "AXCell":
                guard let row = node.children.first(where: { $0.role == "AXStaticText" })?.text, !row.isEmpty else { return }
                let name = CallReader.baseName(row)
                if !names.contains(name) { names.append(name) }
                if isSelfRow(row) { selfNames.insert(name) }
            default:
                break
            }
        }
        if let own = ownName(windows) { selfNames.insert(own) }
        snapshot.participants = names.map { .init(name: $0, isSelf: selfNames.contains($0)) }
        snapshot.speaking = speaking
        snapshot.micMuted = micMuted(app)
        return snapshot
    }

    /// The meeting window. Its title is "Zoom Meeting", or a meeting topic, and it holds video tiles.
    private static func isMeetingWindow(_ window: AXNode) -> Bool {
        if window.title.localizedCaseInsensitiveContains("Zoom Workplace") { return false }
        return window.children.contains { $0.role == "AXTabGroup" }
            || window.title.localizedCaseInsensitiveContains("meeting")
            || window.title.localizedCaseInsensitiveContains("reunión")
    }

    /// The participant name of a tile label: the text before the first comma.
    static func tileName(_ label: String) -> String? {
        let name = label.split(separator: ",", maxSplits: 1).first.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
        return name.isEmpty ? nil : name
    }

    /// A participants row marks the user as "(me)", "(Host, me)", or "(yo)".
    static func isSelfRow(_ row: String) -> Bool {
        guard row.hasSuffix(")"), let open = row.lastIndex(of: "(") else { return false }
        let roles = row[row.index(after: open)..<row.index(before: row.endIndex)]
            .split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
        return roles.contains("me") || roles.contains("yo")
    }

    /// The main window shows the signed-in user in a button labeled "Zoom, Name, Status, Account".
    private static func ownName(_ windows: [AXNode]) -> String? {
        guard let main = windows.first(where: { $0.title.localizedCaseInsensitiveContains("Zoom Workplace") }) else { return nil }
        for child in main.children where child.role == "AXButton" && child.label.hasPrefix("Zoom, ") {
            let parts = child.label.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
            if parts.count >= 2, !parts[1].isEmpty { return parts[1] }
        }
        return nil
    }

    private static func micMuted(_ app: AXNode) -> Bool? {
        var result: Bool?
        app.menuBar?.walk(maxDepth: 3) { node, _ in
            if result == nil, node.role == "AXMenuItem", node.identifier == "onMuteAudio:" {
                result = CallReader.offersUnmute(node.title)
            }
        }
        return result
    }
}

/// Microsoft Teams. The app shows the call in web content, so the tree holds DOM identifiers
/// and ARIA labels. The microphone button has the DOM ID "microphone-button". Participant
/// tiles and roster items have labels that start with the participant name. The labels of
/// Teams change often, so this reader is a best effort.
enum TeamsReader {
    static func read(_ app: AXNode) -> CallSnapshot? {
        var snapshot = CallSnapshot()
        var names: [String] = []
        var speaking: [String] = []
        var muted: Bool?
        var found = false
        for window in app.windows {
            window.walk(maxNodes: 8000) { node, _ in
                let dom = node.domIdentifier
                let label = node.label.isEmpty ? node.title : node.label
                if dom == "microphone-button" || dom == "mic-button" {
                    found = true
                    muted = CallReader.offersUnmute(label)
                    return
                }
                if dom.hasPrefix("roster") || dom.hasPrefix("participant") || dom.contains("video-tile") {
                    found = true
                }
                guard isParticipantLabel(node, label), let name = ZoomReader.tileName(label) else { return }
                if !names.contains(name) { names.append(name) }
                if CallReader.mentionsSpeaking(label), !speaking.contains(name) { speaking.append(name) }
            }
        }
        guard found || muted != nil else { return nil }
        snapshot.participants = names.map { .init(name: $0, isSelf: false) }
        snapshot.speaking = speaking
        snapshot.micMuted = muted
        return snapshot
    }

    /// Tiles and roster items have labels such as "Name, Muted, Video off" or "Name, speaking".
    private static func isParticipantLabel(_ node: AXNode, _ label: String) -> Bool {
        guard ["AXGroup", "AXListItem", "AXCell", "AXRow", "AXButton"].contains(node.role) else { return false }
        let lower = label.lowercased()
        let states = ["muted", "unmuted", "video", "camera", "speaking", "silenciado", "cámara", "vídeo", "hablando"]
        return label.contains(",") && states.contains { lower.contains($0) }
    }
}
