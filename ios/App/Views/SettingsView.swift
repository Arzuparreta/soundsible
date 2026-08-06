import SoundsibleKit
import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(PlayerModel.self) private var player
    @Environment(OfflineStore.self) private var offline

    @State private var confirmUnpair = false
    @State private var deviceName = DeviceIdentity.name

    var body: some View {
        // `@Observable` models have no `$` of their own; `@Bindable` is what
        // hands a binding back for a two-way control.
        @Bindable var player = player

        Form {
            Section {
                if case let .paired(connection) = model.phase {
                    LabeledContent("Address", value: connection.baseURL.absoluteString)
                }
                Button("Unpair this device", role: .destructive) {
                    confirmUnpair = true
                }
            } header: {
                Text("Server")
            }

            Section {
                TextField("This device", text: $deviceName)
                    .autocorrectionDisabled()
                    .onSubmit { DeviceIdentity.name = deviceName }
            } header: {
                Text("Device name")
            } footer: {
                Text(
                    """
                    How this phone is listed in your Soundsible's paired devices. \
                    iOS stopped telling apps what you called your phone, so it is \
                    worth setting if you pair more than one.
                    """
                )
            }

            Section {
                Slider(value: $player.crossfadeSeconds, in: 0...12, step: 1)
                LabeledContent(
                    "Crossfade",
                    value: player.crossfadeSeconds == 0
                        ? "Off"
                        : "\(Int(player.crossfadeSeconds)) s"
                )
            } header: {
                Text("Playback")
            } footer: {
                Text(
                    """
                    Tracks blend into each other over this long. The lock screen \
                    and the car switch to the incoming track halfway through the \
                    blend.
                    """
                )
            }

            Section {
                LabeledContent("Downloaded", value: Self.bytes(offline.usedBytes))
                Picker("Storage limit", selection: budgetBinding) {
                    Text("No limit").tag(Int64(0))
                    Text("1 GB").tag(Int64(1_000_000_000))
                    Text("4 GB").tag(Int64(4_000_000_000))
                    Text("16 GB").tag(Int64(16_000_000_000))
                }
                Button("Remove all downloads", role: .destructive) {
                    offline.removeEverything()
                }
            } header: {
                Text("Offline")
            } footer: {
                Text(
                    """
                    Anything you explicitly made available offline is kept even \
                    when the limit is reached; only music downloaded on the way \
                    past is evicted.
                    """
                )
            }
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .onDisappear { DeviceIdentity.name = deviceName }
        .confirmationDialog(
            "Unpair this device?",
            isPresented: $confirmUnpair,
            titleVisibility: .visible
        ) {
            Button("Unpair", role: .destructive) {
                Task { await model.unpair() }
            }
        } message: {
            Text("Downloaded music stays on the phone until you remove it.")
        }
    }

    private var budgetBinding: Binding<Int64> {
        Binding(
            get: { offline.byteBudget ?? 0 },
            set: { offline.byteBudget = $0 == 0 ? nil : $0 }
        )
    }

    static func bytes(_ value: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: value, countStyle: .file)
    }
}
