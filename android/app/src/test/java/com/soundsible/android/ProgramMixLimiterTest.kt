package com.soundsible.android

import org.junit.Assert.*
import org.junit.Test

class ProgramMixLimiterTest {
    @Test fun quietProgrammeRemainsExactAndChannelsShareTheEnvelope() {
        val limiter = ProgramMixLimiter(48000)
        val frame = doubleArrayOf(0.1, -0.05)
        limiter.frame(frame, 2); assertArrayEquals(doubleArrayOf(0.1, -0.05), frame, 0.0)
        limiter.blend(true)
        repeat(24000) { frame[0] = 1.2; frame[1] = -0.6; limiter.frame(frame, 2) }
        assertTrue(frame[0] in 0.4..0.7)
        assertEquals(-0.5, frame[1] / frame[0], 1e-12)
    }
    @Test fun highPeakCannotOverflowAndResetClearsPriorReduction() {
        val limiter = ProgramMixLimiter(16000); limiter.blend(true)
        val frame = doubleArrayOf(2.0)
        limiter.frame(frame, 1); assertTrue(frame[0] <= 1)
        repeat(16000) { frame[0] = 2.0; limiter.frame(frame, 1) }
        limiter.reset(); frame[0] = 0.1; limiter.frame(frame, 1); assertEquals(0.1, frame[0], 0.0)
        assertThrows(IllegalArgumentException::class.java) { limiter.frame(doubleArrayOf(Double.NaN), 1) }
    }
}
