import AVFoundation
import Foundation
import os

/// Two decks and a crossfade between them.
///
/// The web player mixes two `<audio>` elements through a Web Audio graph, and
/// the reason Auto Mode misbehaves in a car is not the mixing — it is that the
/// browser's Media Session can only describe one of them, so the metadata that
/// reaches the head unit belongs to whichever element Safari picked. Here the
/// decks are two `AVPlayer`s and *this* code decides the moment the outgoing
/// track stops being the one on the dashboard.
///
/// `AVPlayer.volume` ramped from a task rather than `AVAudioEngine` with sample
/// accurate automation: an `AVAudioEngine` graph would have to decode the stream
/// itself, and over several seconds of crossfade a 60 Hz ramp is not audibly
/// different from a per-sample one.
final class DualDeckPlayer {
    /// The current deck reached its end on its own.
    var onPlaybackEnded: (() -> Void)?
    /// Position moved. Fires a few times a second while playing.
    var onProgress: ((_ positionSec: Double) -> Void)?
    /// The current track could not be played to the end — the server went
    /// away mid-song, or the file is not what it claimed to be.
    var onPlaybackFailed: ((Error?) -> Void)?
    /// The crossfade reached the point where the incoming track is the one that
    /// should be named on the lock screen and in the car.
    var onCrossfadeHandover: (() -> Void)?
    /// The incoming deck could not become audible. The outgoing deck still owns
    /// playback unless it had already reached its natural end.
    var onCrossfadeFailed: ((Error?) -> Void)?

    private let players: [AVPlayer]
    private var activeIndex = 0
    // Opaque tokens from AVFoundation, removed in `deinit` — which runs only
    // once nothing else can reach this object, so there is nothing to race.
    private nonisolated(unsafe) var timeObservers: [Any?] = [nil, nil]
    private var observerTasks: [Task<Void, Never>] = []
    private var fade: Task<Void, Never>?
    private var fadeGeneration = 0
    private let log = Logger(subsystem: "com.soundsible.player", category: "decks")

    private var active: AVPlayer { players[activeIndex] }
    private var idle: AVPlayer { players[1 - activeIndex] }

    var isPlaying: Bool { active.rate > 0 }

    var positionSec: Double {
        let time = active.currentTime()
        return time.isNumeric ? time.seconds : 0
    }

    var durationSec: Double? {
        guard let duration = active.currentItem?.duration, duration.isNumeric else { return nil }
        let seconds = duration.seconds
        return seconds.isFinite && seconds > 0 ? seconds : nil
    }

    init() {
        players = [AVPlayer(), AVPlayer()]
        for player in players {
            // The engine already serves what was asked for; letting AVPlayer
            // stall waiting to build a buffer it does not need adds latency to
            // every single tap.
            player.automaticallyWaitsToMinimizeStalling = false
            player.volume = 0
        }
        players[activeIndex].volume = 1
        observeEnds()
        observeTime()
    }

    // MARK: - Transport

    /// Replace what is playing, with no fade.
    func play(asset: AVAsset, startAt positionSec: Double = 0) {
        cancelFade()
        idle.pause()
        idle.volume = 0

        let item = AVPlayerItem(asset: asset)
        active.replaceCurrentItem(with: item)
        active.volume = 1
        if positionSec > 0 {
            active.seek(to: CMTime(seconds: positionSec, preferredTimescale: 600))
        }
        active.play()
    }

    /// Bring a new track in over `duration` seconds while the current one leaves.
    ///
    /// `handoverAt` is the fraction of the fade at which the incoming track
    /// becomes "the" track for the lock screen and the car. Halfway is the point
    /// where a listener would say the new one is what is playing.
    func crossfade(to asset: AVAsset, duration: TimeInterval, handoverAt: Double = 0.5) {
        guard duration > 0 else {
            swapDecks()
            play(asset: asset)
            onCrossfadeHandover?()
            return
        }
        cancelFade()

        let incoming = idle
        let outgoing = active
        let item: AVPlayerItem
        if let staged = incoming.currentItem, Self.sameAsset(staged.asset, asset) {
            item = staged
        } else {
            item = AVPlayerItem(asset: asset)
            incoming.replaceCurrentItem(with: item)
        }
        incoming.volume = 0
        let generation = fadeGeneration

        fade = Task { [weak self] in
            guard await Self.waitUntilReady(item), !Task.isCancelled else {
                guard !Task.isCancelled, self?.fadeGeneration == generation else { return }
                incoming.pause()
                incoming.replaceCurrentItem(with: nil)
                incoming.volume = 0
                outgoing.volume = 1
                self?.fade = nil
                self?.onCrossfadeFailed?(item.error)
                return
            }
            incoming.play()
            guard await Self.waitUntilPlaying(incoming), !Task.isCancelled else {
                guard !Task.isCancelled, self?.fadeGeneration == generation else { return }
                incoming.pause()
                incoming.replaceCurrentItem(with: nil)
                incoming.volume = 0
                outgoing.volume = 1
                self?.fade = nil
                self?.onCrossfadeFailed?(item.error)
                return
            }

            // If preparation lost the whole remaining runway, fading up from an
            // ended deck only prolongs silence. Hand over immediately now that
            // the incoming player is proven audible.
            if Self.hasEnded(outgoing) {
                incoming.volume = 1
                self?.swapDecks()
                self?.onCrossfadeHandover?()
                outgoing.pause()
                outgoing.replaceCurrentItem(with: nil)
                outgoing.volume = 0
                self?.fade = nil
                return
            }

            let started = ContinuousClock.now
            var handedOver = false
            let step = Duration.milliseconds(16)

            while !Task.isCancelled {
                let elapsed = Double(
                    (ContinuousClock.now - started) / .milliseconds(1)
                ) / 1000.0
                let progress = min(1.0, elapsed / duration)

                // Equal-power rather than linear: two linear ramps sum to a
                // noticeable dip in loudness through the middle of the fade.
                incoming.volume = Float(sin(progress * .pi / 2))
                outgoing.volume = Float(cos(progress * .pi / 2))

                if !handedOver, progress >= handoverAt {
                    handedOver = true
                    self?.swapDecks()
                    self?.onCrossfadeHandover?()
                }
                if progress >= 1.0 { break }
                try? await Task.sleep(for: step)
            }

            guard !Task.isCancelled else { return }
            outgoing.pause()
            outgoing.replaceCurrentItem(with: nil)
            outgoing.volume = 0
            incoming.volume = 1
            self?.fade = nil
        }
    }

