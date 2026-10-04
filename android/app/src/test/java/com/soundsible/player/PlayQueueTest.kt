package com.soundsible.player

import com.soundsible.player.data.CarItem
import com.soundsible.player.logic.PlayQueue
import com.soundsible.player.logic.RepeatMode
import org.junit.Assert.*
import org.junit.Test

private fun track(id: String) = CarItem(id = id, kind = "track", title = id, isPlayable = true)
private fun collection(id: String) = CarItem(id = id, kind = "collection", title = id)

class PlayQueueTest {
    @Test fun keepsOnlyPlayableItemsAndStartsAtZero() {
        val queue = PlayQueue(listOf(track("a"), collection("c"), track("b")))
        assertEquals(listOf("a", "b"), queue.items.map { it.id })
        assertEquals("a", queue.current?.id)
    }

    @Test fun emptyQueueHasNoCurrent() {
        val queue = PlayQueue()
        assertNull(queue.current)
        assertNull(queue.skipForward())
    }

    @Test fun skipForwardStopsAtTheEndWithoutRepeat() {
        val queue = PlayQueue(listOf(track("a"), track("b")))
        assertEquals("b", queue.skipForward()?.id)
        assertNull(queue.skipForward())
        // Falling off stays on the last track rather than clearing it.
        assertEquals("b", queue.current?.id)
    }

    @Test fun repeatAllWrapsAround() {
        val queue = PlayQueue(listOf(track("a"), track("b")), repeatMode = RepeatMode.ALL)
        queue.skipForward()
        assertEquals("a", queue.skipForward()?.id)
    }

    @Test fun repeatOneRepeatsOnlyOnNaturalEnd() {
        val queue = PlayQueue(listOf(track("a"), track("b")), repeatMode = RepeatMode.ONE)
        assertEquals("a", queue.advanceAfterPlaybackEnded()?.id)
        assertEquals("b", queue.skipForward()?.id)
    }

    @Test fun skipBackwardRestartsWhenPastThreeSeconds() {
        val queue = PlayQueue(listOf(track("a"), track("b")))
        queue.skipForward()
        assertEquals("b", queue.skipBackward(positionSec = 10.0)?.id)
        assertEquals("a", queue.skipBackward()?.id)
    }

    @Test fun upNextPeeksWithoutMoving() {
        val queue = PlayQueue(listOf(track("a"), track("b")))
        assertEquals("b", queue.upNext?.id)
        assertEquals("a", queue.current?.id)
    }

    @Test fun removeAtKeepsCurrentSane() {
        val queue = PlayQueue(listOf(track("a"), track("b"), track("c")))
        queue.jump(1)
        queue.removeAt(1)
        assertEquals("c", queue.current?.id)
    }

    @Test fun playNextInsertsAfterCurrent() {
        val queue = PlayQueue(listOf(track("a"), track("c")))
        queue.playNext(listOf(track("b")))
        assertEquals(listOf("a", "b", "c"), queue.items.map { it.id })
    }
}
