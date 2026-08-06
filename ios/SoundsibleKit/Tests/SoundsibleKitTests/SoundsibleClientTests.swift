import XCTest
@testable import SoundsibleKit

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Answers canned responses and records what was asked.
final class StubTransport: HTTPTransport, @unchecked Sendable {
    struct Exchange {
        let status: Int
        let body: Data
    }

    private let lock = NSLock()
    private var queued: [Exchange]
    private(set) var requests: [URLRequest] = []

    init(_ queued: [Exchange]) {
        self.queued = queued
    }

    convenience init(status: Int = 200, json: String) {
        self.init([Exchange(status: status, body: Data(json.utf8))])
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        lock.lock()
        requests.append(request)
        let exchange = queued.isEmpty ? Exchange(status: 500, body: Data()) : queued.removeFirst()
        lock.unlock()

        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: exchange.status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        return (exchange.body, response)
    }
}

private func makeStore(
    base: String = "http://soundsible.local:5005",
    token: String = "tok"
) -> InMemoryTokenStore {
    InMemoryTokenStore(
        connection: ServerConnection(baseURL: URL(string: base)!, token: token)
    )
}

final class SoundsibleClientTests: XCTestCase {
    func testHomeDecodesTheCarContract() async throws {
        let transport = StubTransport(json: """
        {"items":[
          {"id":"favourites","kind":"collection","title":"Favourites","subtitle":"Saved tracks",
           "artist":"","album":"","duration_sec":null,"artwork_url":null,"stream_url":null,
           "is_browsable":true,"is_playable":false}
        ],"status":"ok"}
        """)
        let client = SoundsibleClient(transport: transport, tokenStore: makeStore())

        let home = try await client.home()

        XCTAssertEqual(home.items.count, 1)
        XCTAssertEqual(home.items[0].id, "favourites")
        XCTAssertTrue(home.items[0].isBrowsable)
        XCTAssertNil(home.items[0].streamURL)
    }

