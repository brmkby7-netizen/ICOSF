import Foundation
import SafariServices
#if os(macOS)
import AppKit
#endif

@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()

    let catalog = FilterCatalog.load()

    @Published private(set) var state: SharedState
    @Published private(set) var blockerEnabled: [BlockerSlot: Bool] = [:]
    /// nil where the platform cannot tell (iOS).
    @Published private(set) var webExtensionEnabled: Bool?
    @Published private(set) var isUpdating = false
    @Published private(set) var progressText = ""
    @Published private(set) var progress: Double = 0
    @Published private(set) var report: CompileReport? = CompileReport.load()
    @Published private(set) var lastSummary: UpdateSummary?
    @Published var errorMessage: String?

    private let updater = FilterUpdater()
    private var pendingApply: Task<Void, Never>?

    private init() {
        var state = SharedStore.load()
        if state.enabledListIDs == nil {
            state.enabledListIDs = FilterCatalog.load().defaultIDs
            SharedStore.save(state)
        }
        self.state = state
    }

    // MARK: Status

    var allBlockersEnabled: Bool {
        BlockerSlot.allCases.allSatisfy { blockerEnabled[$0] == true }
    }

    var enabledBlockerCount: Int {
        BlockerSlot.allCases.filter { blockerEnabled[$0] == true }.count
    }

    var totalRules: Int { report?.stats.contentBlockerRules ?? 0 }

    var isStale: Bool {
        guard let last = state.lastUpdated else { return true }
        return state.needsRecompile || Date().timeIntervalSince(last) > 24 * 3600
    }

    func refreshStatus() async {
        state = SharedStore.load() // pick up changes made from the Safari extension
        var enabled: [BlockerSlot: Bool] = [:]
        for slot in BlockerSlot.allCases {
            enabled[slot] = await FilterUpdater.isEnabled(slot)
        }
        blockerEnabled = enabled
        #if os(macOS)
        webExtensionEnabled = await withCheckedContinuation { continuation in
            SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: Bastion.webExtensionIdentifier) { state, _ in
                continuation.resume(returning: state?.isEnabled ?? false)
            }
        }
        #endif
    }

    // MARK: Updating

    func updateIfNeeded() async {
        if state.autoUpdate, isStale { await updateFilters(forceDownload: false) }
    }

    func updateFilters(forceDownload: Bool) async {
        guard !isUpdating else { return }
        isUpdating = true
        errorMessage = nil
        progress = 0
        defer {
            isUpdating = false
            progressText = ""
        }
        do {
            let summary = try await updater.update(catalog: catalog, state: state, forceDownload: forceDownload) { [weak self] text, value in
                self?.progressText = text
                self?.progress = value
            }
            lastSummary = summary
            report = summary.report
            state = SharedStore.load()
            if !summary.rejectedSlots.isEmpty {
                errorMessage = "Safari rejected the new rules for \(summary.rejectedSlots.map(\.displayName).joined(separator: ", ")); the previous rules were kept."
            } else if !summary.failed.isEmpty {
                errorMessage = "Couldn't download: \(summary.failed.joined(separator: ", ")). Cached copies were used where available."
            }
        } catch {
            errorMessage = error.localizedDescription
        }
        await refreshStatus()
    }

    /// Recompiles shortly after the last change, so toggling several lists
    /// in a row triggers one rebuild.
    private func scheduleApply() {
        pendingApply?.cancel()
        pendingApply = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            guard !Task.isCancelled else { return }
            await self?.updateFilters(forceDownload: false)
        }
    }

    // MARK: Filter lists

    func isEnabled(_ list: FilterList) -> Bool {
        state.enabledListIDs?.contains(list.id) ?? list.isDefault
    }

    func setList(_ list: FilterList, enabled: Bool) {
        state = SharedStore.update { s in
            var ids = s.enabledListIDs ?? catalog.defaultIDs
            if enabled { ids.insert(list.id) } else { ids.remove(list.id) }
            s.enabledListIDs = ids
        }
        scheduleApply()
    }

    func addCustomList(name: String, url: String, category: String) -> Bool {
        guard let parsed = URL(string: url.trimmingCharacters(in: .whitespaces)),
              let scheme = parsed.scheme?.lowercased(), scheme == "https" || scheme == "http" else { return false }
        let list = SharedState.CustomList(name: name.isEmpty ? (parsed.host ?? "Custom list") : name, url: parsed.absoluteString, category: category)
        state = SharedStore.update { $0.customLists.append(list) }
        scheduleApply()
        return true
    }

    func removeCustomLists(at offsets: IndexSet) {
        let ids = offsets.map { state.customLists[$0].id }
        state = SharedStore.update { s in s.customLists.removeAll { ids.contains($0.id) } }
        scheduleApply()
    }

    // MARK: Allowlist (no recompile needed: blockers append it on reload)

    @discardableResult
    func addToAllowlist(_ input: String) -> Bool {
        guard let domain = Allowlist.normalize(input) else { return false }
        state = SharedStore.update { s in
            s.allowlist = Array(Set(s.allowlist + [domain])).sorted()
        }
        Task { await FilterUpdater.reloadAll() }
        return true
    }

    func removeFromAllowlist(at offsets: IndexSet) {
        let removed = offsets.map { state.allowlist[$0] }
        state = SharedStore.update { s in s.allowlist.removeAll { removed.contains($0) } }
        Task { await FilterUpdater.reloadAll() }
    }

    // MARK: Custom rules & settings

    func saveCustomRules(_ text: String) {
        state = SharedStore.update { $0.customRules = text }
        Task { await updateFilters(forceDownload: false) }
    }

    func setAutoUpdate(_ on: Bool) {
        state = SharedStore.update { $0.autoUpdate = on }
    }

    #if os(macOS)
    func openSafariExtensionSettings() {
        SFSafariApplication.showPreferencesForExtension(withIdentifier: Bastion.blockerIdentifier(.ads)) { error in
            if let error { NSLog("Bastion: could not open Safari settings: \(error.localizedDescription)") }
        }
    }
    #endif
}
