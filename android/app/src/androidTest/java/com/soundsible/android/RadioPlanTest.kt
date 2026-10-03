package com.soundsible.android

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class RadioPlanTest {
    @Test fun boundsSourcesAndRepeatedIdentities() {
        val plan = JSONObject("""{"items":[{"source":"library","track_id":"heard"},{"source":"preview","youtube_id":"invalid"},{"source":"podcast","id":"episode"},{"source":"library","track_id":"new","title":"One"},{"source":"library","track_id":"new"},{"source":"preview","youtube_id":"abcdefghijk","title":"Two"}]}""")
        val rows = RadioPlan.rows(plan, setOf("heard"), 8)
        assertEquals(2, rows.length())
        assertEquals("local", rows.getJSONObject(0).getString("source"))
        assertEquals("abcdefghijk", rows.getJSONObject(1).getString("id"))
        assertEquals(1, RadioPlan.rows(plan, setOf("heard"), 1).length())
    }
}
