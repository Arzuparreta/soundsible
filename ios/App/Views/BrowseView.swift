import SoundsibleKit
import SwiftUI

/// One screen for every node of the car tree.
///
/// The engine returns the same shape for the root, a playlist and a podcast, so
/// one view renders all of them and navigation is just another item id.
struct BrowseView: View {
    let itemID: String?
    let title: String

    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var player: PlayerModel
    @EnvironmentObject private var offline: OfflineStore

    @State private var items: [CarItem] = []
    @State private var isLoading = true
    @State private var failure: String?

    var body: some View {
        List {
            if let failure {
                ContentUnavailableView(
                    "Could not reach your Soundsible",
                    systemImage: "wifi.exclamationmark",
                    description: Text(failure)
                )
            }
            ForEach(items) { item in
                row(for: item)
            }
        }
        .listStyle(.plain)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(itemID == nil ? .large : .inline)
        .toolbar {
            if itemID == nil {
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink {
                        SettingsView()
                    } label: {
                        Image(systemName: "gearshape")
                    }
                }
            } else if playableItems.count > 1 {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button {
                            Task { await pinForOffline() }
                        } label: {
                            Label("Make available offline", systemImage: "arrow.down.circle")
                        }
                        Button(role: .destructive) {
                            offline.unpin(collectionID: itemID ?? "")
                        } label: {
                            Label("Remove downloads", systemImage: "trash")
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
        }
        .overlay {
            if isLoading, items.isEmpty, failure == nil {
                ProgressView()
            }
        }
        .refreshable { await load() }
        .task(id: itemID) { await load() }
        // The mini player floats over the list; without this the last row hides
        // behind it.
        .safeAreaPadding(.bottom, player.current == nil ? 0 : 64)
    }

    private var playableItems: [CarItem] {
        items.filter(\.isPlayable)
    }

    @ViewBuilder
    private func row(for item: CarItem) -> some View {
        if item.isBrowsable {
            NavigationLink {
                BrowseView(itemID: item.id, title: item.title)
            } label: {
                CarItemRow(item: item, isDownloaded: false)
            }
        } else {
            Button {
                let playable = playableItems
                if let index = playable.firstIndex(where: { $0.id == item.id }) {
                    player.play(items: playable, startingAt: index)
                }
            } label: {
                CarItemRow(
                    item: item,
                    isDownloaded: item.trackID.map(offline.isAvailableOffline) ?? false
                )
            }
            .buttonStyle(.plain)
        }
    }

    private func load() async {
        failure = nil
        isLoading = true
        defer { isLoading = false }
        do {
            // `Optional.map` cannot carry an `await`, so the branch is explicit.
            let response: CarItemsResponse
            if let itemID {
                response = try await model.client.items(itemID)
            } else {
                response = try await model.client.home()
            }
            items = response.items
        } catch {
            failure = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func pinForOffline() async {
        guard let itemID, case let .paired(connection) = model.phase else { return }
        await offline.pin(
            collectionID: itemID,
            items: playableItems,
            connection: connection
        )
    }
}

struct CarItemRow: View {
    let item: CarItem
    let isDownloaded: Bool

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title)
                    .lineLimit(1)
                if !item.subtitle.isEmpty {
                    Text(item.subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            if isDownloaded {
                Image(systemName: "arrow.down.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Available offline")
            }
            if let duration = item.durationSec {
                Text(Self.clock(duration))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }

    static func clock(_ seconds: Int) -> String {
        let minutes = seconds / 60
        let remainder = seconds % 60
        return String(format: "%d:%02d", minutes, remainder)
    }
}
