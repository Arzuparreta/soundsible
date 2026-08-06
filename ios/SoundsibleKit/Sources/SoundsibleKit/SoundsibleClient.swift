import Foundation

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Everything the phone asks of a Soundsible engine.
///
/// The client is deliberately thin: the engine already ranks, plans and resolves,
/// so this type carries requests and decodes answers and holds no opinion about
/// what the library means.
public actor SoundsibleClient {
    private let transport: HTTPTransport
    private let tokenStore: TokenStore
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    public init(transport: HTTPTransport, tokenStore: TokenStore) {
        self.transport = transport
        self.tokenStore = tokenStore
        self.decoder = JSONDecoder()
        self.encoder = JSONEncoder()
    }

    public var connection: ServerConnection? {
        tokenStore.load()
    }

    // MARK: - Browse

    public func home() async throws -> CarItemsResponse {
        try await get("/api/car/home")
    }

    /// Children of one browse node.
    ///
    /// The id can carry a slash (`playlist:Road Trip`), and the engine routes it
    /// through a `<path:item_id>` converter, so it is percent-encoded here
    /// against the path-allowed set rather than passed through raw.
    public func items(_ itemID: String) async throws -> CarItemsResponse {
        let encoded = itemID.addingPercentEncoding(
            withAllowedCharacters: .soundsiblePathSegment
        ) ?? itemID
        return try await get("/api/car/items/\(encoded)")
    }

    // MARK: - Presence and playback state

    @discardableResult
    public func registerDevice(_ registration: DeviceRegistration) async throws -> Bool {
        _ = try await send(
            "POST",
            "/api/devices/register",
            body: try encoder.encode(registration)
        )
        return true
    }

    @discardableResult
    public func publishPlaybackState(_ state: RemotePlaybackState) async throws -> Bool {
        _ = try await send("PUT", "/api/playback/state", body: try encoder.encode(state))
        return true
    }

    /// Confirm the stored credential is still good.
    ///
    /// Used on launch: a revoked device should say so plainly instead of failing
    /// one screen at a time.
    public func verifyPairing() async throws -> Bool {
        let (_, response) = try await perform("GET", "/api/pairing/verify", body: nil)
        return response.statusCode == 200
    }

    // MARK: - Pairing

    /// Claim a visible pairing code.
    ///
    /// When the owner has the QR sheet open with auto-confirm on, the engine
    /// answers 201 with the token and pairing is done. Otherwise it answers 200
    /// and the session waits for the owner — a state this app cannot resolve,
    /// because the plaintext token is handed to whoever confirms and is never
    /// stored. `PairingCoordinator` turns that into an explicit instruction
    /// rather than a spinner that never ends.
    public func claimPairingCode(
        baseURL: URL,
        code: String,
        deviceName: String
    ) async throws -> PairingClaim {
        struct ClaimBody: Encodable {
            let code: String
            let device_name: String
            let device_type: String
        }
        let body = try encoder.encode(
            ClaimBody(
                code: code.uppercased(),
                device_name: deviceName,
                device_type: "ios"
            )
        )
        var request = URLRequest(
            url: URL(string: "/api/pairing/sessions/claim", relativeTo: baseURL)!.absoluteURL
        )
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let (data, response) = try await transport.send(request)
        try Self.throwIfFailed(data: data, response: response, decoder: decoder)

        struct ClaimResponse: Decodable {
            let token: String?
            let id: String?
            let status: String?
        }
        let decoded = try decode(ClaimResponse.self, from: data)
        return PairingClaim(sessionID: decoded.id, status: decoded.status, token: decoded.token)
    }

    // MARK: - Plumbing

    private func get<T: Decodable>(_ path: String) async throws -> T {
        let (data, _) = try await perform("GET", path, body: nil)
        return try decode(T.self, from: data)
    }

    @discardableResult
    private func send(_ method: String, _ path: String, body: Data?) async throws -> Data {
        let (data, _) = try await perform(method, path, body: body)
        return data
    }

    private func perform(
        _ method: String,
        _ path: String,
        body: Data?
    ) async throws -> (Data, HTTPURLResponse) {
        guard let connection = tokenStore.load() else {
            throw SoundsibleError.notConfigured
        }
        guard let url = connection.resolve(path) else {
            throw SoundsibleError.transport("Could not build a URL for \(path)")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        if body != nil {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "Authorization")

        let (data, response) = try await transport.send(request)
        try Self.throwIfFailed(data: data, response: response, decoder: decoder)
        return (data, response)
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try decoder.decode(type, from: data)
        } catch {
            throw SoundsibleError.decoding(String(describing: error))
        }
    }

    static func throwIfFailed(
        data: Data,
        response: HTTPURLResponse,
        decoder: JSONDecoder
    ) throws {
        guard !(200..<300).contains(response.statusCode) else { return }
        if response.statusCode == 401 || response.statusCode == 403 {
            throw SoundsibleError.unauthorized
        }
        let message = (try? decoder.decode(ErrorBody.self, from: data))?.error ?? ""
        throw SoundsibleError.http(status: response.statusCode, message: message)
    }
}

extension CharacterSet {
    /// Path characters the engine's `<path:item_id>` converter accepts, minus the
    /// ones that would change which route matches.
    static let soundsiblePathSegment: CharacterSet = {
        var set = CharacterSet.urlPathAllowed
        set.remove(charactersIn: "?#")
        return set
    }()
}
