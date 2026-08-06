import SoundsibleKit
import SwiftUI

struct RootView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var player: PlayerModel
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
    @EnvironmentObject private var player: PlayerModel
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
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .padding(.horizontal, 10)
        .contentShape(Rectangle())
        .onTapGesture(perform: onTap)
    }
}
