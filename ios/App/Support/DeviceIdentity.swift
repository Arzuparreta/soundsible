import Foundation
import UIKit

/// Who this phone says it is to the engine.
///
/// The id has to survive relaunches or the device registry fills up with a new
/// row every time the app starts, and handoff starts targeting a device that no
/// longer exists.
enum DeviceIdentity {
    private static let key = "com.soundsible.player.device-id"

    static var id: String {
        if let existing = UserDefaults.standard.string(forKey: key) {
            return existing
        }
        let fresh = UUID().uuidString
        UserDefaults.standard.set(fresh, forKey: key)
        return fresh
    }

    @MainActor
    static var name: String {
        UIDevice.current.name
    }
}
