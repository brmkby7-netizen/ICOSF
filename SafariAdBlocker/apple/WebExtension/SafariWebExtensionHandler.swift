// Native side of the Bastion web extension. Answers messages sent with
// browser.runtime.sendNativeMessage from extension/background.js.

import Foundation
import SafariServices

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem
        let message = request?.userInfo?[SFExtensionMessageKey] as? [String: Any] ?? [:]

        handle(message) { response in
            let item = NSExtensionItem()
            item.userInfo = [SFExtensionMessageKey: response]
            context.completeRequest(returningItems: [item], completionHandler: nil)
        }
    }

    private func handle(_ message: [String: Any], reply: @escaping ([String: Any]) -> Void) {
        switch message["type"] as? String {
        case "getState":
            let state = SharedStore.load()
            let size = (try? FileManager.default.attributesOfItem(atPath: Container.webIndexFile.path)[.size] as? NSNumber)?.intValue ?? 0
            reply([
                "allowlist": state.allowlist,
                "webIndexVersion": state.webIndexVersion.map { $0 as Any } ?? NSNull(),
                "webIndexSize": size,
            ])

        case "getWebIndexChunk":
            // The index is ASCII-only (see compiler asciiJSON), so byte
            // offsets are character offsets on the JavaScript side.
            let offset = (message["offset"] as? NSNumber)?.uint64Value ?? 0
            let length = (message["length"] as? NSNumber)?.intValue ?? 0
            guard SharedStore.load().webIndexVersion == message["version"] as? String,
                  let handle = try? FileHandle(forReadingFrom: Container.webIndexFile) else {
                reply(["error": "stale"])
                return
            }
            defer { try? handle.close() }
            do {
                try handle.seek(toOffset: offset)
                let data = try handle.read(upToCount: max(0, length)) ?? Data()
                reply(["data": String(decoding: data, as: UTF8.self)])
            } catch {
                reply(["error": error.localizedDescription])
            }

        case "setAllowlist":
            let domains = (message["allowlist"] as? [String] ?? []).compactMap(Allowlist.normalize)
            SharedStore.update { $0.allowlist = Array(Set(domains)).sorted() }
            reloadContentBlockers { reply(["ok": true]) }

        case "addCustomRule":
            guard let rule = message["rule"] as? String, !rule.contains("\n") else {
                reply(["ok": false])
                return
            }
            SharedStore.update { state in
                var lines = state.customRules.components(separatedBy: "\n")
                if !lines.contains(rule) {
                    if lines.last == "" { lines.removeLast() }
                    lines.append(rule)
                    state.customRules = lines.joined(separator: "\n") + "\n"
                    state.needsRecompile = true
                }
            }
            reply(["ok": true])

        case "removeCustomRules":
            let rules = Set(message["rules"] as? [String] ?? [])
            SharedStore.update { state in
                let kept = state.customRules.components(separatedBy: "\n").filter { !rules.contains($0) }
                state.customRules = kept.joined(separator: "\n")
                state.needsRecompile = true
            }
            reply(["ok": true])

        default:
            reply(["error": "unknown message"])
        }
    }

    /// Reloading makes Safari ask each content blocker for its rules again,
    /// and the blockers append the updated allowlist when they answer.
    private func reloadContentBlockers(completion: @escaping () -> Void) {
        let group = DispatchGroup()
        for slot in BlockerSlot.allCases {
            group.enter()
            SFContentBlockerManager.reloadContentBlocker(withIdentifier: Bastion.blockerIdentifier(slot)) { error in
                if let error {
                    NSLog("Bastion: reloading \(slot.rawValue) failed: \(error.localizedDescription)")
                }
                group.leave()
            }
        }
        group.notify(queue: .global()) { completion() }
    }
}
