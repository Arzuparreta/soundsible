package com.soundsible.player

import com.soundsible.player.data.CarItem
import com.soundsible.player.logic.OfflineLibrary
import com.soundsible.player.logic.OfflineTrack
import org.junit.Assert.*
import org.junit.Test

private fun playable(id: String) = CarItem(id = id, kind = "track", title = id, isPlayable = true)

class OfflineLibraryTest {
    @Test fun pinReturnsOnlyMissingTracks() {
        val lib = OfflineLibrary(
            tracks = listOf(OfflineTrack("a", "a.audio", 10, pinnedBy = mutableSetOf("pl1"))),
        )
        val missing = lib.pin("pl1", listOf(playable("a"), playable("b")))
        assertEquals(listOf("b"), missing.map { it.id })
        assertTrue(lib.isAvailableOffline("a"))
    }

    @Test fun unpinOrphansOnlyTracksNothingWants() {
        val lib = OfflineLibrary()
        lib.store("a", "a.audio", 10, "pl1")
        lib.store("a", "a.audio", 10, "pl2")
        lib.store("b", "b.audio", 10, "pl1")
        val orphaned = lib.unpin("pl1")
        assertEquals(listOf("b"), orphaned.map { it.trackId })
        assertTrue(lib.isAvailableOffline("a"))
        assertFalse(lib.isAvailableOffline("b"))
    }

    @Test fun evictionNeverTouchesPinnedTracks() {
        val lib = OfflineLibrary(byteBudget = 15)
        lib.store("pinned", "p.audio", 10, "pl1")
        lib.store("cache-old", "o.audio", 10, "cache")
        lib.unpin("cache")
        lib.store("cache-new", "n.audio", 10, "cache")
        lib.unpin("cache")
        // Pinned track survives even though the library is over budget.
        val evicted = lib.evictToFitBudget()
        assertTrue(evicted.none { it.trackId == "pinned" })
        assertTrue(lib.usedBytes <= 15 || lib.isAvailableOffline("pinned"))
    }
}
