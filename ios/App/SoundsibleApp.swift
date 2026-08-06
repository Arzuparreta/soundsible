import SwiftUI

@main
struct SoundsibleApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .environmentObject(model.player)
                .environmentObject(model.offline)
                .preferredColorScheme(.dark)
                .task { await model.start() }
        }
    }
}
