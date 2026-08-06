import XCTest
@testable import SoundsibleKit

private func track(_ id: String) -> CarItem {
    CarItem(
        id: id,
        kind: "track",
        trackID: id,
        title: id.uppercased(),
        streamURL: "/api/static/stream/\(id)",
        isPlayable: true
    )
}

private func collection(_ id: String) -> CarItem {
    CarItem(id: id, kind: "collection", title: id, isBrowsable: true, isPlayable: false)
}

final class PlayQueueTests: XCTestCase {
    func testQueueKeepsOnlyPlayableItems() {
        let queue = PlayQueue(items: [collection("playlists"), track("a"), collection("radio"), track("b")])

        XCTAssertEqual(queue.items.map(\.id), ["a", "b"])
        XCTAssertEqual(queue.current?.id, "a")
    }

    func testEmptyQueueHasNoCurrent() {
        let queue = PlayQueue(items: [collection("playlists")])

        XCTAssertTrue(queue.isEmpty)
        XCTAssertNil(queue.current)
        XCTAssertNil(queue.upNext)
    }

    func testStartIndexOutOfRangeFallsBackToFirst() {
        let queue = PlayQueue(items: [track("a"), track("b")], startIndex: 9)

        XCTAssertEqual(queue.current?.id, "a")
    }

    // MARK: - Advancing

    func testSkipForwardStopsAtTheEndWithoutRepeat() {
        var queue = PlayQueue(items: [track("a"), track("b")])

        XCTAssertEqual(queue.skipForward()?.id, "b")
        XCTAssertNil(queue.skipForward())
        XCTAssertEqual(queue.current?.id, "b", "Falling off the end must not clear the player")
    }

    func testRepeatAllWrapsAround() {
        var queue = PlayQueue(items: [track("a"), track("b")], repeatMode: .all)
        queue.jump(to: 1)

        XCTAssertEqual(queue.skipForward()?.id, "a")
    }

    func testRepeatOneRepliesOnlyWhenPlaybackEnds() {
        var queue = PlayQueue(items: [track("a"), track("b")], repeatMode: .one)

        XCTAssertEqual(queue.advanceAfterPlaybackEnded()?.id, "a")
        XCTAssertEqual(
            queue.skipForward()?.id,
            "b",
            "Pressing next is an explicit instruction and outranks repeat-one"
        )
    }

    func testUpNextDoesNotMoveTheQueue() {
        var queue = PlayQueue(items: [track("a"), track("b")])

        XCTAssertEqual(queue.upNext?.id, "b")
        XCTAssertEqual(queue.current?.id, "a")

        queue.repeatMode = .off
        queue.jump(to: 1)
        XCTAssertNil(queue.upNext)
    }

    // MARK: - Previous

    func testSkipBackwardRestartsTrackPastThreeSeconds() {
        var queue = PlayQueue(items: [track("a"), track("b")])
        queue.jump(to: 1)

        XCTAssertEqual(queue.skipBackward(positionSec: 12)?.id, "b")
        XCTAssertEqual(queue.skipBackward(positionSec: 1)?.id, "a")
    }

    func testSkipBackwardAtStartStaysUnlessRepeatingAll() {
        var queue = PlayQueue(items: [track("a"), track("b")])
        XCTAssertEqual(queue.skipBackward()?.id, "a")

        queue.repeatMode = .all
        XCTAssertEqual(queue.skipBackward()?.id, "b")
    }

    // MARK: - Editing

    func testPlayNextInsertsAfterCurrentPreservingOrder() {
        var queue = PlayQueue(items: [track("a"), track("b")])
        queue.playNext([track("x"), track("y")])

        XCTAssertEqual(queue.items.map(\.id), ["a", "x", "y", "b"])
        XCTAssertEqual(queue.current?.id, "a")
    }

    func testRemovingBeforeCurrentKeepsTheSameTrackPlaying() {
        var queue = PlayQueue(items: [track("a"), track("b"), track("c")])
        queue.jump(to: 2)

        queue.remove(at: 0)

        XCTAssertEqual(queue.current?.id, "c")
    }

    func testRemovingCurrentMovesToWhatTookItsPlace() {
        var queue = PlayQueue(items: [track("a"), track("b"), track("c")])
        queue.jump(to: 1)

        queue.remove(at: 1)

        XCTAssertEqual(queue.current?.id, "c")
    }

    func testRemovingLastRemainingClearsCurrent() {
        var queue = PlayQueue(items: [track("a")])
        queue.remove(at: 0)

        XCTAssertNil(queue.current)
        XCTAssertTrue(queue.isEmpty)
    }

    func testAppendStartsPlaybackOnAPreviouslyEmptyQueue() {
        var queue = PlayQueue()
        XCTAssertNil(queue.current)

        queue.append(contentsOf: [track("a")])

        XCTAssertEqual(queue.current?.id, "a")
    }

    // MARK: - Shuffle

    func testShuffleKeepsTheVisibleOrderAndTheCurrentTrack() {
        var queue = PlayQueue(items: (0..<25).map { track("t\($0)") })
        queue.jump(to: 7)

        queue.setShuffled(true)

        XCTAssertEqual(queue.items.map(\.id), (0..<25).map { "t\($0)" })
        XCTAssertEqual(queue.current?.id, "t7", "Shuffling must not restart the current track")
    }

    func testShuffleVisitsEveryTrackExactlyOnce() {
        var queue = PlayQueue(items: (0..<25).map { track("t\($0)") })
        queue.setShuffled(true)

        var seen = [queue.current!.id]
        while let next = queue.skipForward() {
            seen.append(next.id)
        }

        XCTAssertEqual(seen.count, 25)
        XCTAssertEqual(Set(seen).count, 25, "A shuffled pass must not repeat or drop a track")
    }

    func testShuffleWithRepeatAllWrapsToTheStartOfTheShuffledWalk() {
        var queue = PlayQueue(items: (0..<5).map { track("t\($0)") }, repeatMode: .all)
        queue.setShuffled(true)
        let first = queue.current!.id

        for _ in 0..<4 { _ = queue.skipForward() }

        XCTAssertEqual(queue.skipForward()?.id, first)
    }

    func testTurningShuffleOffRestoresLinearOrderFromCurrent() {
        var queue = PlayQueue(items: (0..<10).map { track("t\($0)") })
        queue.setShuffled(true)
        queue.setShuffled(false)
        queue.jump(to: 3)

        XCTAssertEqual(queue.skipForward()?.id, "t4")
    }

    func testAppendingWhileShuffledStillReachesTheNewTracks() {
        var queue = PlayQueue(items: (0..<3).map { track("t\($0)") })
        queue.setShuffled(true)
        queue.append(contentsOf: [track("new1"), track("new2")])

        var seen = [queue.current!.id]
        while let next = queue.skipForward() { seen.append(next.id) }

        XCTAssertEqual(Set(seen).count, 5)
        XCTAssertTrue(seen.contains("new1"))
        XCTAssertTrue(seen.contains("new2"))
    }
}
