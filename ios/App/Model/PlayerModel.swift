import AVFoundation
import Foundation
import os
import SoundsibleKit
import SwiftUI

/// Everything that has an opinion about what is sounding, in one place.
///
/// The queue lives in `SoundsibleKit` and is tested on Linux; this type is the
/// wiring between it, the decks, and the surfaces that describe playback to the
/// outside world.
@MainActor
final class PlayerModel: ObservableObject {
    @Published private(set) var current: CarItem?
    @Published private(set) var isPlaying = false
    @Published private(set) var positionSec: Double = 0
    @Published private(set) var durationSec: Double?
    @Published private(set) var queue = PlayQueue()
    @Published var crossfadeSeconds: Double = UserDefaults.standard.object(
        forKey: "com.soundsible.player.crossfade"
    ) as? Double ?? 0 {
        didSet { UserDefaults.standard.set(crossfadeSeconds, forKey: "com.soundsible.player.crossfade") }
    }

    var repeatMode: RepeatMode {
        get { queue.repeatMode }
        set { queue.repeatMode = newValue; refreshCommandAvailability() }
    }

    var isShuffled: Bool { queue.isShuffled }

    private let decks = DualDeckPlayer()
    private let session = AudioSessionController()
    private let nowPlaying = NowPlayingPublisher()
    private let commands = RemoteCommandBridge()
    private let offline: OfflineStore
    private let log = Logger(subsystem: "com.soundsible.player", category: "player")

    private var connection: ServerConnection?
    private var client: SoundsibleClient?
    private var streamLoader: StreamAssetLoader?
    private var artwork: ArtworkLoader?
    private let loaderQueue = DispatchQueue(label: "com.soundsible.player.stream-loader")
    /// Set when an interruption paused us, so we only auto-resume something we
    /// actually stopped.
    private var pausedByInterruption = false
    private var statePublishTask: Task<Void, Never>?

    init(offline: OfflineStore) {
        self.offline = offline
        wireDecks()
        wireSession()
        wireCommands()
    }

    /// Point the player at a server. Called once pairing has produced a token.
    func attach(connection: ServerConnection, client: SoundsibleClient) {
        self.connection = connection
        self.client = client
        self.streamLoader = StreamAssetLoader(token: connection.token)
        self.artwork = ArtworkLoader(token: connection.token)
        session.activate()

        Task {
            try? await client.registerDevice(
                DeviceRegistration(deviceID: DeviceIdentity.id, deviceName: DeviceIdentity.name)
            )
        }
    }

    func detach() {
        stop()
        session.deactivate()
        commands.disconnect()
        connection = nil
        client = nil
        streamLoader = nil
        artwork = nil
    }

    // MARK: - Starting playback

    /// Play a list from a given position in it.
    func play(items: [CarItem], startingAt index: Int) {
        queue = PlayQueue(items: items, startIndex: nil, repeatMode: queue.repeatMode)
        // The index the caller has is into the list it showed, which may include
        // rows that are not playable; matching by identity avoids playing the
        // wrong song.
        if items.indices.contains(index) {
            let wanted = items[index].id
            if let resolved = queue.items.firstIndex(where: { $0.id == wanted }) {
                queue.jump(to: resolved)
            }
        }
        startCurrent(fade: false)
    }

    func toggle() {
        isPlaying ? pause() : resume()
    }

    func resume() {
        guard current != nil else { return }
        decks.resume()
        isPlaying = true
        pausedByInterruption = false
        publishProgress()
        publishStateToServer()
    }

    func pause() {
        decks.pause()
        isPlaying = false
        publishProgress()
        publishStateToServer()
    }

    func stop() {
        decks.stop()
        isPlaying = false
        current = nil
        positionSec = 0
        durationSec = nil
        nowPlaying.clear()
        statePublishTask?.cancel()
    }

    func next() {
        guard queue.skipForward() != nil else { return }
        startCurrent(fade: false)
    }

    func previous() {
        guard queue.skipBackward(positionSec: positionSec) != nil else { return }
        // Restarting the same track is a seek, not a track change: rebuilding
        // Now Playing would make the car blink for no reason.
        if queue.current?.id == current?.id {
            seek(to: 0)
        } else {
            startCurrent(fade: false)
        }
    }

    func seek(to seconds: Double) {
        decks.seek(to: seconds)
        positionSec = seconds
        publishProgress()
        publishStateToServer()
    }

    func setShuffled(_ shuffled: Bool) {
        queue.setShuffled(shuffled)
        refreshCommandAvailability()
    }

    func enqueueNext(_ items: [CarItem]) {
        queue.playNext(items)
        refreshCommandAvailability()
    }

    // MARK: - The actual track change

    private func startCurrent(fade: Bool) {
        guard let item = queue.current, let asset = asset(for: item) else {
            stop()
            return
        }
        current = item
        durationSec = item.durationSec.map(Double.init)
        positionSec = 0

        if fade, crossfadeSeconds > 0 {
            decks.crossfade(to: asset, duration: crossfadeSeconds)
        } else {
            decks.play(asset: asset)
            publishNowPlaying(for: item)
        }
        isPlaying = true

        if let trackID = item.trackID { offline.markPlayed(trackID) }
        refreshCommandAvailability()
        preloadUpNext()
        publishStateToServer()
    }

