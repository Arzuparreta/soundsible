package com.soundsible.android

import org.junit.Assert.*
import org.junit.Test

class SourceRetirementTest {
    private fun local(id: String) = SourceRetirement.Reference(id, "local")
    @Test fun removesAllAcquiredOccurrencesButKeepsPreviewOfSameId() {
        val rows = listOf(local("file"), SourceRetirement.Reference("file", "preview"), local("other"), local("file"), local("file"), SourceRetirement.Reference("file", "podcast"))
        val removals = SourceRetirement.ranges(rows, "file")
        assertEquals(listOf(3..4, 0..0), removals)
        val retained = rows.toMutableList()
        removals.forEach { range -> retained.subList(range.first, range.last + 1).clear() }
        assertEquals(listOf(rows[1], rows[2], rows[5]), retained)
    }
    @Test fun emptyAndAbsentSourcesLeaveReferencesUntouched() {
        assertTrue(SourceRetirement.ranges(emptyList(), "file").isEmpty())
        assertTrue(SourceRetirement.ranges(listOf(local("other")), "file").isEmpty())
    }
    @Test fun contiguousWholeQueueHasOneRemoval() {
        assertEquals(listOf(0..2), SourceRetirement.ranges(List(3) { local("file") }, "file"))
    }
    @Test fun invalidSourceCannotMutateAnything() {
        for (id in listOf("", " ", "x".repeat(513))) {
            try { SourceRetirement.ranges(listOf(local("file")), id); fail("Expected invalid source") }
            catch (_: IllegalArgumentException) {}
        }
    }
}
