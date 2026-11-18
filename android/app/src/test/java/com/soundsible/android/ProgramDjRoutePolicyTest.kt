package com.soundsible.android

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class ProgramDjRoutePolicyTest {
    private fun rows(array: JSONArray) = (0 until array.length()).map { index ->
        val row = array.getJSONObject(index)
        val key = row.getString("key")
        ProgramDjRoutePolicy.RouteRow(key, row.getString("kind"), row.optString("owner").ifEmpty { null },
            row.optString("group").ifEmpty { null }, row.optString("recording").ifEmpty { key })
    }
    private fun JSONObject.text(name: String): String? = if (isNull(name)) null else optString(name).ifEmpty { null }
    private fun expected(vector: JSONObject): Any? = when (val value = vector.get("expect")) {
        JSONObject.NULL -> null
        is JSONArray -> (0 until value.length()).map { value.getString(it) }
        else -> (value as Number).toInt()
    }

    @Test fun sharedRouteRulesMatchTheWebClient() {
        val text = ProgramDjRoutePolicyTest::class.java.classLoader!!.getResourceAsStream("dj_route_rules.json")!!.bufferedReader().use { it.readText() }
        val cases = JSONObject(text).getJSONArray("cases")
        val rules = mutableSetOf<String>()
        for (index in 0 until cases.length()) {
            val vector = cases.getJSONObject(index)
            val rule = vector.getString("rule"); rules.add(rule)
            val actual: Any? = when (rule) {
                "editable_from" -> ProgramDjRoutePolicy.editableFrom(rows(vector.getJSONArray("rows")), vector.getInt("current"), vector.getInt("floor"))
                "block" -> ProgramDjRoutePolicy.block(rows(vector.getJSONArray("rows")), vector.getString("target"))
                "move" -> ProgramDjRoutePolicy.moveBefore(rows(vector.getJSONArray("rows")), vector.getString("target"), vector.text("before"), vector.getInt("floor"))
                "request_insertion" -> ProgramDjRoutePolicy.requestInsertion(rows(vector.getJSONArray("rows")), vector.getInt("floor"), vector.text("before"))
                "remove" -> ProgramDjRoutePolicy.removed(rows(vector.getJSONArray("rows")), vector.getString("target"))
                "repair_horizon" -> ProgramDjRoutePolicy.repairHorizon(rows(vector.getJSONArray("future")), vector.getInt("limit"))
                "session_survivors" -> ProgramDjRoutePolicy.sessionSurvivors(rows(vector.getJSONArray("future")), vector.text("lead"))
                "replan" -> ProgramDjRoutePolicy.replan(rows(vector.getJSONArray("previous")), rows(vector.getJSONArray("generated")))
                else -> error("Unknown rule $rule")
            }
            assertEquals("$rule: ${vector.getString("name")}", expected(vector), actual)
        }
        assertEquals(setOf("editable_from", "block", "move", "request_insertion", "remove", "repair_horizon", "session_survivors", "replan"), rules)
    }

    @Test fun aDragMovesWholeBlocksPastTheirNeighbours() {
        val rows = listOf(ProgramDjRoutePolicy.RouteRow("seed", "generated"), ProgramDjRoutePolicy.RouteRow("bridge", "bridge", "request"),
            ProgramDjRoutePolicy.RouteRow("request", "user"), ProgramDjRoutePolicy.RouteRow("other-bridge", "bridge", "other"),
            ProgramDjRoutePolicy.RouteRow("other", "user"))
        for (key in listOf("bridge", "request")) {
            val moved = ProgramDjRoutePolicy.moveToIndex(rows, key, 3, 0)!!
            assertEquals(listOf("seed", "other-bridge", "other", "bridge", "request"), moved)
            val reordered = moved.map { name -> rows.first { it.key == name } }
            assertEquals(rows.map { it.key }, ProgramDjRoutePolicy.moveToIndex(reordered, key, 1, 0))
        }
        assertEquals(null, ProgramDjRoutePolicy.moveToIndex(rows, "request", 1, 0))
    }
}
