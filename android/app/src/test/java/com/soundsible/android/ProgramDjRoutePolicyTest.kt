package com.soundsible.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class ProgramDjRoutePolicyTest {
    private data class Song(val id: String, val key: String, val pin: Boolean = false, val owner: String? = null)
    private fun apply(before: List<Song>, next: List<Song>) = ProgramDjRoutePolicy.retainPins(before, next, Song::pin, Song::id)
    @Test fun retainsChosenDepthAndOccurrenceWhileChangingFiller() {
        val pin = Song("request", "chosen", true)
        val result = apply(listOf(Song("old", "old"), pin, Song("old2", "old2")),
            listOf(Song("new", "new"), Song("request", "new-duplicate"), Song("new2", "new2")))
        assertEquals(listOf("new", "chosen", "new2"), result.map { it.key })
    }
    @Test fun preservesTwoRequestedOccurrencesOfTheSameRecording() {
        val first = Song("request", "first", true); val second = Song("request", "second", true)
        assertEquals(listOf(first, second), apply(listOf(first, second), listOf(Song("request", "replacement"))))
    }
    @Test fun rejectsAReplanThatWouldMoveADeepRequestEarlier() {
        val before = listOf(Song("a", "a"), Song("b", "b"), Song("request", "chosen", true))
        assertThrows(IllegalArgumentException::class.java) { apply(before, listOf(Song("new", "new"))) }
    }
    @Test fun movingEitherBridgeOrOwnerMovesTheirWholeBlockAcrossNeighbouringBlocks() {
        val rows = listOf(Song("seed", "seed"), Song("bridge", "bridge", owner = "request"),
            Song("request", "request", true), Song("other-bridge", "other-bridge", owner = "other"), Song("other", "other", true))
        for (key in listOf("bridge", "request")) {
            val moved = ProgramDjRoutePolicy.moveBlock(rows, key, 3, Song::key, Song::owner)
            assertEquals(listOf("seed", "other-bridge", "other", "bridge", "request"), moved.map { it.key })
            val restored = ProgramDjRoutePolicy.moveBlock(moved, key, 1, Song::key, Song::owner)
            assertEquals(rows, restored)
        }
    }
    @Test fun blockRemovalDistinguishesRepeatedRecordingsAndTargetsBridgeOwner() {
        val rows = listOf(Song("request", "first", true), Song("bridge", "bridge", owner = "second"), Song("request", "second", true))
        val removed = ProgramDjRoutePolicy.block(rows, "bridge", Song::key, Song::owner).map(Song::key).toSet()
        assertEquals(setOf("bridge", "second"), removed)
        assertEquals(listOf("first"), rows.filter { it.key !in removed }.map { it.key })
    }
}
