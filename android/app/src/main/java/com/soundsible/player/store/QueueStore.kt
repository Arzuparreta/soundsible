package com.soundsible.player.store

import android.content.Context
import android.content.SharedPreferences
import com.soundsible.player.data.CarItem
import com.soundsible.player.data.JsonArray
import com.soundsible.player.data.JsonObject
import com.soundsible.player.data.parseJsonObject

/**
 * Persists the playback queue across process death: items, position in the
 * queue and playback offset. Closing the app must not lose what was sounding.
 */
class QueueStore(context: Context) {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences("soundsible_queue", Context.MODE_PRIVATE)

    data class Snapshot(
        val items: List<CarItem>,
        val index: Int,
        val positionMs: Long,
    )

    fun save(items: List<CarItem>, index: Int, positionMs: Long) {
        try {
            // Cap the tail: restoring hundreds of upcoming tracks costs more
            // than it is worth on a cold start.
            val kept = if (index >= 0) items.drop(index.coerceIn(0, items.size)) else items
            val capped = kept.take(MAX_SAVED)
            val array = capped.map { item ->
                JsonObject.builder()
                    .put("id", item.id)
                    .put("kind", item.kind)
                    .put("track_id", item.trackId)
                    .put("title", item.title)
                    .put("subtitle", item.subtitle)
                    .put("artist", item.artist)
                    .put("album", item.album)
                    .put("duration_sec", item.durationSec)
                    .put("artwork_url", item.artworkUrl)
                    .put("stream_url", item.streamUrl)
                    .put("is_browsable", item.isBrowsable)
                    .put("is_playable", item.isPlayable)
                    .build()
            }
            val root = JsonObject.builder()
                .put("items", JsonArray(array))
                .put("position_ms", positionMs)
                .build()
                .toJsonString()
            prefs.edit().putString(KEY_SNAPSHOT, root).apply()
        } catch (_: Exception) {
        }
    }

    fun load(): Snapshot? {
        return try {
            val raw = prefs.getString(KEY_SNAPSHOT, null) ?: return null
            val root = parseJsonObject(raw)
            val items = root.optArray("items")?.items
                ?.mapNotNull { (it as? JsonObject)?.let(CarItem::fromJson) }
                ?.filter { it.isPlayable }
                ?: emptyList()
            if (items.isEmpty()) return null
            Snapshot(items, 0, root.optLong("position_ms") ?: 0L)
        } catch (_: Exception) {
            null
        }
    }

    fun clear() {
        prefs.edit().remove(KEY_SNAPSHOT).apply()
    }

    companion object {
        private const val KEY_SNAPSHOT = "queue_snapshot"
        private const val MAX_SAVED = 500
    }
}
