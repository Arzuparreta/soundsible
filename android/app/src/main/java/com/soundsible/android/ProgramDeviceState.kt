package com.soundsible.android

import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import org.json.JSONArray
import org.json.JSONObject

/** Shared playbackSession v1 wire format. Native source URLs/cookies never travel. */
@UnstableApi
internal object ProgramDeviceState {
    data class Restored(val rows: JSONArray, val index: Int, val positionMs: Long, val shuffle: Boolean, val repeat: Int)
    fun track(item: MediaItem): JSONObject {
        val extras = item.mediaMetadata.extras
        val source = extras?.getString(ProgramQueue.SOURCE)
        val id = item.mediaId.let { if (it.startsWith("soundsible:track:")) android.net.Uri.decode(it.removePrefix("soundsible:track:")) else it }
        return JSONObject().put("id", id).put("title", item.mediaMetadata.title?.toString().orEmpty())
            .put("artist", item.mediaMetadata.artist?.toString().orEmpty()).put("album", item.mediaMetadata.albumTitle?.toString().orEmpty())
            .put("duration", extras?.getDouble(ProgramPcmProcessor.DURATION, 0.0) ?: 0.0).apply {
                if (source == "preview" || source == "podcast") put("source", "preview")
                if (source == "preview") put("youtube_id", id)
                if (extras?.getBoolean(ProgramQueue.PODCAST) == true) {
                    put("media_kind", "podcast_episode"); put("podcast_enclosure_url", extras.getString(ProgramQueue.ENCLOSURE))
                    put("podcast_episode_guid", extras.getString(ProgramQueue.EPISODE)); put("podcast_feed_id", extras.getString(ProgramQueue.FEED))
                }
            }
    }
    fun snapshot(player: Player): JSONObject? {
        if (player.mediaItemCount == 0 || player.currentMediaItem?.mediaMetadata?.extras?.getString(ProgramQueue.SOURCE) == "live") return null
        val index = player.currentMediaItemIndex.coerceIn(0, player.mediaItemCount - 1)
        val start = (index - 5).coerceAtLeast(0)
        val queue = JSONArray()
        for (i in start until minOf(player.mediaItemCount, index + 41)) {
            val item = player.getMediaItemAt(i)
            queue.put(track(item).put("queueId", ProgramQueue.key(player, i)).put("queueLane", "manual").put("queueSource", "library"))
        }
        val session = JSONObject().put("v", 1).put("mode", "now_playing").put("queue", queue).put("index", index - start)
            .put("shuffle", player.shuffleModeEnabled).put("repeat", when (player.repeatMode) { Player.REPEAT_MODE_ALL -> "all"; Player.REPEAT_MODE_ONE -> "one"; else -> "off" })
            .put("radio", JSONObject().put("active", false).put("seedId", JSONObject.NULL)).put("auto", JSONObject.NULL)
        return JSONObject().put("track_id", track(player.getMediaItemAt(index)).getString("id")).put("track", track(player.getMediaItemAt(index)))
            .put("position_sec", player.currentPosition.coerceAtLeast(0) / 1000.0).put("is_playing", player.isPlaying).put("session", session)
    }
    private fun row(track: JSONObject): JSONObject {
        require(!track.has("pendingResolve")) { "REMOTE_CATALOG_UNRESOLVED" }
        val podcast = track.optString("media_kind") == "podcast_episode"
        val source = if (track.optString("source") == "preview") { if (podcast) "podcast" else "preview" } else "local"
        return JSONObject().put("source", source).put("id", track.getString("id")).put("title", track.optString("title"))
            .put("artist", track.optString("artist")).put("album", track.optString("album")).put("duration", track.optDouble("duration", 0.0)).apply {
                if (podcast) { put("mediaKind", "podcast_episode"); put("enclosure", track.optString("podcast_enclosure_url"))
                    put("episodeGuid", track.optString("podcast_episode_guid")); put("feedId", track.optString("podcast_feed_id")) }
            }
    }
    fun restore(payload: JSONObject): Restored? {
        val state = payload.optJSONObject("state") ?: JSONObject()
        val session = state.optJSONObject("session")
        if (session?.optString("mode") == "auto") return null // DJ workspace restore is a separate explicit acceptance gate.
        val position = state.optDouble("position_sec", 0.0).takeIf { it.isFinite() && it >= 0 && it <= 604800 } ?: 0.0
        if (session?.optInt("v") == 1) {
            val queue = session.optJSONArray("queue")
            if (queue != null && queue.length() in 1..46) {
                val rows = JSONArray(); val keys = mutableSetOf<String>()
                for (i in 0 until queue.length()) {
                    val entry = queue.getJSONObject(i)
                    require(entry.optString("queueId").isNotBlank() && keys.add(entry.getString("queueId")))
                    rows.put(row(entry))
                }
                val index = session.optInt("index", 0).coerceIn(0, rows.length() - 1)
                return Restored(rows, index, (position * 1000).toLong(), session.optBoolean("shuffle"),
                    when (session.optString("repeat")) { "all" -> Player.REPEAT_MODE_ALL; "one" -> Player.REPEAT_MODE_ONE; else -> Player.REPEAT_MODE_OFF })
            }
        }
        val track = payload.optJSONObject("track") ?: return null
        return Restored(JSONArray().put(row(track)), 0, (position * 1000).toLong(), false, Player.REPEAT_MODE_OFF)
    }
}
