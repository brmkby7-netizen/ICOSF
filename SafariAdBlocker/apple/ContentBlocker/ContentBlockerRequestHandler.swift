// Shared by the four content-blocker extensions. Each target sets the
// BastionSlot Info.plist key and bundles its default blockerList.json.

import Foundation

final class ContentBlockerRequestHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let slotName = Bundle.main.object(forInfoDictionaryKey: "BastionSlot") as? String ?? ""
        let slot = BlockerSlot(rawValue: slotName) ?? .ads
        let bundled = Bundle.main.url(forResource: "blockerList", withExtension: "json")

        let url: URL
        do {
            url = try RuleAssembler.assemble(slot: slot, bundled: bundled, allowlist: SharedStore.load().allowlist)
        } catch {
            NSLog("Bastion[\(slotName)]: assembling rules failed: \(error.localizedDescription)")
            url = bundled ?? Container.baseRules(slot)
        }

        let item = NSExtensionItem()
        if let attachment = NSItemProvider(contentsOf: url) {
            item.attachments = [attachment]
        }
        context.completeRequest(returningItems: [item], completionHandler: nil)
    }
}
