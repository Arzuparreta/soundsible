import Foundation

/// One row of the car browse tree.
///
/// The engine returns exactly this shape for every node — collection or track —
/// from `/api/car/home` and `/api/car/items/<id>`. See `shared/api/routes/car.py`.
/// Keeping one shape is what lets the browser be a single generic list view
/// rather than a screen per collection.
public struct CarItem: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let kind: String
    public let trackID: String?
    public let title: String
    public let subtitle: String
    public let artist: String
    public let album: String
    public let durationSec: Int?
    public let artworkURL: String?
    public let streamURL: String?
    public let isBrowsable: Bool
    public let isPlayable: Bool

    enum CodingKeys: String, CodingKey {
        case id
        case kind
        case trackID = "track_id"
        case title
        case subtitle
        case artist
        case album
        case durationSec = "duration_sec"
        case artworkURL = "artwork_url"
        case streamURL = "stream_url"
        case isBrowsable = "is_browsable"
        case isPlayable = "is_playable"
    }

    public init(
        id: String,
        kind: String,
        trackID: String? = nil,
        title: String,
        subtitle: String = "",
        artist: String = "",
        album: String = "",
        durationSec: Int? = nil,
        artworkURL: String? = nil,
        streamURL: String? = nil,
        isBrowsable: Bool = false,
        isPlayable: Bool = false
    ) {
        self.id = id
        self.kind = kind
        self.trackID = trackID
        self.title = title
        self.subtitle = subtitle
        self.artist = artist
        self.album = album
        self.durationSec = durationSec
        self.artworkURL = artworkURL
        self.streamURL = streamURL
        self.isBrowsable = isBrowsable
        self.isPlayable = isPlayable
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        kind = try container.decodeIfPresent(String.self, forKey: .kind) ?? "track"
        trackID = try container.decodeIfPresent(String.self, forKey: .trackID)
        title = try container.decodeIfPresent(String.self, forKey: .title) ?? "Untitled"
        subtitle = try container.decodeIfPresent(String.self, forKey: .subtitle) ?? ""
        artist = try container.decodeIfPresent(String.self, forKey: .artist) ?? ""
        album = try container.decodeIfPresent(String.self, forKey: .album) ?? ""
        durationSec = try container.decodeIfPresent(Int.self, forKey: .durationSec)
        artworkURL = try container.decodeIfPresent(String.self, forKey: .artworkURL)
        streamURL = try container.decodeIfPresent(String.self, forKey: .streamURL)
        isBrowsable = try container.decodeIfPresent(Bool.self, forKey: .isBrowsable) ?? false
        isPlayable = try container.decodeIfPresent(Bool.self, forKey: .isPlayable) ?? false
    }
}

/// Response of `/api/car/home` and `/api/car/items/<id>`.
///
/// `playbackState` only arrives on `recently-played`; every other node omits it.
public struct CarItemsResponse: Codable, Equatable, Sendable {
    public let id: String?
    public let title: String?
    public let items: [CarItem]
    public let status: String?
    public let playbackState: RemotePlaybackState?

    enum CodingKeys: String, CodingKey {
        case id, title, items, status
        case playbackState = "playback_state"
    }
}

/// The engine's view of what a device is playing.
///
/// Everything is optional because this doubles as the shape the app *writes*
/// back to `PUT /api/playback/state`, where a partial update is normal.
public struct RemotePlaybackState: Codable, Equatable, Sendable {
    public var trackID: String?
    public var positionSec: Double?
    public var isPlaying: Bool?
    public var deviceID: String?

    enum CodingKeys: String, CodingKey {
        case trackID = "track_id"
        case positionSec = "position_sec"
        case isPlaying = "is_playing"
        case deviceID = "device_id"
    }

    public init(
        trackID: String? = nil,
        positionSec: Double? = nil,
        isPlaying: Bool? = nil,
        deviceID: String? = nil
    ) {
        self.trackID = trackID
        self.positionSec = positionSec
        self.isPlaying = isPlaying
        self.deviceID = deviceID
    }
}

/// A pairing session as the engine reports it (`shared/api/routes/pairing.py`).
public struct PairingClaim: Codable, Equatable, Sendable {
    public let sessionID: String?
    public let status: String?
    public let token: String?

    enum CodingKeys: String, CodingKey {
        case sessionID = "session_id"
        case status
        case token
    }

    public init(sessionID: String?, status: String?, token: String?) {
        self.sessionID = sessionID
        self.status = status
        self.token = token
    }
}

/// What `POST /api/devices/register` needs to know about this phone.
public struct DeviceRegistration: Codable, Equatable, Sendable {
    public let deviceID: String
    public let deviceName: String
    public let deviceType: String

    enum CodingKeys: String, CodingKey {
        case deviceID = "device_id"
        case deviceName = "device_name"
        case deviceType = "device_type"
    }

    public init(deviceID: String, deviceName: String, deviceType: String = "ios") {
        self.deviceID = deviceID
        self.deviceName = deviceName
        self.deviceType = deviceType
    }
}
