import SwiftUI

struct SetupGuideView: View {
    @EnvironmentObject private var model: AppModel

    private var steps: [String] {
        #if os(iOS)
        return [
            "Open the Settings app.",
            "Go to Apps › Safari › Extensions.",
            "Turn on all four Bastion content blockers.",
            "Turn on Bastion Advanced Blocking and set it to Allow on all websites.",
            "Come back here: the status above updates automatically.",
        ]
        #else
        return [
            "Open Safari › Settings › Extensions.",
            "Tick all four Bastion content blockers.",
            "Tick Bastion Advanced Blocking, then choose Always Allow on Every Website.",
            "Come back here: the status above updates automatically.",
        ]
        #endif
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text("\(index + 1)")
                        .font(.caption.weight(.bold))
                        .frame(width: 22, height: 22)
                        .background(Circle().fill(Color.bastionAccent.opacity(0.15)))
                        .foregroundStyle(Color.bastionAccent)
                    Text(step)
                }
            }
            #if os(macOS)
            Button("Open Safari Extension Settings") { model.openSafariExtensionSettings() }
                .buttonStyle(.borderedProminent)
                .padding(.top, 4)
            #endif
            Button("Check again") { Task { await model.refreshStatus() } }
                .padding(.top, 2)
        }
        .padding(.vertical, 4)
    }
}
