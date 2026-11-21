import SwiftUI

struct AdvancedView: View {
    @EnvironmentObject private var model: AppModel
    @State private var rules = ""
    @State private var loaded = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextEditor(text: $rules)
                        .font(.system(.footnote, design: .monospaced))
                        .frame(minHeight: 180)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                    Button("Save and apply") { model.saveCustomRules(rules) }
                        .disabled(rules == model.state.customRules || model.isUpdating)
                } header: {
                    Text("My filters")
                } footer: {
                    Text("""
                    One filter per line, in Adblock Plus / uBlock Origin syntax:
                    ||ads.example.com^   block a domain
                    example.com##.banner   hide elements on a site
                    @@||example.com^$document   never filter a site
                    example.com##+js(set, adsEnabled, false)   run a scriptlet
                    """)
                    .font(.caption.monospaced())
                }

                Section("Updates") {
                    Toggle("Update filter lists automatically", isOn: Binding(
                        get: { model.state.autoUpdate },
                        set: { model.setAutoUpdate($0) }
                    ))
                    Button("Rebuild rules now") { Task { await model.updateFilters(forceDownload: true) } }
                        .disabled(model.isUpdating)
                }

                if let report = model.report {
                    Section {
                        LabeledContent("Filter lines read", value: report.stats.lines.grouped)
                        LabeledContent("Safari rules", value: report.stats.contentBlockerRules.grouped)
                        LabeledContent("Advanced rules", value: report.stats.webRules.grouped)
                        LabeledContent("Skipped (unsupported in Safari)", value: report.stats.skipped.grouped)
                        LabeledContent("Compile time", value: "\(report.durationMs) ms")
                        if report.distribution.dropped > 0 {
                            Label("\(report.distribution.dropped.grouped) rules didn't fit Safari's limits. Disable a large list to make room.", systemImage: "exclamationmark.triangle")
                                .foregroundStyle(.orange)
                        }
                        DisclosureGroup("Why filters were skipped") {
                            ForEach(report.errors.prefix(15), id: \.self) { skip in
                                HStack(alignment: .firstTextBaseline) {
                                    Text(skip.reason).font(.callout)
                                    Spacer()
                                    Text(skip.count.grouped).font(.callout.monospacedDigit()).foregroundStyle(.secondary)
                                }
                            }
                        }
                    } header: {
                        Text("Last build")
                    }
                }

                Section("About") {
                    Text("Bastion compiles community filter lists (EasyList, uBlock Origin, AdGuard and others) on your device. Nothing you browse ever leaves Safari: content blockers tell Safari what to block, and Safari does the blocking.")
                        .font(.callout)
                    Text("Filter lists belong to their authors and are distributed under their own licenses (GPLv3, CC BY-SA and others).")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Advanced")
            .onAppear {
                if !loaded {
                    rules = model.state.customRules
                    loaded = true
                }
            }
        }
    }
}
