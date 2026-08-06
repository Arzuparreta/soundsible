import XCTest
@testable import SoundsibleKit

private func track(_ id: String) -> CarItem {
    CarItem(id: id, kind: "track", trackID: id, title: id, isPlayable: true)
}

final class OfflineLibraryTests: XCTestCase {
    func testPinReportsOnlyWhatIsMissing() {
        var library = OfflineLibrary()
        library.store(trackID: "a", filename: "a.mp3", byteSize: 100, collectionID: "playlist:One")

        let missing = library.pin(collectionID: "playlist:Two", items: [track("a"), track("b")])

        XCTAssertEqual(missing.map(\.id), ["b"])
        XCTAssertTrue(library.isAvailableOffline("a"))
    }

    func testATrackSurvivesUntilTheLastCollectionLetsGo() {
        var library = OfflineLibrary()
        library.store(trackID: "a", filename: "a.mp3", byteSize: 100, collectionID: "playlist:One")
        library.store(trackID: "a", filename: "a.mp3", byteSize: 100, collectionID: "playlist:Two")

        let firstRelease = library.unpin(collectionID: "playlist:One")
        XCTAssertTrue(firstRelease.isEmpty)
        XCTAssertTrue(library.isAvailableOffline("a"))

        let secondRelease = library.unpin(collectionID: "playlist:Two")
        XCTAssertEqual(secondRelease.map(\.trackID), ["a"])
        XCTAssertFalse(library.isAvailableOffline("a"))
    }

    func testUsedBytesCountsEveryHeldTrackOnce() {
        var library = OfflineLibrary()
        library.store(trackID: "a", filename: "a.mp3", byteSize: 100, collectionID: "one")
        library.store(trackID: "a", filename: "a.mp3", byteSize: 100, collectionID: "two")
        library.store(trackID: "b", filename: "b.mp3", byteSize: 50, collectionID: "one")

        XCTAssertEqual(library.usedBytes, 150)
    }

    // MARK: - Budget

    func testEvictionRemovesLeastRecentlyTouchedFirst() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        var library = OfflineLibrary(
            tracks: [
                OfflineTrack(
                    trackID: "old", filename: "old.mp3", byteSize: 100,
                    downloadedAt: now, lastPlayedAt: now.addingTimeInterval(-500)
                ),
                OfflineTrack(
                    trackID: "fresh", filename: "fresh.mp3", byteSize: 100,
                    downloadedAt: now, lastPlayedAt: now
                ),
            ],
            byteBudget: 150
        )

        let evicted = library.evictToFitBudget(now: now)

        XCTAssertEqual(evicted.map(\.trackID), ["old"])
        XCTAssertTrue(library.isAvailableOffline("fresh"))
    }

    func testNeverPlayedTracksAreRankedByDownloadDate() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        var library = OfflineLibrary(
            tracks: [
                OfflineTrack(trackID: "older", filename: "1", byteSize: 100, downloadedAt: now.addingTimeInterval(-900)),
                OfflineTrack(trackID: "newer", filename: "2", byteSize: 100, downloadedAt: now),
            ],
            byteBudget: 100
        )

        XCTAssertEqual(library.evictToFitBudget(now: now).map(\.trackID), ["older"])
    }

    func testPinnedTracksAreNeverEvicted() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        var library = OfflineLibrary(
            tracks: [
                OfflineTrack(
                    trackID: "pinned", filename: "1", byteSize: 500,
                    downloadedAt: now.addingTimeInterval(-10_000),
                    pinnedBy: ["playlist:Road"]
                ),
            ],
            byteBudget: 10
        )

        XCTAssertTrue(library.evictToFitBudget(now: now).isEmpty)
        XCTAssertTrue(
            library.isAvailableOffline("pinned"),
            "Deleting what somebody explicitly asked to keep offline breaks the feature"
        )
    }

    func testNoBudgetMeansNoEviction() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        var library = OfflineLibrary(
            tracks: [OfflineTrack(trackID: "a", filename: "1", byteSize: 10_000_000, downloadedAt: now)]
        )

        XCTAssertTrue(library.evictToFitBudget(now: now).isEmpty)
    }

    func testEvictionStopsAsSoonAsItFits() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        var library = OfflineLibrary(
            tracks: (0..<5).map {
                OfflineTrack(
                    trackID: "t\($0)", filename: "\($0)", byteSize: 100,
                    downloadedAt: now.addingTimeInterval(Double($0))
                )
            },
            byteBudget: 300
        )

        let evicted = library.evictToFitBudget(now: now)

        XCTAssertEqual(evicted.map(\.trackID), ["t0", "t1"])
        XCTAssertEqual(library.usedBytes, 300)
    }

    func testMarkPlayedProtectsARecentlyHeardTrack() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        var library = OfflineLibrary(
            tracks: [
                OfflineTrack(trackID: "a", filename: "1", byteSize: 100, downloadedAt: now.addingTimeInterval(-900)),
                OfflineTrack(trackID: "b", filename: "2", byteSize: 100, downloadedAt: now.addingTimeInterval(-800)),
            ],
            byteBudget: 100
        )
        library.markPlayed("a", at: now)

        XCTAssertEqual(library.evictToFitBudget(now: now).map(\.trackID), ["b"])
    }
}
