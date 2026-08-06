import Foundation
import MediaPlayer
import SoundsibleKit
import UIKit

/// Publishes what is sounding to every surface that shows it.
///
/// One object feeds the lock screen, Control Centre, the Apple Watch, the
/// CarPlay Now Playing screen and the AVRCP metadata a Bluetooth head unit
/// displays. They are not separate integrations — they are all
/// `MPNowPlayingInfoCenter`, which is why an app with no CarPlay entitlement
/// still shows correctly on a car screen.
@MainActor
final class NowPlayingPublisher {
    private let center = MPNowPlayingInfoCenter.default()
    private var artworkTask: Task<Void, Never>?
    /// The item the currently in-flight artwork belongs to, so a slow download
    /// for a track that has already been skipped never lands on the next one.
    private var artworkItemID: String?

    func clear() {
        artworkTask?.cancel()
        artworkItemID = nil
        center.nowPlayingInfo = nil
    }

    /// Publish a track. Call on every track change.
    func publish(
        item: CarItem,
        durationSec: Double?,
        positionSec: Double,
        rate: Double,
        artworkURL: URL?,
        artworkLoader: ArtworkLoader
    ) {
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: item.title,
            MPMediaItemPropertyArtist: item.artist,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
            // Live streams get a different scrubber; ours is a file with a
            // known length.
            MPNowPlayingInfoPropertyIsLiveStream: false,
        ]
        if !item.album.isEmpty {
            info[MPMediaItemPropertyAlbumTitle] = item.album
        }
        if let duration = durationSec ?? item.durationSec.map(Double.init), duration > 0 {
            info[MPMediaItemPropertyPlaybackDuration] = duration
        }
        // Without these two the progress bar on a head unit sits at zero for the
        // whole song. The rate is what makes it move, and the elapsed time is
        // what it moves from.
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = positionSec
        info[MPNowPlayingInfoPropertyPlaybackRate] = rate
        info[MPNowPlayingInfoPropertyDefaultPlaybackRate] = 1.0

        // Keep whatever artwork is already up while the new one downloads, so a
        // track change does not flash an empty square on the car screen.
        if let existing = center.nowPlayingInfo?[MPMediaItemPropertyArtwork] {
            info[MPMediaItemPropertyArtwork] = existing
        }
        center.nowPlayingInfo = info

        loadArtwork(for: item, url: artworkURL, loader: artworkLoader)
    }

    /// Update position and rate without rebuilding the whole payload.
    ///
    /// Called on play, pause and seek — never on a timer. `MPNowPlayingInfoCenter`
    /// extrapolates from the rate and the elapsed time it was last given, so
    /// tickling it every second is both unnecessary and a good way to get
    /// throttled by the system.
    func updatePlaybackProgress(positionSec: Double, rate: Double) {
        guard var info = center.nowPlayingInfo else { return }
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = positionSec
        info[MPNowPlayingInfoPropertyPlaybackRate] = rate
        center.nowPlayingInfo = info
    }

    private func loadArtwork(for item: CarItem, url: URL?, loader: ArtworkLoader) {
        artworkTask?.cancel()
        artworkItemID = item.id
        guard let url else {
            var info = center.nowPlayingInfo ?? [:]
            info.removeValue(forKey: MPMediaItemPropertyArtwork)
            center.nowPlayingInfo = info
            return
        }

        artworkTask = Task { [weak self] in
            guard let image = await loader.image(at: url) else { return }
            guard !Task.isCancelled else { return }
            guard let self, self.artworkItemID == item.id else { return }

            let artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
            var info = self.center.nowPlayingInfo ?? [:]
            info[MPMediaItemPropertyArtwork] = artwork
            self.center.nowPlayingInfo = info
        }
    }
}
