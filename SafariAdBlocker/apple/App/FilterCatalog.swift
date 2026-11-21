import Foundation

struct FilterList: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let description: String
    let category: String
    let url: String
    let mirrors: [String]?
    let homepage: String?
    let isDefault: Bool
    let trusted: Bool?
    let region: String?

    enum CodingKeys: String, CodingKey {
        case id, name, description, category, url, mirrors, homepage, trusted, region
        case isDefault = "default"
    }
}

struct FilterCatalog: Codable {
    let version: Int
    let lists: [FilterList]

    static func load() -> FilterCatalog {
        guard let url = Bundle.main.url(forResource: "catalog", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let catalog = try? JSONDecoder().decode(FilterCatalog.self, from: data) else {
            assertionFailure("catalog.json missing from the app bundle; run `npm run build` first")
            return FilterCatalog(version: 0, lists: [])
        }
        return catalog
    }

    var defaultIDs: Set<String> { Set(lists.filter(\.isDefault).map(\.id)) }

    struct Section: Identifiable {
        let title: String
        let lists: [FilterList]
        var id: String { title }
    }

    /// Sections shown in the Filters screen, in display order.
    var sections: [Section] {
        let order: [(String, (FilterList) -> Bool)] = [
            ("Ads", { $0.category == "ads" && $0.region == nil }),
            ("Privacy", { $0.category == "privacy" }),
            ("Security", { $0.category == "security" }),
            ("Annoyances", { $0.category == "annoyances" }),
            ("Social", { $0.category == "social" }),
            ("Regional", { $0.region != nil }),
        ]
        return order.compactMap { title, test in
            let matching = lists.filter(test)
            return matching.isEmpty ? nil : Section(title: title, lists: matching)
        }
    }
}

/// Mirrors build/report.json written by the compiler.
struct CompileReport: Codable {
    struct Stats: Codable {
        let lines: Int
        let contentBlockerRules: Int
        let webRules: Int
        let skipped: Int
    }

    struct Distribution: Codable {
        struct Slot: Codable { let total: Int }
        let slots: [String: Slot]
        let limit: Int
        let dropped: Int
    }

    struct Skip: Codable, Hashable {
        let reason: String
        let count: Int
        let examples: [String]
    }

    let builtAt: String
    let durationMs: Int
    let stats: Stats
    let distribution: Distribution
    let errors: [Skip]

    static func load() -> CompileReport? {
        guard let data = try? Data(contentsOf: Container.reportFile) else { return nil }
        return try? JSONDecoder().decode(CompileReport.self, from: data)
    }

    func rules(for slot: BlockerSlot) -> Int { distribution.slots[slot.rawValue]?.total ?? 0 }
}
