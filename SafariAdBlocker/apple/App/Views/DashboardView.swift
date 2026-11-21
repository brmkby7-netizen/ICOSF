import SwiftUI

struct DashboardView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    StatusHeader()
                }

                if !model.allBlockersEnabled {
                    Section("Finish setup") {
                        SetupGuideView()
                    }
                }

                Section {
                    ForEach(BlockerSlot.allCases) { slot in
                        HStack {
                            Image(systemName: model.blockerEnabled[slot] == true ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(model.blockerEnabled[slot] == true ? Color.green : Color.secondary)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Bastion \(slot.displayName)")
                                Text(model.blockerEnabled[slot] == true ? "On" : "Off in Safari settings")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            if let report = model.report {
                                Text("\(report.rules(for: slot).grouped) rules")
                                    .font(.callout.monospacedDigit())
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                } header: {
                    Text("Content blockers")
                } footer: {
                    Text("Safari allows 150,000 rules per content blocker, so Bastion spreads its rules over four of them. Turn all four on.")
                }

                Section {
                    LabeledContent("Last updated") {
                        if let date = model.state.lastUpdated {
                            Text(date, style: .relative) + Text(" ago")
                        } else {
                            Text("Using built-in rules")
                        }
                    }
                    if let report = model.report {
                        LabeledContent("Safari rules", value: report.stats.contentBlockerRules.grouped)
                        LabeledContent("Advanced rules", value: report.stats.webRules.grouped)
                    }
                    if model.isUpdating {
                        VStack(alignment: .leading, spacing: 6) {
                            ProgressView(value: model.progress)
                            Text(model.progressText).font(.caption).foregroundStyle(.secondary)
                        }
                    } else {
                        Button {
                            Task { await model.updateFilters(forceDownload: true) }
                        } label: {
                            Label("Update filters now", systemImage: "arrow.clockwise")
                        }
                    }
                    if let message = model.errorMessage {
                        Label(message, systemImage: "exclamationmark.triangle.fill")
                            .font(.callout)
                            .foregroundStyle(.orange)
                    }
                } header: {
                    Text("Filters")
                }

                Section {
                    WebExtensionStatus()
                } header: {
                    Text("Advanced blocking")
                } footer: {
                    Text("The Bastion Advanced Blocking extension runs scriptlets and advanced cosmetic filters (video ads, anti-adblock walls, cookie dialogs), and adds a toolbar button to pause Bastion or hide any element. Allow it on all websites.")
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Bastion")
            .refreshable { await model.updateFilters(forceDownload: true) }
        }
    }
}

private struct StatusHeader: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        HStack(spacing: 16) {
            Image(systemName: model.allBlockersEnabled ? "checkmark.shield.fill" : "exclamationmark.shield.fill")
                .font(.system(size: 44))
                .foregroundStyle(model.allBlockersEnabled ? Color.green : Color.orange)
                .symbolRenderingMode(.hierarchical)
            VStack(alignment: .leading, spacing: 4) {
                Text(model.allBlockersEnabled ? "Protection is on" : "Protection is incomplete")
                    .font(.title3.weight(.semibold))
                Text(model.allBlockersEnabled
                     ? "Blocking ads, trackers and annoyances with \(model.totalRules.grouped) rules."
                     : "\(model.enabledBlockerCount) of \(BlockerSlot.allCases.count) content blockers are on.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }
}

private struct WebExtensionStatus: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        if let enabled = model.webExtensionEnabled {
            Label(enabled ? "Bastion Advanced Blocking is on" : "Bastion Advanced Blocking is off",
                  systemImage: enabled ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(enabled ? Color.primary : Color.secondary)
        } else {
            Label("Turn on Bastion Advanced Blocking in Safari's extension settings and allow it on every website.", systemImage: "puzzlepiece.extension")
                .font(.callout)
        }
    }
}
