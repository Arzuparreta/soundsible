import Foundation

public enum RepeatMode: String, Codable, Sendable, CaseIterable {
    case off
    /// Wrap around at the end of the queue.
    case all
    /// Replay the current track forever.
    case one
}

/// The order things will sound in, and where we are in it.
///
/// Pure value semantics on purpose: it is the piece most likely to be wrong in a
/// way nobody notices until a car is halfway through a tunnel, and it is the
/// piece that costs nothing to test exhaustively on Linux.
public struct PlayQueue: Equatable, Sendable {
    /// Every playable item, in the order they were handed to us.
    public private(set) var items: [CarItem]
    /// Index into `items` of what is sounding, or `nil` when the queue is empty.
    public private(set) var currentIndex: Int?
    public var repeatMode: RepeatMode
    public private(set) var isShuffled: Bool

    /// The shuffled walk over `items`, as indices. Empty when not shuffled.
    ///
    /// Shuffle reorders *playback*, never the queue itself: the list a person
    /// sees must not rearrange under them because they pressed shuffle.
    private var shuffleOrder: [Int]

    public init(
        items: [CarItem] = [],
        startIndex: Int? = nil,
        repeatMode: RepeatMode = .off
    ) {
        let playable = items.filter(\.isPlayable)
        self.items = playable
        self.repeatMode = repeatMode
        self.isShuffled = false
        self.shuffleOrder = []
        if let startIndex, playable.indices.contains(startIndex) {
            self.currentIndex = startIndex
        } else {
            self.currentIndex = playable.isEmpty ? nil : 0
        }
    }

    public var current: CarItem? {
        guard let currentIndex, items.indices.contains(currentIndex) else { return nil }
        return items[currentIndex]
    }

    public var isEmpty: Bool { items.isEmpty }
    public var count: Int { items.count }

    /// What follows the current item without moving to it.
    ///
    /// The audio layer needs this to preload the next file *before* the current
    /// one ends — a gap between tracks is the one artefact a car makes obvious.
    public var upNext: CarItem? {
        guard let index = indexAfterCurrent(advancing: false) else { return nil }
        return items[index]
    }

    // MARK: - Moving

    /// Advance as if the current track ran out.
    ///
    /// `.one` repeats in this path because that is what "repeat one" means when
    /// a track *ends*; pressing next explicitly is `skipForward()`, which
    /// deliberately ignores it.
    @discardableResult
    public mutating func advanceAfterPlaybackEnded() -> CarItem? {
        if repeatMode == .one { return current }
        return skipForward()
    }

    @discardableResult
    public mutating func skipForward() -> CarItem? {
        guard let next = indexAfterCurrent(advancing: true) else {
            // Falling off a non-repeating queue stops on the last track rather
            // than clearing it, so the player still shows what just played.
            return nil
        }
        currentIndex = next
        return current
    }

    /// Go back, or restart the current track.
    ///
    /// `positionSec` is what a person expects from a previous button: past a few
    /// seconds into a track it restarts that track instead of leaving it.
    @discardableResult
    public mutating func skipBackward(positionSec: Double = 0) -> CarItem? {
        if positionSec > 3 { return current }
        guard let currentIndex else { return nil }
        if currentIndex > 0 {
            self.currentIndex = currentIndex - 1
        } else if repeatMode == .all, !items.isEmpty {
            self.currentIndex = items.count - 1
        }
        return current
    }

    public mutating func jump(to index: Int) {
        guard items.indices.contains(index) else { return }
        currentIndex = index
    }

    // MARK: - Editing

    public mutating func append(contentsOf newItems: [CarItem]) {
        let playable = newItems.filter(\.isPlayable)
        guard !playable.isEmpty else { return }
        let firstNew = items.count
        items.append(contentsOf: playable)
        if isShuffled {
            shuffleOrder.append(contentsOf: (firstNew..<items.count).shuffled())
        }
        if currentIndex == nil { currentIndex = 0 }
    }

    /// Put items directly after the current one, keeping their relative order.
    public mutating func playNext(_ newItems: [CarItem]) {
        let playable = newItems.filter(\.isPlayable)
        guard !playable.isEmpty else { return }
        guard let currentIndex else {
            append(contentsOf: playable)
            return
        }
        items.insert(contentsOf: playable, at: currentIndex + 1)
        if isShuffled { rebuildShuffleOrder() }
    }

    public mutating func remove(at index: Int) {
        guard items.indices.contains(index) else { return }
        items.remove(at: index)
        if items.isEmpty {
            currentIndex = nil
            shuffleOrder = []
            return
        }
        if let current = currentIndex {
            if index < current {
                currentIndex = current - 1
            } else if index == current {
                currentIndex = min(current, items.count - 1)
            }
        }
        if isShuffled { rebuildShuffleOrder() }
    }

    // MARK: - Shuffle

    /// Turn shuffle on, keeping the current track where it is.
    ///
    /// Reshuffling from the current position rather than from the top is what
    /// stops the track you are listening to from restarting when you press it.
    public mutating func setShuffled(_ shuffled: Bool) {
        guard shuffled != isShuffled else { return }
        isShuffled = shuffled
        if shuffled {
            rebuildShuffleOrder()
        } else {
            shuffleOrder = []
        }
    }

    private mutating func rebuildShuffleOrder() {
        guard isShuffled else { return }
        var remaining = Array(items.indices)
        if let currentIndex, let position = remaining.firstIndex(of: currentIndex) {
            remaining.remove(at: position)
            shuffleOrder = [currentIndex] + remaining.shuffled()
        } else {
            shuffleOrder = remaining.shuffled()
        }
    }

    /// Next index in play order, or `nil` when there is nowhere to go.
    private func indexAfterCurrent(advancing: Bool) -> Int? {
        guard !items.isEmpty, let currentIndex else { return nil }

        if isShuffled {
            guard let position = shuffleOrder.firstIndex(of: currentIndex) else { return nil }
            let nextPosition = position + 1
            if nextPosition < shuffleOrder.count { return shuffleOrder[nextPosition] }
            return repeatMode == .all ? shuffleOrder.first : nil
        }

        let next = currentIndex + 1
        if next < items.count { return next }
        return repeatMode == .all ? 0 : nil
    }
}
