import Foundation

/// Where a Soundsible lives and how this device proves it is allowed in.
public struct ServerConnection: Codable, Equatable, Sendable {
    public var baseURL: URL
    public var token: String
    /// Human name of the instance, only ever used to label the UI.
    public var label: String

    public init(baseURL: URL, token: String, label: String = "Soundsible") {
        self.baseURL = baseURL
        self.token = token
        self.label = label
    }

    /// Resolve a path the engine handed us against this server.
    ///
    /// The car contract returns *relative* URLs (`/api/static/stream/<id>`), and
    /// an absolute one would be wrong the moment the same library is reached
    /// over Tailscale instead of the LAN. Absolute inputs are passed through so
    /// a future engine that starts returning them does not break the app.
    public func resolve(_ path: String) -> URL? {
        if let absolute = URL(string: path), absolute.scheme != nil {
            return absolute
        }
        return URL(string: path, relativeTo: baseURL)?.absoluteURL
    }
}

/// Where the paired-device token is kept.
///
/// On iOS this is the Keychain. In tests, and on Linux where there is no
/// Keychain at all, it is a dictionary. The kit never knows which.
public protocol TokenStore: AnyObject, Sendable {
    func load() -> ServerConnection?
    func save(_ connection: ServerConnection) throws
    func clear() throws
}

public final class InMemoryTokenStore: TokenStore, @unchecked Sendable {
    private let lock = NSLock()
    private var connection: ServerConnection?

    public init(connection: ServerConnection? = nil) {
        self.connection = connection
    }

    public func load() -> ServerConnection? {
        lock.lock()
        defer { lock.unlock() }
        return connection
    }

    public func save(_ connection: ServerConnection) throws {
        lock.lock()
        defer { lock.unlock() }
        self.connection = connection
    }

    public func clear() throws {
        lock.lock()
        defer { lock.unlock() }
        connection = nil
    }
}
