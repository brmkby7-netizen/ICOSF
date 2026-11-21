import SwiftUI

struct FiltersView: View {
    @EnvironmentObject private var model: AppModel
    @State private var showingAdd = false

    var body: some View {
        NavigationStack {
            Form {
                ForEach(model.catalog.sections) { section in
                    Section(section.title) {
                        ForEach(section.lists) { list in
                            Toggle(isOn: Binding(
                                get: { model.isEnabled(list) },
                                set: { model.setList(list, enabled: $0) }
                            )) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(list.name)
                                    Text(list.description).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }

                Section {
                    ForEach(model.state.customLists) { list in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(list.name)
                            Text(list.url).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                        }
                    }
                    .onDelete { model.removeCustomLists(at: $0) }
                    Button {
                        showingAdd = true
                    } label: {
                        Label("Add a list by URL", systemImage: "plus")
                    }
                } header: {
                    Text("Your lists")
                } footer: {
                    Text("Any Adblock Plus, uBlock Origin or AdGuard list, or a hosts file. Lists you add can't use trusted scriptlets.")
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Filters")
            .overlay(alignment: .bottom) {
                if model.isUpdating {
                    Label(model.progressText.isEmpty ? "Applying…" : model.progressText, systemImage: "arrow.triangle.2.circlepath")
                        .font(.callout)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .background(.regularMaterial, in: Capsule())
                        .padding()
                }
            }
            .sheet(isPresented: $showingAdd) { AddListSheet() }
        }
    }
}

private struct AddListSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var url = ""
    @State private var category = "ads"
    @State private var invalid = false

    var body: some View {
        NavigationStack {
            Form {
                TextField("Name (optional)", text: $name)
                TextField("https://example.com/list.txt", text: $url)
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                    #endif
                Picker("Content blocker", selection: $category) {
                    Text("Ads").tag("ads")
                    Text("Privacy").tag("privacy")
                    Text("Security").tag("security")
                    Text("Annoyances").tag("annoyances")
                    Text("Social").tag("social")
                }
                if invalid {
                    Text("Enter an http(s) URL.").foregroundStyle(.red).font(.callout)
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Add filter list")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        if model.addCustomList(name: name, url: url, category: category) { dismiss() } else { invalid = true }
                    }
                    .disabled(url.isEmpty)
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 420, minHeight: 260)
        #endif
    }
}
