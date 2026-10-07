package com.soundsible.android

import org.junit.Assert.*
import org.junit.Test

class ProgramDjPlanTest {
    private val confident = ProgramDjPlan.Proposal("current", ProgramMixCurve.Technique.BASS_SWAP,
        150.0, 12.0, 16.0, 1.05, 0.8, 5.0)
    @Test fun staleOccurrenceCannotApplyAnotherTracksCueOrEffects() {
        val plan = ProgramDjPlan.resolve("replacement", 200000000, confident, true)!!
        assertEquals(ProgramMixCurve.Technique.SAFE_FADE, plan.technique)
        assertEquals(193000000L, plan.outCueUs)
        assertEquals(0L, plan.inCueUs)
        assertEquals(6000000L, plan.overlapUs)
        assertEquals(1.0, plan.rate.toDouble(), 0.0001)
    }
    @Test fun matchingTrustedPlanRetainsMeasuredCuesAndTechnique() {
        val plan = ProgramDjPlan.resolve("current", 200000000, confident, true)!!
        assertEquals(ProgramMixCurve.Technique.BASS_SWAP, plan.technique)
        assertEquals(150000000L, plan.outCueUs)
        assertEquals(12000000L, plan.inCueUs)
        assertEquals(16000000L, plan.overlapUs)
        assertEquals(1.05, plan.rate.toDouble(), 0.0001)
        assertEquals(5000L, plan.phaseToleranceUs)
    }
    @Test fun untrustedPlanUsesSafeFadeAndBoundedRunway() {
        val plan = ProgramDjPlan.resolve("current", 20000000, confident.copy(confidence = 0.2), true)!!
        assertEquals(ProgramMixCurve.Technique.SAFE_FADE, plan.technique)
        assertEquals(14000000L, plan.outCueUs)
        assertEquals(5000000L, plan.overlapUs)
        assertEquals(0L, plan.inCueUs)
        assertEquals(1.0, plan.rate.toDouble(), 0.0001)
    }
    @Test fun disabledMixingWaitsForWholeSourceEnd() {
        val plan = ProgramDjPlan.resolve("current", 20000000, confident, false)!!
        assertEquals(ProgramMixCurve.Technique.DIRECT, plan.technique)
        assertEquals(20000000L, plan.outCueUs)
        assertEquals(0L, plan.overlapUs)
        assertEquals(0L, plan.inCueUs)
    }
    @Test fun pathologicalPlannerNumbersCannotReachDsp() {
        val plan = ProgramDjPlan.resolve("current", 200000000,
            confident.copy(inCue = Double.NaN, rate = Double.POSITIVE_INFINITY), true)!!
        assertEquals(ProgramMixCurve.Technique.SAFE_FADE, plan.technique)
        assertEquals(0L, plan.inCueUs)
        assertEquals(1.0, plan.rate.toDouble(), 0.0001)
        assertNull(ProgramDjPlan.resolve("current", 4000000, confident, true))
        assertNull(ProgramDjPlan.resolve("", 200000000, confident, true))
    }
    @Test fun fullCoreLongBlendIsNotShortenedToSpikeLimit() {
        val plan = ProgramDjPlan.resolve("current", 300000000,
            confident.copy(technique = ProgramMixCurve.Technique.LONG_BLEND, overlap = 48.0, outCue = 220.0), true)!!
        assertEquals(48000000L, plan.overlapUs)
        assertEquals(220000000L, plan.outCueUs)
    }
    @Test fun trustedTempoAndPhaseRemainInsideRuntimeBounds() {
        val plan = ProgramDjPlan.resolve("current", 200000000,
            confident.copy(rate = 2.0, inCue = -2.0, phaseToleranceMs = 30.0), true)!!
        assertEquals(1.06, plan.rate.toDouble(), 0.0001)
        assertEquals(0L, plan.inCueUs)
        assertEquals(12000L, plan.phaseToleranceUs)
    }
}