    /// Where the bytes for an item come from.
    ///
    /// A downloaded file wins over the network every time — it is the whole
    /// point of the offline feature, and in a car it is the difference between
    /// music and a spinner in a tunnel.
    private func asset(for item: CarItem) -> AVAsset? {
        if let trackID = item.trackID, let local = offline.localURL(for: trackID) {
            return AVURLAsset(url: local)
        }
        guard let path = item.streamURL,
              let connection,
              let url = connection.resolve(path),
              let streamLoader
        else { return nil }
        return StreamAssetLoader.asset(for: url, loader: streamLoader, queue: loaderQueue)
    }

    private func preloadUpNext() {
        guard let upNext = queue.upNext, let asset = asset(for: upNext) else { return }
        decks.preload(asset: asset)
    }

    // MARK: - Publishing

    private func publishNowPlaying(for item: CarItem) {
        guard let artwork else { return }
        let artworkURL = item.artworkURL.flatMap { connection?.resolve($0) }
        nowPlaying.publish(
            item: item,
            durationSec: durationSec,
            positionSec: positionSec,
            rate: isPlaying ? 1 : 0,
            artworkURL: artworkURL,
            artworkLoader: artwork
        )
    }

    private func publishProgress() {
        nowPlaying.updatePlaybackProgress(
            positionSec: positionSec,
            rate: isPlaying ? 1 : 0
        )
    }

    private func refreshCommandAvailability() {
        commands.updateAvailability(
            hasNext: queue.upNext != nil,
            hasPrevious: queue.count > 1,
            isPodcast: current?.kind == "podcast_episode"
        )
    }

    /// Tell the engine what this device is doing, without letting it become a
    /// request per second.
    private func publishStateToServer() {
        guard let client, let current else { return }
        statePublishTask?.cancel()
        let state = RemotePlaybackState(
            trackID: current.trackID ?? current.id,
            positionSec: positionSec,
            isPlaying: isPlaying,
            deviceID: DeviceIdentity.id
        )
        statePublishTask = Task {
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            try? await client.publishPlaybackState(state)
        }
    }

    // MARK: - Wiring

    private func wireDecks() {
        decks.onProgress = { [weak self] position in
            guard let self else { return }
            self.positionSec = position
            if self.durationSec == nil { self.durationSec = self.decks.durationSec }

            // Start the fade early enough that it ends as the track does.
            if self.crossfadeSeconds > 0,
               let duration = self.durationSec,
               duration - position <= self.crossfadeSeconds,
               self.queue.upNext != nil,
               self.isPlaying {
                self.beginCrossfadeToNext()
            }
        }
        decks.onPlaybackEnded = { [weak self] in
            guard let self else { return }
            guard self.queue.advanceAfterPlaybackEnded() != nil else {
                self.pause()
                return
            }
            self.startCurrent(fade: false)
        }
        decks.onCrossfadeHandover = { [weak self] in
            guard let self, let item = self.queue.current else { return }
            self.current = item
            self.durationSec = self.decks.durationSec ?? item.durationSec.map(Double.init)
            self.publishNowPlaying(for: item)
            self.refreshCommandAvailability()
        }
        decks.onFailure = { [weak self] error in
            self?.log.error("Playback failed: \(error.localizedDescription)")
            self?.pause()
        }
    }

    private var isCrossfading = false

    private func beginCrossfadeToNext() {
        guard !isCrossfading, let upNext = queue.upNext, let asset = asset(for: upNext) else {
            return
        }
        isCrossfading = true
        queue.skipForward()
        decks.crossfade(to: asset, duration: crossfadeSeconds)
        if let trackID = upNext.trackID { offline.markPlayed(trackID) }
        preloadUpNext()
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(self?.crossfadeSeconds ?? 0))
            self?.isCrossfading = false
        }
    }

    private func wireSession() {
        session.onInterruptionBegan = { [weak self] in
            guard let self, self.isPlaying else { return }
            self.pausedByInterruption = true
            self.pause()
        }
        session.onInterruptionEnded = { [weak self] shouldResume in
            guard let self, self.pausedByInterruption else { return }
            self.pausedByInterruption = false
            if shouldResume { self.resume() }
        }
        session.onRouteGone = { [weak self] in
            // Bluetooth dropped or headphones came out. Playing on aloud through
            // the phone speaker is never what somebody wanted.
            self?.pause()
        }
    }

    private func wireCommands() {
        commands.connect(
            RemoteCommandBridge.Handlers(
                play: { [weak self] in self?.resume() },
                pause: { [weak self] in self?.pause() },
                toggle: { [weak self] in self?.toggle() },
                next: { [weak self] in self?.next() },
                previous: { [weak self] in self?.previous() },
                seek: { [weak self] position in self?.seek(to: position) },
                skipForward: { [weak self] interval in
                    guard let self else { return }
                    self.seek(to: self.positionSec + interval)
                },
                skipBackward: { [weak self] interval in
                    guard let self else { return }
                    self.seek(to: max(0, self.positionSec - interval))
                }
            )
        )
    }
}
