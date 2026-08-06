import Foundation
import Security
import SoundsibleKit

/// The paired-device credential, kept where a credential belongs.
///
/// `kSecAttrAccessibleAfterFirstUnlock` rather than the stricter
/// `WhenUnlocked` on purpose: the app has to be able to keep playing, and to
/// resume after a reboot in a car dock, without somebody unlocking the phone
/// first.
nonisolated final class KeychainTokenStore: TokenStore, @unchecked Sendable {
    private let service = "com.soundsible.player.connection"
    private let account = "paired-device"
    private let lock = NSLock()
    private var cached: ServerConnection?
    private var cacheLoaded = false

    func load() -> ServerConnection? {
        lock.lock()
        defer { lock.unlock() }
        if cacheLoaded { return cached }

        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        cacheLoaded = true
        guard status == errSecSuccess, let data = result as? Data else {
            cached = nil
            return nil
        }
        cached = try? JSONDecoder().decode(ServerConnection.self, from: data)
        return cached
    }

    func save(_ connection: ServerConnection) throws {
        let data = try JSONEncoder().encode(connection)

        lock.lock()
        defer { lock.unlock() }

        let query = baseQuery()
        let attributes: [String: Any] = [kSecValueData as String: data]

        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var insert = query
            insert[kSecValueData as String] = data
            insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            status = SecItemAdd(insert as CFDictionary, nil)
        }
        guard status == errSecSuccess else {
            throw SoundsibleError.transport("Could not store the credential (\(status)).")
        }
        cached = connection
        cacheLoaded = true
    }

    func clear() throws {
        lock.lock()
        defer { lock.unlock() }

        let status = SecItemDelete(baseQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw SoundsibleError.transport("Could not clear the credential (\(status)).")
        }
        cached = nil
        cacheLoaded = true
    }

    private func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}
