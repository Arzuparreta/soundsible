package com.soundsible.android

import org.junit.Assert.*
import org.junit.Test
import kotlin.math.abs

class ProgramMixCurveTest {
    @Test fun equalPowerEnvelopeAndExactEnds() {
        for (technique in ProgramMixCurve.Technique.entries.filter { it != ProgramMixCurve.Technique.DIRECT }) {
            for (step in 0..100) {
                val controls = ProgramMixCurve.at(technique, step / 100.0)
                assertEquals(1.0, controls.outgoing * controls.outgoing + controls.incoming * controls.incoming, 1e-12)
            }
            assertEquals(1.0, ProgramMixCurve.at(technique, 0.0).outgoing, 0.0)
            assertEquals(1.0, ProgramMixCurve.at(technique, 1.0).incoming, 0.0)
            assertTrue(abs(ProgramMixCurve.at(technique, 1.0).outgoing) < 1e-12)
        }
    }
    @Test fun techniqueAutomationUsesSharedCurvePoints() {
        val low = ProgramMixCurve.at(ProgramMixCurve.Technique.BASS_SWAP, 0.6)
        assertEquals(-12.0, low.outgoingLowDb, 1e-12); assertEquals(-4.0, low.incomingLowDb, 1e-12)
        assertEquals(22000.0, low.outgoingCutoff, 0.0); assertEquals(0.0, low.echoWet, 0.0)
        val blend = ProgramMixCurve.at(ProgramMixCurve.Technique.LONG_BLEND, 0.6)
        assertEquals(3500.0, blend.outgoingCutoff, 1e-12); assertEquals(10000.0, blend.incomingCutoff, 1e-12)
        assertEquals(low.outgoingLowDb, blend.outgoingLowDb, 0.0)
        assertEquals(0.32, ProgramMixCurve.at(ProgramMixCurve.Technique.ECHO_CUT, 0.8).echoWet, 1e-12)
    }
    @Test fun directNeverOverlapsAndProgressIsBounded() {
        val before = ProgramMixCurve.at(ProgramMixCurve.Technique.DIRECT, 0.99)
        assertEquals(1.0, before.outgoing, 0.0); assertEquals(0.0, before.incoming, 0.0)
        val after = ProgramMixCurve.at(ProgramMixCurve.Technique.DIRECT, 1.0)
        assertEquals(0.0, after.outgoing, 0.0); assertEquals(1.0, after.incoming, 0.0)
        assertEquals(ProgramMixCurve.at(ProgramMixCurve.Technique.SAFE_FADE, 0.0), ProgramMixCurve.at(ProgramMixCurve.Technique.SAFE_FADE, -3.0))
        assertThrows(IllegalArgumentException::class.java) { ProgramMixCurve.at(ProgramMixCurve.Technique.SAFE_FADE, Double.NaN) }
    }
}
