import Foundation
import SoundsibleKit
import SwiftUI

/// Whether we have a Soundsible to talk to, and what it says.
@MainActor
@Observable
final class AppModel {
    enum Phase: Equatable {
        case checking
        case unpaired
        case paired(ServerConnection)
    }

    private(set) var phase: Phase = .checking
    var lastError: String?

    let tokenStore: TokenStore
    let client: SoundsibleClient
    let offline: OfflineStore
    let player: PlayerModel

    // Not `lazy`: `@Observable` turns stored properties into computed ones
    // with init accessors, which `lazy` cannot coexist with. Rebuilding a
    // struct that holds two references is free.
    private var coordinator: PairingCoordinator {
        PairingCoordinator(client: client, tokenStore: tokenStore)
    }

    init(tokenStore: TokenStore = KeychainTokenStore()) {
        self.tokenStore = tokenStore
        self.client = SoundsibleClient(
            transport: URLSessionTransport(),
            tokenStore: tokenStore
        )
        let offline = OfflineStore()
        self.offline = offline
        self.player = PlayerModel(offline: offline)
    }

    /// Decide on launch whether the stored credential still works.
    ///
    /// A revoked device has to say so once, plainly, instead of failing on every
    /// screen it opens.
    func start() async {
        guard let connection = tokenStore.load() else {
            phase = .unpaired
            return
        }
        // Optimistic: a phone in a garage with no signal should still reach its
        // downloaded music instead of being thrown back to the pairing screen.
        adopt(connection)

        do {
            if try await client.verifyPairing() == false {
                await unpair()
                lastError = "This device is no longer paired with your Soundsible."
            }
        } catch SoundsibleError.unauthorized {
            await unpair()
            lastError = "This device is no longer paired with your Soundsible."
        } catch {
            // Anything else is the network, not the credential.
        }
    }

    func pair(baseURL: URL, code: String) async -> Bool {
        await attempt {
            try await self.coordinator.pair(
                baseURL: baseURL,
                code: code,
                deviceName: DeviceIdentity.name
            )
        }
    }

    func pairManually(baseURL: URL, token: String) async -> Bool {
        await attempt {
            try await self.coordinator.pairManually(baseURL: baseURL, token: token)
        }
    }

    func unpair() async {
        player.detach()
        try? tokenStore.clear()
        phase = .unpaired
    }

    private func attempt(_ work: () async throws -> PairingOutcome) async -> Bool {
        lastError = nil
        do {
            switch try await work() {
            case let .paired(connection):
                adopt(connection)
                return true
            case .awaitingOwnerConfirmation:
                lastError = """
                    Your Soundsible accepted the code but is waiting for you to \
                    confirm. Open the pairing sheet on your Soundsible and scan \
                    again — that turns on the confirmation this app needs.
                    """
                return false
            }
        } catch {
            lastError = (error as? LocalizedError)?.errorDescription
                ?? error.localizedDescription
            return false
        }
    }

    private func adopt(_ connection: ServerConnection) {
        phase = .paired(connection)
        player.attach(connection: connection, client: client)
    }
}
