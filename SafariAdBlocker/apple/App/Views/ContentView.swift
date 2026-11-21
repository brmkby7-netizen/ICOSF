import SwiftUI

struct ContentView: View {
    var body: some View {
        TabView {
            DashboardView()
                .tabItem { Label("Protection", systemImage: "shield.lefthalf.filled") }
            FiltersView()
                .tabItem { Label("Filters", systemImage: "line.3.horizontal.decrease.circle") }
            AllowlistView()
                .tabItem { Label("Allowlist", systemImage: "checkmark.shield") }
            AdvancedView()
                .tabItem { Label("Advanced", systemImage: "slider.horizontal.3") }
        }
        .tint(.bastionAccent)
    }
}

extension Color {
    static let bastionAccent = Color(red: 0.91, green: 0.29, blue: 0.18)
}

extension Int {
    var grouped: String { formatted(.number) }
}