    func testRequestsCarryTheBearerTokenAndResolveAgainstTheBaseURL() async throws {
        let transport = StubTransport(json: #"{"items":[],"status":"ok"}"#)
        let client = SoundsibleClient(transport: transport, tokenStore: makeStore())

        _ = try await client.home()

        let request = transport.requests[0]
        XCTAssertEqual(
            request.url?.absoluteString,
            "http://soundsible.local:5005/api/car/home"
        )
        XCTAssertEqual(
            request.value(forHTTPHeaderField: "Authorization"),
            "Bearer tok"
        )
    }

    func testPlaylistIdentifiersWithSpacesAreEncodedIntoThePath() async throws {
        let transport = StubTransport(json: #"{"items":[],"status":"ok"}"#)
        let client = SoundsibleClient(transport: transport, tokenStore: makeStore())

        _ = try await client.items("playlist:Road Trip")

        XCTAssertEqual(
            transport.requests[0].url?.absoluteString,
            "http://soundsible.local:5005/api/car/items/playlist:Road%20Trip"
        )
    }

    func testTrackItemsDecodeRelativeStreamURLs() async throws {
        let transport = StubTransport(json: """
        {"id":"playlist:Road","title":"Road","items":[
          {"id":"t2","kind":"track","track_id":"t2","title":"Two","subtitle":"Artist - Album",
           "artist":"Artist","album":"Album","duration_sec":180,
           "artwork_url":"/api/static/cover/t2","stream_url":"/api/static/stream/t2",
           "is_browsable":false,"is_playable":true}
        ],"status":"ok"}
        """)
        let client = SoundsibleClient(transport: transport, tokenStore: makeStore())

        let response = try await client.items("playlist:Road")
        let item = response.items[0]

        XCTAssertEqual(item.trackID, "t2")
        XCTAssertEqual(item.durationSec, 180)
        XCTAssertEqual(item.streamURL, "/api/static/stream/t2")
        XCTAssertEqual(response.title, "Road")
    }

    func testRecentlyPlayedCarriesPlaybackState() async throws {
        let transport = StubTransport(json: """
        {"id":"recently-played","items":[],
         "playback_state":{"track_id":"t1","position_sec":42,"is_playing":true},
         "status":"ok"}
        """)
        let client = SoundsibleClient(transport: transport, tokenStore: makeStore())

        let response = try await client.items("recently-played")

        XCTAssertEqual(response.playbackState?.trackID, "t1")
        XCTAssertEqual(response.playbackState?.positionSec, 42)
        XCTAssertEqual(response.playbackState?.isPlaying, true)
    }

    // MARK: - Failures

    func testUnauthorizedIsDistinctFromOtherFailures() async {
        let transport = StubTransport(status: 401, json: #"{"error":"Authentication required"}"#)
        let client = SoundsibleClient(transport: transport, tokenStore: makeStore())

        do {
            _ = try await client.home()
            XCTFail("A 401 must not look like success")
        } catch {
            XCTAssertEqual(error as? SoundsibleError, .unauthorized)
        }
    }

    func testServerErrorMessageIsSurfaced() async {
        let transport = StubTransport(status: 404, json: #"{"error":"Playlist not found"}"#)
        let client = SoundsibleClient(transport: transport, tokenStore: makeStore())

        do {
            _ = try await client.items("playlist:Nope")
            XCTFail("A 404 must not look like success")
        } catch {
            XCTAssertEqual(
                error as? SoundsibleError,
                .http(status: 404, message: "Playlist not found")
            )
        }
    }

    func testWithoutAPairedServerNothingIsSent() async {
        let transport = StubTransport(json: "{}")
        let client = SoundsibleClient(transport: transport, tokenStore: InMemoryTokenStore())

        do {
            _ = try await client.home()
            XCTFail("An unpaired app must not reach the network")
        } catch {
            XCTAssertEqual(error as? SoundsibleError, .notConfigured)
            XCTAssertTrue(transport.requests.isEmpty)
        }
    }

    // MARK: - Writes

    func testDeviceRegistrationAnnouncesItselfAsIOS() async throws {
        let transport = StubTransport(json: "{}")
        let client = SoundsibleClient(transport: transport, tokenStore: makeStore())

        try await client.registerDevice(
            DeviceRegistration(deviceID: "abc", deviceName: "iPhone")
        )

        let request = transport.requests[0]
        XCTAssertEqual(request.httpMethod, "POST")
        let body = try XCTUnwrap(request.httpBody)
        let decoded = try JSONDecoder().decode(DeviceRegistration.self, from: body)
        XCTAssertEqual(decoded.deviceType, "ios")
        XCTAssertEqual(decoded.deviceID, "abc")
    }

    func testPlaybackStateIsPublishedAsAPut() async throws {
        let transport = StubTransport(json: "{}")
        let client = SoundsibleClient(transport: transport, tokenStore: makeStore())

        try await client.publishPlaybackState(
            RemotePlaybackState(trackID: "t1", positionSec: 12.5, isPlaying: true, deviceID: "abc")
        )

        let request = transport.requests[0]
        XCTAssertEqual(request.httpMethod, "PUT")
        XCTAssertEqual(request.url?.path, "/api/playback/state")
        let json = try JSONSerialization.jsonObject(
            with: try XCTUnwrap(request.httpBody)
        ) as? [String: Any]
        XCTAssertEqual(json?["track_id"] as? String, "t1")
        XCTAssertEqual(json?["position_sec"] as? Double, 12.5)
    }
}

final class ServerConnectionTests: XCTestCase {
    func testRelativePathsResolveAgainstTheServerRoot() {
        let connection = ServerConnection(
            baseURL: URL(string: "http://100.64.0.1:5005")!,
            token: "t"
        )

        XCTAssertEqual(
            connection.resolve("/api/static/stream/t1")?.absoluteString,
            "http://100.64.0.1:5005/api/static/stream/t1"
        )
    }

    func testAbsoluteURLsArePassedThrough() {
        let connection = ServerConnection(
            baseURL: URL(string: "http://100.64.0.1:5005")!,
            token: "t"
        )

        XCTAssertEqual(
            connection.resolve("https://cdn.example.com/cover.jpg")?.absoluteString,
            "https://cdn.example.com/cover.jpg"
        )
    }

    func testBaseURLWithASubPathIsPreserved() {
        let connection = ServerConnection(
            baseURL: URL(string: "https://home.example.ts.net/soundsible/")!,
            token: "t"
        )

        XCTAssertEqual(
            connection.resolve("api/car/home")?.absoluteString,
            "https://home.example.ts.net/soundsible/api/car/home"
        )
    }
}
