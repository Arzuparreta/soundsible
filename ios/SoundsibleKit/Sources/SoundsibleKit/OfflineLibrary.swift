import Foundation

/// One track held on the phone.
public struct OfflineTrack: Codable, Equatable, Sendable {
    public let trackID: String
    public let filename: String
    public let byteSize: Int64
    public var lastPlayedAt: Date?
    public let downloadedAt: Date
    /// Collections that asked for this track. A track survives until the last
    /// one lets go, so removing one playlist never deletes a track another
    /// playlist still wants.
    public var pinnedBy: Set<String>

    public init(
        trackID: String,
        filename: String,
        byteSize: Int64,
        downloadedAt: Date,
        lastPlayedAt: Date? = nil,
        pinnedBy: Set<String> = []
    ) {
        self.trackID = trackID
        self.filename = filename
        self.byteSize = byteSize
        self.downloadedAt = downloadedAt
        self.lastPlayedAt = lastPlayedAt
        self.pinnedBy = pinnedBy
    }
}

/// What is on the phone, what should be, and what has to go.
///
/// Pure bookkeeping — it never touches the filesystem. The app layer performs
/// the downloads and deletions this decides on, which is what makes the policy
/// testable on Linux instead of only on a device with a full disk.
public struct OfflineLibrary: Equatable, Sendable {
    public private(set) var tracks: [String: OfflineTrack]
    /// Ceiling in bytes, or `nil` for "use what you need".
    public var byteBudget: Int64?

    public init(tracks: [OfflineTrack] = [], byteBudget: Int64? = nil) {
        self.tracks = Dictionary(uniqueKeysWithValues: tracks.map { ($0.trackID, $0) })
        self.byteBudget = byteBudget
    }

    public var usedBytes: Int64 {
        tracks.values.reduce(0) { $0 + $1.byteSize }
    }

    public func isAvailableOffline(_ trackID: String) -> Bool {
        tracks[trackID] != nil
    }

    public func filename(for trackID: String) -> String? {
        tracks[trackID]?.filename
    }

    // MARK: - Pinning

    /// Which of `items` still need fetching for this collection.
    ///
    /// Already-held tracks are pinned in place rather than re-downloaded, so
    /// pinning a playlist that overlaps another costs only the difference.
    public mutating func pin(
        collectionID: String,
        items: [CarItem]
    ) -> [CarItem] {
        var missing: [CarItem] = []
        for item in items where item.isPlayable {
            guard let trackID = item.trackID ?? (item.kind == "track" ? item.id : nil) else {
                continue
            }
            if var held = tracks[trackID] {
                held.pinnedBy.insert(collectionID)
                tracks[trackID] = held
            } else {
                missing.append(item)
            }
        }
        return missing
    }

    /// Record a finished download.
    public mutating func store(
        trackID: String,
        filename: String,
        byteSize: Int64,
        collectionID: String,
        now: Date = Date()
    ) {
        if var held = tracks[trackID] {
            held.pinnedBy.insert(collectionID)
            tracks[trackID] = held
            return
        }
        tracks[trackID] = OfflineTrack(
            trackID: trackID,
            filename: filename,
            byteSize: byteSize,
            downloadedAt: now,
            pinnedBy: [collectionID]
        )
    }

    /// Release a collection and report the tracks nothing wants any more.
    @discardableResult
    public mutating func unpin(collectionID: String) -> [OfflineTrack] {
        var orphaned: [OfflineTrack] = []
        for (trackID, track) in tracks {
            guard track.pinnedBy.contains(collectionID) else { continue }
            var updated = track
            updated.pinnedBy.remove(collectionID)
            if updated.pinnedBy.isEmpty {
                orphaned.append(updated)
                tracks.removeValue(forKey: trackID)
            } else {
                tracks[trackID] = updated
            }
        }
        return orphaned
    }

    public mutating func markPlayed(_ trackID: String, at date: Date = Date()) {
        guard var held = tracks[trackID] else { return }
        held.lastPlayedAt = date
        tracks[trackID] = held
    }

    // MARK: - Budget

    /// Evict until the library fits its budget, and report what to delete.
    ///
    /// Least-recently-touched first, and a track that has never been played
    /// counts as last touched when it was downloaded. Tracks pinned by a
    /// collection are never evicted — the person asked for those explicitly, and
    /// silently deleting them is how an offline library stops being trustworthy.
    public mutating func evictToFitBudget(now: Date = Date()) -> [OfflineTrack] {
        guard let byteBudget, usedBytes > byteBudget else { return [] }

        let evictable = tracks.values
            .filter { $0.pinnedBy.isEmpty }
            .sorted { lhs, rhs in
                (lhs.lastPlayedAt ?? lhs.downloadedAt) < (rhs.lastPlayedAt ?? rhs.downloadedAt)
            }

        var evicted: [OfflineTrack] = []
        var used = usedBytes
        for candidate in evictable where used > byteBudget {
            tracks.removeValue(forKey: candidate.trackID)
            used -= candidate.byteSize
            evicted.append(candidate)
        }
        return evicted
    }
}
