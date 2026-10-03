package com.soundsible.android

import android.content.Context
import androidx.media3.common.MediaItem
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest

/** Private, bounded and account/origin isolated. Enclosure and feed/GUID join copies. */
@androidx.media3.common.util.UnstableApi
class PodcastProgressStore(context: Context) {
    private val prefs = context.getSharedPreferences("podcast-progress", Context.MODE_PRIVATE)
    private fun identities(item: MediaItem?): List<String> {
        val extras = item?.mediaMetadata?.extras ?: return emptyList()
        if (!extras.getBoolean(ProgramQueue.PODCAST)) return emptyList()
        val profile = extras.getString(ProgramQueue.PROFILE) ?: return emptyList()
        val enclosure = extras.getString(ProgramQueue.ENCLOSURE) ?: ""
        val episode = extras.getString(ProgramQueue.EPISODE) ?: ""
        val feed = extras.getString(ProgramQueue.FEED) ?: ""
        val values = mutableListOf<String>()
        if (enclosure.isNotEmpty()) values.add(JSONArray().put("enclosure").put(enclosure).toString())
        if (episode.isNotEmpty() && feed.isNotEmpty()) values.add(JSONArray().put("episode").put(feed).put(episode).toString())
        return values.map { value -> MessageDigest.getInstance("SHA-256").digest((profile + "\u0000" + value).toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) } }
    }
    private fun records(): JSONObject = try { JSONObject(prefs.getString("records", "{}") ?: "{}") } catch (_: Exception) { JSONObject() }
    private fun matching(rows: JSONObject, ids: List<String>): List<String> = rows.keys().asSequence().filter { it in ids || rows.optJSONObject(it)?.optString("alias", "") in ids }.toList()
    fun position(item: MediaItem?): Long = synchronized(lock) {
        val ids = identities(item); if (ids.isEmpty()) return 0
        val rows = records()
        val key = matching(rows, ids).maxByOrNull { rows.optJSONObject(it)?.optLong("updated") ?: 0 } ?: return 0
        val row = rows.optJSONObject(key) ?: return 0
        if (row.optBoolean("completed")) 0 else row.optLong("position", 0).coerceAtLeast(0)
    }
    fun save(item: MediaItem?, position: Long, duration: Long, completed: Boolean = false) = synchronized(lock) {
        val ids = identities(item); if (ids.isEmpty() || position < 0) return
        val rows = records()
        val matches = matching(rows, ids)
        val previousKey = matches.maxByOrNull { rows.optJSONObject(it)?.optLong("updated") ?: 0 }
        val previous = previousKey?.let(rows::optJSONObject)
        val bounded = PodcastPosition.bounded(position, duration)
        // Removing a finished item loses duration; preserve completion at that
        // endpoint, while an explicit backward seek starts it again.
        val finished = completed || (duration > 0 && bounded >= duration) ||
            (duration <= 0 && previous?.optBoolean("completed") == true && previous.optLong("position") == bounded)
        val enclosure = item?.mediaMetadata?.extras?.getString(ProgramQueue.ENCLOSURE) ?: ""
        val key = if (enclosure.isNotEmpty()) ids.first() else previousKey ?: ids.first()
        val alias = if (ids.size == 2) ids.last() else previous?.optString("alias", "") ?: ""
        matches.forEach(rows::remove)
        rows.put(key, JSONObject().put("alias", alias).put("position", bounded).put("completed", finished).put("updated", System.currentTimeMillis()))
        val entries = rows.keys().asSequence().toList().sortedByDescending { rows.optJSONObject(it)?.optLong("updated") ?: 0 }
        entries.drop(500).forEach(rows::remove)
        prefs.edit().putString("records", rows.toString()).apply()
    }
    companion object { private val lock = Any() }
}