    func resume() {
        active.play()
    }

    func pause() {
        cancelFade()
        active.pause()
    }

    func stop() {
        cancelFade()
        for player in players {
            player.pause()
            player.replaceCurrentItem(with: nil)
            player.volume = 0
        }
        players[activeIndex].volume = 1
    }

    func seek(to seconds: Double) {
        active.seek(
            to: CMTime(seconds: max(0, seconds), preferredTimescale: 600),
            toleranceBefore: .zero,
            toleranceAfter: .zero
        )
    }

    /// Preload the next track so its first bytes are already in flight.
    func preload(asset: AVAsset) {
        guard fade == nil else { return }
        idle.replaceCurrentItem(with: AVPlayerItem(asset: asset))
        idle.volume = 0
    }

    // MARK: - Plumbing

    private func swapDecks() {
        activeIndex = 1 - activeIndex
    }

    private func cancelFade() {
        fadeGeneration += 1
        fade?.cancel()
        fade = nil
    }

    private static func sameAsset(_ lhs: AVAsset, _ rhs: AVAsset) -> Bool {
        guard let left = lhs as? AVURLAsset, let right = rhs as? AVURLAsset else {
            return lhs === rhs
        }
        return left.url == right.url
    }

    private static func waitUntilReady(_ item: AVPlayerItem) async -> Bool {
        let deadline = ContinuousClock.now + .seconds(8)
        while !Task.isCancelled, ContinuousClock.now < deadline {
            switch item.status {
            case .readyToPlay:
                return true
            case .failed:
                return false
            case .unknown:
                try? await Task.sleep(for: .milliseconds(50))
            @unknown default:
                return false
            }
        }
        return false
    }

    private static func waitUntilPlaying(_ player: AVPlayer) async -> Bool {
        let deadline = ContinuousClock.now + .seconds(3)
        while !Task.isCancelled, ContinuousClock.now < deadline {
            if player.timeControlStatus == .playing { return true }
            if player.currentItem?.status == .failed { return false }
            try? await Task.sleep(for: .milliseconds(50))
        }
        return false
    }

    private static func hasEnded(_ player: AVPlayer) -> Bool {
        guard let item = player.currentItem,
              item.duration.isNumeric,
              item.currentTime().isNumeric
        else { return false }
        return item.currentTime().seconds >= item.duration.seconds - 0.05
    }

    private func observeEnds() {
        let task = Task { [weak self] in
            let ended = NotificationCenter.default.notifications(
                named: AVPlayerItem.didPlayToEndTimeNotification
            )
            for await notification in ended {
                guard let self else { return }
                // Both decks post this; only the one that is actually the
                // current deck means the queue should move on.
                guard let item = notification.object as? AVPlayerItem,
                      item === self.active.currentItem
                else { continue }
                self.onPlaybackEnded?()
            }
        }
        observerTasks.append(task)

        let failures = Task { [weak self] in
            let failed = NotificationCenter.default.notifications(
                named: AVPlayerItem.failedToPlayToEndTimeNotification
            )
            for await notification in failed {
                guard let self else { return }
                guard let item = notification.object as? AVPlayerItem,
                      item === self.active.currentItem
                else { continue }
                let error = notification.userInfo?[
                    AVPlayerItemFailedToPlayToEndTimeErrorKey
                ] as? Error
                self.onPlaybackFailed?(error)
            }
        }
        observerTasks.append(failures)
    }

    private func observeTime() {
        for (index, player) in players.enumerated() {
            let interval = CMTime(seconds: 0.5, preferredTimescale: 600)
            timeObservers[index] = player.addPeriodicTimeObserver(
                forInterval: interval,
                queue: .main
            ) { [weak self] time in
                // The queue is `.main`, so this genuinely is the main actor —
                // `assumeIsolated` states that rather than hopping and losing
                // the ordering the caller relies on.
                MainActor.assumeIsolated {
                    guard let self, self.players[self.activeIndex] === player else { return }
                    guard time.isNumeric else { return }
                    self.onProgress?(time.seconds)
                }
            }
        }
    }

    deinit {
        fade?.cancel()
        observerTasks.forEach { $0.cancel() }
        for (index, observer) in timeObservers.enumerated() {
            if let observer { players[index].removeTimeObserver(observer) }
        }
    }
}
