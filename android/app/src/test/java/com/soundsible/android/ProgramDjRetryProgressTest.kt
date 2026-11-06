package com.soundsible.android

import org.junit.Assert.*
import org.junit.Test

class ProgramDjRetryProgressTest {
    @Test fun aReopenedCachedPrefixCannotImmediatelyReplaceTheRecoveredOutgoingDeck() {
        val retry = ProgramDjRetryProgress()
        retry.stalled("incoming-occurrence", 3100000)
        assertFalse(retry.ready("incoming-occurrence", 50000))
        assertFalse(retry.ready("incoming-occurrence", 3100000))
        assertTrue(retry.ready("incoming-occurrence", 4000000))
        assertTrue(retry.ready("incoming-occurrence", 50000))
    }
    @Test fun anotherOccurrenceOrAnExplicitSeekDoesNotInheritTheRecoveryFloor() {
        val retry = ProgramDjRetryProgress()
        retry.stalled("old-occurrence", 3100000)
        assertTrue(retry.ready("new-occurrence", 50000))
        retry.stalled("old-occurrence", 3100000)
        retry.clear()
        assertTrue(retry.ready("old-occurrence", 50000))
    }
}
