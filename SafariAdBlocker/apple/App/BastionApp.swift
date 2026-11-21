import SwiftUI
#if os(iOS)
import BackgroundTasks
#endif

@main
struct BastionApp: App {
    @StateObject private var model = AppModel.shared
    @Environment(\.scenePhase) private var scenePhase

    init() {
        #if os(iOS)
        BackgroundRefresh.register()
        #endif
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(model)
                .task {
                    await model.refreshStatus()
                    await model.updateIfNeeded()
                }
                #if os(macOS)
                .frame(minWidth: 560, minHeight: 600)
                // While the app is open on macOS, refresh lists every few hours.
                .onReceive(Timer.publish(every: 3 * 3600, on: .main, in: .common).autoconnect()) { _ in
                    Task { await model.updateIfNeeded() }
                }
                #endif
        }
        #if os(macOS)
        .windowResizability(.contentMinSize)
        #endif
        .onChange(of: scenePhase) { phase in
            switch phase {
            case .active:
                Task {
                    await model.refreshStatus()
                    await model.updateIfNeeded()
                }
            case .background:
                #if os(iOS)
                BackgroundRefresh.schedule()
                #endif
            default:
                break
            }
        }
    }
}

#if os(iOS)
/// Periodic filter updates on iOS via BGProcessingTask (the compiler needs
/// more time than an app-refresh task allows).
enum BackgroundRefresh {
    static var identifier: String { Bastion.appBundleIdentifier + ".refresh" }

    static func register() {
        _ = BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: nil) { task in
            let work = Task { @MainActor in
                await AppModel.shared.updateIfNeeded()
                task.setTaskCompleted(success: AppModel.shared.errorMessage == nil)
            }
            task.expirationHandler = { work.cancel() }
            schedule()
        }
    }

    static func schedule() {
        let request = BGProcessingTaskRequest(identifier: identifier)
        request.requiresNetworkConnectivity = true
        request.requiresExternalPower = false
        request.earliestBeginDate = Date(timeIntervalSinceNow: 12 * 3600)
        try? BGTaskScheduler.shared.submit(request)
    }
}
#endif
