package com.soundsible.android

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class RadioPlanIdentityTest {
    @Test fun itemIdentityTravelsSeparatelyFromTheAudioChosenByThePlanner() {
        val item = JSONObject().put("id", "7N3rFdE3u3Y").put("youtube_id", "7N3rFdE3u3Y")
            .put("source", "preview").put("item_id", "stable-musical-item").put("title", "Autorretrato")
        val stream = RadioPlan.rows(JSONObject().put("items", JSONArray().put(item)), emptySet(), 1).getJSONObject(0)
        assertEquals("7N3rFdE3u3Y", stream.getString("id"))
        assertEquals("stable-musical-item", stream.getString("item_id"))
        item.put("source", "library").put("track_id", "downloaded-file")
        val file = RadioPlan.rows(JSONObject().put("items", JSONArray().put(item)), emptySet(), 1).getJSONObject(0)
        assertEquals("downloaded-file", file.getString("id"))
        assertEquals("stable-musical-item", file.getString("item_id"))
    }
}
