// Downloads enabled filter lists, compiles them, installs the results in the
// App Group, and asks Safari to reload each content blocker. If Safari
// rejects a freshly compiled list, the previous one is restored.

import Foundation
import SafariServices

struct UpdateSummary {
    var downloaded: [String] = []
    var notModified: [String] = []
    var failed: [String] = []
    var rejectedSlots: [BlockerSlot] = []
    var report: CompileReport?
}

@MainActor
final class FilterUpdater {
    private let engine = CompilerEngine()
    private let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 45
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config)
    }()

    private struct ListSource {
        let id: String
        let urls: [String]
        let category: String
        let trusted: Bool
    }

    private struct CacheMeta: Codable {
        var etag: String?
        var lastModified: String?
        var fetchedAt: Date
    }

    /// - Parameter forceDownload: ignore cached copies younger than `maxAge`.
    func update(catalog: FilterCatalog, state: SharedState, forceDownload: Bool,
                progress: @escaping (String, Double) -> Void) async throws -> UpdateSummary {
        var summary = UpdateSummary()
        let enabled = state.enabledListIDs ?? catalog.defaultIDs
        var sources: [ListSource] = catalog.lists.filter { enabled.contains($0.id) }.map {
            ListSource(id: $0.id, urls: [$0.url] + ($0.mirrors ?? []), category: $0.category, trusted: $0.trusted ?? true)
        }
        sources += state.customLists.map {
            // Lists the user adds by URL are not trusted with trusted-* scriptlets.
            ListSource(id: $0.id, urls: [$0.url], category: $0.category, trusted: false)
        }

        // 1. Download (conditional requests; fall back to the cached copy).
        var inputs: [[String: Any]] = []
        for (index, source) in sources.enumerated() {
            progress("Downloading \(source.id)…", 0.05 + 0.45 * Double(index) / Double(max(1, sources.count)))
            if let result = await fetch(source, forceDownload: forceDownload) {
                let (text, fresh) = result
                if fresh { summary.downloaded.append(source.id) } else { summary.notModified.append(source.id) }
                inputs.append(["id": source.id, "text": text, "category": source.category, "trusted": source.trusted])
            } else {
                summary.failed.append(source.id)
            }
        }
        let custom = state.customRules.trimmingCharacters(in: .whitespacesAndNewlines)
        if !custom.isEmpty {
            inputs.append(["id": "user-rules", "text": custom, "category": "custom", "trusted": true])
        }

        // 2. Compile.
        progress("Compiling \(inputs.count) lists…", 0.55)
        let output = try await engine.compile(lists: inputs)
        engine.tearDown()

        // 3. Install, keeping a backup of what Safari accepted last time.
        progress("Installing rules…", 0.8)
        let fm = FileManager.default
        for slot in BlockerSlot.allCases {
            let target = Container.baseRules(slot)
            let backup = target.appendingPathExtension("previous")
            if fm.fileExists(atPath: target.path) {
                try? fm.removeItem(at: backup)
                try? fm.copyItem(at: target, to: backup)
            }
            let json = output.blockers[slot] ?? RuleAssembler.placeholderList
            try Data(json.utf8).write(to: target, options: .atomic)
        }
        try Data(output.webIndex.utf8).write(to: Container.webIndexFile, options: .atomic)
        try Data(output.report.utf8).write(to: Container.reportFile, options: .atomic)

        // 4. Reload Safari's content blockers; roll back any list Safari rejects.
        progress("Reloading Safari content blockers…", 0.9)
        for slot in BlockerSlot.allCases {
            if let error = await Self.reload(slot) {
                let enabled = await Self.isEnabled(slot)
                NSLog("Bastion: Safari rejected \(slot.rawValue) (enabled: \(enabled)): \(error.localizedDescription)")
                guard enabled else { continue }
                summary.rejectedSlots.append(slot)
                let target = Container.baseRules(slot)
                let backup = target.appendingPathExtension("previous")
                if fm.fileExists(atPath: backup.path) {
                    try? fm.removeItem(at: target)
                    try? fm.copyItem(at: backup, to: target)
                } else {
                    try? fm.removeItem(at: target) // fall back to the bundled defaults
                }
                _ = await Self.reload(slot)
            }
        }

        SharedStore.update { s in
            s.lastUpdated = Date()
            s.webIndexVersion = ISO8601DateFormatter().string(from: Date())
            s.needsRecompile = false
        }
        summary.report = CompileReport.load()
        progress("Done", 1)
        return summary
    }

    // MARK: Safari

    static func reload(_ slot: BlockerSlot) async -> Error? {
        await withCheckedContinuation { continuation in
            SFContentBlockerManager.reloadContentBlocker(withIdentifier: Bastion.blockerIdentifier(slot)) { error in
                continuation.resume(returning: error)
            }
        }
    }

    static func reloadAll() async {
        for slot in BlockerSlot.allCases { _ = await reload(slot) }
    }

    static func isEnabled(_ slot: BlockerSlot) async -> Bool {
        await withCheckedContinuation { continuation in
            SFContentBlockerManager.getStateOfContentBlocker(withIdentifier: Bastion.blockerIdentifier(slot)) { state, _ in
                continuation.resume(returning: state?.isEnabled ?? false)
            }
        }
    }

    // MARK: Downloads

    private func fetch(_ source: ListSource, forceDownload: Bool) async -> (String, Bool)? {
        let textURL = Container.lists.appendingPathComponent("\(source.id).txt")
        let metaURL = Container.lists.appendingPathComponent("\(source.id).meta.json")
        let cachedText = try? String(contentsOf: textURL, encoding: .utf8)
        let meta = (try? Data(contentsOf: metaURL)).flatMap { try? JSONDecoder().decode(CacheMeta.self, from: $0) }

        // Lists change at most a few times a day; avoid hammering servers.
        if !forceDownload, let cachedText, let meta, Date().timeIntervalSince(meta.fetchedAt) < 4 * 3600 {
            return (cachedText, false)
        }

        for (i, string) in source.urls.enumerated() {
            guard let url = URL(string: string) else { continue }
            var request = URLRequest(url: url)
            request.setValue("Bastion/1.0 (Safari content blocker)", forHTTPHeaderField: "User-Agent")
            if i == 0, cachedText != nil, let meta {
                if let etag = meta.etag { request.setValue(etag, forHTTPHeaderField: "If-None-Match") }
                if let lm = meta.lastModified { request.setValue(lm, forHTTPHeaderField: "If-Modified-Since") }
            }
            do {
                let (data, response) = try await session.data(for: request)
                guard let http = response as? HTTPURLResponse else { continue }
                if http.statusCode == 304, let cachedText {
                    saveMeta(CacheMeta(etag: meta?.etag, lastModified: meta?.lastModified, fetchedAt: Date()), to: metaURL)
                    return (cachedText, false)
                }
                guard http.statusCode == 200, let text = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .isoLatin1),
                      looksLikeFilterList(text) else { continue }
                try? text.write(to: textURL, atomically: true, encoding: .utf8)
                saveMeta(CacheMeta(etag: http.value(forHTTPHeaderField: "ETag"),
                                   lastModified: http.value(forHTTPHeaderField: "Last-Modified"),
                                   fetchedAt: Date()), to: metaURL)
                return (text, true)
            } catch {
                NSLog("Bastion: downloading \(source.id) from \(string) failed: \(error.localizedDescription)")
            }
        }
        if let cachedText { return (cachedText, false) }
        return nil
    }

    private func looksLikeFilterList(_ text: String) -> Bool {
        let head = text.prefix(512).trimmingCharacters(in: .whitespacesAndNewlines)
        return text.count > 50 && !head.hasPrefix("<")
    }

    private func saveMeta(_ meta: CacheMeta, to url: URL) {
        let encoder = JSONEncoder()
        if let data = try? encoder.encode(meta) { try? data.write(to: url, options: .atomic) }
    }
}
