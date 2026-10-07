package com.soundsible.android

import org.json.JSONArray
import org.json.JSONObject

/** Bounded planner decoding, independent of the player and its thread. */
object RadioPlan {
    fun rows(response: JSONObject, exclude: Set<String>, limit: Int): JSONArray {
        require(limit in 1..8)
        val result = JSONArray()
        val seen = exclude.toMutableSet()
        val items = response.optJSONArray("items") ?: JSONArray()
        require(items.length() <= 1000)
        for (index in 0 until items.length()) {
            val item = items.getJSONObject(index)
            val source = item.optString("source")
            val local = source == "library"
            if (!local && source != "preview") continue
            val id = if (local) item.optString("track_id").ifBlank { item.optString("id") }
                else item.optString("youtube_id").ifBlank { item.optString("discovery_youtube_id") }
            if (id.isBlank() || id == "null" || id.length > 512 || (!local && !Regex("^[A-Za-z0-9_-]{11}$").matches(id))) continue
            if (!seen.add(id)) continue
            val title = item.optString("title"); val artist = item.optString("artist"); val album = item.optString("album")
            if (listOf(title, artist, album).any { it.length > 4096 }) continue
            val row = JSONObject().put("source", if (local) "local" else "preview").put("id", id).put("title", title).put("artist", artist).put("album", album)
            for (field in listOf("duration", "loudness_lufs", "loudness_peak_dbtp")) {
                if (!item.isNull(field)) item.optDouble(field, Double.NaN).takeIf { it.isFinite() && (field != "duration" || it >= 0) }?.let { row.put(field, it) }
            }
            result.put(row)
            if (result.length() == limit) break
        }
        return result
    }
}
