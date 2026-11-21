import SwiftUI

struct AllowlistView: View {
    @EnvironmentObject private var model: AppModel
    @State private var entry = ""
    @State private var invalid = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack {
                        TextField("example.com", text: $entry)
                            .autocorrectionDisabled()
                            #if os(iOS)
                            .textInputAutocapitalization(.never)
                            .keyboardType(.URL)
                            #endif
                            .onSubmit(add)
                        Button("Add", action: add).disabled(entry.isEmpty)
                    }
                    if invalid {
                        Text("That doesn't look like a website address.").font(.callout).foregroundStyle(.red)
                    }
                } footer: {
                    Text("Bastion is paused on these sites and their subdomains. You can also pause a site from the Bastion button in Safari's toolbar.")
                }

                Section("Paused sites") {
                    if model.state.allowlist.isEmpty {
                        Text("None").foregroundStyle(.secondary)
                    }
                    ForEach(model.state.allowlist, id: \.self) { domain in
                        Label(domain, systemImage: "pause.circle")
                    }
                    .onDelete { model.removeFromAllowlist(at: $0) }
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Allowlist")
        }
    }

    private func add() {
        invalid = !model.addToAllowlist(entry)
        if !invalid { entry = "" }
    }
}
