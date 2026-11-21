// Code shared by the Bastion app and all of its extensions: identifiers, the
// App Group container layout, persisted settings, and assembly of the final
// rule list each content blocker hands to Safari.

import Foundation

/// One Safari content-blocker extension. Safari caps each at 150,000 rules,
/// so Bastion spreads its rules over four of them.
public enum BlockerSlot: String, CaseIterable, Codable, Identifiable, Sendable {
    case ads, privacy, annoyances, extra

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .ads: return "Ads"
        case .privacy: return "Privacy & Security"
        case .annoyances: return "Annoyances"
        case .extra: return "Custom & Overflow"
        }
    }

    /// Suffix of the extension's bundle identifier.
    public var bundleSuffix: String {
        switch self {
        case .ads: return "ContentBlocker.Ads"
        case .privacy: return "ContentBlocker.Privacy"
        case .annoyances: return "ContentBlocker.Annoyances"
        case .extra: return "ContentBlocker.Extra"
        }
    }
}

public enum Bastion {
    /// Main app bundle id, from the BastionAppBundleIdentifier Info.plist key
    /// (set by the BASTION_APP_BUNDLE_ID build setting in every target).
    public static var appBundleIdentifier: String {
        (Bundle.main.object(forInfoDictionaryKey: "BastionAppBundleIdentifier") as? String) ?? "app.bastion.Bastion"
    }

    public static var appGroupIdentifier: String {
        (Bundle.main.object(forInfoDictionaryKey: "BastionAppGroup") as? String) ?? "group.app.bastion.Bastion"
    }

    public static func blockerIdentifier(_ slot: BlockerSlot) -> String {
        appBundleIdentifier + "." + slot.bundleSuffix
    }

    public static var webExtensionIdentifier: String {
        appBundleIdentifier + ".WebExtension"
    }
}

// MARK: - Container layout

public enum Container {
    public static var root: URL {
        if let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: Bastion.appGroupIdentifier) {
            return url
        }
        // Unsigned development builds have no App Group; keep working locally.
        let fallback = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Bastion", isDirectory: true)
        try? FileManager.default.createDirectory(at: fallback, withIntermediateDirectories: true)
        return fallback
    }

    static func directory(_ name: String) -> URL {
        let url = root.appendingPathComponent(name, isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    public static var rules: URL { directory("Rules") }
    public static var lists: URL { directory("Lists") }

    public static var stateFile: URL { root.appendingPathComponent("state.json") }
    public static var reportFile: URL { rules.appendingPathComponent("report.json") }
    public static var webIndexFile: URL { rules.appendingPathComponent("web-index.json") }

    /// Compiled rules for a slot, written by the app.
    public static func baseRules(_ slot: BlockerSlot) -> URL {
        rules.appendingPathComponent("\(slot.rawValue).json")
    }

    /// Base rules + allowlist, assembled by the content blocker on load.
    public static func assembledRules(_ slot: BlockerSlot) -> URL {
        rules.appendingPathComponent("\(slot.rawValue).assembled.json")
    }
}

// MARK: - Shared state

/// Settings shared between the app and its extensions (state.json in the App Group).
public struct SharedState: Codable, Equatable, Sendable {
    public struct CustomList: Codable, Equatable, Hashable, Identifiable, Sendable {
        public var id: String
        public var name: String
        public var url: String
        public var category: String

        public init(id: String = "custom-" + UUID().uuidString.prefix(8).lowercased(), name: String, url: String, category: String = "ads") {
            self.id = id
            self.name = name
            self.url = url
            self.category = category
        }
    }

    /// nil until first launch picks the catalog defaults.
    public var enabledListIDs: Set<String>?
    public var customLists: [CustomList] = []
    /// User-written filters (ABP/uBO syntax), compiled into the "extra" slot.
    public var customRules: String = ""
    /// Sites where Bastion is paused (registrable domains, lowercase).
    public var allowlist: [String] = []
    public var autoUpdate: Bool = true
    public var lastUpdated: Date?
    public var webIndexVersion: String?
    /// Set by the web extension when custom rules changed and the app should recompile.
    public var needsRecompile: Bool = false

    public init() {}

    enum CodingKeys: String, CodingKey {
        case enabledListIDs, customLists, customRules, allowlist, autoUpdate, lastUpdated, webIndexVersion, needsRecompile
    }

    // Tolerant decoding so older/newer state files never fail to load.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabledListIDs = try c.decodeIfPresent(Set<String>.self, forKey: .enabledListIDs)
        customLists = (try? c.decodeIfPresent([CustomList].self, forKey: .customLists)) ?? []
        customRules = (try? c.decodeIfPresent(String.self, forKey: .customRules)) ?? ""
        allowlist = (try? c.decodeIfPresent([String].self, forKey: .allowlist)) ?? []
        autoUpdate = (try? c.decodeIfPresent(Bool.self, forKey: .autoUpdate)) ?? true
        lastUpdated = try? c.decodeIfPresent(Date.self, forKey: .lastUpdated)
        webIndexVersion = try? c.decodeIfPresent(String.self, forKey: .webIndexVersion)
        needsRecompile = (try? c.decodeIfPresent(Bool.self, forKey: .needsRecompile)) ?? false
    }
}

public enum SharedStore {
    private static let lock = NSLock()

    public static func load() -> SharedState {
        lock.lock()
        defer { lock.unlock() }
        return readUnlocked()
    }

    public static func save(_ state: SharedState) {
        lock.lock()
        defer { lock.unlock() }
        writeUnlocked(state)
    }

