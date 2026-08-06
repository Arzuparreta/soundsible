import Foundation

/// What the QR code on the Soundsible pairing sheet actually contains.
///
/// The engine builds it in `_pairing_connect_payload` and encodes it as compact
/// JSON in `qr_text`. Parsing is defensive because a camera will happily hand us
/// any barcode on the table.
public struct PairingPayload: Equatable, Sendable {
    public let code: String
    public let claimURL: URL?
    public let playerURL: URL?

    public init(code: String, claimURL: URL?, playerURL: URL?) {
        self.code = code
        self.claimURL = claimURL
        self.playerURL = playerURL
    }

    /// The server root implied by the payload.
    ///
    /// `claim_url` is the engine's own best guess at a reachable base URL, so it
    /// is preferred; `player_url` is the fallback for older engines.
    public var baseURL: URL? {
        if let claimURL { return Self.trim(claimURL, suffix: "/api/pairing/sessions/claim") }
        if let playerURL { return Self.trim(playerURL, suffix: "/player/") }
        return nil
    }

    private static func trim(_ url: URL, suffix: String) -> URL? {
        let text = url.absoluteString
        guard text.hasSuffix(suffix) else {
            return URL(string: "/", relativeTo: url)?.absoluteURL
        }
        return URL(string: String(text.dropLast(suffix.count)))
    }

    /// Decode a scanned string, or return `nil` if it is not a Soundsible code.
    public static func parse(_ scanned: String) -> PairingPayload? {
        guard let data = scanned.data(using: .utf8) else { return nil }

        struct Raw: Decodable {
            let type: String?
            let code: String?
            let claim_url: String?
            let player_url: String?
        }
        guard let raw = try? JSONDecoder().decode(Raw.self, from: data) else { return nil }
        guard raw.type == "soundsible_pairing" else { return nil }
        guard let code = raw.code?.trimmingCharacters(in: .whitespacesAndNewlines),
              !code.isEmpty else { return nil }

        return PairingPayload(
            code: code,
            claimURL: raw.claim_url.flatMap(URL.init(string:)),
            playerURL: raw.player_url.flatMap(URL.init(string:))
        )
    }
}

/// Outcome of trying to pair, in the terms the UI has to explain.
public enum PairingOutcome: Equatable, Sendable {
    /// Done — the engine minted a token and it is stored.
    case paired(ServerConnection)
    /// The code was accepted but the owner still has to confirm on the Soundsible.
    ///
    /// This app cannot finish from here: the plaintext token is handed to
    /// whoever confirms and only its hash is kept, so there is nothing left for
    /// the phone to collect. Opening the pairing sheet on the server (which
    /// turns on auto-confirm) is the way through.
    case awaitingOwnerConfirmation
}

/// Drives the pairing screen.
public struct PairingCoordinator: Sendable {
    private let client: SoundsibleClient
    private let tokenStore: TokenStore

    public init(client: SoundsibleClient, tokenStore: TokenStore) {
        self.client = client
        self.tokenStore = tokenStore
    }

    /// Claim a code against a server and store the credential if one comes back.
    public func pair(
        baseURL: URL,
        code: String,
        deviceName: String,
        label: String = "Soundsible"
    ) async throws -> PairingOutcome {
        let claim = try await client.claimPairingCode(
            baseURL: baseURL,
            code: code,
            deviceName: deviceName
        )
        guard let token = claim.token, !token.isEmpty else {
            return .awaitingOwnerConfirmation
        }
        let connection = ServerConnection(baseURL: baseURL, token: token, label: label)
        try tokenStore.save(connection)
        return .paired(connection)
    }

    /// Accept a base URL and a token typed or pasted by hand.
    ///
    /// The fallback for every case the QR flow cannot reach: an engine whose
    /// pairing sheet is not open, a headless server, or a token the owner
    /// already holds. It is verified before being stored so a typo fails on the
    /// pairing screen instead of on the library screen.
    public func pairManually(
        baseURL: URL,
        token: String,
        label: String = "Soundsible"
    ) async throws -> PairingOutcome {
        let connection = ServerConnection(baseURL: baseURL, token: token, label: label)
        let previous = tokenStore.load()
        try tokenStore.save(connection)
        do {
            guard try await client.verifyPairing() else {
                throw SoundsibleError.unauthorized
            }
            return .paired(connection)
        } catch {
            if let previous {
                try? tokenStore.save(previous)
            } else {
                try? tokenStore.clear()
            }
            throw error
        }
    }
}
