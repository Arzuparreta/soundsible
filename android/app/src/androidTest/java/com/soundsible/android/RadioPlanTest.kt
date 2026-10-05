package com.soundsible.android

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class RadioPlanTest {
    @Test fun keepsFiniteRecordingFactsWithoutGuessingAlbumContext() {
        val rows = RadioPlan.rows(JSONObject("""{"items":[{"source":"library","track_id":"measured","duration":120,"loudness_lufs":-20.25,"loudness_peak_dbtp":-3.5},{"source":"library","track_id":"unknown","duration":-1,"loudness_lufs":null}]}"""), emptySet(), 8)
        assertEquals(-20.25, rows.getJSONObject(0).getDouble("loudness_lufs"), 0.0)
        assertEquals(-3.5, rows.getJSONObject(0).getDouble("loudness_peak_dbtp"), 0.0)
        assertEquals(120.0, rows.getJSONObject(0).getDouble("duration"), 0.0)
        assertFalse(rows.getJSONObject(0).has("context"))
        assertFalse(rows.getJSONObject(1).has("duration"))
        assertFalse(rows.getJSONObject(1).has("loudness_lufs"))
    }
    @Test fun boundsSourcesAndRepeatedIdentities() {
        val plan = JSONObject("""{"items":[{"source":"library","track_id":"heard"},{"source":"preview","youtube_id":"invalid"},{"source":"podcast","id":"episode"},{"source":"library","track_id":"new","title":"One"},{"source":"library","track_id":"new"},{"source":"preview","youtube_id":"abcdefghijk","title":"Two"}]}""")
        val rows = RadioPlan.rows(plan, setOf("heard"), 8)
        assertEquals(2, rows.length())
        assertEquals("local", rows.getJSONObject(0).getString("source"))
        assertEquals("abcdefghijk", rows.getJSONObject(1).getString("id"))
        assertEquals(1, RadioPlan.rows(plan, setOf("heard"), 1).length())
    }
}
