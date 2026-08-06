import SoundsibleKit
import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(PlayerModel.self) private var player
    @State private var showNowPlaying = false

    var body: some View {
        switch model.phase {
        case .checking:
            ProgressView().controlSize(.large)

        case .unpaired:
            PairingView()

        case let .paired(connection):
            ZStack(alignment: .bottom) {
                NavigationStack {
                    BrowseView(itemID: nil, title: connection.label)
                }
                if player.current != nil {
                    MiniPlayerBar { showNowPlaying = true }
                }
            }
            .sheet(isPresented: $showNowPlaying) {
                NowPlayingView()
            }
        }
    }
}

/// The strip above the tab bar. Tapping it opens the full player.
struct MiniPlayerBar: View {
    @Environment(PlayerModel.self) private var player
    let onTap: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(player.current?.title ?? "")
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                Text(player.current?.artist ?? "")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)

            Button {
                player.toggle()
            } label: {
                Image(systemName: player.isPlaying ? "pause.fill" : "play.fill")
                    .font(.title3)
            }
            .buttonStyle(.plain)

            Button {
                player.next()
            } label: {
                Image(systemName: "forward.fill").font(.title3)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        // Liquid Glass rather than a material: built against the iOS 26 SDK this
        // is what floats-above-content is supposed to look like, and it picks up
        // the same lighting as the navigation bar behind it.
        .glassEffect(.regular, in: .rect(cornerRadius: 20))
        .padding(.horizontal, 10)
        .contentShape(Rectangle())
        .onTapGesture(perform: onTap)
    }
}
