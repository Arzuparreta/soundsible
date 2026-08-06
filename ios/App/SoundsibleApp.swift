import SwiftUI

@main
struct SoundsibleApp: App {
    // `@State` and not `@StateObject`: these models are `@Observable`, and the
    // Combine-era wrappers cannot see them at all.
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .environment(model.player)
                .environment(model.offline)
                .preferredColorScheme(.dark)
                .task { await model.start() }
        }
    }
}
