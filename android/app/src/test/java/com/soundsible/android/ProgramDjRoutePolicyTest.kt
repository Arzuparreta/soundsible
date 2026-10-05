package com.soundsible.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class ProgramDjRoutePolicyTest {
    private data class Song(val id: String, val key: String, val pin: Boolean = false)
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
}
