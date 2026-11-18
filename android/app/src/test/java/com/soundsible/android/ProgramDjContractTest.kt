package com.soundsible.android

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/** Android's parsers read the examples that tests/test_api_contract.py holds to shared/contracts/api/dj.schema.json. */
class ProgramDjContractTest {
    private fun example(name: String) = JSONObject(ProgramDjContractTest::class.java.classLoader!!
        .getResourceAsStream("api/examples/$name")!!.bufferedReader().use { it.readText() })

    @Test fun everyPlannedTransitionInTheExamplesBecomesAProposal() {
        for (name in listOf("dj-plan.json", "dj-place.json", "dj-repair.json")) {
            val items = example(name).getJSONArray("items")
            for (index in 0 until items.length()) {
                val item = items.getJSONObject(index)
                val transition = item.getJSONObject("transition")
                val proposal = ProgramDjPlan.proposal(item, "previous")
                assertNotNull("$name[$index]", proposal)
                assertEquals(transition.getString("technique").uppercase(), proposal!!.technique.name)
                assertEquals("previous", proposal.fromKey)
                assertEquals(transition.getDouble("in_cue"), proposal.inCue, 0.0)
                assertEquals(transition.getDouble("playback_rate"), proposal.rate, 0.0)
                assertEquals(transition.optDouble("out_playback_rate", 1.0), proposal.outRate, 0.0)
                if (transition.isNull("out_cue")) assertEquals(true, proposal.outCue.isNaN())
                else assertEquals(transition.getDouble("out_cue"), proposal.outCue, 0.0)
            }
        }
        val following = example("dj-place.json").getJSONObject("following_transition")
        assertNotNull(ProgramDjPlan.proposal(JSONObject().put("transition", following), "previous"))
        assertNull(ProgramDjPlan.proposal(example("dj-plan.json").getJSONArray("items").getJSONObject(0), null))
    }

    @Test fun planItemsInTheExamplesBecomePlayableRows() {
        for (name in listOf("dj-plan.json", "dj-place.json", "dj-repair.json")) {
            val response = example(name)
            val rows = RadioPlan.rows(response, emptySet(), 8)
            assertEquals(name, response.getJSONArray("items").length(), rows.length())
            for (index in 0 until rows.length()) {
                val item = response.getJSONArray("items").getJSONObject(index)
                assertEquals(item.getString("youtube_id"), rows.getJSONObject(index).getString("id"))
            }
        }
    }

    @Test fun aRefinementExampleIsReadLikeAPlannedSeam() {
        val proposal = ProgramDjPlan.proposal(example("dj-transition.json"), "previous")!!
        assertEquals(ProgramMixCurve.Technique.BASS_SWAP, proposal.technique)
    }
}
