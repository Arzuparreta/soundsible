import Foundation
import UIKit

/// Who this phone says it is to the engine.
enum DeviceIdentity {
    private static let idKey = "com.soundsible.player.device-id"
    private static let nameKey = "com.soundsible.player.device-name"

    /// Stable across relaunches, or the engine's device registry grows a new row
    /// every time the app starts and handoff begins targeting devices that no
    /// longer exist.
    static var id: String {
        if let existing = UserDefaults.standard.string(forKey: idKey) {
            return existing
        }
        let fresh = UUID().uuidString
        UserDefaults.standard.set(fresh, forKey: idKey)
        return fresh
    }

    /// What the paired device is called in Soundsible's settings.
    ///
    /// Not `UIDevice.current.name`. Since iOS 16 that returns the *model* —
    /// literally "iPhone" — unless the app holds an entitlement Apple grants
    /// case by case, so using it would file every device anyone ever paired
    /// under the same indistinguishable name. Asking is both more honest and
    /// more useful, and the model is only the starting suggestion.
    static var name: String {
        get {
            let stored = UserDefaults.standard.string(forKey: nameKey)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if let stored, !stored.isEmpty { return stored }
            return defaultName
        }
        set {
            let trimmed = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
            UserDefaults.standard.set(trimmed.isEmpty ? nil : trimmed, forKey: nameKey)
        }
    }

    /// "iPhone" or "iPad", plus enough of the identifier to tell two apart.
    @MainActor
    static var defaultName: String {
        let model = UIDevice.current.model
        let suffix = String(id.prefix(4))
        return "\(model) \(suffix)"
    }
}
