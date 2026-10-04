package com.soundsible.player.logic

import com.soundsible.player.data.CarItem

enum class RepeatMode { OFF, ALL, ONE }

/**
 * The order things will sound in, and where we are in it.
 *
 * Pure value semantics on purpose: the piece most likely to be wrong in a way
 * nobody notices until a car is halfway through a tunnel. Mirrors `PlayQueue`
 * in ios/SoundsibleKit, including its edge-case contract.
 */
class PlayQueue(
    items: List<CarItem> = emptyList(),
    startIndex: Int? = null,
    var repeatMode: RepeatMode = RepeatMode.OFF,
) {
    val items: MutableList<CarItem> = items.filter { it.isPlayable }.toMutableList()
    var currentIndex: Int? =
        if (startIndex != null && startIndex in this.items.indices) startIndex
        else if (this.items.isEmpty()) null else 0
        private set

    var isShuffled: Boolean = false
        private set
    private var shuffleOrder: MutableList<Int> = mutableListOf()

    val current: CarItem?
        get() {
            val i = currentIndex
            return if (i != null && i in items.indices) items[i] else null
        }

    val isEmpty: Boolean get() = items.isEmpty()
    val count: Int get() = items.size

    /**
     * What follows the current item without moving to it, so the audio layer
     * can preload the next file *before* the current one ends.
     */
    val upNext: CarItem?
        get() = indexAfterCurrent().let { if (it != null) items[it] else null }

    /**
     * Advance as if the current track ran out. ONE repeats here because that
     * is what "repeat one" means when a track *ends*; pressing next explicitly
     * is [skipForward], which deliberately ignores it.
     */
    fun advanceAfterPlaybackEnded(): CarItem? {
        if (repeatMode == RepeatMode.ONE) return current
        return skipForward()
    }

    fun skipForward(): CarItem? {
        val next = indexAfterCurrent() ?: return null
        currentIndex = next
        return current
    }

    /**
     * Go back, or restart the current track. Past a few seconds into a track
     * it restarts that track instead of leaving it.
     */
    fun skipBackward(positionSec: Double = 0.0): CarItem? {
        if (positionSec > 3) return current
        val cur = currentIndex ?: return null
        currentIndex = when {
            cur > 0 -> cur - 1
            repeatMode == RepeatMode.ALL && items.isNotEmpty() -> items.size - 1
            else -> cur
        }
        return current
    }

    fun jump(to: Int) {
        if (to in items.indices) currentIndex = to
    }

    /** Replace the whole queue, e.g. restoring a persisted session. */
    fun restore(newItems: List<CarItem>, startIndex: Int) {
        items.clear()
        shuffleOrder = mutableListOf()
        isShuffled = false
        items.addAll(newItems.filter { it.isPlayable })
        currentIndex = if (items.isEmpty()) {
            null
        } else if (startIndex in items.indices) {
            startIndex
        } else {
            0
        }
    }

    fun append(contentsOf: List<CarItem>) {
        val playable = contentsOf.filter { it.isPlayable }
        if (playable.isEmpty()) return
        val firstNew = items.size
        items.addAll(playable)
        if (isShuffled) {
            shuffleOrder.addAll(((firstNew until items.size).shuffled()))
        }
        if (currentIndex == null) currentIndex = 0
    }

    /** Put items directly after the current one, keeping their relative order. */
    fun playNext(newItems: List<CarItem>) {
        val playable = newItems.filter { it.isPlayable }
        if (playable.isEmpty()) return
        val cur = currentIndex
        if (cur == null) {
            append(playable)
            return
        }
        items.addAll(cur + 1, playable)
        if (isShuffled) rebuildShuffleOrder()
    }

    fun removeAt(index: Int) {
        if (index !in items.indices) return
        items.removeAt(index)
        if (items.isEmpty()) {
            currentIndex = null
            shuffleOrder = mutableListOf()
            return
        }
        val cur = currentIndex
        if (cur != null) {
            currentIndex = when {
                index < cur -> cur - 1
                index == cur -> minOf(cur, items.size - 1)
                else -> cur
            }
        }
        if (isShuffled) rebuildShuffleOrder()
    }

    /**
     * Turn shuffle on, keeping the current track where it is. Reshuffling from
     * the current position rather than from the top stops the track being
     * listened to from restarting when shuffle is pressed.
     */
    fun setShuffled(shuffled: Boolean) {
        if (shuffled == isShuffled) return
        isShuffled = shuffled
        shuffleOrder = if (shuffled) mutableListOf() else mutableListOf()
        if (shuffled) rebuildShuffleOrder()
    }

    private fun rebuildShuffleOrder() {
        if (!isShuffled) return
        val remaining = items.indices.toMutableList()
        val cur = currentIndex
        shuffleOrder = if (cur != null && remaining.remove(cur)) {
            mutableListOf(cur).apply { addAll(remaining.shuffled()) }
        } else {
            remaining.shuffled().toMutableList()
        }
    }

    private fun indexAfterCurrent(): Int? {
        if (items.isEmpty()) return null
        val cur = currentIndex ?: return null
        if (isShuffled) {
            val position = shuffleOrder.indexOf(cur)
            if (position == -1) return null
            val nextPosition = position + 1
            if (nextPosition < shuffleOrder.size) return shuffleOrder[nextPosition]
            return if (repeatMode == RepeatMode.ALL) shuffleOrder.firstOrNull() else null
        }
        val next = cur + 1
        if (next < items.size) return next
        return if (repeatMode == RepeatMode.ALL) 0 else null
    }
}
