import AVFoundation
import Foundation
import os

/// Owns the one piece of configuration that makes this app worth building.
///
/// `.playback` is what tells iOS this audio is the point of the app rather than
/// a sound effect, and it is the difference between music that survives the lock
/// button and music that dies with it. Everything else here exists because a car
/// is an environment where the phone gets interrupted constantly — navigation
/// prompts, calls, a Bluetooth link dropping when the engine stops.
final class AudioSessionController {
    /// Somebody else took the audio; we paused and are waiting to be told we can
    /// resume.
    var onInterruptionBegan: (() -> Void)?
    /// The interruption ended. The flag says whether iOS thinks we should
    /// resume on our own.
    var onInterruptionEnded: ((_ shouldResume: Bool) -> Void)?
    /// The output went away — headphones unplugged, Bluetooth disconnected.
    var onRouteGone: (() -> Void)?

    private let log = Logger(subsystem: "com.soundsible.player", category: "audio-session")
    private var observers: [NSObjectProtocol] = []

    func activate() {
        let session = AVAudioSession.sharedInstance()
        do {
            // `.longFormAudio` is the policy that lets AirPlay 2 and CarPlay
            // treat this as a music app rather than a beep.
            try session.setCategory(.playback, mode: .default, policy: .longFormAudio)
            try session.setActive(true)
        } catch {
            log.error("Could not activate the audio session: \(error.localizedDescription)")
        }
        observeInterruptions()
        observeRouteChanges()
    }

    func deactivate() {
        do {
            try AVAudioSession.sharedInstance().setActive(
                false,
                options: .notifyOthersOnDeactivation
            )
        } catch {
            log.error("Could not deactivate the audio session: \(error.localizedDescription)")
        }
    }

    private func observeInterruptions() {
        let observer = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] notification in
            guard let self,
                  let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: raw)
            else { return }

            switch type {
            case .began:
                self.onInterruptionBegan?()
            case .ended:
                let options = (notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt)
                    .map(AVAudioSession.InterruptionOptions.init(rawValue:)) ?? []
                self.onInterruptionEnded?(options.contains(.shouldResume))
            @unknown default:
                break
            }
        }
        observers.append(observer)
    }

    private func observeRouteChanges() {
        let observer = NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] notification in
            guard let self,
                  let raw = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
                  let reason = AVAudioSession.RouteChangeReason(rawValue: raw)
            else { return }

            // Leaving the car must not mean the phone starts playing out loud in
            // your hand. iOS calls this "old device unavailable" and every media
            // app is expected to pause on it.
            if reason == .oldDeviceUnavailable {
                self.onRouteGone?()
            }
        }
        observers.append(observer)
    }

    deinit {
        observers.forEach(NotificationCenter.default.removeObserver)
    }
}