    /// Read-modify-write. Coordinated so the app and extensions don't clobber each other.
    @discardableResult
    public static func update(_ change: (inout SharedState) -> Void) -> SharedState {
        lock.lock()
        defer { lock.unlock() }
        var result = SharedState()
        var ran = false
        let coordinator = NSFileCoordinator()
        var error: NSError?
        coordinator.coordinate(writingItemAt: Container.stateFile, options: .forMerging, error: &error) { _ in
            var state = readUnlocked()
            change(&state)
            writeUnlocked(state)
            result = state
            ran = true
        }
        if !ran {
            var state = readUnlocked()
            change(&state)
            writeUnlocked(state)
            result = state
        }
        return result
    }

    private static func readUnlocked() -> SharedState {
        guard let data = try? Data(contentsOf: Container.stateFile) else { return SharedState() }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return (try? decoder.decode(SharedState.self, from: data)) ?? SharedState()
    }

    private static func writeUnlocked(_ state: SharedState) {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(state) else { return }
        try? data.write(to: Container.stateFile, options: .atomic)
    }
}

// MARK: - Allowlist & rule assembly

public enum Allowlist {
    /// Normalizes user input ("https://www.Example.com/path") to "example.com".
    public static func normalize(_ input: String) -> String? {
        var s = input.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if let url = URL(string: s), let host = url.host { s = host }
        if let slash = s.firstIndex(of: "/") { s = String(s[..<slash]) }
        if s.hasPrefix("www.") { s.removeFirst(4) }
        if s.hasPrefix("*.") { s.removeFirst(2) }
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789.-")
        guard !s.isEmpty, s.contains("."), s.unicodeScalars.allSatisfy({ allowed.contains($0) }) else {
            // Internationalized domains: let the URL machinery punycode them.
            if let url = URL(string: "https://\(s)"), let host = url.host, host.contains(".") { return host }
            return nil
        }
        return s
    }

    /// The rule appended last to every content blocker: it cancels everything
    /// before it on allowlisted sites.
    public static func ruleJSON(for domains: [String]) -> String? {
        let clean = Array(Set(domains.compactMap { normalize($0) })).sorted()
        guard !clean.isEmpty else { return nil }
        let rule: [String: Any] = [
            "trigger": ["url-filter": ".*", "if-domain": clean.map { "*" + $0 }],
            "action": ["type": "ignore-previous-rules"],
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: rule, options: [.sortedKeys]) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

public enum RuleAssembler {
    /// A rule that can never match, for slots with nothing to block (Safari
    /// rejects an empty rule list).
    public static let placeholderList = #"[{"trigger":{"url-filter":"^bastion-placeholder:"},"action":{"type":"block"}}]"#

    /// Produces the file a content blocker returns to Safari: the compiled
    /// rules (or the bundled defaults) with the allowlist rule appended.
    /// Streams the file so the extension stays far below its memory limit.
    public static func assemble(slot: BlockerSlot, bundled: URL?, allowlist: [String]) throws -> URL {
        let fm = FileManager.default
        let compiled = Container.baseRules(slot)
        let base: URL
        if fm.fileExists(atPath: compiled.path) {
            base = compiled
        } else if let bundled, fm.fileExists(atPath: bundled.path) {
            base = bundled
        } else {
            let placeholder = Container.rules.appendingPathComponent("placeholder.json")
            try placeholderList.write(to: placeholder, atomically: true, encoding: .utf8)
            base = placeholder
        }

        guard let extra = Allowlist.ruleJSON(for: allowlist) else { return base }

        let out = Container.assembledRules(slot)
        let tmp = out.appendingPathExtension("tmp")
        try copy(base, to: tmp, appendingRule: extra)
        if fm.fileExists(atPath: out.path) { try fm.removeItem(at: out) }
        try fm.moveItem(at: tmp, to: out)
        return out
    }

    /// Copies a JSON array file, inserting `rule` as its last element.
    private static func copy(_ base: URL, to destination: URL, appendingRule rule: String) throws {
        FileManager.default.createFile(atPath: destination.path, contents: nil)
        let reader = try FileHandle(forReadingFrom: base)
        defer { try? reader.close() }
        let writer = try FileHandle(forWritingTo: destination)
        defer { try? writer.close() }

        // Find the closing bracket of the top-level array.
        let size = try reader.seekToEnd()
        var closing: UInt64?
        var tailStart: UInt64 = size > 64 ? size - 64 : 0
        while closing == nil {
            try reader.seek(toOffset: tailStart)
            let tail = try reader.readToEnd() ?? Data()
            if let idx = tail.lastIndex(of: UInt8(ascii: "]")) {
                closing = tailStart + UInt64(tail.distance(from: tail.startIndex, to: idx))
            } else if tailStart == 0 {
                throw CocoaError(.fileReadCorruptFile)
            } else {
                tailStart = tailStart > 4096 ? tailStart - 4096 : 0
            }
        }
        let end = closing ?? 0

        // Is the array empty? Look at the last non-whitespace byte before "]".
        var isEmpty = false
        var probe = end
        let whitespace: Set<UInt8> = [0x20, 0x0A, 0x0D, 0x09]
        while probe > 0 {
            probe -= 1
            try reader.seek(toOffset: probe)
            guard let byte = try reader.read(upToCount: 1)?.first else { break }
            if whitespace.contains(byte) { continue }
            isEmpty = byte == UInt8(ascii: "[")
            break
        }

        try reader.seek(toOffset: 0)
        var remaining = end
        while remaining > 0 {
            let n = Int(min(UInt64(1 << 20), remaining))
            guard let data = try reader.read(upToCount: n), !data.isEmpty else { break }
            try writer.write(contentsOf: data)
            remaining -= UInt64(data.count)
        }
        try writer.write(contentsOf: Data(((isEmpty ? "" : ",") + rule + "]").utf8))
    }
}
