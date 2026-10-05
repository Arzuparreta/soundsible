package com.soundsible.android

import org.junit.Assert.*
import org.junit.Test

class ProgramDeckClockTest {
    @Test fun reservingALaterReturnDoesNotMoveTheEarlierPlayoutBackwards() {
        val clock = ProgramDeckClock()
        clock.reserve(0, 96000)
        assertEquals(91200L, clock.played(91200))
        clock.reserve(120000, 24000) // The deck resumes after a silent 24000-frame gap.
        assertEquals(91200L, clock.played(91200))
        assertEquals(96000L, clock.played(110000))
        assertEquals(96000L, clock.played(120000))
        assertEquals(108000L, clock.played(132000))
    }
    @Test fun standbyStartsAtItsOwnCueAndResetDiscardsPreviousEpoch() {
        val clock = ProgramDeckClock()
        clock.reserve(48000, 480)
        clock.reserve(48480, 480)
        assertEquals(0L, clock.played(47000))
        assertEquals(720L, clock.played(48720))
        clock.reset(); clock.reserve(0, 480)
        assertEquals(0L, clock.played(0))
        assertEquals(480L, clock.played(1000))
    }
    @Test fun repeatedGapsPruneOnlyAfterTheHardwareReachesTheirSuccessor() {
        val clock = ProgramDeckClock()
        for (index in 0 until 200) {
            clock.reserve(index * 960L, 480)
            assertEquals(index * 480L + 240, clock.played(index * 960L + 240))
            assertEquals((index + 1) * 480L, clock.played(index * 960L + 800))
        }
    }
}
