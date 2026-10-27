package com.soundsible.android

import kotlin.math.roundToLong
import org.junit.Assert.*
import org.junit.Test
import org.json.JSONArray

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
    @Test fun lateMeasuredCueMovesBackByWholeBarsAndStaysOnItsDownbeat() {
        // 1.9355 s bars; the downbeat at 185.4 is past the latest start, 200 - 16 - 1 = 183.
        val plan = ProgramDjPlan.resolve("current", 200000000,
            confident.copy(outCue = 185.4, outPeriod = 0.483875), true)!!
        assertEquals(((185.4 - 2 * 1.9355) * 1000000).roundToLong(), plan.outCueUs)
        assertEquals(12000000L, plan.inCueUs)
    }
    @Test fun unmeasuredCueIsStillClampedWithoutABar() {
        val plan = ProgramDjPlan.resolve("current", 200000000, confident.copy(outCue = 185.4), true)!!
        assertEquals(183000000L, plan.outCueUs)
    }
    @Test fun outCuePlacementMatchesTheWebRule() {
        assertEquals(150.0, ProgramDjPlan.placeOutCue(150.0, 90.0, 170.0, 2.0), 0.0)
        assertEquals(90.5, ProgramDjPlan.placeOutCue(80.5, 90.0, 170.0, 2.0), 1e-9)
        assertEquals(101.0, ProgramDjPlan.placeOutCue(100.0, 101.0, 101.5, 2.0), 0.0)
        assertEquals(170.0, ProgramDjPlan.placeOutCue(172.0, 90.0, 170.0, Double.NaN), 0.0)
    }
    @Test fun trustedTempoAndPhaseRemainInsideRuntimeBounds() {
        val plan = ProgramDjPlan.resolve("current", 200000000,
            confident.copy(rate = 2.0, inCue = -2.0, phaseToleranceMs = 30.0), true)!!
        assertEquals(1.08, plan.rate.toDouble(), 0.0001)
        assertEquals(0L, plan.inCueUs)
        assertEquals(12000L, plan.phaseToleranceUs)
    }
    @Test fun sharedServerAutomaticPlansKeepTheirCuesAndEffects() {
        val vectors = JSONArray().apply {
            for (resource in listOf("dj_structural_plans.json", "dj_echo_plans.json", "dj_metric_plans.json")) {
                val rows = ProgramDjPlanTest::class.java.classLoader!!.getResourceAsStream(resource)!!.bufferedReader().use { JSONArray(it.readText()) }
                for (index in 0 until rows.length()) put(rows.getJSONObject(index))
            }
        }
        for (index in 0 until vectors.length()) {
            val vector = vectors.getJSONObject(index)
            val transition = vector.getJSONObject("transition")
            val sync = transition.getJSONObject("sync")
            val proposal = ProgramDjPlan.Proposal("current",
                ProgramMixCurve.Technique.valueOf(transition.getString("technique").uppercase(java.util.Locale.ROOT)),
                transition.getDouble("out_cue"), transition.getDouble("in_cue"), transition.getDouble("overlap_seconds"),
                transition.getDouble("playback_rate"), transition.getDouble("confidence"),
                sync.getDouble("phase_tolerance_ms"), sync.getDouble("out_period"),
                transition.optDouble("echo_delay_seconds").takeIf { it.isFinite() }, sync)
            val plan = ProgramDjPlan.resolve("current", (vector.getDouble("duration") * 1000000).roundToLong(), proposal, true)!!
            val resolved = vector.optJSONObject("resolved")
            val expectedTechnique = resolved?.optString("technique")?.let { ProgramMixCurve.Technique.valueOf(it.uppercase(java.util.Locale.ROOT)) } ?: proposal.technique
            assertEquals(vector.getString("name"), expectedTechnique, plan.technique)
            assertEquals(((resolved?.optDouble("out_cue") ?: proposal.outCue) * 1000000).roundToLong(), plan.outCueUs)
            assertEquals((proposal.inCue * 1000000).roundToLong(), plan.inCueUs)
            assertEquals((proposal.overlap * 1000000).roundToLong(), plan.overlapUs)
            assertEquals(proposal.rate, plan.rate.toDouble(), 0.000001)
            assertEquals(proposal.echoDelaySeconds, plan.echoDelaySeconds)
        }
    }
    @Test fun explicitUnknownBarNeverBecomesFourMeasuredPulses() {
        val unknown = confident.copy(outPeriod = 0.5, metricSync = org.json.JSONObject().put("out_bar_seconds", org.json.JSONObject.NULL))
        assertEquals(0.0, ProgramDjPlan.barSeconds(unknown), 0.0)
        assertEquals(2.0, ProgramDjPlan.barSeconds(unknown.copy(metricSync = null)), 0.0)
    }
    @Test fun incompleteOrContradictoryMetricPlansDowngradeInsteadOfClaimingBeatmatch() {
        val rows = ProgramDjPlanTest::class.java.classLoader!!.getResourceAsStream("dj_metric_plans.json")!!.bufferedReader().use { JSONArray(it.readText()) }
        val transition = rows.getJSONObject(0).getJSONObject("transition")
        for (field in listOf("out_metre", "out_bar_seconds", "in_bar_seconds", "in_period")) {
            val sync = org.json.JSONObject(transition.getJSONObject("sync").toString())
            sync.put(field, when (field) {
                "in_bar_seconds" -> 2.0
                "in_period" -> 0.55
                else -> org.json.JSONObject.NULL
            })
            val proposal = confident.copy(outCue = transition.getDouble("out_cue"),
                inCue = transition.getDouble("in_cue"), overlap = transition.getDouble("overlap_seconds"), rate = 1.0,
                outPeriod = 0.5, metricSync = sync)
            val plan = ProgramDjPlan.resolve("current", 240000000, proposal, true)!!
            assertEquals(field, ProgramMixCurve.Technique.STRUCTURAL_FADE, plan.technique)
            assertEquals(1.0, plan.rate.toDouble(), 0.0)
        }
    }
    private fun metricVector(name: String): org.json.JSONObject {
        val rows = ProgramDjPlanTest::class.java.classLoader!!.getResourceAsStream("dj_metric_plans.json")!!.bufferedReader().use { JSONArray(it.readText()) }
        return (0 until rows.length()).map { rows.getJSONObject(it) }.first { it.getString("name") == name }.getJSONObject("transition")
    }
    private fun metricProposal(transition: org.json.JSONObject, sync: org.json.JSONObject = transition.getJSONObject("sync")) =
        confident.copy(outCue = transition.getDouble("out_cue"), inCue = transition.getDouble("in_cue"),
            overlap = transition.getDouble("overlap_seconds"), rate = transition.getDouble("playback_rate"),
            outPeriod = sync.getDouble("out_period"), metricSync = sync)
    @Test fun pulsePlansMoveByWholeOutgoingBarsThatAreWholeCommonCycles() {
        // 1.5 s outgoing bars keep the one on the incoming one (213.25 to 174.25);
        // 120 against 180 BPM moves by 2 s, two cycles of 2 + 3 beats.
        for ((name, latest, expected) in listOf(Triple("three-to-four", 175.0, 174.25),
                Triple("unconfirmed-four", 167.0, 166.25), Triple("three-two-pulses", 167.0, 166.25))) {
            val transition = metricVector(name)
            assertEquals(name, "beats", transition.getJSONObject("sync").getString("alignment"))
            val proposal = metricProposal(transition)
            val placement = ProgramDjPlan.metricCuePlacement(proposal.outCue, 90.0, latest, proposal, proposal.overlap)
            assertEquals(name, expected, placement.first, 1e-9)
            assertTrue(name, placement.second)
        }
    }
    @Test fun pulsePlansDowngradeWithoutCoverageCycleOrStepOrWithContradictoryPeriods() {
        for (name in listOf("three-to-four", "unconfirmed-four", "three-two-pulses", "four-three-pulses")) {
            val transition = metricVector(name)
            assertTrue(name, ProgramDjPlan.metricCuePlacement(transition.getDouble("out_cue"), 90.0, 215.0,
                metricProposal(transition), transition.getDouble("overlap_seconds")).second)
            val inPeriod = transition.getJSONObject("sync").getDouble("in_period")
            for ((field, value) in listOf("out_metre" to org.json.JSONObject.NULL, "in_metre" to org.json.JSONObject.NULL,
                    "in_period" to inPeriod * 1.1, "out_period" to 0.0, "in_bar_seconds" to 1.7, "alignment" to "none",
                    "cycle_beats" to org.json.JSONObject.NULL, "cycle_beats" to org.json.JSONArray(listOf(5, 7)),
                    "relocation_seconds" to 0.0)) {
                val sync = org.json.JSONObject(transition.getJSONObject("sync").toString()).put(field, value)
                val proposal = metricProposal(transition, sync)
                val placement = ProgramDjPlan.metricCuePlacement(proposal.outCue, 90.0, 215.0, proposal, proposal.overlap)
                assertFalse("$name $field", placement.second)
            }
        }
    }
    @Test fun aCueWhoseOverlapEndsWithinThePhaseToleranceOfCoverageStays() {
        // User's session, 2026-10-26: 0.9 ms past the coverage moved the cue one beat.
        for (name in listOf("unconfirmed-four", "three-quarter")) {
            val transition = metricVector(name)
            val end = transition.getDouble("out_cue") + transition.getDouble("overlap_seconds") - 0.0009
            val sync = org.json.JSONObject(transition.getJSONObject("sync").toString())
            sync.put("out_metre", org.json.JSONObject(sync.getJSONObject("out_metre").toString()).put("end", end))
            val proposal = metricProposal(transition, sync)
            val placement = ProgramDjPlan.metricCuePlacement(proposal.outCue, 90.0, 215.0, proposal, proposal.overlap)
            assertEquals(name, proposal.outCue, placement.first, 0.0)
            assertTrue(name, placement.second)
            sync.put("out_metre", org.json.JSONObject(sync.getJSONObject("out_metre").toString()).put("end", end - 0.01))
            val beyond = metricProposal(transition, sync)
            assertNotEquals(name, beyond.outCue, ProgramDjPlan.metricCuePlacement(beyond.outCue, 90.0, 215.0, beyond, beyond.overlap).first, 0.0)
        }
    }
    @Test fun echoDelayBelongsOnlyToATrustedMatchingOccurrenceWithMixingEnabled() {
        val echo = confident.copy(technique = ProgramMixCurve.Technique.ECHO_CUT, echoDelaySeconds = 0.5)
        assertEquals(0.5, ProgramDjPlan.resolve("current", 200000000, echo, true)!!.echoDelaySeconds!!, 0.0)
        assertNull(ProgramDjPlan.resolve("replacement", 200000000, echo, true)!!.echoDelaySeconds)
        assertNull(ProgramDjPlan.resolve("current", 200000000, echo.copy(confidence = 0.2), true)!!.echoDelaySeconds)
        assertNull(ProgramDjPlan.resolve("current", 200000000, echo, false)!!.echoDelaySeconds)
        for (delay in listOf(null, 0.0, -0.5, Double.NaN, Double.POSITIVE_INFINITY, 2.1)) {
            val plan = ProgramDjPlan.resolve("current", 200000000, echo.copy(echoDelaySeconds = delay), true)!!
            assertEquals(ProgramMixCurve.Technique.STRUCTURAL_FADE, plan.technique)
            assertNull(plan.echoDelaySeconds)
        }
    }
}
