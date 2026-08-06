import Foundation
import MediaPlayer

/// Wires the steering wheel, the dashboard, the lock screen and the headphone
/// button to the player.
///
/// Enabling and disabling commands is not cosmetic: head units and the lock
/// screen decide which buttons to draw from what is enabled here, so a command
/// left on that does nothing shows a button that does nothing.
@MainActor
final class RemoteCommandBridge {
    struct Handlers {
        var play: () -> Void
        var pause: () -> Void
        var toggle: () -> Void
        var next: () -> Void
        var previous: () -> Void
        var seek: (Double) -> Void
        var skipForward: (Double) -> Void
        var skipBackward: (Double) -> Void
    }

    private let center = MPRemoteCommandCenter.shared()
    private var handlers: Handlers?

    func connect(_ handlers: Handlers) {
        self.handlers = handlers

        center.playCommand.addTarget { [weak self] _ in
            self?.handlers?.play()
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            self?.handlers?.pause()
            return .success
        }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            self?.handlers?.toggle()
            return .success
        }
        center.nextTrackCommand.addTarget { [weak self] _ in
            self?.handlers?.next()
            return .success
        }
        center.previousTrackCommand.addTarget { [weak self] _ in
            self?.handlers?.previous()
            return .success
        }
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else {
                return .commandFailed
            }
            self?.handlers?.seek(event.positionTime)
            return .success
        }

        // Podcasts want a 30-second jump; music wants track skips. Both are
        // offered and the model decides which is meaningful for what is playing.
        center.skipForwardCommand.preferredIntervals = [30]
        center.skipBackwardCommand.preferredIntervals = [15]
        center.skipForwardCommand.addTarget { [weak self] event in
            guard let event = event as? MPSkipIntervalCommandEvent else { return .commandFailed }
            self?.handlers?.skipForward(event.interval)
            return .success
        }
        center.skipBackwardCommand.addTarget { [weak self] event in
            guard let event = event as? MPSkipIntervalCommandEvent else { return .commandFailed }
            self?.handlers?.skipBackward(event.interval)
            return .success
        }

        center.playCommand.isEnabled = true
        center.pauseCommand.isEnabled = true
        center.togglePlayPauseCommand.isEnabled = true
        center.changePlaybackPositionCommand.isEnabled = true

        // Never offered: this app has no rating, no bookmarking and no shuffle
        // surface on the lock screen, and a dead button is worse than none.
        center.ratingCommand.isEnabled = false
        center.likeCommand.isEnabled = false
        center.dislikeCommand.isEnabled = false
        center.bookmarkCommand.isEnabled = false
        center.changeShuffleModeCommand.isEnabled = false
        center.changeRepeatModeCommand.isEnabled = false
    }

    /// Reflect what the queue can currently do.
    ///
    /// A single track sitting alone in the queue must not show a next button on
    /// a car screen, and an episode of a podcast should offer a 30-second jump
    /// instead of a track skip.
    func updateAvailability(hasNext: Bool, hasPrevious: Bool, isPodcast: Bool) {
        center.nextTrackCommand.isEnabled = hasNext && !isPodcast
        center.previousTrackCommand.isEnabled = hasPrevious && !isPodcast
        center.skipForwardCommand.isEnabled = isPodcast
        center.skipBackwardCommand.isEnabled = isPodcast
    }

    func disconnect() {
        center.playCommand.removeTarget(nil)
        center.pauseCommand.removeTarget(nil)
        center.togglePlayPauseCommand.removeTarget(nil)
        center.nextTrackCommand.removeTarget(nil)
        center.previousTrackCommand.removeTarget(nil)
        center.changePlaybackPositionCommand.removeTarget(nil)
        center.skipForwardCommand.removeTarget(nil)
        center.skipBackwardCommand.removeTarget(nil)
        handlers = nil
    }
}
