import XCTest
@testable import SoundsibleKit

final class PairingPayloadTests: XCTestCase {
    private let qr = """
    {"type":"soundsible_pairing","version":1,"code":"AB12CD34",\
    "claim_url":"http://192.168.1.40:5005/api/pairing/sessions/claim",\
    "player_url":"http://192.168.1.40:5005/player/"}
    """

    func testParsesTheEngineQRPayload() throws {
        let payload = try XCTUnwrap(PairingPayload.parse(qr))

        XCTAssertEqual(payload.code, "AB12CD34")
        XCTAssertEqual(
            payload.baseURL?.absoluteString,
            "http://192.168.1.40:5005"
        )
    }

    func testFallsBackToPlayerURLWhenClaimURLIsMissing() throws {
        let payload = try XCTUnwrap(PairingPayload.parse("""
        {"type":"soundsible_pairing","version":1,"code":"X",\
        "player_url":"http://10.0.0.5:5005/player/"}
        """))

        XCTAssertEqual(payload.baseURL?.absoluteString, "http://10.0.0.5:5005")
    }

    func testRejectsBarcodesThatAreNotSoundsible() {
        XCTAssertNil(PairingPayload.parse("https://example.com"))
        XCTAssertNil(PairingPayload.parse(#"{"type":"other","code":"AB12"}"#))
        XCTAssertNil(PairingPayload.parse(#"{"type":"soundsible_pairing"}"#))
        XCTAssertNil(PairingPayload.parse(""))
    }
}

final class PairingCoordinatorTests: XCTestCase {
    private let base = URL(string: "http://192.168.1.40:5005")!

    func testAutoConfirmedClaimStoresTheCredential() async throws {
        let transport = StubTransport([
            .init(status: 201, body: Data(#"{"token":"paired-token","auto_confirmed":true}"#.utf8)),
        ])
        let store = InMemoryTokenStore()
        let client = SoundsibleClient(transport: transport, tokenStore: store)
        let coordinator = PairingCoordinator(client: client, tokenStore: store)

        let outcome = try await coordinator.pair(
            baseURL: base,
            code: "ab12cd34",
            deviceName: "iPhone"
        )

        guard case let .paired(connection) = outcome else {
            return XCTFail("Expected the pairing to complete, got \(outcome)")
        }
        XCTAssertEqual(connection.token, "paired-token")
        XCTAssertEqual(store.load()?.token, "paired-token")
    }

    func testCodeIsUppercasedBeforeItIsSent() async throws {
        let transport = StubTransport([
            .init(status: 201, body: Data(#"{"token":"t"}"#.utf8)),
        ])
        let store = InMemoryTokenStore()
        let coordinator = PairingCoordinator(
            client: SoundsibleClient(transport: transport, tokenStore: store),
            tokenStore: store
        )

        _ = try await coordinator.pair(baseURL: base, code: "ab12cd34", deviceName: "iPhone")

        let body = try XCTUnwrap(transport.requests[0].httpBody)
        let json = try JSONSerialization.jsonObject(with: body) as? [String: Any]
        XCTAssertEqual(json?["code"] as? String, "AB12CD34")
        XCTAssertEqual(json?["device_type"] as? String, "ios")
    }

    func testAClaimWithoutATokenReportsThatTheOwnerMustConfirm() async throws {
        // The engine answers 200 with the session when the pairing sheet is not
        // open. No token is ever coming to this device on that path.
        let transport = StubTransport([
            .init(status: 200, body: Data(#"{"id":"sess-1","status":"claimed"}"#.utf8)),
        ])
        let store = InMemoryTokenStore()
        let coordinator = PairingCoordinator(
            client: SoundsibleClient(transport: transport, tokenStore: store),
            tokenStore: store
        )

        let outcome = try await coordinator.pair(baseURL: base, code: "AB12", deviceName: "iPhone")

        XCTAssertEqual(outcome, .awaitingOwnerConfirmation)
        XCTAssertNil(store.load(), "Nothing usable arrived, so nothing must be stored")
    }

    func testExpiredCodeSurfacesTheServerMessage() async {
        let transport = StubTransport([
            .init(status: 404, body: Data(#"{"error":"Invalid or expired pairing code"}"#.utf8)),
        ])
        let store = InMemoryTokenStore()
        let coordinator = PairingCoordinator(
            client: SoundsibleClient(transport: transport, tokenStore: store),
            tokenStore: store
        )

        do {
            _ = try await coordinator.pair(baseURL: base, code: "NOPE", deviceName: "iPhone")
            XCTFail("An expired code must not pair")
        } catch {
            XCTAssertEqual(
                error as? SoundsibleError,
                .http(status: 404, message: "Invalid or expired pairing code")
            )
        }
    }

    // MARK: - Manual entry

    func testManualPairingVerifiesBeforeItCommits() async throws {
        let transport = StubTransport([.init(status: 200, body: Data(#"{"valid":true}"#.utf8))])
        let store = InMemoryTokenStore()
        let coordinator = PairingCoordinator(
            client: SoundsibleClient(transport: transport, tokenStore: store),
            tokenStore: store
        )

        let outcome = try await coordinator.pairManually(baseURL: base, token: "typed-token")

        guard case .paired = outcome else {
            return XCTFail("Expected the manual pairing to complete, got \(outcome)")
        }
        XCTAssertEqual(store.load()?.token, "typed-token")
        XCTAssertEqual(transport.requests[0].url?.path, "/api/pairing/verify")
    }

    func testARejectedManualTokenLeavesTheStoreUntouched() async {
        let transport = StubTransport([.init(status: 403, body: Data(#"{"error":"nope"}"#.utf8))])
        let store = InMemoryTokenStore()
        let previous = ServerConnection(baseURL: base, token: "still-good", label: "Home")
        try? store.save(previous)
        let coordinator = PairingCoordinator(
            client: SoundsibleClient(transport: transport, tokenStore: store),
            tokenStore: store
        )

        do {
            _ = try await coordinator.pairManually(baseURL: base, token: "typo")
            XCTFail("A rejected token must not pair")
        } catch {
            XCTAssertEqual(error as? SoundsibleError, .unauthorized)
            XCTAssertEqual(
                store.load()?.token,
                "still-good",
                "A failed attempt must not evict a working credential"
            )
        }
    }
}
